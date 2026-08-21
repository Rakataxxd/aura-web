// MediaPipe corre en el dispositivo del usuario. El video nunca sale del telefono.
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

const BASE = import.meta.env.BASE_URL || '/';

export const MODEL_URL = `${BASE}mp/pose_landmarker_lite.task`;
export const WASM_URL = `${BASE}mp/vision_wasm_internal.wasm`;

/**
 * Baja modelo + wasm calentando el cache HTTP, con progreso real.
 * MediaPipe los pide despues y los saca del cache => carga instantanea.
 * Sin esto son ~8MB sin feedback y se siente colgado en datos moviles.
 */
export async function prefetchAssets(onProgress) {
  const urls = [WASM_URL, MODEL_URL];
  const sizes = new Array(urls.length).fill(0);
  const got = new Array(urls.length).fill(0);

  await Promise.all(urls.map(async (url, i) => {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) return;
      sizes[i] = +res.headers.get('content-length') || 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got[i] += value.length;
        const total = sizes.reduce((a, b) => a + b, 0);
        const done_ = got.reduce((a, b) => a + b, 0);
        if (total) onProgress?.(Math.min(0.99, done_ / total));
      }
    } catch { /* si falla, MediaPipe lo baja igual por su cuenta */ }
  }));
  onProgress?.(1);
}

let lienzoCap = null, lienzoCapCtx = null;

/**
 * Consigue un frame chico para mandarle al worker.
 *
 * NO usa createImageBitmap(video, {resize...}).
 *
 * En Safari esa llamada sobre un <video> es lentisima (y con opciones de
 * resize, peor): es lo que dejaba la deteccion en 6/s en un iPhone 15 Pro
 * Max mientras la inferencia tardaba 28ms — o sea el worker ocioso esperando
 * que el hilo principal le pasara la pelota.
 *
 * Un drawImage a un lienzo chico es un blit de GPU, y transferToImageBitmap
 * entrega el resultado SIN copiar.
 */
function tomarBitmap(video) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w) return Promise.resolve(null);
  const s = Math.min(1, 640 / Math.max(w, h));
  const W = Math.round(w * s), H = Math.round(h * s);
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      if (!lienzoCap || lienzoCap.width !== W || lienzoCap.height !== H) {
        lienzoCap = new OffscreenCanvas(W, H);
        lienzoCapCtx = lienzoCap.getContext('2d', { alpha: false });
      }
      lienzoCapCtx.drawImage(video, 0, 0, W, H);
      return Promise.resolve(lienzoCap.transferToImageBitmap());
    } catch { /* sigue por el camino viejo */ }
  }
  return createImageBitmap(video, { resizeWidth: W, resizeHeight: H, resizeQuality: 'low' });
}

/**
 * Detector en worker. El render nunca se bloquea esperando la inferencia.
 * Si el worker no arranca (Safari viejo, sin OffscreenCanvas), devuelve null
 * y quien llama cae al detector del hilo principal.
 */
