// Salas de batalla: juntar hasta seis personas y pasarles mensajes.
//
// QUE PASA POR ACA Y QUE NO. Por aca NO pasa video ni audio: eso va peer to
// peer por WebRTC y esto solo lleva los sobres de la señalizacion (oferta,
// respuesta, candidatos ICE). Mandar media por un Worker costaria plata de
// verdad y agregaria un salto de latencia a cada cuadro.
//
// Lo que SI viaja por aca es el estado del juego: cuando arranca la ronda, el
// aura en vivo de cada uno y el resultado. Es a proposito: asi la batalla
// FUNCIONA aunque el video nunca conecte, que con dos NAT hostiles y sin TURN
// pasa seguido. Se pierde el verse las caras, no la partida.
//
// PROTOCOLO. Cada conexion tiene un `id` que reparte la sala en orden de
// llegada. Hay dos clases de mensaje:
//   - dirigidos a UNO   (oferta/respuesta/ice): el cliente pone `para`
//   - para TODOS los demas (arranca/aura/fin)
// El `de` lo pone SIEMPRE el servidor, nunca el cliente: si no, cualquiera
// en la sala podria firmar mensajes con el id de otro.
//
// HIBERNACION, Y NO ES UN DETALLE DE OPTIMIZACION.
//
// Los sockets se aceptan con `state.acceptWebSocket()` y NO con `ws.accept()`.
// Con el segundo, el Durable Object se queda cargado en memoria todo el tiempo
// que el socket este abierto, y Cloudflare cobra DURACION por eso: 0.128 GB por
// objeto vivo, cada segundo. Una sola pestaña olvidada en una sala son ~11.000
// GB-s en un dia, o sea la cuota diaria entera del plan gratis (13.000) quemada
// por alguien que se fue a almorzar. Cuando se acaba, TODO lo que toque un
// Durable Object empieza a contestar 500 —la cola de desconocidos y las salas
// por codigo al mismo tiempo— y desde el navegador se ve como "no se pudo
// entrar a la cola", que no dice nada de la causa.
//
// Con hibernacion el objeto se descarga mientras nadie habla y el socket sigue
// abierto igual: esperar no cuesta. Lo que se paga es el rato en que de verdad
// vuelan mensajes (los 15 segundos de una ronda), que es lo correcto.
//
// El precio es que NO HAY ESTADO EN MEMORIA: entre dos mensajes el objeto puede
// haber desaparecido y vuelto a construirse. Por eso lo de cada conexion vive
// en su `serializeAttachment` (viaja con el socket) y los dos contadores que no
// son de nadie —el cupo y el proximo id— viven en el storage. Cualquier `this.x`
// que se guarde en el constructor es un dato que un dia no va a estar.

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin O/0/I/1, se dictan por telefono

export const codigoValido = (c) => /^[A-Z2-9]{4}$/.test(c) && [...c].every((x) => ALFABETO.includes(x));

/** Mismo criterio que el ranking, para que el nombre del tile sea el del torneo. */
const ALIAS_OK = /^[\p{L}\p{N} ._-]{2,14}$/u;

const TOPE = 6;
const A_UNO = ['oferta', 'respuesta', 'ice'];
const A_TODOS = ['arranca', 'aura', 'fin', 'micro'];

// `WebSocket.OPEN`. Va el numero pelado porque el runtime de los Workers
// bautiza la constante `READY_STATE_OPEN` y no hace falta apostar a cual de los
// dos nombres existe hoy.
const ABIERTO = 1;

export function codigoNuevo() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  // 32 divide a 256, asi que el modulo no sesga: las 32 letras salen igual.
  return [...b].map((x) => ALFABETO[x % ALFABETO.length]).join('');
}

const leer = (ws) => { try { return ws.deserializeAttachment() || {}; } catch { return {}; } };

/**
 * Borra la ficha de un socket que se va.
 *
 * Hace falta porque `getWebSockets()` puede seguir devolviendo al que se esta
 * yendo durante un instante: sin ficha queda fuera de las listas y no se anuncia
 * a si mismo ni se le manda nada.
 */
const olvidar = (ws) => { try { ws.serializeAttachment({}); } catch { /* ya se fue */ } };

