// El panel de /admin. Una sola pagina, sin build y sin dependencias.
//
// VIVE EN EL WORKER Y NO EN LA APP a proposito: la app se publica entera en
// GitHub Pages —el HTML, el JS y todo lo que se pueda leer con ver-codigo—,
// asi que un panel ahi seria una puerta a la vista de cualquiera que mire el
// bundle. Aca no lo linkea nada y sin la clave no devuelve un solo numero: lo
// que se sirve sin clave es esta cascara, que no dice nada.
export const PANEL = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>AURA · panel</title>
<style>
  :root { --tinta:#0a0a0c; --hueso:#f4efe4; --acido:#c6ff00; --magenta:#ff2e88; }
  * { box-sizing: border-box; }
  /* Va DESPUES de nada y con !important a proposito: el formulario de la clave
     es display:flex, y un display propio le gana al hidden del navegador. Sin
     esto, el panel entraba bien y seguia pidiendo la clave abajo. */
  [hidden] { display: none !important; }
  body {
    margin: 0; padding: 20px 16px 60px;
    background: var(--tinta); color: var(--hueso);
    font-family: "Share Tech Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 14px; line-height: 1.5;
  }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 15px; letter-spacing: .22em; margin: 0 0 4px; color: var(--acido); }
  h2 { font-size: 12px; letter-spacing: .18em; opacity: .55; margin: 30px 0 10px; font-weight: 400; }
  .sub { opacity: .45; font-size: 12px; margin: 0 0 22px; }

  .vivo { display: flex; align-items: baseline; gap: 10px; border: 1px solid rgba(198,255,0,.35); padding: 14px 16px; }
  .vivo b { font-size: 34px; color: var(--acido); font-weight: 400; line-height: 1; }
  .vivo small { opacity: .5; }

  .cajas { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
  .caja { border: 1px solid rgba(244,239,228,.18); padding: 11px 13px; }
  .caja span { display: block; font-size: 11px; letter-spacing: .12em; opacity: .45; }
  .caja b { font-size: 25px; font-weight: 400; color: var(--acido); }
  .caja em { font-style: normal; opacity: .4; font-size: 11px; }

  .barras { display: flex; align-items: flex-end; gap: 4px; height: 130px; }
  /* El tope de ancho es para los primeros dias: con una sola barra a flex:1 el
     grafico es un rectangulo verde de pared a pared que no parece un grafico.
     Las dos filas llevan el mismo tope para que la fecha caiga bajo su barra. */
  .barras div { flex: 1; max-width: 54px; background: var(--acido); min-height: 2px; opacity: .8; }
  .barras div:hover { opacity: 1; outline: 1px solid var(--hueso); }
  .pies { display: flex; gap: 4px; margin-top: 6px; font-size: 9px; opacity: .35; }
  .pies span { flex: 1; max-width: 54px; text-align: center; overflow: hidden; }

  table { width: 100%; border-collapse: collapse; }
  td { padding: 5px 0; border-bottom: 1px solid rgba(244,239,228,.09); }
  td.n { text-align: right; color: var(--acido); }
  td.g { width: 45%; }
  .lleno { display: block; height: 7px; background: rgba(198,255,0,.35); }

  input, button {
    font: inherit; background: transparent; color: var(--hueso);
    border: 1px solid rgba(244,239,228,.4); padding: 9px 13px;
  }
  button { cursor: pointer; }
  button:hover { border-color: var(--acido); color: var(--acido); }
  .mal { color: var(--magenta); }
  #entrar { display: flex; gap: 8px; flex-wrap: wrap; }
</style>
</head>
<body>
<main>
  <h1>ESCÁNER DE AURA · PANEL</h1>
  <p class="sub" id="sub">privado</p>
  <form id="entrar" hidden>
    <input id="clave" type="password" placeholder="clave" autocomplete="current-password" />
    <button>ENTRAR</button>
  </form>
  <div id="todo" hidden></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const LL = 'aura.admin';
const num = (n) => Number(n || 0).toLocaleString('es-GT');

$('entrar').addEventListener('submit', (ev) => {
  ev.preventDefault();
  localStorage.setItem(LL, $('clave').value.trim());
  cargar();
});

function pedirClave(msg) {
  $('sub').textContent = msg;
  $('sub').className = 'sub mal';
  $('entrar').hidden = false;
  $('todo').hidden = true;
  $('clave').focus();
}

async function cargar() {
  const clave = localStorage.getItem(LL) || '';
  if (!clave) return pedirClave('hace falta la clave');
  let r;
  try {
    r = await fetch('/api/admin/stats', { headers: { 'x-clave': clave } });
  } catch (e) {
    return pedirClave('no se pudo conectar');
  }
  if (r.status === 401) { localStorage.removeItem(LL); return pedirClave('clave incorrecta'); }
  if (!r.ok) return pedirClave('error ' + r.status);
  $('entrar').hidden = true;
  $('todo').hidden = false;
  $('sub').className = 'sub';
  pintar(await r.json());
}

// Las tablas se arman con textContent, nunca con innerHTML: el "de donde vino"
// lo escribe el navegador de quien entra, o sea que es texto de afuera.
function fila(tabla, celdas) {
  const tr = tabla.insertRow();
  for (const c of celdas) {
    const td = tr.insertCell();
    if (typeof c === 'string' || typeof c === 'number') td.textContent = c;
    else { td.className = c.clase || ''; if (c.nodo) td.appendChild(c.nodo); else td.textContent = c.txt; }
  }
  return tr;
}

function barra(pct) {
  const s = document.createElement('span');
  s.className = 'lleno';
  s.style.width = Math.max(2, pct * 100) + '%';
  return s;
}

function seccion(titulo) {
  const h = document.createElement('h2');
  h.textContent = titulo;
  $('todo').appendChild(h);
  return h;
}

function pintar(d) {
  $('todo').textContent = '';

  const vivo = document.createElement('div');
  vivo.className = 'vivo';
  const b = document.createElement('b');
  b.textContent = num(d.ahora);
  vivo.appendChild(b);
  const t = document.createElement('small');
  t.textContent = 'personas activas en los últimos 10 minutos';
  vivo.appendChild(t);
  $('todo').appendChild(vivo);

  const hoy = d.dias[0] || {};
  const sem = d.dias.slice(0, 7);
  const suma = (k) => sem.reduce((a, x) => a + Number(x[k] || 0), 0);

  seccion('HOY (' + (hoy.dia || '—') + ')');
  const cajas = document.createElement('div');
  cajas.className = 'cajas';
  const tHoy = (d.torneo || []).find((x) => x.dia === hoy.dia) || {};
  const datos = [
    ['PERSONAS', hoy.gente, 'únicas'],
    ['ABIERTAS', hoy.visitas, 'sesiones'],
    ['ESCANEOS', hoy.escaneos, 'rondas'],
    ['CLIPS', hoy.clips, 'bajados'],
    ['SALAS', hoy.salas, 'entradas'],
    ['TORNEO', tHoy.jugadores, num(tHoy.partidas || 0) + ' partidas'],
  ];
  for (const [k, v, pie] of datos) {
    const c = document.createElement('div');
    c.className = 'caja';
    const s = document.createElement('span'); s.textContent = k;
    const n = document.createElement('b'); n.textContent = num(v);
    const e = document.createElement('em'); e.textContent = ' ' + pie;
    c.append(s, n, e);
    cajas.appendChild(c);
  }
  $('todo').appendChild(cajas);

  seccion('ÚLTIMOS 7 DÍAS');
  const c7 = document.createElement('div');
  c7.className = 'cajas';
  for (const [k, v] of [['PERSONAS', suma('gente')], ['ABIERTAS', suma('visitas')],
                        ['ESCANEOS', suma('escaneos')], ['CLIPS', suma('clips')]]) {
    const c = document.createElement('div');
    c.className = 'caja';
    const s = document.createElement('span'); s.textContent = k;
    const n = document.createElement('b'); n.textContent = num(v);
    c.append(s, n);
    c7.appendChild(c);
  }
  $('todo').appendChild(c7);

  // Personas por dia. Sumar los "unicos" de varios dias NO da los unicos del
  // periodo —el que vuelve manana se cuenta dos veces— y no hay forma de que
  // lo de: el hash del visitante cambia todos los dias justamente para eso.
  const serie = d.dias.slice(0, 14).reverse();
  if (serie.length) {
    seccion('PERSONAS POR DÍA');
    const tope = Math.max(...serie.map((x) => Number(x.gente) || 0), 1);
    const caja = document.createElement('div');
    caja.className = 'barras';
    const pies = document.createElement('div');
    pies.className = 'pies';
    for (const x of serie) {
      const bar = document.createElement('div');
      bar.style.height = ((Number(x.gente) || 0) / tope * 100) + '%';
      bar.title = x.dia + ': ' + num(x.gente) + ' personas';
      caja.appendChild(bar);
      const p = document.createElement('span');
      p.textContent = String(x.dia).slice(8);
      pies.appendChild(p);
    }
    $('todo').append(caja, pies);
  }

  seccion('PAÍSES (7 DÍAS)');
  const tp = document.createElement('table');
  const topP = Math.max(...d.paises.map((x) => x.gente), 1);
  for (const p of d.paises) {
    fila(tp, [p.pais, { clase: 'g', nodo: barra(p.gente / topP) }, { clase: 'n', txt: num(p.gente) }]);
  }
  $('todo').appendChild(tp);

  seccion('DE DÓNDE VIENEN (7 DÍAS)');
  const tr = document.createElement('table');
  const topR = Math.max(...d.refs.map((x) => x.n), 1);
  for (const r of d.refs) {
    fila(tr, [r.ref, { clase: 'g', nodo: barra(r.n / topR) }, { clase: 'n', txt: num(r.n) }]);
  }
  $('todo').appendChild(tr);

  seccion('DÍA POR DÍA');
  const td = document.createElement('table');
  fila(td, ['día', 'personas', 'escaneos', 'clips', 'salas']).style.opacity = '.45';
  for (const x of d.dias) {
    fila(td, [x.dia, { clase: 'n', txt: num(x.gente) }, { clase: 'n', txt: num(x.escaneos) },
              { clase: 'n', txt: num(x.clips) }, { clase: 'n', txt: num(x.salas) }]);
  }
  $('todo').appendChild(td);

  $('sub').textContent = num(d.total.eventos) + ' eventos guardados · actualizado ' +
    new Date().toLocaleTimeString('es-GT');
}

cargar();
// El numero de "ahora" es lo unico que se mira fijo, asi que la pagina se
// refresca sola. Medio minuto: mas seguido no cambia nada y son consultas.
setInterval(() => { if (!document.hidden && $('todo').hidden === false) cargar(); }, 30000);
</script>
</body>
</html>`;
