import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    // Native addons (loopback-capture, node-window-manager) must stay external:
    // bundling a .node binary does not work.
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
    plugins: [react()],
  },
});
