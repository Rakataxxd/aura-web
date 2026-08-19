// Verifica que cada detector dispare con una pose construida a proposito,
// y que NO dispare con una pose neutral (falsos positivos).
import { MoveDetector, detectDap, buildCtx } from './moves.js';

const P = (x, y, v = 0.95) => ({ x, y, z: 0, visibility: v });

/** Cuerpo base de pie, brazos abajo. Todo lo demas parte de aca. */
function base() {
  const lm = Array.from({ length: 33 }, () => P(0.5, 0.5));
  lm[0] = P(0.50, 0.18);                       // nariz
  lm[11] = P(0.43, 0.30); lm[12] = P(0.57, 0.30);  // hombros
  lm[13] = P(0.41, 0.42); lm[14] = P(0.59, 0.42);  // codos
  lm[15] = P(0.40, 0.54); lm[16] = P(0.60, 0.54);  // munecas
  lm[23] = P(0.45, 0.58); lm[24] = P(0.55, 0.58);  // caderas
  lm[25] = P(0.45, 0.74); lm[26] = P(0.55, 0.74);  // rodillas
  lm[27] = P(0.45, 0.90); lm[28] = P(0.55, 0.90);  // tobillos
  return lm;
}

/** Encuadre selfie: piernas fuera de cuadro -> MediaPipe las inventa con
 *  visibility baja. Este es el caso que hacia disparar moves de piernas
 *  sin parar y corrompia la escala de torso. */
function selfie(make = base) {
  const l = make();
  for (const i of [25, 26, 27, 28, 29, 30, 31, 32]) l[i] = P(0.5 + (i % 2 ? 0.05 : -0.05), 0.35, 0.12);
  l[23] = P(0.45, 0.58, 0.45); l[24] = P(0.55, 0.58, 0.45);   // caderas al borde
  return l;
}

const POSES = {
  't-pose': () => { const l = base(); l[13] = P(0.28, 0.30); l[14] = P(0.72, 0.30); l[15] = P(0.13, 0.30); l[16] = P(0.87, 0.30); return l; },
  'manos-arriba': () => { const l = base(); l[13] = P(0.42, 0.20); l[14] = P(0.58, 0.20); l[15] = P(0.44, 0.05); l[16] = P(0.56, 0.05); return l; },
  'scuba': () => { const l = base(); l[13] = P(0.34, 0.30); l[14] = P(0.66, 0.30); l[15] = P(0.44, 0.19); l[16] = P(0.56, 0.19); return l; },
  'mewing': () => { const l = base(); l[14] = P(0.64, 0.32); l[16] = P(0.56, 0.24); return l; },
  'rezo': () => { const l = base(); l[13] = P(0.38, 0.40); l[14] = P(0.62, 0.40); l[15] = P(0.49, 0.40); l[16] = P(0.51, 0.40); return l; },
  'sentadilla': () => { const l = base(); l[23] = P(0.45, 0.70); l[24] = P(0.55, 0.70); l[25] = P(0.44, 0.74); l[26] = P(0.56, 0.74); return l; },
  'neutral': base,
};

// Los mismos gestos pero en encuadre selfie: deben seguir detectandose,
// porque su escala de referencia es la cara, no el torso.
const POSES_SELFIE = {
  'scuba': () => selfie(POSES['scuba']),
  'mewing': () => selfie(POSES['mewing']),
  't-pose': () => selfie(POSES['t-pose']),
  'manos-arriba': () => selfie(POSES['manos-arriba']),
};

/** 6-7: manos al pecho alternando arriba y abajo. */
function sixSeven(phase) {
  const l = base();
  const d = Math.sin(phase) * 0.075;
  // los codos acompañan a las munecas: si se quedan fijos el angulo del
  // brazo se vuelve absurdo en los extremos y la pose deja de ser realista
  l[13] = P(0.34, 0.42 + d * 0.5); l[14] = P(0.66, 0.42 - d * 0.5);
  l[15] = P(0.36, 0.44 + d); l[16] = P(0.64, 0.44 - d);
  return l;
}

/** Giro: los hombros colapsan (perfil) y vuelven a abrirse. */
function spin(frac) {
  const l = base();
  const w = frac < 0.5 ? 0.012 : 0.07;   // angosto -> ancho
  l[11] = P(0.5 - w, 0.30); l[12] = P(0.5 + w, 0.30);
  return l;
}

export function run() {
  const dt = 1 / 30;
  const out = { detectados: {}, falsos_positivos: [], no_detectados: [] };

  // --- estaticos ---
  for (const [id, make] of Object.entries(POSES)) {
    const det = new MoveDetector();
    const hits = new Set();
    for (let f = 0; f < 30; f++) det.feed(make(), dt).forEach((m) => hits.add(m.id));
    if (id === 'neutral') {
      out.falsos_positivos = [...hits];
    } else {
      out.detectados[id] = [...hits];
      if (!hits.has(id)) out.no_detectados.push(id);
    }
  }

  // --- mismos gestos en encuadre selfie (sin piernas) ---
  out.selfie = {};
  for (const [id, make] of Object.entries(POSES_SELFIE)) {
    const det = new MoveDetector();
    const hits = new Set();
    for (let f = 0; f < 30; f++) det.feed(make(), dt).forEach((m) => hits.add(m.id));
    out.selfie[id] = [...hits];
    if (!hits.has(id)) out.no_detectados.push(`selfie:${id}`);
  }
  // selfie quieto: no debe disparar NADA (aca salia 'patada' sin parar)
  {
    const det = new MoveDetector();
    const hits = new Set();
    for (let f = 0; f < 60; f++) det.feed(selfie(), dt).forEach((m) => hits.add(m.id));
    out.selfie_quieto_falsos = [...hits];
  }

  // --- 6-7 (temporal) ---
  {
    const det = new MoveDetector();
    const hits = new Set();
    for (let f = 0; f < 90; f++) det.feed(sixSeven(f * 0.42), dt).forEach((m) => hits.add(m.id));
    out.detectados['six-seven'] = [...hits];
    if (!hits.has('six-seven')) out.no_detectados.push('six-seven');
  }

  // --- giro (temporal) ---
  {
    const det = new MoveDetector();
    const hits = new Set();
    for (let f = 0; f < 40; f++) det.feed(spin(f / 40), dt).forEach((m) => hits.add(m.id));
    out.detectados['giro'] = [...hits];
    if (!hits.has('giro')) out.no_detectados.push('giro');
  }

  // --- dap (dos personas) ---
  const a = base(); const b = base();
  for (let i = 0; i < 33; i++) b[i] = P(a[i].x + 0.30, a[i].y);
  const lejos = detectDap(a, b);                  // dos personas cerca, brazos colgando
  a[14] = P(0.64, 0.40); a[16] = P(0.66, 0.36);   // manos levantadas que se juntan
  b[13] = P(0.70, 0.40); b[15] = P(0.68, 0.36);
  const cerca = detectDap(a, b);
  out.dap = { separados_debe_ser_false: lejos, chocando_debe_ser_true: cerca };
  out.ctx_ok = !!buildCtx(base());
  return out;
}
