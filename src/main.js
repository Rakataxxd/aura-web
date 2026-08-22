import './style.css';
import { createPose, createPoseWorker, openCamera, assignSlots, prefetchAssets, ajustesCamara } from './pose.js';
import { Player } from './scoring.js';
import { Renderer, P_COLOR, GOLD, BONE } from './render.js';
import { Recorder, shareOrDownload } from './record.js';
import { detectDap, DAP, brazosCortados } from './moves.js';
import { toMetric } from './landmarks.js';
import { verdictFor } from './roasts.js';
import { hayApi, getAlias, setAlias, aliasValido, enviarPuntaje, traerRanking, nombrePais } from './ranking.js';
import { Batalla, hayVersus, codigoNuevo, codigoValido, TOPE_SALA } from './versus.js';

const ROUND_SECONDS = 15;
const DEBUG = new URLSearchParams(location.search).has('debug');
const fpsHist = [];

const $ = (id) => document.getElementById(id);
const el = {
  video: $('cam'), canvas: $('view'),
  intro: $('intro'), loading: $('loading'), count: $('count'), result: $('result'), oops: $('oops'),
  rank: $('rank'), versus: $('versus'),
  irVersus: $('irVersus'), vsBuscar: $('vsBuscar'), vsCodigo: $('vsCodigo'), vsEntrar: $('vsEntrar'),
  vsCrear: $('vsCrear'), vsMsg: $('vsMsg'), vsVolver: $('vsVolver'),
  tiles: $('tiles'), tileYo: $('tileYo'), miNombre: $('miNombre'), miAura: $('miAura'),
  barra: $('barra'), barraCodigo: $('barraCodigo'), btnMic: $('btnMic'),
  btnSiguiente: $('btnSiguiente'), btnSalir: $('btnSalir'),
  lobby: $('lobby'), lobbyCodigo: $('lobbyCodigo'), lobbyQuienes: $('lobbyQuienes'),
  lobbyEmpezar: $('lobbyEmpezar'), lobbyFine: $('lobbyFine'),
  go: $('go'), share: $('share'), again: $('again'), retry: $('retry'),
  nextRival: $('nextRival'), backSala: $('backSala'), rSala: $('rSala'), rMarcador: $('rMarcador'),
  countnum: $('countnum'), loadmsg: $('loadmsg'), oopsmsg: $('oopsmsg'),
  rScore: $('rScore'), rTitle: $('rTitle'), rSub: $('rSub'), rStats: $('rStats'), rNote: $('rNote'),
  rTape: $('rTape'),
  verRank: $('verRank'), alta: $('alta'), alias: $('alias'), subir: $('subir'), altaMsg: $('altaMsg'),
  tabAmbito: $('tabAmbito'), tabPeriodo: $('tabPeriodo'),
  rankDonde: $('rankDonde'), tabla: $('tabla'), rankYo: $('rankYo'), rankVolver: $('rankVolver'),
};

const PANELES = ['intro', 'loading', 'count', 'result', 'oops', 'rank', 'versus'];
let panelesArriba = [];
const show = (...ids) => {
  panelesArriba = ids;
  for (const k of PANELES) el[k].classList.toggle('hidden', !ids.includes(k));
  // La barra de la sala y la grilla dependen de que haya arriba: un panel
  // opaco la tapa, y si la barra aparece o se va, los recuadros cambian de
  // alto.
  actualizarBarra();
  acomodarTiles();
};

// ---------- canvas ----------
// Escalera de resolucion. Antes esto era un booleano `downscaled` y
// `sizeCanvas()` aplicaba 0.75 fijo, sin importar que escalon se hubiera
// elegido: un aparato que necesitaba 0.5 volvia a 0.75 al tocar "otra vez".
// Y la decision solo corria si `!downscaled`, o sea UNA vez en la vida de la
// pagina: ni podia bajar mas, ni devolver resolucion si sobraba.
// El ultimo escalon (0.4 -> 288x512) es para los Android flojos: antes el
// piso era 0.5 y un aparato que ahi seguia a 25fps no tenia a donde bajar.
const ESCALAS = [1, 0.75, 0.6, 0.5, 0.4];
let escalaCanvas = 1;
let stressFps = [];
// Cuadros por segundo con los que se CAPTURA el canvas para el clip. Se decide
// con la misma medicion que la resolucion, ver countdown().
let fpsGrabacion = 60;

