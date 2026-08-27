// Cliente de los torneos de comunidad. El equivalente de ranking.js, pero
// para el torneo privado de un streamer.
//
// QUE GUARDA ESTE MODULO EN EL TELEFONO Y POR QUE:
//   - `aura.torneo`  el ultimo codigo en el que jugaste. Es lo que hace que
//     volver a la pagina te devuelva a tu torneo en vez de al menu pelado.
//   - `aura.torneos` las CLAVES de organizador de los torneos que armaste vos.
//     Esa clave es lo unico que prueba que el torneo es tuyo y el servidor no
//     la vuelve a mostrar nunca: si se pierde, no hay forma de moderar ni de
//     cerrarlo. Por eso ademas se ofrece el link con la clave adentro, para
//     que quede en algun lado que no sea este navegador.

const API = (new URLSearchParams(location.search).get('api')
  || import.meta.env.VITE_API_RANKING
  || '').replace(/\/$/, '');

export const hayTorneos = () => !!API;

const CLAVE_ULTIMO = 'aura.torneo';
const CLAVE_MIOS = 'aura.torneos';

// Seis caracteres, contra los cuatro de las salas. El largo ES el tipo: el
// campo del menu es uno solo y decide adonde mandarte por como se ve el codigo.
export const codigoTorneoValido = (c) => /^[A-Z2-9]{6}$/.test(String(c || '').toUpperCase());

export const getUltimo = () => {
  try { return localStorage.getItem(CLAVE_ULTIMO) || ''; } catch { return ''; }
};
export const setUltimo = (c) => {
  try { localStorage.setItem(CLAVE_ULTIMO, c); } catch { /* incognito */ }
};

const mios = () => {
  try { return JSON.parse(localStorage.getItem(CLAVE_MIOS) || '{}'); } catch { return {}; }
};
/** La clave de organizador, si este torneo lo armaste vos en este navegador. */
export const claveDe = (codigo) => mios()[String(codigo).toUpperCase()] || '';
export const soyOrganizador = (codigo) => !!claveDe(codigo);
export function guardarClave(codigo, clave) {
  try {
    const m = mios();
    m[String(codigo).toUpperCase()] = clave;
    localStorage.setItem(CLAVE_MIOS, JSON.stringify(m));
  } catch { /* incognito: queda solo el link */ }
}

async function pedir(ruta, opciones = {}) {
  // Mismo criterio que ranking.js: sin timeout, un backend caido cuelga la
  // pantalla para siempre. AbortController a mano porque AbortSignal.timeout
  // no existe en iOS Safari < 16.
  const ac = new AbortController();
  const reloj = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(`${API}${ruta}`, { ...opciones, signal: ac.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('tardó demasiado');
    throw e;
  } finally {
    clearTimeout(reloj);
  }
}

const J = { 'content-type': 'application/json' };

/** Arma un torneo. Devuelve {codigo, clave, ...}. La clave se guarda sola. */
export async function crearTorneo({ nombre, organizador, dias, clips }) {
  const d = await pedir('/api/torneo', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ nombre, organizador, dias: Number(dias), clips: !!clips }),
  });
  guardarClave(d.codigo, d.clave);
  setUltimo(d.codigo);
  return d;
}

/** Info + tabla. `alias` opcional: si va, viene tu puesto en `yo`. */
export function verTorneo(codigo, alias = '', limite = 50) {
  const q = new URLSearchParams({ codigo: String(codigo).toUpperCase(), limite: String(limite) });
  if (alias) q.set('alias', alias.trim());
  return pedir(`/api/torneo?${q}`);
}

export function subirPuntajeTorneo({ codigo, alias, aura, moves }) {
  return pedir('/api/torneo/score', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({
      codigo: String(codigo).toUpperCase(), alias, aura: Math.round(aura), moves,
    }),
  });
}

export function borrarEntrada(codigo, alias) {
  return pedir('/api/torneo/borrar', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ codigo, alias, clave: claveDe(codigo) }),
  });
}

export function cerrarTorneo(codigo) {
  return pedir('/api/torneo/cerrar', {
    method: 'POST',
    headers: J,
    body: JSON.stringify({ codigo, clave: claveDe(codigo) }),
  });
}

/** La URL del video de alguien. Sirve para un <video src> y para fetch. */
export const urlClip = (codigo, alias) =>
  `${API}/api/torneo/clip?codigo=${encodeURIComponent(String(codigo).toUpperCase())}&alias=${encodeURIComponent(alias)}`;

