import './style.css';
import { createPose, createPoseWorker, openCamera, assignSlots, prefetchAssets, ajustesCamara } from './pose.js';
import { Player } from './scoring.js';
import { Renderer, P_COLOR, GOLD, BONE } from './render.js';
import { Recorder } from './record.js';
import { Mosaico, debeContener } from './mosaico.js';
import { detectDap, DAP, brazosCortados } from './moves.js';
import { toMetric } from './landmarks.js';
import { verdictFor } from './roasts.js';
import { hayApi, getAlias, setAlias, aliasValido, enviarPuntaje, traerRanking, nombrePais } from './ranking.js';
import { Batalla, hayVersus, codigoNuevo, codigoValido, TOPE_SALA, CANCELADO } from './versus.js';
import { hit, contarVisita, online as pedirOnline } from './analitica.js';
import {
  hayTorneos, codigoTorneoValido, crearTorneo, verTorneo, subirPuntajeTorneo,
  subirClip, cerrarTorneo, urlClip, linkTorneo, linkOrganizador, torneoDeLaUrl,
  cuantoFalta, getUltimo, setUltimo, guardarClave, soyOrganizador,
} from './torneo.js';
import { compartir, mensajeDe, hayCompartirNativo } from './compartir.js';
import { bajarClips, soltarClips, armarRecopilatorio, duracionEstimada } from './reel.js';

const ROUND_SECONDS = 15;
const DEBUG = new URLSearchParams(location.search).has('debug');
const fpsHist = [];

const $ = (id) => document.getElementById(id);
const el = {
  video: $('cam'), canvas: $('view'),
  intro: $('intro'), loading: $('loading'), count: $('count'), result: $('result'), oops: $('oops'),
  rank: $('rank'), buscando: $('buscando'),
  irAzar: $('irAzar'), irCrear: $('irCrear'), filaCodigo: $('filaCodigo'),
  vsCodigo: $('vsCodigo'), vsEntrar: $('vsEntrar'), introMsg: $('introMsg'),
  buscMsg: $('buscMsg'), buscOnline: $('buscOnline'), buscCancelar: $('buscCancelar'),
  tiles: $('tiles'), tileYo: $('tileYo'), miNombre: $('miNombre'), miAura: $('miAura'),
  barra: $('barra'), barraCodigo: $('barraCodigo'), btnMic: $('btnMic'),
  btnSiguiente: $('btnSiguiente'), btnSalir: $('btnSalir'),
  lobby: $('lobby'), lobbyCodigo: $('lobbyCodigo'), lobbyQuienes: $('lobbyQuienes'),
  lobbyEmpezar: $('lobbyEmpezar'), lobbyFine: $('lobbyFine'),
  go: $('go'), share: $('share'), again: $('again'), retry: $('retry'),
  backMenu: $('backMenu'), rSala: $('rSala'), rMarcador: $('rMarcador'),
  countnum: $('countnum'), loadmsg: $('loadmsg'), oopsmsg: $('oopsmsg'),
  rScore: $('rScore'), rTitle: $('rTitle'), rSub: $('rSub'), rStats: $('rStats'), rNote: $('rNote'),
  rTape: $('rTape'), rClips: $('rClips'), rClipsFila: $('rClipsFila'),
  verRank: $('verRank'), altaMsg: $('altaMsg'), rPuesto: $('rPuesto'),
  nombre: $('nombre'), nomInput: $('nomInput'), nomOk: $('nomOk'), nomMsg: $('nomMsg'), soy: $('soy'),
  online: $('online'),
  tabAmbito: $('tabAmbito'), tabPeriodo: $('tabPeriodo'),
  rankDonde: $('rankDonde'), tabla: $('tabla'), rankYo: $('rankYo'), rankVolver: $('rankVolver'),

  // torneos de comunidad
  crearMenu: $('crearMenu'), crearSala: $('crearSala'), crearTorneo: $('crearTorneo'),
  irUltimoTorneo: $('irUltimoTorneo'),
  nuevo: $('nuevo'), ntNombre: $('ntNombre'), ntQuien: $('ntQuien'), ntDias: $('ntDias'),
  ntClips: $('ntClips'), ntClipsFila: $('ntClipsFila'), ntCrear: $('ntCrear'),
  ntMsg: $('ntMsg'), ntVolver: $('ntVolver'),
  torneo: $('torneo'), tTape: $('tTape'), tNombre: $('tNombre'), tSub: $('tSub'),
  tCodigo: $('tCodigo'), tCodMsg: $('tCodMsg'), tTabla: $('tTabla'), tYo: $('tYo'),
  tQuienSoy: $('tQuienSoy'),
  tFarmear: $('tFarmear'), tRecop: $('tRecop'), tCompartir: $('tCompartir'),
  tOrg: $('tOrg'), tLinkOrg: $('tLinkOrg'), tCerrar: $('tCerrar'), tOrgMsg: $('tOrgMsg'),
  tVolver: $('tVolver'),
  recop: $('recop'), recTitulo: $('recTitulo'), recCaja: $('recCaja'), recVideo: $('recVideo'),
  recPlaca: $('recPlaca'), recMsg: $('recMsg'), recProgCaja: $('recProgCaja'), recProg: $('recProg'),
  recGenerar: $('recGenerar'), recBajar: $('recBajar'), recVolver: $('recVolver'),
  rTorneo: $('rTorneo'), compartir: $('compartir'), shIg: $('shIg'), shTt: $('shTt'),
};

const PANELES = ['nombre', 'intro', 'loading', 'count', 'result', 'oops', 'rank', 'buscando',
  'nuevo', 'torneo', 'recop'];
let panelesArriba = [];
const show = (...ids) => {
  panelesArriba = ids;
  for (const k of PANELES) el[k].classList.toggle('hidden', !ids.includes(k));
  // Volver al menu es cuando mas importa el numero de gente en la cola: puede
  // haber entrado alguien mientras jugabas.
  // El submenu de CREAR se cierra al pasar por la portada: dejarlo abierto de
  // la vez pasada hace que la pantalla arranque distinta cada vez.
  if (ids.includes('intro')) { refrescarOnline(); el.crearMenu?.classList.add('hidden'); }
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

// Un recuadro no puede ser una franja. Con cuatro personas en una pantalla
// ancha la grilla salía de 2 columnas y cada celda quedaba de 946x431 —2.2:1—,
// y ahí adentro un teléfono vertical no se ve: se ve una franja del 25% de su
// cuadro. Limitar la proporción deja aire a los costados en vez de recortar
// gente.
const AR_MAX = 16 / 9;

/**
 * Recortar o no el video de un recuadro. El criterio está en mosaico.js
 * (`debeContener`), compartido con el clip; acá solo se miden las cajas.
 *
 * Esto es lo que arregla al que jugaba desde el teléfono mientras el resto
 * estaba en computadora: su cámara vertical dentro de una celda apaisada se
 * veía como una franja del techo de su cuarto, con él entero afuera.
 */
function ajustarEncaje(t) {
  const v = t.video;
  const vw = v.videoWidth, vh = v.videoHeight;
  const r = t.caja.getBoundingClientRect();
  if (!vw || !vh || !r.width || !r.height) return;
  v.classList.toggle('contener', debeContener(vw / vh, r.width / r.height));
}

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
  let { w, h } = mejor;
  // Solo dentro de una sala: jugando solo el recuadro ES la pantalla y el
  // canvas ya se acomoda adentro con fitCanvasCss().
  if (enSala) {
    if (w / h > AR_MAX) w = h * AR_MAX;
    else if (h / w > AR_MAX) h = w * AR_MAX;
  }
  el.tiles.style.setProperty('--tw', `${Math.floor(w)}px`);
  el.tiles.style.setProperty('--th', `${Math.floor(h)}px`);

  // Cambió el tamaño de las celdas: puede haber cambiado a quién conviene
  // recortar y a quién no.
  for (const t of tiles.values()) ajustarEncaje(t);

  // Mientras se graba NO se toca el tamaño REAL del canvas: cambiarlo a mitad
  // de grabacion rompe el encoder. Se reacomoda solo el CSS, que es gratis.
  if (state === 'running' || state === 'countdown') fitCanvasCss();
  else if (sizeCanvas() && renderer) renderer = new Renderer(el.canvas);
}

sizeCanvas();
addEventListener('resize', acomodarTiles);

