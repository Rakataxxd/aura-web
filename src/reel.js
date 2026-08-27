// El recopilatorio del torneo: los videos de los que mas aura farmearon,
// pegados en uno solo, con su placa de puesto.
//
// SE ARMA EN EL NAVEGADOR DEL ORGANIZADOR. No hay otra opcion y conviene
// entender por que antes de intentar moverlo: un Worker de Cloudflare no puede
// juntar videos. No hay ffmpeg, no hay sistema de archivos, hay ~30 segundos de
// CPU y los codecs no estan. Cortar y pegar video pide o una maquina con
// ffmpeg (un servidor que hay que pagar y mantener) o un servicio de terceros.
// El navegador del streamer ya tiene un decodificador y un codificador de
// video, y esta prendido justo cuando el quiere su recopilatorio.
//
// COMO: se dibujan los videos, uno tras otro, en un canvas, y se graba el
// canvas. Es exactamente lo que ya hace el juego (render.js dibuja, record.js
// graba) y lo que hace el clip de la sala (mosaico.js). La maquinaria estaba.
//
// CUESTA LO QUE DURA. Grabar un canvas es en tiempo real: un recopilatorio de
// diez clips de 15s tarda unos tres minutos en armarse. No hay forma de
// acelerarlo con MediaRecorder —WebCodecs podria, pero no esta en Safari, que
// es la mitad de los telefonos—, asi que hay barra de progreso y se avisa el
// tiempo de antemano.
//
// SIN AUDIO, A PROPOSITO. Los clips del torneo son escaneos solitarios y no
// tienen audio (solo lo tienen los de sala, ver record.js). Y aunque lo
// tuvieran, empalmar diez pistas cambiando de fuente a mitad de la grabacion
// es un grafo de WebAudio entero para algo que el streamer va a tapar con su
// propia musica igual.

const ANCHO = 720;
const ALTO = 1280;          // 9:16: es el formato de TikTok, Reels y Shorts

const FONDO = '#0c0c10';
const ACID = '#c9ff2e';
const BONE = '#f4efe4';
const GRIS = 'rgba(244, 239, 228, .45)';

const PLACA_MS = 1800;      // cuanto se ve el cartel de cada puesto
const FPS = 30;             // el recopilatorio no necesita 60: son videos ya grabados

const num = (n) => Number(n || 0).toLocaleString('es-GT');

/**
 * Baja los videos del top.
 *
 * A BLOB Y NO DIRECTO AL <video src>. Dos razones:
 *   - Un <video> con una URL de otro dominio ENSUCIA el canvas: en cuanto se
 *     dibuja, `captureStream` deja de servir y la grabacion sale en negro. Con
 *     `blob:` la URL es del mismo origen y el problema no existe. (Se podria
 *     con crossOrigin + CORS, pero un solo header mal puesto lo rompe callado.)
 *   - Reproducir mientras se descarga hace que el clip se corte si la red
 *     tosia. Aca lo que se graba ya esta entero en memoria.
 *
 * Los que fallan se saltean: mejor un recopilatorio de ocho que ninguno.
 */
export async function bajarClips(filas, urlDe, onProgreso) {
  const listos = [];
  for (let i = 0; i < filas.length; i++) {
    const f = filas[i];
    try {
      const res = await fetch(urlDe(f.alias));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (blob.size) listos.push({ ...f, blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      console.warn('[reel] sin el clip de', f.alias, e?.message);
    }
    onProgreso?.((i + 1) / filas.length);
  }
  return listos;
}

export const soltarClips = (clips) => {
  for (const c of clips || []) { try { URL.revokeObjectURL(c.url); } catch { /* ya */ } }
};

/** Un <video> listo para dibujar, o null si el archivo no se pudo leer. */
function prepararVideo(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.src = url;
    v.muted = true;                 // sin esto, reproducir sin gesto lo bloquea el navegador
    v.playsInline = true;
    v.preload = 'auto';
    const listo = () => resolve(v);
    // `canplaythrough` puede no llegar nunca en algunos webm; `loadeddata`
    // alcanza para empezar a dibujar y el resto ya esta en memoria.
    v.onloadeddata = listo;
    v.onerror = () => resolve(null);
    setTimeout(() => resolve(v.readyState >= 2 ? v : null), 8000);
  });
}

/** Dibuja el video entero adentro del lienzo, sin recortarle nada. */
function encajar(ctx, v) {
  const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
  const e = Math.min(ANCHO / vw, ALTO / vh);
  const w = vw * e, h = vh * e;
  ctx.drawImage(v, (ANCHO - w) / 2, (ALTO - h) / 2, w, h);
}

function placa(ctx, fila, torneo) {
  ctx.fillStyle = FONDO;
  ctx.fillRect(0, 0, ANCHO, ALTO);

  ctx.textAlign = 'center';

  ctx.fillStyle = GRIS;
  ctx.font = '700 30px "Chakra Petch", system-ui, sans-serif';
  ctx.fillText(String(torneo || '').toUpperCase().slice(0, 26), ANCHO / 2, ALTO / 2 - 300);

  ctx.fillStyle = ACID;
  ctx.font = '900 300px "Archivo Black", system-ui, sans-serif';
  ctx.fillText(`#${fila.puesto}`, ANCHO / 2, ALTO / 2 - 40);

  ctx.fillStyle = BONE;
  ctx.font = '900 74px "Archivo Black", system-ui, sans-serif';
  ctx.fillText(String(fila.alias).toUpperCase().slice(0, 14), ANCHO / 2, ALTO / 2 + 90);

  ctx.fillStyle = ACID;
  ctx.font = '700 60px "Share Tech Mono", monospace';
  ctx.fillText(num(fila.aura), ANCHO / 2, ALTO / 2 + 180);

  ctx.fillStyle = GRIS;
  ctx.font = '700 26px "Chakra Petch", system-ui, sans-serif';
  ctx.fillText('DE AURA', ANCHO / 2, ALTO / 2 + 220);
}