function elegirEscala(med, actual) {
  let i = ESCALAS.indexOf(actual);
  if (i < 0) i = 0;
  if (med < 25) i += 2;            // lejisimos: saltar dos escalones de una
  else if (med < 46) i += 1;
  else if (med >= 59) i -= 1;      // sobra presupuesto: devolver resolucion
  return ESCALAS[Math.max(0, Math.min(ESCALAS.length - 1, i))];
}

/**
 * La caja donde vive MI recuadro. Jugando solo es la pantalla entera; en una
 * sala es una celda de la grilla, que puede ser mucho mas angosta.
 */
function cajaMia() {
  const r = el.tileYo.getBoundingClientRect();
  return { w: r.width || window.innerWidth, h: r.height || window.innerHeight };
}

function fitCanvasCss() {
  const { width: W, height: H } = el.canvas;
  const { w, h } = cajaMia();
  const scale = Math.min(w / W, h / H);
  el.canvas.style.width = `${W * scale}px`;
  el.canvas.style.height = `${H * scale}px`;
}

/**
 * Resolucion real del canvas.
 *
 * La orientacion sale de MI RECUADRO y no de la ventana: en una sala de dos
 * sobre una pantalla ancha mi celda es media pantalla —o sea vertical— y un
 * canvas apaisado ahi adentro queda con dos franjas negras enormes a los
 * costados.
 * @returns {boolean} si cambio el tamaño (hay que rehacer el renderer)
 */
function sizeCanvas() {
  const { w, h } = cajaMia();
  const [W, H] = h >= w ? [720, 1280] : [1280, 720];
  const ancho = Math.round(W * escalaCanvas / 2) * 2;
  const alto = Math.round(H * escalaCanvas / 2) * 2;
  const cambio = el.canvas.width !== ancho || el.canvas.height !== alto;
  if (cambio) { el.canvas.width = ancho; el.canvas.height = alto; }
  fitCanvasCss();
  return cambio;
}

// Proporcion con la que se mide el "area util" de un recuadro. Los videos se
// recortan con object-fit, asi que lo que sobra de una celda muy alta o muy
// ancha NO se ve: sin tener eso en cuenta, dos personas en pantalla ancha
// empataban con dos apiladas y la eleccion salia por redondeo.
const AR_TILE = 4 / 3;

/**
 * Reparte la pantalla entre los recuadros.
 *
 * Prueba TODAS las cantidades de columnas y se queda con la que deja el
 * recuadro mas grande. De ahi salen solas las disposiciones de cualquier
 * videollamada: dos lado a lado en horizontal (y apiladas en un telefono
 * parado), tres como 2 arriba + 1 centrado abajo, seis como 3x2. El centrado
 * del ultimo renglon lo hace el flexbox, no esta cuenta.
 */
function acomodarTiles() {
  const enSala = modo === 'versus' && !!batalla;
  el.tiles.classList.toggle('solo', !enSala);
  el.tiles.classList.toggle('sala', enSala);
  // La barra puede ocupar dos renglones en un telefono angosto: se mide, no
  // se adivina.
  el.tiles.style.bottom = enSala && !el.barra.classList.contains('hidden')
    ? `${el.barra.offsetHeight + 6}px`
    : '';

  const n = 1 + tiles.size;
  const hueco = n > 1 ? 8 : 0;      // el --tgap del CSS
  const W = el.tiles.clientWidth, H = el.tiles.clientHeight;
  if (!W || !H) return;

  let mejor = { w: W, h: H, util: -1 };
  for (let cols = 1; cols <= n; cols++) {
    const filas = Math.ceil(n / cols);
    const w = (W - hueco * (cols - 1)) / cols;
    const h = (H - hueco * (filas - 1)) / filas;
    if (w <= 0 || h <= 0) continue;
    const util = Math.min(w, h * AR_TILE) * Math.min(w / AR_TILE, h);
    if (util > mejor.util) mejor = { w, h, util };
  }
  el.tiles.style.setProperty('--tw', `${Math.floor(mejor.w)}px`);
  el.tiles.style.setProperty('--th', `${Math.floor(mejor.h)}px`);

  // Mientras se graba NO se toca el tamaño REAL del canvas: cambiarlo a mitad
  // de grabacion rompe el encoder. Se reacomoda solo el CSS, que es gratis.
  if (state === 'running' || state === 'countdown') fitCanvasCss();
  else if (sizeCanvas() && renderer) renderer = new Renderer(el.canvas);
}

