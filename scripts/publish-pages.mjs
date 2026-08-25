// Publica el sitio en Cloudflare Pages (el dominio propio, auratester.com).
//
// POR QUE ADEMAS DE gh-pages. GitHub Pages tiene un limite blando de 100 GB al
// mes y cada visitante nuevo se baja 8.5 MB (el wasm de MediaPipe y el modelo,
// ya comprimidos): son ~12.000 visitas al mes y despues GitHub avisa y corta.
// El ancho de banda de Cloudflare Pages no se cobra. gh-pages se deja vivo como
// espejo: si Pages se cae, el link viejo sigue funcionando.
//
// DIFERENCIAS CON EL BUILD DE gh-pages:
//   base            /aura-web/  ->  /            (aca el sitio vive en la raiz)
//   VITE_API_RANKING  .workers.dev -> api.auratester.com   (ver .env.pages)
//
// USO:  npm run deploy:pages
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const PROYECTO = 'auratester';
const SALIDA = resolve('dist-pages');

const run = (cmd) => execSync(cmd, { stdio: 'inherit', shell: true });

run('npx vite build --mode pages --outDir dist-pages --base=/');

// Los videos de prueba viven en public/ para que `vite dev` los sirva, pero son
// 9.6 MB que no le sirven a nadie: si se suben, se publican.
const testdata = resolve(SALIDA, 'testdata');
if (existsSync(testdata)) rmSync(testdata, { recursive: true, force: true });

// `--commit-dirty` para no depender de que el arbol este limpio, y `--branch`
// fijo porque Pages trata cualquier otra rama como preview (url distinta, y el
// worker rechaza ese Origin).
run(`npx wrangler pages deploy dist-pages --project-name=${PROYECTO} --branch=main --commit-dirty=true`);
