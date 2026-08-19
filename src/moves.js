// NIVEL 2: movimientos con nombre, detectados por reglas de angulos.
// Sin dataset, sin entrenamiento. Un dia de trabajo, y es de donde sale
// el "¡me reconocio el move!" que es el 90% del valor percibido.
//
// Todo se mide en TORSOS, no en pixeles: asi da igual que tan lejos
// estes de la camara o que tan alto seas.

import { NOSE, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN } from './landmarks.js';

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const vis = (lm, ...idx) => idx.every((i) => (lm[i].visibility ?? 1) > 0.5);

/** Angulo en grados en el vertice b. */
function angle(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (d < 1e-6) return 180;
  return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d))) * 180 / Math.PI;
}

/** Contexto normalizado. y negativo = arriba del pecho. */
export function buildCtx(lm) {
  const sc = mid(lm[L_SH], lm[R_SH]);
  const hc = mid(lm[L_HIP], lm[R_HIP]);
  const T = dist(sc, hc);
  if (!(T > 0.02)) return null;
  const n = (p) => ({ x: (p.x - sc.x) / T, y: (p.y - sc.y) / T });
  return {
    lm, T, sc, hc, n,
    nose: n(lm[NOSE]),
    lWr: n(lm[L_WR]), rWr: n(lm[R_WR]),
    lAn: n(lm[L_AN]), rAn: n(lm[R_AN]),
    hip: n(hc),
    knee: n(mid(lm[L_KN], lm[R_KN])),
    lElbow: angle(lm[L_SH], lm[L_EL], lm[L_WR]),
    rElbow: angle(lm[R_SH], lm[R_EL], lm[R_WR]),
    shoulderW: Math.abs(lm[L_SH].x - lm[R_SH].x) / T,
    wristGap: dist(lm[L_WR], lm[R_WR]) / T,
    noseToL: dist(lm[L_WR], lm[NOSE]) / T,
    noseToR: dist(lm[R_WR], lm[NOSE]) / T,
  };
}

// hold = segundos que hay que sostenerlo; cd = cooldown antes de repetir
export const MOVES = [
  {
    id: 'six-seven', name: '6-7', bonus: 9000, hold: 0, cd: 6,
    line: 'SEIS… SIETE. CONFIRMADO.',
    temporal: true,
  },
  {
    id: 'scuba', name: 'SCUBA', bonus: 7000, hold: 0.25, cd: 5,
    line: 'INMERSIÓN DETECTADA',
    test: (c) => c.noseToL < 0.75 && c.noseToR < 0.75
      && c.lWr.y < 0.05 && c.rWr.y < 0.05
      && c.lElbow < 130 && c.rElbow < 130,
  },
  {
    id: 'dab', name: 'DAB', bonus: 6000, hold: 0.2, cd: 5,
    line: 'ESO ES DE 2016 PERO SUMA',
    test: (c) => {
      const tuckL = c.noseToL < 0.65 && c.rElbow > 145 && c.rWr.y < -0.15 && Math.abs(c.rWr.x) > 0.95;
      const tuckR = c.noseToR < 0.65 && c.lElbow > 145 && c.lWr.y < -0.15 && Math.abs(c.lWr.x) > 0.95;
      return tuckL || tuckR;
    },
  },
  {
    id: 'dap', name: 'DAP', bonus: 12000, hold: 0.15, cd: 6,
    line: '¡DAP REGISTRADO! AURA COMPARTIDA',
    versus: true,   // requiere 2 personas, se evalua aparte
  },
  {
    id: 't-pose', name: 'T-POSE', bonus: 5000, hold: 0.35, cd: 6,
    line: 'AFIRMANDO DOMINANCIA',
    test: (c) => c.lElbow > 152 && c.rElbow > 152
      && Math.abs(c.lWr.y) < 0.42 && Math.abs(c.rWr.y) < 0.42
      && Math.abs(c.lWr.x) > 1.25 && Math.abs(c.rWr.x) > 1.25,
  },
  {
    id: 'manos-arriba', name: 'MANOS ARRIBA', bonus: 3500, hold: 0.25, cd: 5,
    line: 'INVOCANDO ALGO',
    test: (c) => c.lWr.y < -0.85 && c.rWr.y < -0.85,
  },
  {
    id: 'patada', name: 'PATADA ALTA', bonus: 6500, hold: 0.1, cd: 5,
    line: 'ILEGAL EN COMPETENCIA',
    test: (c) => c.lAn.y < c.hip.y || c.rAn.y < c.hip.y,
  },
  {
    id: 'sentadilla', name: 'BAJANDO', bonus: 4000, hold: 0.3, cd: 5,
    line: 'HASTA EL SUELO',
    // las dos rodillas a la misma altura: si una esta arriba es una patada,
    // no una sentadilla (ese era un falso positivo real)
    test: (c) => c.hip.y > c.knee.y - 0.22
      && Math.abs(c.n(c.lm[L_KN]).y - c.n(c.lm[R_KN]).y) < 0.35
      && c.lAn.y > c.knee.y && c.rAn.y > c.knee.y,
  },
  {
    id: 'cruzado', name: 'BRAZOS CRUZADOS', bonus: 3000, hold: 0.35, cd: 6,
    line: 'DESAPROBACIÓN TOTAL',
    test: (c) => {
      const shSign = Math.sign(c.lm[L_SH].x - c.lm[R_SH].x);
      const wrSign = Math.sign(c.lm[L_WR].x - c.lm[R_WR].x);
      return shSign !== 0 && wrSign !== 0 && shSign !== wrSign
        && c.wristGap < 1.1 && c.lWr.y > 0.05 && c.lWr.y < 1.0;
    },
  },
  {
    id: 'rezo', name: 'PLEGARIA', bonus: 3000, hold: 0.4, cd: 6,
    line: 'PIDIENDO AYUDA SUPERIOR',
    test: (c) => c.wristGap < 0.32 && c.lWr.y > -0.5 && c.lWr.y < 0.7
      && c.lElbow < 120 && c.rElbow < 120,
  },
  {
    id: 'giro', name: 'GIRO COMPLETO', bonus: 5500, hold: 0, cd: 5,
    line: 'ROTACIÓN NO AUTORIZADA',
    temporal: true,
  },
];

