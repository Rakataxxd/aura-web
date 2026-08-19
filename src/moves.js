// NIVEL 2: movimientos con nombre, detectados por reglas de angulos.
// Sin dataset, sin entrenamiento.
//
// DOS REGLAS QUE COSTARON BUGS REALES:
//
// 1. MediaPipe devuelve coordenadas para landmarks FUERA DE CUADRO, inventadas
//    y con visibility baja. Si no se filtran, un encuadre selfie produce
//    tobillos fantasma y dispara moves de piernas sin parar. Todo move declara
//    que landmarks necesita en `needs`.
//
// 2. Normalizar por torso (hombro->cadera) falla cuando las caderas estan al
//    borde o fuera del cuadro. Para gestos de cara se usa F (nariz->centro de
//    hombros) que sobrevive cualquier encuadre donde se te vea la cara.

import { NOSE, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN } from './landmarks.js';

const VIS = 0.55;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const seen = (lm, i) => (lm[i].visibility ?? 1) >= VIS;
const allSeen = (lm, idx) => idx.every((i) => seen(lm, i));

function angle(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (d < 1e-6) return 180;
  return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d))) * 180 / Math.PI;
}

export function buildCtx(lm) {
  if (!allSeen(lm, [L_SH, R_SH])) return null;   // sin hombros no hay nada
  const sc = mid(lm[L_SH], lm[R_SH]);
  const hc = mid(lm[L_HIP], lm[R_HIP]);

  const SW = dist(lm[L_SH], lm[R_SH]);           // ancho de hombros
  const F = dist(lm[NOSE], sc);                  // escala de cara: nariz -> hombros
  const hipsOk = allSeen(lm, [L_HIP, R_HIP]);

  // Torso real si se ven las caderas; si no, estimado desde la parte de
  // arriba. Asi los umbrales siguen expresados en torsos y funcionan igual
  // en un encuadre de cuerpo entero que en un selfie.
  let T = hipsOk ? dist(sc, hc) : 0;
  if (!(T > 0.02)) T = Math.max(SW * 0.95, F * 1.7);
  if (!(T > 0.02) || !(F > 0.01)) return null;

  const n = (p) => ({ x: (p.x - sc.x) / T, y: (p.y - sc.y) / T });
  return {
    lm, T, F, SW, sc, hipsOk, n,
    nose: lm[NOSE],
    lWr: n(lm[L_WR]), rWr: n(lm[R_WR]),
    lAn: n(lm[L_AN]), rAn: n(lm[R_AN]),
    hip: n(hc),
    knee: n(mid(lm[L_KN], lm[R_KN])),
    lElbow: angle(lm[L_SH], lm[L_EL], lm[L_WR]),
    rElbow: angle(lm[R_SH], lm[R_EL], lm[R_WR]),
    wristGap: dist(lm[L_WR], lm[R_WR]) / T,
    // distancias a la nariz medidas en ESCALAS DE CARA, no en torsos
    fL: dist(lm[L_WR], lm[NOSE]) / F,
    fR: dist(lm[R_WR], lm[NOSE]) / F,
  };
}

const ARMS = [L_SH, R_SH, L_EL, R_EL, L_WR, R_WR];