// ---------- estado ----------
let pose = null, poseWorker = null, stream = null, renderer = null, recorder = null;
let mosaico = null;           // lienzo del clip de la sala (todas las camaras)
let clipGrupo = false;        // esta ronda se graba la sala entera, no solo yo
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
  // Con todo ya cargado no se pasa por la pantalla de carga. Al saltar de un
  // rival al siguiente eso era un parpadeo de "PIDIENDO CÁMARA" sobre una
  // camara que nunca se apago: mas alarmante que informativo.
  const camaraViva = stream?.getVideoTracks?.().some((t) => t.readyState === 'live');
  if (!camaraViva || (!poseWorker && !pose)) show('loading');
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

// ---------- la repeticion de la sala ----------
//
// El clip de una batalla de grupo tiene que tener a TODOS: un recuadro con uno
// solo no es la repeticion de nada. Se graba un lienzo aparte (ver mosaico.js)
// que copia mi canvas mas los <video> de los demas, con el audio de la sala
// mezclado encima.
//
// SOLO EN SALAS POR CODIGO. En la cola al azar el de enfrente es un
// desconocido, y su cara no tiene por que terminar en la galeria de nadie:
// ahi el clip sigue siendo solo mi recuadro, como siempre.

const FPS_MOSAICO = 30;

function grabarSala() {
  return modo === 'versus' && tipoSala !== 'azar' && !!batalla && tiles.size > 0;
}

/**
 * El lienzo del mosaico, del tamaño que aguante el aparato.
 *
 * Se ata a la misma medicion que decide la resolucion del canvas del juego: un
 * telefono que no llega a 720p dibujando UN recuadro tampoco va a componer
 * cuatro a 1280x720.
 */
function mosaicoVivo() {
  const ancho = escalaCanvas >= 0.75 ? 1280 : 960;
  if (!mosaico || mosaico.canvas.width !== ancho) {
    mosaico = new Mosaico(ancho, Math.round(ancho * 9 / 16 / 2) * 2);
  }
  return mosaico;
}

/** Lo que va en cada celda del mosaico, en el mismo orden que la grilla. */
function fuentesMosaico() {
  const mias = {
    fuente: el.canvas, alias: getAlias() || 'VOS',
    aura: players[0]?.aura ?? 0, yo: true, mudo: !micOn,
  };
  const otras = (batalla?.lista() ?? [])
    .map((par) => ({
      fuente: tiles.get(par.id)?.video || null,
      alias: par.alias || 'INVITADO',
      aura: par.aura || 0,
      yo: false,
      mudo: !par.micro,
    }))
    .filter((f) => f.fuente);
  return [mias, ...otras];
}

/** Mi micro (si esta prendido) mas el de todos los demas. */
function pistasSala() {
  const p = [];
  if (micTrack && micOn) p.push(micTrack);
  for (const par of batalla?.lista() ?? []) {
    for (const t of par.stream?.getAudioTracks?.() ?? []) p.push(t);
  }
  return p;
}

function countdown() {
  // Jugando solo, cada ronda es su propia partida: sin esto, la mejor ronda
  // de la partida ANTERIOR seguia mandando y una ronda floja mostraba el
  // resultado de la anterior.
  if (modo !== 'versus') reiniciarDuelo();
  // Se cuenta ACA y no al tocar el boton: entre el boton y la cuenta hay un
  // permiso de camara y 8MB de modelo, y la mitad de la gente se cae ahi. Lo
  // que interesa medir es cuantos llegaron a escanear DE VERDAD.
  hit('escaneo');
  players = [new Player(0), new Player(1)];
  roundLeft = ROUND_SECONDS;
  stressFps = [];
  trabajoRonda.length = 0;
  ultimaDeteccion = 0;
  dapCool = 0;
  state = 'countdown';
  // Se decide ANTES del ensayo: grabar el mosaico cuesta distinto que grabar
  // mi recuadro (son tres copias de video mas por cuadro), y la prueba de
  // esfuerzo tiene que medir lo que de verdad se va a hacer.
  clipGrupo = grabarSala();
  arrancarLoop();

  // Ensayo: se graba en falso durante la cuenta y se tira. Sin esto la
  // prueba de esfuerzo medía un frame SIN capturar el canvas, que es
  // justamente lo que se pone caro al grabar.
  const ensayo = new Recorder(clipGrupo ? mosaicoVivo().canvas : el.canvas);
  ensayo.start(clipGrupo ? FPS_MOSAICO : 60);

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
      // El mosaico se dibuja acelerado a 30: capturarlo a 60 le pide al
      // compositor el doble de muestreos de un lienzo que no cambia tan
      // rapido, y el video que llega de los demas viene a 15-24fps igual.
      if (clipGrupo) fpsGrabacion = FPS_MOSAICO;
      state = 'running';
      framesRonda = 0;
      deteccionesRonda = 0;
      inicioRonda = performance.now();
      // El grabador se rehace acá y no en boot(): recién ahora se sabe qué
      // lienzo hay que grabar (el mío o el de la sala) y con qué resolución.
      recorder = new Recorder(clipGrupo ? mosaicoVivo().canvas : el.canvas);
      recorder.start(fpsGrabacion, clipGrupo ? pistasSala() : []);
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

  // El mosaico se arma DESPUES de dibujar mi recuadro: copia el canvas del
  // frame de recién, no el del anterior. Tambien durante la cuenta regresiva,
  // porque ese es el costo que la prueba de esfuerzo tiene que medir.
  if (clipGrupo && (state === 'running' || state === 'countdown')) {
    mosaico?.dibujar(fuentesMosaico(), FPS_MOSAICO);
  }

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

  // TODAS las repeticiones del duelo se guardan, no solo la mejor. Un duelo son
  // tres rondas y la que uno quiere postear no siempre es la que dio más aura:
  // seguido es la que salió más ridícula. Se tiran al empezar un duelo nuevo.
  if (modo === 'versus' && blob) {
    clipsDuelo.push({ ronda: rondaN, aura, blob, sala: clipGrupo });
    while (clipsDuelo.length > RONDAS) clipsDuelo.shift();
  }

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
    // Una ronda NO es la partida: la partida son tres.
    dueloCerrado = puntuarRonda(filas);
    el.rMarcador.classList.remove('hidden');
    if (!dueloCerrado) {
      el.rMarcador.textContent = `RONDA ${rondaN}/${RONDAS}  ·  ${marcadorTexto(filas)}`;
      programarSiguienteRonda();
      el.rSub.textContent += `  Va la ronda ${rondaN} de ${RONDAS}…`;
    } else {
      const orden = pintarTablaDuelo(filas);
      el.rMarcador.textContent = `DUELO CERRADO  ·  ${marcadorTexto(filas)}`;
      const primeros = orden.filter((f) => f.pts === orden[0].pts);
      const gane = orden[0].yo && primeros.length === 1;
      const empate = primeros.length > 1 && primeros.some((f) => f.yo);
      el.rTape.textContent = gane ? 'GANÁS EL DUELO' : (empate ? 'DUELO EMPATADO' : 'PERDÉS EL DUELO');
      el.rTape.classList.toggle('alert', !gane && !empate);
    }
    // La sala NO se cierra: se sigue viendo a todos y se puede jugar otro
    // duelo sin volver a negociar nada.
  } else {
    dueloCerrado = true;          // en solo, la ronda ES la partida
    el.rSala.classList.add('hidden');
    el.rMarcador.classList.add('hidden');
  }

  // Mi mejor ronda del duelo es la que vale: es la que se sube al torneo y la
  // del clip. Guardar la ULTIMA en vez de la mejor hacia que una tercera
  // ronda floja te borrara la primera, que era la buena.
  if (!mejorRonda || aura > mejorRonda.aura) {
    mejorRonda = {
      aura, moves: landed, blob, titulo: v.t,
      sub: el.rSub.textContent, stats: el.rStats.innerHTML, sala: clipGrupo,
    };
  }

  // ENTRE RONDAS NO SE CIERRA NADA. Ni torneo, ni clip, ni botones: eso es el
  // final de una partida y la partida sigue. Lo unico que se ve es como quedo
  // la ronda y que viene la siguiente.
  el.compartir.classList.toggle('hidden', !dueloCerrado);
  // Los dos puestos arrancan ocultos en cada ronda: son de la partida que se
  // acaba de cerrar y los escribe quien los sube, no esta funcion.
  el.rPuesto.classList.add('hidden');
  el.rTorneo.classList.add('hidden');
  el.again.classList.toggle('hidden', !dueloCerrado);
  el.backMenu.classList.toggle('hidden', !dueloCerrado);
  el.altaMsg.textContent = '';
  el.rNote.textContent = '';

  if (dueloCerrado) {
    // El resultado que se muestra al cerrar es el de la mejor ronda, para que
    // el numero grande, el clip y lo que se sube al torneo sean lo mismo.
    if (rondaN > 1 || mejorRonda.aura !== aura) {
      el.rScore.textContent = mejorRonda.aura.toLocaleString('es-GT');
      el.rTitle.textContent = mejorRonda.titulo;
      el.rStats.innerHTML = mejorRonda.stats;
      blob = mejorRonda.blob;
    }
    // Lo que se sube al torneo. Se congela aca y no se recalcula despues:
    // `players` se reinicia en "otra vez" y el alias se puede escribir en
    // cualquier momento, incluso con otra ronda ya empezando.
    ultimaPartida = { aura: mejorRonda.aura, moves: mejorRonda.moves };
    el.again.textContent = modo === 'versus' && batalla?.vivo
      ? (tipoSala === 'azar' ? 'OTRO RIVAL' : 'OTRA VEZ')
      : 'OTRA VEZ';

    if (blob) {
      // El tercer boton dice COMPARTIR o GUARDAR segun lo que vaya a pasar de
      // verdad: en el telefono abre la hoja del sistema, en la computadora baja
      // el archivo. Los de Instagram y TikTok no cambian de texto porque ahi lo
      // que se promete es el destino, no el mecanismo.
      el.share.textContent = hayCompartirNativo(blob) ? 'COMPARTIR' : 'GUARDAR';
    } else {
      el.compartir.classList.add('hidden');
      el.rNote.textContent = 'Tu navegador no permite grabar. El escáner sí funcionó.';
    }

    // Todo se anota SOLO. El nombre se pidió al entrar a la app, así que acá
    // no hay nada que tocar: el ranking global siempre, y encima el torneo del
    // streamer si venías de uno. Van en ese orden y no en paralelo para que
    // las dos líneas de puesto no se escriban peleándose la pantalla.
    anotarEnRanking().then(() => { if (torneoActivo) anotarEnTorneo(); });
  }
  pintarClips();
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
const buscador = new Batalla();   // solo para la cola; la sala usa `batalla`
const tiles = new Map();      // id -> {caja, video, nombre, aura}