/** La marca del final. Es el unico lugar del video que dice de donde salio. */
function cierre(ctx, torneo) {
  ctx.fillStyle = FONDO;
  ctx.fillRect(0, 0, ANCHO, ALTO);
  ctx.textAlign = 'center';
  ctx.fillStyle = BONE;
  ctx.font = '900 62px "Archivo Black", system-ui, sans-serif';
  ctx.fillText('ESCÁNER', ANCHO / 2, ALTO / 2 - 40);
  ctx.fillStyle = ACID;
  ctx.fillText('DE AURA', ANCHO / 2, ALTO / 2 + 30);
  ctx.fillStyle = GRIS;
  ctx.font = '700 34px "Chakra Petch", system-ui, sans-serif';
  ctx.fillText('auratester.com', ANCHO / 2, ALTO / 2 + 120);
  ctx.font = '700 24px "Chakra Petch", system-ui, sans-serif';
  ctx.fillText(String(torneo || '').toUpperCase().slice(0, 30), ANCHO / 2, ALTO / 2 + 175);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cuanto va a tardar, en segundos. Se dice ANTES de empezar. */
export const duracionEstimada = (clips, segundosPorClip = 15) =>
  Math.round(clips.length * (PLACA_MS / 1000 + segundosPorClip) + 3);

/**
 * Arma el recopilatorio y devuelve el Blob.
 *
 * @param {Array} clips lo que devolvio `bajarClips`
 * @param {string} torneo el nombre, para las placas
 * @param {(p:number, texto:string)=>void} onProgreso 0..1
 */
export async function armarRecopilatorio(clips, torneo, onProgreso) {
  if (!clips.length) throw new Error('no hay videos para armar el recopilatorio');

  // Las tipografias tienen que estar ANTES del primer fillText. Si no, las dos
  // primeras placas salen en la fuente por defecto y las demas no: el canvas
  // no espera a que cargue una fuente, dibuja con lo que hay.
  try { await document.fonts?.ready; } catch { /* da igual */ }

  const canvas = document.createElement('canvas');
  canvas.width = ANCHO;
  canvas.height = ALTO;
  const ctx = canvas.getContext('2d', { alpha: false });

  ctx.fillStyle = FONDO;
  ctx.fillRect(0, 0, ANCHO, ALTO);

  const stream = canvas.captureStream(FPS);
  const mime = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
    .find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';

  const trozos = [];
  const opts = { videoBitsPerSecond: 4_000_000 };
  if (mime) opts.mimeType = mime;
  const rec = new MediaRecorder(stream, opts);
  rec.ondataavailable = (e) => { if (e.data.size) trozos.push(e.data); };
  rec.start(500);

  // El bucle de dibujo es UNO SOLO para todo el recopilatorio y no uno por
  // clip: arrancar y parar un rAF entre videos deja huecos donde el canvas no
  // se redibuja, y `captureStream` graba esos huecos como cuadros congelados.
  let actual = null;         // el <video> que se esta dibujando, o null (placa)
  let vivo = true;
  const dibujar = () => {
    if (!vivo) return;
    if (actual && actual.readyState >= 2) {
      ctx.fillStyle = FONDO;
      ctx.fillRect(0, 0, ANCHO, ALTO);
      encajar(ctx, actual);
    }
    requestAnimationFrame(dibujar);
  };
  requestAnimationFrame(dibujar);

  const total = clips.length;
  try {
    for (let i = 0; i < total; i++) {
      const c = clips[i];
      const base = i / total;
      const paso = 1 / total;

      onProgreso?.(base, `#${c.puesto} ${c.alias}`);
      actual = null;
      placa(ctx, c, torneo);
      await esperar(PLACA_MS);

      const v = await prepararVideo(c.url);
      if (!v) continue;                       // se salta: mejor sin ese que sin nada

      await new Promise((resolve) => {
        let cerrado = false;
        // Red de seguridad: un webm sin duracion en la cabecera puede no
        // disparar `ended` NUNCA. Sin este tope el recopilatorio se cuelga
        // para siempre en el clip roto y desde afuera no se ve la diferencia
        // con "esta tardando".
        const tope = setTimeout(() => terminar(), 40000);
        function terminar() {
          if (cerrado) return;
          cerrado = true;
          clearTimeout(tope);
          actual = null;
          try { v.pause(); } catch { /* ya */ }
          v.onended = null; v.ontimeupdate = null; v.onerror = null;
          resolve();
        }
        v.onended = terminar;
        v.onerror = terminar;
        v.ontimeupdate = () => {
          const p = v.duration ? v.currentTime / v.duration : 0;
          onProgreso?.(base + paso * Math.min(1, p), `#${c.puesto} ${c.alias}`);
          // El margen es porque `ended` a veces no llega en el ultimo cuadro.
          if (v.duration && v.currentTime >= v.duration - 0.15) terminar();
        };
        actual = v;
        v.play().catch(terminar);
      });
    }

    actual = null;
    cierre(ctx, torneo);
    await esperar(2200);
    onProgreso?.(1, 'cerrando');
  } finally {
    vivo = false;
  }

  const blob = await new Promise((resolve) => {
    rec.onstop = () => resolve(new Blob(trozos, { type: rec.mimeType || mime || 'video/webm' }));
    rec.stop();
  });
  // Igual que en record.js: parar el grabador NO corta la captura del canvas.
  stream.getTracks().forEach((t) => t.stop());
  return blob;
}
