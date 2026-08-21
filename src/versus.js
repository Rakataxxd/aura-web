// Batalla online: emparejar, verse las caras y comparar aura en vivo.
//
// DOS CANALES, A PROPOSITO:
//   - el WebSocket contra el Worker lleva el ESTADO DEL JUEGO (listos,
//     arranca, aura en vivo, resultado),
//   - WebRTC lleva SOLO el video, peer to peer.
// Asi la partida funciona aunque el video nunca conecte, que entre dos NAT
// hostiles y sin servidor TURN pasa seguido. Se pierde verse la cara, no la
// partida. Al reves —todo por el data channel de WebRTC— una negociacion
// fallida se llevaba puesto el partido entero.

const HTTP = (new URLSearchParams(location.search).get('api')
  || import.meta.env.VITE_API_RANKING
  || '').replace(/\/$/, '');
const WS = HTTP.replace(/^http/, 'ws');

export const hayVersus = () => !!HTTP;

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin O/0/I/1: se dictan por telefono
export const codigoValido = (c) => /^[A-Z2-9]{4}$/.test(String(c || '').toUpperCase());

export function codigoNuevo() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return [...b].map((x) => ALFABETO[x % ALFABETO.length]).join('');
}

// STUN publicos. Alcanzan para la mayoria de las redes domesticas; detras de
// un NAT simetrico (datos moviles seguido) hace falta TURN, que cuesta plata.
// Por eso el juego no depende del video.
const HIELO = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

export class Batalla {
  /**
   * @param {object} cb
   *   onEstado(estado, extra)  'buscando'|'esperando'|'listos'|'arranca'|'rival-se-fue'|'llena'|'error'
   *   onAuraRival(v)
   *   onFinRival({aura, moves})
   *   onVideoRival(MediaStream|null)
   */
  constructor(cb = {}) {
    this.cb = cb;
    this.ws = null;
    this.pc = null;
    this.rol = null;
    this.codigo = null;
    this.stream = null;
    this.vivo = false;
    this.ultimoEnvio = 0;
  }

  // ---------- entrar ----------

  /** Cola de desconocidos: devuelve el codigo que reparte el servidor. */
  buscarRival() {
    this.cb.onEstado?.('buscando');
    return new Promise((res, rej) => {
      const ws = new WebSocket(`${WS}/api/cola`);
      const corte = setTimeout(() => { try { ws.close(); } catch { /* ya */ } rej(new Error('nadie apareció')); }, 90000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.tipo !== 'emparejado') return;
        clearTimeout(corte);
        res(m.codigo);
      };
      ws.onerror = () => { clearTimeout(corte); rej(new Error('no se pudo entrar a la cola')); };
      ws.onclose = () => clearTimeout(corte);
    });
  }

  /** Entra a una sala por codigo. `stream` es la camara local, para el video. */
  entrar(codigo, stream) {
    this.codigo = String(codigo).toUpperCase();
    this.stream = stream;
    this.vivo = true;
    this.cb.onEstado?.('esperando', { codigo: this.codigo });

    const ws = this.ws = new WebSocket(`${WS}/api/sala?codigo=${this.codigo}`);
    ws.onmessage = (ev) => this.recibir(JSON.parse(ev.data));
    ws.onerror = () => this.cb.onEstado?.('error', { motivo: 'se cortó la conexión' });
    ws.onclose = (ev) => {
      console.info('[versus] se cerro el socket', ev.code, ev.reason, { vivo: this.vivo });
      if (this.vivo) this.cb.onEstado?.('rival-se-fue');
    };
  }

  // ---------- protocolo ----------

  async recibir(m) {
    switch (m.tipo) {
      case 'entraste':
        this.rol = m.rol;
        break;
      case 'llena':
        this.vivo = false;
        this.cb.onEstado?.('llena');
        break;
      case 'listos':
        this.cb.onEstado?.('listos', { rol: this.rol });
        // El anfitrion es SIEMPRE el que ofrece. Si los dos ofrecen a la vez
        // la negociacion entra en colision y no cierra nunca.
        if (this.rol === 'anfitrion') this.negociar();
        break;
      case 'oferta': {
        const pc = this.pc || this.crearPC();
        await pc.setRemoteDescription(m.sdp);
        const resp = await pc.createAnswer();
        await pc.setLocalDescription(resp);
        this.mandar({ tipo: 'respuesta', sdp: pc.localDescription });
        break;
      }
      case 'respuesta':
        await this.pc?.setRemoteDescription(m.sdp);
        break;
      case 'ice':
        // Un candidato que llega antes de la descripcion remota tira; no
        // importa, ICE reintenta con los siguientes.
        try { await this.pc?.addIceCandidate(m.candidato); } catch { /* fuera de orden */ }
        break;
      case 'arranca':
        this.cb.onEstado?.('arranca');
        break;
      case 'aura':
        this.cb.onAuraRival?.(m.v);
        break;
      case 'fin':
        console.info('[versus] llego el fin del rival', m.aura);
        this.cb.onFinRival?.({ aura: m.aura, moves: m.moves || [] });
        break;
      case 'rival-entro':
        break;
      case 'rival-se-fue':
        this.cb.onEstado?.('rival-se-fue');
        break;
    }
  }

  crearPC() {
    const pc = this.pc = new RTCPeerConnection({ iceServers: HIELO });
    for (const t of this.stream?.getVideoTracks?.() || []) pc.addTrack(t, this.stream);
    pc.onicecandidate = (e) => { if (e.candidate) this.mandar({ tipo: 'ice', candidato: e.candidate }); };
    pc.ontrack = (e) => this.cb.onVideoRival?.(e.streams[0]);
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.cb.onVideoRival?.(null);
    };
    return pc;
  }

  async negociar() {
    const pc = this.crearPC();
    const oferta = await pc.createOffer({ offerToReceiveVideo: true });
    await pc.setLocalDescription(oferta);
    this.mandar({ tipo: 'oferta', sdp: pc.localDescription });
  }

  mandar(m) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  // ---------- durante la partida ----------

  /** Solo el anfitrion arranca, para que no haya dos cuentas regresivas. */
  arrancar() {
    if (this.rol !== 'anfitrion') return false;
    this.mandar({ tipo: 'arranca' });
    return true;
  }

  /** El aura viaja a lo sumo 5 veces por segundo: es un numero en pantalla. */
  aura(v) {
    const ahora = performance.now();
    if (ahora - this.ultimoEnvio < 200) return;
    this.ultimoEnvio = ahora;
    this.mandar({ tipo: 'aura', v: Math.round(v) });
  }

  fin(aura, moves) {
    this.mandar({ tipo: 'fin', aura: Math.round(aura), moves });
  }

  saltar() {
    this.mandar({ tipo: 'saltar' });
    this.cerrar();
  }

  cerrar() {
    this.vivo = false;
    try { this.pc?.close(); } catch { /* ya */ }
    try { this.ws?.close(); } catch { /* ya */ }
    this.pc = null;
    this.ws = null;
    this.cb.onVideoRival?.(null);
  }
}
