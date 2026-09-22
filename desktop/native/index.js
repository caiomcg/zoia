/**
 * Windows Graphics Capture straight into NVENC.
 *
 * The pixels never leave the GPU: WGC hands the addon a D3D11 texture and
 * NVENC encodes it on the same device, so only the compressed H.264 bitstream
 * crosses back into JavaScript.
 */
module.exports = require('./build/Release/zoia_capture.node');
