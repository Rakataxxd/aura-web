// Harness de prueba: alimenta el scorer y el renderer con un cuerpo simulado.
// Permite verificar scoring + HUD sin camara ni persona.
// Uso en consola:  import('/src/simtest.js').then(m => m.run(8))

import { Player } from './scoring.js';
import { Renderer } from './render.js';

const IDX = {
  NOSE: 0, L_SH: 11, R_SH: 12, L_EL: 13, R_EL: 14, L_WR: 15, R_WR: 16,
  L_HIP: 23, R_HIP: 24, L_KN: 25, R_KN: 26, L_AN: 27, R_AN: 28,
};

/** Cuerpo sintetico. amp/freq controlan que tan salvaje se mueve. */
export function fakeBody(t, { cx = 0.5, amp = 0.12, freq = 3.2 } = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: cx, y: 0.5, z: 0, visibility: 0.95 }));
  const s = Math.sin(t * freq), c = Math.cos(t * freq * 1.3);
  const bob = Math.sin(t * freq * 0.8) * amp * 0.25;

  const put = (i, x, y) => { lm[i] = { x, y: y + bob, z: 0, visibility: 0.95 }; };

  put(IDX.NOSE, cx + s * amp * 0.15, 0.18);
  put(IDX.L_SH, cx - 0.07, 0.30);
  put(IDX.R_SH, cx + 0.07, 0.30);
  put(IDX.L_EL, cx - 0.13 - s * amp, 0.40 - c * amp);
  put(IDX.R_EL, cx + 0.13 + s * amp, 0.40 + c * amp);
  put(IDX.L_WR, cx - 0.18 - s * amp * 2.2, 0.48 - c * amp * 2.2);
  put(IDX.R_WR, cx + 0.18 + s * amp * 2.2, 0.48 + c * amp * 2.2);
  put(IDX.L_HIP, cx - 0.05, 0.58);
  put(IDX.R_HIP, cx + 0.05, 0.58);
  put(IDX.L_KN, cx - 0.06 - c * amp * 0.7, 0.73);
  put(IDX.R_KN, cx + 0.06 + c * amp * 0.7, 0.73);
  put(IDX.L_AN, cx - 0.07 - s * amp * 1.1, 0.90);
  put(IDX.R_AN, cx + 0.07 + s * amp * 1.1, 0.90);
  return lm;
}

/** Corre la simulacion sobre el canvas real. Devuelve un reporte verificable. */
export async function run(seconds = 8, { versus = false, live = true, stopFrac = 1, poster = false } = {}) {
  const canvas = document.getElementById('view');
  const video = document.getElementById('cam');
  document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));

  const renderer = new Renderer(canvas);
  const players = [new Player(0), new Player(1)];
  const dt = 1 / 30;
  const fired = { move: 0, crit: 0, line: 0, combo: 0 };
  const samples = [];
  let t = 0;

  // perfil de intensidad: calma -> explosion -> congelado (para probar los 3 caminos)
  const profile = (x) => {
    if (x < 0.15) return { amp: 0.02, freq: 1.0 };   // quieto -> debe salir roast bajo
    if (x < 0.70) return { amp: 0.20, freq: 7.5 };   // explosion -> move/crit/combo
    return { amp: 0.004, freq: 0.4 };                // congelado -> debe salir HOLD
  };

  const total = Math.round(seconds / dt);
  const lastFrame = Math.round(total * stopFrac);
  for (let f = 0; f < lastFrame; f++) {
    t += dt;
    const pr = profile(f / total);
    const lm0 = fakeBody(t, { cx: versus ? 0.30 : 0.5, ...pr });
    const lm1 = versus ? fakeBody(t * 1.4, { cx: 0.70, amp: pr.amp * 0.5, freq: pr.freq }) : null;

    players[0].update(lm0, t); players[0].lm = lm0;
    players[1].update(lm1, t); players[1].lm = lm1;

    for (const [i, p] of players.entries()) {
      for (const ev of p.drain()) {
        fired[ev.kind] = (fired[ev.kind] || 0) + 1;
        if (ev.kind === 'move') renderer.addCallout(ev.text, ['#c9ff2e', '#ff2d6f'][i], `+${ev.value} AURA`);
        else if (ev.kind === 'crit') renderer.addCrit(ev.text, ev.value, '#ffc531');
        else if (ev.kind === 'line') renderer.setLine(ev.text, ['#c9ff2e', '#ff2d6f'][i]);
      }
    }

    renderer.frame({
      video, mirror: true, players, active: versus ? 2 : 1,
      status: `SIM ${(seconds - t).toFixed(1)}s`, dt,
    });

    if (f % 15 === 0) samples.push({ t: +t.toFixed(2), e: +players[0].energy.toFixed(2), aura: Math.round(players[0].aura) });
    if (live) await new Promise((r) => setTimeout(r, 0));
  }

  // poster: fuerza el peor caso visual (nombre largo + critico + frase a la vez)
  // para verificar que nada se desborda en pantalla angosta.
  if (poster) {
    renderer.addCallout('PASO DEL CHUCHO TRISTE (ILEGAL EN 3 PAÍSES)', '#c9ff2e', '+427 AURA');
    renderer.addCrit('¡AURA DESBORDADA!', 3, '#ffc531');
    renderer.setLine('DETECTÉ 4 MICROEXPRESIONES DE CONFIANZA', '#c9ff2e');
    for (let f = 0; f < 7; f++) {
      renderer.frame({ video, mirror: true, players, active: versus ? 2 : 1, status: 'SIM 6.2s', dt });
    }
  }

  return {
    eventos: fired,
    p1: { aura: Math.round(players[0].aura), pico: +players[0].peakEnergy.toFixed(2), combo: players[0].combo },
    p2: { aura: Math.round(players[1].aura), pico: +players[1].peakEnergy.toFixed(2) },
    muestras: samples,
  };
}
