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
| `DAP` | dos personas, muñecas **levantadas** y juntas (< 0.55 torsos) | 22,000 |
| `6-7` | manos al pecho **por dentro de los codos**, alternando arriba/abajo (3 cruces en 2.5s) | 18,000 |
| `DAB` | un brazo plegado con la cara adentro, el otro **arriba y al costado de la cabeza** | 16,000 |
| `SCUBA` | una mano en la **boca** y la otra **plegada frente al pecho** (asimétrico) | 15,000 |
| `MEWING` | **una** muñeca en la mandíbula (debajo de la nariz) y la otra lejos | 14,000 |
| `GIRO COMPLETO` | el orden de los hombros se invierte dos veces en < 1.8s | 12,000 |
| `T-POSE` | los dos brazos horizontales y hacia afuera (vale el codo si la muñeca se salió del cuadro) | 11,000 |
| `BAJANDO` | cadera a la altura de las rodillas, con rodillas **y tobillos dentro del cuadro** | 9,000 |
| `MANOS ARRIBA` | ambos brazos bien por encima de los hombros | 8,000 |
| `PLEGARIA` | muñecas juntas al pecho, codos doblados | 7,000 |

Los bonus pesan a propósito: si el aura por moverse mucho aplastara a los moves, sacudirse le ganaría a hacer el movimiento — lo contrario de lo que el juego premia.

### Los umbrales salen de video real, no de los muñecos

`src/movetest.js` arma muñecos sintéticos y verifica que cada pose dispare su move. Es útil para no romper nada, pero **no alcanza para calibrar**: el muñeco del scuba modelaba una mano apoyada sobre la cabeza con el codo por encima de la nariz. El test daba verde y el gesto no salía nunca en la app, porque nadie hace esa pose — en 15 segundos de video haciendo scuba a propósito no hay **un solo cuadro** con una mano arriba de la cabeza.

Todo umbral nuevo se mide replayando landmarks de video real:

```bash
node scripts/replay.mjs testdata/scuba.json --puertas scuba,dab
```

`testdata/*.json` son volcados de landmarks cuadro a cuadro (ver `src/diagtest.js`). Replayar tarda milisegundos; pasar MediaPipe sobre el clip tarda un minuto y hay que hacerlo en un navegador.

Cuando dos gestos se pisan, la regla nueva se elige comparando **percentiles del gesto bueno contra los gestos parecidos**, no a ojo. Ejemplo del scuba contra el mewing y la plegaria:

| rasgo | SCUBA | MEWING | PLEGARIA |
|---|---|---|---|
| ángulo del codo libre | 35-61° | 124-151° (cuelga) | 12-48° |
| mano libre, altura | 0.33-0.45 | 0.43-0.84 | 0.23-0.38 |
| mano libre, costado | 0.05-0.33 | 0.40-0.63 | 0.05-0.34 |
| separación de manos | 0.50-0.73 | 0.74-1.30 | 0.37-0.62 |

El codo del brazo libre es lo que separa scuba de mewing; las manos separadas y a distinta altura, lo que lo separa de plegaria.

### Repetir un gesto: se re-arma soltándolo o ALEJANDO la mano

Cada move tenía un cooldown fijo de 3 a 6 segundos. En una ronda de **15 segundos** eso significa que hacer mewing dos veces seguidas contaba una sola: el detector lo veía y lo tiraba. Desde afuera se siente como "no me lo detecta" o "tiene delay", que es lo peor que puede hacer un juego de reflejos.

El cooldown existía por una razón buena —que sostener la pose no dispare en bucle— pero el tiempo era la herramienta equivocada. Lo que habilita repetir es **soltar el gesto**, con un piso de 0.45 s de antirrebote (`ANTIREBOTE`).

Soltar por tiempo tampoco alcanzó. Haciendo dabs seguidos el test se cae en huecos de 0.07-0.13 s y `suelto` se vuelve a cero en cuanto un cuadro pasa: nunca junta los 0.25 s de `REARME`, y un segundo entero de dabs daba **un** disparo. Peor con el dab del otro lado: la pose espejada también pasa el test, así que cambiar de brazo no suelta nada.

Por eso además re-arma por **distancia** (`REARME_DIST`, 0.45 torsos). Medido: entre dos dabs la muñeca se va a 0.9 torsos del punto donde disparó el anterior, mientras que sosteniendo la pose el temblor de MediaPipe no pasa de 0.06. No hay cómo confundirlos, y sostener un gesto sigue contando **una** vez.

