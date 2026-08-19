// Publica dist/ en la rama gh-pages.
// Crea un repo git desechable dentro de dist y lo empuja forzado:
// asi la rama gh-pages no arrastra historia y no se mezcla con main.
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const DIST = resolve('dist');
if (!existsSync(DIST)) {
  console.error('No hay dist/. Corré `npm run build` primero.');
  process.exit(1);
}

const run = (cmd, cwd = DIST) => execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();

const remote = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
if (!remote) {
  console.error('No hay remote origin configurado.');
  process.exit(1);
}

// Pages ignora archivos que empiezan con _ salvo que exista .nojekyll
writeFileSync(resolve(DIST, '.nojekyll'), '');

rmSync(resolve(DIST, '.git'), { recursive: true, force: true });
run('git init -q');
run('git checkout -q -b gh-pages');
run('git add -A');
run('git -c user.name=deploy -c user.email=deploy@local commit -q -m "deploy"');
console.log('Publicando en gh-pages…');
run(`git push -q --force ${remote} gh-pages:gh-pages`);
rmSync(resolve(DIST, '.git'), { recursive: true, force: true });

const slug = remote.replace(/\.git$/, '').split(/[:/]/).slice(-2);
console.log(`Listo -> https://${slug[0]}.github.io/${slug[1]}/`);
