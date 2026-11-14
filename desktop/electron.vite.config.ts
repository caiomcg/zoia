import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { createReadStream, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * MediaPipe's runtime for the camera's background effects, served beside the
 * page at mediapipe/wasm/ rather than fetched from a CDN, so they work offline
 * and load nothing from elsewhere. Copied from the package at build time
 * instead of committed: the .wasm is ~9 MB and must match the installed
 * version. Only the SIMD build: Electron's Chromium always has SIMD.
 * The model it runs is small and lives in src/renderer/public/mediapipe/.
 */
function mediapipeWasm(): Plugin {
  const dir = resolve('node_modules/@mediapipe/tasks-vision/wasm');
  const files = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];
  const prefix = '/mediapipe/wasm/';
  return {
    name: 'zoia-mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? '';
        const name = path.startsWith(prefix) ? path.slice(prefix.length) : '';
        if (!files.includes(name)) return next();
        res.setHeader(
          'Content-Type',
          name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        );
        createReadStream(join(dir, name)).pipe(res);
      });
    },
    generateBundle() {
      for (const name of files) {
        this.emitFile({
          type: 'asset',
          fileName: `mediapipe/wasm/${name}`,
          source: readFileSync(join(dir, name)),
        });
      }
    },
  };
}

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
    plugins: [react(), mediapipeWasm()],
  },
});
