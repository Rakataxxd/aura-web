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
  // brazos estirados de verdad: shoulder->wrist ~1 torso, como un adulto
  'manos-arriba': () => { const l = base(); l[13] = P(0.42, 0.16); l[14] = P(0.58, 0.16); l[15] = P(0.44, 0.02); l[16] = P(0.56, 0.02); return l; },
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
/**
 * 6-7 real: manos ABIERTAS hacia afuera a la altura del pecho, palmas
 * arriba, antebrazos casi horizontales, codos pegados al cuerpo y casi
 * quietos mientras las manos alternan. Esa geometria es la que lo separa
 * de mover los brazos en general.
 */
function sixSeven(phase) {
  const l = base();
  const d = Math.sin(phase) * 0.07;
  l[13] = P(0.36, 0.42 + d * 0.12); l[14] = P(0.64, 0.42 - d * 0.12);  // codos casi fijos
  l[15] = P(0.22, 0.44 + d); l[16] = P(0.78, 0.44 - d);                // manos afuera
  return l;
}

/**
 * Giro: de frente -> perfil -> de frente PERO con los hombros invertidos.
 * Arranca de frente a proposito: el detector se auto-normaliza contra el
 * ancho maximo reciente del propio cuerpo, asi que necesita verlo abierto.
 */
function spin(frac) {
  const l = base();
  const perfil = () => { l[11] = P(0.48, 0.30); l[12] = P(0.52, 0.30); };
  const alReves = () => { l[11] = P(0.57, 0.30); l[12] = P(0.43, 0.30); };
  if (frac < 0.18) return l;              // de frente
  if (frac < 0.34) { perfil(); return l; }
  if (frac < 0.55) { alReves(); return l; }   // de espaldas: hombros invertidos
  if (frac < 0.70) { perfil(); return l; }
  return l;                               // de frente otra vez: vuelta completa
}

/** Corredor de perfil: la nariz va por delante del hombro. No debe girar. */
function corriendo(frac) {
  const l = base();
  const w = 0.022;
  l[11] = P(0.5 - w, 0.30); l[12] = P(0.5 + w, 0.30);
  l[0] = P(0.5 + (frac < 0.5 ? 0.06 : -0.06), 0.18);   // nariz fuera del torso
  return l;
}

// LCG determinista: los tests tienen que dar siempre lo mismo.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

/**
 * Version DESPROLIJA de una pose: como la hace una persona real.
 * - ruido de landmark (MediaPipe tiembla ~0.005 aunque no te muevas)
 * - la pose no llega al extremo, se queda al 80% del camino
 * - visibility mediocre
 * - balanceo lento del cuerpo
 *
 * Este es el test que faltaba. Con poses perfectas y perfectamente
 * quietas todo pasaba, y por eso no detecte que habia apretado de mas.
 */
function desprolijo(make, f, seed = 7, flojera = 0.2) {
  const r = rng(seed + f * 31);
  const base0 = base();
  const l = make();
  const drift = Math.sin(f * 0.07) * 0.012;
  return l.map((p, i) => ({
    x: p.x + (p.x - base0[i].x) * -flojera + r() * 0.005 + drift,
    y: p.y + (p.y - base0[i].y) * -flojera + r() * 0.005,
    z: 0,
    visibility: 0.68,
  }));
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

  // --- las mismas poses pero DESPROLIJAS (como las hace una persona) ---
  out.desprolijo = {};
  for (const [id, make] of Object.entries(POSES)) {
    if (id === 'neutral') continue;
    const det = new MoveDetector();
    const hits = new Set();
    for (let f = 0; f < 40; f++) det.feed(desprolijo(make, f), dt).forEach((m) => hits.add(m.id));
    out.desprolijo[id] = [...hits];
    if (!hits.has(id)) out.no_detectados.push(`desprolijo:${id}`);
  }

  // --- moverse MUCHO y despues hacer la pose ---
  // Escenario exacto del bug: el filtro de quietud promediaba toda la
  // ventana, asi que lo que hiciste antes bloqueaba la pose de despues.
  out.moverse_y_luego_posar = {};
  for (const [id, make] of Object.entries(POSES)) {
    if (id === 'neutral') continue;
    const det = new MoveDetector();
    const hits = new Set();
    for (let f = 0; f < 45; f++) {           // 1.5s sacudiendose
      const l = base();
      const s = Math.sin(f * 0.9) * 0.16;
      l[15] = P(0.40 + s, 0.54 - s); l[16] = P(0.60 - s, 0.54 + s);
      l[13] = P(0.41 + s, 0.42); l[14] = P(0.59 - s, 0.42);
      det.feed(l, dt);
    }
    for (let f = 0; f < 30; f++) det.feed(desprolijo(make, f), dt).forEach((m) => hits.add(m.id));
    out.moverse_y_luego_posar[id] = [...hits];
    if (!hits.has(id)) out.no_detectados.push(`tras-moverse:${id}`);
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
    for (let f = 0; f < 55; f++) det.feed(spin(f / 55), dt).forEach((m) => hits.add(m.id));
    out.detectados['giro'] = [...hits];
    if (!hits.has('giro')) out.no_detectados.push('giro');
  }

  // --- corredor de perfil: no debe disparar NADA (caso del video real) ---
  {
    const det = new MoveDetector();
    const hits = new Set();
    for (let f = 0; f < 120; f++) det.feed(corriendo(f / 120), dt).forEach((m) => hits.add(m.id));
    out.corriendo_de_perfil_falsos = [...hits];
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
