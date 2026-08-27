// Torneos privados: un streamer arma uno, reparte el codigo, y su comunidad
// compite durante los dias que el diga.
//
// POR QUE NO ES UN DURABLE OBJECT (la razon larga esta en schema.sql): un
// torneo es asincrono. Nadie espera a nadie, no hay nada que empujar en vivo.
// Todo esto son consultas a D1 y un archivo en el almacen (ver almacen.js).
//
// LOS VIDEOS SON OPCIONALES EN TRES NIVELES, y cada uno se cae solo:
//   1. el organizador elige si su torneo los guarda      -> `clips` en la tabla
//   2. la cuenta puede no tener almacen atado            -> ver almacen.js
//   3. la subida puede fallar (varios MB en datos moviles) -> `clip` queda NULL
// En los tres casos el torneo funciona igual y la tabla se ve completa. El
// puntaje se anota SIEMPRE por su propia via, antes y aparte del archivo.

import { abrir, hayAlmacen, guardar, borrar as borrarArchivo, servir } from './almacen.js';

// Sin O/0/I/1: el codigo se dicta en un stream y se escribe a mano.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// SEIS y no cuatro, que es lo que usan las salas. Dos motivos, los dos
// importan:
//   - El largo ES el tipo. El campo del menu es uno solo; con 4 va a una sala
//     y con 6 a un torneo, sin que nadie tenga que elegir de que se trata.
//   - Una sala vive minutos y un torneo, semanas. 32^4 son un millon de
//     combinaciones y adivinar una sala viva es dificil porque casi ninguna lo
//     esta; con mil torneos abiertos a la vez, tantear codigos hasta caer en
//     uno seria facil. 32^6 son mil millones.
export const CODIGO_LARGO = 6;
export const codigoValido = (c) => /^[A-Z2-9]{6}$/.test(String(c || '').toUpperCase());

export function codigoNuevo() {
  const b = new Uint8Array(CODIGO_LARGO);
  crypto.getRandomValues(b);
  return [...b].map((x) => ALFABETO[x % ALFABETO.length]).join('');
}

const DIA_MS = 86_400_000;

// Cuanto duran los videos DESPUES de que el torneo termina. Es lo que se le
// promete al que juega ("se guardan 7 dias"), asi que es una constante con
// nombre y no un numero suelto en una cuenta.
export const DIAS_GUARDADOS = 7;

// Techo de duracion. Un torneo abierto es una fila que nadie va a cerrar nunca
// y, si guarda videos, espacio ocupado hasta que venza. Noventa dias es mas
// que cualquier evento real de una comunidad.
const DIAS_MAX = 90;

// Cuantos videos se conservan por torneo. Es el top: si te pasan, tu video se
// borra solo (ver `acomodarClips`). Con 5.3MB por clip esto es ~53MB por
// torneo, que en el 1GB del plan gratis de KV son ~19 torneos a la vez.
const TOPE_CLIPS = 10;

// Con el bitrate actual un clip de 15s pesa 5.3MB (ver src/record.js). El tope
// de 24MB deja lugar de sobra para un telefono que grabe mas gordo, y queda
// justo por debajo del limite de 25MB por valor que tiene KV: una subida mas
// grande que eso hay que rechazarla ACA, con un mensaje que se entienda, y no
// dejar que reviente adentro del almacen.
const CLIP_MAX_BYTES = 24 * 1024 * 1024;

