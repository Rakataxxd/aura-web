// Salas de batalla: emparejar dos jugadores y pasarles mensajes.
//
// QUE HACE Y QUE NO. Por aca NO pasa video: el video va peer-to-peer por
// WebRTC y esto solo lleva los sobres de la señalizacion (oferta, respuesta,
// candidatos ICE). Mandar video por un Worker costaria plata de verdad y
// agregaria un salto de latencia a cada cuadro.
//
// Lo que SI viaja por aca es el estado del juego: quien esta listo, cuando
// arranca la ronda, el aura en vivo de cada uno y el resultado. Es a
// proposito: asi la batalla FUNCIONA aunque el video nunca conecte, que con
// dos NAT hostiles y sin TURN pasa seguido. Se pierde el verse las caras,
// no la partida.

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin O/0/I/1, se dictan por telefono

export const codigoValido = (c) => /^[A-Z2-9]{4}$/.test(c) && [...c].every((x) => ALFABETO.includes(x));

function codigoNuevo() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => ALFABETO[x % ALFABETO.length]).join('');
}

/** Un par de jugadores. El DO se llama como el codigo de sala. */
export class Sala {
  constructor(state) {
    this.state = state;
    this.pares = new Map();     // ws -> {rol}
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('esperaba websocket', { status: 426 });

    // Tercero en discordia: la sala es de dos. Se rechaza con un motivo
    // legible en vez de dejarlo colgado esperando un rival que ya llego.
    if (this.pares.size >= 2) {
      const { 0: c, 1: s } = new WebSocketPair();
      s.accept();
      s.send(JSON.stringify({ tipo: 'llena' }));
      s.close(4001, 'llena');
      return new Response(null, { status: 101, webSocket: c });
    }

    const { 0: cliente, 1: server } = new WebSocketPair();
    server.accept();
    // El primero en llegar es el anfitrion: es quien manda la oferta WebRTC
    // y quien decide cuando arranca. Sin un rol fijo los dos mandaban oferta
    // a la vez y la negociacion no cerraba nunca.
    const rol = this.pares.size === 0 ? 'anfitrion' : 'visita';
    this.pares.set(server, { rol });

    server.send(JSON.stringify({ tipo: 'entraste', rol, jugadores: this.pares.size }));
    this.avisar(server, { tipo: 'rival-entro' });
    if (this.pares.size === 2) this.todos({ tipo: 'listos' });

    server.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || typeof m.tipo !== 'string') return;
      // Lista blanca. Todo lo que no sea del protocolo se tira: el relay no
      // tiene por que reenviar lo que le manden.
      if (!['oferta', 'respuesta', 'ice', 'arranca', 'aura', 'fin', 'saltar'].includes(m.tipo)) return;
      this.avisar(server, m);
      if (m.tipo === 'saltar') { try { server.close(4002, 'saltar'); } catch { /* ya cerrado */ } }
    });

    const irse = () => {
      this.pares.delete(server);
      this.todos({ tipo: 'rival-se-fue' });
    };
    server.addEventListener('close', irse);
    server.addEventListener('error', irse);

    return new Response(null, { status: 101, webSocket: cliente });
  }

  /** A todos menos al que hablo. */
  avisar(quien, msg) {
    const txt = JSON.stringify(msg);
    for (const ws of this.pares.keys()) if (ws !== quien) { try { ws.send(txt); } catch { /* se fue */ } }
  }

  todos(msg) {
    const txt = JSON.stringify(msg);
    for (const ws of this.pares.keys()) { try { ws.send(txt); } catch { /* se fue */ } }
  }
}

/**
 * Cola de emparejamiento al azar. Singleton (siempre el mismo DO).
 *
 * No arma la partida: reparte un codigo de sala y los manda a los dos a
 * conectarse ahi. Es un rebote de mas, pero deja UNA sola implementacion de
 * sala en vez de dos caminos distintos —amigos y desconocidos— que despues
 * hay que mantener sincronizados.
 */
export class Lobby {
  constructor(state) {
    this.state = state;
    this.esperando = [];    // websockets en cola, en orden de llegada
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('esperaba websocket', { status: 426 });
    const { 0: cliente, 1: server } = new WebSocketPair();
    server.accept();

    const sacar = () => {
      const i = this.esperando.indexOf(server);
      if (i >= 0) this.esperando.splice(i, 1);
    };
    server.addEventListener('close', sacar);
    server.addEventListener('error', sacar);

    // Se limpia la cola antes de emparejar: un socket que se murio sin
    // avisar (pestaña cerrada de golpe, telefono que se durmio) dejaba a la
    // siguiente persona emparejada con un fantasma.
    this.esperando = this.esperando.filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN);

    const otro = this.esperando.shift();
    if (otro) {
      const codigo = codigoNuevo();
      for (const ws of [otro, server]) {
        try { ws.send(JSON.stringify({ tipo: 'emparejado', codigo })); ws.close(4000, 'emparejado'); } catch { /* se fue */ }
      }
    } else {
      this.esperando.push(server);
      server.send(JSON.stringify({ tipo: 'en-cola', delante: 0 }));
    }

    return new Response(null, { status: 101, webSocket: cliente });
  }
}

export { codigoNuevo };