sizeCanvas();
addEventListener('resize', acomodarTiles);

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
let ultimoPreview = 0;           // reloj de la vista previa del lobby, ver loop()
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
  // El aura viaja a la sala desde aca y no desde el bucle de dibujo: es el
  // unico lugar donde el numero cambio de verdad.
  if (modo === 'versus') {
    batalla?.aura(players[0].aura);
    el.miAura.textContent = Math.round(players[0].aura).toLocaleString('es-GT');
  }

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
  // Sin detector no hay nada que hacer. Sin este corte, una ronda que empiece
  // antes de que el modelo cargue tira una excepcion por CADA cuadro (medido:
  // 436 en una ronda) y lo unico que se ve desde afuera es un aura de cero.
  if (!pose) return;
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
 * Camara viva, sin volver a pedirla si ya lo esta.
 *
 * Reusarla importa para la batalla: pasar de un rival al siguiente abria una
 * camara nueva cada vez —dejando la anterior encendida— y metia un "pidiendo
 * cámara" de dos segundos en medio de lo que tiene que sentirse instantaneo.
 */
async function asegurarCamara() {
  if (stream?.getVideoTracks?.().some((t) => t.readyState === 'live')) return true;
  try {
    stream = await openCamera(el.video);
  } catch (e) {
    fail(
      e?.name === 'NotAllowedError'
        ? 'Necesito permiso de cámara. Activalo y reintentá.'
        : 'No encontré cámara en este dispositivo.'
    );
    return false;
  }
  // Camara nueva = track nuevo: el clon que tenia el worker quedo muerto y
  // sin esto la ronda siguiente se detecta por el camino lento.
  poseWorker?.conectarStream(stream);
  return true;
}

/** Un solo lazo de dibujo vivo a la vez: dos compiten por el mismo worker. */
function arrancarLoop() {
  cancelAnimationFrame(raf);
  lastT = performance.now() / 1000;
  loop();
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
  el.loadmsg.textContent = 'PIDIENDO CÁMARA…';
  if (!await asegurarCamara()) return false;
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
  arrancarLoop();

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
        // Y con la MISMA medicion se decide a cuantos cuadros capturar.
        //
        // captureStream(60) no es gratis aunque el canvas dibuje a 30: le pide
        // al compositor que muestree 60 veces por segundo y al codificador que
        // comprima 60 cuadros. En un Android que ya viene raspando, eso es
        // presupuesto que se le saca al dibujo — y un clip de 30fps completo se
        // ve mejor que uno de 60 al que le faltan cuadros.
        fpsGrabacion = med >= 50 ? 60 : 30;
      }
      state = 'running';
      framesRonda = 0;
      deteccionesRonda = 0;
      inicioRonda = performance.now();
      recorder.start(fpsGrabacion);
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

  // ESPERANDO EN EL LOBBY SE DIBUJA A LA MITAD.
  //
  // La vista previa de la sala puede estar minutos en pantalla mientras entra
  // gente, y ahi no se esta grabando nada: dibujar a 60fps solo sirve para
  // calentar el telefono, y un telefono caliente entra a la ronda con la CPU
  // ya limitada. `lastT` no se toca al saltear, asi que el dt del cuadro
  // siguiente sale correcto solo.
  const ahora = performance.now();
  if (state === 'idle' && modo === 'versus') {
    if (ahora - ultimoPreview < 32) return;
    ultimoPreview = ahora;
  }

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
  fpsClip = Math.min(fpsGrabacion, framesRonda / segundos);
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
  // En una sala la camara NO se apaga al terminar la ronda: la sala sigue
  // viva y los demas te tienen que seguir viendo mientras miran el
  // resultado, igual que en cualquier videollamada. Se apaga al salir.
  if (modo !== 'versus') stream?.getTracks().forEach((t) => t.stop());
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

  // --- batalla online: comparar contra la sala ---
  if (modo === 'versus' && batalla) {
    console.info('[versus] termino mi ronda, mando fin', { aura, participantes });
    batalla.fin(aura, landed);
    // El `fin` de los demas llega despues del propio: sus rondas arrancaron
    // unas decimas mas tarde (la orden de arrancar viaja). Se les da margen y
    // el que no llega se muestra sin puntaje, en vez de inventar un ganador.
    await esperarFines(3500);
    const filas = pintarResultadoSala(aura);
    const cerraron = filas.filter((f) => f.aura != null);

    if (cerraron.length < 2) {
      el.rTape.textContent = 'SIN RIVAL';
      el.rSub.textContent = 'Nadie más terminó la ronda. Tu aura cuenta igual.';
    } else if (cerraron.length === 2) {
      const otro = cerraron.find((f) => !f.yo);
      const gane = aura > otro.aura;
      const empate = aura === otro.aura;
      el.rTape.textContent = empate ? 'EMPATE' : (gane ? 'GANASTE' : 'PERDISTE');
      el.rTape.classList.toggle('alert', !gane && !empate);
      el.rSub.textContent = `${empate ? 'Empate' : (gane ? 'Le ganaste' : 'Te ganó')} por `
        + `${Math.abs(aura - otro.aura).toLocaleString('es-GT')} de aura.`;
    } else {
      const puesto = filas.findIndex((f) => f.yo) + 1;
      el.rTape.textContent = puesto === 1 ? 'GANASTE' : `${puesto}º DE ${cerraron.length}`;
      el.rTape.classList.toggle('alert', puesto > 1);
      el.rSub.textContent = puesto === 1
        ? `Nadie de los ${cerraron.length} te alcanzó.`
        : `Quedaste ${puesto}º entre ${cerraron.length}.`;
    }
    // El 1v1 al azar no es una ronda suelta: es un duelo al mejor de tres.
    if (tipoSala === 'azar') puntuarDuelo(aura, cerraron);
    else el.rMarcador.classList.add('hidden');
    // La sala NO se cierra: se sigue viendo a todos y se puede jugar otra
    // ronda sin volver a negociar nada.
  } else {
    el.rSala.classList.add('hidden');
    el.rMarcador.classList.add('hidden');
  }

  // A donde se puede ir desde el resultado. "OTRA VEZ" siempre es solo; los
  // otros dos aparecen segun de donde venga la partida.
  const enSala = modo === 'versus' && !!batalla?.vivo;
  el.nextRival.classList.toggle('hidden', !(enSala && tipoSala === 'azar'));
  el.backSala.classList.toggle('hidden', !(enSala && tipoSala === 'privada'));
  el.again.textContent = enSala ? 'JUGAR SOLO' : 'OTRA VEZ';

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
let tipoSala = 'privada';     // 'azar' (1v1 de la cola) | 'privada' (hasta 6 por codigo)
let batalla = null;
let participantes = [];       // ids que estaban cuando arranco la ronda
let micTrack = null;          // track del microfono, si alguna vez lo dieron
let micOn = false;
let arranqueAzar = 0;         // timeout del arranque automatico del 1v1
let proximaRonda = 0;         // timeout de la ronda siguiente del duelo
const tiles = new Map();      // id -> {caja, video, nombre, aura}