// Los bonus pesan fuerte a proposito: si el aura por moverse mucho aplasta
// a los moves con nombre, sacudirse le gana a hacer el movimiento, que es
// justo lo contrario de lo que el juego premia.
export const MOVES = [
  {
    id: 'dap', name: 'DAP', bonus: 22000, cd: 6, versus: true,
    needs: [L_WR, R_WR],
    line: '¡DAP REGISTRADO! AURA COMPARTIDA',
  },
  {
    id: 'six-seven', name: '6-7', bonus: 18000, cd: 6, temporal: true,
    needs: ARMS,
    line: 'SEIS… SIETE. CONFIRMADO.',
  },
  {
    id: 'scuba', name: 'SCUBA', bonus: 15000, hold: 0.2, cd: 5,
    needs: [NOSE, L_SH, R_SH, L_WR, R_WR],
    line: 'INMERSIÓN DETECTADA',
    // las dos manos enmarcando la cara, a la altura de los ojos o arriba
    test: (c) => c.fL < 1.35 && c.fR < 1.35
      && c.lm[L_WR].y < c.nose.y + c.F * 0.35
      && c.lm[R_WR].y < c.nose.y + c.F * 0.35
      && c.lElbow < 145 && c.rElbow < 145,
  },
  {
    id: 'mewing', name: 'MEWING', bonus: 14000, hold: 0.3, cd: 5,
    needs: [NOSE, L_SH, R_SH, L_WR, R_WR],
    line: 'LÍNEA MAXILAR CONFIRMADA',
    // UNA mano recorriendo la mandibula (debajo de la nariz) y la otra lejos.
    // Ese contraste es lo que lo separa del scuba.
    test: (c) => {
      const one = (near, far, wr) => near < 1.3 && far > 2.0
        && wr.y > c.nose.y + c.F * 0.3;
      return one(c.fL, c.fR, c.lm[L_WR]) || one(c.fR, c.fL, c.lm[R_WR]);
    },
  },
  {
    id: 'giro', name: 'GIRO COMPLETO', bonus: 12000, cd: 5, temporal: true,
    needs: [NOSE, L_SH, R_SH],
    line: 'ROTACIÓN NO AUTORIZADA',
  },
  {
    id: 't-pose', name: 'T-POSE', bonus: 11000, hold: 0.35, cd: 6,
    needs: ARMS,
    line: 'AFIRMANDO DOMINANCIA',
    test: (c) => c.lElbow > 152 && c.rElbow > 152
      && Math.abs(c.lWr.y) < 0.42 && Math.abs(c.rWr.y) < 0.42
      && Math.abs(c.lWr.x) > 1.25 && Math.abs(c.rWr.x) > 1.25,
  },
  {
    id: 'sentadilla', name: 'BAJANDO', bonus: 9000, hold: 0.3, cd: 5,
    // exige piernas visibles: en encuadre selfie simplemente no aplica
    needs: [L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN],
    line: 'HASTA EL SUELO',
    test: (c) => c.hipsOk && c.hip.y > c.knee.y - 0.22
      && Math.abs(c.n(c.lm[L_KN]).y - c.n(c.lm[R_KN]).y) < 0.35
      && c.lAn.y > c.knee.y && c.rAn.y > c.knee.y,
  },
  {
    id: 'manos-arriba', name: 'MANOS ARRIBA', bonus: 8000, hold: 0.25, cd: 5,
    needs: [L_SH, R_SH, L_WR, R_WR],
    line: 'INVOCANDO ALGO',
    test: (c) => c.lWr.y < -0.85 && c.rWr.y < -0.85,
  },
  {
    id: 'rezo', name: 'PLEGARIA', bonus: 7000, hold: 0.4, cd: 6,
    needs: ARMS,
    line: 'PIDIENDO AYUDA SUPERIOR',
    test: (c) => c.wristGap < 0.32 && c.lWr.y > -0.5 && c.lWr.y < 0.7
      && c.lElbow < 120 && c.rElbow < 120,
  },
];

const BY_ID = Object.fromEntries(MOVES.map((m) => [m.id, m]));

export class MoveDetector {
  constructor() {
    this.held = {};
    this.cool = {};
    this.flips = [];
    this.lastSign = 0;
    this.postureGrace = 0;
    this.spin = { narrow: false, at: 0 };
    this.t = 0;
  }

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

    for (const m of MOVES) {
      if (!m.test) continue;
      if (m.needs && !allSeen(lm, m.needs)) { this.held[m.id] = 0; continue; }
      let ok = false;
      try { ok = m.test(c); } catch { ok = false; }
      if (ok) {
        this.held[m.id] = (this.held[m.id] ?? 0) + dt;
        if (this.held[m.id] >= (m.hold ?? 0)) fire(m);
      } else {
        this.held[m.id] = 0;
      }
    }

    // --- 6-7: manos al pecho alternando arriba/abajo ---
    const posture = allSeen(lm, ARMS)
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
      // en los extremos del movimiento el brazo se estira y la postura falla
      // un frame; sin gracia se pierde la racha y nunca dispara
      this.postureGrace -= dt;
      if (this.postureGrace <= 0) { this.lastSign = 0; this.flips.length = 0; }
    }
    this.flips = this.flips.filter((x) => this.t - x < 2.0);
    if (this.flips.length >= 3) { this.flips = []; fire(BY_ID['six-seven']); }

    // --- giro: los hombros colapsan (de perfil) y vuelven ---
    // medido contra la cara, no contra el torso: la cabeza no cambia de
    // tamaño al girar, las caderas puede que ni se vean
    if (allSeen(lm, [NOSE, L_SH, R_SH])) {
      const turn = c.SW / c.F;
      if (turn < 0.55) { this.spin.narrow = true; this.spin.at = this.t; }
      else if (this.spin.narrow && turn > 1.05) {
        this.spin.narrow = false;
        if (this.t - this.spin.at < 1.4) fire(BY_ID['giro']);
      }
      if (this.t - this.spin.at > 1.6) this.spin.narrow = false;
    }

    return out;
  }
}

/** DAP: dos personas chocando manos. Se evalua sobre el par. */
export function detectDap(lmA, lmB) {
  if (!lmA || !lmB) return false;
  const cA = buildCtx(lmA), cB = buildCtx(lmB);
  if (!cA || !cB) return false;
  const T = (cA.T + cB.T) / 2;
  let best = Infinity;
  for (const a of [L_WR, R_WR]) {
    for (const b of [L_WR, R_WR]) {
      if (!seen(lmA, a) || !seen(lmB, b)) continue;
      // manos levantadas: con los brazos colgando son dos personas paradas
      // cerca, no un dap (era un falso positivo real)
      if (cA.n(lmA[a]).y > cA.hip.y - 0.25) continue;
      if (cB.n(lmB[b]).y > cB.hip.y - 0.25) continue;
      best = Math.min(best, dist(lmA[a], lmB[b]) / T);
    }
  }
  return best < 0.42;
}

export const DAP = BY_ID['dap'];
