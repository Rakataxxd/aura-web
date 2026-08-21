import './style.css';
import { createPose, createPoseWorker, openCamera, assignSlots, prefetchAssets, ajustesCamara } from './pose.js';
import { Player } from './scoring.js';
import { Renderer, P_COLOR, GOLD, BONE } from './render.js';
import { Recorder, shareOrDownload } from './record.js';
import { detectDap, DAP, brazosCortados } from './moves.js';
import { toMetric } from './landmarks.js';
import { verdictFor } from './roasts.js';
import { hayApi, getAlias, setAlias, aliasValido, enviarPuntaje, traerRanking, nombrePais } from './ranking.js';
import { Batalla, hayVersus, codigoNuevo, codigoValido } from './versus.js';

const ROUND_SECONDS = 15;
const DEBUG = new URLSearchParams(location.search).has('debug');
const fpsHist = [];

const $ = (id) => document.getElementById(id);
const el = {
  video: $('cam'), canvas: $('view'),
  intro: $('intro'), loading: $('loading'), count: $('count'), result: $('result'), oops: $('oops'),
  rank: $('rank'), versus: $('versus'), sala: $('sala'),
  irVersus: $('irVersus'), vsBuscar: $('vsBuscar'), vsCodigo: $('vsCodigo'), vsEntrar: $('vsEntrar'),
  vsCrear: $('vsCrear'), vsMsg: $('vsMsg'), vsVolver: $('vsVolver'),
  salaCodigo: $('salaCodigo'), salaMsg: $('salaMsg'), salaFine: $('salaFine'), salaSalir: $('salaSalir'),
  rivalCaja: $('rivalCaja'), rivalVid: $('rivalVid'), rivalAura: $('rivalAura'), rivalSaltar: $('rivalSaltar'),
  go: $('go'), share: $('share'), again: $('again'), retry: $('retry'),
  countnum: $('countnum'), loadmsg: $('loadmsg'), oopsmsg: $('oopsmsg'),
  rScore: $('rScore'), rTitle: $('rTitle'), rSub: $('rSub'), rStats: $('rStats'), rNote: $('rNote'),
  rTape: $('rTape'),
  verRank: $('verRank'), alta: $('alta'), alias: $('alias'), subir: $('subir'), altaMsg: $('altaMsg'),
  tabAmbito: $('tabAmbito'), tabPeriodo: $('tabPeriodo'),
  rankDonde: $('rankDonde'), tabla: $('tabla'), rankYo: $('rankYo'), rankVolver: $('rankVolver'),
};

const PANELES = ['intro', 'loading', 'count', 'result', 'oops', 'rank', 'versus', 'sala'];
const show = (...ids) => {
  for (const k of PANELES) el[k].classList.toggle('hidden', !ids.includes(k));
};

// ---------- canvas ----------
// Escalera de resolucion. Antes esto era un booleano `downscaled` y
// `sizeCanvas()` aplicaba 0.75 fijo, sin importar que escalon se hubiera
// elegido: un aparato que necesitaba 0.5 volvia a 0.75 al tocar "otra vez".
// Y la decision solo corria si `!downscaled`, o sea UNA vez en la vida de la
// pagina: ni podia bajar mas, ni devolver resolucion si sobraba.
const ESCALAS = [1, 0.75, 0.6, 0.5];
let escalaCanvas = 1;
let stressFps = [];

function elegirEscala(med, actual) {
  let i = ESCALAS.indexOf(actual);
  if (i < 0) i = 0;
  if (med < 25) i += 2;            // lejisimos: saltar dos escalones de una
  else if (med < 46) i += 1;
  else if (med >= 59) i -= 1;      // sobra presupuesto: devolver resolucion
  return ESCALAS[Math.max(0, Math.min(ESCALAS.length - 1, i))];
}

function fitCanvasCss() {
  const { width: W, height: H } = el.canvas;
  const scale = Math.min(window.innerWidth / W, window.innerHeight / H);
  el.canvas.style.width = `${W * scale}px`;
  el.canvas.style.height = `${H * scale}px`;
}

function sizeCanvas() {
  const portrait = window.innerHeight >= window.innerWidth;
  const [W, H] = portrait ? [720, 1280] : [1280, 720];
  el.canvas.width = Math.round(W * escalaCanvas / 2) * 2;
  el.canvas.height = Math.round(H * escalaCanvas / 2) * 2;
  fitCanvasCss();
}
sizeCanvas();
addEventListener('resize', () => { if (state !== 'running') sizeCanvas(); });

