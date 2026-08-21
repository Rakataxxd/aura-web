// ¿Sostener una pose sin hacer nada farmea aura?
//
// POR QUE EXISTE ESTE SCRIPT, si movetest.js ya tiene `sostenido_debe_ser_1`:
// ese test mantiene un muñeco PERFECTAMENTE QUIETO cinco segundos, y una
// persona real no lo esta. MEDIDO en video real, sosteniendo un gesto la
// muñeca igual deriva entre 0.19 y 0.23 torsos, y en un t-pose hasta 0.81.
// El re-armado por distancia (REARME_DIST) se dispara justamente con eso,
// asi que el test sintetico daba verde mientras la app de verdad podia estar
// regalando aura a quien se quedara quieto haciendo la pose.
//
// Aca se toma una ventana REAL donde la persona sostiene el gesto y se
// repite en bucle ida-y-vuelta hasta llenar una ronda de 15 s. Es
// exactamente "me quedo haciendo la pose toda la ronda", con el temblor de
// MediaPipe de verdad en vez de ruido inventado.
//
//   node scripts/sostener.mjs
//
// Sostener tiene que dar UN disparo. Si da mas, REARME_DIST quedo por debajo
// de la deriva natural y quedarse quieto es la estrategia optima, que es lo
// contrario de lo que el juego premia.

import { readFileSync } from 'node:fs';
import { Player } from '../src/scoring.js';

const reh = (lm) => lm && lm.map(([x, y, v, f]) => ({ x, y, visibility: v, fuera: !!f }));

// Ventanas donde la persona SOSTIENE el gesto, elegidas mirando el video.
// Las dos primeras son sostenidos de verdad (deriva 0.19-0.23). Las otras
// dos tienen movimiento propio del gesto (0.38 y 0.81) y por eso SI deben
// disparar varias veces: repetir un gesto es justamente lo que se premia.
const VENTANAS = [
  ['mewing quieto', 'testdata/batalla.json', 11.83, 13.02, 1],
  ['scuba quieto', 'testdata/scuba.json', 11.47, 13.70, 1],
  ['plegaria con movimiento', 'testdata/aurafarm2.json', 13.0, 14.9, null],
  ['t-pose con movimiento', 'testdata/batalla.json', 10.05, 10.90, null],
];

const RONDA = 15;
let falla = false;

for (const [tag, arch, a, b, esperado] of VENTANAS) {
  const trozo = JSON.parse(readFileSync(new URL(`../${arch}`, import.meta.url), 'utf8'))
    .crudos.filter((f) => f.t >= a && f.t <= b);
  // Ida y vuelta: empalmar el final con el principio daria un salto que el
  // detector leeria como movimiento y contaria como repeticion.
  const ciclo = [...trozo, ...[...trozo].reverse().slice(1, -1)];

  const p = new Player(0);
  let t = 0, i = 0, n = 0, bonus = 0;
  while (t < RONDA) {
    const f = ciclo[i++ % ciclo.length];
    t += f.dt;
    const lm = reh(f.lm);
    // El dump guarda metrico; se le pasa el mismo a los dos parametros
    // porque lo que se mide aca son los moves, no la energia.
    p.update(lm, t, lm);
    for (const e of p.drain()) if (e.kind === 'signature') { n++; bonus += e.value; }
  }

  const mal = esperado != null && n !== esperado;
  if (mal) falla = true;
  console.log(`${mal ? 'MAL ' : 'ok  '} ${tag.padEnd(24)} ${RONDA}s -> ${String(n).padStart(2)} disparos, ${bonus.toLocaleString('es-GT').padStart(8)} de bonus${esperado != null ? `   (esperado ${esperado})` : ''}`);
}

if (falla) {
  console.error('\nQuedarse quieto esta farmeando. Subi REARME_DIST por encima de la deriva natural (0.23 torsos medidos).');
  process.exit(1);
}
console.log('\nSostener una pose cuenta una sola vez.');