// El duelo al azar es al mejor de tres: el primero que gana DOS se lo lleva y
// no se juega la tercera. Cada lado saca la cuenta por su cuenta con los
// mismos dos numeros (mi aura y la suya), asi que no hace falta ningun mensaje
// de marcador que pueda desincronizarse.
const RONDAS = 3;
const META = 2;
let marcador = { yo: 0, rival: 0 };
let rondaN = 1;
let dueloArrancado = false;

/** Lo que ven los demas: la camara, y el micro si lo prendieron. */
function armarSalida() {
  const tks = [...(stream?.getVideoTracks?.() ?? [])];
  if (micTrack) tks.push(micTrack);
  return new MediaStream(tks);
}

function crearTile(id) {
  const caja = document.createElement('div');
  caja.className = 'tile';
  const video = document.createElement('video');
  video.playsInline = true;
  video.autoplay = true;
  // NO lleva `muted`: la gracia es escuchar al otro. Si el navegador bloquea
  // el autoplay con sonido, `sonar()` lo reintenta al primer toque.
  const nombre = document.createElement('span');
  nombre.className = 'tile-nombre';
  const aura = document.createElement('span');
  aura.className = 'tile-aura';
  caja.append(video, nombre, aura);
  // Mi recuadro es el primero del DOM, asi que los demas caen despues: en una
  // grilla de dos eso me deja a la izquierda, que es como uno se espera verse.
  el.tiles.appendChild(caja);
  const t = { caja, video, nombre, aura };
  tiles.set(id, t);
  return t;
}

function quitarTile(id) {
  const t = tiles.get(id);
  if (!t) return;
  t.video.srcObject = null;
  t.caja.remove();
  tiles.delete(id);
}

