// NIVEL 2: movimientos con nombre, detectados por reglas de angulos.
//
// TRES REGLAS QUE COSTARON BUGS REALES:
//
// 1. MediaPipe devuelve coordenadas para landmarks FUERA DE CUADRO, inventadas
//    y con visibility baja. Si no se filtran, un encuadre selfie produce
//    tobillos fantasma. Todo move declara sus landmarks en `needs`.
//
// 2. Normalizar por torso falla cuando las caderas estan al borde del cuadro.
//    Los gestos de cara se miden contra F (nariz->centro de hombros).
//
// 3. Una configuracion que ocurre POR ACCIDENTE a mitad de un movimiento
//    rapido no es un gesto. Todo move estatico exige quietud (`calm`): un
//    gesto se sostiene, no se atraviesa. Sin esto, bailar dispara de todo.

import { NOSE, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN } from './landmarks.js';

const VIS = 0.45;
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

/** Inclinacion respecto a la horizontal, 0 = horizontal, 90 = vertical. */
function tilt(a, b) {
  return Math.abs(Math.atan2(b.y - a.y, b.x - a.x)) * 180 / Math.PI % 180 > 90
    ? 180 - Math.abs(Math.atan2(b.y - a.y, b.x - a.x)) * 180 / Math.PI
    : Math.abs(Math.atan2(b.y - a.y, b.x - a.x)) * 180 / Math.PI;
}

export function buildCtx(lm) {
  if (!allSeen(lm, [L_SH, R_SH])) return null;
  const sc = mid(lm[L_SH], lm[R_SH]);
  const hc = mid(lm[L_HIP], lm[R_HIP]);

  const SW = dist(lm[L_SH], lm[R_SH]);
  // Sin nariz visible se estima la escala de cara desde los hombros. Exigir
  // la nariz aca tumbaba TODOS los moves, hasta los que no miran la cara.
  const F = seen(lm, NOSE) ? dist(lm[NOSE], sc) : SW * 0.55;
  const hipsOk = allSeen(lm, [L_HIP, R_HIP]);

  let T = hipsOk ? dist(sc, hc) : 0;
  if (!(T > 0.02)) T = Math.max(SW * 0.95, F * 1.7);
  if (!(T > 0.02) || !(F > 0.01)) return null;

  const n = (p) => ({ x: (p.x - sc.x) / T, y: (p.y - sc.y) / T });
  return {
    lm, T, F, SW, sc, hipsOk, n,
    nose: lm[NOSE],
    lWr: n(lm[L_WR]), rWr: n(lm[R_WR]),
    lEl: n(lm[L_EL]), rEl: n(lm[R_EL]),
    lAn: n(lm[L_AN]), rAn: n(lm[R_AN]),
    hip: n(hc),
    knee: n(mid(lm[L_KN], lm[R_KN])),
    lElbow: angle(lm[L_SH], lm[L_EL], lm[L_WR]),
    rElbow: angle(lm[R_SH], lm[R_EL], lm[R_WR]),
    wristGap: dist(lm[L_WR], lm[R_WR]) / T,
    fL: dist(lm[L_WR], lm[NOSE]) / F,
    fR: dist(lm[R_WR], lm[NOSE]) / F,
  };
}

const ARMS = [L_SH, R_SH, L_EL, R_EL, L_WR, R_WR];
const FACE_ARMS = [NOSE, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR];

