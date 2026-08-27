// Cuanta gente entra, de donde y que hace. Lo lee UNA persona: el panel de
// /admin, con clave. La app nunca muestra estos numeros.
//
// POR QUE A MANO Y NO GOOGLE ANALYTICS. La pagina se sirve desde GitHub Pages,
// que no da ni un log: sin esto no hay forma de saber si entraron diez o diez
// mil. Y el Worker ya esta desplegado, ya tiene la base y ya sabe el pais de
// cada request —lo unico que faltaba era una tabla—, asi que sumar un script
// de terceros seria meter un bloqueador de anuncios en el camino, cargar 20KB
// mas en un telefono que ya esta bajando 8MB de modelo, y mandarle a otro los
// datos de los que juegan.
//
// LO QUE NO SE GUARDA: ni IP, ni user agent, ni cookie, ni nada que sirva para
// volver a la persona. Ver `visitanteDe`.

/** Lo unico que el cliente puede anotar. Lo que no este aca se tira. */
// 'torneo' es entrar a un torneo de comunidad. Va separado de 'sala' porque
// son cosas distintas: una sala son seis personas diez minutos y un torneo es
// la comunidad entera de alguien durante una semana. Mezclarlos haria ilegible
// justo el numero que dice si la funcion sirvio.
const TIPOS = ['visita', 'escaneo', 'clip', 'sala', 'torneo'];

/** Cuanto hace falta para dejar de estar "ahora". */
const VENTANA_ONLINE = 10 * 60_000;

// El contador de online lo pide TODO el que abre el menu, cada medio minuto.
// Sin este cache eso es una consulta a D1 por persona por vuelta; con el, es
// una cada ocho segundos por isolate, y el numero igual se siente vivo.
let cache = { hasta: 0, dato: null };

/**
 * Quien es esta persona, sin saber quien es.
 *
 * SHA-256 de (sal + dia + IP + user agent). La sal es un secreto del Worker,
 * asi que ni con la tabla en la mano se puede probar que una IP estuvo aca. Y
 * como el DIA entra en la mezcla, el hash se renueva solo cada medianoche: da
 * para contar personas distintas dentro de un dia y no da para seguir a nadie
 * de un dia al otro. Es la misma idea que usa Plausible.
 */
async function visitanteDe(req, env, dia) {
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const ua = req.headers.get('User-Agent') || '';
  const mezcla = `${env.SAL_VISITANTE || 'sin-sal'}|${dia}|${ip}|${ua}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(mezcla));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * De donde vino. El header `Referer` del propio POST no sirve —dice la pagina
 * del juego, no de donde llego—, asi que el origen lo manda el cliente desde
 * `document.referrer`. Como viene de afuera, se recorta y se limpia: termina
 * en una tabla que se pinta como HTML.
 */
function limpiarRef(crudo) {
  const s = String(crudo || '').trim().toLowerCase();
  if (!s) return 'directo';
  return s.replace(/[^a-z0-9.\-_/]/g, '').slice(0, 40) || 'directo';
}

/**
 * Anota un evento. No devuelve nada util a proposito: el cliente lo manda y se
 * olvida, y si la analitica falla no se entera nadie.
 */
export async function anotar(req, env, { pais, region, hoy, cuerpo }) {
  const body = (() => { try { return JSON.parse(cuerpo); } catch { return null; } })();
  const tipo = TIPOS.includes(body?.tipo) ? body.tipo : null;
  if (!tipo) return;

  const ts = Date.now();
  await env.DB.prepare(
    `INSERT INTO eventos (tipo, visitante, pais, region, ref, dia, semana, ts)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(
    tipo,
    await visitanteDe(req, env, hoy.dia),
    pais,
    region,
    tipo === 'visita' ? limpiarRef(body.ref) : 'directo',
    hoy.dia,
    hoy.semana,
    ts,
  ).run();
}

/**
 * Cuanta gente hay del otro lado AHORA MISMO.
 *
 * Son dos numeros distintos y los dos importan: `jugando` es cualquiera que
 * hizo algo en los ultimos diez minutos (sale de los eventos), y `cola` es
 * cuantos estan esperando rival en este segundo (lo sabe el Lobby, que los
 * tiene conectados). El segundo es el que evita que alguien se quede noventa
 * segundos esperando a nadie.
 */
export async function online(env) {
  const ahora = Date.now();
  if (cache.dato && ahora < cache.hasta) return cache.dato;

  const [act, lob] = await Promise.all([
    env.DB.prepare('SELECT COUNT(DISTINCT visitante) AS n FROM eventos WHERE ts > ?')
      .bind(ahora - VENTANA_ONLINE).first().catch(() => null),
    // Al Lobby se le pregunta por HTTP comun, sin websocket: es el mismo
    // objeto que tiene la cola en memoria, asi que el numero es exacto.
    env.LOBBY.get(env.LOBBY.idFromName('cola')).fetch('https://lobby/cuantos')
      .then((r) => r.json()).catch(() => null),
  ]);

  const dato = { jugando: act?.n ?? 0, cola: lob?.cola ?? 0 };
  cache = { hasta: ahora + 8000, dato };
  return dato;
}

/** Comparacion que tarda lo mismo acierte o no, para no filtrar la clave. */
function igual(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export function esAdmin(req, env) {
  return !!env.ADMIN_CLAVE && igual(req.headers.get('x-clave'), env.ADMIN_CLAVE);
}

const diaHace = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/**
 * Todo lo que muestra el panel, en UNA sola ida a la base.
 *
 * `SUM(tipo = 'x')` cuenta filas que cumplen la condicion: en SQLite el
 * booleano ES un 1 o un 0. Sale mas corto que un CASE y hace lo mismo.
 */
export async function resumen(env) {
  const semana = diaHace(7);
  const [dias, paises, refs, torneo, ahora, total] = await env.DB.batch([
    env.DB.prepare(
      `SELECT dia,
              COUNT(DISTINCT visitante) AS gente,
              SUM(tipo = 'visita')  AS visitas,
              SUM(tipo = 'escaneo') AS escaneos,
              SUM(tipo = 'clip')    AS clips,
              SUM(tipo = 'sala')    AS salas,
              SUM(tipo = 'torneo')  AS torneos
         FROM eventos GROUP BY dia ORDER BY dia DESC LIMIT 30`
    ),
    env.DB.prepare(
      `SELECT pais, COUNT(DISTINCT visitante) AS gente
         FROM eventos WHERE dia >= ? GROUP BY pais ORDER BY gente DESC LIMIT 15`
    ).bind(semana),
    env.DB.prepare(
      `SELECT ref, COUNT(*) AS n
         FROM eventos WHERE tipo = 'visita' AND dia >= ? GROUP BY ref ORDER BY n DESC LIMIT 12`
    ).bind(semana),
    env.DB.prepare(
      `SELECT dia, COUNT(*) AS partidas, COUNT(DISTINCT alias_key) AS jugadores
         FROM runs GROUP BY dia ORDER BY dia DESC LIMIT 30`
    ),
    env.DB.prepare('SELECT COUNT(DISTINCT visitante) AS n FROM eventos WHERE ts > ?')
      .bind(Date.now() - VENTANA_ONLINE),
    env.DB.prepare('SELECT COUNT(*) AS eventos, MIN(ts) AS desde FROM eventos'),
  ]);

  return {
    dias: dias.results || [],
    paises: paises.results || [],
    refs: refs.results || [],
    torneo: torneo.results || [],
    ahora: ahora.results?.[0]?.n ?? 0,
    total: total.results?.[0] || { eventos: 0, desde: null },
  };
}