export async function createPoseWorker(numPoses = 2, onResult) {
  let worker;
  try {
    // Clasico, no modulo: MediaPipe necesita importScripts para su WASM.
    worker = new Worker(`${BASE}pose-worker.js`);
  } catch (e) {
    console.warn('[pose] no se pudo crear el worker:', e?.message);
    return null;
  }

  const listo = await new Promise((res) => {
    const t = setTimeout(() => res({ ok: false, error: 'timeout' }), 20000);
    worker.addEventListener('message', function onMsg(ev) {
      if (ev.data?.type !== 'ready') return;
      clearTimeout(t);
      worker.removeEventListener('message', onMsg);
      res(ev.data);
    });
    worker.postMessage({
      type: 'init',
      base: new URL(BASE, location.href).href,
      numPoses,
      soloCpu: new URLSearchParams(location.search).has('cpu'),
    });
  });

  if (!listo.ok) {
    console.warn('[pose] worker no inicializo:', listo.error);
    worker.terminate();
    return null;
  }

  let enVuelo = false;
  let ultimoResultado = 0;
  let modoStream = false;
  let huboResultado = false;
  let procesador = null, clonTrack = null;   // referencias vivas, ver conectarStream
  const msInferencia = [];
  const msCaptura = [];
  worker.addEventListener('message', (ev) => {
    if (ev.data?.type === 'error') { console.warn('[pose/worker]', ev.data.message); return; }
    if (ev.data?.type !== 'result') return;
    enVuelo = false;
    ultimoResultado = performance.now();
    huboResultado = true;
    if (ev.data.ms != null) { msInferencia.push(ev.data.ms); if (msInferencia.length > 60) msInferencia.shift(); }
    onResult(ev.data.landmarks, ev.data.ts);
  });

  const api = {
    delegate: listo.delegate,
    ocupado: () => enVuelo,
    /** Mediana de ms por inferencia. El numero que dice si el aparato aguanta. */
    inferenciaMs: () => (msInferencia.length
      ? [...msInferencia].sort((a, b) => a - b)[msInferencia.length >> 1] : 0),

    /**
     * Camino rapido: el worker se sirve solo del track de la camara.
     *
     * ESTE ES EL ARREGLO DE LOS 60FPS. Antes, por cada frame de camara el
     * hilo principal hacia createImageBitmap(video), que copia un cuadro de
     * 720p. Son varios ms de hilo principal 30 veces por segundo, y el
     * presupuesto de un frame a 60fps es 16.7ms ENTERO. Los frames que se
     * pasaban caian al siguiente vsync (33.3ms = 30fps), y el clip se grababa
     * a eso. Con MediaStreamTrackProcessor los pixeles no tocan nunca el hilo
     * principal: el worker jala VideoFrames por su cuenta.
     *
     * El track se CLONA para no pelearse con el <video> que se dibuja.
     */
    conectarStream(stream) {
      if (typeof MediaStreamTrackProcessor === 'undefined') return false;
      const track = stream?.getVideoTracks?.()[0];
      if (!track) return false;
      clonTrack?.stop();                       // el de la ronda anterior
      try {
        // El track se CLONA para no pelearse con el <video> que se dibuja, y
        // el procesador se GUARDA: si se queda sin referencias el recolector
        // se lo lleva y el readable transferido deja de entregar frames para
        // siempre, sin error ninguno. Costo: media hora de buscarlo.
        clonTrack = track.clone();
        procesador = new MediaStreamTrackProcessor({ track: clonTrack });
        worker.postMessage({ type: 'stream', readable: procesador.readable }, [procesador.readable]);
        modoStream = true;
        huboResultado = false;
        ultimoResultado = performance.now();
        return true;
      } catch (e) {
        console.warn('[pose] sin MediaStreamTrackProcessor:', e?.message);
        return false;
      }
    },

    /**
     * ¿El worker se esta alimentando solo y con vida? Si el camino de stream
     * se muere (permiso, track que termina, navegador raro) hay que volver a
     * empujar frames a mano en vez de quedarse sin deteccion.
     */
    autoAlimentado() {
      if (!modoStream) return false;
      // El primer detect compila shaders: puede tardar >1.5s aunque todo
      // este bien. Se le da margen hasta que llegue el primero, y despues se
      // vigila corto. Sin esa distincion el arranque parecia un stream roto.
      if (performance.now() - ultimoResultado < (huboResultado ? 1500 : 6000)) return true;
      modoStream = false;                   // se murio: no volvemos a confiar
      console.warn('[pose] el stream del worker no responde, vuelvo a empujar frames');
      return false;
    },

    /** Manda un frame. No hace nada si el worker sigue con el anterior. */
    async enviar(video, ts) {
      if (enVuelo) return;
      enVuelo = true;
      try {
        const t0 = performance.now();
        const bitmap = await tomarBitmap(video);
        msCaptura.push(performance.now() - t0);
        if (msCaptura.length > 60) msCaptura.shift();
        if (!bitmap) { enVuelo = false; return; }
        worker.postMessage({ type: 'frame', bitmap, ts }, [bitmap]);
      } catch {
        enVuelo = false;
      }
    },
    /** Cuanto cuesta CONSEGUIR el frame (distinto de inferirlo). */
    capturaMs: () => (msCaptura.length
      ? [...msCaptura].sort((a, b) => a - b)[msCaptura.length >> 1] : 0),
    cerrar() { worker.terminate(); },
  };
  return api;
}

export async function createPose(numPoses = 2) {
  const fileset = await FilesetResolver.forVisionTasks(`${BASE}mp`);
  // GPU es ~3x mas rapido; en algunos Android viejos falla -> caemos a CPU
  for (const delegate of ['GPU', 'CPU']) {
    try {
      return await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${BASE}mp/pose_landmarker_lite.task`, delegate },
        runningMode: 'VIDEO',
        numPoses,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputSegmentationMasks: false,
      });
    } catch (e) {
      if (delegate === 'CPU') throw e;
      console.warn('[pose] GPU no disponible, uso CPU:', e?.message);
    }
  }
}

export async function openCamera(video, facing = 'user') {
  const ideal = {
    facingMode: { ideal: facing },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    // solo 'ideal': 'min' es restriccion dura y una camara que no la
    // cumpla tira error en vez de negociar. Nunca uses min aca.
    frameRate: { ideal: 60 },
  };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: ideal, audio: false });
  } catch (e) {
    if (e?.name === 'NotAllowedError') throw e;
    // ultimo recurso: pedir cualquier camara sin condiciones
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
  const track = stream.getVideoTracks()[0];
  // NO se renegocia a 60fps despues de abrir.
  //
  // Muchas camaras de telefono solo dan 60fps BAJANDO la resolucion, y para
  // esta app ese cambio es puro perjuicio: el clip se graba a los fps del
  // CANVAS, no a los de la camara, asi que 60fps de camara no aporta nada al
  // archivo — y menos resolucion sí arruina los landmarks. Se prefiere
  // resolucion, que es lo unico que mejora la deteccion.
  console.info('[camara]', JSON.stringify(track?.getSettings?.() ?? {}));

  video.srcObject = stream;
  video.setAttribute('playsinline', '');  // iOS: sin esto abre en pantalla completa nativa
  video.muted = true;
  await video.play();
  return stream;
}

/** Lo que de verdad esta entregando la camara, para poder reportarlo. */
export function ajustesCamara(stream) {
  const s = stream?.getVideoTracks?.()[0]?.getSettings?.() ?? {};
  return { w: s.width || 0, h: s.height || 0, fps: Math.round(s.frameRate || 0) };
}

/** Ordena los cuerpos detectados de izquierda a derecha -> P1 / P2 estables por zona. */
export function assignSlots(landmarksArr) {
  const withX = landmarksArr
    .map((lm) => ({ lm, cx: (lm[11].x + lm[12].x + lm[23].x + lm[24].x) / 4 }))
    .filter((d) => Number.isFinite(d.cx))
    .sort((a, b) => a.cx - b.cx);
  if (withX.length === 0) return [null, null];
  if (withX.length === 1) return [withX[0].lm, null];
  return [withX[0].lm, withX[withX.length - 1].lm];
}