// TODA batalla es un duelo al mejor de tres, sea contra un desconocido o en
// una sala de seis: el que gana DOS se lo lleva y no se juega la tercera.
//
// Cada uno lleva la cuenta por su lado con los mismos numeros —el `fin` de
// cada ronda le llega a todos—, asi que no hay ningun mensaje de marcador que
// se pueda perder o desincronizar.
const RONDAS = 3;
const META = 2;
let rondaN = 1;
let puntos = new Map();       // 'yo' | id de par -> rondas ganadas
let dueloArrancado = false;
let dueloCerrado = false;
let mejorRonda = null;        // mi mejor ronda del duelo: es la que cuenta al final
const clipsDuelo = [];        // la repeticion de CADA ronda: {ronda, aura, blob, sala}

function reiniciarDuelo() {
  rondaN = 1;
  puntos = new Map();
  dueloCerrado = false;
  mejorRonda = null;
  clipsDuelo.length = 0;
}

/**
 * Los botones para bajarse CADA ronda del duelo.
 *
 * El botón grande sigue bajando la mejor —es la que va al torneo y la que uno
 * postea—, pero la ronda que da más risa no siempre es la que dio más aura, y
 * hasta ahora las otras dos se tiraban a la basura sin preguntar.
 */
function pintarClips() {
  el.rClipsFila.replaceChildren();
  const hay = clipsDuelo.filter((c) => c.blob);
  // Con una sola ronda grabada esto no aporta nada: es el mismo archivo que ya
  // baja el botón grande.
  const visible = dueloCerrado && hay.length > 1;
  el.rClips.classList.toggle('hidden', !visible);
  if (!visible) return;

  for (const c of hay) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = `RONDA ${c.ronda} · ${c.aura.toLocaleString('es-GT')}`;
    b.addEventListener('click', async () => {
      b.disabled = true;
      const r = await shareOrDownload(c.blob, c.aura, c.sala ? 'sala-aura' : 'mi-aura');
      b.disabled = false;
      if (r === 'downloaded') el.rNote.textContent = 'Guardado. Subilo y etiquetame.';
    });
    el.rClipsFila.appendChild(b);
  }
}

/**
 * Lo que ven los demas. Solo video: el audio no va por aca sino por el
 * transceiver que `conectar()` abre siempre, que es lo que permite prender el
 * micro despues sin renegociar.
 */
function armarSalida() {
  return new MediaStream(stream?.getVideoTracks?.() ?? []);
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
  // La proporción del video ajeno no se sabe hasta que llega el primer cuadro,
  // y puede CAMBIAR en el medio: el gobernador de calidad de la malla baja la
  // resolucion cuando entra gente, y un teléfono que se gira manda otra cosa.
  video.addEventListener('loadedmetadata', () => ajustarEncaje(t));
  video.addEventListener('resize', () => ajustarEncaje(t));
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
    el.btnMic.textContent = micTrack ? (micOn ? 'MIC ON' : 'MIC OFF') : 'SIN MIC';
    el.btnMic.classList.toggle('on', micOn);
    el.btnMic.disabled = false;   // sin permiso igual se puede reintentar
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

  const mios = puntos.get('yo') ?? 0;
  if (tipoSala === 'azar') {
    el.lobbyCodigo.textContent = n < 2 ? 'BUSCANDO' : `${rondaN}/${RONDAS}`;
    el.lobbyQuienes.textContent = n < 2 ? 'Esperando rival…' : `DUELO AL MEJOR DE ${RONDAS} · LLEVÁS ${mios}`;
    el.lobbyEmpezar.classList.add('hidden');
    el.lobbyFine.textContent = n < 2 ? '' : 'Arranca solo.';
    return;
  }

  el.lobbyCodigo.textContent = batalla.codigo || '····';
  // Texto, nunca HTML: los alias los escribieron otras personas.
  el.lobbyQuienes.textContent = `${n}/${batalla.max} · ${nombres.join(' · ')}`;
  el.lobbyEmpezar.classList.toggle('hidden', !anfitrion);
  el.lobbyEmpezar.disabled = n < 2;
  el.lobbyEmpezar.textContent = n < 2 ? 'FALTA GENTE' : `EMPEZAR (AL MEJOR DE ${RONDAS})`;
  // Si no soy el anfitrión, lo es el id más chico, y `lista()` viene ordenada.
  el.lobbyFine.textContent = anfitrion
    ? (n < 2 ? 'Pasale el código a quien quieras retar.' : 'Cuando quieras.')
    : `Esperando a que ${gente[0]?.alias || 'el anfitrión'} empiece…`;
}

/**
 * Consigue el microfono. Se pide al ENTRAR a cualquier sala y arranca
 * PRENDIDO.
 *
 * Antes se pedia recien al tocar el boton y arrancaba apagado, y el resultado
 * era el previsible: nadie se acordaba de prenderlo justo cuando ya estaba
 * jugando, asi que las salas eran mudas. Si lo niegan se sigue sin audio —el
 * juego no depende de eso—, pero el botón queda como mute, no como interruptor
 * de encendido.
 */
async function pedirMicro() {
  if (micTrack) return true;
  try {
    const a = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    micTrack = a.getAudioTracks()[0] || null;
  } catch { micTrack = null; }
  micOn = !!micTrack;
  if (micTrack) micTrack.enabled = true;
  return !!micTrack;
}

/** El botón es un MUTE: el micro ya viene pedido desde que entraste. */
async function alternarMicro() {
  if (!batalla) return;
  if (!micTrack) {
    if (!await pedirMicro()) { actualizarBarra(); return; }
    await batalla.ponerMicro(micTrack);
  } else {
    micOn = !micOn;
    micTrack.enabled = micOn;
  }
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
    { clave: 'yo', alias: getAlias() || 'VOS', aura: miAura, yo: true },
    ...gente.map((p) => ({ clave: p.id, alias: p.alias || 'INVITADO', aura: p.fin ? p.fin.aura : null, yo: false })),
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
  // Empezar con el duelo anterior ya cerrado significa que esto es un duelo
  // NUEVO: se borra el marcador viejo antes de la primera ronda.
  if (dueloCerrado) reiniciarDuelo();
  dueloArrancado = true;
  participantes = batalla ? batalla.lista().map((p) => p.id) : [];
  batalla?.limpiarRonda();
  el.miAura.textContent = '';
  countdown();
}

