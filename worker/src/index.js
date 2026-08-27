// Ranking del ESCÁNER DE AURA. Cloudflare Worker + D1.
//
// POR QUE CLOUDFLARE Y NO OTRA COSA: los rankings nacional y regional
// necesitan saber de donde juega cada uno. Cloudflare ya lo sabe —
// `request.cf.country` y `request.cf.region` vienen en TODOS los requests,
// gratis y sin pedirle permiso de ubicacion a nadie. Con cualquier otro
// backend habria que sumar un servicio de IP (una dependencia mas, con
// cuota) o hacer que el jugador elija su pais a mano (que se miente solo).
//
// Endpoints:
//   POST /api/score    {alias, aura, moves} -> {ok, puestos:{...}}
//   GET  /api/ranking?ambito=global|pais|region&periodo=dia|semana|historico
//                     [&alias=x] [&limite=50]
//   GET  /api/salud
//   GET  /api/online   -> {jugando, cola}      cuanta gente hay del otro lado
//   POST /api/hit      {tipo, ref}             analitica, ver analitica.js
//   GET  /api/admin/stats                      privado, header x-clave
//   GET  /admin                                el panel que lee eso
//   WS   /api/cola                              cola de desconocidos (1v1)
//   WS   /api/sala?codigo=XXXX[&max=N][&alias=x] sala de hasta 6
//
//   Torneos de comunidad (ver torneos.js). El codigo es de SEIS caracteres,
//   contra los cuatro de las salas: el largo es lo que distingue uno de otro.
//   POST /api/torneo         {nombre, organizador, dias, clips} -> {codigo, clave}
//   GET  /api/torneo?codigo=XXXXXX[&alias=x][&limite=50]
//   POST /api/torneo/score   {codigo, alias, aura, moves}
//   PUT  /api/torneo/clip?codigo=X&alias=Y    el video, crudo en el cuerpo
//   GET  /api/torneo/clip?codigo=X&alias=Y    para verlo
//   POST /api/torneo/borrar  {codigo, alias, clave}    moderar
//   POST /api/torneo/cerrar  {codigo, clave}           terminarlo antes

import { Sala, Lobby, codigoValido } from './salas.js';
import { anotar, online, esAdmin, resumen } from './analitica.js';
import { PANEL } from './panel.js';
import * as torneos from './torneos.js';
export { Sala, Lobby };

const LIMITE_MAX = 100;
// Techo de cordura. Una ronda son 15 segundos: ni bailando como un demonio
// se llega a esto. Todo lo de arriba es alguien tocando el fetch a mano.
const AURA_MAX = 100_000_000;

const ALIAS_OK = /^[\p{L}\p{N} ._-]{2,14}$/u;

const json = (data, req, env, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors(req, env) },
  });

