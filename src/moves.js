// NIVEL 2: movimientos con nombre, detectados por reglas de angulos.
//
// ENTRADA: landmarks en ESPACIO METRICO (ver toMetric en landmarks.js).
// NO le pases landmarks crudos de MediaPipe: en un cuadro vertical las
// distancias horizontales vienen estiradas 1.78x y en apaisado encogidas
// 0.56x, y todos los umbrales de aca dejan de significar nada. Ese era el
// motivo de que solo mewing (regla vertical) funcionara en telefono.
//
// Los numeros de este archivo estan en TORSOS (centro de hombros -> centro
// de caderas = 1.0) o en CARAS (F = nariz -> centro de hombros), que en un
// adulto valen ~0.29 y ~0.12 de la altura del cuerpo.
//
// CUATRO REGLAS QUE COSTARON BUGS REALES:
//
// 1. MediaPipe devuelve coordenadas para landmarks FUERA DE CUADRO, inventadas
//    y con visibility baja. Si no se filtran, un encuadre selfie produce
//    tobillos fantasma. Todo move declara sus landmarks en `needs`.
//
// 2. Normalizar por torso falla cuando las caderas estan al borde del cuadro.
//    Los gestos de cara se miden contra F (nariz->centro de hombros).
//
// 3. Una configuracion que ocurre POR ACCIDENTE a mitad de un movimiento
//    rapido no es un gesto. Todo move estatico exige quietud (`calm`): un
//    gesto se sostiene, no se atraviesa. Sin esto, bailar dispara de todo.
//
// 4. EXCEPCION al punto 1: el t-pose. Con el telefono vertical los brazos
//    abiertos se salen del cuadro SIEMPRE. Exigir muñecas visibles lo hacia
//    literalmente indetectable en el aparato donde se usa la app. Ese move
//    usa la punta de brazo que haya (muñeca si esta dentro, si no el codo).

import { NOSE, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN } from './landmarks.js';

const VIS = 0.45;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const seen = (lm, i) => (lm[i].visibility ?? 1) >= VIS;
const allSeen = (lm, idx) => idx.every((i) => seen(lm, i));

function angle(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (d < 1e-6) return 180;
  return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / d))) * 180 / Math.PI;
}

export function buildCtx(lm) {
  if (!allSeen(lm, [L_SH, R_SH])) return null;
  const sc = mid(lm[L_SH], lm[R_SH]);
  const hc = mid(lm[L_HIP], lm[R_HIP]);

  const SW = dist(lm[L_SH], lm[R_SH]);
  // Sin nariz visible se estima la escala de cara desde los hombros. Exigir
  // la nariz aca tumbaba TODOS los moves, hasta los que no miran la cara.
  // Proporciones reales de adulto en espacio metrico: F/SW ~ 0.52, T/SW ~ 1.26.
  // Piso contra el ancho de hombros: MEDIDO en video real, al agachar la
  // cabeza (dab, mewing mirando abajo) la nariz se acerca al centro de
  // hombros y F cae a la MITAD. Todo lo que se mide en caras se duplicaba de
  // golpe y los gestos de cara se caian justo cuando se hacen bien.
  const F = Math.max(seen(lm, NOSE) ? dist(lm[NOSE], sc) : 0, SW * 0.4);
  const hipsOk = allSeen(lm, [L_HIP, R_HIP]);

  let T = hipsOk ? dist(sc, hc) : 0;
  if (!(T > 0.02)) T = Math.max(SW * 1.26, F * 2.4);
  if (!(T > 0.02) || !(F > 0.01)) return null;

  const n = (p) => ({ x: (p.x - sc.x) / T, y: (p.y - sc.y) / T });
  return {
    lm, T, F, SW, sc, hipsOk, n,
    nose: lm[NOSE],
    lWr: n(lm[L_WR]), rWr: n(lm[R_WR]),
    lEl: n(lm[L_EL]), rEl: n(lm[R_EL]),
    lAn: n(lm[L_AN]), rAn: n(lm[R_AN]),
    hip: n(hc),
    knee: n(mid(lm[L_KN], lm[R_KN])),
    lElbow: angle(lm[L_SH], lm[L_EL], lm[L_WR]),
    rElbow: angle(lm[R_SH], lm[R_EL], lm[R_WR]),
    wristGap: dist(lm[L_WR], lm[R_WR]) / T,
    fL: dist(lm[L_WR], lm[NOSE]) / F,
    fR: dist(lm[R_WR], lm[NOSE]) / F,
  };
}

const ARMS = [L_SH, R_SH, L_EL, R_EL, L_WR, R_WR];
const FACE_ARMS = [NOSE, L_SH, R_SH, L_EL, R_EL, L_WR, R_WR];

/**
 * Punta usable del brazo, en torsos.
 *
 * Con el telefono VERTICAL el cuadro mide 0.56 alturas de ancho y un adulto
 * en cruz mide 1.0 de punta a punta: las muñecas quedan fuera del cuadro
 * salvo que estes lejisimos. Por eso, si la muñeca no esta visible y dentro,
 * se usa el codo, que casi siempre si entra. Sin esto el t-pose era
 * indetectable en telefono, que es donde se usa la app.
 */
function puntaBrazo(c, elb, wr) {
  const e = c.lm[elb];
  if (verWr(c, wr)) return c.n(c.lm[wr]);
  if ((e.visibility ?? 1) >= 0.25) return c.n(e);
  return null;
}

/** La muñeca se ve Y esta dentro del encuadre: se puede confiar en ella. */
const verWr = (c, wr) => (c.lm[wr].visibility ?? 1) >= VIS && !c.lm[wr].fuera;

