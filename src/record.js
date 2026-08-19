// El clip ES el producto. Sin clip para postear no hay crecimiento.
// Safari no soporta webm -> hay que negociar el codec, no asumirlo.

const CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* noop */ }
  }
  return '';
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
  start(fps = 60) {
    if (!this.supported) return false;
    this.chunks = [];
    const stream = this.canvas.captureStream(fps);
    // Medido: Chrome entrega ~2.4x el bitrate pedido con esta cantidad de
    // movimiento. 3.5M -> ~8Mbps reales -> ~14MB por clip de 15s a 60fps,
    // que todavia se comparte bien con datos moviles.
    const opts = { videoBitsPerSecond: 3_500_000 };
    if (this.mime) opts.mimeType = this.mime;
    try {
      this.rec = new MediaRecorder(stream, opts);
    } catch {
      try { this.rec = new MediaRecorder(stream); } catch { return false; }
    }
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(250);
    return true;
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.rec || this.rec.state === 'inactive') return resolve(null);
      this.rec.onstop = () => {
        const type = this.rec.mimeType || this.mime || 'video/webm';
        resolve(new Blob(this.chunks, { type }));
      };
      this.rec.stop();
    });
  }
}

const extFor = (blob) => (blob.type.includes('mp4') ? 'mp4' : 'webm');

/** Intenta compartir nativo (TikTok/IG directo). Si no, descarga. */
export async function shareOrDownload(blob, aura) {
  const name = `mi-aura-${aura}.${extFor(blob)}`;
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
