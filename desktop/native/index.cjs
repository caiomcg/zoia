/**
 * Windows Graphics Capture straight into NVENC.
 *
 * Deliberately .cjs, not .js: this is CommonJS, and packaged inside an asar
 * whose package.json declares "type": "module" a .js file is treated as ESM
 * and dies on `module is not defined`. In development it happened to work
 * because native/package.json sits alongside it and defaults to CommonJS —
 * that file is not packaged, so the bug only ever appeared in a built exe.
 *
 * The pixels never leave the GPU: WGC hands the addon a D3D11 texture and
 * NVENC encodes it on the same device, so only the compressed H.264 bitstream
 * crosses back into JavaScript.
 */
module.exports = require('./build/Release/zoia_capture.node');