/**
 * Brazo estirado hacia AFUERA y horizontal. Es la forma del t-pose que
 * sobrevive a que la muñeca se salga del cuadro: la direccion
 * hombro -> punta es horizontal aunque la punta sea el codo.
 */
function brazoEnCruz(c, sh, elb, wr) {
  const s = c.n(c.lm[sh]);
  const p = puntaBrazo(c, elb, wr);
  if (!p) return null;
  const lado = Math.sign(s.x) || (sh === L_SH ? -1 : 1);
  const dx = (p.x - s.x) * lado;          // positivo = se aleja del cuerpo
  const dy = p.y - s.y;
  const largo = Math.hypot(dx, dy);
  // codo estirado ~0.64 torsos, muñeca ~1.15. 0.45 deja pasar los dos
  // aunque la pose venga floja.
  // 0.3, no 0.45: MEDIDO en video real sentado y cerca, el brazo que se va
  // al borde del cuadro le queda a MediaPipe en 0.35-0.44 torsos de largo
  // (lo aplasta contra el borde). Con 0.45 el t-pose se caia por 0.01.
  if (!(dx > 0 && largo > 0.3)) return null;
  if (Math.abs(dy) > largo * 0.5) return null;   // < ~27 grados de la horizontal
  return p;
}

const BRAZO = {
  L: { sh: L_SH, el: L_EL, wr: L_WR, ang: 'lElbow', f: 'fL' },
  R: { sh: R_SH, el: R_EL, wr: R_WR, ang: 'rElbow', f: 'fR' },
};

/**
 * SCUBA: una mano en la BOCA (el regulador) y la otra MOVIENDOSE frente al
 * pecho. El buzo.
 *
 * ESTA REGLA SE REESCRIBIO ENTERA PORQUE DESCRIBIA OTRO GESTO. Las dos
 * versiones anteriores buscaban una mano pellizcando la nariz y la otra
 * PLANA SOBRE LA CABEZA. No es el gesto que hace la gente: en un video de
 * 15 segundos haciendo scuba a proposito, no hay UN SOLO cuadro donde una
 * mano pase por encima de la cabeza — el codo nunca cruza la linea de
 * hombros. Por eso el scuba no salia nunca por mas que se aflojaran los
 * umbrales: se estaba midiendo una pose que nadie hacia.
 *
 * Lo que si pasaba es que ese gesto disparaba MEWING (92 de 112 cuadros) y
 * PLEGARIA (61), porque las tres cosas tienen una mano cerca de la cara.
 *
 * Numeros MEDIDOS sobre los 112 cuadros del scuba real, contra las ventanas
 * de mewing (3 videos), plegaria (2) y 6-7:
 *
 *   rasgo         SCUBA          mewing            plegaria
 *   codo libre    35-61 grados   124-151 (cuelga)  12-48
 *   mano libre y  0.33-0.45      0.43-0.84 (baja)  0.23-0.38
 *   mano libre x  0.05-0.33      0.40-0.63 (afuera) 0.05-0.34
 *   dist a nariz  2.32-2.63      2.67-3.80         2.02-2.66
 *   separacion    0.50-0.73      0.74-1.30         0.37-0.62
 *
 * El codo del brazo libre es el separador limpio contra el mewing (ahi la
 * mano CUELGA, el codo se abre); contra la plegaria son las manos separadas
 * y a distinta altura. Con esto la regla cubre 84% de los cuadros del gesto
 * real y no toca ni un cuadro de dab, t-pose ni mewing en los tres videos.
 */
function esScuba(c, a, b) {
  // a = la mano que va a la BOCA. b = la que se mueve frente al pecho.
  if (!verWr(c, a.wr) || !verWr(c, b.wr)) return false;
  const boca = c.n(c.lm[a.wr]);
  const pecho = c.n(c.lm[b.wr]);
  if (!(c[a.f] < 1.70)) return false;                        // la mano TOCA la cara
  if (!(boca.y > -0.20 && boca.y < 0.30)) return false;      // a la altura de la boca
  if (!(pecho.y > 0.30 && pecho.y < 0.58)) return false;     // a la altura del pecho
  if (!(Math.abs(pecho.x) < 0.42)) return false;             // DELANTE del cuerpo, no al costado
  if (!(pecho.y - boca.y > 0.24)) return false;              // una arriba y otra abajo
  // El brazo del pecho va PLEGADO. En el mewing la otra mano cuelga y ese
  // codo se abre a 124-151 grados; aca MEDIDO da 35-61. Es el separador mas
  // limpio que hay entre los dos gestos.
  if (!(c[b.ang] > 25 && c[b.ang] < 85)) return false;
  // Y las manos NO estan juntas: juntas es la plegaria.
  return c.wristGap > 0.47;
}

/** ¿Alguna de las dos asignaciones de manos da scuba? */
const hayScuba = (c) => esScuba(c, BRAZO.L, BRAZO.R) || esScuba(c, BRAZO.R, BRAZO.L);

/**
 * DAB: un brazo plegado con la cara metida en el codo, el otro estirado en
 * diagonal hacia ARRIBA y afuera.
 *
 * Lo que lo separa del mewing —que tambien tiene una mano en la cara— es LA
 * OTRA MANO: en mewing cuelga (n.y ~ +0.7), en el dab apunta arriba
 * (n.y ~ -0.2). Sin esa condicion el dab disparaba MEWING, que es
 * exactamente lo que pasaba en el video real.
 *
 * El brazo estirado usa `puntaBrazo`: a corta distancia esa muñeca se sale
 * del cuadro constantemente.
 */
