// Verifica que cada detector dispare con una pose construida a proposito,
// que NO dispare con una pose neutral, y —lo importante— que el resultado
// sea EL MISMO con el telefono parado que acostado.
//
// POR QUE SE REESCRIBIO:
// La version anterior armaba los muñecos escribiendo coordenadas
// normalizadas a mano. Sin querer, esas coordenadas modelaban un cuadro
// APAISADO (hombros a 0.14 de ancho contra un torso de 0.28). Todo pasaba
// en el test y nada funcionaba en un telefono vertical, donde las distancias
// horizontales valen 3.2x mas. Ahora el cuerpo se define en unidades
// FISICAS y se proyecta al encuadre que se quiera probar, asi que la
// distorsion de aspecto es parte del test en vez de estar escondida en el.

import { MoveDetector, detectDap, buildCtx } from './moves.js';
import { toMetric } from './landmarks.js';

// Cuerpo de adulto de pie, en fracciones de su propia altura. Origen en el
// centro del cuerpo, +y hacia abajo (0 = coronilla, 1 = pies).
// Comprobaciones: torso (hombros->caderas) = 0.29, ancho de hombros = 0.23,
// nariz->hombros = 0.12, brazo entero hombro->muñeca = 0.33.
const CUERPO = {
  0: [0, 0.06],
  11: [-0.115, 0.18], 12: [0.115, 0.18],
  13: [-0.145, 0.34], 14: [0.145, 0.34],
  15: [-0.155, 0.49], 16: [0.155, 0.49],
  23: [-0.06, 0.47], 24: [0.06, 0.47],
  25: [-0.06, 0.71], 26: [0.06, 0.71],
  27: [-0.06, 0.96], 28: [0.06, 0.96],
};

// Encuadres reales. `alto` = cuanto del alto del cuadro ocupa la persona.
const ENCUADRES = {
  'vertical': { ar: 9 / 16, alto: 0.85 },        // telefono parado: EL caso de uso
  'apaisado': { ar: 16 / 9, alto: 0.85 },        // laptop / telefono acostado
  'cuadrado': { ar: 1, alto: 0.85 },
  'vertical-lejos': { ar: 9 / 16, alto: 0.6 },   // parado y alejado
};
const SELFIE = { ar: 9 / 16, alto: 1.5, cy: 0.81 };   // piernas fuera de cuadro
// Batalla a corta distancia: sentado, medio cuerpo, brazos entrando y
// saliendo del cuadro. ES EL CASO DE USO REAL de la app, medido contra un
// video de verdad (T = 0.36 de la altura del cuadro -> alto ~1.25).
const CERCA = { ar: 9 / 16, alto: 1.3, cy: 0.78 };

const clonar = () => Object.fromEntries(Object.entries(CUERPO).map(([k, v]) => [k, [...v]]));

/**
 * Proyecta un cuerpo fisico a landmarks de MediaPipe para un encuadre dado,
 * y devuelve ya el espacio metrico (que es lo que consume moves.js).
 * Lo que esta fuera del cuadro sale con visibility baja, igual que MediaPipe.
 */
function proyectar(fis, { ar, alto, cx = 0.5, cy = 0.5 }) {
  const lm = Array.from({ length: 33 }, () => ({ x: cx, y: cy, z: 0, visibility: 0.1 }));
  for (const [i, [fx, fy]] of Object.entries(fis)) {
    const x = cx + (fx * alto) / ar;
    const y = cy + (fy - 0.5) * alto;
    const dentro = x > 0 && x < 1 && y > 0 && y < 1;
    lm[+i] = { x, y, z: 0, visibility: dentro ? 0.92 : 0.1 };
  }
  return toMetric(lm, ar);
}

