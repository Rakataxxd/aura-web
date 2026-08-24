// Batalla online: sala de hasta seis, verse las caras y comparar aura en vivo.
//
// DOS CANALES, A PROPOSITO:
//   - el WebSocket contra el Worker lleva el ESTADO DEL JUEGO (quien esta,
//     cuando arranca, el aura en vivo, el resultado),
//   - WebRTC lleva SOLO video y audio, peer to peer.
// Asi la partida funciona aunque el video nunca conecte, que entre dos NAT
// hostiles y sin servidor TURN pasa seguido. Se pierde verse la cara, no la
// partida. Al reves —todo por el data channel de WebRTC— una negociacion
// fallida se llevaba puesto el partido entero.
//
// MALLA, NO SERVIDOR DE MEDIA. Cada uno se conecta con cada uno: seis
// personas son cinco conexiones por cabeza. Un SFU (un servidor que recibe
// una copia y reparte) escalaria mucho mejor, pero cuesta plata y hay que
// mantenerlo; a seis todavia aguanta una malla si se le baja el bitrate a
// medida que entra gente, que es lo que hace `calidad()`.

const HTTP = (new URLSearchParams(location.search).get('api')
  || import.meta.env.VITE_API_RANKING
  || '').replace(/\/$/, '');
const WS = HTTP.replace(/^http/, 'ws');

export const hayVersus = () => !!HTTP;

export const TOPE_SALA = 6;

/** Motivo de rechazo cuando la busqueda la corto el propio jugador. */
export const CANCELADO = 'cancelado';

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

/**
 * Cuanto ancho de banda le toca a cada conexion segun cuanta gente hay.
 *
 * Sin esto, seis personas en malla mandan seis veces el mismo video a
 * calidad completa y el telefono se queda sin encoder antes que sin red: la
 * deteccion de pose, que es LO QUE HACE AL JUEGO, empieza a perder cuadros.
 */
// Los números subieron cuando el clip de la sala pasó a grabar las cámaras de
// TODOS: lo que antes era un recuadro de 200px al costado ahora queda guardado
// en un archivo de 1280x720. A 180kbps y con la resolución partida al medio,
// una sala de cuatro daba una repetición que no se podía ni mirar. El techo
// sigue siendo el encoder del teléfono, no la red: con cinco conexiones esto
// son ~1.3Mbps de subida, que es lo que hace cualquier videollamada.
function presupuesto(n) {
  if (n <= 1) return { bits: 800_000, fps: 30, escala: 1 };
  if (n <= 3) return { bits: 450_000, fps: 24, escala: 1.25 };
  return { bits: 260_000, fps: 20, escala: 1.5 };
}

export class Batalla {
  /**
   * @param {object} cb
   *   onGente()                cambio quien esta en la sala (entro, salio, cambio el alias)
   *   onVideo(id, stream|null) llego (o se cayo) el media de alguien
   *   onAura(id, v)            aura en vivo
   *   onFin(id, {aura, moves}) alguien cerro su ronda
   *   onArranca()              el anfitrion dio la orden
   *   onEstado(e)              'llena' | 'error' | 'cerrado'
   */
  constructor(cb = {}) {
    this.cb = cb;
    this.ws = null;
    this.cola = null;           // socket de la cola de emparejamiento
    this.pares = new Map();     // id -> par
    this.id = 0;
    this.max = TOPE_SALA;
    this.codigo = null;
    this.salida = null;         // MediaStream propio (camara, y micro si lo prenden)
    this.micro = null;          // MediaStreamTrack de audio, o null
    this.microOn = false;       // lo que ven los demas en mi recuadro
    this.vivo = false;
    this.ultimoEnvio = 0;
  }

  // ---------- quien esta ----------

  lista() { return [...this.pares.values()].sort((a, b) => a.id - b.id); }

  /** Anfitrion es el id mas chico que sigue conectado: si se va, hay otro. */
  soyAnfitrion() { return this.lista().every((p) => p.id > this.id); }

  cuantos() { return this.pares.size + 1; }

  par(id, alias) {
    let p = this.pares.get(id);
    if (!p) {
      p = { id, alias: '', pc: null, audioTx: null, stream: null, aura: 0, fin: null, micro: false, hielos: [] };
      this.pares.set(id, p);
    }
    if (alias) p.alias = String(alias);
    return p;
  }

  // ---------- entrar ----------

