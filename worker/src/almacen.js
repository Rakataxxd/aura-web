// Donde viven los videos de los torneos.
//
// POR QUE ESTA CAPA EXISTE. Cloudflare tiene dos lugares donde poner archivos y
// se eligen por una razon que no es tecnica:
//
//   R2  es el correcto para esto —10 GB gratis, pensado para blobs, con Range
//       nativo— pero HABILITARLO PIDE UNA TARJETA en la cuenta. Aunque nunca
//       cobre nada, hay que aceptar sus terminos y dejar un medio de pago.
//   KV  entra en el plan gratis de Workers sin tarjeta ninguna: 1 GB, valores
//       de hasta 25 MB, y expiracion automatica por TTL.
//
// Este proyecto eligio KV, a proposito, para no pedirle la tarjeta a nadie. Con
// clips de 5.3 MB medidos (ver el bitrate en src/record.js) 1 GB da para ~190
// videos, y con el tope de 10 por torneo son ~19 torneos con video a la vez.
//
// Pero la eleccion es de UNA LINEA: si algun dia sobra con KV, se ata R2 al
// binding y todo lo de arriba sigue igual. Por eso `abrir()` devuelve siempre
// la misma interfaz y el resto del worker no sabe cual de los dos le toco.

const KV = 'kv';
const R2 = 'r2';

/**
 * Devuelve el almacen disponible, o null si no hay ninguno.
 *
 * R2 gana si esta atado, porque si alguien se tomo el trabajo de habilitarlo
 * es porque lo quiere usar. Si no, KV.
 */
export function abrir(env) {
  if (env.CLIPS_R2) return { tipo: R2, bin: env.CLIPS_R2 };
  if (env.CLIPS) return { tipo: KV, bin: env.CLIPS };
  return null;
}

export const hayAlmacen = (env) => !!abrir(env);

/**
 * Guarda un video.
 *
 * @param {number} vence epoch ms en que hay que borrarlo
 *
 * EN KV EL VENCIMIENTO LO HACE LA BASE. `expirationTtl` borra el valor sola al
 * cumplirse el plazo: no hay barrido que pueda fallar ni quedar a medias, y un
 * torneo que nadie vuelve a mirar no deja basura para siempre. Es mejor que el
 * cron, que igual queda para limpiar la marca en la tabla.
 *
 * KV NO ACEPTA UN STREAM SIN LARGO CONOCIDO, asi que el cuerpo se lee entero a
 * memoria. Con el tope de 25 MB por valor y los 128 MB que tiene un Worker,
 * entra de sobra; con R2 no hace falta y por eso ahi va el stream derecho.
 */
export async function guardar(alm, llave, cuerpo, { tipo, vence, codigo }) {
  if (alm.tipo === R2) {
    await alm.bin.put(llave, cuerpo, {
      httpMetadata: { contentType: tipo, cacheControl: 'public, max-age=2592000' },
      customMetadata: { codigo, vence: String(vence) },
    });
    return;
  }
  const datos = cuerpo instanceof ArrayBuffer ? cuerpo : await new Response(cuerpo).arrayBuffer();
  // Minimo un minuto: KV rechaza un TTL mas corto, y un torneo que se cierra
  // justo cuando alguien sube su clip no puede hacer fallar la subida.
  const seg = Math.max(60, Math.round((vence - Date.now()) / 1000));
  await alm.bin.put(llave, datos, {
    expirationTtl: seg,
    metadata: { tipo, codigo },
  });
}

export async function borrar(alm, llave) {
  await alm.bin.delete(llave);
}

/**
 * Sirve un video, con soporte de Range.
 *
 * EL RANGE NO ES UN LUJO: iOS pide `Range: bytes=0-1` ANTES de decidir si sabe
 * reproducir algo, y a una respuesta 200 entera la trata como que no. Sin esto,
 * en iPhone el video del torneo directamente no arranca.
 *
 * R2 lo resuelve solo. KV no sabe de rangos, asi que se lee el valor completo y
 * se corta el pedazo a mano. Suena caro y no lo es: son ~5 MB, el Worker tiene
 * 128 MB, y KV cachea en el borde, asi que la lectura repetida no vuelve al
 * origen.
 */
export async function servir(alm, llave, req) {
  if (alm.tipo === R2) {
    const obj = await alm.bin.get(llave, { range: req.headers, onlyIf: req.headers });
    if (!obj) return null;
    const h = new Headers();
    obj.writeHttpMetadata(h);
    h.set('etag', obj.httpEtag);
    h.set('accept-ranges', 'bytes');
    if (!obj.body) return new Response(null, { status: 304, headers: h });
    if (req.headers.has('range') && obj.range && 'offset' in obj.range) {
      const desde = obj.range.offset ?? 0;
      const largo = obj.range.length ?? (obj.size - desde);
      h.set('content-range', `bytes ${desde}-${desde + largo - 1}/${obj.size}`);
      return new Response(obj.body, { status: 206, headers: h });
    }
    return new Response(obj.body, { headers: h });
  }

  const { value, metadata } = await alm.bin.getWithMetadata(llave, { type: 'arrayBuffer' });
  if (!value) return null;

  const total = value.byteLength;
  const h = new Headers({
    'content-type': metadata?.tipo || 'video/mp4',
    'cache-control': 'public, max-age=2592000',
    'accept-ranges': 'bytes',
  });

  const rango = req.headers.get('range');
  if (!rango) return new Response(value, { headers: h });

  // Solo `bytes=inicio-fin`, que es lo unico que mandan los reproductores. Un
  // rango que no se entiende se contesta con el archivo entero en vez de con
  // un 416: es mas util que el video se vea a que el navegador tenga razon.
  const m = /^bytes=(\d*)-(\d*)$/.exec(rango.trim());
  if (!m) return new Response(value, { headers: h });

  let desde = m[1] === '' ? null : Number(m[1]);
  let hasta = m[2] === '' ? null : Number(m[2]);
  if (desde === null && hasta === null) return new Response(value, { headers: h });
  // `bytes=-500` son los ULTIMOS 500, no los primeros. Es la forma que usan
  // algunos reproductores para leer el indice de un mp4, que va al final.
  if (desde === null) { desde = Math.max(0, total - hasta); hasta = total - 1; }
  if (hasta === null || hasta >= total) hasta = total - 1;
  if (desde > hasta || desde >= total) {
    return new Response(null, { status: 416, headers: { ...Object.fromEntries(h), 'content-range': `bytes */${total}` } });
  }

  h.set('content-range', `bytes ${desde}-${hasta}/${total}`);
  return new Response(value.slice(desde, hasta + 1), { status: 206, headers: h });
}
