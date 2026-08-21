// Cliente del ranking. Todo lo que sabe de red la app esta aca.
//
// La URL del worker se pone en `.env` como VITE_API_RANKING (Vite la
// reemplaza al compilar). Se puede pisar con ?api=... para probar contra un
// `wrangler dev` local sin recompilar.
//
// SIN URL LA APP SIGUE FUNCIONANDO. El escaner nunca necesito servidor y no
// va a empezar a necesitarlo ahora: si no hay backend configurado, `hayApi`
// da false y la UI de ranking simplemente no aparece. Un fetch fallando a
// mitad de la pantalla de resultado seria peor que no tener ranking.
const API = (new URLSearchParams(location.search).get('api')
  || import.meta.env.VITE_API_RANKING
  || '').replace(/\/$/, '');

export const hayApi = () => !!API;

const CLAVE_ALIAS = 'aura.alias';

export const getAlias = () => {
  try { return localStorage.getItem(CLAVE_ALIAS) || ''; } catch { return ''; }
};
export const setAlias = (a) => {
  try { localStorage.setItem(CLAVE_ALIAS, a); } catch { /* modo incognito */ }
};

/** Mismo criterio que el worker. Si no valida, ni se manda el request. */
export const aliasValido = (a) => /^[\p{L}\p{N} ._-]{2,14}$/u.test(String(a || '').trim());

async function pedir(ruta, opciones = {}) {
  // Sin timeout, un backend caido deja la pantalla colgada para siempre: no
  // hay estado de "cargando" que aguante eso en una app de 15 segundos.
  //
  // A mano y no con AbortSignal.timeout(): ese metodo no existe en iOS
  // Safari anterior al 16, y ahi la llamada tiraba TypeError ANTES de salir
  // a la red — o sea que el telefono mas viejo ni intentaba subir el
  // puntaje. AbortController existe en todos lados.
  const ac = new AbortController();
  const reloj = setTimeout(() => ac.abort(), 6000);
  try {
    const res = await fetch(`${API}${ruta}`, { ...opciones, signal: ac.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('tardó demasiado');
    throw e;
  } finally {
    clearTimeout(reloj);
  }
}

/** Sube una partida. Devuelve {aura, pais, region}. */
export function enviarPuntaje({ alias, aura, moves }) {
  return pedir('/api/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ alias, aura: Math.round(aura), moves }),
  });
}

/** Trae una tabla. `yo` viene con el puesto del alias si se lo pasa. */
export function traerRanking({ ambito = 'global', periodo = 'dia', alias = '', limite = 25 } = {}) {
  const q = new URLSearchParams({ ambito, periodo, limite: String(limite) });
  if (aliasValido(alias)) q.set('alias', alias.trim());
  return pedir(`/api/ranking?${q}`);
}

// Nombre del pais en castellano a partir del ISO-2 que manda Cloudflare.
// Intl lo resuelve solo; si el navegador no lo soporta queda el codigo, que
// es feo pero no rompe nada.
let nombres = null;
export function nombrePais(iso) {
  if (!iso || iso === 'XX') return 'DESCONOCIDO';
  try {
    nombres ||= new Intl.DisplayNames(['es'], { type: 'region' });
    return (nombres.of(iso) || iso).toUpperCase();
  } catch { return iso; }
}
