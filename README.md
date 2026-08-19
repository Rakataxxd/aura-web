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
| `DAP` | dos personas, muñecas **levantadas** y juntas (< 0.42 torsos) | 22,000 |
| `6-7` | manos al pecho, codos doblados, alternando arriba/abajo (3 cruces en 2s) | 18,000 |
| `SCUBA` | **ambas** muñecas enmarcando la cara, a la altura de los ojos o arriba | 15,000 |
| `MEWING` | **una** muñeca en la mandíbula (debajo de la nariz) y la otra lejos | 14,000 |
| `GIRO COMPLETO` | el ancho de hombros colapsa (perfil) y vuelve en < 1.4s | 12,000 |
| `T-POSE` | codos > 152°, muñecas a la altura del hombro y bien afuera | 11,000 |
| `BAJANDO` | cadera a la altura de las rodillas, ambas parejas | 9,000 |
| `MANOS ARRIBA` | ambas muñecas bien por encima de los hombros | 8,000 |
| `PLEGARIA` | muñecas juntas al pecho, codos doblados | 7,000 |

Los bonus pesan a propósito: si el aura por moverse mucho aplastara a los moves, sacudirse le ganaría a hacer el movimiento — lo contrario de lo que el juego premia.

### Las dos reglas que costaron bugs reales

**1. Filtrar por `visibility`.** MediaPipe devuelve coordenadas para landmarks fuera de cuadro — inventadas, con `visibility` baja. En encuadre selfie eso produce tobillos fantasma flotando sobre la cadera, y un move de piernas dispara sin parar. Cada move declara sus landmarks en `needs`.

**2. El torso no siempre sirve de escala.** Si las caderas están al borde o fuera del cuadro, la medida hombro→cadera se corrompe y con ella todos los umbrales. Los gestos de cara se miden contra `F` (nariz→centro de hombros), que sobrevive cualquier encuadre donde se te vea la cara. `movetest.js` cubre este caso explícitamente.

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

Calibración actual para una ronda de 15s, **sin contar moves con nombre**:

| perfil | aura | veredicto |
|---|---|---|
| quieto | **0** | SIN AURA DETECTABLE |
| suave | ~160 | SIN AURA DETECTABLE |
| normal | ~42,000 | AURA RESPETABLE |
| salvaje | ~73,000 | AURA PELIGROSA |

Debajo de `IDLE` (0.45 torsos/segundo) el aura **drena** en vez de subir — pero de forma proporcional a lo quieto que estés, no de golpe. Un drenaje plano creaba un acantilado donde moverse suave valía lo mismo que no moverse.

Los tiers altos (LEYENDA 80k, PROHIBIDA 130k) exigen combinar movimiento **y** moves con nombre. Ninguno de los dos solo alcanza.

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

## Rendimiento

El render corre a 60fps y el clip se graba a 60fps (`captureStream(60)` — con 30 el clip salía capado aunque el canvas dibujara a 60).

Trampas ya pagadas, no las reintroduzcas:

- `shadowBlur` hunde el framerate en móvil. El glow del esqueleto son dos trazos (uno ancho translúcido, uno fino sólido).
- La trama de puntos dibujaba ~3,000 `arc()` por frame. Ahora es un patrón pre-renderizado: una llamada.
- El grano se dibuja cada 2 frames. A 60fps no se nota y libera medio presupuesto de píxeles.
- La cuenta regresiva dibuja los efectos **a tope a propósito** (`stress: true`): mide el costo real antes de grabar. Si no llega a 48fps, baja el canvas a 540×960 **antes** de arrancar — cambiar la resolución a mitad de grabación rompe el encoder.

`?debug` en la URL muestra FPS y resolución en vivo, fuera del clip.

## Peso

La app son 54 KB. MediaPipe son ~8 MB (modelo 4.8 + wasm 3.35), y se precargan en segundo plano apenas abre el intro, con progreso visible. Primera visita paga; las siguientes salen de cache.
