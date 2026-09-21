import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Baked into the main-process bundle at build time. Whoever runs `npm run
// pack` sets these in the environment; the resulting .exe carries them as
// string literals, since the people it is sent to configure nothing.
const define = {
  __ZOIA_SERVER_URL__: JSON.stringify(
    process.env.ZOIA_SERVER_URL ?? 'https://zoia.nullptrlabs.com',
  ),
  __ZOIA_PAIRING_TOKEN__: JSON.stringify(process.env.ZOIA_PAIRING_TOKEN ?? ''),
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
