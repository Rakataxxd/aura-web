// MediaPipe corre en el dispositivo del usuario. El video nunca sale del telefono.
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

const BASE = import.meta.env.BASE_URL || '/';

export const MODEL_URL = `${BASE}mp/pose_landmarker_lite.task`;
export const WASM_URL = `${BASE}mp/vision_wasm_internal.wasm`;

/**
 * Baja modelo + wasm calentando el cache HTTP, con progreso real.
 * MediaPipe los pide despues y los saca del cache => carga instantanea.
 * Sin esto son ~8MB sin feedback y se siente colgado en datos moviles.
 */
export async function prefetchAssets(onProgress) {
  const urls = [WASM_URL, MODEL_URL];
  const sizes = new Array(urls.length).fill(0);
  const got = new Array(urls.length).fill(0);

  await Promise.all(urls.map(async (url, i) => {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) return;
      sizes[i] = +res.headers.get('content-length') || 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got[i] += value.length;
        const total = sizes.reduce((a, b) => a + b, 0);
        const done_ = got.reduce((a, b) => a + b, 0);
        if (total) onProgress?.(Math.min(0.99, done_ / total));
      }
    } catch { /* si falla, MediaPipe lo baja igual por su cuenta */ }
  }));
  onProgress?.(1);
}

export async function createPose(numPoses = 2) {
  const fileset = await FilesetResolver.forVisionTasks(`${BASE}mp`);
  // GPU es ~3x mas rapido; en algunos Android viejos falla -> caemos a CPU
  for (const delegate of ['GPU', 'CPU']) {
    try {
      return await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${BASE}mp/pose_landmarker_lite.task`, delegate },
        runningMode: 'VIDEO',
        numPoses,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputSegmentationMasks: false,
      });
    } catch (e) {
      if (delegate === 'CPU') throw e;
      console.warn('[pose] GPU no disponible, uso CPU:', e?.message);
    }
  }
}

export async function openCamera(video, facing = 'user') {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');  // iOS: sin esto abre en pantalla completa nativa
  video.muted = true;
  await video.play();
  return stream;
}

/** Ordena los cuerpos detectados de izquierda a derecha -> P1 / P2 estables por zona. */
export function assignSlots(landmarksArr) {
  const withX = landmarksArr
    .map((lm) => ({ lm, cx: (lm[11].x + lm[12].x + lm[23].x + lm[24].x) / 4 }))
    .filter((d) => Number.isFinite(d.cx))
    .sort((a, b) => a.cx - b.cx);
  if (withX.length === 0) return [null, null];
  if (withX.length === 1) return [withX[0].lm, null];
  return [withX[0].lm, withX[withX.length - 1].lm];
}
