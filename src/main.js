import './style.css';
import { createPose, openCamera, assignSlots, prefetchAssets } from './pose.js';
import { Player } from './scoring.js';
import { Renderer, P_COLOR, GOLD, BONE } from './render.js';
import { Recorder, shareOrDownload } from './record.js';
import { detectDap, DAP } from './moves.js';
import { verdictFor } from './roasts.js';

const ROUND_SECONDS = 15;
const DEBUG = new URLSearchParams(location.search).has('debug');
const fpsHist = [];

const $ = (id) => document.getElementById(id);
const el = {
  video: $('cam'), canvas: $('view'),
  intro: $('intro'), loading: $('loading'), count: $('count'), result: $('result'), oops: $('oops'),
  go: $('go'), share: $('share'), again: $('again'), retry: $('retry'),
  countnum: $('countnum'), loadmsg: $('loadmsg'), oopsmsg: $('oopsmsg'),
  rScore: $('rScore'), rTitle: $('rTitle'), rSub: $('rSub'), rStats: $('rStats'), rNote: $('rNote'),
};

const show = (...ids) => {
  for (const k of ['intro', 'loading', 'count', 'result', 'oops']) {
    el[k].classList.toggle('hidden', !ids.includes(k));
  }
};

// ---------- canvas ----------
function sizeCanvas() {
  const portrait = window.innerHeight >= window.innerWidth;
  const [W, H] = portrait ? [720, 1280] : [1280, 720];
  el.canvas.width = W;
  el.canvas.height = H;
  const scale = Math.min(window.innerWidth / W, window.innerHeight / H);
  el.canvas.style.width = `${W * scale}px`;
  el.canvas.style.height = `${H * scale}px`;
}
sizeCanvas();
addEventListener('resize', () => { if (state !== 'running') sizeCanvas(); });

// ---------- estado ----------
let pose = null, stream = null, renderer = null, recorder = null;
let players = [new Player(0), new Player(1)];
let activeCount = 1;
let state = 'idle';
let raf = 0, lastVideoTime = -1, lastT = 0, roundLeft = ROUND_SECONDS, blob = null;
let prefetch = null, prefetchPct = 0, dapCool = 0;
const mirror = true;   // camara frontal: espejo, si no se siente al reves

// Suavizado exponencial de landmarks solo para el render.
const smoothed = [null, null];
function smoothLm(slot, target, dt) {
  if (!target) { smoothed[slot] = null; return null; }
  const prev = smoothed[slot];
  if (!prev || prev.length !== target.length) {
    smoothed[slot] = target.map((p) => ({ ...p }));
    return smoothed[slot];
  }
  const a = 1 - Math.exp(-dt * 22);   // independiente del framerate
  for (let i = 0; i < target.length; i++) {
    prev[i].x += (target[i].x - prev[i].x) * a;
    prev[i].y += (target[i].y - prev[i].y) * a;
    prev[i].visibility = target[i].visibility;
  }
  return prev;
}

function fail(msg) {
  state = 'idle';
  cancelAnimationFrame(raf);
  el.oopsmsg.textContent = msg;
  show('oops');
}

async function boot() {
  el.go.disabled = true;
  show('loading');
  try {
    el.loadmsg.textContent = 'PIDIENDO CÁMARA…';
    stream = await openCamera(el.video);
  } catch (e) {
    return fail(
      e?.name === 'NotAllowedError'
        ? 'Necesito permiso de cámara. Activalo y reintentá.'
        : 'No encontré cámara en este dispositivo.'
    );
  }
  try {
    el.loadmsg.textContent = prefetchPct >= 1 ? 'CALIBRANDO SENSORES…' : `DESCARGANDO SENSORES… ${Math.round(prefetchPct * 100)}%`;
    await prefetch;                       // ya venia bajando desde que abrio la pagina
    el.loadmsg.textContent = 'CALIBRANDO SENSORES…';
    if (!pose) pose = await createPose(2);
    if (document.fonts?.ready) await document.fonts.ready;
  } catch (e) {
    console.error(e);
    return fail('No se pudo cargar el modelo. Revisá tu conexión.');
  }
  renderer = new Renderer(el.canvas);
  recorder = new Recorder(el.canvas);
  countdown();
}

function countdown() {
  players = [new Player(0), new Player(1)];
  roundLeft = ROUND_SECONDS;
  state = 'countdown';
  lastT = performance.now() / 1000;
  loop();

  let n = 3;
  show('count');
  el.countnum.textContent = n;
  const tick = setInterval(() => {
    n--;
    if (n === 0) {
      clearInterval(tick);
      show();
      state = 'running';
      recorder.start(30);
      return;
    }
    el.countnum.textContent = n;
    el.countnum.style.animation = 'none';
    void el.countnum.offsetWidth;
    el.countnum.style.animation = '';
  }, 850);
}

function handleEvents(p, slot) {
  for (const ev of p.drain()) {
    if (ev.kind === 'signature') renderer.addSignature(ev.text, ev.value);
    else if (ev.kind === 'move') renderer.addCallout(ev.text, P_COLOR[slot], `+${ev.value} AURA`);
    else if (ev.kind === 'crit') renderer.addCrit(ev.text, ev.value, GOLD);
    else if (ev.kind === 'line') renderer.setLine(ev.text, P_COLOR[slot]);
    else if (ev.kind === 'combo' && ev.value % 5 === 0) {
      renderer.addCallout(`${ev.value}× COMBO`, GOLD);
    }
  }
}

