// Contar cuanta gente entra, sin contarle nada a nadie mas.
//
// La pagina vive en GitHub Pages, que no da un solo log: sin esto no hay forma
// de saber si entraron diez personas o diez mil. Lo que se manda es una
// palabra ("entre", "escanee", "baje el clip") y nada mas: el servidor no
// guarda IP ni cookie, ver worker/src/analitica.js.
//
// PORQUE NO ESTA EN ranking.js: eso es el torneo y la app funciona sin torneo.
// Esto es medicion, y tiene una regla propia —no puede romper NADA, ni frenar
// una pantalla, ni tirar un error a la consola de nadie—, asi que cada llamada
// se traga sus propios fallos.

const API = (new URLSearchParams(location.search).get('api')
  || import.meta.env.VITE_API_RANKING
  || '').replace(/\/$/, '');

const CLAVE_SESION = 'aura.visto';
const CLAVE_PRIMERA = 'aura.primera';   // el dia de la primera vez, en localStorage

// Techo de eventos por sesion. Una partida son cuatro o cinco; con esto, una
// pestaña abierta toda la tarde jugando sigue sin escribir cien filas.
const TOPE = 20;
let mandados = 0;

/**
 * De donde llego. `document.referrer` viene vacio en el navegador de
 * Instagram (abre sin referrer), asi que ademas se mira un `?ref=` o
 * `?utm_source=` en la URL: eso es lo que se le pega al link cuando se
 * comparte, y es lo unico que distingue un pico de IG de uno de WhatsApp.
 */
function deDonde() {
  const q = new URLSearchParams(location.search);
  const marca = q.get('ref') || q.get('utm_source');
  if (marca) return marca.slice(0, 40);
  try {
    const h = new URL(document.referrer).hostname.replace(/^www\./, '');
    return h && h !== location.hostname ? h : '';
  } catch { return ''; }
}

/**
 * Anota algo. No se espera: `keepalive` deja el request vivo aunque la pestaña
 * se cierre en el mismo momento, y el cuerpo va como texto plano a proposito
 * —con `application/json` el navegador manda un OPTIONS antes y serian dos
 * requests por cada evento.
 */
export function hit(tipo, extra = {}) {
  if (!API || mandados >= TOPE) return;
  mandados++;
  try {
    fetch(`${API}/api/hit`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ tipo, ref: tipo === 'visita' ? deDonde() : '', ...extra }),
      keepalive: true,
    }).catch(() => { /* que se pierda */ });
  } catch { /* que se pierda */ }
}

/**
 * Si esta persona ya habia entrado antes. La marca vive en SU telefono y lo
 * unico que sale de ahi es un si o un no.
 *
 * El servidor no puede saberlo solo: el hash del visitante cambia todas las
 * noches justamente para que no se pueda seguir a nadie de un dia al otro. Con
 * esto se sabe CUANTOS vuelven sin saber QUIENES, que es lo que se queria.
 *
 * En incognito localStorage tira o se vacia al cerrar: ahi todos cuentan como
 * nuevos. Sesga el numero para abajo, y es mejor que inventarlo.
 */
function yaHabiaEntrado() {
  try {
    const antes = localStorage.getItem(CLAVE_PRIMERA);
    if (antes) return true;
    localStorage.setItem(CLAVE_PRIMERA, new Date().toISOString().slice(0, 10));
  } catch { /* incognito */ }
  return false;
}

/**
 * La visita se cuenta UNA vez por pestaña. Sin esto, cada "otra vez" que
 * recarga o cada vuelta al menu sumaria una visita nueva y el numero de gente
 * quedaria inflado justo el dia que importa que sea cierto.
 */
export function contarVisita() {
  try {
    if (sessionStorage.getItem(CLAVE_SESION)) return;
    sessionStorage.setItem(CLAVE_SESION, '1');
  } catch { /* modo incognito: se cuenta igual */ }
  // El orden importa: `yaHabiaEntrado` ESCRIBE la marca la primera vez, asi
  // que tiene que correr una sola vez por sesion o la segunda pestaña del
  // mismo dia ya se contaria como alguien que vuelve.
  hit('visita', { vuelve: yaHabiaEntrado() });
}

/**
 * Cuanta gente hay del otro lado: `jugando` son los activos de los ultimos
 * diez minutos y `cola` los que estan esperando rival AHORA. Devuelve null si
 * no se pudo: el menu simplemente no muestra la linea.
 */
export async function online() {
  if (!API) return null;
  const ac = new AbortController();
  const reloj = setTimeout(() => ac.abort(), 4000);
  try {
    const r = await fetch(`${API}/api/online`, { signal: ac.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(reloj); }
}