/**
 * Reparte el punto de la ronda y dice si el duelo terminó.
 *
 * El empate arriba no le da el punto a nadie: repartirlo a los dos permitiría
 * que un duelo de tres rondas terminara con los dos en dos.
 */
function puntuarRonda(filas) {
  const cerraron = filas.filter((f) => f.aura != null);
  if (cerraron.length > 1) {
    const tope = Math.max(...cerraron.map((f) => f.aura));
    const arriba = cerraron.filter((f) => f.aura === tope);
    if (arriba.length === 1) puntos.set(arriba[0].clave, (puntos.get(arriba[0].clave) ?? 0) + 1);
  }
  const lider = Math.max(0, ...puntos.values());
  // Con tres rondas, dos victorias ya son inalcanzables. Tambien cierra por
  // quedarse sin rondas o sin rivales: seguir solo no tiene sentido.
  return lider >= META || rondaN >= RONDAS || (batalla?.cuantos() ?? 1) < 2;
}

/**
 * La orden la da el anfitrión para que todos arranquen juntos; los demas solo
 * esperan el `arranca`. Los cinco segundos son para poder leer el resultado
 * sin que se lo lleve por delante la cuenta regresiva de la ronda siguiente.
 */
function programarSiguienteRonda() {
  rondaN++;
  if (!batalla?.soyAnfitrion()) return;
  proximaRonda = setTimeout(() => {
    proximaRonda = 0;
    // Se pudieron haber ido todos en estos cinco segundos: una ronda contra
    // nadie no le sirve a nadie.
    if (batalla?.cuantos() >= 2 && batalla.arrancar()) empezarRonda();
  }, 5000);
}

/** "VOS 1 — 1 RIVAL" en un uno contra uno; con más gente, tus puntos. */
function marcadorTexto(filas) {
  const mios = puntos.get('yo') ?? 0;
  if (filas.length === 2) {
    const otro = filas.find((f) => !f.yo);
    return `VOS ${mios} — ${puntos.get(otro.clave) ?? 0} RIVAL`;
  }
  return `LLEVÁS ${mios} PT${mios === 1 ? '' : 'S'}`;
}

/** Al cerrar el duelo la tabla deja de ser la ronda y pasa a ser el marcador. */
function pintarTablaDuelo(filas) {
  const orden = filas
    .map((f) => ({ ...f, pts: puntos.get(f.clave) ?? 0 }))
    .sort((a, b) => b.pts - a.pts || (b.aura ?? -1) - (a.aura ?? -1));

  el.rSala.replaceChildren();
  el.rSala.classList.remove('hidden');
  orden.forEach((f, i) => {
    const li = document.createElement('li');
    if (f.yo) li.classList.add('yo');
    if (i === 0) li.classList.add('podio');
    const pos = document.createElement('span');
    pos.className = 'pos';
    pos.textContent = `${i + 1}º`;
    // El nombre lo escribió otra persona: va como TEXTO, nunca como HTML.
    const quien = document.createElement('span');
    quien.className = 'quien';
    quien.textContent = f.alias;
    const cuanto = document.createElement('span');
    cuanto.className = 'cuanto';
    cuanto.textContent = `${f.pts} pt${f.pts === 1 ? '' : 's'}`;
    li.append(pos, quien, cuanto);
    el.rSala.appendChild(li);
  });
  return orden;
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
  clipGrupo = false;
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
  // Cortar lo que hubiera antes: una ronda a medias, o una sala vieja. Sin
  // esto, entrar a una sala con una ronda corriendo dejaba las dos cosas
  // vivas: la ronda terminaba sola despues y cerraba SU resultado sobre una
  // sala en la que todavia no se habia jugado nada.
  salirDeSala();
  modo = 'versus';
  tipoSala = tipo;
  reiniciarDuelo();
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
        salirDeSala({ apagarCamara: true });
        alMenu('Esa sala ya está llena. Probá con otro código.');
        return;
      }
      // A mitad de ronda NO se corta nada: se termina de jugar y el aura
      // cuenta igual. Cortarla porque se cayo un socket seria castigar al
      // que se quedo.
      if (state === 'running' || state === 'countdown') return;
      salirDeSala({ apagarCamara: true });
      alMenu('Se cortó la conexión con la sala.');
    },
  });
  // El micro se pide ANTES de conectarse, para que ya viaje en la primera
  // negociación y no haya que tocar nada para que te oigan.
  await pedirMicro();
  batalla.entrar(codigo, {
    salida: armarSalida(),
    alias: getAlias(),
    max: tipo === 'azar' ? 2 : TOPE_SALA,
  });
  batalla.ponerMicro(micTrack);
  batalla.avisarMicro(micOn);
  hit('sala');

  show();               // sin paneles: se ve la sala
  pintarSala();
  arrancarLoop();       // verse la cara mientras se espera, como en una call
}

/**
 * Envoltorio de entrarASala que NO deja fallar en silencio.
 *
 * Es una función async que nadie espera: una excepción adentro se convertía en
 * un rechazo sin dueño y lo único que se veía desde afuera era un botón que no
 * hacía nada. Cualquier cosa que salga mal termina en el menú, escrita.
 */
function entrar(codigo, tipo) {
  return entrarASala(codigo, tipo).catch((e) => {
    console.error('[versus] no se pudo entrar a la sala', e);
    salirDeSala({ apagarCamara: true });
    alMenu('No se pudo entrar a la sala.');
  });
}

/** Vuelve al menú con el motivo escrito, en vez de dejar la pantalla muda. */
function alMenu(motivo = '') {
  el.introMsg.textContent = motivo;
  el.go.disabled = false;
  show('intro');
}

async function buscarYEntrar() {
  // La camara y el modelo se cargan ANTES de entrar a la cola. Pedir permiso
  // de camara con un rival ya esperando del otro lado es la forma mas facil
  // de que el otro se canse y se vaya.
  if (!await boot(false)) return;
  el.buscMsg.textContent = 'Emparejando…';
  show('buscando');
  // A la vista de una: el que entra a la cola es el que más necesita saber si
  // hay alguien del otro lado, y esperar al refresco de medio minuto le deja
  // el spinner sin una sola cifra al lado.
  refrescarOnline(true);
  try {
    // La cola solo reparte el codigo; despues los dos entran a la misma sala
    // por el mismo camino que los amigos, con cupo de dos. Una sola
    // implementacion de sala en vez de dos que hay que mantener sincronizadas.
    // El servidor avisa cuantos hay esperando cada vez que cambia. Decirle a
    // alguien que esta solo en la cola parece un mal mensaje y es al reves: el
    // que sabe que no hay nadie manda el link o arma una sala, y el que no
    // sabe se queda mirando un spinner noventa segundos y cierra la pagina.
    const codigo = await buscador.buscarRival(({ esperando }) => {
      el.buscMsg.textContent = esperando > 1
        ? `${esperando} esperando. Emparejando…`
        : 'Sos el único en la cola. Pasá el link a alguien o armá una sala con código.';
    });
    await entrar(codigo, 'azar');
  } catch (e) {
    if (e.message === CANCELADO) return;      // se salió a propósito
    alMenu(`${e.message}. Probá de nuevo o armá una sala con código.`);
  }
}

/** Estilo Omegle: cortar con este y buscar otro sin pasar por el menu. */
async function siguienteRival() {
  // La camara queda prendida a proposito: se reusa para la sala siguiente y
  // el corte se siente instantaneo en vez de meter otro "pidiendo cámara".
  salirDeSala();
  await buscarYEntrar();
}

el.irAzar?.addEventListener('click', () => { startPrefetch(); buscarYEntrar(); });
// CREAR ya no arma una sala de una: despliega las dos cosas que se pueden
// crear. Se cierra al elegir y al volver al menu, para que la portada no quede
// con el submenu abierto de la vez pasada.
const cerrarCrear = () => el.crearMenu?.classList.add('hidden');
el.irCrear?.addEventListener('click', () => {
  startPrefetch();
  el.introMsg.textContent = '';
  el.crearMenu?.classList.toggle('hidden');
});
el.crearSala?.addEventListener('click', () => {
  cerrarCrear();
  startPrefetch();
  entrar(codigoNuevo(), 'privada');
});
el.crearTorneo?.addEventListener('click', () => {
  cerrarCrear();
  abrirNuevoTorneo();
});

