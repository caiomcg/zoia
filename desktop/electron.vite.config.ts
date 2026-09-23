import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Baked into the main-process bundle at build time — for a *private* build.
// A published build embeds neither, and reads a zoia-invite.json at runtime
// instead, because anything compiled into a public artifact is public. See
// src/main/config.ts and docs/adr/0010-invites-outside-the-binary.md.
const pairingToken = process.env.ZOIA_PAIRING_TOKEN ?? '';

// Deliberately opt-in rather than keying off process.env.CI: a *private*
// build that happens to run in somebody's CI should still shout.
const tokenless = process.env.ZOIA_TOKENLESS_BUILD === '1';

// A private build that lost its token is silent at build time and only
// discovered by whoever you sent it to, so it is still worth shouting about.
// A public build has no token by design, and a warning that fires on every
// release run is a warning people learn to scroll past.
if (!pairingToken && !tokenless) {
  console.warn(
    '\n  WARNING: ZOIA_PAIRING_TOKEN is not set.\n' +
      '  This build can only pair from a zoia-invite.json handed over separately.\n' +
      '  Set ZOIA_TOKENLESS_BUILD=1 if that is what you meant, or use make-exe.bat.\n',
  );
}

const define = {
  // Empty, not a placeholder. This used to default to a real-looking
  // hostname, which in a published build would have sent every fresh install
  // at a domain belonging to somebody else. Empty means "nothing compiled in";
  // src/main/config.ts treats it as absent and waits for an invite.
  __ZOIA_SERVER_URL__: JSON.stringify(process.env.ZOIA_SERVER_URL ?? ''),
  __ZOIA_PAIRING_TOKEN__: JSON.stringify(pairingToken),
};

export default defineConfig({
  main: {
    define,
    // Native addons (loopback-capture, node-window-manager) must stay external:
    // bundling a .node binary does not work.
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          // Electron's sandboxed preload loader (sandbox: true, set in
          // main/index.ts) is CommonJS-only: it rejects ESM `import` syntax
          // outright, regardless of file extension. Root package.json says
          // "type": "module", so without this override electron-vite emits
          // an .mjs preload that the sandboxed loader refuses to run at all
          // — the window opens but nothing in it ever runs.
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
    plugins: [react()],
  },
});