// ---------- estado ----------
let pose = null, poseWorker = null, stream = null, renderer = null, recorder = null;
let players = [new Player(0), new Player(1)];
let activeCount = 1;
let state = 'idle';
let raf = 0, lastVideoTime = -1, lastT = 0, roundLeft = ROUND_SECONDS, blob = null;
let prefetch = null, prefetchPct = 0, dapCool = 0, dapHold = 0;
let framesRonda = 0, inicioRonda = 0, fpsClip = 0, deteccionesRonda = 0, fpsDeteccion = 0, nivelEfectos = 0;
let cam = { w: 0, h: 0, fps: 0 }, motor = '?', msInf = 0, msCap = 0, medStress = 0;
const trabajoRonda = [];
const p95 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] : 0);
let crudos = [null, null];       // ultimos landmarks reales (para el scorer)
let ultimaDeteccion = 0;         // segundos, para el dt real entre detecciones
let brazosFuera = false;         // los brazos no entran en el encuadre
let bombeando = false;           // hay un lazo de requestVideoFrameCallback vivo
let genBombeo = 0;
let proximaDeteccion = 0;        // ciclo de trabajo del respaldo de hilo principal
let lienzoChico = null, lienzoChicoCtx = null;
const msInferencia = [];
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
  pararDeteccion();
  el.oopsmsg.textContent = msg;
  show('oops');
}

// ---------- deteccion (desacoplada del render) ----------
//
// El scorer corre AL LLEGAR landmarks nuevos, no en cada frame de render.
// Llamar update() a 60Hz con landmarks que solo cambian a 30Hz partia la
// energia a la mitad en los frames repetidos.
function onLandmarks(landmarks, tsMs) {
  const t = tsMs / 1000;
  const dt = ultimaDeteccion ? Math.min(t - ultimaDeteccion, 0.3) : 1 / 30;
  ultimaDeteccion = t;
  deteccionesRonda++;

  crudos = landmarks?.length ? assignSlots(landmarks) : [null, null];
  if (landmarks?.length) activeCount = landmarks.length >= 2 ? 2 : 1;

  // Relacion de aspecto REAL del cuadro que vio el detector. Sin esto, la
  // misma pose da numeros que difieren 3.2x entre telefono parado y
  // acostado, y los umbrales de moves.js dejan de significar nada.
  const ar = (el.video.videoWidth || 1) / (el.video.videoHeight || 1);
  const metricos = crudos.map((lm) => toMetric(lm, ar));
  brazosFuera = brazosCortados(metricos[0]);

  if (state !== 'running') return;

  players.forEach((p, i) => p.update(crudos[i], t, metricos[i]));
  // El aura viaja al rival desde aca y no desde el bucle de dibujo: es el
  // unico lugar donde el numero cambio de verdad.
  if (modo === 'versus') batalla?.aura(players[0].aura);

  // DAP: no es de un jugador, es del par. Se sostiene: con un solo frame
  // coincidente cualquier mano que pasara cerca de la otra contaba.
  if (activeCount === 2) {
    dapCool -= dt;
    dapHold = detectDap(metricos[0], metricos[1]) ? dapHold + dt : 0;
    if (dapCool <= 0 && dapHold >= 0.2) {
      dapCool = DAP.cd; dapHold = 0;
      players.forEach((p) => { p.aura += DAP.bonus; p.landed.push(DAP.name); });
      renderer.addSignature(DAP.name, DAP.bonus);
      renderer.setLine(DAP.line, GOLD);
    }
  } else dapHold = 0;
  players.forEach((p, i) => { if (i < activeCount) handleEvents(p, i); });
}

/** Empuja frames de camara al detector, sin bloquear el render. */
function pedirDeteccion() {
  const v = el.video;
  if (v.readyState < 2) return;
  // El worker se sirve solo del track: no hay nada que empujar y el hilo
  // principal no toca ni un pixel. Es lo que libera el presupuesto de 60fps.
  if (poseWorker?.autoAlimentado()) return;
  // Solo frames NUEVOS de camara. Mandar el mismo frame otra vez gasta un
  // createImageBitmap y hace que el worker repita inferencia sobre lo mismo.
  if (v.currentTime === lastVideoTime) return;
  if (poseWorker) {
    if (!poseWorker.ocupado()) {
      lastVideoTime = v.currentTime;
      poseWorker.enviar(v, performance.now());
    }
    return;
  }
  // --- respaldo: hilo principal ---
  //
  // detectForVideo BLOQUEA. Cada llamada se come el presupuesto del frame
  // entero y el clip se graba a lo que quede. Medido en un iPhone 15 Pro
  // Max: 13 FPS de clip con 7 detecciones/s, o sea la inferencia comiendose
  // todo. Dos frenos:
  //   1. Se detecta sobre una copia CHICA, no sobre el video de 1080p. El
  //      modelo trabaja a 256px igual.
  //   2. Ciclo de trabajo: despues de una inferencia de T ms se esperan
  //      T*1.4 antes de la siguiente. La deteccion baja un poco; el dibujo,
  //      que es LO QUE SE GRABA, recupera la mayor parte del presupuesto.
  if (performance.now() < proximaDeteccion) return;
  lastVideoTime = v.currentTime;
  try {
    const t0 = performance.now();
    const res = pose.detectForVideo(reducirFrame(v), t0);
    const costo = performance.now() - t0;
    msInferencia.push(costo);
    if (msInferencia.length > 60) msInferencia.shift();
    // Cuanto respiro darle al dibujo depende de si le esta sobrando. Si el
    // gobernador no tuvo que soltar ni un efecto, hay margen y conviene
    // detectar mas seguido; si ya esta soltando, el clip manda.
    proximaDeteccion = performance.now() + costo * ((renderer?.nivel ?? 0) === 0 ? 0.8 : 1.8);
    onLandmarks(res?.landmarks ?? [], performance.now());
  } catch (e) { console.warn('[pose]', e?.message); }
}