el.vsEntrar?.addEventListener('click', () => {
  const c = el.vsCodigo.value.trim().toUpperCase();
  // El LARGO decide adonde va. Seis es un torneo, cuatro es una sala.
  if (codigoTorneoValido(c)) {
    el.introMsg.textContent = '';
    abrirTorneo(c);
    return;
  }
  if (!codigoValido(c)) {
    el.introMsg.textContent = 'El código son 4 caracteres (sala) o 6 (torneo).';
    return;
  }
  el.introMsg.textContent = '';
  startPrefetch();
  entrar(c, 'privada');
});
// El teclado del teléfono muestra "ir" y hay que poder usarlo.
el.vsCodigo?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') el.vsEntrar.click(); });
el.buscCancelar?.addEventListener('click', () => {
  buscador.cancelarBusqueda();
  salirDeSala({ apagarCamara: true });   // la cámara se abrió para la cola
  alMenu();
});

// --- barra de la sala ---
el.btnSalir?.addEventListener('click', () => {
  salirDeSala({ apagarCamara: true });
  alMenu();
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
// Solo dos, y solo al CERRAR el duelo: seguir jugando, o volver al menú.
el.backMenu?.addEventListener('click', () => {
  salirDeSala({ apagarCamara: true });
  alMenu();
});
// Sin backend configurado no hay batalla: los accesos ni aparecen, en vez de
// ofrecer algo que va a fallar.
if (hayVersus()) {
  el.irAzar?.classList.remove('hidden');
  el.irCrear?.classList.remove('hidden');
  el.filaCodigo?.classList.remove('hidden');
}

// ---------- cuanta gente hay del otro lado ----------
//
// Dos numeros distintos: `cola` son los que estan esperando rival EN ESTE
// SEGUNDO (los tiene conectados el lobby) y `jugando` los que hicieron algo en
// los ultimos diez minutos. El primero es el que decide si tocar "BUSCAR
// RIVAL" tiene sentido; el segundo dice si la pagina esta viva.
//
// Se pide SOLO con el menu a la vista y con la pestaña al frente. Mientras se
// juega no le importa a nadie, y un request cada medio minuto por cada persona
// que dejo la pagina abierta se convierte en el pico de trafico mas grande del
// dia sin que nadie lo mire.
const CADA_ONLINE = 30000;
let ultimoOnline = 0;

const cuantos = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

// SE LLAMA USUARIOS ACTIVOS Y SE ESCRIBE ASI, EN LAS DOS PANTALLAS.
//
// Antes cada una lo decia a su manera —"personas escaneando" en la portada,
// "personas en el escáner" en la espera— y encima la portada le restaba uno
// para no contarte a vos. Tres nombres y dos numeros distintos para UNA sola
// cosa: el mismo dato que el panel de /admin llama "personas activas en los
// últimos 10 minutos". Ahora es el numero crudo, con su nombre, en todos lados.
const activos = (n) => cuantos(n, 'USUARIO ACTIVO', 'USUARIOS ACTIVOS');

function pintarOnline(d) {
  if (!d || !el.online) return;         // se cayo el pedido: se deja lo de antes
  el.online.classList.remove('hidden');
  el.online.classList.toggle('vacio', d.jugando <= 1);
  // La cola va detras y solo si hay alguien: es el dato que decide si tocar
  // "BUSCAR RIVAL" tiene sentido, pero sin nadie esperando la linea se llena de
  // ceros y el consejo sirve mas que el numero.
  el.online.textContent = d.cola > 0
    ? `${activos(d.jugando)} · ${d.cola} buscando rival`
    : d.jugando > 1
      ? `${activos(d.jugando)} · nadie en la cola`
      : `${activos(d.jugando)} · armá una sala y pasá el código`;
}

/**
 * El mismo dato, pero para el que YA está esperando.
 *
 * Acá el número de la cola no se repite: ese lo escribe `buscMsg` y es exacto
 * (lo avisa el servidor por el mismo socket cada vez que cambia). Lo que falta
 * mientras gira el spinner son los usuarios activos. Noventa segundos de espera
 * se aguantan sabiendo que hay veinte del otro lado y no se aguantan ni diez si
 * uno sospecha que no hay nadie.
 */
function pintarBuscando(d) {
  if (!d || !el.buscOnline) return;
  el.buscOnline.classList.remove('hidden');
  el.buscOnline.classList.toggle('vacio', d.jugando <= 1);
  el.buscOnline.textContent = activos(d.jugando);
}

/** ¿Alguna de las dos pantallas que muestran el número está a la vista? */
const miraOnline = () => !el.intro.classList.contains('hidden')
  || !el.buscando.classList.contains('hidden');

/**
 * @param {boolean} forzar Saltea el mínimo de 10s. Lo usa el que ACABA de
 *   entrar a la cola: viene del menú, donde el número se acaba de pedir, y sin
 *   esto la pantalla de búsqueda arrancaba muda hasta el refresco siguiente.
 */
async function refrescarOnline(forzar = false) {
  if (!hayVersus() || document.hidden) return;
  const ahora = Date.now();
  if (!forzar && ahora - ultimoOnline < 10000) return;   // show() se llama seguido
  ultimoOnline = ahora;
  const d = await pedirOnline();
  pintarOnline(d);
  pintarBuscando(d);
}

if (hayVersus()) {
  setInterval(() => { if (miraOnline()) refrescarOnline(); }, CADA_ONLINE);
  // Volver a la pestaña despues de un rato y ver el numero viejo es peor que
  // no verlo: el que se fue a mandar el link vuelve a mirar justo esto.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && miraOnline()) refrescarOnline();
  });
  refrescarOnline();
}

// ---------- torneo ----------
let ultimaPartida = null;     // {aura, moves} de la ronda recien cerrada
let subida = null;            // respuesta del worker: {pais, region}
let ambito = 'global', periodo = 'dia';

/**
 * Sube la ronda al ranking global. Se llama sola al cerrar la partida, en
 * TODOS los modos: solo, duelo, sala y torneo.
 *
 * POR QUE YA NO HAY BOTON. Antes esto era un formulario en la pantalla de
 * resultado: escribí tu nombre, tocá "ENTRAR AL TORNEO". El que acababa de
 * sacar su puntaje tenía que ponerse a teclear para que contara, y el que no
 * lo hacía —la enorme mayoría— desaparecía sin dejar rastro. Ahora el nombre
 * se pide UNA vez, antes de entrar (ver la pantalla `nombre`), y desde ahí
 * todo lo que se escanea entra solo.
 *
 * SE MANDA CADA RONDA, no solo las que superan tu récord. Parece de más y no
 * lo es: el ranking tiene tres periodos y el servidor se queda con el MAX de
 * cada uno (ver schema.sql). Una ronda floja de hoy no toca tu récord
 * histórico pero puede ganar la tabla del día, y si no se manda, no existe.
 * Lo que "se detecta automáticamente" es el mejor: eso lo hace la consulta,
 * no el cliente.
 */
async function anotarEnRanking() {
  const alias = getAlias();
  if (!hayApi() || !ultimaPartida || !aliasValido(alias)) return;

  el.rPuesto.classList.remove('hidden');
  el.rPuesto.textContent = 'ANOTANDO…';
  el.altaMsg.textContent = '';
  // Con el backend lento o caido son seis segundos sin una sola señal de vida,
  // y desde afuera eso es indistinguible de colgado.
  const lento = setTimeout(() => { el.altaMsg.textContent = 'Tardando más de lo normal…'; }, 2200);
  try {
    subida = await enviarPuntaje({ alias, ...ultimaPartida });
    // El ambito arranca en el mas chico que tenga sentido: verse primero entre
    // los del barrio engancha mas que ser el puesto 4.000 del mundo.
    ambito = subida.ambito || (subida.region ? 'region' : 'pais');
    periodo = 'dia';
    if (subida.yo) {
      const donde = ambito === 'region'
        ? (subida.region || nombrePais(subida.pais)).toUpperCase()
        : nombrePais(subida.pais);
      el.rPuesto.textContent = `PUESTO ${subida.yo.puesto} DE ${subida.yo.total}
HOY EN ${donde}`;
      // Tu mejor marca del dia, si la de esta ronda no la alcanzo. Sin esto,
      // ver "puesto 3" despues de una ronda floja se lee como un error.
      el.altaMsg.textContent = subida.yo.aura > ultimaPartida.aura
        ? `Tu mejor de hoy sigue siendo ${subida.yo.aura.toLocaleString('es-GT')}.`
        : '';
    } else {
      el.rPuesto.textContent = 'ANOTADO EN EL RANKING';
    }
  } catch (e) {
    // Que no entre al ranking no puede robarle la pantalla a nadie: el puntaje
    // ya esta en grande arriba y el clip se puede compartir igual.
    el.rPuesto.classList.add('hidden');
    el.altaMsg.textContent = `No se pudo anotar en el ranking (${e.message}).`;
  } finally {
    clearTimeout(lento);
  }
}

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