Para que repetir no se vuelva farmeo, el mismo move **rinde cada vez menos** (×0.6 acumulativo, piso 0.25). Siempre responde y siempre se ve el callout; simplemente deja de pagar.

Medido sobre video real (15 s haciendo gestos a propósito): DAB pasó de 2 a 5 detecciones y 6-7 de 3 a 4.

### Cómo depurar "no me lo detecta"

Esa frase no es accionable: hay tres filtros en serie (`needs` → `calm` → `test`) y desde afuera no se ve cuál corta. `diagtest.js` corre el pipeline real sobre un video y dice, frame por frame, en qué puerta muere cada move:

```js
const d = await import('/aura-web/src/diagtest.js')
await d.run('/aura-web/testdata/batalla.mp4', { velocidad: 0.25 })
__frames.filter(x => x.t > 9 && x.t < 11).map(x => `${x.t}:${x.puertas['t-pose']}`)
// ["9.03:test", "9.21:ok", "9.3:calm(5.0>4.5)", ...]
```

`velocidad` baja el playbackRate: la inferencia tarda más que un frame y a velocidad normal se pierde la mitad del gesto. Y el harness le pasa al detector el **dt real** entre cuadros — con `1/30` fijo la velocidad de muñeca sale escalada y el filtro de quietud parece cortar gestos que en la app pasan bien.

### Iterar umbrales sin volver a pasar MediaPipe

Cada pasada de `diagtest` sobre un clip de 15 s tarda **un minuto** y necesita navegador. Ajustar un umbral así es imposible. Por eso `diagtest` **vuelca los landmarks métricos** de cada cuadro (`window.__crudos`, con su `dt` real) y `scripts/replay.mjs` los re-corre en node en milisegundos:

```bash
node scripts/replay.mjs testdata/aurafarm2.json
node scripts/replay.mjs testdata/aurafarm2.json --puertas dab,mewing   # tramos 'ok' y en qué puerta muere
node scripts/replay.mjs testdata/aurafarm2.json --rasgos 5.2 9.5       # números crudos del gesto
```

Los `tramos ok` son lo que hay que mirar: dicen cuánto dura seguido cada racha en que el test se cumple. Si el gesto se ve en el video pero las rachas duran menos que el `hold`, el problema no es la geometría.

### El `hold` decae, no se reinicia

Un gesto que la persona sostiene medio segundo entero pasa el test en **rachas de uno o dos cuadros**: MediaPipe tiembla. Con reset duro (`held = 0` en cuanto un cuadro falla) el acumulado nunca llega al `hold` y el move **no existe** — medido sobre video real: seis dabs seguidos daban **cero** detecciones. Ahora el `held` decae (`FUGA`, 1.2× el tiempo transcurrido): un hueco de uno o dos cuadros cuesta pero no borra, y un gesto que pasa 2 de cada 3 cuadros sigue sumando.

Las puertas de `needs` y `calm` también decaen en vez de resetear: un solo cuadro con la nariz parpadeando por debajo de `visibility` borraba todo el acumulado y el gesto tenía que empezar de nuevo.

### Las cinco reglas que costaron bugs reales

**1. Espacio métrico, no coordenadas crudas.** MediaPipe normaliza `x` por el **ancho** y `y` por el **alto**. En un cuadro 16:9 una distancia horizontal real vale 0.5625 de lo que valdría vertical; en 9:16 vale 1.78. La misma pose da números que **difieren 3.2×** según el teléfono esté parado o acostado. Con umbrales calibrados a ojo contra muñecos sintéticos (que sin querer modelaban un cuadro apaisado), en un teléfono vertical no se detectaba ni el t-pose, ni el scuba flojo, ni las manos arriba — y `MEWING` sobrevivía porque es la única regla basada en distancias **verticales**, inmune a la distorsión. `toMetric()` (en `landmarks.js`) convierte a geometría real; todo `moves.js` consume eso y ya no le importa la orientación. `movetest.js` prueba **cada pose en cuatro encuadres**: si un move solo aparece en una columna, es un bug de aspecto.