/**
 * El autoplay con sonido lo permite el navegador despues de un gesto, y a una
 * sala se entra siempre tocando algo. Si igual lo bloquea, se reintenta con
 * el primer toque que venga: mejor eso que un rival mudo para siempre.
 */
function sonar(video) {
  video.play?.().catch(() => {
    document.addEventListener('pointerdown', () => { video.play?.().catch(() => { /* ya fue */ }); }, { once: true });
  });
}

/** Sincroniza los recuadros con quien esta en la sala. */
function pintarSala() {
  const enSala = modo === 'versus' && !!batalla;
  el.miNombre.textContent = getAlias() || 'VOS';
  el.tileYo.classList.toggle('mudo', enSala && !micOn);

  if (!enSala) {
    for (const id of [...tiles.keys()]) quitarTile(id);
    el.miAura.textContent = '';
    actualizarBarra();
    acomodarTiles();
    return;
  }

  const gente = batalla.lista();
  const vistos = new Set();
  for (const par of gente) {
    vistos.add(par.id);
    const t = tiles.get(par.id) || crearTile(par.id);
    t.nombre.textContent = par.alias || 'INVITADO';
    t.caja.classList.toggle('mudo', !par.micro);
  }
  for (const id of [...tiles.keys()]) if (!vistos.has(id)) quitarTile(id);

  actualizarBarra();
  acomodarTiles();
}

function actualizarBarra() {
  const enSala = modo === 'versus' && !!batalla;
  // Con un panel opaco arriba la barra no se ve pero igual se comeria los
  // toques. La cuenta regresiva no cuenta: es transparente a proposito.
  const tapada = panelesArriba.some((k) => k !== 'count');
  el.barra.classList.toggle('hidden', !enSala || tapada);
  if (enSala) {
    const n = batalla.cuantos();
    el.barraCodigo.textContent = tipoSala === 'azar' ? `AL AZAR ${n}/2` : `${batalla.codigo} ${n}/${batalla.max}`;
    el.btnSiguiente.classList.toggle('hidden', tipoSala !== 'azar');
    el.btnMic.textContent = micOn ? 'MIC ON' : 'MIC OFF';
    el.btnMic.classList.toggle('on', micOn);
  }
  // El lobby se apoya sobre la barra, y la barra puede ocupar dos renglones
  // en un telefono angosto: se mide, no se adivina.
  const alto = el.barra.classList.contains('hidden') ? 0 : el.barra.offsetHeight;
  document.documentElement.style.setProperty('--barra-h', `${alto}px`);
  actualizarLobby(tapada);
}

/**
 * El lobby de espera.
 *
 * Va FLOTANDO sobre la grilla y no como panel a pantalla completa: la gracia
 * de una sala es ver quién va cayendo mientras esperás, y un panel opaco
 * encima convierte eso en una pantalla de carga.
 */
function actualizarLobby(tapada = false) {
  const enSala = modo === 'versus' && !!batalla;
  const jugando = state === 'running' || state === 'countdown';
  const visible = enSala && !jugando && !tapada;
  el.lobby.classList.toggle('hidden', !visible);
  if (!visible) return;

  const gente = batalla.lista();
  const n = gente.length + 1;
  const anfitrion = batalla.soyAnfitrion();
  const nombres = [getAlias() || 'VOS', ...gente.map((p) => p.alias || 'INVITADO')];

  if (tipoSala === 'azar') {
    el.lobbyCodigo.textContent = n < 2 ? 'BUSCANDO' : `${marcador.yo} - ${marcador.rival}`;
    el.lobbyQuienes.textContent = n < 2 ? 'Esperando rival…' : `RONDA ${rondaN} DE ${RONDAS}`;
    el.lobbyEmpezar.classList.add('hidden');
    el.lobbyFine.textContent = n < 2 ? '' : 'Arranca solo.';
    return;
  }

  el.lobbyCodigo.textContent = batalla.codigo || '····';
  // Texto, nunca HTML: los alias los escribieron otras personas.
  el.lobbyQuienes.textContent = `${n}/${batalla.max} · ${nombres.join(' · ')}`;
  el.lobbyEmpezar.classList.toggle('hidden', !anfitrion);
  el.lobbyEmpezar.disabled = n < 2;
  el.lobbyEmpezar.textContent = n < 2 ? 'FALTA GENTE' : 'EMPEZAR BATALLA';
  // Si no soy el anfitrión, lo es el id más chico, y `lista()` viene ordenada.
  el.lobbyFine.textContent = anfitrion
    ? (n < 2 ? 'Pasale el código a quien quieras retar.' : 'Cuando quieras.')
    : `Esperando a que ${gente[0]?.alias || 'el anfitrión'} empiece…`;
}

