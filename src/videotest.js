// Corre el pipeline REAL (MediaPipe + scoring + moves) sobre un video
// pregrabado. Los muñecos sinteticos de movetest.js prueban la geometria,
// pero no prueban nada sobre landmarks humanos con ruido, oclusion y
// encuadres raros. Aca es donde salen los falsos positivos de verdad.
//
//   const v = await import('/src/videotest.js')
//   await v.run('/testdata/persona.mp4')

import { createPose } from './pose.js';
import { Player } from './scoring.js';
import { MoveDetector, buildCtx } from './moves.js';

let posePromise = null;

export async function run(url, { numPoses = 1, maxSeconds = 60 } = {}) {
  if (!posePromise) posePromise = createPose(numPoses);
  const pose = await posePromise;

  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.loop = false;
  // Tiene que estar EN el DOM y renderizado: un <video> desprendido no
  // decodifica frames y requestVideoFrameCallback no dispara nunca.
  Object.assign(video.style, {
    position: 'fixed', left: '0', bottom: '0', width: '120px',
    opacity: '0.35', zIndex: '9999', pointerEvents: 'none',
  });
  document.body.appendChild(video);
  window.__vtVideo = video;

  await new Promise((res, rej) => {
    if (video.readyState >= 1) return res();
    video.onloadedmetadata = res;
    video.onerror = () => rej(new Error('no carga el video: ' + url));
  });
  window.__vtProgreso = { fase: 'metadata', dur: video.duration, w: video.videoWidth };

  const det = new MoveDetector();
  const player = new Player(0);
  const hits = [];          // {t, move}
  const inferMs = [];
  const energias = [];
  let frames = 0, conPersona = 0, sinTorso = 0;
  let lastT = -1;

  await video.play();

  await new Promise((resolve) => {
    let acabado = false;
    const done = () => { if (!acabado) { acabado = true; clearTimeout(wd); resolve(); } };
    // rVFC deja de dispararse al terminar la reproduccion: sin esto el
    // bucle se cuelga esperando un frame que nunca llega.
    video.addEventListener('ended', done);
    const wd = setTimeout(done, (maxSeconds + 25) * 1000);

    const step = (now, meta) => {
      const t = video.currentTime;
      if (t === lastT) { schedule(); return; }
      lastT = t;
      frames++;

      const t0 = performance.now();
      let res = null;
      try { res = pose.detectForVideo(video, now); } catch { /* noop */ }
      inferMs.push(performance.now() - t0);

      const lm = res?.landmarks?.[0] || null;
      if (lm) {
        conPersona++;
        if (!buildCtx(lm)) sinTorso++;
      }

      player.update(lm, t);
      player.drain();
      energias.push(player.energy);
      for (const m of det.feed(lm, 1 / 30)) hits.push({ t: +t.toFixed(2), move: m.name });

      window.__vtProgreso = { fase: 'procesando', frames, t: +t.toFixed(2), conPersona, hits: hits.length };
      if (video.ended || t >= maxSeconds) { done(); return; }
      schedule();
    };
    const schedule = () => {
      if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(step);
      else requestAnimationFrame((n) => step(n, null));
    };
    schedule();
  });

  video.pause();
  video.remove();
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sorted = [...inferMs].sort((a, b) => a - b);
  const porMove = {};
  for (const h of hits) porMove[h.move] = (porMove[h.move] || 0) + 1;

  return {
    video: { url, dur: +video.duration.toFixed(1), w: video.videoWidth, h: video.videoHeight },
    frames,
    persona_detectada_pct: Math.round((conPersona / Math.max(frames, 1)) * 100),
    ctx_invalido_pct: Math.round((sinTorso / Math.max(conPersona, 1)) * 100),
    inferencia_ms: { media: +avg(inferMs).toFixed(1), p50: +(sorted[(sorted.length / 2) | 0] || 0).toFixed(1), p95: +(sorted[(sorted.length * 0.95) | 0] || 0).toFixed(1) },
    energia: { media: +avg(energias).toFixed(2), pico: +Math.max(...energias, 0).toFixed(2) },
    aura_final: Math.round(player.aura),
    moves_disparados: porMove,
    total_disparos: hits.length,
    linea_de_tiempo: hits.slice(0, 40),
  };
}