**2. Filtrar por `visibility`… salvo cuando el cuadro es el problema.** MediaPipe devuelve coordenadas para landmarks fuera de cuadro — inventadas, con `visibility` baja. En encuadre selfie eso produce tobillos fantasma y un move de piernas dispara sin parar; cada move declara sus landmarks en `needs`. Pero con el teléfono **vertical** el cuadro mide 0.56 alturas de ancho y un adulto en cruz mide 1.0 de punta a punta: las muñecas se salen **siempre**. Exigirlas hacía el `T-POSE` literalmente indetectable en el aparato donde se usa la app. Esos moves usan `puntaBrazo()`: la muñeca si está dentro, el codo si no. Cuando ni el codo entra, el HUD avisa "alejáte".

**3. Antes de calibrar un detector, confirmá qué gesto es. Mirando el video, no razonando.** El `SCUBA` se reescribió **tres veces** y las dos primeras describían poses que nadie hace:

1. "Las dos manos enmarcando la cara, simétricas" — y encima **rechazaba la asimetría** (`|lWr.y − rWr.y| > F*1.3 → false`). No podía detectarse nunca.
2. "Una mano pellizca la nariz, la otra va plana sobre la cabeza". Sigue sin ser el gesto: en 15 s de video haciendo scuba a propósito **no hay un solo cuadro** con una mano por encima de la cabeza, el codo nunca cruza la línea de hombros.
3. Lo que la persona hace de verdad: **una mano en la boca y la otra plegada moviéndose frente al pecho**.

Mientras tanto ese gesto disparaba `MEWING` (92 de 112 cuadros) y `PLEGARIA` (61) — que es literalmente lo que se veía en pantalla, y el dato que tendría que haber disparado la pregunta mucho antes. Se perdieron varias rondas de calibración afinando umbrales de una geometría equivocada, con el test sintético en verde todo el tiempo.

**4. Lo que se parece a otra cosa hay que separarlo por lo que NO comparten.** Ocho casos, todos encontrados corriendo el detector sobre video real, no razonando:

- El `DAB` también tiene una mano en la cara, así que disparaba `MEWING` — y `DAB` no existía. Lo que los separa es **la otra mano**: en mewing cuelga (`n.y ≈ +0.7`), en el dab apunta arriba (`n.y ≈ −0.2`).
- **Sentado en una silla la cadera también queda a la altura de las rodillas**, así que `BAJANDO` disparaba solo mientras el sujeto estaba sentado haciendo gestos de cara. Filtrar por `visibility` no alcanza: con las piernas fuera de cuadro MediaPipe las inventa **con visibility alta** (se ven dibujadas en el esqueleto del clip). Lo que no puede inventar es que estén **dentro del encuadre** — `fuera`.
- Metiendo la cara en el codo los hombros rotan y su orden parpadea, así que el dab disparaba `GIRO COMPLETO`. Para girar **hay que pasar por perfil**; ahora se exige haber visto el ancho de hombros colapsar entre una inversión y la otra.
- Bracear con los brazos abiertos disparaba `6-7`. Ese gesto se hace con las manos **delante del pecho** (`|x| ≈ 0.76` torsos), no en cruz.
- Sentado y cerca, un `T-POSE` flojo deja las muñecas a 0.6-0.8 torsos —dentro del rango del `6-7`— y al subir y bajar los brazos **alterna igual**. Lo que no comparten es la forma del brazo: en el 6-7 la mano va **por dentro del codo** (0.2-0.6 contra 0.5-0.67 medidos), en el t-pose por fuera.
- El `6-7` también deja **una** mano a la altura de la cara con la otra abajo, medio segundo por vez, así que disparaba `MEWING`. Lo que no comparten es la quietud: el mewing se sostiene (velocidad de muñeca &lt; 2.6 medida), el 6-7 alterna (≈ 3.2). Por eso `mewing` tiene `calm: 3.0`.
- Cuando la mano de arriba del `SCUBA` se sale del cuadro hay que leerle el **codo**, y ese codo también está arriba y afuera: pasaba como `DAB`. El techo que los separa es la nariz — en el dab ese codo queda **por debajo** de la nariz, en el scuba por encima.
- El `DAB` sentado **no se lanza**: el brazo libre queda corto y plegado (codo a 5-60°, muñeca a la altura del hombro). Exigirle codo estirado y 0.25 torsos más allá del hombro rechazaba los **seis** dabs de un video. Lo que sobrevive: ese brazo va **arriba y al costado de la cabeza** (0.5-0.8 torsos de la nariz).

