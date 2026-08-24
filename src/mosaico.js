// La repetición de la SALA: el clip con todas las cámaras, no solo la mía.
//
// POR QUÉ UN LIENZO APARTE Y NO EL DEL JUEGO. El canvas del juego es MI
// recuadro: lo dibuja el renderer con mis efectos y encima cambia de tamaño
// según qué celda me toque en la grilla (en una sala de cuatro es un cuarto de
// pantalla). El mosaico es un lienzo fijo, del tamaño del archivo que se
// quiere producir, y se arma COPIANDO: mi canvas ya dibujado más los <video>
// de los demás. Copiar un canvas o un video a otro canvas es un blit de GPU;
// nada se dibuja dos veces.
//
// LAS CELDAS NO RECORTAN. En pantalla los recuadros usan `cover` porque llenar
// la celda se ve mejor, pero un clip que se guarda para siempre no se puede
// dar el lujo de cortarle la cabeza a nadie: acá todo entra completo y lo que
// sobra queda negro. Es el mismo problema que arregla `ajustarEncaje()` en la
// grilla, pero acá no hay caso en que convenga recortar.

const HUECO = 10;

// Proporción con la que se mide el "área útil" de una celda. Sin esto, dos
// personas en un lienzo apaisado empatan con dos apiladas y la elección de
// columnas sale por redondeo. Es la misma cuenta que `acomodarTiles()`.
const AR_CELDA = 4 / 3;

const FONDO = '#0c0c10';
const BORDE = 'rgba(244, 239, 228, .16)';
const ACID = '#c9ff2e';
const BONE = '#f4efe4';

// Cuánto puede diferir la proporción de un video de la de su recuadro antes de
// que deje de convenir recortarlo. Con 1.35: un 16:9 dentro de una celda
// apaisada sigue llenándola (se ve mejor), pero un teléfono vertical (9:16)
// dentro de esa misma celda pasa a entrar completo.
export const DESAJUSTE_MAX = 1.35;

/**
 * ¿Este video hay que meterlo entero en su recuadro en vez de recortarlo?
 *
 * `cover` llena la celda y es lo que uno quiere casi siempre. Pero cuando las
 * proporciones no se parecen en nada —un celular vertical metido en una celda
 * apaisada— `cover` deja ver una banda finita del centro del cuadro: en la
 * práctica, el techo de la habitación, con la persona entera afuera.
 *
 * Vive acá y no en main.js para que la grilla en pantalla y el clip usen el
 * mismo criterio, y para poder probarlo sin navegador.
 */
export function debeContener(arVideo, arCelda) {
  if (!(arVideo > 0) || !(arCelda > 0)) return false;
  return Math.max(arVideo / arCelda, arCelda / arVideo) > DESAJUSTE_MAX;
}

/** Columnas que dejan la celda más grande. Devuelve también el tamaño. */
export function repartir(W, H, n) {
  let mejor = { cols: 1, filas: n, cw: W, ch: H, util: -1 };
  for (let cols = 1; cols <= n; cols++) {
    const filas = Math.ceil(n / cols);
    const cw = (W - HUECO * (cols - 1)) / cols;
    const ch = (H - HUECO * (filas - 1)) / filas;
    if (cw <= 0 || ch <= 0) continue;
    const util = Math.min(cw, ch * AR_CELDA) * Math.min(cw / AR_CELDA, ch);
    if (util > mejor.util) mejor = { cols, filas, cw, ch, util };
  }
  return mejor;
}

/** Tamaño real de la fuente, sea un canvas o un video que todavía no cargó. */
function medida(f) {
  const w = f.videoWidth ?? f.width ?? 0;
  const h = f.videoHeight ?? f.height ?? 0;
  return w > 0 && h > 0 ? { w, h } : null;
}