function esDab(c, a, b) {
  if (!(c[a.f] < 1.9) || !verWr(c, a.wr) || !(c[a.ang] < 110)) return false;
  const pw = c.n(c.lm[a.wr]);
  if (!(pw.y > -1.2 && pw.y < 0.55)) return false;          // mano a la altura de la cara
  // b = el brazo lanzado. MEDIDO sobre seis dabs seguidos de video real
  // (sentado, camara cerca): la muñeca de ese brazo queda a la ALTURA del
  // hombro en x (0.5-0.7 torsos, el hombro esta en 0.6) y el codo apenas
  // 0.13 mas afuera. Exigir que la punta pasara 0.25 torsos del hombro, y
  // ademas codo estirado (>110 grados, cuando el real oscilaba 5-60),
  // rechazaba los SEIS. El dab de verdad no siempre se lanza: sentado se
  // hace corto y plegado.
  //
  // Lo que sobrevive a todos: el brazo va ARRIBA (codo y muñeca a la altura
  // de los hombros o por encima), hacia el lado de su propio hombro, y la
  // mano lejos de la cara — que es justo lo que el mewing (mano colgando) y
  // la plegaria (manos al pecho) no tienen.
  const s = c.n(c.lm[b.sh]);
  const lado = Math.sign(s.x) || 1;
  const el = c.n(c.lm[b.el]);
  const p = puntaBrazo(c, b.el, b.wr) || el;
  // El codo del brazo lanzado queda POR DEBAJO DE LA NARIZ (MEDIDO: -0.11 a
  // +0.2 en dabs reales, con la nariz en -0.41). El techo es lo que lo
  // separa del SCUBA cuando esa mano se sale del cuadro y hay que leer el
  // codo: ahi el codo va sobre la cabeza, por encima de la nariz.
  if (!(el.y < 0.25 && el.y > c.n(c.nose).y && p.y < 0.25)) return false;
  if (!(el.x * lado > 0.3)) return false;                   // codo del lado de su hombro
  // AL COSTADO de la cabeza, no encima: es lo unico que separa el dab del
  // SCUBA, que tambien lleva una mano a la cara y la otra en alto — pero
  // esa mano va sobre la cabeza (0.1-0.3 torsos de la nariz) mientras que en
  // el dab se va al costado (MEDIDO: 0.5-0.8 en seis dabs reales).
  if (!((p.x - c.n(c.nose).x) * lado > 0.45)) return false;
  if (verWr(c, b.wr) && !(c[b.f] > 2.2)) return false;      // esa mano NO esta en la cara
  return true;
}

