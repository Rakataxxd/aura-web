// El sitio entero corriendo en ESTA maquina: la pagina, las salas y la cola.
// Lo unico que sigue en Cloudflare es el ranking.
//
// PARA QUE EXISTE. Los Durable Objects del plan gratis se pagan por segundo de
// objeto prendido, y cuando se acaba la cuota del dia TODO lo que los toque
// contesta 500: la cola de desconocidos y las salas por codigo al mismo tiempo.
// El juego online queda muerto hasta el otro dia. Esto lo saltea sin pagar y
// sin esperar: `wrangler dev` corre el MISMO worker aca (con Durable Objects de
// verdad, los de miniflare) y una maquina propia no cobra por segundo.
//
// POR QUE UN PROXY Y NO APUNTAR DERECHO AL WRANGLER. `?api=` en la URL le pisa
// el backend a TODO el cliente, no solo a las batallas: ranking, analitica y
// puntajes tambien irian a parar aca, y la base de datos local esta vacia. Se
// perderian los puntajes de las partidas que se jueguen mientras dure el apagon.
// Entonces este proceso parte el trafico:
//
//   /api/cola, /api/sala  ->  wrangler dev  (127.0.0.1:8787)   salas y cola
//   todo lo demas         ->  el worker de produccion          ranking real
//
// El websocket no se puede reenviar con fetch: un upgrade deja de ser HTTP
// despues del handshake. Se abre un socket crudo contra el wrangler, se le
// repite el pedido tal cual y se empalman los dos caños.
//
// LA PAGINA SALE DE `dist-local/`, que NO es el mismo build que el de GitHub
// Pages: aquel se compila con base `/aura-web/` porque vive en un subdirectorio,
// y este va en la raiz de un dominio propio. Se construye con:
//
//   npm run build:local
//
// que es `vite build --mode casa` y toma VITE_API_RANKING de `.env.casa`
// (https://casa.auratester.com). Con eso el cliente le pega a su MISMO origen,
// asi que no hace falta el `?api=` en la URL ni hay CORS de por medio.
//
// EL HOSTNAME ES `casa.auratester.com`, no el dominio pelado: desde el
// 25-ago-2026 auratester.com y www los sirve Cloudflare Pages y este tunel
// quedo como salida de emergencia nada mas.
//
// USO:
//   1) npx wrangler dev --port 8787          (en worker/)
//   2) node dev/servidor-local.mjs
//   3) cloudflared --config <cfg> tunnel run          (dev/arrancar-local.bat hace las tres)
//
// OJO: esto vive mientras la PC este prendida.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..', 'dist-local');
const PUERTO = Number(process.env.PUERTO || 8788);
const LOCAL = { host: '127.0.0.1', port: Number(process.env.WRANGLER || 8787) };
const PROD = (process.env.PROD || 'https://aura-ranking.rakataxxd.workers.dev').replace(/\/$/, '');

/** Lo unico que se atiende aca. El resto es de produccion. */
const esSala = (url) => url.startsWith('/api/cola') || url.startsWith('/api/sala');

const hora = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(hora(), ...a);

const servidor = http.createServer(async (req, res) => {
  const url = req.url || '/';

  // El menu pregunta cuanta gente hay. Son dos numeros de dos lados distintos:
  // `jugando` lo sabe produccion (esta en su base) y `cola` lo sabe el wrangler
  // de aca, que es el que tiene a la gente esperando. Sin este remiendo el menu
  // diria "nadie en la cola" con gente adentro.
  if (url.startsWith('/api/online')) {
    const [prod, mio] = await Promise.all([
      fetch(`${PROD}/api/online`, { headers: cabeceras(req) }).then((r) => r.json()).catch(() => null),
      fetch(`http://${LOCAL.host}:${LOCAL.port}/api/online`).then((r) => r.json()).catch(() => null),
    ]);
    return responder(res, 200, JSON.stringify({ jugando: prod?.jugando ?? 0, cola: mio?.cola ?? 0 }), req);
  }

  if (esSala(url)) {
    // Un GET a /api/sala sin upgrade no es nada util, pero que conteste algo.
    return responder(res, 426, 'esperaba websocket', req);
  }

  // `/admin` es el panel del worker, no un archivo del sitio.
  if (!url.startsWith('/api/') && !url.startsWith('/admin')) return estatico(url, res);

  // Todo lo demas es de produccion: ranking, puntajes, analitica, /admin.
  try {
    const cuerpo = ['GET', 'HEAD'].includes(req.method) ? undefined : await leer(req);
    const r = await fetch(PROD + url, { method: req.method, headers: cabeceras(req), body: cuerpo });
    const buf = Buffer.from(await r.arrayBuffer());
    const h = {};
    // `content-encoding` se saca porque fetch ya descomprimio el cuerpo: dejarlo
    // le promete al navegador un gzip que no va a llegar.
    r.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) h[k] = v; });
    res.writeHead(r.status, h);
    res.end(buf);
  } catch (e) {
    log('proxy falló', url, e?.message);
    responder(res, 502, 'no se pudo hablar con produccion', req);
  }
});