// ---------- poses, en unidades fisicas ----------
const POSES = {
  't-pose': () => { const b = clonar(); b[13] = [-0.30, 0.18]; b[14] = [0.30, 0.18]; b[15] = [-0.44, 0.18]; b[16] = [0.44, 0.18]; return b; },
  'manos-arriba': () => { const b = clonar(); b[13] = [-0.14, 0.02]; b[14] = [0.14, 0.02]; b[15] = [-0.10, -0.14]; b[16] = [0.10, -0.14]; return b; },
  // SCUBA: derecha en la BOCA (el regulador), izquierda plegada moviendose
  // frente al pecho.
  //
  // ESTE MUÑECO MODELABA OTRO GESTO: tenia la mano izquierda plana SOBRE LA
  // CABEZA. El test daba verde y en la app el scuba no salia nunca, porque
  // nadie hace esa pose — en 15 segundos de video haciendo scuba a proposito
  // no hay un solo cuadro con una mano arriba de la cabeza. Los numeros de
  // aca salen de esos 112 cuadros: mano de la boca a la altura de los
  // hombros, mano libre al pecho (0.37 torsos por debajo) y pegada al eje.
  'scuba': () => {
    const b = clonar();
    b[14] = [0.145, 0.30]; b[16] = [0.09, 0.16];      // derecha: en la boca
    b[13] = [-0.175, 0.325]; b[15] = [-0.055, 0.296]; // izquierda: plegada al pecho
    return b;
  },
  'mewing': () => { const b = clonar(); b[14] = [0.14, 0.24]; b[16] = [0.055, 0.11]; return b; },
  'rezo': () => { const b = clonar(); b[13] = [-0.16, 0.32]; b[14] = [0.16, 0.32]; b[15] = [-0.02, 0.28]; b[16] = [0.02, 0.28]; return b; },
  'sentadilla': () => { const b = clonar(); b[23] = [-0.07, 0.62]; b[24] = [0.07, 0.62]; b[25] = [-0.09, 0.68]; b[26] = [0.09, 0.68]; return b; },
  // DAB: brazo derecho plegado con la cara adentro, izquierdo estirado en
  // diagonal hacia arriba. Las medidas salen del video real: el brazo
  // estirado se ve FORZOSAMENTE acortado (apunta en diagonal y hacia la
  // camara), no llega ni cerca de la envergadura completa.
  'dab': () => {
    const b = clonar();
    b[13] = [-0.21, 0.09]; b[15] = [-0.30, 0.02];   // izquierdo estirado arriba
    b[14] = [0.12, 0.20]; b[16] = [0.01, 0.11];     // derecho plegado en la cara
    return b;
  },
  'neutral': clonar,
};

/**
 * 6-7: manos al pecho, codos pegados, alternando arriba y abajo.
 *
 * Las muñecas van MAS ADENTRO que los codos. La version anterior las ponia
 * por fuera (0.22 contra 0.13), que es como uno se imagina el gesto pero no
 * como sale: MEDIDO en dos videos reales, la mano queda a 0.2-0.6 torsos del
 * eje y el codo a 0.5-0.67. Importa porque un t-pose flojo y sentado deja
 * las muñecas justo en ese rango, y "por dentro del codo" es lo unico que
 * separa los dos gestos.
 */
function sixSeven(phase) {
  const b = clonar();
  const d = Math.sin(phase) * 0.07;
  b[13] = [-0.15, 0.36 + d * 0.1]; b[14] = [0.15, 0.36 - d * 0.1];
  b[15] = [-0.11, 0.30 + d]; b[16] = [0.11, 0.30 - d];
  return b;
}

/** Giro: de frente -> perfil -> de espaldas (hombros invertidos) -> de frente. */
function spin(frac) {
  const b = clonar();
  const perfil = () => { b[11] = [-0.03, 0.18]; b[12] = [0.03, 0.18]; };
  const alReves = () => { b[11] = [0.115, 0.18]; b[12] = [-0.115, 0.18]; };
  if (frac < 0.18) return b;
  if (frac < 0.34) { perfil(); return b; }
  if (frac < 0.55) { alReves(); return b; }
  if (frac < 0.70) { perfil(); return b; }
  return b;
}