// `calm`: velocidad maxima de muñeca (torsos/segundo) permitida para que
// cuente. Un gesto se sostiene; atravesarlo bailando no vale.
//
// `hold`: cuanto tiene que aguantar la geometria antes de disparar. OJO con
// subirlo: es la mitad de la latencia que se siente. MEDIDO replayando los
// dos videos reales, la mediana desde el primer cuadro con la pose correcta
// hasta el callout era 0.41 s (0.69 el peor), y en una ronda de 15 segundos
// eso es lo que hace imposible encadenar. Bajando el hold de los cuatro
// gestos que se encadenan —dab, mewing, scuba, plegaria— la mediana queda en
// 0.18 s, aparecen 2 detecciones legitimas mas por video, y no se cuela
// ningun falso positivo (ni en los videos ni en movetest.js).
//
// El t-pose NO se toca: es una pose que se sostiene, no se encadena, y
// bajarle el hold la hacia disparar con rachas de 0.17 s que son ruido.
export const MOVES = [
  {
    id: 'dap', name: 'DAP', bonus: 22000, cd: 6, versus: true,
    needs: [L_WR, R_WR],
    line: '¡DAP REGISTRADO! AURA COMPARTIDA',
  },
  {
    // cd 1.5, no 6: los moves temporales no se re-arman soltandolos (no
    // tienen `test`), asi que el cooldown es lo UNICO que los deja repetir.
    // Con 6 segundos, cuatro segundos de 6-7 seguido contaban una sola vez
    // en una ronda de 15. Repetir ya cuesta tres alternancias nuevas (~1.2 s):
    // el cooldown no tiene que agregar mas freno que ese.
    // 0.8, no 1.5: MEDIDO en video real, las alternancias salen cada 0.27 s,
    // asi que juntar las tres que exige el gesto cuesta 0.80 s. Con cd 1.5
    // el reloj mandaba y no la persona — los disparos salian clavados cada
    // 1.53 s por mas rapido que se hiciera, que es el "casi no lo detecta".
    id: 'six-seven', name: '6-7', bonus: 18000, cd: 0.8, temporal: true,
    needs: ARMS,
    line: 'SEIS… SIETE. CONFIRMADO.',
  },
  {
    id: 'dab', name: 'DAB', bonus: 16000, hold: 0.10, cd: 3, calm: 6.5,
    // La muñeca del brazo estirado se sale del cuadro a corta distancia:
    // no puede estar en `needs` (ver esDab, usa el codo de respaldo).
    needs: [NOSE, L_SH, R_SH, L_EL, R_EL],
    line: 'DAB. NADIE TE PIDIÓ ESO.',
    test: (c) => esDab(c, BRAZO.L, BRAZO.R) || esDab(c, BRAZO.R, BRAZO.L),
  },
  {
    id: 'scuba', name: 'SCUBA', bonus: 15000, hold: 0.15, cd: 5, calm: 5.0,
    // Las muñecas se chequean adentro: la mano de arriba se sale del cuadro
    // constantemente, porque la cabeza ya esta cerca del borde.
    needs: [NOSE, L_SH, R_SH, L_EL, R_EL],
    line: 'INMERSIÓN DETECTADA',
    test: hayScuba,
  },
  {
    // calm 3.0, no 4.0: el 6-7 tambien deja UNA mano a la altura de la cara
    // con la otra abajo, medio segundo por vez. En video real eso disparaba
    // un MEWING falso en pleno 6-7. Lo que no comparten es la quietud: el
    // mewing se sostiene (vel < 2.6 medida) y el 6-7 alterna (vel ~ 3.2).
    id: 'mewing', name: 'MEWING', bonus: 14000, hold: 0.20, cd: 5, calm: 3.0,
    needs: FACE_ARMS,
    line: 'LÍNEA MAXILAR CONFIRMADA',
    // UNA mano junto a la cara y la otra claramente lejos. Ese contraste
    // es lo unico que hace falta para separarlo del scuba.
    // El "lejos" es RELATIVO al "cerca": un umbral fijo fallaba cuando la
    // mano buena quedaba a media cara y la otra colgando a media altura.
    // El otro brazo tiene que COLGAR. Sin esa condicion el DAB —que tambien
    // tiene una mano en la cara— disparaba MEWING: pasaba en el video real,
    // el dab se anotaba como mewing y el dab nunca existia.
    // MEDIDO sobre dos mewings reales seguidos: con `near*2` el segundo se
    // caia por centesimas (mano a 1.35 caras, la otra a 2.65 contra 2.70
    // pedidas) y con `otro.y > 0.35` se caia de nuevo cuando la mano libre
    // descansaba a media altura (0.34). Las dos condiciones existen para
    // separar del DAB, donde la otra mano va ARRIBA (y ~ -0.2): 1.6 y 0.2
    // siguen separandolo con margen de sobra.
    // `codoOtro > 90`: la otra mano tiene que COLGAR, y un brazo que cuelga
    // tiene el codo abierto. MEDIDO en mewings reales de los tres videos:
    // 124-151 grados. En el SCUBA esa mano esta plegada frente al pecho
    // (35-61) y sin esta condicion el scuba disparaba MEWING en 92 de sus
    // 112 cuadros — que es literalmente lo que se veia en pantalla.
    test: (c) => {
      if (hayScuba(c)) return false;
      const una = (near, far, wr, otro, codoOtro) => near < 1.7 && far > Math.max(1.9, near * 1.6)
        && wr.y > c.nose.y - c.F * 0.5
        && wr.y < c.sc.y + c.F * 0.6
        && c.n(otro).y > 0.2
        && codoOtro > 90;
      return una(c.fL, c.fR, c.lm[L_WR], c.lm[R_WR], c.rElbow)
        || una(c.fR, c.fL, c.lm[R_WR], c.lm[L_WR], c.lElbow);
    },
  },
  {
    id: 'giro', name: 'GIRO COMPLETO', bonus: 12000, cd: 5, temporal: true,
    needs: [NOSE, L_SH, R_SH],
    line: 'ROTACIÓN NO AUTORIZADA',
  },
  {
    id: 't-pose', name: 'T-POSE', bonus: 11000, hold: 0.26, cd: 6, calm: 4.5,
    // Solo hombros: los brazos abiertos se salen del cuadro en vertical y
    // exigirlos en `needs` era lo que hacia el move imposible en telefono.
    needs: [L_SH, R_SH],
    line: 'AFIRMANDO DOMINANCIA',
    test: (c) => {
      const a = brazoEnCruz(c, L_SH, L_EL, L_WR);
      const b = brazoEnCruz(c, R_SH, R_EL, R_WR);
      if (!a || !b) return false;
      // MEDIDO: en un t-pose real sentado el angulo de codo del brazo que se
      // va al borde oscila entre 94 y 175 grados frame a frame (MediaPipe lo
      // pierde). Exigir codo estirado rompia el `hold` cada dos frames. La
      // horizontalidad hombro->punta ya dice lo que hace falta.
      return Math.abs(a.y - b.y) <= 0.6;                       // los dos a la misma altura
    },
  },
  {
    id: 'sentadilla', name: 'BAJANDO', bonus: 9000, hold: 0.3, cd: 5, calm: 5.0,
    needs: [L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN],
    line: 'HASTA EL SUELO',
    // SENTADO EN UNA SILLA LA CADERA TAMBIEN QUEDA A LA ALTURA DE LAS
    // RODILLAS. En el video real esto disparaba "HASTA EL SUELO" mientras el
    // tipo estaba sentado haciendo gestos de cara, y se comia el momento.
    //
    // Filtrar por visibility no alcanza: con las piernas fuera de cuadro
    // MediaPipe las inventa CON visibility alta (se ven dibujadas en el
    // esqueleto del clip). Lo que no puede inventar es que esten DENTRO del
    // encuadre. Una sentadilla que no se ve no es una sentadilla.
    test: (c) => c.hipsOk
      && !c.lm[L_KN].fuera && !c.lm[R_KN].fuera
      && !c.lm[L_AN].fuera && !c.lm[R_AN].fuera
      && c.hip.y > c.knee.y - 0.38
      && Math.abs(c.n(c.lm[L_KN]).y - c.n(c.lm[R_KN]).y) < 0.5,
  },
  {
    id: 'manos-arriba', name: 'MANOS ARRIBA', bonus: 8000, hold: 0.26, cd: 5, calm: 4.5,
    // Mismo caso que el t-pose: con el cuerpo entero en cuadro, las manos
    // sobre la cabeza quedan ARRIBA del borde. Si no se ven, vale el codo,
    // que con los brazos en alto tambien queda por encima de los hombros.
    needs: [L_SH, R_SH, L_EL, R_EL],
    line: 'INVOCANDO ALGO',
    test: (c) => {
      const a = puntaBrazo(c, L_EL, L_WR), b = puntaBrazo(c, R_EL, R_WR);
      if (!a || !b) return false;
      if (!(a.y < -0.5 && b.y < -0.5)) return false;
      if (!verWr(c, L_WR) || !verWr(c, R_WR)) return true;
      return c.lWr.y < c.lEl.y && c.rWr.y < c.rEl.y
        && c.lElbow > 105 && c.rElbow > 105;
    },
  },
  {
    id: 'rezo', name: 'PLEGARIA', bonus: 7000, hold: 0.24, cd: 6, calm: 3.0,
    needs: ARMS,
    line: 'PIDIENDO AYUDA SUPERIOR',
    // Manos juntas AL PECHO, claramente debajo de la cara. Sin esa
    // condicion el scuba (manos juntas a la altura de los ojos) tambien
    // disparaba plegaria.
    // 0.6 torsos, no 0.45: MEDIDO con las manos JUNTAS delante del pecho un
    // segundo y medio, MediaPipe reporta la separacion entre 0.34 y 0.64 —
    // las muñecas superpuestas son el peor caso para el modelo. Con 0.45 la
    // plegaria pasaba a rachas de 0.2 s y no llegaba nunca al `hold`. El
    // 6-7, que es el gesto mas parecido en altura, no baja de 0.67.
    // El scuba manda: tiene una mano frente al pecho igual que la plegaria y
    // se pisan en la mitad de los cuadros. Es el gesto mas especifico de los
    // dos (pide la otra mano en la boca) y vale mas, asi que gana el.
    test: (c) => !hayScuba(c)
      && c.wristGap < 0.6
      && c.lm[L_WR].y > c.nose.y + c.F * 0.7
      && c.lWr.y < 0.85
      && c.lElbow < 140 && c.rElbow < 140
      && Math.abs(c.lWr.x) < 0.8 && Math.abs(c.rWr.x) < 0.8,
  },
];