/**
 * Prende y apaga el microfono.
 *
 * El permiso se pide RECIEN al tocar el boton y no al entrar a la sala: la
 * mayoria entra a jugar, no a hablar, y una negativa deja el micro bloqueado
 * para siempre en ese sitio. Como el hueco del audio ya viene negociado desde
 * que se armo la conexion, poner el track despues no renegocia nada.
 */
async function alternarMicro() {
  if (!batalla) return;
  if (!micTrack) {
    try {
      const a = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      micTrack = a.getAudioTracks()[0] || null;
    } catch {
      el.btnMic.disabled = true;
      el.btnMic.textContent = 'SIN MIC';
      return;
    }
    if (!micTrack) return;
    await batalla.ponerMicro(micTrack);
  }
  micOn = !micOn;
  micTrack.enabled = micOn;
  batalla.avisarMicro(micOn);
  pintarSala();
}

/** Espera el `fin` de todos los que arrancaron la ronda, o se cansa. */
async function esperarFines(ms) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const faltan = batalla?.lista().filter((p) => participantes.includes(p.id) && !p.fin) ?? [];
    if (!faltan.length) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Tabla de la ronda. Devuelve las filas ya ordenadas, para el veredicto. */
function pintarResultadoSala(miAura) {
  const gente = batalla?.lista().filter((p) => participantes.includes(p.id)) ?? [];
  el.rSala.replaceChildren();
  el.rSala.classList.toggle('hidden', !gente.length);

  const filas = [
    { alias: getAlias() || 'VOS', aura: miAura, yo: true },
    ...gente.map((p) => ({ alias: p.alias || 'INVITADO', aura: p.fin ? p.fin.aura : null, yo: false })),
  ];
  // Los que no cerraron van al fondo: se fueron, o entraron a mitad de ronda.
  filas.sort((a, b) => (b.aura ?? -1) - (a.aura ?? -1));
  if (!gente.length) return filas;

  filas.forEach((f, i) => {
    const li = document.createElement('li');
    if (f.yo) li.classList.add('yo');
    if (i === 0 && f.aura != null) li.classList.add('podio');
    const pos = document.createElement('span');
    pos.className = 'pos';
    pos.textContent = f.aura == null ? '·' : `${i + 1}º`;
    // El nombre lo escribio otra persona: va como TEXTO, nunca como HTML.
    const quien = document.createElement('span');
    quien.className = 'quien';
    quien.textContent = f.alias;
    const cuanto = document.createElement('span');
    cuanto.className = 'cuanto';
    cuanto.textContent = f.aura == null ? '—' : Number(f.aura).toLocaleString('es-GT');
    li.append(pos, quien, cuanto);
    el.rSala.appendChild(li);
  });
  return filas;
}

function empezarRonda() {
  clearTimeout(arranqueAzar);
  clearTimeout(proximaRonda);
  arranqueAzar = proximaRonda = 0;
  dueloArrancado = true;
  participantes = batalla ? batalla.lista().map((p) => p.id) : [];
  batalla?.limpiarRonda();
  el.miAura.textContent = '';
  countdown();
}

/** Marcador del duelo al mejor de tres. Solo corre en la cola al azar. */
function puntuarDuelo(miAura, cerraron) {
  const otro = cerraron.find((f) => !f.yo);
  if (otro) {
    if (miAura > otro.aura) marcador.yo++;
    else if (otro.aura > miAura) marcador.rival++;   // el empate no da punto
  }
  const gane = marcador.yo >= META;
  const perdi = marcador.rival >= META;
  // Se cierra por llegar a dos o por quedarse sin rondas. Que el rival se
  // haya ido tambien cierra: no hay contra quien seguir.
  const ultima = gane || perdi || rondaN >= RONDAS || !otro;

  el.rMarcador.classList.remove('hidden');
  el.rMarcador.textContent = `RONDA ${rondaN}/${RONDAS}  ·  VOS ${marcador.yo} — ${marcador.rival} RIVAL`;

  if (!ultima) {
    rondaN++;
    el.rSub.textContent += `  Va la ronda ${rondaN}…`;
    // La orden la da el anfitrión para que los dos arranquen juntos; el otro
    // solo espera el `arranca`. Los 5 segundos son para poder leer el
    // resultado sin que se lo lleve por delante la cuenta regresiva.
    if (batalla?.soyAnfitrion()) {
      proximaRonda = setTimeout(() => {
        proximaRonda = 0;
        // El rival pudo haberse ido en estos cinco segundos: jugar una ronda
        // contra nadie no le sirve a nadie.
        if (batalla?.cuantos() >= 2 && batalla.arrancar()) empezarRonda();
      }, 5000);
    }
    return;
  }

  el.rTape.textContent = gane ? 'GANÁS EL DUELO'
    : perdi ? 'PERDÉS EL DUELO'
      : marcador.yo > marcador.rival ? 'GANÁS EL DUELO'
        : marcador.yo < marcador.rival ? 'PERDÉS EL DUELO' : 'DUELO EMPATADO';
  el.rTape.classList.toggle('alert', marcador.yo < marcador.rival);
  if (!otro && rondaN < RONDAS) el.rSub.textContent = 'El rival se fue. El duelo queda acá.';
}

