import { defineConfig } from 'vite';

// GitHub Pages sirve desde /aura-web/ -> sin esto los assets dan 404.
// pose.js usa import.meta.env.BASE_URL para armar las rutas del modelo.
export default defineConfig({
  base: '/aura-web/',
  build: {
    // el modelo y el wasm ya vienen comprimidos; no los toques
    assetsInlineLimit: 4096,
  },
});