const BY_ID = Object.fromEntries(MOVES.map((m) => [m.id, m]));

/** Cuanto hay que SOLTAR el gesto para que vuelva a contar. */
const REARME = 0.25;
/**
 * ...o cuanto tiene que ALEJARSE la mano del punto exacto donde disparo.
 *
 * Soltar por TIEMPO no alcanza para repetir. MEDIDO en video real haciendo
 * dabs seguidos: entre uno y otro el test se cae en huecos de 0.07-0.13 s y
 * `suelto` se vuelve a cero en cuanto un cuadro pasa, asi que nunca junta los
 * 0.25 s y el gesto queda trabado. Un segundo entero de dabs daba UN disparo.
 * Peor todavia con el dab del OTRO LADO: la pose espejada tambien pasa el
 * test, o sea que cambiar de brazo no suelta nada y no contaba nunca.
 *
 * Lo que si separa "repetir" de "sostener" es la MANO: MEDIDO, entre dos
 * dabs la muñeca se va a 0.9 torsos del punto donde disparo el anterior,
 * mientras que sosteniendo la pose el temblor de MediaPipe no pasa de 0.06.
 * A 0.45 no hay como confundirlos.
 */
const REARME_DIST = 0.45;
/**
 * ...y aun soltandolo, no puede repetirse mas rapido que esto.
 * 0.45, no 0.7: en video real los dabs seguidos salen cada ~0.6 s y el
 * segundo caia dentro del antirrebote del primero.
 */
const ANTIREBOTE = 0.45;
/**
 * Velocidad a la que se pierde el `hold` acumulado cuando el test falla,
 * en segundos de gesto por segundo. Con 1.6 un gesto que pasa 2 de cada 3
 * cuadros sigue sumando; uno que pasa 1 de cada 3 se apaga.
 *
 * 1.2, no 1.6: el tiempo real hasta el disparo no es `hold`, es
 * hold / (p - (1-p)*FUGA) con p = fraccion de cuadros que pasan el test.
 * Como MediaPipe tiembla, p ronda 0.7 y con 1.6 eso multiplica la espera por
 * 4.5. MEDIDO replayando los dos videos: con 1.6 un DAB entero (aurafarm2,
 * 7.9-8.1) no llegaba a disparar nunca; con 1.2 dispara y no aparece ningun
 * falso positivo nuevo en los 469 cuadros de video real ni en el sintetico.
 */
const FUGA = 1.2;

export class MoveDetector {
  constructor() {
    this.held = {};
    this.cool = {};
    this.armado = {};   // ¿ya se solto desde la ultima vez que disparo?
    this.suelto = {};   // cuanto lleva sin cumplirse
    this.ancla = {};    // donde estaban las manos cuando disparo (ver REARME_DIST)
    this.flips = [];
    this.lastSign = 0;
    this.postureGrace = 0;
    this.girosFlips = [];
    this.hist = [];        // ventana corta de posiciones normalizadas
    this.t = 0;
  }

