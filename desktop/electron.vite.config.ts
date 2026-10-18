import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const define = {
  // The address the sign-in screen starts with, for a build made for one
  // group's server; empty, the screen starts empty, as a published release
  // does. Only a default: people sign in with an account (ADR 0031), so
  // nothing secret is ever compiled in.
  __ZOIA_SERVER_URL__: JSON.stringify(process.env.ZOIA_SERVER_URL ?? ''),
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