/** Corredor de perfil: la nariz va por delante del hombro. No debe girar. */
function corriendo(frac) {
  const b = clonar();
  b[11] = [-0.018, 0.18]; b[12] = [0.018, 0.18];
  b[0] = [frac < 0.5 ? 0.09 : -0.09, 0.06];
  return b;
}

// LCG determinista: los tests tienen que dar siempre lo mismo.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

/**
 * Version DESPROLIJA de una pose: como la hace una persona real.
 * - ruido de landmark (MediaPipe tiembla aunque no te muevas)
 * - la pose no llega al extremo, se queda al 80% del camino
 * - balanceo lento del cuerpo
 */
function desprolijo(make, f, seed = 7, flojera = 0.2) {
  const r = rng(seed + f * 31);
  const base0 = clonar();
  const b = make();
  const drift = Math.sin(f * 0.07) * 0.010;
  const out = {};
  for (const i of Object.keys(b)) {
    const [x, y] = b[i], [bx, by] = base0[i];
    out[i] = [x + (x - bx) * -flojera + r() * 0.004 + drift, y + (y - by) * -flojera + r() * 0.004];
  }
  return out;
}

/** Corre un detector limpio sobre una secuencia de cuerpos fisicos. */
function correr(cuerpos, enc, frames) {
  const det = new MoveDetector();
  const hits = new Set();
  for (let f = 0; f < frames; f++) {
    det.feed(proyectar(cuerpos(f), enc), 1 / 30).forEach((m) => hits.add(m.id));
  }
  return [...hits];
}

