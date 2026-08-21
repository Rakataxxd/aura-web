/* eslint-env worker */
// Deteccion de pose en un hilo aparte. WORKER CLASICO A PROPOSITO.
//
// POR QUE EXISTE:
// detectForVideo tarda 9-20ms en una GPU de escritorio (mas en telefono).
// El presupuesto de un frame a 60fps es 16.7ms TOTAL. En el hilo principal
// cada frame con deteccion se pasa del vsync y cae al siguiente -> 33.3ms
// -> exactamente 30fps. Por eso el clip salia a 30 clavado.
//
// POR QUE NO ES UN MODULE WORKER:
// MediaPipe carga su WASM con importScripts(), que no existe en workers de
// tipo modulo -> falla con "ModuleFactory not set". Por eso este archivo
// vive en public/ (Vite no lo toca, se sirve igual en dev y en produccion)
// y usa el build IIFE que expone el global `Vision`.

let landmarker = null;
let ocupado = false;
let ultimoTs = 0;
let lienzo = null, lienzoCtx = null;
let fileset = null, opciones = null;       // para poder reconstruir el grafo
let fallos = 0, rehaciendo = false;
let genStream = 0;                         // solo el lazo de stream mas nuevo vive

// El modelo trabaja a 256px. Un frame de camara de 1080x1920 no da nada de
// precision extra y cuesta carisimo: MEDIDO en este proyecto, detectar el
// frame entero tarda ~45ms y reducido a 640 tarda ~10ms. Al empujar frames
// a mano esto ya lo hacia el hilo principal en createImageBitmap; con el
// track directo el frame llega en crudo y hay que reducirlo aca.
const LADO_MAX = 640;

/**
 * UN SOLO RELOJ, entero y siempre creciente.
 *
 * MediaPipe exige timestamps estrictamente crecientes y, si recibe uno
 * repetido o menor, EL GRAFO QUEDA ROTO PARA SIEMPRE: todas las llamadas
 * siguientes tiran INVALID_ARGUMENT y la deteccion no vuelve hasta recargar
 * la pagina. Lo unico que se ve desde afuera es una ronda que "detecta mal".
 *
 * Antes se usaba el ts que venia con cada frame, y venia de DOS relojes
 * distintos: el de los VideoFrame (monotonico del sistema, horas desde el
 * arranque) y performance.now() (desde que cargo la pagina). Al tocar "otra
 * vez" se reconectaba el stream y los dos se cruzaban. De ahi en adelante,
 * deteccion muerta.
 *
 * El ts no tiene que coincidir con nada externo: MediaPipe solo lo usa para
 * ordenar. Asi que se genera aca y listo.
 */
function siguienteTs() {
  const t = Math.round(performance.now());
  ultimoTs = t > ultimoTs ? t : ultimoTs + 1;
  return ultimoTs;
}