const NOMBRE_OK = /^[\p{L}\p{N} ._'!¡?¿&:-]{3,40}$/u;
const ALIAS_OK = /^[\p{L}\p{N} ._-]{2,14}$/u;

const AURA_MAX = 100_000_000;

/** Igual que en index.js: es la clave por la que se identifica a cada uno. */
const clave = (alias) => alias.trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/**
 * Secreto del organizador. Es lo unico que separa "yo arme este torneo" de
 * "yo se el codigo", y el codigo lo tiene toda la comunidad: sin esto,
 * cualquiera de los que juegan podria borrar entradas ajenas o cerrar el
 * torneo. Va en la URL que se guarda el organizador, nunca en la que reparte.
 */
const claveNueva = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

/**
 * Comparacion en tiempo constante.
 *
 * Con `===` sobre un secreto, cuanto tarda en decir que no depende de cuantos
 * caracteres acerto. Es un ataque de laboratorio contra un torneo de TikTok,
 * pero son cuatro lineas y la alternativa es explicar por que no se hizo.
 */
function mismoSecreto(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

/** La llave del video de alguien dentro de un torneo. Una por persona. */
const llaveClip = (codigo, aliasKey) => `t/${codigo}/${aliasKey}`;

// `>=` y no `>` en el cierre: `termina` es el INSTANTE en que se acaba, no el
// ultimo momento valido. Con `>`, cerrar un torneo a mano (que pone
// `termina = ahora`) devolvia "abierto" en la misma respuesta que lo cerraba, y
// el organizador veia el boton sin efecto.
const estado = (t, ahora) => (ahora < t.arranca ? 'espera' : ahora >= t.termina ? 'cerrado' : 'abierto');

/** Lo que se le puede contar a cualquiera. `clave` NUNCA sale de aca. */
function publico(t, ahora) {
  return {
    codigo: t.codigo,
    nombre: t.nombre,
    organizador: t.organizador,
    clips: !!t.clips,
    topeClips: t.tope_clips,
    arranca: t.arranca,
    termina: t.termina,
    estado: estado(t, ahora),
    diasGuardados: DIAS_GUARDADOS,
  };
}

export async function buscar(env, codigo) {
  return env.DB.prepare('SELECT * FROM torneos WHERE codigo = ?').bind(codigo).first();
}

// ---------------------------------------------------------------------------
// crear

export async function crear(req, env, { pais, ahora }) {
  const body = await req.json().catch(() => null);
  if (!body) return { error: 'cuerpo invalido', status: 400 };

  const nombre = String(body.nombre ?? '').trim().slice(0, 40);
  if (!NOMBRE_OK.test(nombre)) return { error: 'el nombre del torneo va de 3 a 40 caracteres', status: 400 };

  const organizador = String(body.organizador ?? '').trim().slice(0, 14);
  if (!ALIAS_OK.test(organizador)) return { error: 'organizador invalido', status: 400 };

  const dias = Math.floor(Number(body.dias));
  if (!Number.isFinite(dias) || dias < 1 || dias > DIAS_MAX) {
    return { error: `los dias van de 1 a ${DIAS_MAX}`, status: 400 };
  }

  // Se pide guardar videos pero no hay almacen atado: se crea igual, con los
  // clips apagados, y se avisa. Negarse a crear el torneo por esto seria
  // perder al organizador por una casilla.
  const queria = body.clips === true;
  const clips = queria && hayAlmacen(env);

  const termina = ahora + dias * DIA_MS;
  const codigo = codigoNuevo();
  const secreto = claveNueva();

  // Sin reintento por colision: con 32^6 y un INSERT que falla ruidoso si
  // repite, la respuesta correcta a "salio la misma de mil millones" es que el
  // organizador toque el boton de nuevo.
  await env.DB.prepare(
    `INSERT INTO torneos (codigo, nombre, organizador, clave, clips, tope_clips,
                          arranca, termina, purga, pais, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    codigo, nombre, organizador, secreto, clips ? 1 : 0, TOPE_CLIPS,
    ahora, termina, termina + DIAS_GUARDADOS * DIA_MS, pais, ahora,
  ).run();

  const t = { codigo, nombre, organizador, clips: clips ? 1 : 0, tope_clips: TOPE_CLIPS, arranca: ahora, termina };
  return {
    data: {
      ...publico(t, ahora),
      clave: secreto,
      // El unico momento en que esto se puede decir. Despues no hay como saber
      // que el organizador queria clips y no los tuvo.
      avisoClips: queria && !clips ? 'no hay almacenamiento configurado: el torneo va sin videos' : '',
    },
  };
}

// ---------------------------------------------------------------------------
// tabla

/**
 * La tabla del torneo.
 *
 * Sin GROUP BY ni MAX(): en `torneo_runs` ya hay una sola fila por persona con
 * su record. Es toda la diferencia de diseño con `runs` y es lo que hace que
 * esta consulta salga entera del indice `ix_t_rank` aunque haya diez mil
 * inscriptos, que es el caso que el streamer trae.
 */
export async function tabla(env, codigo, limite) {
  const { results } = await env.DB.prepare(
    `SELECT alias, aura, moves, pais, clip, ts
       FROM torneo_runs WHERE codigo = ?
       ORDER BY aura DESC, ts ASC
       LIMIT ?`
  ).bind(codigo, limite).all();
  // `clip` sale como booleano y no como llave: la llave es una ruta interna de
  // R2 y el cliente no tiene por que verla, le alcanza con saber si hay video.
  return (results || []).map((r, i) => ({ ...r, clip: !!r.clip, puesto: i + 1 }));
}

/**
 * Puesto de una persona: cuantos le ganan, mas uno.
 *
 * El desempate por `ts ASC` esta tambien aca y no solo en el ORDER BY de la
 * tabla: sin el, dos personas con el mismo aura se dan el mismo puesto en la
 * lista pero numeros distintos en "sos el N de M", y el que lo ve piensa que
 * el torneo miente. Gana el que llego primero a esa marca.
 */
export async function puestoDe(env, codigo, aliasKey) {
  const mio = await env.DB.prepare(
    'SELECT aura, ts FROM torneo_runs WHERE codigo = ? AND alias_key = ?'
  ).bind(codigo, aliasKey).first();
  if (!mio) return null;
  const arriba = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM torneo_runs
      WHERE codigo = ? AND (aura > ? OR (aura = ? AND ts < ?))`
  ).bind(codigo, mio.aura, mio.aura, mio.ts).first();
  const total = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM torneo_runs WHERE codigo = ?'
  ).bind(codigo).first();
  return { puesto: (arriba?.n ?? 0) + 1, aura: mio.aura, total: total?.n ?? 0 };
}

export async function info(env, url, ahora) {
  const codigo = (url.searchParams.get('codigo') || '').toUpperCase();
  if (!codigoValido(codigo)) return { error: 'codigo invalido', status: 400 };

  const t = await buscar(env, codigo);
  if (!t) return { error: 'ese torneo no existe', status: 404 };

  const limite = Math.min(100, Math.max(1, +url.searchParams.get('limite') || 50));
  const alias = (url.searchParams.get('alias') || '').trim();
  const yo = ALIAS_OK.test(alias) ? await puestoDe(env, codigo, clave(alias)) : null;

  return { data: { ...publico(t, ahora), filas: await tabla(env, codigo, limite), yo } };
}

// ---------------------------------------------------------------------------
// puntaje

export async function puntaje(req, env, { pais, ahora }) {
  const body = await req.json().catch(() => null);
  if (!body) return { error: 'cuerpo invalido', status: 400 };

  const codigo = String(body.codigo ?? '').toUpperCase();
  if (!codigoValido(codigo)) return { error: 'codigo invalido', status: 400 };

  const alias = String(body.alias ?? '').trim().slice(0, 14);
  if (!ALIAS_OK.test(alias)) return { error: 'alias invalido', status: 400 };

  const aura = Math.floor(Number(body.aura));
  if (!Number.isFinite(aura) || aura < 0 || aura > AURA_MAX) {
    return { error: 'aura invalida', status: 400 };
  }
  const moves = Array.isArray(body.moves)
    ? body.moves.filter((m) => typeof m === 'string').slice(0, 12).join(',').slice(0, 200)
    : '';

  const t = await buscar(env, codigo);
  if (!t) return { error: 'ese torneo no existe', status: 404 };
  const cuando = estado(t, ahora);
  if (cuando === 'espera') return { error: 'el torneo todavia no arranco', status: 409 };
  if (cuando === 'cerrado') return { error: 'el torneo ya termino', status: 409 };

  const k = clave(alias);

  // El upsert entero en UNA sentencia, no leer-comparar-escribir.
  //
  // POR QUE IMPORTA: dos telefonos de la misma persona terminando a la vez
  // —o el mismo, con doble toque— leerian los dos el record viejo y el ultimo
  // en escribir pisaria al mas alto. Aca la condicion vive adentro del UPDATE
  // y la decide SQLite: `excluded` es la fila que se intento insertar.
  //
  // `intentos` se suma SIEMPRE, aunque no mejore: es lo que despues dice
  // cuanta gente farmeo de verdad contra cuanta entro y toco una sola vez.
  // Y `alias` se pisa con el nuevo para que quien cambie mayusculas se vea
  // como se escribio la ultima vez.
  await env.DB.prepare(
    `INSERT INTO torneo_runs (codigo, alias_key, alias, aura, moves, pais, clip, intentos, ts)
     VALUES (?,?,?,?,?,?,NULL,1,?)
     ON CONFLICT(codigo, alias_key) DO UPDATE SET
       intentos = intentos + 1,
       alias    = excluded.alias,
       aura     = MAX(aura, excluded.aura),
       moves    = CASE WHEN excluded.aura > aura THEN excluded.moves ELSE moves END,
       ts       = CASE WHEN excluded.aura > aura THEN excluded.ts    ELSE ts    END`
  ).bind(codigo, k, alias, aura, moves, pais, ahora).run();

  const yo = await puestoDe(env, codigo, k);

  // `superado` es lo que decide, del lado del cliente, si vale la pena gastar
  // datos moviles subiendo el video: solo se sube el que mejoro su
  // propia marca Y entro al top.
  const superado = !!yo && yo.aura === aura;
  return {
    data: {
      ok: true,
      aura,
      yo,
      torneo: publico(t, ahora),
      // Que el cliente NO decida esto solo: el tope y el opt-in viven en el
      // servidor y pueden cambiar entre que se cargo la pagina y se termino
      // de jugar.
      subirClip: !!t.clips && hayAlmacen(env) && superado && !!yo && yo.puesto <= t.tope_clips,
    },
  };
}

// ---------------------------------------------------------------------------
// videos

/**
 * Borra los videos de los que se cayeron del top.
 *
 * Se corre despues de cada subida y no por un barrido periodico: el unico
 * momento en que alguien puede caerse del top es cuando otro entra. Son dos
 * consultas chicas contra un indice, y mantiene el bucket acotado a
 * `tope_clips` archivos por torneo pase lo que pase.
 */
async function acomodarClips(env, t) {
  const alm = abrir(env);
  if (!alm) return 0;
  const { results } = await env.DB.prepare(
    `SELECT alias_key FROM torneo_runs
      WHERE codigo = ? AND clip IS NOT NULL
      ORDER BY aura DESC, ts ASC
      LIMIT -1 OFFSET ?`
  ).bind(t.codigo, t.tope_clips).all();

  for (const r of results || []) {
    // Primero el archivo y despues la fila: al reves, un fallo a mitad deja la
    // fila diciendo que no hay video y el archivo ocupando lugar para siempre,
    // sin nada que lo referencie. En este orden, lo peor que queda es una fila
    // que promete un video que ya no esta, y eso se ve y se puede arreglar.
    try { await borrarArchivo(alm, llaveClip(t.codigo, r.alias_key)); }
    catch (e) { console.warn('[torneo] no se pudo borrar el clip', e?.message); }
    await env.DB.prepare(
      'UPDATE torneo_runs SET clip = NULL WHERE codigo = ? AND alias_key = ?'
    ).bind(t.codigo, r.alias_key).run();
  }
  return (results || []).length;
}

export async function guardarClip(req, env, url, ahora) {
  const alm = abrir(env);
  if (!alm) return { error: 'este torneo no guarda videos', status: 409 };

  const codigo = (url.searchParams.get('codigo') || '').toUpperCase();
  if (!codigoValido(codigo)) return { error: 'codigo invalido', status: 400 };
  const alias = (url.searchParams.get('alias') || '').trim();
  if (!ALIAS_OK.test(alias)) return { error: 'alias invalido', status: 400 };

  const t = await buscar(env, codigo);
  if (!t) return { error: 'ese torneo no existe', status: 404 };
  if (!t.clips) return { error: 'este torneo no guarda videos', status: 409 };
  if (estado(t, ahora) !== 'abierto') return { error: 'el torneo no esta abierto', status: 409 };

  // Rechazo temprano por el header, para no leer 100MB a memoria antes de
  // decir que no. NO es el control de verdad —el cliente escribe ese numero y
  // puede mentir—: el que vale es el de mas abajo, sobre los bytes reales.
  const largo = Number(req.headers.get('content-length') || 0);
  if (largo > CLIP_MAX_BYTES) return { error: 'el video pesa demasiado', status: 413 };

  const k = clave(alias);

  // Se vuelve a mirar el puesto ACA y no se confia en el `subirClip` que se
  // devolvio antes: entre que el telefono termino de jugar y termino de subir
  // el archivo pueden pasar treinta segundos, y en ese rato pueden pasarlo
  // diez personas. Sin esto, el que sube lento mete su archivo igual y
  // desaloja al que si esta en el top.
  const yo = await puestoDe(env, codigo, k);
  if (!yo) return { error: 'todavia no tenes puntaje en este torneo', status: 409 };
  if (yo.puesto > t.tope_clips) {
    return { data: { ok: false, guardado: false, motivo: 'fuera-del-top', yo } };
  }

  const tipo = req.headers.get('content-type') || 'video/mp4';
  if (!/^video\/(mp4|webm)/.test(tipo)) return { error: 'formato de video invalido', status: 415 };

  // El cuerpo se lee ENTERO antes de guardarlo, y no se confia en
  // `content-length`: ese header lo escribe el cliente y se puede mentir, asi
  // que el tope de tamaño solo vale de verdad despues de tener los bytes. En KV
  // ademas hace falta el largo si o si (ver almacen.js).
  const datos = await req.arrayBuffer();
  if (datos.byteLength > CLIP_MAX_BYTES) return { error: 'el video pesa demasiado', status: 413 };
  if (!datos.byteLength) return { error: 'el video llego vacio', status: 400 };

  const llave = llaveClip(codigo, k);
  await guardar(alm, llave, datos, { tipo, vence: t.purga, codigo });

  await env.DB.prepare(
    'UPDATE torneo_runs SET clip = ? WHERE codigo = ? AND alias_key = ?'
  ).bind(llave, codigo, k).run();

  const desalojados = await acomodarClips(env, t);
  return { data: { ok: true, guardado: true, yo, desalojados } };
}

/**
 * Devuelve el video de alguien. Publico: el que tiene el codigo, lo ve.
 *
 * Con Range, porque sin eso un <video> de varios MB no puede buscar dentro del
 * archivo y en iOS directamente no arranca: Safari pide los primeros bytes
 * antes de decidir si sabe reproducirlo, y una respuesta 200 entera a esa
 * pregunta la trata como que no.
 */
export async function verClip(req, env, url) {
  const alm = abrir(env);
  if (!alm) return null;
  const codigo = (url.searchParams.get('codigo') || '').toUpperCase();
  const alias = (url.searchParams.get('alias') || '').trim();
  if (!codigoValido(codigo) || !ALIAS_OK.test(alias)) return null;
  return servir(alm, llaveClip(codigo, clave(alias)), req);
}

// ---------------------------------------------------------------------------
// moderacion (el organizador, con su clave)

export async function borrarEntrada(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return { error: 'cuerpo invalido', status: 400 };

  const codigo = String(body.codigo ?? '').toUpperCase();
  if (!codigoValido(codigo)) return { error: 'codigo invalido', status: 400 };
  const alias = String(body.alias ?? '').trim();
  if (!ALIAS_OK.test(alias)) return { error: 'alias invalido', status: 400 };

  const t = await buscar(env, codigo);
  if (!t) return { error: 'ese torneo no existe', status: 404 };
  if (!mismoSecreto(body.clave, t.clave)) return { error: 'no sos el organizador', status: 403 };

  const k = clave(alias);
  const alm = abrir(env);
  if (alm) {
    try { await borrarArchivo(alm, llaveClip(codigo, k)); }
    catch (e) { console.warn('[torneo] borrar clip', e?.message); }
  }
  await env.DB.prepare('DELETE FROM torneo_runs WHERE codigo = ? AND alias_key = ?')
    .bind(codigo, k).run();

  return { data: { ok: true } };
}

/** Cerrar antes de tiempo: el organizador decide que ya esta. */
export async function cerrar(req, env, ahora) {
  const body = await req.json().catch(() => null);
  if (!body) return { error: 'cuerpo invalido', status: 400 };
  const codigo = String(body.codigo ?? '').toUpperCase();
  if (!codigoValido(codigo)) return { error: 'codigo invalido', status: 400 };

  const t = await buscar(env, codigo);
  if (!t) return { error: 'ese torneo no existe', status: 404 };
  if (!mismoSecreto(body.clave, t.clave)) return { error: 'no sos el organizador', status: 403 };

  // La purga se recalcula desde el cierre nuevo: los 7 dias que se prometieron
  // se cuentan desde que el torneo termina de verdad, no desde la fecha que se
  // habia planeado.
  await env.DB.prepare('UPDATE torneos SET termina = ?, purga = ? WHERE codigo = ?')
    .bind(ahora, ahora + DIAS_GUARDADOS * DIA_MS, codigo).run();

  return { data: { ok: true, ...publico({ ...t, termina: ahora }, ahora) } };
}

// ---------------------------------------------------------------------------
// barrido: los videos duran 7 dias despues del cierre

/**
 * Borra lo vencido. Lo llama el cron.
 *
 * Se borran los VIDEOS, no los torneos: la tabla de posiciones es el historico
 * que el streamer va a querer mirar dentro de seis meses y pesa nada. Lo que
 * ocupa —y lo que se prometio por siete dias— son los archivos.
 *
 * De a poco (`LIMITE` torneos por corrida) para no pasarse del tiempo de CPU
 * de una invocacion: lo que quede vencido se lleva la corrida siguiente.
 */
export async function purgar(env, ahora, LIMITE = 5) {
  const alm = abrir(env);
  if (!alm) return { torneos: 0, clips: 0 };

  const { results } = await env.DB.prepare(
    `SELECT codigo FROM torneos
      WHERE purga <= ?
        AND EXISTS (SELECT 1 FROM torneo_runs r WHERE r.codigo = torneos.codigo AND r.clip IS NOT NULL)
      LIMIT ?`
  ).bind(ahora, LIMITE).all();

  let clips = 0;
  for (const t of results || []) {
    const { results: filas } = await env.DB.prepare(
      'SELECT alias_key FROM torneo_runs WHERE codigo = ? AND clip IS NOT NULL'
    ).bind(t.codigo).all();
    for (const f of filas || []) {
      try { await borrarArchivo(alm, llaveClip(t.codigo, f.alias_key)); clips++; }
      catch (e) { console.warn('[purga]', e?.message); }
    }
    await env.DB.prepare('UPDATE torneo_runs SET clip = NULL WHERE codigo = ?')
      .bind(t.codigo).run();
  }
  return { torneos: (results || []).length, clips };
}