// Una linea al servidor diciendo "entro alguien". Sin esto no hay forma de
// saber cuanta gente entro: Pages no da logs y el ranking solo ve a los que
// escriben su nombre, que son una minoria.
contarVisita();

// ---------- eventos ----------
el.go.addEventListener('click', () => { startPrefetch(); boot(); });
el.retry.addEventListener('click', () => { el.go.disabled = false; show('intro'); });
el.again.addEventListener('click', async () => {
  // "OTRA VEZ" sigue donde estabas: otro rival en la cola, otro duelo en la
  // sala, u otra ronda si venías solo.
  if (modo === 'versus' && batalla?.vivo) {
    if (tipoSala === 'azar') { siguienteRival(); return; }
    batalla.limpiarRonda();
    show();
    pintarSala();
    arrancarLoop();
    return;
  }
  salirDeSala();
  show('loading');
  if (!await asegurarCamara()) return;
  bombearDeteccion();
  acomodarTiles();
  renderer = new Renderer(el.canvas);
  recorder = new Recorder(el.canvas);
  countdown();
});
/**
 * Los tres botones de compartir son el mismo camino con distinto texto.
 *
 * El aura del nombre del archivo es la de la ronda QUE SE ESTÁ BAJANDO (la
 * mejor del duelo), no la de `players`, que ya se reinició al empezar otra.
 */
async function compartirRonda(red, boton) {
  if (!blob) return;
  const botones = [el.shIg, el.shTt, el.share];
  botones.forEach((b) => { if (b) b.disabled = true; });
  try {
    const r = await compartir(blob, {
      aura: mejorRonda?.aura ?? Math.round(players[0].aura),
      puesto: miPuestoTorneo?.puesto,
      total: miPuestoTorneo?.total,
      torneo: torneoActivo ? torneoDatos?.organizador : '',
    }, red);
    hit('clip');
    el.rNote.textContent = mensajeDe(r, red);
  } finally {
    botones.forEach((b) => { if (b) b.disabled = false; });
    if (boton) boton.blur();
  }
}
el.shIg?.addEventListener('click', (e) => compartirRonda('instagram', e.currentTarget));
el.shTt?.addEventListener('click', (e) => compartirRonda('tiktok', e.currentTarget));
el.share.addEventListener('click', (e) => compartirRonda('', e.currentTarget));

// ============================================================================
// TORNEOS DE COMUNIDAD
//
// El torneo de un streamer: el arma uno, lee el codigo en camara, y su gente
// entra, farmea y sube en la tabla durante los dias que el puso.
//
// ES ASINCRONO Y ESO CAMBIA TODO. No hay sala, no hay socket, no hay nadie
// esperando: se pide la tabla, se juega, se sube el puntaje. Por eso no usa
// nada de versus.js —ni Durable Objects del lado del servidor, ver torneos.js—
// y por eso escala a la comunidad entera de alguien y no a seis personas.
// ============================================================================

let torneoActivo = null;      // codigo en el que estoy jugando, o null
let torneoDatos = null;       // ultima info que trajo el servidor
let miPuestoTorneo = null;    // {puesto, total, aura} de la ronda recien subida

// ---------- crear ----------

function abrirNuevoTorneo() {
  el.ntMsg.textContent = '';
  el.ntNombre.value = '';
  el.ntQuien.value = getAlias();
  el.ntDias.value = '7';
  el.ntCrear.disabled = false;
  el.ntCrear.textContent = 'CREAR TORNEO';
  show('nuevo');
}

el.ntVolver?.addEventListener('click', () => show('intro'));

el.ntCrear?.addEventListener('click', async () => {
  const nombre = el.ntNombre.value.trim();
  const quien = el.ntQuien.value.trim();
  const dias = Number(el.ntDias.value);

  if (nombre.length < 3) {
    el.ntMsg.textContent = 'Ponele un nombre al torneo (3 letras o más).';
    el.ntNombre.focus();
    return;
  }
  if (!aliasValido(quien)) {
    el.ntMsg.textContent = 'Tu nombre va de 2 a 14 letras o números.';
    el.ntQuien.focus();
    return;
  }
  if (!Number.isFinite(dias) || dias < 1 || dias > 90) {
    el.ntMsg.textContent = 'Los días van de 1 a 90.';
    el.ntDias.focus();
    return;
  }

  el.ntCrear.disabled = true;
  el.ntCrear.textContent = 'CREANDO…';
  el.ntMsg.textContent = '';
  try {
    const d = await crearTorneo({ nombre, organizador: quien, dias, clips: el.ntClips.checked });
    // El nombre del organizador pasa a ser su alias por defecto: va a jugar en
    // su propio torneo y no tiene por que escribirlo dos veces.
    setAlias(quien);
    // Se entra al torneo recien creado en vez de volver al menu: lo primero
    // que necesita el organizador es el codigo a la vista para leerlo en camara.
    await abrirTorneo(d.codigo, { aviso: d.avisoClips });
  } catch (e) {
    el.ntMsg.textContent = `No se pudo crear (${e.message}).`;
    el.ntCrear.disabled = false;
    el.ntCrear.textContent = 'REINTENTAR';
  }
});

// ---------- ver el torneo ----------

/**
 * Trae y pinta un torneo.
 *
 * @param {string} codigo
 * @param {object} opts `aviso` es un mensaje que sobrevive al pintado (lo usa
 *   "creaste el torneo pero sin videos"), y `callado` no borra la tabla que ya
 *   estaba —lo usa el refresco de despues de jugar, donde parpadear seria peor.
 */
async function abrirTorneo(codigo, { aviso = '', callado = false } = {}) {
  const c = String(codigo).toUpperCase();
  if (!codigoTorneoValido(c)) { alMenu('Ese código de torneo no es válido.'); return; }

  show('torneo');
  if (!callado) {
    el.tNombre.textContent = 'CARGANDO…';
    el.tSub.textContent = '';
    el.tTabla.innerHTML = '';
    el.tYo.textContent = '';
    el.tCodigo.textContent = c;
  }
  el.tCodMsg.textContent = aviso || 'Tocá el código para copiar el link';
  el.tCodMsg.classList.toggle('alerta', !!aviso);

  try {
    const d = await verTorneo(c, getAlias());
    torneoDatos = d;
    setUltimo(c);
    pintarTorneo(d);
  } catch (e) {
    el.tNombre.textContent = 'NO SE PUDO ABRIR';
    el.tSub.textContent = e.message;
    el.tTabla.innerHTML = '';
    el.tCodigo.textContent = c;
  }
}

const ESTADO_TXT = {
  espera: 'TODAVÍA NO ARRANCA',
  abierto: 'ABIERTO',
  cerrado: 'TERMINADO',
};