  /**
   * Velocidad de muñeca en torsos/segundo, SOLO del tramo reciente.
   * Promediar los 2.2s enteros era un bug: si te movias y despues hacias
   * la pose, el promedio seguia alto por lo de antes y la pose nunca
   * contaba como quieta. Bloqueaba casi todos los moves.
   */
  velMuneca(ventana = 0.3) {
    const h = this.hist;
    if (h.length < 3) return 0;
    let s = 0, n = 0;
    for (let i = h.length - 1; i > 0; i--) {
      if (this.t - h[i].t > ventana) break;
      const dt = h[i].t - h[i - 1].t;
      if (dt <= 0) continue;
      s += (Math.hypot(h[i].lWr.x - h[i - 1].lWr.x, h[i].lWr.y - h[i - 1].lWr.y)
        + Math.hypot(h[i].rWr.x - h[i - 1].rWr.x, h[i].rWr.y - h[i - 1].rWr.y)) / 2 / dt;
      n++;
    }
    return n ? s / n : 0;
  }

  /**
   * Recorrido acumulado de un punto en la ventana reciente.
   *
   * Antes sumaba los 2.2s enteros y eso rompia el 6-7: levantar los brazos
   * para ponerte en posicion mueve MUCHO los codos, y ese recorrido de
   * entrada seguia contando mientras hacias el gesto. La comparacion
   * manos>codos nunca se cumplia. Solo cuenta lo reciente, que es cuando el
   * gesto de verdad esta pasando.
   */
  recorrido(clave, ventana = 1.1) {
    const h = this.hist;
    let s = 0;
    for (let i = 1; i < h.length; i++) {
      if (this.t - h[i].t > ventana) continue;
      s += Math.hypot(h[i][clave].x - h[i - 1][clave].x, h[i][clave].y - h[i - 1][clave].y);
    }
    return s;
  }

