/**
 * Baked in at build time via esbuild/vite `define` (see electron.vite.config.ts),
 * not read from process.env at runtime. The people this app is built for run a
 * plain .exe with no environment to configure — the server URL and pairing
 * token must already be inside it.
 */
declare const __ZOIA_SERVER_URL__: string;
declare const __ZOIA_PAIRING_TOKEN__: string;
