// Banco de frases. El producto real. Editá esto mas que el codigo.
// Regla: especifico > generico. Absurdo > correcto. Corto > explicado.

export const MOVE_NAMES = [
  'EL TÍO EN LA BODA', 'DESBLOQUEO ESPIRITUAL', 'TORNADO DE MERCADO',
  'PASO DEL CHUCHO TRISTE', 'INVOCACIÓN DEL PRIMO', 'GIRO PROHIBIDO',
  'TÉCNICA DEL CAMIONETERO', 'EL PROFESOR ENOJADO', 'DESPERTAR DEL SÉPTIMO CHAKRA',
  'PATADA DE LUNES', 'FLOTACIÓN NIVEL DIOS', 'EL SEÑOR DEL BUS 203',
  'COMBO ANCESTRAL', 'MOVIMIENTO NO CATALOGADO', 'RITUAL DE MEDIANOCHE',
  'ESTIRAMIENTO DE ABUELO', 'AURA DE PRIMERA FILA', 'EL QUE NADIE PIDIÓ',
];

export const MOVE_ADJ = [
  'IMPECABLE', 'CUESTIONABLE', 'DEVASTADOR', 'CONFUSO', 'HISTÓRICO',
  'ILEGAL EN 3 PAÍSES', 'NIVEL LEYENDA', 'PREOCUPANTE', 'DIVINO', 'RARO',
];

// Se dispara cuando la energia esta ALTA
export const ROAST_HYPE = [
  'ESO NO SE ENSEÑA',
  'LA CÁMARA APENAS TE AGUANTA',
  'DETECTÉ 4 MICROEXPRESIONES DE CONFIANZA',
  'TU AURA ESTÁ INTERFIRIENDO CON EL WIFI',
  'ALGUIEN LLAME A UN ADULTO',
  'EL SENSOR PIDIÓ VACACIONES',
  'ESTO VA A SALIR EN LAS NOTICIAS',
  'CONFIRMADO: NACISTE PARA ESTO',
  'MI ALGORITMO ESTÁ LLORANDO',
  'NIVEL DE AURA: PREOCUPANTE (BUENO)',
];

// Se dispara cuando la energia esta BAJA. Los roasts pegan mas que los halagos.
export const ROAST_LOW = [
  'ESO LO VIO TU MAMÁ',
  'DETECTÉ MOVIMIENTO. APENAS.',
  '¿ESTÁS BIEN? PARPADEÁ DOS VECES',
  'MI SENSOR SE DURMIÓ',
  'AURA INDETECTABLE. SEGUÍ INTENTANDO',
  'ESTO ES UN PROTECTOR DE PANTALLA',
  'HASTA LA PARED TIENE MÁS AURA',
  'CREÍ QUE ERA UNA FOTO',
  'NEGATIVO. VOLVÉ MAÑANA',
  'ESO FUE UN ESTIRAMIENTO, NO UN MOVE',
];

// Se dispara al sostener una pose despues de energia alta
export const ROAST_HOLD = [
  'Y AHÍ SE QUEDÓ. RESPETO.',
  'CONGELÓ EL TIEMPO',
  'ESA POSE VALE DINERO',
  'AGUANTALO. AGUANTALO. PERFECTO.',
  'ESTATUA DE SÍ MISMO',
];

export const CRIT_LINES = [
  '¡GOLPE CRÍTICO!', '¡AURA DESBORDADA!', '¡ESO FUE ILEGAL!',
  '¡MULTIPLICADOR ANCESTRAL!', '¡SE ROMPIÓ EL MEDIDOR!', '¡×3 SIN EXPLICACIÓN!',
];

// Calibrado contra ronda de 15s. Casi todos deben caer en RESPETABLE/PELIGROSA;
// LEYENDA se alcanza esforzandose. PROHIBIDA es raro -> por eso se clipea.
export const VERDICTS = [
  { min: 0, t: 'SIN AURA DETECTABLE', s: 'Consultá a un especialista.' },
  { min: 5000, t: 'AURA DE PRINCIPIANTE', s: 'Hay algo. Muy poco, pero hay.' },
  { min: 20000, t: 'AURA RESPETABLE', s: 'Ya podés entrar a una fiesta sin permiso.' },
  { min: 45000, t: 'AURA PELIGROSA', s: 'La gente se voltea a ver y no sabe por qué.' },
  { min: 80000, t: 'AURA NIVEL LEYENDA', s: 'Documentado por primera vez en esta cámara.' },
  { min: 130000, t: 'AURA PROHIBIDA', s: 'No deberías tener acceso a esto.' },
];

export function verdictFor(aura) {
  let v = VERDICTS[0];
  for (const x of VERDICTS) if (aura >= x.min) v = x;
  return v;
}

export const pick = (arr) => arr[(Math.random() * arr.length) | 0];

export function moveName() {
  return Math.random() < 0.25
    ? `${pick(MOVE_NAMES)} (${pick(MOVE_ADJ)})`
    : pick(MOVE_NAMES);
}