/** Copia reducida del frame de camara, para no inferir sobre 1080p. */
function reducirFrame(v) {
  const w = v.videoWidth, h = v.videoHeight;
  if (!w || Math.max(w, h) <= 640) return v;
  const s = 640 / Math.max(w, h);
  const W = Math.round(w * s), H = Math.round(h * s);
  if (!lienzoChico) lienzoChico = document.createElement('canvas');
  if (lienzoChico.width !== W || lienzoChico.height !== H) {
    lienzoChico.width = W; lienzoChico.height = H;
    lienzoChicoCtx = lienzoChico.getContext('2d', { alpha: false });
  }
  lienzoChicoCtx.drawImage(v, 0, 0, W, H);
  return lienzoChico;
}

/**
 * Lazo de deteccion, SEPARADO del de render.
 *
 * Antes la deteccion vivia dentro del requestAnimationFrame: cada frame de
 * dibujo pagaba tambien el costo de conseguir un cuadro de camara, y el que
 * se pasaba de 16.7ms caia al siguiente vsync -> 30fps clavados en el clip.
 * requestVideoFrameCallback dispara UNA vez por cuadro nuevo de camara, que
 * es exactamente cuando hay algo nuevo que detectar, y nunca mas.
 */
function bombearDeteccion() {
  const v = el.video;
  if (bombeando || !('requestVideoFrameCallback' in v)) return;
  bombeando = true;
  // Al reiniciar la ronda se abre una camara nueva. La generacion mata al
  // lazo viejo si le quedaba un callback pendiente, para no terminar con dos
  // bombeos compitiendo por el mismo worker.
  const mio = ++genBombeo;
  const paso = () => {
    if (mio !== genBombeo) return;
    pedirDeteccion();
    v.requestVideoFrameCallback(paso);
  };
  v.requestVideoFrameCallback(paso);
}

function pararDeteccion() {
  genBombeo++;
  bombeando = false;
}

/**
 * Camara + modelo listos. `arrancarYa` en false deja todo cargado SIN
 * empezar la ronda, que es lo que necesita la batalla online: el permiso de
 * camara y el modelo tardan, y hacer esperar al rival mientras tanto es peor
 * que esperar uno mismo antes de entrar a la sala.
 * @returns {Promise<boolean>} si quedo listo
 */
async function boot(arrancarYa = true) {
  el.go.disabled = true;
  show('loading');
  try {
    el.loadmsg.textContent = 'PIDIENDO CÁMARA…';
    stream = await openCamera(el.video);
  } catch (e) {
    fail(
      e?.name === 'NotAllowedError'
        ? 'Necesito permiso de cámara. Activalo y reintentá.'
        : 'No encontré cámara en este dispositivo.'
    );
    return false;
  }
  try {
    el.loadmsg.textContent = prefetchPct >= 1 ? 'CALIBRANDO SENSORES…' : `DESCARGANDO SENSORES… ${Math.round(prefetchPct * 100)}%`;
    await prefetch;                       // ya venia bajando desde que abrio la pagina
    el.loadmsg.textContent = 'CALIBRANDO SENSORES…';
    // Worker primero: es lo unico que permite 60fps. Si no arranca, el
    // detector del hilo principal sigue funcionando (a ~30fps).
    if (!poseWorker && !pose) {
      // ?hiloprincipal fuerza el camino viejo, para comparar rendimiento
      if (!new URLSearchParams(location.search).has('hiloprincipal')) {
        poseWorker = await createPoseWorker(2, onLandmarks);
      }
      if (!poseWorker) pose = await createPose(2);
      console.info(poseWorker ? `[pose] worker (${poseWorker.delegate})` : '[pose] hilo principal');
    }
    // ?sinstream fuerza el camino de createImageBitmap, para comparar
    if (poseWorker && !new URLSearchParams(location.search).has('sinstream')) {
      console.info('[pose] stream directo al worker:', poseWorker.conectarStream(stream));
    }
    bombearDeteccion();
    if (document.fonts?.ready) await document.fonts.ready;
  } catch (e) {
    console.error(e);
    fail('No se pudo cargar el modelo. Revisá tu conexión.');
    return false;
  }
  renderer = new Renderer(el.canvas);
  recorder = new Recorder(el.canvas);
  if (arrancarYa) countdown();
  return true;
}

