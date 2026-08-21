// Diagnostico: corre MediaPipe sobre un video y, en vez de decir solo
// "disparo / no disparo", guarda los NUMEROS de cada frame.
//
// Existe porque "no me lo detecta" no es accionable: hay que saber CUAL de
// las condiciones es la que corta. Con esto se ve, por ejemplo, que un gesto
// pasa el filtro de cara y muere en el angulo de codo.
//
//   const d = await import('/aura-web/src/diagtest.js')
//   await d.run('/aura-web/testdata/batalla.mp4')

import { createPose } from './pose.js';
import { MoveDetector, buildCtx, MOVES } from './moves.js';
import { toMetric } from './landmarks.js';
import { NOSE, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP, L_KN, R_KN } from './landmarks.js';

let posePromise = null;

const r2 = (v) => (Number.isFinite(v) ? +v.toFixed(2) : null);
const r3 = (v) => (Number.isFinite(v) ? +v.toFixed(4) : 0);

/** Rasgos derivados de un frame, en las unidades que usa moves.js. */
function rasgos(c) {
  const vis = (i) => r2(c.lm[i].visibility ?? 1);
  return {
    T: r2(c.T), F: r2(c.F), caderas: c.hipsOk,
    hombro: r2(c.n(c.lm[L_SH]).x),        // medio ancho de hombros, en torsos
    lWr: [r2(c.lWr.x), r2(c.lWr.y)], rWr: [r2(c.rWr.x), r2(c.rWr.y)],
    lEl: [r2(c.lEl.x), r2(c.lEl.y)], rEl: [r2(c.rEl.x), r2(c.rEl.y)],
    codoL: r2(c.lElbow), codoR: r2(c.rElbow),
    fL: r2(c.fL), fR: r2(c.fR),
    sepManos: r2(c.wristGap),
    hip: r2(c.hip.y), rodilla: r2(c.knee.y),
    visWr: [vis(L_WR), vis(R_WR)], visEl: [vis(L_EL), vis(R_EL)],
    visHip: [vis(L_HIP), vis(R_HIP)], visKn: [vis(L_KN), vis(R_KN)],
    fueraWr: [c.lm[L_WR].fuera, c.lm[R_WR].fuera],
    fueraEl: [c.lm[L_EL].fuera, c.lm[R_EL].fuera],
  };
}

/**
 * Para CADA move, en que puerta muere este frame.
 * 'ok' = pasa todo. Sin esto, "no me lo detecta" no se puede depurar: hay
 * tres filtros en serie y el que corta no se ve desde afuera.
 */
function puertas(c, lm, vel) {
  const out = {};
  for (const m of MOVES) {
    if (!m.test) continue;
    if (m.needs && !m.needs.every((i) => (lm[i].visibility ?? 1) >= 0.45)) { out[m.id] = 'needs'; continue; }
    if (m.calm != null && vel > m.calm) { out[m.id] = `calm(${vel.toFixed(1)}>${m.calm})`; continue; }
    let ok = false;
    try { ok = m.test(c); } catch { ok = false; }
    out[m.id] = ok ? 'ok' : 'test';
  }
  return out;
}

