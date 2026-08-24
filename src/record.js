// El clip ES el producto. Sin clip para postear no hay crecimiento.
// Safari no soporta webm -> hay que negociar el codec, no asumirlo.

const CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

// Con audio hay que pedir el códec de audio TAMBIÉN. Un contenedor mp4 con
// `codecs=avc1` a secas y una pista de audio adentro es una combinación que
// algunos navegadores rechazan al construir el MediaRecorder, y el fallback
// termina grabando webm donde había mp4 (o nada).
const CANDIDATES_AV = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMime(conAudio = false) {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of (conAudio ? CANDIDATES_AV : CANDIDATES)) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* noop */ }
  }
  return '';
}

/**
 * Junta varias pistas de audio en una sola, para que el clip de la sala tenga
 * lo que se escuchó: mi micrófono y el de todos los demás.
 *
 * Un MediaRecorder acepta UNA pista de audio, no cinco. La mezcla la hace el
 * grafo de WebAudio, que es lo único que puede sumar señales sin salir del
 * dispositivo. Si algo falla, se graba sin audio: un clip mudo es mucho mejor
 * que ningún clip.
 */
export function mezclarAudio(pistas = []) {
  const vivas = pistas.filter((t) => t && t.readyState === 'live');
  if (!vivas.length) return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    const ctx = new Ctx();
    ctx.resume?.().catch(() => { /* ya arrancará con el próximo gesto */ });
    const dest = ctx.createMediaStreamDestination();
    // Las fuentes se GUARDAN: sin una referencia viva, el recolector se las
    // lleva a mitad de la grabación y el audio se corta solo. Es el mismo
    // problema que el `procesador` del worker de pose.
    const fuentes = vivas.map((t) => {
      const src = ctx.createMediaStreamSource(new MediaStream([t]));
      src.connect(dest);
      return src;
    });
    const track = dest.stream.getAudioTracks()[0] || null;
    if (!track) { ctx.close?.(); return null; }
    return {
      track,
      cerrar() {
        for (const s of fuentes) { try { s.disconnect(); } catch { /* ya */ } }
        try { track.stop(); } catch { /* ya */ }
        ctx.close?.().catch(() => { /* ya */ });
      },
    };
  } catch (e) {
    console.warn('[clip] sin audio:', e?.message);
    return null;
  }
}

export class Recorder {
  constructor(canvas) {
    this.canvas = canvas;
    this.chunks = [];
    this.rec = null;
    this.mime = pickMime();
    this.supported = this.mime !== null;
  }

  // 60 por defecto: captureStream(30) capaba el clip a 30fps aunque el
  // canvas estuviera dibujando a 60.
  start(fps = 60, pistasAudio = []) {
    if (!this.supported) return false;
    this.chunks = [];
    const stream = this.stream = this.canvas.captureStream(fps);
    // El audio va POR ENCIMA del video ya capturado, no en un stream aparte:
    // el MediaRecorder graba un stream, y ese stream tiene que traer las dos
    // cosas o el archivo sale mudo.
    this.mezcla = mezclarAudio(pistasAudio);
    if (this.mezcla) {
      try { stream.addTrack(this.mezcla.track); }
      catch { this.mezcla.cerrar(); this.mezcla = null; }
    }
    // Medido: Chrome entrega ~2.4x el bitrate pedido con esta cantidad de
    // movimiento. 3.5M -> ~8Mbps reales -> ~14MB por clip de 15s a 60fps,
    // que todavia se comparte bien con datos moviles.
    const opts = { videoBitsPerSecond: 3_500_000 };
    const mime = this.mezcla ? pickMime(true) : this.mime;
    if (mime) opts.mimeType = mime;
    try {
      this.rec = new MediaRecorder(stream, opts);
    } catch {
      try { this.rec = new MediaRecorder(stream); } catch { return false; }
    }
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(250);
    return true;
  }

  /**
   * Corta y tira lo grabado, y suelta la captura del canvas.
   *
   * Para el ENSAYO de la cuenta regresiva: capturar el canvas no es gratis
   * en todos lados (en iOS es lo mas caro de todo el frame) y ese costo
   * aparece SOLO al grabar. Medir el rendimiento sin el grabador puesto daba
   * 60fps y despues la ronda se caia a 12. Se graba en falso mientras corre
   * la cuenta, se descarta, y recien ahi se decide la resolucion.
   */
  cancelar() {
    try { if (this.rec && this.rec.state !== 'inactive') this.rec.stop(); } catch { /* noop */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.mezcla?.cerrar();
    this.mezcla = null;
    this.chunks = [];
    this.rec = null;
    this.stream = null;
  }

  stop() {
    return new Promise((resolve) => {
      const soltar = () => {
        // OBLIGATORIO. Parar el MediaRecorder NO corta la captura del canvas:
        // el track de captureStream sigue vivo y sigue leyendo el canvas en
        // cada frame. Sin esto, la ronda 2 corria con DOS capturas del mismo
        // canvas encima, la 3 con tres. En iOS, donde capturar el canvas es
        // lo mas caro del frame, eso es exactamente "el primer clip salio a
        // 60 y el segundo bajo".
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        // El AudioContext también: cada ronda abría uno y los navegadores
        // tienen un tope de contextos vivos por pestaña (seis en Chrome).
        this.mezcla?.cerrar();
        this.mezcla = null;
      };
      if (!this.rec || this.rec.state === 'inactive') { soltar(); return resolve(null); }
      this.rec.onstop = () => {
        const type = this.rec.mimeType || this.mime || 'video/webm';
        soltar();
        resolve(new Blob(this.chunks, { type }));
      };
      this.rec.stop();
    });
  }
}

const extFor = (blob) => (blob.type.includes('mp4') ? 'mp4' : 'webm');

/** Intenta compartir nativo (TikTok/IG directo). Si no, descarga. */
export async function shareOrDownload(blob, aura, prefijo = 'mi-aura') {
  const name = `${prefijo}-${aura}.${extFor(blob)}`;
  const file = new File([blob], name, { type: blob.type });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: `Mi aura: ${aura.toLocaleString('es-GT')}`,
        text: `Saqué ${aura.toLocaleString('es-GT')} de aura. Probá vos:`,
      });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  return 'downloaded';
}
