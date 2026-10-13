import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The package is ESM, so `__dirname` does not exist here.
const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Four entry points, three of them pages:
 *   popup.html      the 400×620 dialer (design 1a)
 *   sidepanel.html  the 400×780 call console (design 1b)
 *   offscreen.html  the Twilio Device's home — see src/offscreen
 *   service-worker  MV3 background, kept at a fixed filename for the manifest
 *
 * MV3 forbids remote code, so everything is bundled; no chunk hashing on the
 * entries, because the manifest and the offscreen API name these files.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': dir('./src') },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    rollupOptions: {
      input: {
        popup: dir('./popup.html'),
        sidepanel: dir('./sidepanel.html'),
        offscreen: dir('./offscreen.html'),
        mic: dir('./mic.html'),
        'service-worker': dir('./src/background/service-worker.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
