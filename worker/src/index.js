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

function cors(req, env) {
  const origen = req.headers.get('Origin') || '';
  const permitidos = (env.ORIGENES || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Sin comodin: `*` con un origen concreto igual funcionaria, pero dejar la
  // lista explicita es lo que evita que cualquier pagina escriba puntajes.
  const ok = permitidos.includes(origen);
  return {
    'access-control-allow-origin': ok ? origen : permitidos[0] || '',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
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
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });
    if (url.pathname === '/api/salud') return json({ ok: true }, req, env);

    const pais = (req.cf?.country || 'XX').toUpperCase();
    // `regionCode` es corto y estable (GT-16); `region` es el nombre largo.
    // Se guarda el nombre porque es lo que se muestra, y si no hay ninguno
    // queda vacio y el ambito regional simplemente no aplica.
    const region = req.cf?.region || '';
    const hoy = periodos(Date.now());

    try {
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

        // Aca NO se devuelven los nueve puestos (3 periodos x 3 ambitos).
        // Cada uno cuesta tres consultas y serian 27 en un solo POST, que en
        // D1 es una barbaridad para algo que la pantalla ni muestra junto:
        // el ranking se abre por pestaña y cada pestaña ya pide su `yo`.
        return json({ ok: true, aura, pais, region }, req, env);
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
};
