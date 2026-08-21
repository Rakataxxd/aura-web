// Indices de MediaPipe Pose (33 puntos). Modulo aparte para que
// scoring.js y moves.js no se importen en circulo.
export const NOSE = 0;
export const L_SH = 11, R_SH = 12;
export const L_EL = 13, R_EL = 14;
export const L_WR = 15, R_WR = 16;
export const L_HIP = 23, R_HIP = 24;
export const L_KN = 25, R_KN = 26;
export const L_AN = 27, R_AN = 28;

/**
 * ESPACIO METRICO. Este es el bug que rompia t-pose, 6-7, scuba y dap.
 *
 * MediaPipe devuelve x normalizado por el ANCHO y y normalizado por el ALTO.
 * En un cuadro 16:9 una distancia horizontal real vale 0.5625 de lo que
 * valdria vertical; en 9:16 vale 1.78. O sea: la MISMA pose da numeros que
 * difieren 3.2x segun el telefono este acostado o parado.
 *
 * Todos los umbrales de moves.js estaban calibrados contra los muñecos
 * sinteticos, que sin querer modelaban un cuadro apaisado. En un telefono
 * vertical (como se usa de verdad) las distancias horizontales se estiraban:
 *   - t-pose:  la muñeca se salia del cuadro -> `needs` lo mataba
 *   - scuba:   manos "lejos" de la cara -> fL/fR pasaban de 1.5
 *   - 6-7:     antebrazos y separacion de manos fuera de rango
 * y mewing sobrevivia porque es la unica regla basada en distancias
 * VERTICALES (nariz -> hombros), inmune a la distorsion. Por eso era el
 * unico que funcionaba.
 *
 * Aca se convierte a un espacio donde 1.0 = alto del cuadro en las DOS
 * ejes, o sea geometria real. Todo moves.js consume esto y ya no le importa
 * la orientacion del aparato.
 *
 * `fuera` marca los landmarks que MediaPipe extrapolo fuera del encuadre:
 * en un cuadro vertical los brazos abiertos SIEMPRE se salen, y hay que
 * saberlo para decidir si se confia en la muñeca o en el codo.
 */
export function toMetric(lm, ar) {
  if (!lm) return null;
  const a = ar > 0 ? ar : 1;
  return lm.map((p) => ({
    x: p.x * a,
    y: p.y,
    visibility: p.visibility,
    fuera: p.x < 0.015 || p.x > 0.985 || p.y < 0.015 || p.y > 0.985,
  }));
}