export async function run(url, { numPoses = 1, maxSeconds = 60, velocidad = 1 } = {}) {
  if (!posePromise) posePromise = createPose(numPoses);
  const pose = await posePromise;

  const video = document.createElement('video');
  video.src = url;
  video.muted = true; video.playsInline = true; video.loop = false;
  Object.assign(video.style, {
    position: 'fixed', left: '0', bottom: '0', width: '120px',
    opacity: '0.35', zIndex: '9999', pointerEvents: 'none',
  });
  document.body.appendChild(video);

  await new Promise((res, rej) => {
    if (video.readyState >= 1) return res();
    video.onloadedmetadata = res;
    video.onerror = () => rej(new Error('no carga el video: ' + url));
  });
  const ar = video.videoWidth / video.videoHeight;

  const det = new MoveDetector();
  const frames = [];
  const crudos = [];
  const disparos = [];
  let lastT = -1, sinPersona = 0, sinCtx = 0;

  // Mas lento = mas muestras por segundo de video. La inferencia tarda mas
  // que un frame y a velocidad normal se pierde la mitad del gesto.
  video.playbackRate = velocidad;
  await video.play();
  await new Promise((resolve) => {
    let fin = false;
    const done = () => { if (!fin) { fin = true; clearTimeout(wd); resolve(); } };
    video.addEventListener('ended', done);
    const wd = setTimeout(done, (maxSeconds + 30) * 1000);

    const step = (now) => {
      const t = video.currentTime;
      if (t === lastT) { schedule(); return; }
      // dt REAL de video, no 1/30. Con un dt inventado la velocidad de
      // muñeca sale multiplicada por (dt_real/dt_falso) y el filtro de
      // quietud parece cortar gestos que en la app pasan sin problema.
      const dt = lastT < 0 ? 1 / 30 : Math.min(Math.max(t - lastT, 1 / 120), 0.3);
      lastT = t;

      let res = null;
      try { res = pose.detectForVideo(video, now); } catch { /* noop */ }
      const lm = res?.landmarks?.[0] || null;
      const met = toMetric(lm, ar);
      if (!lm) sinPersona++;
      // Volcado crudo: con esto el detector se puede re-correr en node con
      // otros umbrales sin volver a pasar MediaPipe (60 s cada vez).
      crudos.push({
        t: +t.toFixed(3), dt: +dt.toFixed(4),
        lm: met && met.map((p) => [r3(p.x), r3(p.y), r3(p.visibility ?? 1), p.fuera ? 1 : 0]),
      });

      const c = met && buildCtx(met);
      if (met && !c) sinCtx++;
      // El estado de quietud hay que leerlo ANTES de feed(): despues ya se
      // movio la ventana y no es el que uso la decision.
      const vel = det.velMuneca();
      for (const m of det.feed(met, dt)) disparos.push({ t: +t.toFixed(2), move: m.name });
      if (c) frames.push({ t: +t.toFixed(2), vel: r2(vel), ...rasgos(c), puertas: puertas(c, met, vel) });

      window.__diag = { t: +t.toFixed(2), frames: frames.length, disparos: disparos.length };
      if (video.ended || t >= maxSeconds) { done(); return; }
      schedule();
    };
    const schedule = () => {
      if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(step);
      else requestAnimationFrame((n) => step(n));
    };
    schedule();
  });

  video.pause(); video.remove();
  window.__frames = frames;
  window.__crudos = crudos;
  return {
    video: { url, w: video.videoWidth, h: video.videoHeight, ar: r2(ar), dur: r2(video.duration) },
    frames: frames.length, sinPersona, sinCtx,
    disparos,
  };
}

/** Rasgos promedio/rango en una ventana de tiempo (para mirar UN gesto). */
export function ventana(a, b) {
  const f = (window.__frames || []).filter((x) => x.t >= a && x.t <= b);
  if (!f.length) return null;
  const num = ['T', 'F', 'codoL', 'codoR', 'fL', 'fR', 'sepManos', 'hip', 'rodilla'];
  const out = { n: f.length, t: [a, b] };
  for (const k of num) {
    const v = f.map((x) => x[k]).filter((x) => x != null);
    if (v.length) out[k] = [r2(Math.min(...v)), r2(v.reduce((s, y) => s + y, 0) / v.length), r2(Math.max(...v))];
  }
  for (const k of ['lWr', 'rWr', 'lEl', 'rEl']) {
    const xs = f.map((x) => x[k][0]), ys = f.map((x) => x[k][1]);
    out[k] = { x: [r2(Math.min(...xs)), r2(Math.max(...xs))], y: [r2(Math.min(...ys)), r2(Math.max(...ys))] };
  }
  return out;
}