function pintarTorneo(d) {
  el.tTape.textContent = `TORNEO DE ${String(d.organizador).toUpperCase()}`;
  el.tNombre.textContent = d.nombre;
  el.tCodigo.textContent = d.codigo;

  const cuando = d.estado === 'abierto' ? cuantoFalta(d.termina) : ESTADO_TXT[d.estado];
  el.tSub.textContent = d.clips
    ? `${cuando} · se guardan los videos del top ${d.topeClips}`
    : `${cuando} · sin videos guardados`;

  el.tQuienSoy.textContent = getAlias() ? `Vas a farmear como ${getAlias()}.` : '';

  // La tabla. El play solo aparece donde HAY video: prometer un play que no
  // reproduce nada es peor que no ofrecerlo.
  const mio = String(getAlias()).trim().toLowerCase();
  el.tTabla.innerHTML = d.filas.length
    ? d.filas.map((f) => `<li class="${f.puesto <= 3 ? 'podio ' : ''}${String(f.alias).toLowerCase() === mio ? 'yo' : ''}">
        <span class="pos">${f.puesto}</span>
        <span class="quien">${escapar(f.alias)}${f.clip ? ' <em class="tiene-clip">▶</em>' : ''}</span>
        <span class="cuanto">${Number(f.aura).toLocaleString('es-GT')}</span>
      </li>`).join('')
    : '<li><span class="vacio">TODAVÍA NO FARMEÓ NADIE.<br />SÉ EL PRIMERO.</span></li>';

  el.tYo.textContent = d.yo
    ? `Vos: puesto ${d.yo.puesto} de ${d.yo.total} · ${Number(d.yo.aura).toLocaleString('es-GT')} de aura.`
    : '';

  // Farmear solo se puede con el torneo abierto. Cerrado, el boton se queda
  // pero dice por que no: desaparecido, la gente cree que se rompio.
  const abierto = d.estado === 'abierto';
  el.tFarmear.disabled = !abierto;
  el.tFarmear.textContent = abierto
    ? (d.yo ? 'FARMEAR DE NUEVO' : 'EMPEZAR A FARMEAR')
    : (d.estado === 'espera' ? 'TODAVÍA NO ARRANCA' : 'EL TORNEO TERMINÓ');

  // El recopilatorio necesita videos. Sin ninguno guardado no hay nada que ver.
  const hayClips = d.clips && d.filas.some((f) => f.clip);
  el.tRecop.classList.toggle('hidden', !hayClips);

  el.tOrg.classList.toggle('hidden', !soyOrganizador(d.codigo));
  el.tCerrar.classList.toggle('hidden', d.estado !== 'abierto');
  el.tOrgMsg.textContent = '';
}

/** Copiar avisando en el propio boton: es el patron que ya usa la sala. */
function copiarEn(boton, texto, dice = 'COPIADO') {
  const antes = boton.textContent;
  navigator.clipboard?.writeText(texto)
    .then(() => {
      boton.textContent = dice;
      setTimeout(() => { boton.textContent = antes; }, 1400);
    })
    .catch(() => { el.tCodMsg.textContent = texto; });
}

el.tCodigo?.addEventListener('click', () => {
  if (torneoDatos) copiarEn(el.tCodigo, linkTorneo(torneoDatos.codigo), 'LINK COPIADO');
});

el.tCompartir?.addEventListener('click', async () => {
  if (!torneoDatos) return;
  const texto = `Entrá al torneo de aura de ${torneoDatos.organizador}: "${torneoDatos.nombre}".\nCódigo ${torneoDatos.codigo}\n${linkTorneo(torneoDatos.codigo)}`;
  // Aca si sirve el compartir nativo de TEXTO, que existe en todos lados (a
  // diferencia del de archivos): manda el link por WhatsApp, Discord o donde
  // el streamer tenga a su gente.
  if (navigator.share) {
    try { await navigator.share({ title: torneoDatos.nombre, text: texto }); return; }
    catch (e) { if (e?.name === 'AbortError') return; }
  }
  copiarEn(el.tCompartir, texto, 'COPIADO');
});

el.tLinkOrg?.addEventListener('click', () => {
  if (!torneoDatos) return;
  copiarEn(el.tLinkOrg, linkOrganizador(torneoDatos.codigo), 'COPIADO — GUARDALO');
  el.tOrgMsg.textContent = 'Ese link lleva tu clave adentro. Guardalo: es lo único que prueba que el torneo es tuyo.';
});

el.tCerrar?.addEventListener('click', async () => {
  if (!torneoDatos) return;
  // Cerrar es irreversible: nadie mas puede subir puntaje. Se pregunta.
  if (!confirm(`¿Cerrar "${torneoDatos.nombre}" ahora? Nadie más va a poder farmear.`)) return;
  el.tCerrar.disabled = true;
  try {
    await cerrarTorneo(torneoDatos.codigo);
    el.tOrgMsg.textContent = 'Torneo cerrado. Los videos se guardan 7 días más.';
    await abrirTorneo(torneoDatos.codigo, { callado: true });
  } catch (e) {
    el.tOrgMsg.textContent = `No se pudo cerrar (${e.message}).`;
  } finally {
    el.tCerrar.disabled = false;
  }
});

el.tVolver?.addEventListener('click', () => { torneoActivo = null; show('intro'); });

// ---------- farmear en el torneo ----------

el.tFarmear?.addEventListener('click', () => {
  // El nombre ya esta: no se puede llegar hasta aca sin pasar por la pantalla
  // que lo pide. El chequeo queda igual por si alguien borro el localStorage
  // con la pestaña abierta.
  if (!aliasValido(getAlias())) { pedirNombre(); return; }
  torneoActivo = torneoDatos?.codigo || null;
  if (!torneoActivo) return;
  hit('torneo');
  // Se sale de cualquier sala: el torneo es solitario, y una sala abierta
  // dejaria la grilla y la barra encima de la pantalla del escaneo.
  salirDeSala();
  startPrefetch();
  boot();
});

/**
 * Sube la ronda al torneo. Se llama sola al cerrar la partida.
 *
 * EL ORDEN ES DELIBERADO: primero el puntaje (un JSON de nada, instantaneo) y
 * DESPUES el video (~5MB, puede tardar). Asi el puesto aparece en
 * pantalla enseguida y el archivo sube por atras. Al reves, el que tiene mala
 * señal se queda mirando "subiendo…" y no ve nunca su puesto, que es lo unico
 * que fue a buscar.
 */
async function anotarEnTorneo() {
  const alias = getAlias();
  if (!torneoActivo || !ultimaPartida || !aliasValido(alias)) return;

  miPuestoTorneo = null;
  el.rTorneo.classList.remove('hidden');
  el.rTorneo.textContent = 'ANOTANDO EN EL TORNEO…';

  let r;
  try {
    r = await subirPuntajeTorneo({ codigo: torneoActivo, alias, ...ultimaPartida });
  } catch (e) {
    el.rTorneo.textContent = `No se pudo anotar en el torneo (${e.message}).`;
    return;
  }

  miPuestoTorneo = r.yo;
  const org = String(r.torneo?.organizador || '').toUpperCase();
  el.rTorneo.textContent = `PUESTO ${r.yo.puesto} DE ${r.yo.total}\nEN EL TORNEO DE ${org}`;

  if (!r.subirClip || !blob) return;

  // El video, por atras. Nada de esto bloquea: el puesto ya esta escrito.
  const antes = el.rTorneo.textContent;
  const res = await subirClip({
    codigo: torneoActivo,
    alias,
    blob,
    onProgreso: (p) => {
      el.rTorneo.textContent = `${antes}\nGUARDANDO TU VIDEO… ${Math.round(p * 100)}%`;
    },
  });
  el.rTorneo.textContent = antes;
  // Que el video no entre no es un error que valga interrumpir a nadie: el
  // puesto —lo que la persona vino a buscar— ya esta. Se dice y se sigue.
  el.rNote.textContent = res.ok && res.guardado
    ? 'Tu video quedó guardado en el torneo.'
    : res.ok
      ? 'Quedaste fuera del top: tu puesto cuenta, pero el video no se guarda.'
      : `El puesto quedó anotado. El video no se pudo guardar (${res.error}).`;
}

// ---------- el recopilatorio ----------

let clipsReel = [];
let recopBlob = null;
let reelIndice = 0;

el.tRecop?.addEventListener('click', () => abrirRecop());

/** Cuanto tarda en armarse, en minutos y siempre al menos 1. */
const minutos = (clips) => Math.max(1, Math.ceil(duracionEstimada(clips) / 60));

function abrirRecop() {
  if (!torneoDatos) return;
  recopBlob = null;
  el.recTitulo.textContent = torneoDatos.nombre;
  el.recBajar.classList.add('hidden');
  el.recProgCaja.classList.add('hidden');
  el.recGenerar.disabled = false;
  el.recGenerar.classList.remove('hidden');

  const conClip = torneoDatos.filas.filter((f) => f.clip).slice(0, torneoDatos.topeClips);
  if (!conClip.length) {
    el.recMsg.textContent = 'Todavía no hay videos guardados en este torneo.';
    el.recGenerar.classList.add('hidden');
    show('recop');
    return;
  }
  el.recGenerar.textContent = `GENERAR EL VIDEO (${conClip.length} clips, ~${minutos(conClip)} min)`;
  el.recMsg.textContent = `Los ${conClip.length} que más farmearon. Se reproducen uno tras otro.`;

  // El reel arranca solo: es lo que el streamer quiere ver primero. El archivo
  // es el paso siguiente y tarda minutos, asi que no puede ser el unico camino.
  reelIndice = 0;
  reproducirReel(conClip);
  show('recop');
}