/** ¿Se puede pedir el delegado GPU desde aca? Safari: no. */
function tieneWebGL() {
  try {
    if (typeof OffscreenCanvas === 'undefined') return false;
    const c = new OffscreenCanvas(1, 1);
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

function reducir(fuente) {
  const w = fuente.displayWidth || fuente.width;
  const h = fuente.displayHeight || fuente.height;
  const s = Math.min(1, LADO_MAX / Math.max(w || 1, h || 1));
  if (s >= 1 || typeof OffscreenCanvas === 'undefined') return fuente;
  const W = Math.round(w * s), H = Math.round(h * s);
  if (!lienzo) { lienzo = new OffscreenCanvas(W, H); lienzoCtx = lienzo.getContext('2d'); }
  if (lienzo.width !== W || lienzo.height !== H) { lienzo.width = W; lienzo.height = H; }
  lienzoCtx.drawImage(fuente, 0, 0, W, H);
  return lienzo;
}

function detectar(fuente) {
  try {
    const res = landmarker.detectForVideo(reducir(fuente), siguienteTs());
    fallos = 0;
    return res && res.landmarks ? res.landmarks : [];
  } catch (err) {
    if (fallos === 0) self.postMessage({ type: 'error', message: err && err.message });
    // Un grafo de MediaPipe roto NO se recupera solo: sigue tirando el mismo
    // error para siempre. Si falla varias veces seguidas se reconstruye, que
    // es la diferencia entre "esta ronda salio mal" y "no vuelve a andar
    // hasta que recargues".
    if (++fallos >= 8) rehacer();
    return [];
  }
}

async function rehacer() {
  if (rehaciendo || !opciones) return;
  rehaciendo = true;
  fallos = 0;
  try {
    const viejo = landmarker;
    landmarker = null;
    try { viejo && viejo.close(); } catch { /* noop */ }
    landmarker = await self.Vision.PoseLandmarker.createFromOptions(fileset, opciones);
    ultimoTs = 0;
    self.postMessage({ type: 'error', message: 'grafo reconstruido' });
  } catch (e) {
    self.postMessage({ type: 'error', message: 'no se pudo reconstruir: ' + (e && e.message) });
  }
  rehaciendo = false;
}

/**
 * Primer detect: compila shaders y arma el grafo. MEDIDO: 1.5 SEGUNDOS.
 * Si eso pasa con la ronda ya corriendo, el vigilante del hilo principal
 * cree que el stream esta muerto y se vuelve al camino lento para siempre.
 * Se paga aca, con la pantalla de carga puesta, que es donde corresponde.
 */
function calentar() {
  if (typeof OffscreenCanvas === 'undefined') return;
  try {
    const c = new OffscreenCanvas(LADO_MAX, LADO_MAX);
    c.getContext('2d').fillRect(0, 0, 4, 4);
    landmarker.detectForVideo(c, siguienteTs());
  } catch { /* si falla, solo significa que el primer frame real paga el costo */ }
}

/**
 * El worker jala frames de la camara por su cuenta. Asi el hilo principal
 * no gasta NI UN milisegundo en la deteccion y le queda el presupuesto
 * entero de 16.7ms para dibujar el canvas, que es lo que se graba.
 *
 * Un frame que llega mientras seguimos con el anterior se cierra y se tira:
 * encolar solo suma latencia, siempre interesa el mas nuevo. Cerrarlos es
 * OBLIGATORIO, si no la camara se traba al quedarse sin buffers.
 */
async function leerStream(readable) {
  const mio = ++genStream;
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    // Al tocar "otra vez" llega un stream nuevo. Sin esto quedaban DOS lazos
    // leyendo y peleandose por el mismo detector.
    if (mio !== genStream) { value.close(); reader.cancel().catch(() => {}); return; }
    if (!landmarker || ocupado) { value.close(); continue; }
    ocupado = true;
    const t0 = performance.now();
    const landmarks = detectar(value);
    value.close();
    ocupado = false;
    self.postMessage({ type: 'result', ts: performance.now(), landmarks, ms: performance.now() - t0 });
  }
}

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'stream') {
    leerStream(msg.readable).catch((err) => {
      self.postMessage({ type: 'error', message: 'stream: ' + (err && err.message) });
    });
    return;
  }

  if (msg.type === 'init') {
    try {
      importScripts(`${msg.base}mp/vision_bundle.js`);
      const { FilesetResolver, PoseLandmarker } = self.Vision;
      fileset = await FilesetResolver.forVisionTasks(`${msg.base}mp`);
      let ultimo = null;
      // SAFARI NO TIENE WEBGL EN WORKERS (no hay OffscreenCanvas con
      // contexto GL). Pedir el delegado GPU no solo falla: deja el modulo
      // WASM inservible, asi que el reintento con CPU tambien fallaba, el
      // worker devolvia ok:false y todo se iba al detector del hilo
      // principal. Eso era un iPhone 15 Pro Max a 13 FPS con 7
      // detecciones/s: la inferencia bloqueando el bucle de dibujo.
      // Se pregunta ANTES en vez de probar y romper.
      // ?cpu fuerza este camino desde cualquier navegador, que es la unica
      // forma de probar lo que le va a pasar a Safari sin tener un iPhone.
      const delegados = (tieneWebGL() && !msg.soloCpu) ? ['GPU', 'CPU'] : ['CPU'];
      for (const delegate of delegados) {
        try {
          opciones = {
            baseOptions: { modelAssetPath: `${msg.base}mp/pose_landmarker_lite.task`, delegate },
            runningMode: 'VIDEO',
            numPoses: msg.numPoses ?? 2,
            minPoseDetectionConfidence: 0.5,
            minPosePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
            outputSegmentationMasks: false,
          };
          landmarker = await PoseLandmarker.createFromOptions(fileset, opciones);
          calentar();
          self.postMessage({ type: 'ready', ok: true, delegate });
          return;
        } catch (err) { ultimo = err; }
      }
      self.postMessage({ type: 'ready', ok: false, error: ultimo?.message || 'sin delegado' });
    } catch (err) {
      self.postMessage({ type: 'ready', ok: false, error: err?.message || String(err) });
    }
    return;
  }

  if (msg.type === 'frame') {
    // Si llega un frame mientras seguimos con el anterior, se descarta.
    // Encolar solo agrega latencia: siempre interesa el frame mas nuevo.
    if (!landmarker || ocupado) { msg.bitmap.close(); return; }
    ocupado = true;
    const t0 = performance.now();
    const landmarks = detectar(msg.bitmap);
    msg.bitmap.close();
    ocupado = false;
    self.postMessage({ type: 'result', ts: msg.ts, landmarks, ms: performance.now() - t0 });
  }
};