**5. El torso no siempre sirve de escala.** Si las caderas están al borde o fuera del cuadro, la medida hombro→cadera se corrompe y con ella todos los umbrales. Los gestos de cara se miden contra `F` (nariz→centro de hombros), que sobrevive cualquier encuadre donde se te vea la cara. `movetest.js` cubre este caso explícitamente.

Para agregar uno nuevo: metelo en `MOVES` con un `test(ctx)`. El contexto ya trae posiciones normalizadas por torso (`c.lWr`, `c.rWr`, `c.hip`…), ángulos de codo y distancias a la nariz. Los que dependen del tiempo (como `6-7` y `giro`) se marcan `temporal: true` y llevan su lógica dentro de `MoveDetector.feed`.

Verificar que un detector nuevo funcione y no dispare de más:

```js
const m = await import('/src/movetest.js')
m.run()   // debe dar ok: true  (no_detectados vacío en los 4 encuadres)
```

Corre también sin navegador, que es más rápido para iterar:

```
node -e "import('./src/movetest.js').then(m=>console.log(JSON.stringify(m.run(),null,1)))"
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

## Batalla online (rival al azar o sala con código)

Uno contra uno, 15 segundos, gana el que junte más aura. Dos formas de entrar: **BUSCAR RIVAL** te mete en una cola con desconocidos, o **CREAR SALA** te da un código de 4 caracteres para dictarle a un amigo. El alfabeto de los códigos no tiene `O`, `0`, `I` ni `1`, justamente porque se dictan por teléfono.

### Dos canales, a propósito

| qué | por dónde | por qué |
|---|---|---|
| estado del juego (listos, arranca, aura en vivo, resultado) | WebSocket contra un Durable Object | barato, confiable, ordenado |
| video del rival | WebRTC peer to peer | mandar video por un Worker costaría plata y sumaría un salto de latencia por cuadro |

Separarlos es lo que hace que **la batalla funcione aunque el video nunca conecte**. Entre dos NAT hostiles y sin servidor TURN eso pasa seguido; se pierde verse las caras, no la partida. Al revés —todo por el data channel de WebRTC— una negociación fallida se llevaba puesto el partido entero.

El primero en entrar es el **anfitrión**: es el único que manda la oferta WebRTC y el único que da la orden de arrancar. Sin un rol fijo los dos ofrecían a la vez, la negociación entraba en colisión y no cerraba nunca, y salían dos cuentas regresivas.

### Decisiones sobre desconocidos

Video al azar con desconocidos es el patrón que terminó cerrando Omegle. Tres cosas acotan la superficie:

- **No es chat abierto.** El video se ve durante los 15 segundos de la ronda y se corta.
- **SALTAR** está siempre visible sobre el recuadro del rival.
- **La cara del rival no entra en tu clip.** El recuadro vive en el DOM, sobre el canvas, no dentro: `captureStream()` graba el canvas, así que nadie se lleva grabada la cara de un desconocido a la galería.

El relay tiene lista blanca de mensajes: lo que no es del protocolo no se reenvía. El handshake del WebSocket valida `Origin` a mano, porque el navegador no le aplica CORS.

### Durable Objects en el plan gratis

`new_sqlite_classes` en la migración, no `new_classes`: los Durable Objects respaldados por SQLite entran en el plan gratis, los de KV no.

## Torneo (rankings global / nacional / regional)

En vivo: **https://rakataxxd.github.io/aura-web/** · backend: `https://aura-ranking.rakataxxd.workers.dev` (D1 `aura-ranking`).

Tres tablas — **hoy**, **esta semana** e **histórico** — cruzadas con tres ámbitos: **global**, **tu país** y **tu región**. Cada alias entra una sola vez por tabla, con su mejor puntaje.

El escáner sigue funcionando sin nada de esto: si no hay backend configurado, la UI de ranking simplemente no aparece. El video nunca sale del teléfono; lo único que viaja es `{alias, aura, moves}`.

### Por qué Cloudflare Worker + D1

El ranking nacional y el regional necesitan saber desde dónde juega cada uno. Cloudflare ya lo sabe: `request.cf.country` y `request.cf.region` vienen en **todos** los requests, gratis y sin pedirle permiso de ubicación a nadie. Con cualquier otro backend habría que sumar un servicio de IP (una dependencia más, con cuota) o hacer que el jugador elija su país a mano, que se miente solo. Además no queda ninguna key en el cliente.