function loop() {
  raf = requestAnimationFrame(loop);
  const now = performance.now();
  const t = now / 1000;
  const dt = Math.min(t - lastT, 0.15);
  lastT = t;

  let found = [null, null];
  if (el.video.readyState >= 2 && el.video.currentTime !== lastVideoTime) {
    lastVideoTime = el.video.currentTime;
    try {
      const res = pose.detectForVideo(el.video, now);
      if (res?.landmarks?.length) {
        found = assignSlots(res.landmarks);
        activeCount = res.landmarks.length >= 2 ? 2 : 1;
      }
    } catch (e) { console.warn('[pose]', e?.message); }
  }

  const scoring = state === 'running';
  players.forEach((p, i) => {
    if (scoring) p.update(found[i], t);
    // El scorer usa los landmarks crudos (la energia debe ser real).
    // El dibujo usa una version suavizada: la deteccion llega a ~30Hz y
    // pintarla tal cual a 60Hz se ve a saltos.
    p.lm = smoothLm(i, found[i], dt);
  });
  // DAP: no es de un jugador, es del par. Se evalua sobre landmarks crudos.
  if (scoring && activeCount === 2) {
    dapCool -= dt;
    if (dapCool <= 0 && detectDap(found[0], found[1])) {
      dapCool = DAP.cd;
      players.forEach((p) => { p.aura += DAP.bonus; p.landed.push(DAP.name); });
      renderer.addSignature(DAP.name, DAP.bonus);
      renderer.setLine(DAP.line, GOLD);
    }
  }

  if (scoring) players.forEach((p, i) => { if (i < activeCount) handleEvents(p, i); });

  if (scoring) {
    roundLeft -= dt;
    if (roundLeft <= 0) { finish(); return; }
  }

  // ?debug muestra FPS reales. Fuera del clip por defecto.
  if (DEBUG) {
    fpsHist.push(1 / Math.max(dt, 1e-4));
    if (fpsHist.length > 45) fpsHist.shift();
  }
  const fpsTag = DEBUG ? `  ·  ${(fpsHist.reduce((a, b) => a + b, 0) / fpsHist.length).toFixed(0)} FPS` : '';

  const status = (state === 'running'
    ? `${roundLeft.toFixed(1)}s  ·  ${activeCount === 2 ? 'MODO VERSUS' : 'SUJETO ÚNICO'}`
    : (found[0] ? 'SUJETO DETECTADO' : 'BUSCANDO SUJETO…')) + fpsTag;

  renderer.frame({ video: el.video, mirror, players, active: activeCount, status, dt });
}

async function finish() {
  state = 'ending';
  blob = await recorder.stop();
  cancelAnimationFrame(raf);
  stream?.getTracks().forEach((t) => t.stop());
  state = 'idle';

  const winner = activeCount === 2
    ? (players[0].aura >= players[1].aura ? 0 : 1)
    : 0;
  const p = players[winner];
  const aura = Math.round(p.aura);
  const v = verdictFor(aura);

  el.rScore.textContent = aura.toLocaleString('es-GT');
  el.rTitle.textContent = v.t;
  el.rSub.textContent = v.s;
  const landed = [...new Set(p.landed)];
  el.rStats.innerHTML = [
    `PICO <b>${p.peakEnergy.toFixed(1)}</b>`,
    `COMBO MÁX <b>${p.combo}</b>`,
    activeCount === 2 ? `GANADOR <b>P${winner + 1}</b>` : `MODO <b>SOLO</b>`,
    ...landed.map((n) => `<b>${n}</b>`),
  ].map((s) => `<span>${s}</span>`).join('');
  el.rSub.textContent = landed.length
    ? `${v.s}  Reconocí: ${landed.join(', ')}.`
    : `${v.s} No detecté ningún movimiento con nombre.`;

  if (blob) {
    el.share.classList.remove('hidden');
    el.share.textContent = navigator.canShare?.({ files: [new File([blob], 'x', { type: blob.type })] })
      ? 'COMPARTIR CLIP' : 'DESCARGAR CLIP';
    el.rNote.textContent = '';
  } else {
    el.share.classList.add('hidden');
    el.rNote.textContent = 'Tu navegador no permite grabar. El escáner sí funcionó.';
  }
  show('result');
}

// Arranca la descarga apenas se ve el intro: para cuando toquen el boton,
// los 8MB ya estan (o van a medias) y el arranque se siente instantaneo.
function startPrefetch() {
  if (prefetch) return;
  prefetch = prefetchAssets((p) => {
    prefetchPct = p;
    if (!el.loading.classList.contains('hidden') && p < 1) {
      el.loadmsg.textContent = `DESCARGANDO SENSORES… ${Math.round(p * 100)}%`;
    }
  });
}
if ('requestIdleCallback' in window) requestIdleCallback(startPrefetch, { timeout: 2500 });
else setTimeout(startPrefetch, 1200);

// ---------- eventos ----------
el.go.addEventListener('click', () => { startPrefetch(); boot(); });
el.retry.addEventListener('click', () => { el.go.disabled = false; show('intro'); });
el.again.addEventListener('click', async () => {
  sizeCanvas();
  show('loading');
  try { stream = await openCamera(el.video); } catch { return fail('Se perdió la cámara.'); }
  renderer = new Renderer(el.canvas);
  recorder = new Recorder(el.canvas);
  countdown();
});
el.share.addEventListener('click', async () => {
  if (!blob) return;
  el.share.disabled = true;
  const r = await shareOrDownload(blob, Math.round(players[0].aura));
  el.share.disabled = false;
  if (r === 'downloaded') el.rNote.textContent = 'Guardado. Subilo y etiquetame.';
});
