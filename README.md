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