// `calm`: velocidad maxima de muñeca (torsos/segundo) permitida para que
// cuente. Un gesto se sostiene; atravesarlo bailando no vale.
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
    id: 'scuba', name: 'SCUBA', bonus: 15000, hold: 0.22, cd: 5, calm: 4.0,
    needs: FACE_ARMS,
    line: 'INMERSIÓN DETECTADA',
    // Las dos manos enmarcando la cara, una a cada lado. Lo que lo separa
    // de rascarse el pelo es la simetria y que esten a los costados, no
    // la precision milimetrica.
    test: (c) => {
      if (!(c.fL < 1.5 && c.fR < 1.5)) return false;
      const lo = c.nose.y - c.F * 1.25, hi = c.nose.y + c.F * 1.0;
      if (!(c.lm[L_WR].y > lo && c.lm[L_WR].y < hi)) return false;
      if (!(c.lm[R_WR].y > lo && c.lm[R_WR].y < hi)) return false;
      if (Math.abs(c.lm[L_WR].y - c.lm[R_WR].y) > c.F * 0.9) return false;   // simetria
      const dl = c.lm[L_WR].x - c.nose.x, dr = c.lm[R_WR].x - c.nose.x;
      return dl * dr < 0                                                     // una a cada lado
        && c.lElbow > 12 && c.lElbow < 165 && c.rElbow > 12 && c.rElbow < 165;
    },
  },
  {
    id: 'mewing', name: 'MEWING', bonus: 14000, hold: 0.3, cd: 5, calm: 3.5,
    needs: FACE_ARMS,
    line: 'LÍNEA MAXILAR CONFIRMADA',
    // UNA mano junto a la cara y la otra claramente lejos. Ese contraste
    // es lo unico que hace falta para separarlo del scuba.
    test: (c) => {
      const una = (near, far, wr) => near < 1.4 && far > 1.9
        && wr.y > c.nose.y - c.F * 0.15
        && wr.y < c.sc.y + c.F * 0.4;
      return una(c.fL, c.fR, c.lm[L_WR]) || una(c.fR, c.fL, c.lm[R_WR]);
    },
  },
  {
    id: 'giro', name: 'GIRO COMPLETO', bonus: 12000, cd: 5, temporal: true,
    needs: [NOSE, L_SH, R_SH],
    line: 'ROTACIÓN NO AUTORIZADA',
  },
  {
    id: 't-pose', name: 'T-POSE', bonus: 11000, hold: 0.3, cd: 6, calm: 4.0,
    needs: ARMS,
    line: 'AFIRMANDO DOMINANCIA',
    test: (c) => c.lElbow > 142 && c.rElbow > 142
      && Math.abs(c.lWr.y) < 0.6 && Math.abs(c.rWr.y) < 0.6
      && Math.abs(c.lWr.x) > 1.0 && Math.abs(c.rWr.x) > 1.0
      && Math.abs(c.lWr.y - c.rWr.y) < 0.7,
  },
  {
    id: 'sentadilla', name: 'BAJANDO', bonus: 9000, hold: 0.3, cd: 5, calm: 5.0,
    needs: [L_HIP, R_HIP, L_KN, R_KN],
    line: 'HASTA EL SUELO',
    test: (c) => c.hipsOk && c.hip.y > c.knee.y - 0.38
      && Math.abs(c.n(c.lm[L_KN]).y - c.n(c.lm[R_KN]).y) < 0.5,
  },
  {
    id: 'manos-arriba', name: 'MANOS ARRIBA', bonus: 8000, hold: 0.28, cd: 5, calm: 4.5,
    needs: [L_SH, R_SH, L_EL, R_EL, L_WR, R_WR],
    line: 'INVOCANDO ALGO',
    test: (c) => c.lWr.y < -0.55 && c.rWr.y < -0.55
      && c.lWr.y < c.lEl.y && c.rWr.y < c.rEl.y
      && c.lElbow > 105 && c.rElbow > 105,
  },
  {
    id: 'rezo', name: 'PLEGARIA', bonus: 7000, hold: 0.35, cd: 6, calm: 3.0,
    needs: ARMS,
    line: 'PIDIENDO AYUDA SUPERIOR',
    // Manos juntas AL PECHO, claramente debajo de la cara. Sin esa
    // condicion el scuba (manos juntas a la altura de los ojos) tambien
    // disparaba plegaria.
    test: (c) => c.wristGap < 0.45
      && c.lm[L_WR].y > c.nose.y + c.F * 0.7
      && c.lWr.y < 0.85
      && c.lElbow < 140 && c.rElbow < 140
      && Math.abs(c.lWr.x) < 0.8 && Math.abs(c.rWr.x) < 0.8,
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
    this.girosFlips = [];
    this.hist = [];        // ventana corta de posiciones normalizadas
    this.t = 0;
  }

  /**
   * Velocidad de muñeca en torsos/segundo, SOLO del tramo reciente.
   * Promediar los 2.2s enteros era un bug: si te movias y despues hacias
   * la pose, el promedio seguia alto por lo de antes y la pose nunca
   * contaba como quieta. Bloqueaba casi todos los moves.
   */
  velMuneca(ventana = 0.3) {
    const h = this.hist;
    if (h.length < 3) return 0;
    let s = 0, n = 0;
    for (let i = h.length - 1; i > 0; i--) {
      if (this.t - h[i].t > ventana) break;
      const dt = h[i].t - h[i - 1].t;
      if (dt <= 0) continue;
      s += (Math.hypot(h[i].lWr.x - h[i - 1].lWr.x, h[i].lWr.y - h[i - 1].lWr.y)
        + Math.hypot(h[i].rWr.x - h[i - 1].rWr.x, h[i].rWr.y - h[i - 1].rWr.y)) / 2 / dt;
      n++;
    }
    return n ? s / n : 0;
  }

  /** Recorrido acumulado de un punto en la ventana. */
  recorrido(clave) {
    const h = this.hist;
    let s = 0;
    for (let i = 1; i < h.length; i++) {
      s += Math.hypot(h[i][clave].x - h[i - 1][clave].x, h[i][clave].y - h[i - 1][clave].y);
    }
    return s;
  }

  feed(lm, dt) {
    this.t += dt;
    for (const k in this.cool) this.cool[k] -= dt;
    if (!lm) { this.hist.length = 0; return []; }
    const c = buildCtx(lm);
    if (!c) { this.hist.length = 0; return []; }

    this.hist.push({ t: this.t, lWr: c.lWr, rWr: c.rWr, lEl: c.lEl, rEl: c.rEl });
    while (this.hist.length && this.t - this.hist[0].t > 2.2) this.hist.shift();

    const vel = this.velMuneca();
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
      // el gesto tiene que estar quieto: atravesarlo bailando no cuenta
      if (m.calm != null && vel > m.calm) { this.held[m.id] = 0; continue; }
      let ok = false;
      try { ok = m.test(c); } catch { ok = false; }
      if (ok) {
        this.held[m.id] = (this.held[m.id] ?? 0) + dt;
        if (this.held[m.id] >= (m.hold ?? 0)) fire(m);
      } else {
        this.held[m.id] = 0;
      }
    }

    // --- 6-7 ---
    // Lo que lo distingue de mover los brazos en general: los CODOS quedan
    // pegados al cuerpo y casi no se mueven, mientras las manos suben y
    // bajan alternadas, con los antebrazos casi horizontales.
    const codosPegados = Math.abs(c.lEl.x) < 1.25 && Math.abs(c.rEl.x) < 1.25;
    const antebrazosPlanos = tilt(c.lm[L_EL], c.lm[L_WR]) < 62 && tilt(c.lm[R_EL], c.lm[R_WR]) < 62;
    const manosAlFrente = Math.abs(c.lWr.x) < 1.8 && Math.abs(c.rWr.x) < 1.8;
    const alturaPecho = c.lWr.y > -0.5 && c.lWr.y < 1.5 && c.rWr.y > -0.5 && c.rWr.y < 1.5;
    const posture = allSeen(lm, ARMS) && codosPegados && antebrazosPlanos
      && manosAlFrente && alturaPecho && c.wristGap > 0.45
      && c.lElbow > 28 && c.lElbow < 162 && c.rElbow > 28 && c.rElbow < 162;

    if (posture) {
      this.postureGrace = 0.35;
      const d = c.lWr.y - c.rWr.y;
      const s = Math.abs(d) > 0.16 ? Math.sign(d) : 0;
      if (s !== 0 && s !== this.lastSign) {
        if (this.lastSign !== 0) this.flips.push(this.t);
        this.lastSign = s;
      }
    } else {
      this.postureGrace -= dt;
      if (this.postureGrace <= 0) { this.lastSign = 0; this.flips.length = 0; }
    }
    this.flips = this.flips.filter((x) => this.t - x < 2.5);
    // Las manos tienen que recorrer mas que los codos: si todo el brazo
    // viaja junto es baile, no 6-7. Este es el discriminador que importa,
    // por eso se conserva aunque todo lo demas se haya aflojado.
    const manos = this.recorrido('lWr') + this.recorrido('rWr');
    const codos = this.recorrido('lEl') + this.recorrido('rEl');
    if (this.flips.length >= 3 && manos > codos * 1.5) {
      this.flips = [];
      fire(BY_ID['six-seven']);
    }

    // --- giro ---
    // La prueba de que giraste es que los HOMBROS SE INVIERTEN DE ORDEN.
    // Antes usaba ancho-de-hombros/tamaño-de-cara como señal de perfil, pero
    // de perfil MediaPipe sigue separando los hombros por el grosor del
    // cuerpo: el colapso es chico y cualquier bajon de deteccion lo imitaba.
    // Ese era el falso positivo del video real.
    //
    // Ahora el ancho se compara contra el maximo reciente del PROPIO cuerpo
    // (auto-normalizado, sirve para cualquier complexion), y el disparo
    // exige que el orden de hombros al salir sea el contrario al de entrada.
    if (allSeen(lm, [NOSE, L_SH, R_SH])) {
      this.swMax = Math.max(c.SW, (this.swMax ?? c.SW) * (1 - dt * 0.35));

      // "De frente" = hombros abiertos Y la nariz DENTRO del ancho de
      // hombros. Corriendo de perfil la nariz va por delante del hombro,
      // asi que un corredor nunca cuenta como frontal. Ese era el falso
      // positivo del video real.
      const shL = Math.min(lm[L_SH].x, lm[R_SH].x);
      const shR = Math.max(lm[L_SH].x, lm[R_SH].x);
      const span = shR - shL;
      const frontal = c.SW > this.swMax * 0.7
        && lm[NOSE].x > shL + span * 0.15
        && lm[NOSE].x < shR - span * 0.15;

      if (frontal) {
        const orden = Math.sign(lm[L_SH].x - lm[R_SH].x);
        if (orden !== 0) {
          if (this.ordenFrontal !== undefined && orden !== this.ordenFrontal) {
            this.girosFlips.push(this.t);
          }
          this.ordenFrontal = orden;
        }
      }
      this.girosFlips = this.girosFlips.filter((x) => this.t - x < 1.8);
      // Una vuelta entera invierte los hombros DOS veces y termina como
      // empezo. Con un solo cambio seria media vuelta (quedar de espaldas),
      // que no es un giro completo.
      if (this.girosFlips.length >= 2) {
        this.girosFlips = [];
        fire(BY_ID['giro']);
      }
    }

    return out;
  }
}