  /**
   * Cola de desconocidos: devuelve el codigo que reparte el servidor.
   *
   * El socket se guarda para poder SALIRSE. Esperar en una cola sin boton de
   * cancelar son noventa segundos de rehen, y el unico escape era recargar.
   *
   * @param {(cuantos: {delante: number, esperando: number}) => void} [onCola]
   *   Cuanta gente hay esperando. El servidor lo AVISA cada vez que cambia,
   *   por el mismo socket: esperar sin saber si hay alguien mas del otro lado
   *   es lo que hace que la gente se vaya antes de que aparezca nadie.
   */
  buscarRival(onCola) {
    this.cancelarBusqueda();
    return new Promise((res, rej) => {
      const ws = this.cola = new WebSocket(`${WS}/api/cola`);
      let emparejado = false;
      const corte = setTimeout(() => {
        rej(new Error('nadie apareció'));
        this.cancelarBusqueda();
      }, 90000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.tipo === 'en-cola') {
          onCola?.({ delante: m.delante || 0, esperando: m.esperando || 1 });
          return;
        }
        if (m.tipo !== 'emparejado') return;
        emparejado = true;
        clearTimeout(corte);
        this.cola = null;
        res(m.codigo);
      };
      ws.onerror = () => { clearTimeout(corte); if (!emparejado) rej(new Error('no se pudo entrar a la cola')); };
      // El servidor cierra el socket apenas empareja: ese cierre NO es un
      // fallo. Cualquier otro si, y ahi el que corta es siempre el de acá.
      ws.onclose = () => { clearTimeout(corte); if (!emparejado) rej(new Error(CANCELADO)); };
    });
  }

  cancelarBusqueda() {
    try { this.cola?.close(); } catch { /* ya */ }
    this.cola = null;
  }

  /** @param {{salida?: MediaStream, alias?: string, max?: number}} opciones */
  entrar(codigo, { salida = null, alias = '', max = TOPE_SALA } = {}) {
    this.codigo = String(codigo).toUpperCase();
    this.salida = salida;
    this.vivo = true;

    const q = new URLSearchParams({ codigo: this.codigo, max: String(max) });
    if (alias) q.set('alias', alias);
    const ws = this.ws = new WebSocket(`${WS}/api/sala?${q}`);
    ws.onmessage = (ev) => { try { this.recibir(JSON.parse(ev.data)); } catch (e) { console.warn('[versus]', e?.message); } };
    ws.onerror = () => { if (this.vivo) this.cb.onEstado?.('error'); };
    ws.onclose = (ev) => {
      console.info('[versus] se cerro el socket', ev.code, ev.reason, { vivo: this.vivo });
      if (!this.vivo) return;
      this.vivo = false;
      this.cb.onEstado?.('cerrado');
    };
  }

  // ---------- protocolo ----------

  async recibir(m) {
    switch (m.tipo) {
      case 'entraste':
        this.id = m.id;
        this.max = m.max || TOPE_SALA;
        // A los que ya estaban NO les ofrezco yo: sus id son menores, o sea
        // que a ellos les toca ofrecerme. Aca solo se anotan.
        for (const p of m.pares || []) this.par(p.id, p.alias);
        this.cb.onGente?.();
        break;

      case 'llego': {
        const par = this.par(m.id, m.alias);
        // Yo ya estaba (mi id es menor), asi que ofrezco yo.
        if (this.id < par.id) await this.conectar(par, true);
        this.calidadTodos();
        // El que llega no sabe quien tiene el micro prendido: nadie le manda
        // el estado de antes de que entrara. Se lo re-anuncian todos ahora.
        this.avisarMicro();
        this.cb.onGente?.();
        break;
      }

      case 'se-fue': {
        const par = this.pares.get(m.id);
        if (par) {
          try { par.pc?.close(); } catch { /* ya */ }
          this.pares.delete(m.id);
        }
        this.calidadTodos();
        this.cb.onGente?.();
        break;
      }

      case 'llena':
        this.vivo = false;
        this.cb.onEstado?.('llena');
        break;

      case 'oferta': {
        const par = this.par(m.de);
        const pc = await this.conectar(par, false);
        await pc.setRemoteDescription(m.sdp);
        await this.volcarHielos(par);
        const resp = await pc.createAnswer();
        await pc.setLocalDescription(resp);
        this.mandar({ tipo: 'respuesta', para: par.id, sdp: pc.localDescription });
        break;
      }

      case 'respuesta': {
        const par = this.pares.get(m.de);
        if (!par?.pc) break;
        await par.pc.setRemoteDescription(m.sdp);
        await this.volcarHielos(par);
        break;
      }

      case 'ice': {
        const par = this.par(m.de);
        // Un candidato que llega antes de la descripcion remota tira. Sobre
        // un WebSocket ordenado no deberia pasar (la oferta sale primero),
        // pero guardarlo cuesta un array y ahorra una conexion perdida.
        if (!par.pc?.remoteDescription) { par.hielos.push(m.candidato); break; }
        try { await par.pc.addIceCandidate(m.candidato); } catch { /* fuera de orden */ }
        break;
      }

      case 'arranca':
        this.cb.onArranca?.();
        break;

      case 'micro': {
        const par = this.pares.get(m.de);
        if (!par) break;
        par.micro = !!m.on;
        this.cb.onGente?.();
        break;
      }

      case 'aura': {
        const par = this.pares.get(m.de);
        if (!par) break;
        par.aura = Number(m.v) || 0;
        this.cb.onAura?.(par.id, par.aura);
        break;
      }

      case 'fin': {
        const par = this.pares.get(m.de);
        if (!par) break;
        par.fin = {
          aura: Number(m.aura) || 0,
          moves: Array.isArray(m.moves) ? m.moves.filter((x) => typeof x === 'string').slice(0, 12) : [],
        };
        this.cb.onFin?.(par.id, par.fin);
        break;
      }
    }
  }

  async volcarHielos(par) {
    const pendientes = par.hielos.splice(0);
    for (const c of pendientes) {
      try { await par.pc.addIceCandidate(c); } catch { /* fuera de orden */ }
    }
  }

  // ---------- WebRTC ----------

  async conectar(par, ofrecer) {
    if (par.pc) return par.pc;
    const pc = par.pc = new RTCPeerConnection({ iceServers: HIELO });

    const video = this.salida?.getVideoTracks?.() ?? [];
    if (video.length) for (const t of video) pc.addTrack(t, this.salida);
    else pc.addTransceiver('video', { direction: 'recvonly' });

    // El hueco del audio se abre SIEMPRE, con o sin microfono todavia.
    //
    // Es la unica forma de que prender el micro despues NO renegocie: con el
    // transceiver ya negociado, poner el track es un replaceTrack y listo.
    // Renegociar en malla es justo donde aparecen las colisiones de oferta
    // (los dos ofrecen a la vez y la conexion no cierra nunca), y ademas
    // habria que decidir quien ofrece cuando el que prende el micro es el
    // que NO tiene el rol de oferente.
    par.audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    if (this.micro) { try { await par.audioTx.sender.replaceTrack(this.micro); } catch { /* ya se ira */ } }

    pc.onicecandidate = (e) => { if (e.candidate) this.mandar({ tipo: 'ice', para: par.id, candidato: e.candidate }); };

    // El stream remoto se arma ACA y no se toma de `e.streams[0]`: un track
    // puesto con replaceTrack sobre un transceiver que se negocio vacio llega
    // sin msid, o sea sin stream asociado, y el audio del micro no sonaba
    // nunca. Armandolo a mano, video y audio caen siempre en el mismo stream.
    pc.ontrack = (e) => {
      par.stream ||= new MediaStream();
      if (!par.stream.getTracks().includes(e.track)) par.stream.addTrack(e.track);
      this.cb.onVideo?.(par.id, par.stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.calidad(pc);
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.cb.onVideo?.(par.id, null);
    };

    if (ofrecer) {
      const oferta = await pc.createOffer();
      await pc.setLocalDescription(oferta);
      this.mandar({ tipo: 'oferta', para: par.id, sdp: pc.localDescription });
    }
    return pc;
  }

  calidad(pc) {
    const { bits, fps, escala } = presupuesto(this.pares.size);
    for (const s of pc.getSenders()) {
      if (s.track?.kind !== 'video') continue;
      try {
        const p = s.getParameters();
        p.encodings = p.encodings?.length ? p.encodings : [{}];
        p.encodings[0].maxBitrate = bits;
        p.encodings[0].maxFramerate = fps;
        p.encodings[0].scaleResolutionDownBy = escala;
        s.setParameters(p).catch(() => { /* el navegador manda */ });
      } catch { /* firefox viejo no deja tocar encodings */ }
    }
  }

  calidadTodos() {
    for (const p of this.pares.values()) if (p.pc) this.calidad(p.pc);
  }

  /** Pone (o saca) el track del microfono en todas las conexiones, sin renegociar. */
  async ponerMicro(track) {
    this.micro = track || null;
    for (const p of this.pares.values()) {
      try { await p.audioTx?.sender.replaceTrack(this.micro); } catch { /* conexion muerta */ }
    }
  }

  /** Avisa si estoy hablando o mudo, para el iconito del recuadro ajeno. */
  avisarMicro(on) {
    if (on !== undefined) this.microOn = !!on;
    this.mandar({ tipo: 'micro', on: this.microOn });
  }

  mandar(m) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  // ---------- durante la partida ----------

  /** La orden la da el anfitrion, para que no haya dos cuentas regresivas. */
  arrancar() {
    if (!this.vivo || !this.soyAnfitrion()) return false;
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

  /** Deja la sala lista para otra ronda sin desconectar a nadie. */
  limpiarRonda() {
    for (const p of this.pares.values()) { p.fin = null; p.aura = 0; }
  }

  cerrar() {
    this.vivo = false;
    this.cancelarBusqueda();
    for (const p of this.pares.values()) { try { p.pc?.close(); } catch { /* ya */ } }
    this.pares.clear();
    try { this.ws?.close(); } catch { /* ya */ }
    this.ws = null;
    this.micro = null;
  }
}