### Levantarlo

```bash
cd worker
npx wrangler d1 create aura-ranking          # pegá el database_id en wrangler.toml
npx wrangler d1 execute aura-ranking --remote --file=./schema.sql
npx wrangler deploy                          # imprime la URL del worker
```

Después, en la raíz del proyecto:

```bash
cp .env.example .env                         # y pegá ahí la URL del worker
```

Si publicás en un dominio distinto de `rakataxxd.github.io`, agregalo a `ORIGENES` en `worker/wrangler.toml`: el worker compara el header `Origin` exacto y no usa comodín, que es lo que evita que cualquier página escriba puntajes.

### Probarlo local

```bash
cd worker && npx wrangler d1 execute aura-ranking --local --file=./schema.sql
cd worker && npx wrangler dev --port 8787 --local
```

`.env.development.local` ya apunta a `http://127.0.0.1:8787`. Es `.development.local` y no `.local` a propósito: `.env.local` también se lee al compilar para producción y `npm run deploy` publicaría la app apuntando a localhost.

### Esquema

Se guarda **una fila por partida**, no una por jugador; el mejor puntaje por alias sale con `MAX() + GROUP BY` al consultar. Es a propósito: una partida de hoy que no supera tu récord histórico igual tiene que poder ganar el ranking del día. Guardando todo, las tres tablas son la misma consulta con otro `WHERE`.

## Deploy

```bash
npm run deploy
```

Compila y publica la rama `gh-pages`.

## Rendimiento

El clip se graba a los fps a los que **de verdad** se dibujó el canvas: `captureStream` solo captura cuando el canvas se redibuja. La pantalla de resultado muestra siempre `CLIP N FPS · Np` — ese es el número del archivo, no una promesa.

**El presupuesto de un frame a 60fps es 16.7 ms enteros.** Todo lo que el hilo principal haga de más cae al siguiente vsync: 33.3 ms, o sea 30fps clavados. Por eso:

- **La detección no vive en el hilo principal ni en el `requestAnimationFrame`.** El worker se sirve solo del track de cámara con `MediaStreamTrackProcessor`: los píxeles no tocan nunca el hilo principal. Antes cada frame pagaba un `createImageBitmap` de 1080p. Medido acá: 0.4 ms de trabajo de hilo principal por frame (p95 0.9 ms).
- Cuando no hay `MediaStreamTrackProcessor` (Safari, Firefox) se empujan frames a mano, pero desde `requestVideoFrameCallback` — que dispara una vez por **cuadro nuevo de cámara**, no una por frame de dibujo — y reducidos a 640 px.
- Si el camino de stream no entrega en 1.5 s (6 s la primera vez, ver abajo) se vuelve solo al camino a mano. Nunca te quedás sin detección.
- **El primer `detectForVideo` tarda ~1.5 segundos** compilando shaders. Se paga en el arranque, con la pantalla de carga puesta (`calentar()` en el worker). Sin eso el vigilante creía que el stream estaba muerto justo al empezar la ronda.
- El modelo trabaja a 256 px: detectar el frame de 1080×1920 entero tarda ~45 ms y reducido a 640 tarda ~10 ms. Se reduce siempre.

### Por qué se caían los fps justo al empezar a grabar

Perder el vsync no cuesta un poco: **cuesta la mitad**. Un frame que se pasa de 16.7 ms cae al siguiente vsync y son 33.3 ms clavados — 60 → 30 de golpe, sin degradado. Así que la pregunta no es "qué es lento", es **qué cuesta distinto en la ronda que en la cuenta regresiva**. Eran tres cosas, y las tres estaban en el código:

**1. `shadowBlur` en la barra de energía.** El radio era `u * energía * 3`, y durante la cuenta regresiva la energía es **0** porque el scorer no corre todavía (`onLandmarks` hace `if (state !== 'running') return`). O sea: valía cero exactamente cuando se mide el rendimiento y se encendía exactamente cuando se empieza a grabar. Y `shadowBlur` es lo que este mismo README ya prohibía para el esqueleto. Ahora es el mismo truco de dos rectángulos.