/**
 * Sube el clip. Aparte de `pedir` y con XMLHttpRequest a proposito.
 *
 * DOS MOTIVOS, los dos por el tamaño: son ~5MB y en datos moviles eso puede
 * tardar bastante.
 *   - `fetch` no tiene progreso de SUBIDA (solo de bajada). Sin una barra,
 *     medio minuto sin señal de vida se lee como colgado y la gente cierra.
 *   - El timeout de 8s de `pedir` cortaria toda subida que no sea wifi.
 *
 * NADIE ESPERA A ESTO. El puntaje ya se anoto por su propia via y el puesto ya
 * esta. Si falla, se pierde el video y nada mas; por eso resuelve con un objeto
 * en vez de tirar.
 */
export function subirClip({ codigo, alias, blob, onProgreso }) {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `${API}/api/torneo/clip?codigo=${encodeURIComponent(String(codigo).toUpperCase())}&alias=${encodeURIComponent(alias)}`);
    x.setRequestHeader('content-type', blob.type || 'video/mp4');
    // Dos minutos: un clip de 5MB a 400kbps de subida son ~105 segundos, y esa
    // es una conexion mala pero real.
    x.timeout = 120000;
    x.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgreso?.(e.loaded / e.total);
    };
    x.onload = () => {
      let d = {};
      try { d = JSON.parse(x.responseText || '{}'); } catch { /* da igual */ }
      resolve(x.status >= 200 && x.status < 300
        ? { ok: true, ...d }
        : { ok: false, error: d.error || `HTTP ${x.status}` });
    };
    x.onerror = () => resolve({ ok: false, error: 'se cortó la subida' });
    x.ontimeout = () => resolve({ ok: false, error: 'la subida tardó demasiado' });
    x.send(blob);
  });
}

/** El link que reparte el organizador. Sin la clave: esa no se comparte. */
export const linkTorneo = (codigo) =>
  `${location.origin}${import.meta.env.BASE_URL}t/${String(codigo).toUpperCase()}`;

/**
 * El link del organizador, con la clave adentro.
 *
 * La clave vive en el localStorage de UN navegador. Borrar los datos del sitio,
 * cambiar de telefono o entrar en incognito y ya no hay forma de moderar ni de
 * cerrar el torneo: el servidor no la vuelve a mostrar. Este link es la copia
 * de seguridad, y hay que decirle al organizador que lo guarde.
 */
export const linkOrganizador = (codigo) => {
  const c = claveDe(codigo);
  return c ? `${linkTorneo(codigo)}?k=${c}` : linkTorneo(codigo);
};

/**
 * Lee el codigo (y la clave, si viene) de la URL.
 *
 * Dos formas porque hay dos origenes: `/t/ABC123` es el link lindo que se
 * reparte, y `?t=ABC123` es el que sobrevive a un hosting sin reescritura de
 * rutas —GitHub Pages, que sirve el espejo, devuelve 404 en /t/ y ahi el link
 * bonito no existe.
 */
export function torneoDeLaUrl() {
  const q = new URLSearchParams(location.search);
  const clave = q.get('k') || '';
  const porQuery = (q.get('t') || '').toUpperCase();
  if (codigoTorneoValido(porQuery)) return { codigo: porQuery, clave };
  const m = location.pathname.match(/\/t\/([A-Za-z0-9]{6})\/?$/);
  const porRuta = (m?.[1] || '').toUpperCase();
  if (codigoTorneoValido(porRuta)) return { codigo: porRuta, clave };
  return null;
}

/** Cuanto le queda. Texto corto, es lo que se ve arriba de la tabla. */
export function cuantoFalta(termina, ahora = Date.now()) {
  const ms = termina - ahora;
  if (ms <= 0) return 'TERMINADO';
  // Redondeado y no truncado. Un torneo de 7 días recién creado tiene 6,999
  // días por delante, y `floor` lo anunciaba como "QUEDAN 6 DÍAS" en la misma
  // pantalla donde el organizador acababa de escribir 7.
  const dias = Math.round(ms / 86400000);
  if (ms >= 86400000) return `QUEDAN ${dias} DÍA${dias === 1 ? '' : 'S'}`;
  const horas = Math.floor(ms / 3600000);
  if (horas >= 1) return `QUEDAN ${horas} HORA${horas === 1 ? '' : 'S'}`;
  const min = Math.max(1, Math.floor(ms / 60000));
  return `QUEDAN ${min} MINUTO${min === 1 ? '' : 'S'}`;
}
