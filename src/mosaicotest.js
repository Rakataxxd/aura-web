// Prueba la geometría de la grilla y del clip de sala SIN navegador.
//
// Las dos cosas que se rompen acá son de cuentas, no de pixeles: en qué
// disposición se reparten N recuadros, y cuándo un video hay que meterlo entero
// en su celda en vez de recortarlo. Las dos se pueden probar en node.
//
//   node -e "import('./src/mosaicotest.js').then(m=>console.log(JSON.stringify(m.run(),null,1)))"

import { repartir, debeContener } from './mosaico.js';

// El caso que motivó todo: cuatro personas en una pantalla ancha, una de ellas
// desde un teléfono vertical. Antes se veía una franja del techo de su cuarto.
const CELULAR = 720 / 1280;      // 0.5625
const COMPU = 16 / 9;

const AR_MAX = 16 / 9;

/** Lo mismo que hace acomodarTiles() después de elegir columnas. */
function limitar(w, h) {
  if (w / h > AR_MAX) return { w: h * AR_MAX, h };
  if (h / w > AR_MAX) return { w, h: w * AR_MAX };
  return { w, h };
}

export function run() {
  const fallas = [];
  const out = { fallas };

  // --- disposiciones esperadas de cualquier videollamada ---
  const casos = [
    { n: 1, W: 1280, H: 720, cols: 1 },
    { n: 2, W: 1280, H: 720, cols: 2 },   // lado a lado en apaisado
    { n: 2, W: 390, H: 760, cols: 1 },    // apiladas en un teléfono parado
    { n: 3, W: 1280, H: 720, cols: 2 },   // 2 arriba + 1 centrado abajo
    { n: 4, W: 1280, H: 720, cols: 2 },   // 2x2
    { n: 6, W: 1280, H: 720, cols: 3 },   // 3x2
  ];
  out.reparto = {};
  for (const c of casos) {
    const r = repartir(c.W, c.H, c.n);
    out.reparto[`${c.n}@${c.W}x${c.H}`] = { cols: r.cols, filas: r.filas, cw: Math.round(r.cw), ch: Math.round(r.ch) };
    if (r.cols !== c.cols) fallas.push(`reparto ${c.n}@${c.W}x${c.H}: ${r.cols} columnas, esperaba ${c.cols}`);
    // Ninguna disposición se puede salir del lienzo.
    if (r.cols * r.cw > c.W + 1 || r.filas * r.ch > c.H + 1) fallas.push(`reparto ${c.n}: se sale del lienzo`);
  }

  // --- el recorte del celular ---
  //
  // La celda de cuatro personas en una pantalla de 1900x870 salía de 946x431
  // (2.19:1). Ahí adentro, un video vertical con `cover` mostraba una banda de
  // 431 de alto sobre 1684 de video: el 25% del cuadro.
  const celda = limitar(946, 431);
  const arCelda = celda.w / celda.h;
  out.celda_limitada = { w: Math.round(celda.w), h: Math.round(celda.h), ar: +arCelda.toFixed(2) };
  if (arCelda > AR_MAX + 0.01) fallas.push(`la celda sigue siendo una franja: ${arCelda.toFixed(2)}:1`);

  out.encaje = {
    celular_en_celda_ancha: debeContener(CELULAR, arCelda),
    compu_en_celda_ancha: debeContener(COMPU, arCelda),
    compu_en_celda_cuadrada: debeContener(COMPU, 1),
    celular_en_celda_vertical: debeContener(CELULAR, 0.6),
  };
  // El teléfono vertical entra completo…
  if (!out.encaje.celular_en_celda_ancha) fallas.push('el celular se sigue recortando en una celda apaisada');
  // …y el que está en computadora sigue llenando su recuadro, que se ve mejor.
  if (out.encaje.compu_en_celda_ancha) fallas.push('un 16:9 no tiene por qué dejar franjas negras');
  // Una celda casi cuadrada contra un 16:9 ya es demasiada diferencia.
  if (!out.encaje.compu_en_celda_cuadrada) fallas.push('16:9 en celda cuadrada debería entrar completo');
  // Y un teléfono en un teléfono llena, como siempre.
  if (out.encaje.celular_en_celda_vertical) fallas.push('un vertical dentro de un vertical no se recorta casi nada');

  out.ok = fallas.length === 0;
  return out;
}