  feed(lm, dt) {
    this.t += dt;
    for (const k in this.cool) this.cool[k] -= dt;
    if (!lm) { this.hist.length = 0; return []; }
    const c = buildCtx(lm);
    if (!c) { this.hist.length = 0; return []; }

    this.hist.push({ t: this.t, lWr: c.lWr, rWr: c.rWr, lEl: c.lEl, rEl: c.rEl });
    while (this.hist.length && this.t - this.hist[0].t > 2.2) this.hist.shift();

    const vel = this.velMuneca();
    const out = [];
    // Lo que habilita repetir un gesto es SOLTARLO, no que pase un reloj.
    //
    // Antes cada move tenia un `cd` de 3 a 6 segundos: hacer mewing dos veces
    // seguidas detectaba las dos y tiraba la segunda. Desde afuera se sentia
    // como "no me lo detecta" o "tiene delay", y era lo peor posible en una
    // ronda de 15 segundos.
    //
    // Con re-armado por soltura: sostener la pose sigue contando UNA vez
    // (que era el motivo real del cooldown), pero bajar la mano y volver a
    // hacerla cuenta de nuevo, al toque.
    const fire = (m) => {
      if ((this.cool[m.id] ?? 0) > 0) return false;
      if (m.test && this.armado[m.id] === false) return false;
      this.cool[m.id] = m.test ? ANTIREBOTE : (m.cd ?? ANTIREBOTE);
      if (m.test) { this.armado[m.id] = false; this.ancla[m.id] = { lWr: c.lWr, rWr: c.rWr }; }
      this.held[m.id] = 0;
      out.push(m);
      return true;
    };

    for (const m of MOVES) {
      if (!m.test) continue;
      // Re-armado por MOVIMIENTO: si la mano se fue lejos del punto donde
      // este move disparo, es otra repeticion y no la misma pose sostenida.
      // Es lo que hace que spamear un gesto lo cuente cada vez, y que el dab
      // del otro lado cuente aunque la pose espejada nunca "suelte".
      const anc = this.ancla[m.id];
      if (anc && Math.max(
        Math.hypot(c.lWr.x - anc.lWr.x, c.lWr.y - anc.lWr.y),
        Math.hypot(c.rWr.x - anc.rWr.x, c.rWr.y - anc.rWr.y)) > REARME_DIST) {
        this.armado[m.id] = true;
        this.ancla[m.id] = null;
      }
      // Perder los landmarks o moverse tambien cuenta como soltar el gesto:
      // si no, tapar la mano un segundo dejaba el move trabado sin re-armar.
      //
      // Pero DECAE, no se pone en cero. Poner cero aca salteaba la FUGA: un
      // solo cuadro con la nariz parpadeando por debajo de visibility 0.45 —o
      // un temblor que pasara `calm` por centesimas— borraba TODO el
      // acumulado y el gesto tenia que empezar de nuevo. Es el mismo motivo
      // por el que el `else` de mas abajo decae en vez de resetear.
      const soltar = () => {
        this.held[m.id] = Math.max(0, (this.held[m.id] ?? 0) - dt * FUGA);
        this.suelto[m.id] = (this.suelto[m.id] ?? 0) + dt;
        if (this.suelto[m.id] >= REARME) this.armado[m.id] = true;
      };
      if (m.needs && !allSeen(lm, m.needs)) { soltar(); continue; }
      // el gesto tiene que estar quieto: atravesarlo bailando no cuenta
      if (m.calm != null && vel > m.calm) { soltar(); continue; }
      let ok = false;
      try { ok = m.test(c); } catch { ok = false; }
      if (ok) {
        this.suelto[m.id] = 0;
        this.held[m.id] = (this.held[m.id] ?? 0) + dt;
        if (this.held[m.id] >= (m.hold ?? 0)) fire(m);
      } else {
        // El `held` DECAE, no se pone en cero. MEDIDO sobre video real: un
        // gesto que la persona sostiene medio segundo entero pasa el test en
        // rachas de UNO o DOS cuadros (MediaPipe tiembla), asi que con reset
        // duro el acumulado nunca llegaba a `hold` y el move no existia:
        // seis dabs seguidos daban CERO detecciones. Decayendo, un hueco de
        // uno o dos cuadros cuesta pero no borra.
        this.held[m.id] = Math.max(0, (this.held[m.id] ?? 0) - dt * FUGA);
        this.suelto[m.id] = (this.suelto[m.id] ?? 0) + dt;
        if (this.suelto[m.id] >= REARME) this.armado[m.id] = true;
      }
    }

    // --- 6-7 ---
    // Lo que lo distingue de mover los brazos en general: los CODOS quedan
    // pegados al cuerpo y casi no se mueven, mientras las manos suben y
    // bajan alternadas, con los antebrazos casi horizontales.
    const codosPegados = Math.abs(c.lEl.x) < 1.35 && Math.abs(c.rEl.x) < 1.35;
    // Las manos van POR ENCIMA de los codos. Reemplaza a "antebrazos casi
    // horizontales" (tilt < 70), que describia mal el gesto: MEDIDO sobre
    // cuatro segundos de 6-7 real, el antebrazo va de 6 a 82 grados —
    // sube y baja, y en el punto alto esta casi VERTICAL. Esa condicion
    // sola tumbaba la mitad de los cuadros del gesto.
    const manosSobreCodos = c.lWr.y < c.lEl.y + 0.25 && c.rWr.y < c.rEl.y + 0.25;
    // Al frente y CERCA del cuerpo. El 6-7 se hace con las manos delante del
    // pecho (|x| ~ 0.76 torsos); a 2.0 entraba cualquier braceo con los
    // brazos abiertos, y en el video real eso disparo un 6-7 falso en pleno
    // t-pose.
    const manosAlFrente = Math.abs(c.lWr.x) < 1.15 && Math.abs(c.rWr.x) < 1.15;
    // Las manos van MAS ADENTRO que los codos. Sentado y cerca, un t-pose
    // flojo deja las muñecas a 0.6-0.8 torsos, dentro de `manosAlFrente`, y
    // al subir y bajar los brazos alterna igual que un 6-7: en video real
    // eso disparo un 6-7 falso en pleno T-POSE. Lo que no comparten es la
    // forma del brazo — en el 6-7 la mano esta por dentro del codo
    // (MEDIDO: 0.2-0.6 contra 0.5-0.67), en el t-pose por fuera.
    const manosAdentro = Math.abs(c.lWr.x) < Math.abs(c.lEl.x) + 0.15
      && Math.abs(c.rWr.x) < Math.abs(c.rEl.x) + 0.15;
    const alturaPecho = c.lWr.y > -0.9 && c.lWr.y < 1.7 && c.rWr.y > -0.9 && c.rWr.y < 1.7;
    // Sin rango de angulo de codo. MEDIDO: en el 6-7 real el codo se cierra
    // hasta 0-10 grados (la mano sube JUNTO al hombro, y ahi el angulo
    // hombro-codo-muñeca colapsa). El minimo de 20 grados rechazaba el pico
    // de cada alternancia, que es justo donde se cuentan los cruces: el
    // gesto entero, cuatro segundos de video, daba CERO deteccion.
    const posture = allSeen(lm, ARMS) && codosPegados && manosSobreCodos && manosAdentro
      && manosAlFrente && alturaPecho && c.wristGap > 0.4 && c.wristGap < 1.9;

    if (posture) {
      this.postureGrace = 0.5;
      const d = c.lWr.y - c.rWr.y;
      const s = Math.abs(d) > 0.13 ? Math.sign(d) : 0;
      if (s !== 0 && s !== this.lastSign) {
        if (this.lastSign !== 0) this.flips.push(this.t);
        this.lastSign = s;
      }
    } else {
      this.postureGrace -= dt;
      if (this.postureGrace <= 0) { this.lastSign = 0; this.flips.length = 0; }
    }
    this.flips = this.flips.filter((x) => this.t - x < 2.5);
    // Las manos tienen que recorrer mas que los codos: si todo el brazo
    // viaja junto es baile, no 6-7. Este es el discriminador que importa,
    // por eso se conserva aunque todo lo demas se haya aflojado.
    const manos = this.recorrido('lWr') + this.recorrido('rWr');
    const codos = this.recorrido('lEl') + this.recorrido('rEl');
    // Vuelve a 3. Baje a 2 pensando que era muy exigente, pero no tenia
    // evidencia: en video real 2 alternancias disparo un 6-7 falso durante
    // un t-pose. Tres exige una intencion que el braceo no tiene.
    // Las alternancias solo se consumen si el disparo ENTRA. Antes se
    // borraban igual, asi que las tres que caian dentro del cooldown se
    // tiraban a la basura y despues habia que juntar tres nuevas: cuatro
    // segundos de 6-7 seguido daban un solo disparo.
    if (this.flips.length >= 3 && manos > codos * 1.25 + 0.04) {
      if (fire(BY_ID['six-seven'])) this.flips = [];
    }

    // --- giro ---
    // La prueba de que giraste es que los HOMBROS SE INVIERTEN DE ORDEN.
    // Antes usaba ancho-de-hombros/tamaño-de-cara como señal de perfil, pero
    // de perfil MediaPipe sigue separando los hombros por el grosor del
    // cuerpo: el colapso es chico y cualquier bajon de deteccion lo imitaba.
    // Ese era el falso positivo del video real.
    //
    // Ahora el ancho se compara contra el maximo reciente del PROPIO cuerpo
    // (auto-normalizado, sirve para cualquier complexion), y el disparo
    // exige que el orden de hombros al salir sea el contrario al de entrada.
    if (allSeen(lm, [NOSE, L_SH, R_SH])) {
      this.swMax = Math.max(c.SW, (this.swMax ?? c.SW) * (1 - dt * 0.35));

      // "De frente" = hombros abiertos Y la nariz DENTRO del ancho de
      // hombros. Corriendo de perfil la nariz va por delante del hombro,
      // asi que un corredor nunca cuenta como frontal. Ese era el falso
      // positivo del video real.
      const shL = Math.min(lm[L_SH].x, lm[R_SH].x);
      const shR = Math.max(lm[L_SH].x, lm[R_SH].x);
      const span = shR - shL;
      const frontal = c.SW > this.swMax * 0.7
        && lm[NOSE].x > shL + span * 0.15
        && lm[NOSE].x < shR - span * 0.15;

      // Para girar HAY que pasar por perfil. Sin exigirlo, cualquier momento
      // en que los hombros se angostan y el orden se vuelve ruido cuenta
      // como media vuelta: en video real un DAB disparaba GIRO COMPLETO,
      // porque al meter la cara en el codo los hombros rotan y el orden
      // parpadea sin que la persona se haya dado vuelta.
      // El perfil tiene que SOSTENERSE. MEDIDO en video real: durante un DAB
      // MediaPipe colapsa el ancho de hombros a 0.02-0.09 (contra 0.21 de
      // base) en cuadros sueltos — es perdida de tracking, no un perfil, y
      // rachas asi no pasan de 0.12 s. Con el cuadro suelto valiendo, el dab
      // disparaba GIRO COMPLETO. Un giro de verdad deja los hombros angostos
      // 0.3 s largos.
      this.perfilT = c.SW < this.swMax * 0.45 ? (this.perfilT ?? 0) + dt : 0;
      if (this.perfilT >= 0.16) this.huboPerfil = true;

      if (frontal) {
        const orden = Math.sign(lm[L_SH].x - lm[R_SH].x);
        // El orden nuevo tiene que SOSTENERSE 0.1 s. Cuando el tracking se
        // rompe, el orden de hombros parpadea uno o dos cuadros (0.08 s en el
        // dab medido) y vuelve; eso contaba como media vuelta. Nadie se da
        // vuelta en 40 ms.
        if (orden !== 0) {
          if (orden !== this.ordenCand) { this.ordenCand = orden; this.ordenT = 0; }
          else this.ordenT = (this.ordenT ?? 0) + dt;
          if (this.ordenT >= 0.10 && orden !== this.ordenFrontal) {
            if (this.ordenFrontal !== undefined && this.huboPerfil) this.girosFlips.push(this.t);
            this.huboPerfil = false;
            this.ordenFrontal = orden;
          }
        }
      }
      this.girosFlips = this.girosFlips.filter((x) => this.t - x < 1.8);
      // Una vuelta entera invierte los hombros DOS veces y termina como
      // empezo. Con un solo cambio seria media vuelta (quedar de espaldas),
      // que no es un giro completo.
      if (this.girosFlips.length >= 2) {
        this.girosFlips = [];
        fire(BY_ID['giro']);
      }
    }

    return out;
  }
}