/** Una sala. El Durable Object se llama como el codigo. */
export class Sala {
  constructor(state) {
    // Liviano a proposito: esto corre CADA VEZ que el objeto despierta de la
    // hibernacion, o sea una vez por mensaje si nadie hablaba hace rato.
    this.state = state;
  }

  /** Quienes estan, en orden de llegada. Se arma desde los sockets, no de memoria. */
  gente() {
    return this.state.getWebSockets()
      .map((ws) => ({ ws, ...leer(ws) }))
      .filter((p) => p.id && p.ws.readyState === ABIERTO)
      .sort((a, b) => a.id - b.id);
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('esperaba websocket', { status: 426 });
    const url = new URL(req.url);
    const gente = this.gente();

    // El cupo lo fija QUIEN ABRE la sala y despues no se toca. Si cada uno
    // trajera el suyo, el tercero en discordia entraria a un uno contra uno
    // con solo pedir max=6 en la URL.
    let max = await this.state.storage.get('max');
    if (gente.length === 0) {
      const pedido = Math.floor(Number(url.searchParams.get('max')));
      max = Number.isFinite(pedido) && pedido >= 2 ? Math.min(TOPE, pedido) : TOPE;
      // Sala vacia es sala nueva: el cupo y la numeracion arrancan de cero. Sin
      // esto los contadores de una partida de ayer siguen en el storage y el
      // primero en entrar seria el jugador 14.
      await this.state.storage.put({ max, proximo: 1 });
    }
    max = max || TOPE;

    // Sala llena: se rechaza con un motivo legible en vez de dejar a alguien
    // colgado esperando a un rival que ya esta jugando con otro.
    if (gente.length >= max) {
      const { 0: c, 1: s } = new WebSocketPair();
      // Este si va con `accept()` comun: se contesta y se cierra en el mismo
      // suspiro, no hay nada que hibernar.
      s.accept();
      s.send(JSON.stringify({ tipo: 'llena', max }));
      s.close(4001, 'llena');
      return new Response(null, { status: 101, webSocket: c });
    }

    const crudo = (url.searchParams.get('alias') || '').trim().slice(0, 14);
    const alias = ALIAS_OK.test(crudo) ? crudo : '';

    // Los id NO se reciclan: el que se fue no vuelve a ser el 2 mientras la
    // sala siga abierta. El contador va al storage porque en memoria no
    // sobrevive a la hibernacion, y ahi si volveria a repartir numeros usados.
    const id = (await this.state.storage.get('proximo')) || 1;
    await this.state.storage.put('proximo', id + 1);

    const { 0: cliente, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ id, alias });

    // El que ENTRA recibe la lista de los que ya estaban; los que ya estaban
    // reciben al que entro. Con eso solo, los dos lados saben quien ofrece:
    // el del id mas chico. Un rol fijo por par es lo que evita que los dos
    // manden oferta a la vez y la negociacion no cierre nunca.
    server.send(JSON.stringify({
      tipo: 'entraste',
      id,
      max,
      pares: gente.map((p) => ({ id: p.id, alias: p.alias })),
    }));
    this.aLosDemas(server, { tipo: 'llego', id, alias });

    return new Response(null, { status: 101, webSocket: cliente });
  }

  async webSocketMessage(ws, data) {
    const yo = leer(ws);
    if (!yo.id) return;

    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.tipo !== 'string') return;

    // Lista blanca. Lo que no es del protocolo no se reenvia: el relay no
    // tiene por que repartir lo que le manden.
    if (A_UNO.includes(m.tipo)) {
      const destino = this.gente().find((p) => p.id === m.para);
      // `de` va al final del spread a proposito: pisa lo que haya mandado
      // el cliente. El remitente lo decide el servidor y nadie mas.
      if (destino) this.enviar(destino.ws, { ...m, de: yo.id });
    } else if (A_TODOS.includes(m.tipo)) {
      this.aLosDemas(ws, { ...m, de: yo.id });
    }
  }

  async webSocketClose(ws) { this.irse(ws); }

  async webSocketError(ws) { this.irse(ws); }

  irse(ws) {
    const { id } = leer(ws);
    if (!id) return;          // ya se aviso, o nunca llego a entrar
    olvidar(ws);
    this.aTodos({ tipo: 'se-fue', id });
  }

  enviar(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* se fue */ }
  }

  /** A todos menos al que hablo. */
  aLosDemas(quien, msg) {
    for (const p of this.gente()) if (p.ws !== quien) this.enviar(p.ws, msg);
  }

  aTodos(msg) {
    for (const p of this.gente()) this.enviar(p.ws, msg);
  }
}