**2. La bajada automática de resolución nunca funcionó. Ni una vez.** `countdown()` fija `lastT` y llama a `loop()` **en el mismo tick**, así que el primer `dt` son microsegundos y `1/Math.max(dt,1e-4)` da **10.000 fps**. Ese único valor movía el **promedio** de 76 muestras de 45 fps hasta 176, y la decisión salía siempre `escala 1`. Un teléfono dibujando a 45 fps se quedaba en 720×1280 para siempre. Ahora se usa la **mediana**, que no se deja mover por un pico.

**3. `fitFont` corría en cada frame** y podía asignar `ctx.font` catorce veces por texto. Asignar `font` parsea el shorthand y busca la familia: es de lo más caro del canvas 2D y es costo de **CPU**, justo lo que le falta a un teléfono. El texto de un callout no cambia en sus 2.4 s de vida — ahora está cacheado.

### "El primer clip salió perfecto, el segundo peor"

Esa frase describía **dos** bugs distintos, los dos en el camino de *OTRA VEZ*, y los dos invisibles en la primera ronda:

**1. Un timestamp repetido mata el detector para siempre.** MediaPipe exige timestamps estrictamente crecientes; si recibe uno repetido o menor, el grafo queda en `INVALID_ARGUMENT` **permanente** — todas las llamadas siguientes fallan y la detección no vuelve hasta recargar la página. Desde afuera solo se ve "esta ronda detecta mal".

El worker usaba el `ts` que venía con cada frame, y venían de **dos relojes distintos**: el de los `VideoFrame` (monotónico del sistema, horas desde el arranque) y `performance.now()` (desde que cargó la página). Al tocar *otra vez* se reconectaba el stream y los dos se cruzaban. Medido: ronda 1 detectaba los tres moves, rondas 2 y 3 daban `PICO 0.0` y **cero** moves, con 4.000 errores en consola.

Ahora el ts se genera en el worker (`siguienteTs()`), de un solo reloj, entero y siempre creciente — MediaPipe solo lo usa para ordenar, no tiene que coincidir con nada externo. Y si el grafo igual se rompe, tras 8 fallos seguidos **se reconstruye solo** (`rehacer()`): la diferencia entre "esta ronda salió mal" y "no vuelve a andar hasta que recargues".

**2. `Recorder.stop()` no soltaba la captura del canvas.** Parar el `MediaRecorder` **no** corta el track de `captureStream`: seguía vivo leyendo el canvas en cada frame. La ronda 2 corría con **dos** capturas del mismo canvas encima, la 3 con tres. En iOS, donde capturar el canvas es lo más caro del frame, eso es exactamente "el primero a 60 y el segundo peor". Verificado contando tracks vivos: antes crecía por ronda, ahora queda en `0`.

De paso, dos bugs más de rondas repetidas: `sizeCanvas()` aplicaba `0.75` fijo ignorando el escalón que se había elegido (un aparato que necesitaba `0.5` volvía a `0.75` al reintentar), y la decisión de resolución sólo corría si `!downscaled`, o sea **una vez en la vida de la página** — ni podía bajar más, ni devolver resolución si sobraba. Ahora hay una escalera (`ESCALAS`) que se re-evalúa en cada ronda y se mueve en los dos sentidos.

### Safari no tiene WebGL en workers (iPhone a 13 FPS)

Reporte real de un iPhone 15 Pro Max: `CLIP 13 FPS`, `DETECCIÓN 7/s`, `EFECTOS nivel 3`. El gobernador había soltado **todos** los efectos y aun así 13 fps — o sea el cuello no era dibujar. 13 fps de dibujo con 7 detecciones/s es la firma de **la inferencia bloqueando el hilo principal**.

La cadena: Safari no soporta WebGL dentro de un Worker (no hay `OffscreenCanvas` con contexto GL). El worker pedía el delegado `GPU`, fallaba, y ese fallo deja el módulo WASM inservible — así que el reintento con `CPU` **también** fallaba, `createPoseWorker` devolvía `null` y todo se iba al detector del hilo principal, que bloquea.

Ahora se **pregunta antes** (`tieneWebGL()`) en vez de probar y romper: si no hay GL en el worker, se va directo a `CPU`. Medido forzando ese camino con `?cpu`: **60 FPS de clip, 17 detecciones/s**. Un poco menos de detección, el clip entero.

Y el respaldo de hilo principal, que ahora es solo una red de seguridad, dejó de ser suicida:

- detecta sobre una copia **reducida a 640 px**, no sobre el frame de 1080p (el modelo trabaja a 256 igual);
- **ciclo de trabajo**: después de una inferencia de `T` ms espera `T·0.8` (o `T·1.8` si el gobernador ya está soltando efectos) antes de la siguiente.

Medido con `?hiloprincipal` y CPU a 4×: pasó de comerse el frame entero a **60 FPS de clip con 13 detecciones/s**.

### Nunca renegociar la cámara a 60fps

Muchas cámaras de teléfono solo dan 60fps **bajando la resolución**. Para esta app ese cambio es puro perjuicio: el clip se graba a los fps del **canvas**, no a los de la cámara, así que 60fps de cámara no aportan nada al archivo — y menos resolución sí arruina los landmarks. Se prefiere resolución siempre.

### Gobernador de calidad

La resolución no se puede tocar a mitad de grabación (rompe el encoder), pero los efectos sí. `Renderer.gobernar()` mira la **mediana** de los últimos 30 `dt` y, si baja de ~51 fps, suelta efectos de a uno — grano → trama → rayos, que son las tres pasadas de pantalla completa. Recupera con histéresis (2.5 s de holgura antes de devolver un nivel) para que no oscile. **Un clip a 60 fps sin grano se ve mucho mejor que uno a 30 con grano.** En `?debug` el nivel sale como `N0`…`N3`.

### Cómo medir esto sin engañarse

Tres formas de sacar números falsos, las tres pisadas ya:

- **`performance.now()` alrededor de llamadas de canvas mide el encolado, no la rasterización.** Hay que forzar el flush con `getImageData(0,0,1,1)` al final del lote. Sin flush, un `fillRect` de pantalla completa "cuesta" 0.001 ms; con flush, 0.81 ms.
- **`cpuThrottlingRate` de DevTools frena el JS, no la GPU.** Sirve para reproducir un teléfono en lo que es costo de CPU, y no sirve para nada en lo que es costo de dibujo.
- **Si rAF corre libre (sin vsync), medir "fps" no dice nada.** Ahí el intervalo de rAF ≈ trabajo por frame, y eso sí sirve; el ritmo no.

Medido con esa metodología: `captureStream(60)` + `MediaRecorder` sobre el canvas cuesta **casi nada** (5.0 → 5.0 ms de mediana por frame, p95 5.8 → 6.3). No es el culpable, por más que sea lo único que arranca en ese instante.

Trampas de dibujo ya pagadas, no las reintroduzcas:

- `shadowBlur` hunde el framerate en móvil. El glow del esqueleto son dos trazos (uno ancho translúcido, uno fino sólido).
- La trama de puntos dibujaba ~3,000 `arc()` por frame. Ahora es un patrón pre-renderizado: una llamada.
- El grano se dibuja cada 2 frames. A 60fps no se nota y libera medio presupuesto de píxeles.
- La cuenta regresiva dibuja los efectos **a tope a propósito** (`stress: true`): mide el costo real antes de grabar. Si la **mediana** no llega a 57fps baja la resolución **antes** de arrancar — cambiarla a mitad de grabación rompe el encoder. Mejor 540p a 60fps que 720p a 30.
- Ojo con lo que la prueba de esfuerzo **no** mide: `stress: true` fuerza la trama y los rayos, pero no los callouts, ni la línea, ni el flash, ni el scorer — todo eso solo existe en la ronda. Por eso además hay gobernador en vivo.

`?debug` agrega FPS y nivel de efectos en vivo (`60 FPS 1280p N0`) y, en el resultado, la fila que hace falta para diagnosticar sin adivinar:

```
MOTOR worker GPU | INFERENCIA 24 ms | DETECCIÓN 30/s | CÁMARA 1080×1920 @30 | EFECTOS nivel 0
```

**`MOTOR` es lo primero que hay que mirar.** `HILO PRINCIPAL` significa que la inferencia está bloqueando el dibujo y no hay ajuste de efectos que lo salve.

Flags para comparar caminos: `?hiloprincipal` (detector sin worker), `?cpu` (worker con delegado CPU — reproduce lo que le pasa a Safari sin necesitar un iPhone), `?sinstream` (empujar frames con `createImageBitmap` en vez del track directo).

## Peso

La app son 54 KB. MediaPipe son ~8 MB (modelo 4.8 + wasm 3.35), y se precargan en segundo plano apenas abre el intro, con progreso visible. Primera visita paga; las siguientes salen de cache.