export function run() {
  const out = { por_encuadre: {}, no_detectados: [], falsos_positivos: {} };

  // --- EL test: la misma pose fisica en todos los encuadres ---
  // Un move que solo aparece en una columna es un bug de aspecto, que es
  // exactamente lo que estaba roto.
  for (const [enc, cfg] of Object.entries(ENCUADRES)) {
    const col = {};
    for (const [id, make] of Object.entries(POSES)) {
      if (id === 'neutral') continue;
      col[id] = correr(() => make(), cfg, 30);
      if (!col[id].includes(id)) out.no_detectados.push(`${enc}:${id}`);
      // la misma pose hecha como la hace una persona real
      const flojo = correr((f) => desprolijo(make, f), cfg, 40);
      if (!flojo.includes(id)) out.no_detectados.push(`${enc}:desprolijo:${id}`);
    }
    col['six-seven'] = correr((f) => sixSeven(f * 0.42), cfg, 90);
    if (!col['six-seven'].includes('six-seven')) out.no_detectados.push(`${enc}:six-seven`);
    col['giro'] = correr((f) => spin(f / 55), cfg, 55);
    if (!col['giro'].includes('giro')) out.no_detectados.push(`${enc}:giro`);

    out.falsos_positivos[enc] = {
      neutral: correr(clonar, cfg, 60),
      corriendo_de_perfil: correr((f) => corriendo(f / 120), cfg, 120),
    };
    out.por_encuadre[enc] = col;
  }

  // --- batalla a corta distancia: sentado, medio cuerpo ---
  // Aca NO se prueban t-pose, manos-arriba ni sentadilla: a esa distancia
  // los brazos abiertos y las piernas quedan fuera del cuadro y no hay nada
  // que detectar. Eso no es un bug, es el encuadre; la app avisa "alejáte".
  out.cerca = {};
  for (const id of ['scuba', 'mewing', 'rezo', 'dab']) {
    out.cerca[id] = correr(() => POSES[id](), CERCA, 30);
    if (!out.cerca[id].includes(id)) out.no_detectados.push(`cerca:${id}`);
    const flojo = correr((f) => desprolijo(POSES[id], f), CERCA, 40);
    if (!flojo.includes(id)) out.no_detectados.push(`cerca:desprolijo:${id}`);
  }
  // 6-7 de cerca: las manos van mas juntas, si no se salen del cuadro
  {
    const cerca67 = (f) => {
      const b = clonar(); const d = Math.sin(f * 0.3) * 0.06;
      b[13] = [-0.14, 0.34 + d * 0.1]; b[14] = [0.14, 0.34 - d * 0.1];
      b[15] = [-0.09, 0.29 + d]; b[16] = [0.09, 0.29 - d];
      return b;
    };
    out.cerca['six-seven'] = correr(cerca67, CERCA, 90);
    if (!out.cerca['six-seven'].includes('six-seven')) out.no_detectados.push('cerca:six-seven');
  }
  // Sentado quieto NO es una sentadilla. En el video real "HASTA EL SUELO"
  // disparaba solo mientras el tipo estaba sentado haciendo gestos de cara.
  {
    const sentado = () => {
      const b = clonar();
      b[23] = [-0.07, 0.50]; b[24] = [0.07, 0.50];    // cadera y rodilla casi
      b[25] = [-0.10, 0.55]; b[26] = [0.10, 0.55];    // a la misma altura
      b[27] = [-0.10, 0.80]; b[28] = [0.10, 0.80];
      return b;
    };
    out.sentado_falsos = correr(sentado, CERCA, 60);
    if (out.sentado_falsos.length) out.no_detectados.push(`sentado-falso:${out.sentado_falsos}`);
  }

  // --- selfie: sin piernas, caderas al borde ---
  out.selfie = {};
  for (const id of ['scuba', 'mewing', 'rezo', 'manos-arriba']) {
    out.selfie[id] = correr(() => POSES[id](), SELFIE, 30);
    if (!out.selfie[id].includes(id)) out.no_detectados.push(`selfie:${id}`);
  }
  out.selfie_quieto_falsos = correr(clonar, SELFIE, 60);

  // --- moverse mucho y DESPUES posar (el filtro de quietud no debe bloquear) ---
  out.tras_moverse = {};
  for (const [id, make] of Object.entries(POSES)) {
    if (id === 'neutral') continue;
    const det = new MoveDetector();
    const hits = new Set();
    for (let f = 0; f < 45; f++) {
      const b = clonar();
      const s = Math.sin(f * 0.9) * 0.16;
      b[15] = [-0.155 + s, 0.49 - s]; b[16] = [0.155 - s, 0.49 + s];
      b[13] = [-0.145 + s, 0.34]; b[14] = [0.145 - s, 0.34];
      det.feed(proyectar(b, ENCUADRES.vertical), 1 / 30);
    }
    for (let f = 0; f < 30; f++) {
      det.feed(proyectar(desprolijo(make, f), ENCUADRES.vertical), 1 / 30).forEach((m) => hits.add(m.id));
    }
    out.tras_moverse[id] = [...hits];
    if (!hits.has(id)) out.no_detectados.push(`tras-moverse:${id}`);
  }

  // --- 6-7 como pasa de verdad: primero SUBIS los brazos, despues alternas.
  // Levantar los brazos mueve muchisimo los codos, y ese recorrido de
  // entrada seguia contando en la ventana durante el gesto: la comparacion
  // manos>codos no se cumplia nunca. Este es el caso que faltaba.
  out.six_seven_tras_subir_brazos = {};
  for (const paso of [0.30, 0.20]) {          // ~0.7s y ~1.05s por ciclo
    const secuencia = (f) => {
      if (f >= 20) return sixSeven((f - 20) * paso);
      const k = f / 20;                        // brazos que suben a posicion
      const a = clonar(), b = sixSeven(0);
      return Object.fromEntries(Object.keys(b).map((i) => [i, [
        a[i][0] + (b[i][0] - a[i][0]) * k,
        a[i][1] + (b[i][1] - a[i][1]) * k,
      ]]));
    };
    const hits = correr(secuencia, ENCUADRES.vertical, 100);
    out.six_seven_tras_subir_brazos[`ciclo_${paso}`] = hits;
    if (!hits.includes('six-seven')) out.no_detectados.push(`six-seven-tras-subir:${paso}`);
  }

  // 6-7 corto y desprolijo: ciclo y medio, y a mitad de camino las manos se
  // salen de la banda del pecho un instante (nadie lo hace limpio). Pedir 3
  // alternancias SIN romper la postura era pedir dos ciclos perfectos.
  {
    const secuencia = (f) => {
      const b = sixSeven(f * 0.26);
      if (f === 18 || f === 19) { b[15][1] += 0.22; b[16][1] += 0.22; }   // se cayeron
      return b;
    };
    const hits = correr(secuencia, ENCUADRES.vertical, 42);
    out.six_seven_corto = hits;
    if (!hits.includes('six-seven')) out.no_detectados.push('six-seven-corto');
  }

  // --- REPETIR el mismo gesto ---
  // En una ronda de 15 segundos, un cooldown de 5s por move significa que
  // hacerlo dos veces seguidas cuenta una sola. Se sentia como "no me lo
  // detecta" o "tiene delay". Lo que habilita repetir es SOLTARLO.
  out.repeticion = {};
  for (const id of ['mewing', 'dab', 'scuba', 't-pose', 'rezo']) {
    const det = new MoveDetector();
    let n = 0;
    const correrPaso = (frames, make) => {
      for (let f = 0; f < frames; f++) {
        det.feed(proyectar(make(), ENCUADRES.vertical), 1 / 30)
          .forEach((m) => { if (m.id === id) n++; });
      }
    };
    correrPaso(20, POSES[id]);   // lo hago
    correrPaso(12, clonar);      // lo suelto (0.4s)
    correrPaso(20, POSES[id]);   // lo hago otra vez -> tiene que contar
    out.repeticion[id] = n;
    if (n < 2) out.no_detectados.push(`repeticion:${id} (solo ${n})`);
  }
  // ...pero SOSTENERLO sin soltar sigue contando una sola vez
  {
    const det = new MoveDetector();
    let n = 0;
    for (let f = 0; f < 150; f++) {   // 5 segundos sin moverse
      det.feed(proyectar(POSES.mewing(), ENCUADRES.vertical), 1 / 30)
        .forEach((m) => { if (m.id === 'mewing') n++; });
    }
    out.sostenido_debe_ser_1 = n;
    if (n !== 1) out.no_detectados.push(`sostenido:mewing disparo ${n} veces`);
  }

  // --- dap (dos personas), en los dos encuadres ---
  out.dap = {};
  for (const [enc, cfg0] of Object.entries(ENCUADRES)) {
    // Dos cuerpos enteros solo entran si estan mas lejos: en 9:16 el cuadro
    // mide 0.56 alturas de ancho y dos personas separadas ocupan ~0.8.
    const cfg = { ...cfg0, alto: Math.min(cfg0.alto, 0.6) };
    const sep = (b, dx) => Object.fromEntries(Object.entries(b).map(([k, [x, y]]) => [k, [x + dx, y]]));
    const quietos = [proyectar(sep(clonar(), -0.28), cfg), proyectar(sep(clonar(), 0.28), cfg)];
    const a = sep(clonar(), -0.28), c = sep(clonar(), 0.28);
    a[14] = [-0.28 + 0.13, 0.30]; a[16] = [-0.28 + 0.25, 0.24];   // manos que se chocan
    c[13] = [0.28 - 0.13, 0.30]; c[15] = [0.28 - 0.25, 0.24];     // en el medio
    out.dap[enc] = {
      separados_debe_ser_false: detectDap(quietos[0], quietos[1]),
      chocando_debe_ser_true: detectDap(proyectar(a, cfg), proyectar(c, cfg)),
    };
    if (!out.dap[enc].chocando_debe_ser_true) out.no_detectados.push(`dap:${enc}`);
    if (out.dap[enc].separados_debe_ser_false) out.no_detectados.push(`dap-falso-positivo:${enc}`);
  }

  out.ctx_ok = !!buildCtx(proyectar(clonar(), ENCUADRES.vertical));
  out.ok = out.no_detectados.length === 0
    && Object.values(out.falsos_positivos).every((f) => !f.neutral.length && !f.corriendo_de_perfil.length)
    && !out.selfie_quieto_falsos.length;
  return out;
}