function countdown() {
  players = [new Player(0), new Player(1)];
  roundLeft = ROUND_SECONDS;
  stressFps = [];
  trabajoRonda.length = 0;
  ultimaDeteccion = 0;
  dapCool = 0;
  state = 'countdown';
  lastT = performance.now() / 1000;
  loop();

  // Ensayo: se graba en falso durante la cuenta y se tira. Sin esto la
  // prueba de esfuerzo medía un frame SIN capturar el canvas, que es
  // justamente lo que se pone caro al grabar.
  const ensayo = new Recorder(el.canvas);
  ensayo.start(60);

  let n = 3;
  show('count');
  el.countnum.textContent = n;
  const tick = setInterval(() => {
    n--;
    if (n === 0) {
      clearInterval(tick);
      show();
      ensayo.cancelar();      // suelta la captura antes de tocar el canvas
      // Si el aparato no aguanto la prueba de esfuerzo de la cuenta regresiva,
      // bajamos resolucion ANTES de grabar. Cambiarla a mitad de grabacion
      // rompe el encoder, por eso la decision se toma aca.
      // Se re-evalua en CADA ronda: la carga cambia entre rondas (calor,
      // bateria, otra app) y antes esto corria una sola vez por carga de
      // pagina, asi que ni podia bajar mas ni devolver resolucion.
      if (stressFps.length > 20) {
        // MEDIANA, no promedio.
        //
        // El primer frame del bucle mide un dt de microsegundos (countdown()
        // fija lastT y llama a loop() en el mismo tick), o sea ~10000 fps.
        // Ese unico valor levantaba el promedio de ~45 a ~176 y la decision
        // salia SIEMPRE "escala 1". Toda la bajada automatica de resolucion
        // estaba muerta desde que se escribio: un aparato que dibujaba a
        // 45fps se quedaba igual en 720x1280.
        const orden = [...stressFps].sort((a, b) => a - b);
        const med = orden[orden.length >> 1];
        // Escalonado: si el aparato no llega a 60fps, lo que arruina el clip
        // es la resolucion, no los efectos. Mejor 540p a 60fps que 720p a 30.
        medStress = med;
        // La medicion vale PARA LA ESCALA CON LA QUE SE MIDIO: se mueve un
        // escalon (dos si esta lejisimos), no se salta a un absoluto.
        const escala = elegirEscala(med, escalaCanvas);
        if (escala !== escalaCanvas) {
          escalaCanvas = escala;
          sizeCanvas();
          renderer = new Renderer(el.canvas);
          console.info(`[perf] ${med.toFixed(0)} FPS en la prueba -> ${el.canvas.width}x${el.canvas.height}`);
        }
      }
      state = 'running';
      framesRonda = 0;
      deteccionesRonda = 0;
      inicioRonda = performance.now();
      recorder.start(60);
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
  // Siempre, no solo en debug: es DOS performance.now() y es el unico numero
  // que separa "el hilo principal esta ahogado" de "el cuello esta afuera"
  // (compositor, encoder, GPU). Sin el, un reporte de pocos fps no se puede
  // diagnosticar.
  const trabajo0 = performance.now();
  const now = performance.now();
  const t = now / 1000;
  const dt = Math.min(t - lastT, 0.15);
  lastT = t;

  // Solo si no hay rVFC (Firefox): ahi el render sigue siendo el unico reloj.
  if (!bombeando) pedirDeteccion();

  const scoring = state === 'running';
  // El scorer ya consumio los landmarks crudos en onLandmarks(). Aca solo
  // se suaviza para dibujar: la deteccion llega a ~30Hz y pintarla tal cual
  // a 60Hz se ve a saltos.
  players.forEach((p, i) => { p.lm = smoothLm(i, crudos[i], dt); });

  if (scoring) {
    framesRonda++;      // frames que realmente entraron al clip
    roundLeft -= dt;
    if (roundLeft <= 0) { finish(); return; }
  }

  const fps = 1 / Math.max(dt, 1e-4);
  // La cuenta regresiva dibuja los efectos a tope a proposito: mide el costo
  // REAL antes de grabar. Medirlo con la pantalla en calma daba 60 siempre
  // y luego se caia al empezar la ronda.
  if (state === 'countdown' && stressFps.length < 90) stressFps.push(fps);

  if (DEBUG) {
    fpsHist.push(fps);
    if (fpsHist.length > 45) fpsHist.shift();
    window.__fps = fpsHist.reduce((a, b) => a + b, 0) / fpsHist.length;
    window.__estado = state;
  }
  const fpsTag = DEBUG
    ? `  ·  ${(fpsHist.reduce((a, b) => a + b, 0) / fpsHist.length).toFixed(0)} FPS  ${el.canvas.width}p  N${renderer.nivel}`
    : '';

  // Con el telefono vertical el cuadro mide media altura de ancho: los brazos
  // abiertos se salen y el t-pose no tiene con que detectarse. Decirlo es la
  // diferencia entre "no funciona" y "alejate un paso".
  const aviso = brazosFuera && crudos[0] ? '  ·  ALEJÁTE, NO VEO TUS BRAZOS' : '';
  const status = (state === 'running'
    ? `${roundLeft.toFixed(1)}s  ·  ${activeCount === 2 ? 'MODO VERSUS' : 'SUJETO ÚNICO'}${aviso}`
    : (crudos[0] ? `SUJETO DETECTADO${aviso}` : 'BUSCANDO SUJETO…')) + fpsTag;

  renderer.frame({
    video: el.video, mirror, players, active: activeCount, status, dt,
    stress: state === 'countdown',
  });

  // Trabajo de hilo principal por frame: si pasa de 16.7ms, 60fps es
  // imposible porque rAF cae al siguiente vsync (33.3ms = 30fps clavados).
  // Si NO pasa de 16.7 y los fps igual estan por el piso, el cuello esta
  // fuera del hilo principal y no hay efecto que soltar que lo arregle.
  if (scoring) {
    trabajoRonda.push(performance.now() - trabajo0);
    if (trabajoRonda.length > 400) trabajoRonda.shift();
  }
  if (DEBUG) {
    (window.__trabajo ||= []).push(performance.now() - trabajo0);
    if (window.__trabajo.length > 240) window.__trabajo.shift();
  }
}

async function finish() {
  state = 'ending';
  // Cuadros por segundo REALES del clip: el canvas solo se captura cuando
  // se redibuja, asi que este es el numero que de verdad tiene el archivo.
  // captureStream(60) es el techo: el clip nunca puede tener mas de 60,
  // aunque el bucle dibuje mas rapido.
  const segundos = Math.max((performance.now() - inicioRonda) / 1000, 0.001);
  fpsClip = Math.min(60, framesRonda / segundos);
  fpsDeteccion = deteccionesRonda / segundos;
  cam = ajustesCamara(stream);       // antes de cerrar el track, despues no se sabe
  nivelEfectos = renderer?.nivel ?? 0;
  // El motor es LO PRIMERO que hay que saber cuando alguien reporta pocos
  // fps: "hilo principal" significa que la inferencia esta bloqueando el
  // dibujo y no hay ajuste de efectos que lo salve.
  motor = poseWorker ? `worker ${poseWorker.delegate}` : 'HILO PRINCIPAL';
  const inf = poseWorker
    ? poseWorker.inferenciaMs()
    : (msInferencia.length ? [...msInferencia].sort((a, b) => a - b)[msInferencia.length >> 1] : 0);
  msInf = Math.round(inf);
  msCap = Math.round(poseWorker?.capturaMs?.() ?? 0);
  blob = await recorder.stop();
  cancelAnimationFrame(raf);
  pararDeteccion();
  stream?.getTracks().forEach((t) => t.stop());
  state = 'idle';

  const winner = activeCount === 2
    ? (players[0].aura >= players[1].aura ? 0 : 1)
    : 0;
  const p = players[winner];
  const aura = Math.round(p.aura);
  const v = verdictFor(aura);

  // La cinta la puede haber pisado una batalla anterior con GANASTE/PERDISTE.
  el.rTape.textContent = 'VEREDICTO';
  el.rTape.classList.remove('alert');
  el.rScore.textContent = aura.toLocaleString('es-GT');
  el.rTitle.textContent = v.t;
  el.rSub.textContent = v.s;
  const landed = [...new Set(p.landed)];
  el.rStats.innerHTML = [
    `PICO <b>${p.peakEnergy.toFixed(1)}</b>`,
    `COMBO MÁX <b>${p.combo}</b>`,
    activeCount === 2 ? `GANADOR <b>P${winner + 1}</b>` : `MODO <b>SOLO</b>`,
    ...landed.map((n) => `<b>${n}</b>`),
    ...(DEBUG ? [
      // Los FPS del clip vuelven a ser solo de debug. Los habia dejado
      // siempre visibles para no tener que adivinar cuando "no sale a 60",
      // pero en la pantalla de resultado de una ronda buena compiten con
      // los moves reconocidos, que es lo unico que el jugador queria ver.
      `CLIP <b>${fpsClip.toFixed(0)} FPS · ${el.canvas.height}p</b>`,
      // TRABAJO es el que decide dónde está el cuello:
      //   alto  -> el hilo principal está ahogado (JS/dibujo)
      //   bajo con pocos FPS -> el cuello está afuera (captura/encoder/GPU)
      `TRABAJO <b>${p95(trabajoRonda).toFixed(1)} ms</b>`,
      `CUENTA <b>${medStress.toFixed(0)} fps</b>`,
      `MOTOR <b>${motor}</b>`,
      `INFERENCIA <b>${msInf} ms</b>`,
      `CAPTURA <b>${msCap} ms</b>`,
      `DETECCIÓN <b>${fpsDeteccion.toFixed(0)}/s</b>`,
      `CÁMARA <b>${cam.w}×${cam.h} @${cam.fps}</b>`,
      `EFECTOS <b>nivel ${nivelEfectos}</b>`,
    ] : []),
  ].map((s) => `<span>${s}</span>`).join('');
  el.rSub.textContent = landed.length
    ? `${v.s}  Reconocí: ${landed.join(', ')}.`
    : `${v.s} No detecté ningún movimiento con nombre.`;

  // --- batalla online: comparar contra el rival ---
  if (modo === 'versus' && batalla) {
    console.info('[versus] termino mi ronda, mando fin', { aura, tengoFinRival: !!finRival });
    batalla.fin(aura, landed);
    // El `fin` del rival puede llegar despues del nuestro: su ronda arranco
    // unas decimas mas tarde (la orden de arrancar viaja). Se le da margen y
    // si no llega, se dice que no llego en vez de inventar un ganador.
    if (!finRival) {
      const t0 = performance.now();
      while (!finRival && performance.now() - t0 < 3500) await new Promise((r) => setTimeout(r, 100));
    }
    if (finRival) {
      const gane = aura > finRival.aura;
      const empate = aura === finRival.aura;
      el.rTape.textContent = empate ? 'EMPATE' : (gane ? 'GANASTE' : 'PERDISTE');
      el.rTape.classList.toggle('alert', !gane && !empate);
      el.rSub.textContent = `${empate ? 'Empate' : (gane ? 'Le ganaste' : 'Te ganó')} por ${Math.abs(aura - finRival.aura).toLocaleString('es-GT')} de aura. `
        + `Rival: ${finRival.aura.toLocaleString('es-GT')}${finRival.moves.length ? ` (${finRival.moves.join(', ')})` : ''}.`;
    } else {
      el.rTape.textContent = 'SIN RIVAL';
      el.rSub.textContent = 'El rival se fue antes de terminar. Tu aura cuenta igual.';
    }
    cerrarBatalla();
  }

  // Lo que se sube al torneo. Se guarda al cerrar la ronda y no se recalcula
  // despues: `players` se reinicia en "otra vez" y el alias se puede escribir
  // en cualquier momento, incluso con otra ronda ya empezando.
  ultimaPartida = { aura, moves: landed };
  prepararAlta();

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

// ---------- batalla online ----------
let modo = 'solo';            // 'solo' | 'versus'
let batalla = null;
let auraRival = 0;
let finRival = null;

function mostrarRival(on) {
  el.rivalCaja.classList.toggle('hidden', !on);
  if (!on) { el.rivalVid.srcObject = null; el.rivalAura.textContent = '0'; }
}

function cerrarBatalla() {
  batalla?.cerrar();
  batalla = null;
  modo = 'solo';
  auraRival = 0;
  finRival = null;
  mostrarRival(false);
}

/**
 * Entra a una sala. La camara y el modelo se cargan ANTES de conectarse:
 * pedir permiso de camara con un rival ya esperando del otro lado es la
 * forma mas facil de que el otro se vaya.
 */
async function entrarASala(codigo) {
  modo = 'versus';
  auraRival = 0;
  finRival = null;
  if (!await boot(false)) { modo = 'solo'; return; }

  el.salaCodigo.textContent = codigo;
  el.salaMsg.textContent = 'Esperando rival…';
  el.salaFine.textContent = 'Pasale el código a quien quieras retar.';
  show('sala');

  batalla = new Batalla({
    onEstado: (e, extra) => {
      if (e === 'listos') {
        el.salaMsg.textContent = '¡Rival encontrado!';
        el.salaFine.textContent = 'Arrancando…';
        mostrarRival(true);
        // Solo el anfitrion da la orden, si no habria dos cuentas
        // regresivas. El margen es para que el video alcance a negociar;
        // si no llega, la partida arranca igual y se juega a ciegas.
        if (extra?.rol === 'anfitrion') {
          setTimeout(() => { if (batalla?.arrancar()) countdown(); }, 1600);
        }
      } else if (e === 'arranca') {
        countdown();
      } else if (e === 'llena') {
        el.salaMsg.textContent = 'Esa sala ya tiene dos jugadores.';
        el.salaFine.textContent = 'Probá con otro código.';
        cerrarBatalla();
      } else if (e === 'rival-se-fue') {
        // A mitad de ronda NO se corta: se termina jugando solo y el aura
        // cuenta igual. Cortar la ronda por un rival que se fue seria
        // castigar al que se quedo.
        if (state === 'running' || state === 'countdown') {
          el.rivalAura.textContent = '—';
        } else {
          el.salaMsg.textContent = 'El rival se fue.';
          el.salaFine.textContent = 'Buscá otro o volvé al menú.';
          cerrarBatalla();
        }
      } else if (e === 'error') {
        el.salaMsg.textContent = 'Se cortó la conexión.';
        cerrarBatalla();
      }
    },
    onAuraRival: (v) => { auraRival = v; el.rivalAura.textContent = v.toLocaleString('es-GT'); },
    onFinRival: (r) => { finRival = r; },
    onVideoRival: (s) => { el.rivalVid.srcObject = s; },
  });
  batalla.entrar(codigo, stream);
}

el.irVersus?.addEventListener('click', () => {
  startPrefetch();
  el.vsMsg.textContent = '';
  el.vsCodigo.value = '';
  show('versus');
});
el.vsVolver?.addEventListener('click', () => { cerrarBatalla(); el.go.disabled = false; show('intro'); });
el.vsCrear?.addEventListener('click', () => entrarASala(codigoNuevo()));
el.vsEntrar?.addEventListener('click', () => {
  const c = el.vsCodigo.value.trim().toUpperCase();
  if (!codigoValido(c)) { el.vsMsg.textContent = 'El código son 4 letras o números.'; return; }
  entrarASala(c);
});
el.vsBuscar?.addEventListener('click', async () => {
  el.vsBuscar.disabled = true;
  el.vsMsg.textContent = 'Buscando rival…';
  try {
    // La cola solo reparte el codigo; despues los dos entran a la misma
    // sala por el mismo camino que los amigos. Una sola implementacion de
    // sala en vez de dos que hay que mantener sincronizadas.
    const codigo = await new Batalla().buscarRival();
    await entrarASala(codigo);
  } catch (e) {
    el.vsMsg.textContent = `${e.message}. Probá de nuevo o armá una sala con código.`;
  } finally {
    el.vsBuscar.disabled = false;
  }
});
el.salaSalir?.addEventListener('click', () => { cerrarBatalla(); show('versus'); });
el.rivalSaltar?.addEventListener('click', () => {
  batalla?.saltar();
  cerrarBatalla();
  cancelAnimationFrame(raf);
  pararDeteccion();
  stream?.getTracks().forEach((t) => t.stop());
  state = 'idle';
  el.go.disabled = false;
  show('versus');
});
if (hayVersus()) el.irVersus?.classList.remove('hidden');

// ---------- torneo ----------
let ultimaPartida = null;     // {aura, moves} de la ronda recien cerrada
let subida = null;            // respuesta del worker: {pais, region}
let yaSubida = false;         // esta ronda ya se anoto
let ambito = 'global', periodo = 'dia';

function prepararAlta() {
  el.alta.classList.toggle('hidden', !hayApi());
  if (!hayApi()) return;
  yaSubida = false;
  el.alias.value = getAlias();
  el.subir.disabled = false;
  el.subir.textContent = 'ENTRAR AL TORNEO';
  el.altaMsg.textContent = '';
}

// El teclado del telefono ocupa media pantalla y se come el boton de
// "ENTRAR AL TORNEO" justo cuando lo vas a tocar. Al enfocar el campo se
// trae la fila entera a la vista; el timeout es porque iOS recien reajusta
// el viewport DESPUES del focus.
el.alias?.addEventListener('focus', () => {
  setTimeout(() => el.alta?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
});

el.subir?.addEventListener('click', async () => {
  // Ya anotada: el boton pasa a ser el atajo a la tabla. Volver a mandar la
  // misma ronda crearia una fila duplicada con el mismo puntaje.
  if (yaSubida) { abrirRanking(); return; }

  const alias = el.alias.value.trim();
  if (!aliasValido(alias)) {
    el.altaMsg.textContent = 'El nombre va de 2 a 14 letras o números.';
    el.alias.focus();
    return;
  }
  if (!ultimaPartida) return;
  setAlias(alias);
  el.subir.disabled = true;
  el.subir.textContent = 'SUBIENDO…';
  el.altaMsg.textContent = '';
  // Con el backend lento o caido eran seis segundos de "SUBIENDO…" sin una
  // sola señal de vida, y desde afuera eso es indistinguible de colgado.
  const lento = setTimeout(() => { el.altaMsg.textContent = 'Tardando más de lo normal…'; }, 2200);
  try {
    subida = await enviarPuntaje({ alias, ...ultimaPartida });
    yaSubida = true;
    el.altaMsg.textContent = 'Anotado.';
    // El ambito arranca en el mas chico que tenga sentido: verse primero
    // entre los del barrio engancha mas que ser el puesto 4.000 del mundo.
    ambito = subida.region ? 'region' : 'pais';
    periodo = 'dia';
    abrirRanking();
  } catch (e) {
    el.altaMsg.textContent = `No se pudo subir (${e.message}). Tu puntaje no se perdió, probá de nuevo.`;
  } finally {
    clearTimeout(lento);
    // PASE LO QUE PASE el boton vuelve a estar vivo. Sin este `finally` se
    // quedaba en "SUBIENDO…" y deshabilitado despues de un alta EXITOSA: la
    // ronda se anotaba bien, pero al tocar VOLVER desde la tabla el boton
    // seguia gris y parecia colgado.
    el.subir.disabled = false;
    el.subir.textContent = yaSubida ? 'VER MI PUESTO' : 'REINTENTAR';
  }
});

/** Las pestañas de ambito dependen de si el worker supo de donde jugás. */
function sincronizarTabs() {
  for (const b of el.tabAmbito.querySelectorAll('.tab')) {
    b.classList.toggle('on', b.dataset.v === ambito);
    if (b.dataset.v === 'region') b.disabled = !!subida && !subida.region;
  }
  for (const b of el.tabPeriodo.querySelectorAll('.tab')) {
    b.classList.toggle('on', b.dataset.v === periodo);
  }
}

const PERIODO_TXT = { dia: 'HOY', semana: 'ESTA SEMANA', historico: 'DESDE SIEMPRE' };

async function abrirRanking() {
  show('rank');
  sincronizarTabs();
  el.rankYo.textContent = '';
  el.tabla.innerHTML = '<li><span class="vacio">CARGANDO…</span></li>';
  const alias = getAlias();
  try {
    const r = await traerRanking({ ambito, periodo, alias, limite: 50 });
    const donde = ambito === 'global' ? 'EL MUNDO'
      : ambito === 'pais' ? nombrePais(r.pais)
        : (r.region || nombrePais(r.pais)).toUpperCase();
    el.rankDonde.textContent = `${donde} · ${PERIODO_TXT[periodo]}`;
    // Se compara por la clave normalizada, igual que agrupa el worker: si no,
    // "Rakata" no se resaltaria por haberse anotado antes como "RAKATA".
    const clave = (s) => String(s).trim().toLowerCase();
    el.tabla.innerHTML = r.filas.length
      ? r.filas.map((f) => `<li class="${f.puesto <= 3 ? 'podio ' : ''}${clave(f.alias) === clave(alias) ? 'yo' : ''}">
          <span class="pos">${f.puesto}</span>
          <span class="quien">${escapar(f.alias)}</span>
          <span class="cuanto">${Number(f.aura).toLocaleString('es-GT')}</span>
        </li>`).join('')
      : '<li><span class="vacio">TODAVÍA NO JUGÓ NADIE ACÁ.<br />ANOTATE PRIMERO.</span></li>';
    el.rankYo.textContent = r.yo
      ? `Vos: puesto ${r.yo.puesto} de ${r.yo.total} · ${Number(r.yo.aura).toLocaleString('es-GT')} de aura.`
      : (alias ? 'Todavía no tenés puntaje en esta tabla.' : '');
  } catch (e) {
    el.tabla.innerHTML = `<li><span class="vacio">NO SE PUDO CARGAR<br />${escapar(e.message)}</span></li>`;
    el.rankDonde.textContent = '';
  }
}

// El alias lo escribe el jugador: va al DOM como texto, nunca como HTML.
const escapar = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

for (const [caja, set] of [[el.tabAmbito, (v) => (ambito = v)], [el.tabPeriodo, (v) => (periodo = v)]]) {
  caja?.addEventListener('click', (ev) => {
    const b = ev.target.closest('.tab');
    if (!b || b.disabled) return;
    set(b.dataset.v);
    abrirRanking();
  });
}

el.verRank?.addEventListener('click', abrirRanking);
el.rankVolver?.addEventListener('click', () => show(ultimaPartida ? 'result' : 'intro'));
if (hayApi()) el.verRank?.classList.remove('hidden');

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
  // Camara nueva = track nuevo: el clon que tenia el worker quedo muerto y
  // sin esto la ronda 2 se detectaba por el camino lento.
  poseWorker?.conectarStream(stream);
  bombearDeteccion();
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