const BY_ID = Object.fromEntries(MOVES.map((m) => [m.id, m]));

export class MoveDetector {
  constructor() {
    this.held = {};       // segundos acumulados por move
    this.cool = {};       // cooldown restante
    this.flips = [];      // cruces por cero para 6-7
    this.lastSign = 0;
    this.postureGrace = 0;
    this.spin = { narrow: false, at: 0 };
    this.t = 0;
  }

  /** Devuelve array de moves detectados este frame. */
  feed(lm, dt) {
    this.t += dt;
    for (const k in this.cool) this.cool[k] -= dt;
    if (!lm) return [];
    const c = buildCtx(lm);
    if (!c) return [];

    const out = [];
    const fire = (m) => {
      if ((this.cool[m.id] ?? 0) > 0) return;
      this.cool[m.id] = m.cd;
      this.held[m.id] = 0;
      out.push(m);
    };

    // --- moves estaticos ---
    for (const m of MOVES) {
      if (!m.test) continue;
      let ok = false;
      try { ok = m.test(c); } catch { ok = false; }
      if (ok) {
        this.held[m.id] = (this.held[m.id] ?? 0) + dt;
        if (this.held[m.id] >= m.hold) fire(m);
      } else {
        this.held[m.id] = 0;
      }
    }

    // --- 6-7: manos a la altura del pecho alternando arriba/abajo ---
    const posture = vis(lm, L_WR, R_WR)
      && c.lWr.y > -0.25 && c.lWr.y < 1.25
      && c.rWr.y > -0.25 && c.rWr.y < 1.25
      && c.lElbow > 22 && c.lElbow < 160
      && c.rElbow > 22 && c.rElbow < 160
      && c.wristGap > 0.6;
    if (posture) {
      this.postureGrace = 0.35;
      const d = c.lWr.y - c.rWr.y;
      const s = Math.abs(d) > 0.22 ? Math.sign(d) : 0;
      if (s !== 0 && s !== this.lastSign) {
        if (this.lastSign !== 0) this.flips.push(this.t);
        this.lastSign = s;
      }
    } else {
      // en los extremos del movimiento el brazo se estira y la postura
      // falla un frame; sin gracia se pierde la racha y nunca dispara
      this.postureGrace -= dt;
      if (this.postureGrace <= 0) { this.lastSign = 0; this.flips.length = 0; }
    }
    this.flips = this.flips.filter((x) => this.t - x < 2.0);
    if (this.flips.length >= 3) { this.flips = []; fire(BY_ID['six-seven']); }

    // --- giro: el ancho de hombros colapsa (de perfil) y vuelve ---
    if (c.shoulderW < 0.24) { this.spin.narrow = true; this.spin.at = this.t; }
    else if (this.spin.narrow && c.shoulderW > 0.48) {
      this.spin.narrow = false;
      if (this.t - this.spin.at < 1.4) fire(BY_ID['giro']);
    }
    if (this.t - this.spin.at > 1.6) this.spin.narrow = false;

    return out;
  }
}

/** DAP: dos personas chocando manos. Se evalua sobre el par, no por jugador. */
export function detectDap(lmA, lmB) {
  if (!lmA || !lmB) return false;
  const cA = buildCtx(lmA), cB = buildCtx(lmB);
  if (!cA || !cB) return false;
  const T = (cA.T + cB.T) / 2;
  let best = Infinity;
  for (const [a, ca] of [[L_WR, cA], [R_WR, cA]]) {
    for (const [b, cb] of [[L_WR, cB], [R_WR, cB]]) {
      if (!vis(lmA, a) || !vis(lmB, b)) continue;
      // ambas manos levantadas: con los brazos colgando no hay dap,
      // solo dos personas paradas cerca (era un falso positivo)
      if (ca.n(lmA[a]).y > ca.hip.y - 0.25) continue;
      if (cb.n(lmB[b]).y > cb.hip.y - 0.25) continue;
      best = Math.min(best, dist(lmA[a], lmB[b]) / T);
    }
  }
  return best < 0.42;
}

export const DAP = BY_ID['dap'];