/**
 * El 1v1 al azar arranca solo; la sala privada no.
 *
 * Con seis personas, arrancar apenas entra la segunda le cortaria la ronda a
 * los que todavia estan llegando. Ahi la orden la da el anfitrion con el
 * boton, que es lo que hace cualquier juego con lobby.
 */
function tantearArranque() {
  clearTimeout(arranqueAzar);
  arranqueAzar = 0;
  if (tipoSala !== 'azar' || !batalla?.soyAnfitrion()) return;
  if (batalla.cuantos() !== 2 || state !== 'idle') return;
  // Solo la PRIMERA ronda del duelo arranca sola. Sin esto, cualquier cosa que
  // mueva la lista de gente —alguien prendiendo el micro, sin ir mas lejos—
  // largaba una ronda encima del resultado que estabas leyendo.
  if (dueloArrancado) return;
  // El margen es para que el video alcance a negociar; si no llega, la
  // partida arranca igual y se juega a ciegas.
  arranqueAzar = setTimeout(() => {
    arranqueAzar = 0;
    if (batalla?.arrancar()) empezarRonda();
  }, 1600);
}

function salirDeSala({ apagarCamara = false } = {}) {
  clearTimeout(arranqueAzar);
  clearTimeout(proximaRonda);
  arranqueAzar = proximaRonda = 0;
  dueloArrancado = false;
  batalla?.cerrar();
  batalla = null;
  modo = 'solo';
  participantes = [];
  // El microfono se SUELTA al salir. Dejar el track vivo mantiene prendida la
  // lucecita del sistema, y nadie quiere seguir "al aire" despues de salir.
  micTrack?.stop();
  micTrack = null;
  micOn = false;
  el.btnMic.disabled = false;

  // Irse de la sala CORTA la ronda que hubiera en curso. Sin esto, saltar a
  // mitad de partida dejaba `state` en 'running' para siempre: la sala
  // siguiente ya no arrancaba nunca, porque tanto el arranque automatico como
  // la orden del anfitrion solo corren desde 'idle'. Y el grabador seguia
  // capturando el canvas de una ronda que ya no existe.
  if (state !== 'idle') {
    cancelAnimationFrame(raf);
    pararDeteccion();
    recorder?.cancelar();
    state = 'idle';
  }
  if (apagarCamara) {
    cancelAnimationFrame(raf);
    pararDeteccion();
    stream?.getTracks().forEach((t) => t.stop());
  }
  pintarSala();
}

/**
 * Entra a una sala. La camara y el modelo se cargan ANTES de conectarse:
 * pedir permiso de camara con un rival ya esperando del otro lado es la
 * forma mas facil de que el otro se vaya.
 */