/**
 * DAP: dos personas chocando manos.
 * Exige manos levantadas, contacto ENTRE los dos cuerpos, y que sean dos
 * personas de verdad separadas. Antes bastaba proximidad de muñecas, asi
 * que dos personas paradas juntas ya contaba.
 *
 * OJO: recibe landmarks METRICOS. Con los crudos, en telefono vertical la
 * separacion entre cuerpos y la distancia entre manos venian estiradas 1.78x
 * y el umbral de contacto (0.38 torsos) no se alcanzaba nunca.
 */
export function detectDap(lmA, lmB) {
  if (!lmA || !lmB) return false;
  const cA = buildCtx(lmA), cB = buildCtx(lmB);
  if (!cA || !cB) return false;

  const sep = Math.abs(cA.sc.x - cB.sc.x) / ((cA.T + cB.T) / 2);
  if (sep < 0.6) return false;             // o es una sola persona detectada dos veces

  const izq = Math.min(cA.sc.x, cB.sc.x), der = Math.max(cA.sc.x, cB.sc.x);
  const T = (cA.T + cB.T) / 2;
  const holgura = (der - izq) * 0.15;      // el choque no cae exacto en el medio

  for (const a of [L_WR, R_WR]) {
    for (const b of [L_WR, R_WR]) {
      if (!seen(lmA, a) || !seen(lmB, b)) continue;
      if (cA.n(lmA[a]).y > cA.hip.y - 0.15) continue;   // mano levantada
      if (cB.n(lmB[b]).y > cB.hip.y - 0.15) continue;
      if (dist(lmA[a], lmB[b]) / T > 0.55) continue;
      const cx = (lmA[a].x + lmB[b].x) / 2;
      if (cx < izq - holgura || cx > der + holgura) continue;
      return true;
    }
  }
  return false;
}

export const DAP = BY_ID['dap'];

/**
 * Los hombros se ven pero los brazos quedaron fuera del encuadre.
 * En vertical pasa apenas la persona se acerca, y es lo que impide el
 * t-pose. Sirve para decirle "alejate" en vez de dejarlo probando a ciegas.
 */
export function brazosCortados(lm) {
  if (!lm || !allSeen(lm, [L_SH, R_SH])) return false;
  const cortado = (i) => lm[i].fuera || (lm[i].visibility ?? 1) < 0.25;
  return (cortado(L_EL) && cortado(L_WR)) || (cortado(R_EL) && cortado(R_WR));
}