/**
 * Reproduce los clips del top uno tras otro en el <video> de la pantalla.
 *
 * Se cambia el `src` del MISMO elemento en vez de tener uno por clip: diez
 * <video> con varios MB cada uno es la forma mas rapida de que un telefono se
 * quede sin memoria a mitad del reel.
 */
function reproducirReel(filas) {
  const v = el.recVideo;
  if (!filas.length) return;

  const poner = (i) => {
    reelIndice = ((i % filas.length) + filas.length) % filas.length;
    const f = filas[reelIndice];
    el.recPlaca.innerHTML = `<em>#${f.puesto}</em> ${escapar(f.alias)} · ${Number(f.aura).toLocaleString('es-GT')}`;
    v.src = urlClip(torneoDatos.codigo, f.alias);
    // `muted` para que el navegador deje arrancar sin gesto. El clip del
    // escaneo solitario no tiene audio igual, asi que no se pierde nada.
    v.muted = true;
    v.play().catch(() => { /* que lo toque a mano */ });
  };

  v.onended = () => poner(reelIndice + 1);
  v.onerror = () => { if (filas.length > 1) poner(reelIndice + 1); };
  poner(0);
}

el.recGenerar?.addEventListener('click', async () => {
  if (!torneoDatos) return;
  const filas = torneoDatos.filas.filter((f) => f.clip).slice(0, torneoDatos.topeClips);
  if (!filas.length) return;

  // El reel de la pantalla se para: dos videos decodificando a la vez mientras
  // se graba un canvas es justo lo que hace que el recopilatorio salga a
  // saltos en un telefono.
  el.recVideo.onended = null;
  el.recVideo.pause();

  el.recGenerar.disabled = true;
  el.recProgCaja.classList.remove('hidden');
  const barra = (p) => { el.recProg.style.width = `${Math.round(p * 100)}%`; };

  try {
    el.recGenerar.textContent = 'BAJANDO LOS VIDEOS…';
    soltarClips(clipsReel);
    clipsReel = await bajarClips(filas, (alias) => urlClip(torneoDatos.codigo, alias), barra);
    if (!clipsReel.length) throw new Error('no se pudo bajar ningún video');

    el.recGenerar.textContent = 'ARMANDO…';
    const m = minutos(clipsReel);
    el.recMsg.textContent = `Se arma en tiempo real: ~${m} minuto${m === 1 ? '' : 's'}. No cierres esta pantalla.`;
    recopBlob = await armarRecopilatorio(clipsReel, torneoDatos.nombre, (p, que) => {
      barra(p);
      el.recGenerar.textContent = `ARMANDO… ${Math.round(p * 100)}% ${que || ''}`;
    });

    // Se muestra el resultado en el mismo reproductor: ver el archivo antes de
    // subirlo es lo minimo, y ademas prueba que salio bien.
    el.recVideo.onended = null;
    el.recVideo.src = URL.createObjectURL(recopBlob);
    el.recVideo.muted = false;
    el.recPlaca.innerHTML = '<em>EL RECOPILATORIO</em>';
    el.recMsg.textContent = 'Listo. Miralo y guardalo.';
    el.recGenerar.classList.add('hidden');
    el.recBajar.classList.remove('hidden');
  } catch (e) {
    el.recMsg.textContent = `No se pudo armar (${e.message}).`;
    el.recGenerar.disabled = false;
    el.recGenerar.textContent = 'REINTENTAR';
  } finally {
    el.recProgCaja.classList.add('hidden');
    barra(0);
  }
});

el.recBajar?.addEventListener('click', async () => {
  if (!recopBlob) return;
  el.recBajar.disabled = true;
  const r = await compartir(recopBlob, {
    aura: torneoDatos?.filas?.[0]?.aura || 0,
    torneo: torneoDatos?.organizador,
  }, '');
  el.recBajar.disabled = false;
  el.recMsg.textContent = mensajeDe(r, '') || 'Guardado.';
});

el.recVolver?.addEventListener('click', () => {
  // Los objectURL se sueltan al salir: son varios MB cada uno y quedarse con diez
  // colgados es medio giga de memoria retenida en el telefono del streamer.
  el.recVideo.onended = null;
  el.recVideo.pause();
  el.recVideo.removeAttribute('src');
  el.recVideo.load();
  soltarClips(clipsReel);
  clipsReel = [];
  recopBlob = null;
  show('torneo');
});

// ---------- entradas al torneo desde afuera ----------

el.irUltimoTorneo?.addEventListener('click', () => abrirTorneo(getUltimo()));

if (hayTorneos()) {
  el.irCrear?.classList.remove('hidden');
  // El atajo aparece solo si ya estuviste en uno.
  if (codigoTorneoValido(getUltimo())) el.irUltimoTorneo?.classList.remove('hidden');
}

// ============================================================================
// EL NOMBRE, UNA SOLA VEZ
//
// Es lo primero que se ve y no se vuelve a preguntar nunca. Todo lo que se
// escanee después —solo, duelo, sala o torneo— se anota en el ranking con
// este nombre, sin que haya que tocar nada al terminar.
//
// POR QUE ESTA ES LA DECISION IMPORTANTE. Antes el nombre se pedía DESPUES,
// en la pantalla de resultado, junto a un botón de "ENTRAR AL TORNEO": justo
// cuando la persona acaba de ver su puntaje y lo único que quiere es
// compartirlo. El que no se ponía a teclear ahí —la enorme mayoría—
// desaparecía sin dejar rastro, y por eso la tabla `runs` sólo veía a una
// minoría de los que escaneaban (~59 de varios cientos el día del pico de
// Instagram, ver el panel de /admin). Pedirlo al entrar cuesta una pantalla
// una vez y hace que TODOS entren al ranking.
// ============================================================================

// Qué hacer cuando termine de escribir el nombre. Existe porque se puede
// llegar acá desde un link de torneo: primero el nombre, después el destino
// que la persona pidió, sin perderlo en el camino.
let despuesDelNombre = null;

function pedirNombre(luego = null) {
  despuesDelNombre = luego;
  el.nomInput.value = getAlias();
  el.nomMsg.textContent = '';
  show('nombre');
  // El foco va con retraso a propósito: en iOS, enfocar un campo mientras el
  // panel todavía está apareciendo abre el teclado sobre una pantalla a medio
  // dibujar y el layout queda cortado.
  setTimeout(() => el.nomInput?.focus(), 120);
}

/** Pinta "jugás como X" en la portada. Es el único lugar donde se cambia. */
function pintarSoy() {
  const a = getAlias();
  el.soy.classList.toggle('hidden', !a);
  if (a) el.soy.textContent = `jugás como ${a} · cambiar`;
}

function guardarNombre() {
  const n = el.nomInput.value.trim();
  if (!aliasValido(n)) {
    el.nomMsg.textContent = 'De 2 a 14 letras o números.';
    el.nomInput.focus();
    return;
  }
  setAlias(n);
  pintarSoy();
  // Los recuadros de la sala muestran el nombre: si se cambió estando adentro
  // de una, hay que repintarlos o sigue el viejo hasta la próxima ronda.
  if (batalla?.vivo) pintarSala();
  const luego = despuesDelNombre;
  despuesDelNombre = null;
  if (luego) luego(); else show('intro');
}

el.nomOk?.addEventListener('click', guardarNombre);
// El teclado del teléfono muestra "listo" y hay que poder usarlo.
el.nomInput?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') guardarNombre(); });
el.soy?.addEventListener('click', () => pedirNombre());

// ---------- por dónde arranca la app ----------
//
// Tres caminos, en este orden:
//   1. sin nombre               -> se pide, y después se sigue
//   2. con nombre y link de torneo -> derecho al torneo
//   3. con nombre, sin link     -> la portada de siempre
//
// Va al FINAL del archivo porque necesita que todo lo demás esté definido:
// `abrirTorneo` y `pedirNombre` son de este módulo y se llaman acá mismo.
{
  const dela = hayTorneos() ? torneoDeLaUrl() : null;
  // La clave del link es la copia de seguridad del organizador: si viene, se
  // guarda para que ESTE navegador pueda moderar y cerrar. Se hace antes de
  // cualquier bifurcación: no puede depender de si hay nombre o no.
  if (dela?.clave) guardarClave(dela.codigo, dela.clave);

  const destino = dela ? () => abrirTorneo(dela.codigo) : () => show('intro');

  pintarSoy();
  if (aliasValido(getAlias())) destino();
  else pedirNombre(destino);
}
