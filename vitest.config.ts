import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/server/test/**/*.test.ts',
      // Pure, DOM-free helpers from the web app (no jsdom, no React).
      'apps/web/test/**/*.test.ts',
      // Same for the extension: the click-to-call number detector decides what
      // a rep can dial from any page, so it is tested here rather than by hand.
      'apps/extension/talkr-voice/test/**/*.test.ts',
    ],
    // Integration tests share one Postgres instance; run files sequentially to
    // keep per-file schema resets deterministic. Within-file tests still run in order.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
