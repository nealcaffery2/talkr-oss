import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The content script, built on its own.
 *
 * It cannot be an entry in the main build: a content script is loaded as a
 * classic script, so it may not `import` a shared chunk, and the main build
 * splits anything two entries have in common (the number detector is used by
 * the worker too). One IIFE with everything inlined is the only shape Chrome
 * will run, so it gets its own config and appends to the same `dist`.
 */
export default defineConfig({
  resolve: {
    alias: { '@': dir('./src') },
  },
  build: {
    outDir: 'dist',
    // The main build has already written dist; this adds to it.
    emptyOutDir: false,
    target: 'chrome116',
    lib: {
      entry: dir('./src/content/main.ts'),
      formats: ['iife'],
      name: 'TalkrContent',
      fileName: () => 'content.js',
    },
    rollupOptions: {
      output: { extend: true },
    },
  },
});