export class Mosaico {
  constructor(ancho = 1280, alto = 720) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = ancho;
    this.canvas.height = alto;
    // `alpha: false` porque el fondo es opaco: le ahorra al compositor una
    // capa entera, y este lienzo se compone 30 veces por segundo.
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.ultimo = 0;
  }

  /**
   * Dibuja un cuadro del mosaico, como mucho `fps` veces por segundo.
   *
   * El acelerador NO es cosmético: `captureStream()` muestrea el lienzo cada
   * vez que cambia, así que dibujar a 60 en una sala de cuatro son cuatro
   * copias de video más por cuadro y el doble de trabajo para el codificador,
   * a cambio de nada — el video que llega de los demás viene a 15-24fps.
   *
   * @param {Array<{fuente: HTMLCanvasElement|HTMLVideoElement, alias: string,
   *   aura: number, yo: boolean, mudo: boolean}>} fuentes
   * @returns {boolean} si dibujó
   */
  dibujar(fuentes, fps = 30) {
    const ahora = performance.now();
    // -2ms de margen: sin eso, un cuadro que llega a 33.2ms cae al vsync
    // siguiente y el clip termina a 20fps en vez de 30.
    if (ahora - this.ultimo < 1000 / fps - 2) return false;
    this.ultimo = ahora;

    const { ctx } = this;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.fillStyle = '#08080a';
    ctx.fillRect(0, 0, W, H);

    const n = fuentes.length;
    if (!n) return true;
    const { cols, filas, cw, ch } = repartir(W, H, n);
    const y0 = (H - (filas * ch + HUECO * (filas - 1))) / 2;

    fuentes.forEach((f, i) => {
      const fila = Math.floor(i / cols);
      const enFila = Math.min(cols, n - fila * cols);
      // El último renglón va centrado, como en cualquier videollamada.
      const x0 = (W - (enFila * cw + HUECO * (enFila - 1))) / 2;
      const x = x0 + (i % cols) * (cw + HUECO);
      const y = y0 + fila * (ch + HUECO);
      this.celda(f, x, y, cw, ch);
    });
    return true;
  }

  celda(f, x, y, w, h) {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    ctx.fillStyle = FONDO;
    ctx.fillRect(x, y, w, h);

    const m = f.fuente && medida(f.fuente);
    if (m) {
      // Entra completo: escala la que quepa, y lo que sobra queda negro.
      const s = Math.min(w / m.w, h / m.h);
      const dw = m.w * s, dh = m.h * s;
      try {
        ctx.drawImage(f.fuente, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
      } catch { /* un video sin cuadro todavía: celda vacía y ya */ }
    }

    this.etiquetas(f, x, y, w, h);

    ctx.lineWidth = 2;
    ctx.strokeStyle = f.yo ? ACID : BORDE;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.restore();
  }

  etiquetas(f, x, y, w, h) {
    const { ctx } = this;
    const px = Math.max(11, Math.min(22, Math.round(h * 0.055)));
    const pad = Math.round(px * 0.5);
    const alto = px + pad;
    // La cajita deja un margen igual al padding contra el borde de la celda:
    // pegada al borde se come los 2px del marco y se ve como un error.
    const cajaY = y + h - pad - alto;
    const medio = cajaY + alto / 2;
    // `middle` en vez de `alphabetic`: centrar a ojo con la altura de la fuente
    // deja el texto corrido para arriba en cuanto el tamaño cambia con la celda.
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    const nombre = `${f.mudo ? '🔇 ' : ''}${f.alias}`.slice(0, 20);
    ctx.font = `700 ${px}px "Chakra Petch", system-ui, sans-serif`;
    const anchoN = ctx.measureText(nombre).width;
    ctx.fillStyle = 'rgba(10, 10, 12, .74)';
    ctx.fillRect(x + pad, cajaY, anchoN + pad * 2, alto);
    ctx.fillStyle = BONE;
    ctx.fillText(nombre, x + pad * 2, medio);

    const num = Math.round(f.aura || 0).toLocaleString('es-GT');
    ctx.font = `${px}px "Share Tech Mono", monospace`;
    const anchoA = ctx.measureText(num).width;
    ctx.fillStyle = 'rgba(10, 10, 12, .74)';
    ctx.fillRect(x + w - pad - anchoA - pad * 2, cajaY, anchoA + pad * 2, alto);
    ctx.fillStyle = ACID;
    ctx.fillText(num, x + w - pad * 2 - anchoA, medio);
  }
}
