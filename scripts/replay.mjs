// Re-corre el detector sobre landmarks YA extraidos de un video real.
//
// Existe porque pasar MediaPipe sobre un clip tarda ~60 s y hay que hacerlo
// en un navegador: iterar umbrales asi es imposible. `diagtest.js` vuelca los
// landmarks metricos frame a frame (window.__crudos) y esto los replaya en
// node en milisegundos, con el MISMO dt del video.
//
//   node scripts/replay.mjs testdata/aurafarm2.json
//   node scripts/replay.mjs testdata/aurafarm2.json --puertas dab,six-seven
//   node scripts/replay.mjs testdata/aurafarm2.json --rasgos 0.5 4.4

import { readFileSync } from 'node:fs';
import { MoveDetector, MOVES, buildCtx } from '../src/moves.js';
import { L_EL, R_EL, L_WR, R_WR } from '../src/landmarks.js';

const [, , archivo, ...args] = process.argv;
if (!archivo) { console.error('uso: node scripts/replay.mjs <dump.json> [--puertas ids] [--rasgos a b]'); process.exit(1); }

const dump = JSON.parse(readFileSync(archivo, 'utf8'));
const crudos = dump.crudos || dump;

const rehidratar = (lm) => lm && lm.map(([x, y, v, f]) => ({ x, y, visibility: v, fuera: !!f }));

const flag = (n) => { const i = args.indexOf(n); return i < 0 ? null : args.slice(i + 1); };
const idsPuerta = (flag('--puertas')?.[0] || '').split(',').filter(Boolean);
const ventana = flag('--rasgos')?.slice(0, 2).map(Number);

const det = new MoveDetector();
const disparos = [];
const puertas = {};   // id -> [{t, estado}]

for (const fr of crudos) {
  const lm = rehidratar(fr.lm);
  // Mismo orden que en la app: el estado de quietud se lee DENTRO de feed,
  // asi que para las puertas hay que reproducir el push de historia primero.
  const c = lm && buildCtx(lm);
  for (const m of det.feed(lm, fr.dt)) disparos.push({ t: fr.t, move: m.name });
  if (c) {
    const vel = det.velMuneca();
    for (const m of MOVES) {
      if (!m.test) continue;
      let estado;
      if (m.needs && !m.needs.every((i) => (lm[i].visibility ?? 1) >= 0.45)) estado = 'needs';
      else if (m.calm != null && vel > m.calm) estado = `calm(${vel.toFixed(1)}>${m.calm})`;
      else { let ok = false; try { ok = m.test(c); } catch { ok = false; } estado = ok ? 'ok' : 'test'; }
      (puertas[m.id] ??= []).push({ t: fr.t, estado, vel: +vel.toFixed(2) });
    }
  }
}

console.log('frames', crudos.length, 'dur', crudos.at(-1)?.t);
console.log('DISPAROS:');
for (const d of disparos) console.log(`  ${d.t.toFixed(2)}  ${d.move}`);

/** Tramos contiguos de 'ok', que es lo que decide si se llega al `hold`. */
function tramos(lista) {
  const out = [];
  let ini = null, fin = null;
  for (const p of lista) {
    if (p.estado === 'ok') { if (ini == null) ini = p.t; fin = p.t; }
    else if (ini != null) { out.push([ini, fin]); ini = null; }
  }
  if (ini != null) out.push([ini, fin]);
  return out;
}

for (const id of idsPuerta) {
  const l = puertas[id] || [];
  const cuenta = {};
  for (const p of l) { const k = p.estado.startsWith('calm') ? 'calm' : p.estado; cuenta[k] = (cuenta[k] || 0) + 1; }
  const hold = MOVES.find((m) => m.id === id)?.hold ?? 0;
  const tr = tramos(l);
  console.log(`\n== ${id} ==`, JSON.stringify(cuenta), `hold=${hold}`);
  console.log('  tramos ok:', tr.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}(${(b - a).toFixed(2)})`).join(' ') || '(ninguno)');
}

if (ventana) {
  const [a, b] = ventana;
  const filas = [];
  const det2 = new MoveDetector();
  for (const fr of crudos) {
    const lm = rehidratar(fr.lm);
    det2.feed(lm, fr.dt);
    if (fr.t < a || fr.t > b) continue;
    const c = lm && buildCtx(lm);
    if (!c) continue;
    const tilt = (p, q) => { const g = Math.abs(Math.atan2(q.y - p.y, q.x - p.x)) * 180 / Math.PI; return +(g > 90 ? 180 - g : g).toFixed(0); };
    filas.push({
      t: +fr.t.toFixed(2), vel: +det2.velMuneca().toFixed(1),
      lWr: [+c.lWr.x.toFixed(2), +c.lWr.y.toFixed(2)], rWr: [+c.rWr.x.toFixed(2), +c.rWr.y.toFixed(2)],
      lEl: [+c.lEl.x.toFixed(2), +c.lEl.y.toFixed(2)], rEl: [+c.rEl.x.toFixed(2), +c.rEl.y.toFixed(2)],
      codo: [Math.round(c.lElbow), Math.round(c.rElbow)],
      tiltL: tilt(c.lm[L_EL], c.lm[L_WR]), tiltR: tilt(c.lm[R_EL], c.lm[R_WR]),
      sep: +c.wristGap.toFixed(2), fL: +c.fL.toFixed(2), fR: +c.fR.toFixed(2),
    });
  }
  console.log(`\n== rasgos ${a}-${b} (${filas.length} frames) ==`);
  for (const f of filas) console.log(JSON.stringify(f));
}