/**
 * El handshake del websocket, a mano.
 *
 * `fetch` no sirve: despues del 101 esto deja de ser HTTP y pasa a ser un caño
 * de bytes en las dos direcciones. Se repite el pedido crudo contra el wrangler
 * y se empalman los sockets.
 */
servidor.on('upgrade', (req, socket, head) => {
  if (!esSala(req.url || '')) { socket.destroy(); return; }
  log('sala ->', req.url);

  const arriba = net.connect(LOCAL.port, LOCAL.host, () => {
    const lineas = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      // El Host tiene que ser el de destino; el Origin se deja INTACTO porque
      // el worker decide con eso si acepta la conexion.
      lineas.push(`${k}: ${/^host$/i.test(k) ? `${LOCAL.host}:${LOCAL.port}` : req.rawHeaders[i + 1]}`);
    }
    arriba.write(lineas.join('\r\n') + '\r\n\r\n');
    if (head?.length) arriba.write(head);
    socket.pipe(arriba);
    arriba.pipe(socket);
  });

  const cortar = () => { try { socket.destroy(); } catch { /* ya */ } try { arriba.destroy(); } catch { /* ya */ } };
  arriba.on('error', (e) => { log('wrangler no contesta:', e?.message, '(¿lo arrancaste?)'); cortar(); });
  socket.on('error', cortar);
});

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  // Sin esto el navegador no compila el wasm mientras baja (`instantiateStreaming`
  // exige el mime exacto) y MediaPipe tarda visiblemente mas en arrancar.
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',   // el modelo de pose
  '.mp4': 'video/mp4',
};

/**
 * La pagina. Sale de `dist-local/`, compilado aparte del de GitHub Pages.
 *
 * Lo que no existe cae en index.html: la app es una sola pantalla y asi un
 * enlace con basura al final no da un 404 pelado.
 */
function estatico(url, res) {
  const limpio = decodeURIComponent(url.split('?')[0]);
  let archivo = path.join(RAIZ, limpio === '/' ? 'index.html' : limpio);
  // El join ya normaliza, pero se verifica igual: un `..` en la URL no puede
  // terminar sirviendo cualquier archivo de la maquina.
  if (!archivo.startsWith(RAIZ)) { res.writeHead(403); return res.end('no'); }
  if (!fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) archivo = path.join(RAIZ, 'index.html');

  if (!fs.existsSync(archivo)) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('falta dist-local: corré el build (ver el encabezado de este archivo)');
  }

  const ext = path.extname(archivo).toLowerCase();
  const html = ext === '.html';
  res.writeHead(200, {
    'content-type': TIPOS[ext] || 'application/octet-stream',
    // Los assets llevan hash en el nombre, asi que se pueden cachear fuerte.
    // El index no: es el que decide a que hash apuntar.
    'cache-control': html ? 'no-cache' : 'public, max-age=604800',
    'content-length': fs.statSync(archivo).size,
  });
  fs.createReadStream(archivo).pipe(res);
}

function cabeceras(req) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'connection', 'content-length'].includes(k)) continue;
    h[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return h;
}

const leer = (req) => new Promise((res) => {
  const p = [];
  req.on('data', (c) => p.push(c));
  req.on('end', () => res(Buffer.concat(p)));
});

/** Respuesta propia. Lleva CORS porque la pagina vive en otro dominio. */
function responder(res, status, cuerpo, req) {
  res.writeHead(status, {
    'content-type': status === 200 ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'access-control-allow-origin': req.headers.origin || '*',
    vary: 'Origin',
  });
  res.end(cuerpo);
}

servidor.listen(PUERTO, () => {
  log(`el sitio corre en esta PC, puerto ${PUERTO}`);
  log(`   la pagina             -> ${RAIZ}`);
  log(`   /api/cola y /api/sala -> wrangler dev en ${LOCAL.host}:${LOCAL.port}`);
  log(`   el resto de /api      -> ${PROD}`);
});