async function entrarASala(codigo, tipo = 'privada') {
  modo = 'versus';
  tipoSala = tipo;
  marcador = { yo: 0, rival: 0 };
  rondaN = 1;
  dueloArrancado = false;
  if (!await boot(false)) { modo = 'solo'; actualizarBarra(); return; }

  batalla = new Batalla({
    onGente: () => { pintarSala(); tantearArranque(); },
    onVideo: (id, s) => {
      const t = tiles.get(id) || (s ? crearTile(id) : null);
      if (!t) return;
      if (t.video.srcObject !== s) t.video.srcObject = s;
      if (s) sonar(t.video);
      pintarSala();
    },
    onAura: (id, v) => {
      const t = tiles.get(id);
      if (t) t.aura.textContent = Number(v).toLocaleString('es-GT');
    },
    onArranca: () => { if (state === 'idle') empezarRonda(); },
    onEstado: (e) => {
      if (e === 'llena') {
        el.vsMsg.textContent = 'Esa sala ya está llena. Probá con otro código.';
        salirDeSala({ apagarCamara: true });
        el.go.disabled = false;
        show('versus');
        return;
      }
      // A mitad de ronda NO se corta nada: se termina de jugar y el aura
      // cuenta igual. Cortarla porque se cayo un socket seria castigar al
      // que se quedo.
      if (state === 'running' || state === 'countdown') return;
      el.vsMsg.textContent = 'Se cortó la conexión con la sala.';
      salirDeSala({ apagarCamara: true });
      el.go.disabled = false;
      show('versus');
    },
  });
  batalla.entrar(codigo, {
    salida: armarSalida(),
    alias: getAlias(),
    max: tipo === 'azar' ? 2 : TOPE_SALA,
  });

  show();               // sin paneles: se ve la sala
  pintarSala();
  arrancarLoop();       // verse la cara mientras se espera, como en una call
}

async function buscarYEntrar() {
  el.vsBuscar.disabled = true;
  el.vsMsg.textContent = 'Buscando rival…';
  try {
    // La cola solo reparte el codigo; despues los dos entran a la misma sala
    // por el mismo camino que los amigos, con cupo de dos. Una sola
    // implementacion de sala en vez de dos que hay que mantener sincronizadas.
    const codigo = await new Batalla().buscarRival();
    await entrarASala(codigo, 'azar');
  } catch (e) {
    el.vsMsg.textContent = `${e.message}. Probá de nuevo o armá una sala con código.`;
    show('versus');
  } finally {
    el.vsBuscar.disabled = false;
  }
}

/** Estilo Omegle: cortar con este y buscar otro sin pasar por el menu. */
async function siguienteRival() {
  // La camara queda prendida a proposito: se reusa para la sala siguiente y
  // el corte se siente instantaneo en vez de meter otro "pidiendo cámara".
  salirDeSala();
  show('versus');
  await buscarYEntrar();
}

el.irVersus?.addEventListener('click', () => {
  startPrefetch();
  el.vsMsg.textContent = '';
  el.vsCodigo.value = '';
  show('versus');
});
el.vsVolver?.addEventListener('click', () => {
  salirDeSala({ apagarCamara: true });
  el.go.disabled = false;
  show('intro');
});
el.vsCrear?.addEventListener('click', () => entrarASala(codigoNuevo(), 'privada'));
el.vsEntrar?.addEventListener('click', () => {
  const c = el.vsCodigo.value.trim().toUpperCase();
  if (!codigoValido(c)) { el.vsMsg.textContent = 'El código son 4 letras o números.'; return; }
  entrarASala(c, 'privada');
});
el.vsBuscar?.addEventListener('click', buscarYEntrar);

// --- barra de la sala ---
el.btnSalir?.addEventListener('click', () => {
  salirDeSala({ apagarCamara: true });
  el.go.disabled = false;
  show('versus');
});
el.btnSiguiente?.addEventListener('click', siguienteRival);
el.btnMic?.addEventListener('click', alternarMicro);
el.lobbyEmpezar?.addEventListener('click', () => { if (batalla?.arrancar()) empezarRonda(); });

function copiarCodigo(boton) {
  if (!batalla?.codigo || tipoSala !== 'privada') return;
  navigator.clipboard?.writeText(batalla.codigo)
    .then(() => {
      const antes = boton.textContent;
      boton.textContent = 'COPIADO';
      setTimeout(() => { boton.textContent = antes; actualizarBarra(); }, 1200);
    })
    .catch(() => { /* sin portapapeles: el codigo igual se ve */ });
}
el.barraCodigo?.addEventListener('click', () => copiarCodigo(el.barraCodigo));
el.lobbyCodigo?.addEventListener('click', () => copiarCodigo(el.lobbyCodigo));

// --- salidas del resultado ---
el.nextRival?.addEventListener('click', siguienteRival);
el.backSala?.addEventListener('click', () => {
  if (!batalla?.vivo) { show('versus'); return; }
  batalla.limpiarRonda();
  show();
  pintarSala();
  arrancarLoop();
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
  // "OTRA VEZ" es siempre en solitario: si venias de una sala, se sale.
  salirDeSala();
  show('loading');
  if (!await asegurarCamara()) return;
  bombearDeteccion();
  acomodarTiles();
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