const origenes = (env) => (env.ORIGENES || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Quien puede pegarle. Se compara EXACTO contra el header Origin. */
const origenOk = (req, env) => origenes(env).includes(req.headers.get('Origin') || '');

function cors(req, env) {
  const origen = req.headers.get('Origin') || '';
  const permitidos = origenes(env);
  // Sin comodin: `*` con un origen concreto igual funcionaria, pero dejar la
  // lista explicita es lo que evita que cualquier pagina escriba puntajes.
  const ok = permitidos.includes(origen);
  return {
    'access-control-allow-origin': ok ? origen : permitidos[0] || '',
    // PUT es el del video del torneo: se manda crudo en el cuerpo, no como
    // formulario, asi que el navegador le pide permiso al servidor por metodo.
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

/** YYYY-MM-DD y YYYY-Www en UTC. Se guardan al escribir, ver schema.sql. */
function periodos(ms) {
  const d = new Date(ms);
  const dia = d.toISOString().slice(0, 10);
  // Semana ISO: jueves de la misma semana manda el año.
  const j = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  j.setUTCDate(j.getUTCDate() + 4 - (j.getUTCDay() || 7));
  const ini = new Date(Date.UTC(j.getUTCFullYear(), 0, 1));
  const n = Math.ceil(((j - ini) / 86400000 + 1) / 7);
  return { dia, semana: `${j.getUTCFullYear()}-W${String(n).padStart(2, '0')}` };
}

/** Alias normalizado: es la clave por la que se agrupa el mejor puntaje. */
const clave = (alias) => alias.trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/**
 * WHERE + parametros de un ambito/periodo. Devolver los dos juntos es lo que
 * mantiene la consulta parametrizada: concatenar el pais en el SQL seria
 * inyeccion servida en bandeja.
 */
function filtro({ ambito, periodo, pais, region, hoy }) {
  const cond = [];
  const args = [];
  if (periodo === 'dia') { cond.push('dia = ?'); args.push(hoy.dia); }
  else if (periodo === 'semana') { cond.push('semana = ?'); args.push(hoy.semana); }
  if (ambito === 'pais' || ambito === 'region') { cond.push('pais = ?'); args.push(pais); }
  if (ambito === 'region') { cond.push('region = ?'); args.push(region); }
  return { where: cond.length ? `WHERE ${cond.join(' AND ')}` : '', args };
}

/**
 * Top N por alias.
 *
 * El `MAX(aura)` con columnas sueltas en el SELECT es una garantia
 * DOCUMENTADA de SQLite: cuando hay un solo min/max agregado, las demas
 * columnas salen de la fila que gano. Por eso el pais y la fecha que se
 * muestran son los de la partida record y no los de una fila cualquiera.
 */
async function tabla(env, f, limite) {
  const { results } = await env.DB.prepare(
    `SELECT alias, MAX(aura) AS aura, pais, region, moves, ts
       FROM runs ${f.where}
       GROUP BY alias_key
       ORDER BY aura DESC
       LIMIT ?`
  ).bind(...f.args, limite).all();
  return (results || []).map((r, i) => ({ ...r, puesto: i + 1 }));
}

/**
 * Puesto de un alias: cuantos LE GANAN, mas uno. Se cuenta sobre el mejor de
 * cada alias, no sobre las filas sueltas, o alguien con veinte partidas
 * flojas empujaria a todo el mundo para abajo.
 */
async function puestoDe(env, f, aliasKey) {
  const mio = await env.DB.prepare(
    `SELECT MAX(aura) AS aura FROM runs ${f.where}${f.where ? ' AND' : ' WHERE'} alias_key = ?`
  ).bind(...f.args, aliasKey).first();
  if (!mio || mio.aura == null) return null;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT MAX(aura) AS a FROM runs ${f.where} GROUP BY alias_key
     ) WHERE a > ?`
  ).bind(...f.args, mio.aura).first();
  const total = await env.DB.prepare(
    `SELECT COUNT(DISTINCT alias_key) AS n FROM runs ${f.where}`
  ).bind(...f.args).first();
  return { puesto: (row?.n ?? 0) + 1, aura: mio.aura, total: total?.n ?? 0 };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });
    if (url.pathname === '/api/salud') return json({ ok: true }, req, env);

    // El panel se sirve sin clave porque sin clave no trae ningun dato: lo que
    // se pide con la clave es /api/admin/stats, y eso pasa por `esAdmin`.
    if (url.pathname === '/admin') {
      return new Response(PANEL, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' },
      });
    }
    if (url.pathname === '/api/admin/stats') {
      if (!esAdmin(req, env)) return new Response('no', { status: 401 });
      return new Response(JSON.stringify(await resumen(env)), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    // --- batalla online ---
    // Los WebSocket NO pasan por `cors()`: el navegador no aplica CORS al
    // handshake de un WebSocket, asi que el chequeo se hace a mano contra el
    // header Origin. Sin esto cualquier pagina podria abrir salas.
    if (url.pathname === '/api/sala' || url.pathname === '/api/cola') {
      if (!origenOk(req, env)) return new Response('origen no permitido', { status: 403 });

      if (url.pathname === '/api/cola') {
        return env.LOBBY.get(env.LOBBY.idFromName('cola')).fetch(req);
      }
      const codigo = (url.searchParams.get('codigo') || '').toUpperCase();
      if (!codigoValido(codigo)) return new Response('codigo invalido', { status: 400 });
      return env.SALAS.get(env.SALAS.idFromName(codigo)).fetch(req);
    }

    const pais = (req.cf?.country || 'XX').toUpperCase();
    // `regionCode` es corto y estable (GT-16); `region` es el nombre largo.
    // Se guarda el nombre porque es lo que se muestra, y si no hay ninguno
    // queda vacio y el ambito regional simplemente no aplica.
    const region = req.cf?.region || '';
    const hoy = periodos(Date.now());

    try {
      // Analitica. Contesta ANTES de escribir: el cliente la manda y se
      // olvida, y ni el `visita` de la primera pantalla tiene por que hacerle
      // esperar un round trip a nadie. Si la escritura falla, se pierde un
      // evento y no se entera nadie, que es exactamente lo que corresponde.
      if (url.pathname === '/api/hit' && req.method === 'POST') {
        if (origenOk(req, env)) {
          // El cuerpo se lee ACA y no adentro de `anotar`: una vez devuelta la
          // respuesta, el stream del request ya no se puede leer. Lo unico que
          // queda para despues es el INSERT.
          const cuerpo = await req.text();
          ctx.waitUntil(anotar(req, env, { pais, region, hoy, cuerpo }).catch((e) => {
            console.warn('[hit]', e?.message);
          }));
        }
        return new Response(null, { status: 204, headers: cors(req, env) });
      }

      if (url.pathname === '/api/online') {
        return json(await online(env), req, env);
      }

      // --- torneos de comunidad ---
      //
      // Los modulos de torneo devuelven `{data}` o `{error, status}` en vez de
      // una Response: asi no tienen que saber nada de CORS ni del formato, que
      // vive todo aca. `resolver` es el unico puente.
      if (url.pathname.startsWith('/api/torneo')) {
        // El video se sirve aparte porque NO es JSON: es el archivo, con
        // Range y con su propio 206/304.
        if (url.pathname === '/api/torneo/clip' && req.method === 'GET') {
          const res = await torneos.verClip(req, env, url);
          if (!res) return json({ error: 'no hay video' }, req, env, 404);
          for (const [k, v] of Object.entries(cors(req, env))) res.headers.set(k, v);
          return res;
        }

        const resolver = (r) => (r.error
          ? json({ error: r.error }, req, env, r.status || 400)
          : json(r.data, req, env));

        // Escribir exige venir del sitio. Leer no: la tabla de un torneo se
        // mira desde donde sea (la pagina del reel, un iframe en el stream) y
        // el codigo ya es el permiso.
        const escribe = req.method === 'POST' || req.method === 'PUT';
        if (escribe && !origenOk(req, env)) {
          return json({ error: 'origen no permitido' }, req, env, 403);
        }

        const ahora = Date.now();
        if (url.pathname === '/api/torneo' && req.method === 'POST') {
          return resolver(await torneos.crear(req, env, { pais, ahora }));
        }
        if (url.pathname === '/api/torneo' && req.method === 'GET') {
          return resolver(await torneos.info(env, url, ahora));
        }
        if (url.pathname === '/api/torneo/score' && req.method === 'POST') {
          return resolver(await torneos.puntaje(req, env, { pais, ahora }));
        }
        if (url.pathname === '/api/torneo/clip' && req.method === 'PUT') {
          return resolver(await torneos.guardarClip(req, env, url, ahora));
        }
        if (url.pathname === '/api/torneo/borrar' && req.method === 'POST') {
          return resolver(await torneos.borrarEntrada(req, env));
        }
        if (url.pathname === '/api/torneo/cerrar' && req.method === 'POST') {
          return resolver(await torneos.cerrar(req, env, ahora));
        }
        return json({ error: 'no existe' }, req, env, 404);
      }

      if (url.pathname === '/api/score' && req.method === 'POST') {
        const body = await req.json().catch(() => null);
        if (!body) return json({ error: 'cuerpo invalido' }, req, env, 400);

        const alias = String(body.alias ?? '').trim().slice(0, 14);
        if (!ALIAS_OK.test(alias)) return json({ error: 'alias invalido' }, req, env, 400);

        const aura = Math.floor(Number(body.aura));
        if (!Number.isFinite(aura) || aura < 0 || aura > AURA_MAX) {
          return json({ error: 'aura invalida' }, req, env, 400);
        }
        const moves = Array.isArray(body.moves)
          ? body.moves.filter((m) => typeof m === 'string').slice(0, 12).join(',').slice(0, 200)
          : '';

        const ts = Date.now();
        await env.DB.prepare(
          `INSERT INTO runs (alias, alias_key, aura, pais, region, moves, dia, semana, ts)
           VALUES (?,?,?,?,?,?,?,?,?)`
        ).bind(alias, clave(alias), aura, pais, region, moves, hoy.dia, hoy.semana, ts).run();

        // UN puesto, no los nueve (3 periodos x 3 ambitos). Cada uno cuesta
        // tres consultas y serian 27 en un solo POST, que en D1 es una
        // barbaridad para algo que la pantalla ni muestra junto: el ranking se
        // abre por pestaña y cada pestaña ya pide su `yo`.
        //
        // POR QUE UNO Y NO NINGUNO. Desde que el puntaje se sube solo al
        // terminar la ronda, la pantalla de resultado tiene que poder decir el
        // puesto sin pedir nada mas: la alternativa era un segundo request por
        // cada escaneo, y el escaneo es lo que hace TODA la gente.
        //
        // El ambito es el mas chico que tenga sentido, y el periodo es hoy:
        // verse primero entre los del barrio engancha mas que ser el 4.000 del
        // mundo, y "hoy" es la unica tabla donde alguien que recien entra puede
        // aparecer arriba.
        const ambitoYo = region ? 'region' : 'pais';
        const yo = await puestoDe(env, filtro({ ambito: ambitoYo, periodo: 'dia', pais, region, hoy }), clave(alias))
          .catch(() => null);

        return json({ ok: true, aura, pais, region, ambito: ambitoYo, yo }, req, env);
      }

      if (url.pathname === '/api/ranking' && req.method === 'GET') {
        const ambito = ['global', 'pais', 'region'].includes(url.searchParams.get('ambito'))
          ? url.searchParams.get('ambito') : 'global';
        const periodo = ['dia', 'semana', 'historico'].includes(url.searchParams.get('periodo'))
          ? url.searchParams.get('periodo') : 'dia';
        const limite = Math.min(LIMITE_MAX, Math.max(1, +url.searchParams.get('limite') || 25));
        const f = filtro({ ambito, periodo, pais, region, hoy });

        const alias = (url.searchParams.get('alias') || '').trim();
        const yo = ALIAS_OK.test(alias) ? await puestoDe(env, f, clave(alias)) : null;

        return json({
          ambito, periodo, pais, region,
          filas: await tabla(env, f, limite),
          yo,
        }, req, env);
      }

      return json({ error: 'no existe' }, req, env, 404);
    } catch (e) {
      // El mensaje va al log, no al cliente: los errores de D1 traen el SQL.
      console.error('[ranking]', e?.message, e?.stack);
      return json({ error: 'error del servidor' }, req, env, 500);
    }
  },

  /**
   * El barrido de los videos vencidos. Una vez por hora, no por minuto:
   * lo unico que hace es borrar archivos que ya nadie puede ver, y correrlo
   * cada minuto serian 43.200 invocaciones al mes contra las 100.000 diarias
   * del plan gratis, para un trabajo que casi siempre no tiene nada que hacer.
   *
   * Sin R2 no hay nada que borrar y `purgar` sale en la primera linea.
   */
  async scheduled(evento, env, ctx) {
    ctx.waitUntil(
      torneos.purgar(env, Date.now())
        .then((r) => { if (r.clips) console.log('[purga]', r.torneos, 'torneos,', r.clips, 'clips'); })
        .catch((e) => console.error('[purga]', e?.message)),
    );
  },
};
