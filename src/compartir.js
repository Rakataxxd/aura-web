// Compartir el clip. Esto es el motor de crecimiento: cada video posteado es
// gente nueva, y hasta ahora el unico boton decia "DESCARGAR CLIP" y dejaba a
// la persona sola frente a su galeria.
//
// LO QUE NO SE PUEDE HACER, para que nadie lo intente de nuevo: NO existe una
// forma de mandar un video a Instagram o a TikTok desde la web. No hay intent,
// no hay URL, no hay API abierta. Cualquier "compartir en TikTok" que uno vea
// por ahi comparte un LINK, no un archivo.
//
// Lo unico que existe de verdad es `navigator.share({files})` —la hoja nativa
// del sistema—, y ahi Instagram y TikTok aparecen como destino porque las
// puso el sistema operativo, no nosotros. Por eso:
//
//   EN EL TELEFONO  los dos botones abren la misma hoja nativa, con el texto
//                   preparado para cada red. Es un click y el video sale.
//   EN LA COMPUTADORA  no hay hoja: se baja el archivo, se copia el texto al
//                   portapapeles y se abre la pagina de subir de esa red.
//
// Que los dos botones hagan casi lo mismo en el telefono no es un adorno: la
// gente no busca "compartir", busca el logo de donde va a postear.

const SITIO = 'auratester.com';

/** ¿Podemos mandar el archivo por la hoja nativa del sistema? */
export const hayCompartirNativo = (blob) => {
  if (!blob || !navigator.canShare || !navigator.share) return false;
  try {
    return navigator.canShare({ files: [new File([blob], 'x.mp4', { type: blob.type })] });
  } catch { return false; }
};

const extDe = (blob) => (String(blob?.type || '').includes('mp4') ? 'mp4' : 'webm');

const num = (n) => Number(n || 0).toLocaleString('es-GT');

/**
 * El texto que acompaña al video.
 *
 * El link va SIN https:// y sin barra final a proposito: Instagram y TikTok no
 * hacen clickeable nada en la descripcion, asi que el link es para LEERLO y
 * escribirlo a mano. `auratester.com` se copia de memoria; una URL larga con
 * parametros, no.
 *
 * El `?ref=` no va aca por lo mismo. Se pierde la atribucion del que llega
 * tipeando, y esta bien: un link mas largo cuesta mas visitas de las que mide.
 */
export function leyenda({ aura, puesto, total, torneo, red }) {
  const lineas = [];
  if (torneo && puesto) {
    lineas.push(`Puesto ${puesto}${total ? ` de ${total}` : ''} en el torneo de ${torneo}.`);
    lineas.push(`${num(aura)} de aura.`);
  } else {
    lineas.push(`${num(aura)} de aura.`);
    lineas.push('¿Cuánta tenés vos?');
  }
  lineas.push('');
  lineas.push(`Medite en ${SITIO}`);
  lineas.push('');
  // Pocos y en castellano: los que usa la gente que hace este tipo de video.
  // Una lista de treinta etiquetas se lee como spam y las redes la castigan.
  lineas.push(red === 'tiktok'
    ? '#aura #aurafarming #auratester #fyp'
    : '#aura #aurafarming #auratester #reels');
  return lineas.join('\n');
}

const nombreArchivo = ({ aura, torneo }, blob) =>
  `${torneo ? 'torneo' : 'aura'}-${Math.round(aura || 0)}.${extDe(blob)}`;

function bajar(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nombre;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); return true; }
  catch { return false; }
}

// A donde se manda al que esta en una computadora. TikTok tiene una pagina de
// subida de verdad; Instagram publica desde la web pero no tiene una URL
// directa que abra el formulario, asi que va a la portada.
const SUBIR = {
  tiktok: 'https://www.tiktok.com/upload',
  instagram: 'https://www.instagram.com/',
};

/**
 * Comparte el clip.
 *
 * @param {Blob} blob el video
 * @param {object} datos {aura, puesto, total, torneo}
 * @param {'instagram'|'tiktok'|''} red a cual va; vacio = solo guardar
 * @returns {Promise<'compartido'|'cancelado'|'bajado'|'nada'>}
 */
export async function compartir(blob, datos = {}, red = '') {
  if (!blob) return 'nada';
  const texto = leyenda({ ...datos, red });
  const nombre = nombreArchivo(datos, blob);

  if (hayCompartirNativo(blob)) {
    try {
      await navigator.share({
        files: [new File([blob], nombre, { type: blob.type })],
        // `text` es lo que la hoja nativa le pasa a la app destino. Instagram
        // y TikTok lo IGNORAN para video (arman su propio editor), asi que
        // igual se copia al portapapeles: cuando la persona llega al campo de
        // la descripcion, pegar es un toque y escribir todo de nuevo, no.
        text: texto,
      });
      copiar(texto);
      return 'compartido';
    } catch (e) {
      // Cancelar es una respuesta valida, no un error: no hay que caerse al
      // fallback de descarga por algo que la persona decidio.
      if (e?.name === 'AbortError') return 'cancelado';
      // Cualquier otra cosa (la hoja existe pero fallo) sigue de largo al
      // camino de escritorio, que siempre funciona.
    }
  }

  bajar(blob, nombre);
  const copiado = await copiar(texto);
  if (red && SUBIR[red]) {
    // `noopener` obligatorio: sin eso la pestaña nueva puede tocar la nuestra
    // por `window.opener`. Y sale de un click de verdad, asi que el bloqueador
    // de ventanas lo deja pasar.
    window.open(SUBIR[red], '_blank', 'noopener');
  }
  return copiado ? 'bajado' : 'bajado';
}

/** El mensaje que se le muestra despues, segun como salio. */
export function mensajeDe(resultado, red) {
  const donde = red === 'tiktok' ? 'TikTok' : red === 'instagram' ? 'Instagram' : '';
  switch (resultado) {
    case 'compartido': return 'Listo. El texto quedó copiado por si lo querés pegar.';
    case 'cancelado': return '';
    case 'bajado': return donde
      ? `Video guardado y texto copiado. Te abrimos ${donde}: subilo desde ahí.`
      : 'Guardado. Subilo y etiquetame.';
    default: return '';
  }
}
