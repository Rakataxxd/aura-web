# ESCÁNER DE AURA

App web que mide tu "aura" en tiempo real con la cámara y te devuelve un clip listo para postear.

**Todo corre en el dispositivo del usuario.** No hay servidor, no hay subida de video, no hay costo por usuario.

## Cómo funciona

1. **Pose** — MediaPipe Pose Landmarker (WASM/WebGPU) detecta hasta 2 cuerpos en el navegador.
2. **Medición** — métricas reales sobre los landmarks, normalizadas por largo de torso (para que la distancia a la cámara no altere el puntaje):
   - energía (velocidad de articulaciones, en torsos/segundo)
   - amplitud (extensión de extremidades)
   - control (sostener una pose después de explotar → bonus)
   - combo por energía sostenida
3. **Presentación** — el HUD se dibuja en canvas, no en DOM, porque `canvas.captureStream()` solo graba el canvas. Si fuera HTML el clip descargado saldría sin números.
4. **Clip** — MediaRecorder graba el canvas. Negocia el códec (Safari no soporta webm) y comparte con Web Share API, con descarga como respaldo.

## Movimientos con nombre

`src/moves.js` detecta 11 movimientos por reglas de ángulos — sin dataset, sin entrenamiento. Cada uno da bonus de aura y su propio callout dorado.

| move | cómo se detecta | bonus |
|---|---|---|
| `6-7` | manos al pecho, codos doblados, alternando arriba/abajo (3 cruces en 2s) | 9,000 |
| `DAP` | dos personas, muñecas levantadas y juntas (< 0.42 torsos) | 12,000 |
| `SCUBA` | ambas muñecas cerca de la cara, por encima de los hombros | 7,000 |
| `DAB` | una muñeca junto a la nariz + otro brazo estirado en diagonal | 6,000 |
| `PATADA ALTA` | un tobillo por encima de la cadera | 6,500 |
| `GIRO COMPLETO` | el ancho de hombros colapsa (perfil) y vuelve en < 1.4s | 5,500 |
| `T-POSE` | codos > 152°, muñecas a la altura del hombro y bien afuera | 5,000 |
| `BAJANDO` | cadera a la altura de las rodillas, ambas parejas | 4,000 |
| `MANOS ARRIBA` | ambas muñecas bien por encima de los hombros | 3,500 |
| `PLEGARIA` | muñecas juntas al pecho, codos doblados | 3,000 |
| `BRAZOS CRUZADOS` | muñecas cruzadas respecto a los hombros | 3,000 |

Para agregar uno nuevo: metelo en `MOVES` con un `test(ctx)`. El contexto ya trae posiciones normalizadas por torso (`c.lWr`, `c.rWr`, `c.hip`…), ángulos de codo y distancias a la nariz. Los que dependen del tiempo (como `6-7` y `giro`) se marcan `temporal: true` y llevan su lógica dentro de `MoveDetector.feed`.

Verificar que un detector nuevo funcione y no dispare de más:

```js
const m = await import('/src/movetest.js')
m.run()   // debe dar no_detectados: [] y falsos_positivos: []
```

## Principio de diseño

> **Precisión = entrada. Diversión = salida.**

Los números del comentario son absurdos a propósito ("detecté 3 microexpresiones de confianza"). La *reactividad* no: si te movés de verdad, el puntaje sube de verdad. Falsa precisión funciona como comedia; falsa reactividad mata el chiste en un video.

## Editar los chistes

`src/roasts.js` es el archivo que más vale la pena tocar. Nombres de movimientos, frases del narrador, veredictos. Editar ahí cambia el producto más que tocar el código.

Calibración actual para una ronda de 15s:

| perfil | aura | veredicto |
|---|---|---|
| tímido | ~2,000 | SIN AURA DETECTABLE |
| normal | ~25,000 | AURA RESPETABLE |
| salvaje | ~52,000 | NIVEL LEYENDA |

## Desarrollo

```bash
npm install
npm run dev
```

Sin cámara podés ejercitar scoring y HUD con landmarks simulados:

```js
// en la consola del navegador
const m = await import('/src/simtest.js')
await m.run(15, { versus: true, live: false, stopFrac: 0.5, poster: true })
```

`poster: true` fuerza el peor caso visual (nombre largo + crítico + frase a la vez) para verificar que nada se desborde en pantalla angosta.

## Deploy

```bash
npm run deploy
```

Compila y publica la rama `gh-pages`.

## Peso

La app son 54 KB. MediaPipe son ~8 MB (modelo 4.8 + wasm 3.35), y se precargan en segundo plano apenas abre el intro, con progreso visible. Primera visita paga; las siguientes salen de cache.