/**
 * DAP: dos personas chocando manos.
 * Exige manos levantadas, contacto ENTRE los dos cuerpos, y que sean dos
 * personas de verdad separadas. Antes bastaba proximidad de muñecas, asi
 * que dos personas paradas juntas ya contaba.
 */
export function detectDap(lmA, lmB) {
  if (!lmA || !lmB) return false;
  const cA = buildCtx(lmA), cB = buildCtx(lmB);
  if (!cA || !cB) return false;

  const sep = Math.abs(cA.sc.x - cB.sc.x) / ((cA.T + cB.T) / 2);
  if (sep < 0.8) return false;             // o es una sola persona detectada dos veces

  const izq = Math.min(cA.sc.x, cB.sc.x), der = Math.max(cA.sc.x, cB.sc.x);
  const T = (cA.T + cB.T) / 2;

  for (const a of [L_WR, R_WR]) {
    for (const b of [L_WR, R_WR]) {
      if (!seen(lmA, a) || !seen(lmB, b)) continue;
      if (cA.n(lmA[a]).y > cA.hip.y - 0.3) continue;   // mano levantada
      if (cB.n(lmB[b]).y > cB.hip.y - 0.3) continue;
      if (dist(lmA[a], lmB[b]) / T > 0.38) continue;
      const cx = (lmA[a].x + lmB[b].x) / 2;
      if (cx < izq || cx > der) continue;              // el choque va en medio
      return true;
    }
  }
  return false;
}

export const DAP = BY_ID['dap'];
