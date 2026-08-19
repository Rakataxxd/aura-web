/* eslint-env worker */
// Deteccion de pose en un hilo aparte. WORKER CLASICO A PROPOSITO.
//
// POR QUE EXISTE:
// detectForVideo tarda 9-20ms en una GPU de escritorio (mas en telefono).
// El presupuesto de un frame a 60fps es 16.7ms TOTAL. En el hilo principal
// cada frame con deteccion se pasa del vsync y cae al siguiente -> 33.3ms
// -> exactamente 30fps. Por eso el clip salia a 30 clavado.
//
// POR QUE NO ES UN MODULE WORKER:
// MediaPipe carga su WASM con importScripts(), que no existe en workers de
// tipo modulo -> falla con "ModuleFactory not set". Por eso este archivo
// vive en public/ (Vite no lo toca, se sirve igual en dev y en produccion)
// y usa el build IIFE que expone el global `Vision`.

let landmarker = null;
let ocupado = false;

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      importScripts(`${msg.base}mp/vision_bundle.js`);
      const { FilesetResolver, PoseLandmarker } = self.Vision;
      const fileset = await FilesetResolver.forVisionTasks(`${msg.base}mp`);
      let ultimo = null;
      for (const delegate of ['GPU', 'CPU']) {
        try {
          landmarker = await PoseLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: `${msg.base}mp/pose_landmarker_lite.task`, delegate },
            runningMode: 'VIDEO',
            numPoses: msg.numPoses ?? 2,
            minPoseDetectionConfidence: 0.5,
            minPosePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
            outputSegmentationMasks: false,
          });
          self.postMessage({ type: 'ready', ok: true, delegate });
          return;
        } catch (err) { ultimo = err; }
      }
      self.postMessage({ type: 'ready', ok: false, error: ultimo?.message || 'sin delegado' });
    } catch (err) {
      self.postMessage({ type: 'ready', ok: false, error: err?.message || String(err) });
    }
    return;
  }

  if (msg.type === 'frame') {
    // Si llega un frame mientras seguimos con el anterior, se descarta.
    // Encolar solo agrega latencia: siempre interesa el frame mas nuevo.
    if (!landmarker || ocupado) { msg.bitmap.close(); return; }
    ocupado = true;
    let landmarks = [];
    try {
      const res = landmarker.detectForVideo(msg.bitmap, msg.ts);
      landmarks = res && res.landmarks ? res.landmarks : [];
    } catch (err) {
      self.postMessage({ type: 'error', message: err && err.message });
    }
    msg.bitmap.close();
    ocupado = false;
    self.postMessage({ type: 'result', ts: msg.ts, landmarks });
  }
};