/**
 * Cola de emparejamiento al azar. Singleton (siempre el mismo DO).
 *
 * No arma la partida: reparte un codigo de sala y los manda a los dos a
 * conectarse ahi. Es un rebote de mas, pero deja UNA sola implementacion de
 * sala en vez de dos caminos distintos —amigos y desconocidos— que despues
 * hay que mantener sincronizados. La diferencia es solo el cupo: los que
 * entran por la cola piden max=2 y la sala queda cerrada de a dos.
 *
 * Esperar tiene que ser GRATIS, y con hibernacion lo es: el objeto duerme
 * mientras la gente hace cola y despierta solo cuando alguien entra o se va.
 * Aceptando los sockets a la vieja usanza, en cambio, cada persona parada en la
 * cola tenia el lobby prendido y facturando.
 */
export class Lobby {
  constructor(state) {
    this.state = state;
  }

  /**
   * Los que esperan, en orden de llegada.
   *
   * El orden sale del turno guardado en cada socket y no del array que devuelve
   * `getWebSockets()`, que no promete ningun orden. Un socket que se murio sin
   * avisar —pestaña cerrada de golpe, telefono que se durmio— ya no aparece, y
   * el filtro por `readyState` cubre al que se esta yendo justo ahora: sin eso,
   * al siguiente lo emparejaban con un fantasma.
   */
  cola() {
    return this.state.getWebSockets()
      .map((ws) => ({ ws, turno: leer(ws).turno }))
      .filter((x) => x.turno && x.ws.readyState === ABIERTO)
      .sort((a, b) => a.turno - b.turno)
      .map((x) => x.ws);
  }

  /**
   * Le dice a cada uno cuantos hay y cuantos tiene adelante.
   *
   * Se AVISA, no se pregunta: los que esperan ya tienen el socket abierto, asi
   * que el numero les llega solo cuando cambia y nadie tiene que estar
   * preguntando cada dos segundos. Esperar en una cola sin saber si hay
   * alguien mas es lo que hace que la gente se vaya a los diez segundos.
   */
  avisar() {
    const cola = this.cola();
    cola.forEach((ws, i) => {
      try { ws.send(JSON.stringify({ tipo: 'en-cola', delante: i, esperando: cola.length })); } catch { /* se fue */ }
    });
  }

  async fetch(req) {
    // El menu pregunta por HTTP comun cuantos hay buscando rival. Es el mismo
    // objeto que tiene la cola, o sea que el numero es exacto y no cuesta ni
    // una consulta a la base.
    if (new URL(req.url).pathname === '/cuantos') {
      return Response.json({ cola: this.cola().length });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('esperaba websocket', { status: 426 });

    const { 0: cliente, 1: server } = new WebSocketPair();

    // El turno es un contador que solo sube, guardado en el storage: es lo
    // unico que ordena la cola cuando el objeto estuvo dormido y no se acuerda
    // de nada.
    const turno = ((await this.state.storage.get('turno')) || 0) + 1;
    await this.state.storage.put('turno', turno);

    this.state.acceptWebSocket(server);
    server.serializeAttachment({ turno });

    const otro = this.cola().find((ws) => ws !== server);
    if (otro) {
      const codigo = codigoNuevo();
      for (const ws of [otro, server]) {
        olvidar(ws);   // ya no estan en la cola: el numero que se avisa abajo tiene que dar
        try {
          ws.send(JSON.stringify({ tipo: 'emparejado', codigo }));
          ws.close(4000, 'emparejado');
        } catch { /* se fue */ }
      }
    }
    this.avisar();

    return new Response(null, { status: 101, webSocket: cliente });
  }

  async webSocketClose() { this.avisar(); }

  async webSocketError() { this.avisar(); }
}
