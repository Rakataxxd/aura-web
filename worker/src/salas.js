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

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin O/0/I/1, se dictan por telefono

export const codigoValido = (c) => /^[A-Z2-9]{4}$/.test(c) && [...c].every((x) => ALFABETO.includes(x));

/** Mismo criterio que el ranking, para que el nombre del tile sea el del torneo. */
const ALIAS_OK = /^[\p{L}\p{N} ._-]{2,14}$/u;

const TOPE = 6;
const A_UNO = ['oferta', 'respuesta', 'ice'];
const A_TODOS = ['arranca', 'aura', 'fin', 'micro'];

export function codigoNuevo() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  // 32 divide a 256, asi que el modulo no sesga: las 32 letras salen igual.
  return [...b].map((x) => ALFABETO[x % ALFABETO.length]).join('');
}

/** Una sala. El Durable Object se llama como el codigo. */
export class Sala {
  constructor(state) {
    this.state = state;
    this.gente = new Map();     // ws -> {id, alias}
    this.proximo = 1;           // los id NO se reciclan: el que se fue no vuelve a ser el 2
    this.max = TOPE;
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('esperaba websocket', { status: 426 });
    const url = new URL(req.url);

    // El cupo lo fija QUIEN ABRE la sala y despues no se toca. Si cada uno
    // trajera el suyo, el tercero en discordia entraria a un uno contra uno
    // con solo pedir max=6 en la URL.
    if (this.gente.size === 0) {
      const pedido = Math.floor(Number(url.searchParams.get('max')));
      this.max = Number.isFinite(pedido) && pedido >= 2 ? Math.min(TOPE, pedido) : TOPE;
    }

    // Sala llena: se rechaza con un motivo legible en vez de dejar a alguien
    // colgado esperando a un rival que ya esta jugando con otro.
    if (this.gente.size >= this.max) {
      const { 0: c, 1: s } = new WebSocketPair();
      s.accept();
      s.send(JSON.stringify({ tipo: 'llena', max: this.max }));
      s.close(4001, 'llena');
      return new Response(null, { status: 101, webSocket: c });
    }

    const crudo = (url.searchParams.get('alias') || '').trim().slice(0, 14);
    const alias = ALIAS_OK.test(crudo) ? crudo : '';

    const { 0: cliente, 1: server } = new WebSocketPair();
    server.accept();
    const id = this.proximo++;
    const yo = { id, alias };

    // El que ENTRA recibe la lista de los que ya estaban; los que ya estaban
    // reciben al que entro. Con eso solo, los dos lados saben quien ofrece:
    // el del id mas chico. Un rol fijo por par es lo que evita que los dos
    // manden oferta a la vez y la negociacion no cierre nunca.
    server.send(JSON.stringify({
      tipo: 'entraste',
      id,
      max: this.max,
      pares: [...this.gente.values()].map((p) => ({ id: p.id, alias: p.alias })),
    }));
    this.aLosDemas(server, { tipo: 'llego', id, alias });
    this.gente.set(server, yo);

    server.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || typeof m.tipo !== 'string') return;
      if (!this.gente.has(server)) return;

      // Lista blanca. Lo que no es del protocolo no se reenvia: el relay no
      // tiene por que repartir lo que le manden.
      if (A_UNO.includes(m.tipo)) {
        const destino = this.buscar(m.para);
        // `de` va al final del spread a proposito: pisa lo que haya mandado
        // el cliente. El remitente lo decide el servidor y nadie mas.
        if (destino) this.enviar(destino, { ...m, de: id });
      } else if (A_TODOS.includes(m.tipo)) {
        this.aLosDemas(server, { ...m, de: id });
      }
    });

    const irse = () => {
      if (!this.gente.delete(server)) return;
      this.aTodos({ tipo: 'se-fue', id });
    };
    server.addEventListener('close', irse);
    server.addEventListener('error', irse);

    return new Response(null, { status: 101, webSocket: cliente });
  }

  buscar(id) {
    for (const [ws, p] of this.gente) if (p.id === id) return ws;
    return null;
  }

  enviar(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* se fue */ }
  }

  /** A todos menos al que hablo. */
  aLosDemas(quien, msg) {
    const txt = JSON.stringify(msg);
    for (const ws of this.gente.keys()) if (ws !== quien) { try { ws.send(txt); } catch { /* se fue */ } }
  }

  aTodos(msg) {
    const txt = JSON.stringify(msg);
    for (const ws of this.gente.keys()) { try { ws.send(txt); } catch { /* se fue */ } }
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
