// Windows Graphics Capture wired straight into NVENC.
//
// This exists because every route through Chromium or ffmpeg was measured
// failing at exactly one thing: getting a *window's* pixels to a hardware
// encoder without dragging them through system memory.
//
//   - ffmpeg's ddagrab is Desktop Duplication, so it cannot capture a window;
//   - ffmpeg's gdigrab can name a window but returns blank frames for modern
//     GPU-composited apps (verified by capturing one and looking at it);
//   - Chromium can capture a window, but its WebRTC stack has no hardware
//     encoder on Windows, and bridging its frames out to ffmpeg cost a
//     GPU->CPU readback plus three copies, which measured 14fps at 4K.
//
// So this does what a native app does. WGC hands over a D3D11 texture, the
// texture is copied GPU-to-GPU into an encoder input surface, and NVENC reads
// it on the same device. Pixels never touch the CPU; only the compressed
// bitstream — a couple of MB/s — is handed back to JavaScript.

#include <napi.h>

#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Security.Authorization.AppCapabilityAccess.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <ffnvcodec/nvEncodeAPI.h>

#include <AMF/components/ColorSpace.h>
#include <AMF/components/VideoEncoderVCE.h>
#include <AMF/core/Factory.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
namespace wgc = winrt::Windows::Graphics::Capture;
namespace wgdx = winrt::Windows::Graphics::DirectX;

namespace {

std::string HresultMessage(const char* what, HRESULT hr) {
  char buffer[256];
  snprintf(buffer, sizeof(buffer), "%s failed (hr=0x%08lX)", what, static_cast<unsigned long>(hr));
  return buffer;
}

// PCI vendor ids. NVENC belongs to the NVIDIA driver, AMF to AMD's and Quick
// Sync to Intel's, so the vendor of the adapter we render on decides which
// encoder can possibly work.
constexpr UINT kVendorNvidia = 0x10DE;
constexpr UINT kVendorAmd = 0x1002;
constexpr UINT kVendorAmdAlt = 0x1022;
constexpr UINT kVendorIntel = 0x8086;

const char* VendorName(UINT id) {
  switch (id) {
    case kVendorNvidia: return "nvidia";
    case kVendorAmd:
    case kVendorAmdAlt: return "amd";
    case kVendorIntel: return "intel";
    default: return "unknown";
  }
}

std::string Narrow(const wchar_t* wide) {
  if (!wide) return {};
  const int needed = WideCharToMultiByte(CP_UTF8, 0, wide, -1, nullptr, 0, nullptr, nullptr);
  if (needed <= 1) return {};
  std::string out(static_cast<size_t>(needed - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide, -1, out.data(), needed, nullptr, nullptr);
  return out;
}

bool NvencLibraryPresent() {
  HMODULE module = LoadLibraryW(L"nvEncodeAPI64.dll");
  if (!module) return false;
  FreeLibrary(module);
  return true;
}

bool AmfLibraryPresent() {
  HMODULE module = LoadLibraryW(AMF_DLL_NAME);
  if (!module) return false;
  FreeLibrary(module);
  return true;
}

struct AdapterChoice {
  ComPtr<IDXGIAdapter1> adapter;
  UINT vendorId = 0;
  std::string name;
  /** True only when this is an NVIDIA adapter AND the NVENC runtime loaded. */
  bool nvenc = false;
  /** True only when this is an AMD adapter AND the AMF runtime loaded. */
  bool amf = false;
};

/**
 * Picks the adapter to capture and encode on.
 *
 * This used to pass nullptr to D3D11CreateDevice, which takes whatever Windows
 * considers the default. On a desktop with one discrete card that is the right
 * answer by luck. On a laptop with switchable graphics it is the integrated
 * GPU — and NVENC, asked to open a session on an Intel or AMD device, refuses.
 * Every hybrid-graphics machine failed that way while reporting that hardware
 * encoding was available, because availability was inferred from the NVIDIA
 * driver's DLL being installed rather than from the device actually in use.
 *
 * Preference order: an NVIDIA adapter when NVENC is loadable, since that path
 * encodes without the frame ever leaving the GPU. Otherwise the first hardware
 * adapter: AMF encodes in-process on a Radeon, and anything else's frames go
 * out to ffmpeg for Quick Sync.
 */
AdapterChoice ChooseAdapter() {
  AdapterChoice choice;

  ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(factory.GetAddressOf())))) return choice;

  const bool nvencAvailable = NvencLibraryPresent();

  ComPtr<IDXGIAdapter1> adapter;
  for (UINT i = 0; factory->EnumAdapters1(i, adapter.ReleaseAndGetAddressOf()) != DXGI_ERROR_NOT_FOUND;
       ++i) {
    DXGI_ADAPTER_DESC1 desc = {};
    if (FAILED(adapter->GetDesc1(&desc))) continue;
    // WARP and the Basic Render Driver have no encoder at all, and picking one
    // would turn "no hardware encoder" into a confusing runtime failure.
    if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;

    if (nvencAvailable && desc.VendorId == kVendorNvidia) {
      choice.adapter = adapter;
      choice.vendorId = desc.VendorId;
      choice.name = Narrow(desc.Description);
      choice.nvenc = true;
      return choice;
    }

    if (!choice.adapter) {
      choice.adapter = adapter;
      choice.vendorId = desc.VendorId;
      choice.name = Narrow(desc.Description);
    }
  }

  // AMF ships with AMD's driver, so it is there whenever the adapter is a
  // Radeon with a driver installed; the encoder itself is tried at start.
  choice.amf = (choice.vendorId == kVendorAmd || choice.vendorId == kVendorAmdAlt) &&
               AmfLibraryPresent();
  return choice;
}

// Encoded output handed back to JavaScript.
struct Packet {
  std::vector<uint8_t> data;
  bool keyframe = false;
};

/**
 * A hardware H.264 encoder that reads textures on the capture's own D3D11
 * device. NVENC on NVIDIA, AMF on AMD: either way the frame never leaves the
 * GPU, and what comes back is an Annex B bitstream for the room's WebRTC
 * connection (renderer/livekit/native-video.ts).
 *
 * Every method is called with Session::encodeMutex_ held.
 */
class VideoEncoder {
 public:
  virtual ~VideoEncoder() = default;
  /** For logs and the stats card: "nvenc" or "amf". */
  virtual const char* Name() const = 0;
  /** The format of the surface the scaler renders into for this encoder. */
  virtual DXGI_FORMAT InputFormat() const = 0;
  virtual std::string Start(ID3D11Device* device, uint32_t width, uint32_t height,
                            uint32_t maxWidth, uint32_t maxHeight, uint32_t fps,
                            uint32_t bitrate) = 0;
  /** The one surface every frame is rendered into, until the next Resize. */
  virtual std::string RegisterInput(ID3D11Texture2D* texture) = 0;
  virtual std::string Resize(ID3D11Texture2D* texture, uint32_t width, uint32_t height) = 0;
  /** Changes the target bitrate in place, without a keyframe. */
  virtual std::string SetBitrate(uint32_t bitrate) = 0;
  virtual bool Encode(int64_t timestamp, Packet* out, std::string* error) = 0;
  virtual void Stop() = 0;

  // Makes the next frame an IDR, with SPS/PPS in front of it. Called when a
  // viewer asks for a keyframe (a WebRTC PLI): after loss, or on joining
  // mid-stream, nothing decodes until one arrives, and waiting out the GOP
  // means seconds of a frozen or broken picture.
  void RequestIdr() { forceIdr_ = true; }

 protected:
  std::atomic<bool> forceIdr_{false};
};

class NvencEncoder : public VideoEncoder {
 public:
  ~NvencEncoder() override { Stop(); }
  const char* Name() const override { return "nvenc"; }
  // WGC hands over BGRA; NVENC calls that ARGB and converts on the GPU.
  DXGI_FORMAT InputFormat() const override { return DXGI_FORMAT_B8G8R8A8_UNORM; }

  // Opens an NVENC session on the same D3D11 device the capture runs on, so
  // the input surface never has to move between devices.
  // Every NVENC failure used to come back as a sentence with no code in it,
  // so "wrong GPU", "driver older than these headers" and "session limit
  // reached" were indistinguishable in a crash report from someone else's
  // machine. The status is the one value worth having.
  static std::string NvencError(const char* what, NVENCSTATUS status) {
    const char* meaning = "";
    switch (status) {
      case NV_ENC_ERR_INVALID_VERSION:
        meaning = " (the display driver is older than this build expects)";
        break;
      case NV_ENC_ERR_UNSUPPORTED_DEVICE:
      case NV_ENC_ERR_NO_ENCODE_DEVICE:
        meaning = " (this GPU has no NVENC encoder)";
        break;
      case NV_ENC_ERR_OUT_OF_MEMORY:
        meaning = " (the GPU is out of memory)";
        break;
      case NV_ENC_ERR_ENCODER_BUSY:
        meaning = " (too many encode sessions are already open)";
        break;
      default:
        break;
    }
    char buffer[192];
    snprintf(buffer, sizeof(buffer), "NVENC: %s failed with status %d%s", what,
             static_cast<int>(status), meaning);
    return buffer;
  }

  // `maxWidth` x `maxHeight` is the largest size Resize may later ask for.
  // NVENC only changes resolution in place up to the maximum it was opened
  // with, and that maximum cannot itself be reconfigured.
  std::string Start(ID3D11Device* device, uint32_t width, uint32_t height, uint32_t maxWidth,
                    uint32_t maxHeight, uint32_t fps, uint32_t bitrate) override {
    fps_ = std::max<uint32_t>(fps, 1);
    library_ = LoadLibraryW(L"nvEncodeAPI64.dll");
    if (!library_) return "NVENC is unavailable: nvEncodeAPI64.dll could not be loaded.";

    auto create = reinterpret_cast<decltype(NvEncodeAPICreateInstance)*>(
        GetProcAddress(library_, "NvEncodeAPICreateInstance"));
    if (!create) return "NVENC is unavailable: NvEncodeAPICreateInstance is missing.";

    functions_ = {};
    functions_.version = NV_ENCODE_API_FUNCTION_LIST_VER;
    if (const NVENCSTATUS status = create(&functions_); status != NV_ENC_SUCCESS) {
      return NvencError("NvEncodeAPICreateInstance", status);
    }

    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open = {};
    open.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    open.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
    open.device = device;
    open.apiVersion = NVENCAPI_VERSION;
    if (const NVENCSTATUS status = functions_.nvEncOpenEncodeSessionEx(&open, &encoder_);
        status != NV_ENC_SUCCESS) {
      return NvencError("nvEncOpenEncodeSessionEx", status);
    }

    NV_ENC_PRESET_CONFIG preset = {};
    preset.version = NV_ENC_PRESET_CONFIG_VER;
    preset.presetCfg.version = NV_ENC_CONFIG_VER;
    if (functions_.nvEncGetEncodePresetConfigEx(encoder_, NV_ENC_CODEC_H264_GUID,
                                                NV_ENC_PRESET_P4_GUID,
                                                NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY,
                                                &preset) != NV_ENC_SUCCESS) {
      return "NVENC: nvEncGetEncodePresetConfigEx failed for the low-latency preset";
    }

    config_ = preset.presetCfg;
    // Constant bitrate with no B-frames: this is a live stream, and B-frames
    // buy compression at the cost of latency that a viewer would feel.
    config_.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
    config_.rcParams.averageBitRate = bitrate;
    config_.rcParams.vbvBufferSize = bitrate / fps;
    config_.rcParams.vbvInitialDelay = config_.rcParams.vbvBufferSize;
    config_.frameIntervalP = 1;
    config_.gopLength = fps * 2;
    config_.encodeCodecConfig.h264Config.idrPeriod = config_.gopLength;
    // Repeating SPS/PPS matters for a stream nobody joins at the start of.
    config_.encodeCodecConfig.h264Config.repeatSPSPPS = 1;
    config_.encodeCodecConfig.h264Config.sliceMode = 0;
    config_.encodeCodecConfig.h264Config.sliceModeData = 0;

    init_ = {};
    NV_ENC_INITIALIZE_PARAMS& init = init_;
    init.version = NV_ENC_INITIALIZE_PARAMS_VER;
    init.encodeGUID = NV_ENC_CODEC_H264_GUID;
    init.presetGUID = NV_ENC_PRESET_P4_GUID;
    init.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
    init.encodeWidth = width;
    init.encodeHeight = height;
    init.darWidth = width;
    init.darHeight = height;
    init.maxEncodeWidth = std::max(maxWidth, width);
    init.maxEncodeHeight = std::max(maxHeight, height);
    init.frameRateNum = fps;
    init.frameRateDen = 1;
    init.enablePTD = 1;
    init.encodeConfig = &config_;
    if (const NVENCSTATUS status = functions_.nvEncInitializeEncoder(encoder_, &init);
        status != NV_ENC_SUCCESS) {
      return NvencError("nvEncInitializeEncoder", status);
    }

    NV_ENC_CREATE_BITSTREAM_BUFFER bitstream = {};
    bitstream.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
    if (functions_.nvEncCreateBitstreamBuffer(encoder_, &bitstream) != NV_ENC_SUCCESS) {
      return "NVENC refused to allocate an output buffer.";
    }
    bitstream_ = bitstream.bitstreamBuffer;

    width_ = width;
    height_ = height;
    return {};
  }

  /**
   * Registers the one surface every frame is copied into.
   *
   * Done once rather than per frame: registering is an expensive call, and
   * doing it inside the encode loop measured 19fps where the capture itself
   * was willing to go faster.
   */
  std::string RegisterInput(ID3D11Texture2D* texture) override {
    NV_ENC_REGISTER_RESOURCE registration = {};
    registration.version = NV_ENC_REGISTER_RESOURCE_VER;
    registration.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
    registration.width = width_;
    registration.height = height_;
    registration.pitch = 0;
    registration.resourceToRegister = texture;
    // WGC hands over BGRA; NVENC calls that ARGB and converts on the GPU.
    registration.bufferFormat = NV_ENC_BUFFER_FORMAT_ARGB;
    if (functions_.nvEncRegisterResource(encoder_, &registration) != NV_ENC_SUCCESS) {
      return "NVENC refused to register the capture texture.";
    }
    registered_ = registration.registeredResource;
    return {};
  }

  /**
   * Changes the stream's resolution in place, the way a WebRTC sender does
   * when the shared window changes size, and swaps in `texture`, a surface of
   * the new size, as the input. The next frame is an IDR carrying the new
   * SPS, which is all a viewer's decoder needs to follow the change.
   *
   * On failure nothing has changed: the old size and input stay registered.
   */
  std::string Resize(ID3D11Texture2D* texture, uint32_t width, uint32_t height) override {
    NV_ENC_RECONFIGURE_PARAMS reconfigure = {};
    reconfigure.version = NV_ENC_RECONFIGURE_PARAMS_VER;
    reconfigure.reInitEncodeParams = init_;
    reconfigure.reInitEncodeParams.encodeWidth = width;
    reconfigure.reInitEncodeParams.encodeHeight = height;
    reconfigure.reInitEncodeParams.darWidth = width;
    reconfigure.reInitEncodeParams.darHeight = height;
    reconfigure.resetEncoder = 1;
    reconfigure.forceIDR = 1;
    if (const NVENCSTATUS status = functions_.nvEncReconfigureEncoder(encoder_, &reconfigure);
        status != NV_ENC_SUCCESS) {
      return NvencError("nvEncReconfigureEncoder", status);
    }
    init_ = reconfigure.reInitEncodeParams;

    if (registered_) {
      functions_.nvEncUnregisterResource(encoder_, registered_);
      registered_ = nullptr;
    }
    width_ = width;
    height_ = height;
    forceIdr_ = true;
    return RegisterInput(texture);
  }

  /**
   * The same reconfigure Resize uses, with the rate control changed and
   * nothing reset: no keyframe, no new SPS, the stream carries straight on.
   * VBV stays one frame of the new rate, as Start sets it.
   */
  std::string SetBitrate(uint32_t bitrate) override {
    NV_ENC_CONFIG config = config_;
    config.rcParams.averageBitRate = bitrate;
    config.rcParams.vbvBufferSize = bitrate / fps_;
    config.rcParams.vbvInitialDelay = config.rcParams.vbvBufferSize;
    NV_ENC_RECONFIGURE_PARAMS reconfigure = {};
    reconfigure.version = NV_ENC_RECONFIGURE_PARAMS_VER;
    reconfigure.reInitEncodeParams = init_;
    reconfigure.reInitEncodeParams.encodeConfig = &config;
    if (const NVENCSTATUS status = functions_.nvEncReconfigureEncoder(encoder_, &reconfigure);
        status != NV_ENC_SUCCESS) {
      return NvencError("nvEncReconfigureEncoder(bitrate)", status);
    }
    // nvEncInitializeEncoder keeps the pointer; keep it pointing at ours.
    config_ = config;
    init_.encodeConfig = &config_;
    return {};
  }

  // Encodes one already-on-GPU texture. Returns false only on a real failure;
  // a frame the encoder chooses not to emit is not an error.
  bool Encode(int64_t timestamp, Packet* out, std::string* error) override {
    NV_ENC_MAP_INPUT_RESOURCE mapped = {};
    mapped.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
    mapped.registeredResource = registered_;
    if (functions_.nvEncMapInputResource(encoder_, &mapped) != NV_ENC_SUCCESS) {
      *error = "NVENC refused to map the capture texture.";
      return false;
    }

    NV_ENC_PIC_PARAMS pic = {};
    pic.version = NV_ENC_PIC_PARAMS_VER;
    pic.inputBuffer = mapped.mappedResource;
    pic.bufferFmt = mapped.mappedBufferFmt;
    pic.inputWidth = width_;
    pic.inputHeight = height_;
    pic.outputBitstream = bitstream_;
    pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
    pic.inputTimeStamp = timestamp;
    if (forceIdr_.exchange(false)) {
      pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
    }

    const NVENCSTATUS status = functions_.nvEncEncodePicture(encoder_, &pic);
    bool ok = true;

    if (status == NV_ENC_SUCCESS) {
      NV_ENC_LOCK_BITSTREAM lock = {};
      lock.version = NV_ENC_LOCK_BITSTREAM_VER;
      lock.outputBitstream = bitstream_;
      if (functions_.nvEncLockBitstream(encoder_, &lock) == NV_ENC_SUCCESS) {
        const auto* bytes = static_cast<const uint8_t*>(lock.bitstreamBufferPtr);
        out->data.assign(bytes, bytes + lock.bitstreamSizeInBytes);
        out->keyframe = lock.pictureType == NV_ENC_PIC_TYPE_IDR ||
                        lock.pictureType == NV_ENC_PIC_TYPE_I;
        functions_.nvEncUnlockBitstream(encoder_, bitstream_);
      } else {
        *error = "NVENC produced a frame it then refused to hand over.";
        ok = false;
      }
    } else if (status != NV_ENC_ERR_NEED_MORE_INPUT) {
      *error = "NVENC failed to encode a frame.";
      ok = false;
    }

    functions_.nvEncUnmapInputResource(encoder_, mapped.mappedResource);
    return ok;
  }

  void Stop() override {
    if (encoder_) {
      if (registered_) {
        functions_.nvEncUnregisterResource(encoder_, registered_);
        registered_ = nullptr;
      }
      if (bitstream_) {
        functions_.nvEncDestroyBitstreamBuffer(encoder_, bitstream_);
        bitstream_ = nullptr;
      }
      functions_.nvEncDestroyEncoder(encoder_);
      encoder_ = nullptr;
    }
    if (library_) {
      FreeLibrary(library_);
      library_ = nullptr;
    }
  }

 private:
  HMODULE library_ = nullptr;
  NV_ENCODE_API_FUNCTION_LIST functions_ = {};
  // Held for the encoder's lifetime: nvEncInitializeEncoder keeps the pointer
  // it is given rather than copying the configuration.
  NV_ENC_CONFIG config_ = {};
  // Kept for Resize, which re-sends the whole set with a new size.
  NV_ENC_INITIALIZE_PARAMS init_ = {};
  void* encoder_ = nullptr;
  NV_ENC_OUTPUT_PTR bitstream_ = nullptr;
  NV_ENC_REGISTERED_PTR registered_ = nullptr;
  uint32_t width_ = 0;
  uint32_t height_ = 0;
  uint32_t fps_ = 1;
};

/**
 * AMD's hardware encoder through AMF, driven the way NVENC is above: opened on
 * the capture's own D3D11 device, fed the scaler's output texture, and asked
 * for one frame's bitstream at a time.
 *
 * This replaces reading every frame back to the CPU and piping it to ffmpeg's
 * h264_amf, which on a Radeon cost a GPU sync per frame, several megabytes
 * through the main process sixty times a second, a CPU colour conversion in
 * ffmpeg, and a WHIP muxer that never retransmitted a lost packet. Here the
 * frame stays on the GPU and the bitstream goes out on the room's WebRTC
 * connection, which paces it, retransmits, and asks for keyframes.
 *
 * The runtime (amfrt64.dll) ships with AMD's driver and is loaded at run time;
 * only the SDK's headers are built in (include/AMF, from AMF v1.5.3).
 */
class AmfEncoder : public VideoEncoder {
 public:
  ~AmfEncoder() override { Stop(); }
  const char* Name() const override { return "amf"; }
  // The scaler converts to BT.709 limited-range NV12 on the GPU (see
  // ConfigureScaler), which is the encoder's native input.
  DXGI_FORMAT InputFormat() const override { return DXGI_FORMAT_NV12; }

  static std::string AmfError(const char* what, AMF_RESULT result) {
    const char* meaning = "";
    switch (result) {
      case AMF_NOT_SUPPORTED:
        meaning = " (not supported by this GPU or driver)";
        break;
      case AMF_NO_DEVICE:
      case AMF_ENCODER_NOT_PRESENT:
        meaning = " (this GPU has no AMF encoder)";
        break;
      case AMF_DIRECTX_FAILED:
        meaning = " (the D3D11 device was refused)";
        break;
      case AMF_OUT_OF_MEMORY:
        meaning = " (the GPU is out of memory)";
        break;
      default:
        break;
    }
    char buffer[192];
    snprintf(buffer, sizeof(buffer), "AMF: %s failed with result %d%s", what,
             static_cast<int>(result), meaning);
    return buffer;
  }

  std::string Start(ID3D11Device* device, uint32_t width, uint32_t height, uint32_t /*maxWidth*/,
                    uint32_t /*maxHeight*/, uint32_t fps, uint32_t bitrate) override {
    fps_ = std::max<uint32_t>(fps, 1);
    // A keyframe every two seconds, as NVENC's GOP. Counted here rather than
    // left to AMF_VIDEO_ENCODER_IDR_PERIOD: the low-latency usages were
    // measured ignoring it (ffmpeg's h264_amf, -g 30: one IDR in 240 frames).
    gop_ = fps_ * 2;
    frames_ = 0;

    library_ = LoadLibraryW(AMF_DLL_NAME);
    if (!library_) return "AMF is unavailable: amfrt64.dll could not be loaded.";
    auto query = reinterpret_cast<AMFQueryVersion_Fn>(
        GetProcAddress(library_, AMF_QUERY_VERSION_FUNCTION_NAME));
    auto init = reinterpret_cast<AMFInit_Fn>(GetProcAddress(library_, AMF_INIT_FUNCTION_NAME));
    if (!query || !init) return "AMF is unavailable: the runtime has no AMFInit.";

    amf_uint64 runtime = 0;
    query(&runtime);
    // A driver older than these headers refuses to be asked for their version;
    // asking for what the driver has works with every property used here.
    AMF_RESULT result = init(std::min<amf_uint64>(runtime, AMF_FULL_VERSION), &factory_);
    if (result != AMF_OK || !factory_) return AmfError("AMFInit", result);

    result = factory_->CreateContext(&context_);
    if (result != AMF_OK) return AmfError("CreateContext", result);
    // AMF submits work on this device from threads of its own, while the
    // capture callback uses its immediate context.
    ComPtr<ID3D10Multithread> multithread;
    if (SUCCEEDED(device->QueryInterface(IID_PPV_ARGS(multithread.GetAddressOf())))) {
      multithread->SetMultithreadProtected(TRUE);
    }
    result = context_->InitDX11(device);
    if (result != AMF_OK) return AmfError("InitDX11", result);

    result = factory_->CreateComponent(context_, AMFVideoEncoderVCE_AVC, &encoder_);
    if (result != AMF_OK) return AmfError("CreateComponent(H.264)", result);

    // Usage first: setting it resets every other property to its defaults.
    std::string error;
    Set(AMF_VIDEO_ENCODER_USAGE, AMF_VIDEO_ENCODER_USAGE_ULTRA_LOW_LATENCY, &error);
    Set(AMF_VIDEO_ENCODER_PROFILE, AMF_VIDEO_ENCODER_PROFILE_HIGH, &error);
    Set(AMF_VIDEO_ENCODER_QUALITY_PRESET, AMF_VIDEO_ENCODER_QUALITY_PRESET_SPEED, &error);
    Set(AMF_VIDEO_ENCODER_FRAMESIZE, ::AMFConstructSize(width, height), &error);
    Set(AMF_VIDEO_ENCODER_FRAMERATE, ::AMFConstructRate(fps_, 1), &error);
    // The rate control the ffmpeg route measured best (see encoder.ts): the
    // target held under heavy motion, near nothing on a still screen, and
    // even frame sizes. CBR pads every frame with filler to the full rate.
    Set(AMF_VIDEO_ENCODER_RATE_CONTROL_METHOD,
        AMF_VIDEO_ENCODER_RATE_CONTROL_METHOD_LATENCY_CONSTRAINED_VBR, &error);
    Set(AMF_VIDEO_ENCODER_ENFORCE_HRD, true, &error);
    if (!error.empty()) return error;

    // Not every generation supports each of these; one it lacks is not a
    // reason to refuse the hardware.
    Optional(AMF_VIDEO_ENCODER_B_PIC_PATTERN, 0);
    Optional(AMF_VIDEO_ENCODER_FILLER_DATA_ENABLE, false);
    Optional(AMF_VIDEO_ENCODER_RATE_CONTROL_SKIP_FRAME_ENABLE, false);
    Optional(AMF_VIDEO_ENCODER_ENABLE_VBAQ, true);
    Optional(AMF_VIDEO_ENCODER_IDR_PERIOD, static_cast<amf_int64>(gop_));
    Optional(AMF_VIDEO_ENCODER_INPUT_COLOR_PROFILE, AMF_VIDEO_CONVERTER_COLOR_PROFILE_709);
    Optional(AMF_VIDEO_ENCODER_OUTPUT_COLOR_PROFILE, AMF_VIDEO_CONVERTER_COLOR_PROFILE_709);
    // QueryOutput waits this long for the frame instead of returning at once.
    Optional(AMF_VIDEO_ENCODER_QUERY_TIMEOUT, static_cast<amf_int64>(kQueryTimeoutMs));

    const std::string rateError = SetBitrate(bitrate);
    if (!rateError.empty()) return rateError;

    result = encoder_->Init(amf::AMF_SURFACE_NV12, static_cast<amf_int32>(width),
                            static_cast<amf_int32>(height));
    if (result != AMF_OK) return AmfError("Init", result);
    width_ = width;
    height_ = height;
    return {};
  }

  // Wrapped per frame rather than once: an AMF surface built from a native
  // texture is a thin reference, and the texture is what stays registered.
  std::string RegisterInput(ID3D11Texture2D* texture) override {
    input_ = texture;
    return {};
  }

  // The encoder rebuilt at the new size in place; its first frame is an IDR
  // carrying the new SPS.
  std::string Resize(ID3D11Texture2D* texture, uint32_t width, uint32_t height) override {
    const AMF_RESULT result =
        encoder_->ReInit(static_cast<amf_int32>(width), static_cast<amf_int32>(height));
    if (result != AMF_OK) return AmfError("ReInit", result);
    input_ = texture;
    width_ = width;
    height_ = height;
    forceIdr_ = true;
    return {};
  }

  // Dynamic properties in AMF: the next frame is encoded at the new rate.
  // VBV stays two frames of it, as measured in encoder.ts's -bufsize.
  std::string SetBitrate(uint32_t bitrate) override {
    std::string error;
    Set(AMF_VIDEO_ENCODER_TARGET_BITRATE, static_cast<amf_int64>(bitrate), &error);
    Set(AMF_VIDEO_ENCODER_PEAK_BITRATE, static_cast<amf_int64>(bitrate), &error);
    Set(AMF_VIDEO_ENCODER_VBV_BUFFER_SIZE, static_cast<amf_int64>(bitrate) * 2 / fps_, &error);
    return error;
  }

  bool Encode(int64_t timestamp, Packet* out, std::string* error) override {
    amf::AMFSurfacePtr surface;
    AMF_RESULT result = context_->CreateSurfaceFromDX11Native(input_.Get(), &surface, nullptr);
    if (result != AMF_OK) {
      *error = AmfError("CreateSurfaceFromDX11Native", result);
      return false;
    }
    constexpr amf_pts kSecond = 10'000'000;  // AMF time is in 100ns units.
    surface->SetPts(timestamp * kSecond / fps_);
    surface->SetDuration(kSecond / fps_);

    if (forceIdr_.exchange(false) || frames_ % gop_ == 0) {
      // A requested keyframe restarts the cadence, as it would with -g.
      frames_ = 0;
      surface->SetProperty(AMF_VIDEO_ENCODER_FORCE_PICTURE_TYPE,
                           AMF_VIDEO_ENCODER_PICTURE_TYPE_IDR);
      surface->SetProperty(AMF_VIDEO_ENCODER_INSERT_SPS, true);
      surface->SetProperty(AMF_VIDEO_ENCODER_INSERT_PPS, true);
    }
    ++frames_;

    result = encoder_->SubmitInput(surface);
    if (result == AMF_INPUT_FULL) {
      // Only if a frame was left behind by a slow one before: collect it and
      // try again, rather than lose this one.
      amf::AMFDataPtr stale;
      encoder_->QueryOutput(&stale);
      result = encoder_->SubmitInput(surface);
    }
    if (result != AMF_OK) {
      *error = AmfError("SubmitInput", result);
      return false;
    }

    // One frame in, one frame out: the encoder holds no lookahead and no
    // B-frames, so its output is this frame's, a few milliseconds later.
    // QueryOutput waits up to kQueryTimeoutMs itself where the runtime knows
    // QUERY_TIMEOUT; the loop covers runtimes that return at once.
    amf::AMFDataPtr data;
    const auto deadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(kQueryTimeoutMs);
    for (;;) {
      result = encoder_->QueryOutput(&data);
      if (result == AMF_OK && data) break;
      if (result != AMF_OK && result != AMF_REPEAT) {
        *error = AmfError("QueryOutput", result);
        return false;
      }
      if (std::chrono::steady_clock::now() >= deadline) return true;  // Late, not failed.
      Sleep(1);
    }

    amf::AMFBufferPtr buffer(data);
    if (!buffer) {
      *error = "AMF returned something other than a bitstream.";
      return false;
    }
    const auto* bytes = static_cast<const uint8_t*>(buffer->GetNative());
    out->data.assign(bytes, bytes + buffer->GetSize());
    amf_int64 type = -1;
    data->GetProperty(AMF_VIDEO_ENCODER_OUTPUT_DATA_TYPE, &type);
    out->keyframe = type == AMF_VIDEO_ENCODER_OUTPUT_DATA_TYPE_IDR ||
                    type == AMF_VIDEO_ENCODER_OUTPUT_DATA_TYPE_I;
    return true;
  }

  void Stop() override {
    input_.Reset();
    if (encoder_) {
      encoder_->Terminate();
      encoder_ = nullptr;
    }
    if (context_) {
      context_->Terminate();
      context_ = nullptr;
    }
    // The factory belongs to the runtime; it lives as long as the DLL does.
    factory_ = nullptr;
    if (library_) {
      FreeLibrary(library_);
      library_ = nullptr;
    }
  }

 private:
  static constexpr int kQueryTimeoutMs = 50;

  template <typename T>
  void Set(const wchar_t* name, const T& value, std::string* error) {
    const AMF_RESULT result = encoder_->SetProperty(name, value);
    if (result != AMF_OK && error->empty()) {
      *error = AmfError(Narrow(name).c_str(), result);
    }
  }
  template <typename T>
  void Optional(const wchar_t* name, const T& value) {
    encoder_->SetProperty(name, value);
  }

  HMODULE library_ = nullptr;
  amf::AMFFactory* factory_ = nullptr;
  amf::AMFContextPtr context_;
  amf::AMFComponentPtr encoder_;
  ComPtr<ID3D11Texture2D> input_;
  uint32_t width_ = 0;
  uint32_t height_ = 0;
  uint32_t fps_ = 1;
  uint32_t gop_ = 120;
  uint32_t frames_ = 0;
};

class Session {
 public:
  std::string Start(HWND hwnd, HMONITOR monitor, uint32_t fps, uint32_t bitrate, uint32_t maxWidth,
                    uint32_t maxHeight, bool showBorder, Napi::ThreadSafeFunction tsfn) {
    try {
      return StartInternal(hwnd, monitor, fps, bitrate, maxWidth, maxHeight, showBorder,
                           std::move(tsfn));
    } catch (const winrt::hresult_error& err) {
      return HresultMessage("Windows Graphics Capture", err.code());
    } catch (const std::exception& err) {
      return std::string("Capture failed to start: ") + err.what();
    } catch (...) {
      return "Capture failed to start for an unknown reason.";
    }
  }

 private:
  std::string StartInternal(HWND hwnd, HMONITOR monitor, uint32_t fps, uint32_t bitrate,
                            uint32_t maxWidth,
                            uint32_t maxHeight, bool showBorder, Napi::ThreadSafeFunction tsfn) {
    tsfn_ = std::move(tsfn);
    rawInFlight_ = 0;
    targetFps_ = fps;
    lastFrameTime_ = std::chrono::steady_clock::time_point{};
    nextFrameDue_ = std::chrono::steady_clock::time_point{};

    // Everything below belongs to one D3D device, and each capture creates its
    // own. Interfaces kept from the previous capture pointed at its device,
    // and handing them this one's textures failed with E_INVALIDARG, so the
    // second share of a session always fell back.
    scalerInput_.Reset();
    scalerOutput_.Reset();
    scaler_.Reset();
    scalerEnum_.Reset();
    source_.Reset();
    rendered_.Reset();
    nv12_ = false;
    videoContext_.Reset();
    videoDevice_.Reset();
    input_.Reset();

    adapter_ = ChooseAdapter();
    if (!adapter_.adapter) return "No hardware graphics adapter was found.";
    // The encoder belongs to the adapter we are actually rendering on: NVENC
    // on NVIDIA's, AMF on AMD's. Anything else — Intel, or either of those
    // declining below — sends frames out raw for ffmpeg to encode.
    encoder_.reset();
    if (adapter_.nvenc) {
      encoder_ = std::make_unique<NvencEncoder>();
    } else if (adapter_.amf) {
      encoder_ = std::make_unique<AmfEncoder>();
    }
    encode_ = encoder_ != nullptr;

    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    // D3D_DRIVER_TYPE_UNKNOWN is required when an adapter is named; passing
    // HARDWARE with a non-null adapter fails with E_INVALIDARG.
    HRESULT hr = D3D11CreateDevice(adapter_.adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags,
                                   nullptr, 0, D3D11_SDK_VERSION, device_.GetAddressOf(), nullptr,
                                   context_.GetAddressOf());
    if (FAILED(hr)) return HresultMessage("D3D11CreateDevice", hr);

    ComPtr<IDXGIDevice> dxgiDevice;
    hr = device_.As(&dxgiDevice);
    if (FAILED(hr)) return HresultMessage("QueryInterface(IDXGIDevice)", hr);

    winrt::com_ptr<::IInspectable> inspectable;
    hr = CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.Get(), inspectable.put());
    if (FAILED(hr)) return HresultMessage("CreateDirect3D11DeviceFromDXGIDevice", hr);
    winrtDevice_ = inspectable.as<wgdx::Direct3D11::IDirect3DDevice>();

    // The documented way to capture a specific window or screen: WGC itself
    // has no handle-shaped entry point, only this interop factory. A whole
    // screen used to go through ffmpeg's ddagrab and WHIP instead; capturing
    // the monitor here puts it on the same path as a window.
    auto interop = winrt::get_activation_factory<wgc::GraphicsCaptureItem,
                                                 ::IGraphicsCaptureItemInterop>();
    if (monitor) {
      hr = interop->CreateForMonitor(
          monitor, winrt::guid_of<wgc::GraphicsCaptureItem>(), winrt::put_abi(item_));
      if (FAILED(hr)) return HresultMessage("GraphicsCaptureItem::CreateForMonitor", hr);
    } else {
      hr = interop->CreateForWindow(
          hwnd, winrt::guid_of<wgc::GraphicsCaptureItem>(), winrt::put_abi(item_));
      if (FAILED(hr)) return HresultMessage("GraphicsCaptureItem::CreateForWindow", hr);
    }

    const auto size = item_.Size();
    // Encoders reject odd dimensions.
    width_ = static_cast<uint32_t>(size.Width) & ~1u;
    height_ = static_cast<uint32_t>(size.Height) & ~1u;

    // A capture item reports 0x0 for a window that is minimised, and also
    // briefly for one that has been created but not yet composed. Asking the
    // window itself is both a fallback and a better answer, since a minimised
    // window still has a client rect.
    if ((width_ == 0 || height_ == 0) && hwnd) {
      RECT rect = {};
      if (GetClientRect(hwnd, &rect)) {
        width_ = static_cast<uint32_t>(rect.right - rect.left) & ~1u;
        height_ = static_cast<uint32_t>(rect.bottom - rect.top) & ~1u;
      }
    }

    if (width_ == 0 || height_ == 0) {
      // Naming the numbers, because "no visible area" reads as a bug in this
      // app when it usually means the window is minimised.
      char buffer[192];
      snprintf(buffer, sizeof(buffer),
               "That window reports no visible area (%ldx%ld). "
               "If it is minimised, restore it and share again.",
               static_cast<long>(size.Width), static_cast<long>(size.Height));
      return buffer;
    }

    // The window's own size, which is what WGC hands over every frame.
    sourceWidth_ = width_;
    sourceHeight_ = height_;
    scale_ = false;
    maxWidth_ = maxWidth & ~1u;
    maxHeight_ = maxHeight & ~1u;
    sourceChangedAt_ = {};
    resizeFailed_ = false;
    if (maxWidth_ > 0 && maxHeight_ > 0) {
      // The stream is the window fitted into the preset, on the GPU, keeping
      // its aspect ratio — down or up. Down, because a 4K window went out at
      // 4K on the 1080p preset's bitrate, and encoding 4K while a game held
      // the GPU cost enough to lose frames. Up, so a small window still fills
      // the preset. When the window changes size the stream follows it (see
      // ResizeStream), so a browser made fullscreen becomes the full preset.
      //
      // The raw path scales too. It used to send the window at its starting
      // size, unscaled, and copy that much of every frame: a window made
      // bigger mid-broadcast went out as its top-left corner. ffmpeg is told
      // the frame size once, so there the stream keeps its size and a resized
      // window is letterboxed into it instead.
      uint32_t fittedWidth = 0;
      uint32_t fittedHeight = 0;
      Fit(width_, height_, &fittedWidth, &fittedHeight);
      if (fittedWidth > 0 && fittedHeight > 0) {
        width_ = fittedWidth;
        height_ = fittedHeight;
        // Always through the scaler on this path, even at 1:1: it is what
        // lets the window change size mid-broadcast (see OnFrameInternal).
        scale_ = true;
      }
    }

    // AMF is fed NV12, which only the scaler produces. Without a preset to
    // scale into there is no NV12, so the frames go out raw instead.
    if (encode_ && encoder_->InputFormat() == DXGI_FORMAT_NV12 && !scale_) {
      fallbackReason_ = "AMF needs the frame scaled to NV12, and no output size was given.";
      encode_ = false;
      encoder_.reset();
    }

    if (encode_) {
      const std::string encoderError =
          encoder_->Start(device_.Get(), width_, height_, maxWidth_, maxHeight_, fps, bitrate);
      if (!encoderError.empty()) {
        // Degrade rather than refuse. NVENC can be present and still decline —
        // most often on a driver older than the headers this was built
        // against, which is what stopped a GTX 1060 sharing at all. The frames
        // can still be read back and encoded by ffmpeg, which is exactly the
        // path AMD and Intel take, so there is no reason to fail the
        // broadcast. Reported so it is visible rather than a silent downgrade.
        fallbackReason_ = encoderError;
        encode_ = false;
        const bool wasNvenc = encoder_->InputFormat() != DXGI_FORMAT_NV12;
        encoder_.reset();
        // An NVIDIA card whose NVENC declined keeps exactly what it had: the
        // window at its own size, unscaled BGRA. A Radeon whose AMF declined
        // keeps the scaled NV12 readback below, which is what it always had.
        if (wasNvenc) {
          width_ = sourceWidth_;
          height_ = sourceHeight_;
          scale_ = false;
        }
      }
    }

    // A dedicated surface. For the NVENC path each captured frame is copied
    // into it GPU-to-GPU, which avoids re-registering a different texture with
    // NVENC every frame. For the raw path it is a staging texture the CPU can
    // read, which is the one copy AMF and Quick Sync cost us — ffmpeg owns the
    // encoder there and cannot be handed a texture on this process's device.
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = width_;
    desc.Height = height_;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    // The raw path reads back NV12 when it scales: the video processor
    // converts on the way, so a frame is 1.5 bytes a pixel instead of 4.
    // BGRA at 1080p60 is ~500MB/s to copy out, hand to JavaScript and push
    // through a pipe, and only about half the frames made it — ffmpeg then
    // duplicated the rest, which looked like slow motion. It also spares
    // ffmpeg converting every frame to NV12 on the CPU.
    // An encoder that takes NV12 (AMF) gets it from the scaler the same way.
    nv12_ = encode_ ? encoder_->InputFormat() == DXGI_FORMAT_NV12 : scale_;
    desc.Format = nv12_ ? DXGI_FORMAT_NV12 : DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    if (encode_) {
      desc.Usage = D3D11_USAGE_DEFAULT;
      desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    } else {
      desc.Usage = D3D11_USAGE_STAGING;
      desc.BindFlags = 0;
      desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    }
    hr = device_->CreateTexture2D(&desc, nullptr, input_.GetAddressOf());
    if (FAILED(hr)) return HresultMessage("CreateTexture2D", hr);

    if (encode_) {
      const std::string registerError = encoder_->RegisterInput(input_.Get());
      if (!registerError.empty()) return registerError;
    }

    if (scale_ && !encode_) {
      // The video processor cannot write into a staging texture, so the raw
      // path scales into a surface of its own and copies that for readback.
      D3D11_TEXTURE2D_DESC renderedDesc = desc;
      renderedDesc.Usage = D3D11_USAGE_DEFAULT;
      renderedDesc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
      renderedDesc.CPUAccessFlags = 0;
      hr = device_->CreateTexture2D(&renderedDesc, nullptr, rendered_.GetAddressOf());
      if (FAILED(hr)) return HresultMessage("CreateTexture2D(scaled frame)", hr);
    }

    if (scale_) {
      const std::string scalerError = ConfigureScaler(sourceWidth_, sourceHeight_);
      if (!scalerError.empty()) {
        if (encode_) return scalerError;
        // Readback works without a scaler, so the raw path loses only resizing:
        // back to the window at its own size, as it was before it scaled.
        fprintf(stderr, "[zoia-capture] %s; sending unscaled\n", scalerError.c_str());
        scale_ = false;
        nv12_ = false;
        rendered_.Reset();
        width_ = sourceWidth_;
        height_ = sourceHeight_;
        desc.Width = width_;
        desc.Height = height_;
        desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        input_.Reset();
        hr = device_->CreateTexture2D(&desc, nullptr, input_.GetAddressOf());
        if (FAILED(hr)) return HresultMessage("CreateTexture2D", hr);
      }
    }

    // Sized for the largest the window can become, not for its size now.
    // Recreating the pool from the frame callback fails with
    // RPC_E_WRONG_THREAD, which left every frame skipped and viewers on a
    // black picture. A pool at least as big as any monitor holds a window
    // made fullscreen, and a smaller window just fills its top-left corner
    // (ContentSize says how much of it).
    poolWidth_ = static_cast<uint32_t>(std::max(size.Width, 0));
    poolHeight_ = static_cast<uint32_t>(std::max(size.Height, 0));
    scaleErrorLogged_ = false;
    if (hwnd) {
      const auto grow = [](HMONITOR monitor, HDC, LPRECT, LPARAM data) -> BOOL {
        auto* pool = reinterpret_cast<std::pair<uint32_t, uint32_t>*>(data);
        MONITORINFO info = {};
        info.cbSize = sizeof(info);
        if (GetMonitorInfoW(monitor, &info)) {
          pool->first = std::max<uint32_t>(pool->first, info.rcMonitor.right - info.rcMonitor.left);
          pool->second =
              std::max<uint32_t>(pool->second, info.rcMonitor.bottom - info.rcMonitor.top);
        }
        return TRUE;
      };
      std::pair<uint32_t, uint32_t> pool{poolWidth_, poolHeight_};
      EnumDisplayMonitors(nullptr, nullptr, grow, reinterpret_cast<LPARAM>(&pool));
      poolWidth_ = pool.first;
      poolHeight_ = pool.second;
    }
    framePool_ = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(
        winrtDevice_, wgdx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 3,
        {static_cast<int32_t>(poolWidth_), static_cast<int32_t>(poolHeight_)});
    session_ = framePool_.CreateCaptureSession(item_);

    // The capture is of the application, not of the cursor floating over it.
    session_.IsCursorCaptureEnabled(false);

    // Windows 11 outlines a captured window in yellow. It is off unless the
    // person asked for it in Settings: it is a reminder on the sharer's own
    // screen, and a distraction over a game. Windows 10 has no way to turn it
    // off, and there the border simply stays.
    hideBorder_ = !showBorder;
    if (hideBorder_) {
      try {
        if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
                L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired")) {
          session_.IsBorderRequired(false);
        }
      } catch (...) {
      }
    }

    // Windows Graphics Capture spaces frames at least ~16.7ms apart unless
    // told otherwise, and only delivers on a display refresh. On a 165Hz
    // monitor the first refresh past 16.7ms is the third (18.2ms), so a game
    // running at 90fps+ was delivered at 55fps — measured 52–55 — and every
    // missing frame was a hitch. Asking for every refresh instead lets the
    // raw path's own schedule pick 60 evenly spaced frames out of them.
    // Raw path only: NVENC's pacing was left exactly as it was.
    if (!encode_) {
      try {
        if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
                L"Windows.Graphics.Capture.GraphicsCaptureSession", L"MinUpdateInterval")) {
          session_.MinUpdateInterval(std::chrono::milliseconds(1));
        }
      } catch (...) {
      }
    }

    frameToken_ = framePool_.FrameArrived({this, &Session::OnFrame});
    session_.StartCapture();
    running_ = true;

    if (hideBorder_) HideBorder();
    return {};
  }

 public:
  void Stop() {
    if (!running_.exchange(false)) return;

    try {
      if (framePool_) framePool_.FrameArrived(frameToken_);
      if (session_) session_.Close();
      if (framePool_) framePool_.Close();
    } catch (...) {
      // Shutting down; a capture object objecting to being closed is not
      // worth propagating.
    }
    session_ = nullptr;
    framePool_ = nullptr;
    item_ = nullptr;

    // Under the lock so a frame already inside OnFrame finishes first.
    std::lock_guard<std::mutex> guard(encodeMutex_);
    if (encoder_) encoder_->Stop();
    if (tsfn_) {
      tsfn_.Release();
      tsfn_ = nullptr;
    }
  }

  uint32_t width() const { return width_; }
  uint32_t height() const { return height_; }
  void RequestKeyframe() {
    if (encode_ && encoder_) encoder_->RequestIdr();
  }

 private:
  void OnFrame(const wgc::Direct3D11CaptureFramePool& pool,
               const winrt::Windows::Foundation::IInspectable& args) {
    // This runs on a WinRT thread pool thread; an exception escaping here
    // would terminate the process rather than surface anywhere useful.
    try {
      OnFrameInternal(pool, args);
    } catch (const winrt::hresult_error& err) {
      Emit({}, false, HresultMessage("Capture frame", err.code()));
    } catch (...) {
      Emit({}, false, "A captured frame could not be processed.");
    }
  }

  void OnFrameInternal(const wgc::Direct3D11CaptureFramePool& pool,
                       const winrt::Windows::Foundation::IInspectable&) {
    auto frame = pool.TryGetNextFrame();
    if (!frame || !running_) return;
    // Every frame Windows delivers, before any pacing: compared with what is
    // kept, it says whether frames are lost here or never arrive at all.
    ++offeredCount_;

    std::lock_guard<std::mutex> guard(encodeMutex_);
    if (!running_) return;

    // The NVENC path paces after the copy, below; this is the raw path's.
    // Against a schedule of slots at the target rate, as NVENC's is. It used
    // to drop any frame within 14ms of the last one kept, and on a 144Hz
    // monitor (a frame every 6.9ms) that kept one in three: 48fps, unevenly
    // spaced, which ffmpeg padded out with duplicates and read as stutter.
    if (!encode_ && targetFps_ > 0) {
      const auto now = std::chrono::steady_clock::now();
      const auto interval = FrameInterval();
      if (nextFrameDue_.time_since_epoch().count() != 0 && now + interval / 4 < nextFrameDue_) {
        return;
      }
      // After a stall (a window that stopped redrawing), a fresh schedule
      // rather than a burst to catch up.
      nextFrameDue_ = nextFrameDue_.time_since_epoch().count() == 0 || nextFrameDue_ + interval < now
                          ? now + interval
                          : nextFrameDue_ + interval;
    }
    const auto previousArrival = lastFrameTime_;
    lastFrameTime_ = std::chrono::steady_clock::now();

    if (scale_) {
      // The window changed size: a game going fullscreen, or back to a window.
      // The pool is sized for any monitor (see StartInternal), so the new
      // picture is already whole in its top-left corner; only the scaler is
      // refitted to read that much of it.
      const auto content = frame.ContentSize();
      // Clamped to the pool: a window bigger than every monitor is cropped
      // rather than dropped.
      const uint32_t contentWidth =
          std::min<uint32_t>(static_cast<uint32_t>(std::max(content.Width, 0)), poolWidth_) & ~1u;
      const uint32_t contentHeight =
          std::min<uint32_t>(static_cast<uint32_t>(std::max(content.Height, 0)), poolHeight_) & ~1u;
      // Minimised: nothing to show, and nothing to resize to.
      if (contentWidth == 0 || contentHeight == 0) return;
      if (contentWidth != sourceWidth_ || contentHeight != sourceHeight_) {
        const std::string error = ConfigureScaler(contentWidth, contentHeight);
        if (error.empty()) {
          sourceChangedAt_ = std::chrono::steady_clock::now();
        } else if (!scaleErrorLogged_) {
          // The previous scaler is still in place: letterboxed, not stopped.
          scaleErrorLogged_ = true;
          fprintf(stderr, "[zoia-capture] %s\n", error.c_str());
        }
      }

      // Until then the new size is letterboxed into the stream's current one.
      // Only once the window has held its size: dragging an edge produces a
      // new size every frame, and each change costs viewers a keyframe.
      if (encode_ && !resizeFailed_ && sourceChangedAt_.time_since_epoch().count() != 0 &&
          std::chrono::steady_clock::now() - sourceChangedAt_ >= kResizeSettle) {
        sourceChangedAt_ = {};
        uint32_t fittedWidth = 0;
        uint32_t fittedHeight = 0;
        Fit(sourceWidth_, sourceHeight_, &fittedWidth, &fittedHeight);
        if (fittedWidth > 0 && fittedHeight > 0 &&
            (fittedWidth != width_ || fittedHeight != height_)) {
          ResizeStream(fittedWidth, fittedHeight);
        }
      }
    }

    auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    ComPtr<ID3D11Texture2D> captured;
    if (FAILED(access->GetInterface(IID_PPV_ARGS(captured.GetAddressOf())))) return;

    D3D11_TEXTURE2D_DESC capturedDesc = {};
    captured->GetDesc(&capturedDesc);
    const UINT copyW = std::min(scale_ ? sourceWidth_ : width_, capturedDesc.Width);
    const UINT copyH = std::min(scale_ ? sourceHeight_ : height_, capturedDesc.Height);
    if (copyW == 0 || copyH == 0) return;

    // A region copy rather than CopyResource: the destination is rounded down
    // to even dimensions for the encoder, so on a window with an odd width the
    // two textures do not match and CopyResource would quietly do nothing.
    // Clamping against captured dimensions prevents D3D11 dropping the call if
    // window geometry or borders differ from the capture item size.
    const D3D11_BOX box{0, 0, 0, copyW, copyH, 1};
    // Into a surface of our own when scaling: the pool's textures rotate, and
    // a video processor input view is tied to one texture.
    context_->CopySubresourceRegion(scale_ ? source_.Get() : input_.Get(), 0, 0, 0, 0,
                                    captured.Get(), 0, &box);

    if (encode_) {
      // Paced against a schedule of slots at the target rate, so a 144Hz
      // source does not flood the encoder, averaging out to the target at
      // any refresh rate. Only a source redrawing faster than the target is
      // paced: a frame after a gap of a whole interval or more — a window
      // that redraws once when clicked, typed in, or switched — goes out at
      // once. Dropping it left that picture unsent until the next redraw.
      //
      // All GPU work stays on this callback's thread. Encoding from a thread
      // of our own races Windows Graphics Capture's use of the device and
      // can hang NVENC: viewers see black and stopping the share freezes.
      const auto now = std::chrono::steady_clock::now();
      const auto interval = FrameInterval();
      const bool redrawingFast = previousArrival.time_since_epoch().count() != 0 &&
                                 now - previousArrival < interval;
      if (targetFps_ > 0 && redrawingFast && nextFrameDue_.time_since_epoch().count() != 0 &&
          now + interval / 4 < nextFrameDue_) {
        return;
      }
      EncodeLatest(now);
      return;
    }

    // The JavaScript side has not taken the last frames yet: the main thread
    // is stalled. Queueing more only delivered them later as a burst, each
    // copied on that same thread — longer stall, older frames — and the
    // pacer had already repeated the previous one in their place, so viewers
    // got a duplicate and then a skip. Skipping the readback here also spares
    // the GPU sync for a frame that would only have been late. Two in flight,
    // not one: the main thread routinely stalls for about two frames.
    if (rawInFlight_.load() >= kMaxRawInFlight) {
      ++backlogDropped_;
      return;
    }

    ++arrivedCount_;
    const auto encodeStart = std::chrono::steady_clock::now();

    if (scale_) {
      if (!Scale()) return;
      context_->CopyResource(input_.Get(), rendered_.Get());
    }

    // Raw path, for a GPU whose encoder this process cannot drive directly.
    // The frame is read back and handed to ffmpeg, which encodes it with AMF
    // or Quick Sync. One readback per frame is the whole cost of supporting
    // those GPUs, and it is paid on the capture thread rather than the UI one.
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    const HRESULT hr = context_->Map(input_.Get(), 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr)) {
      Emit({}, false, HresultMessage("Map(staging texture)", hr));
      return;
    }

    // NV12 is a full-height luma plane of one byte a pixel, then a half-height
    // plane of interleaved chroma, at the same pitch, right after it.
    const size_t rowBytes = static_cast<size_t>(width_) * (nv12_ ? 1 : 4);
    const uint32_t rows = nv12_ ? height_ + height_ / 2 : height_;
    // Not `frame`: that name already belongs to the captured surface above.
    std::vector<uint8_t> pixels(rowBytes * rows);
    const auto* src = static_cast<const uint8_t*>(mapped.pData);
    // Row by row: the mapped pitch is the driver's, and is usually padded out
    // beyond the row itself.
    for (uint32_t y = 0; y < rows; ++y) {
      memcpy(pixels.data() + y * rowBytes, src + static_cast<size_t>(y) * mapped.RowPitch, rowBytes);
    }
    context_->Unmap(input_.Get(), 0);

    const uint64_t readbackNanos = std::chrono::duration_cast<std::chrono::nanoseconds>(
                                       std::chrono::steady_clock::now() - encodeStart)
                                       .count();
    encodeNanos_ += readbackNanos;
    if (readbackNanos > maxReadbackNanos_) maxReadbackNanos_ = readbackNanos;
    ++frameIndex_;
    EmitRaw(std::move(pixels));
  }

  // Scales the last copied frame into the scaler's output. Called with
  // encodeMutex_ held.
  bool Scale() {
    D3D11_VIDEO_PROCESSOR_STREAM stream = {};
    stream.Enable = TRUE;
    stream.pInputSurface = scalerInput_.Get();
    const HRESULT blt =
        videoContext_->VideoProcessorBlt(scaler_.Get(), scalerOutput_.Get(), 0, 1, &stream);
    if (FAILED(blt)) {
      Emit({}, false, HresultMessage("VideoProcessorBlt", blt));
      return false;
    }
    return true;
  }

  std::chrono::nanoseconds FrameInterval() const {
    return std::chrono::nanoseconds(1'000'000'000LL / std::max<uint32_t>(targetFps_, 1));
  }

  // Scales (if needed) and encodes what the last copy left in the encoder's
  // input, and moves the schedule on. Called with encodeMutex_ held.
  void EncodeLatest(std::chrono::steady_clock::time_point now) {
    const auto interval = FrameInterval();
    if (nextFrameDue_.time_since_epoch().count() == 0) {
      nextFrameDue_ = now + interval;
    } else {
      nextFrameDue_ += interval;
      // After a stall (a window that stopped redrawing), start a fresh
      // schedule rather than accepting a burst to catch up.
      if (nextFrameDue_ < now) nextFrameDue_ = now + interval;
    }

    if (scale_ && !Scale()) return;

    ++arrivedCount_;
    const auto encodeStart = std::chrono::steady_clock::now();
    Packet packet;
    std::string error;
    if (!encoder_->Encode(frameIndex_++, &packet, &error)) {
      Emit({}, false, error);
      return;
    }
    encodeNanos_ += std::chrono::duration_cast<std::chrono::nanoseconds>(
                        std::chrono::steady_clock::now() - encodeStart)
                        .count();
    if (!packet.data.empty()) Emit(std::move(packet.data), packet.keyframe, {});
  }

 public:
  // Distinguishes "the window is not redrawing" from "the encoder is slow",
  // which look identical from the outside.
  uint64_t arrived() const { return arrivedCount_; }
  /** "h264" when NVENC encoded it; otherwise the raw frames' pixel format. */
  const char* output() const { return encode_ ? "h264" : nv12_ ? "nv12" : "bgra"; }
  /** "nvenc" or "amf" when the addon encodes; empty when frames go out raw. */
  const char* encoderName() const { return encode_ && encoder_ ? encoder_->Name() : ""; }

  /**
   * Moves the encoder to a new target bitrate mid-stream — what the room's
   * WebRTC sender estimates the uplink will carry. Raw frames have no
   * encoder here to tell; ffmpeg's rate is fixed for its run.
   */
  std::string SetBitrate(uint32_t bitrate) {
    std::lock_guard<std::mutex> guard(encodeMutex_);
    if (!running_ || !encode_ || !encoder_) return "No encoder is running.";
    return encoder_->SetBitrate(bitrate);
  }
  /** Empty unless NVENC was available, tried, and declined. */
  const std::string& fallbackReason() const { return fallbackReason_; }
  const char* vendor() const { return VendorName(adapter_.vendorId); }
  const std::string& adapterName() const { return adapter_.name; }
  uint64_t offered() const { return offeredCount_; }
  uint64_t encodeNanos() const { return encodeNanos_; }
  uint64_t takeMaxReadbackNanos() { return maxReadbackNanos_.exchange(0); }
  uint64_t backlogDropped() const { return backlogDropped_; }

  double averageEncodeMs() const {
    return arrivedCount_ ? (static_cast<double>(encodeNanos_) / arrivedCount_) / 1e6 : 0.0;
  }

 private:
  /**
   * Turns off the yellow outline Windows 11 draws around a captured window —
   * a reminder on the sharer's own screen, and a distraction over a game.
   * Only when the person has not asked for it in Settings. Windows 10 cannot
   * turn it off, and there it simply stays.
   *
   * Windows wants the app to ask first, and that answer arrives
   * asynchronously. It must never be waited for here: this runs on the main
   * process's thread, and blocking on it froze the whole app at "starting".
   * So the first capture asks and applies the answer when it comes; every one
   * after that applies it straight away.
   */
  void HideBorder() {
    static const bool supported =
        winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
            L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired");
    if (!supported) return;

    try {
      session_.IsBorderRequired(false);
    } catch (...) {
    }

    if (borderAccess_ == BorderAccess::Allowed) return;
    if (borderAccess_ != BorderAccess::Unknown) return;

    borderAccess_ = BorderAccess::Asking;
    try {
      auto request =
          wgc::GraphicsCaptureAccess::RequestAccessAsync(wgc::GraphicsCaptureAccessKind::Borderless);
      // Its own reference, so the answer never races Stop() clearing session_;
      // a session closed by then just refuses, inside the try below.
      request.Completed([this, session = session_](
                            const auto& operation, winrt::Windows::Foundation::AsyncStatus status) {
        bool allowed = false;
        try {
          allowed = status == winrt::Windows::Foundation::AsyncStatus::Completed &&
                    operation.GetResults() == winrt::Windows::Security::Authorization::
                                                  AppCapabilityAccess::AppCapabilityAccessStatus::Allowed;
        } catch (...) {
        }
        borderAccess_ = allowed ? BorderAccess::Allowed : BorderAccess::Denied;
        try {
          session.IsBorderRequired(false);
        } catch (...) {
        }
      });
    } catch (...) {
      borderAccess_ = BorderAccess::Denied;
    }
  }

  /**
   * D3D11's video processor: the GPU's fixed-function scaler, the same one
   * video playback uses, so it costs next to nothing next to the encode.
   *
   * Fits a window of the given size into input_, the stream's fixed size,
   * keeping its aspect ratio and filling the rest with black. Called at the
   * start and again whenever the window changes size; everything tied to the
   * source size is rebuilt, and the output is repainted whole on every frame.
   */
  // `width` x `height` fitted into the preset, keeping its shape, rounded
  // down to the even sizes encoders require.
  void Fit(uint32_t width, uint32_t height, uint32_t* fittedWidth, uint32_t* fittedHeight) const {
    const double factor = std::min(static_cast<double>(maxWidth_) / width,
                                   static_cast<double>(maxHeight_) / height);
    *fittedWidth = std::min(static_cast<uint32_t>(width * factor) & ~1u, maxWidth_);
    *fittedHeight = std::min(static_cast<uint32_t>(height * factor) & ~1u, maxHeight_);
  }

  // Moves the stream to a new size: a fresh encoder input of that size, NVENC
  // reconfigured in place, and the scaler pointed at the new input. Called
  // with encodeMutex_ held, before the frame being handled is copied, so the
  // frame that triggered it is the first one at the new size.
  void ResizeStream(uint32_t width, uint32_t height) {
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = encoder_->InputFormat();
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    ComPtr<ID3D11Texture2D> texture;
    HRESULT hr = device_->CreateTexture2D(&desc, nullptr, texture.GetAddressOf());
    if (FAILED(hr)) {
      resizeFailed_ = true;
      return;
    }

    const std::string error = encoder_->Resize(texture.Get(), width, height);
    if (!error.empty()) {
      // A driver that will not change size in place keeps the stream at its
      // starting size, letterboxed, as before: worse, not broken. Not tried
      // again, since it would fail the same way on every resize.
      resizeFailed_ = true;
      fprintf(stderr, "[zoia-capture] %s; keeping %ux%u\n", error.c_str(), width_, height_);
      return;
    }

    input_ = texture;
    width_ = width;
    height_ = height;
    const std::string scalerError = ConfigureScaler(sourceWidth_, sourceHeight_);
    if (!scalerError.empty()) Emit({}, false, scalerError);
  }

  std::string ConfigureScaler(uint32_t sourceWidth, uint32_t sourceHeight) {
    // Built aside and swapped in only once it is complete. A resize that fails
    // halfway used to clear the scaler that was already working, and the next
    // frame then failed and ended the broadcast.
    ComPtr<ID3D11VideoDevice> videoDevice = videoDevice_;
    ComPtr<ID3D11VideoContext> videoContext = videoContext_;
    if (!videoDevice && FAILED(device_.As(&videoDevice))) return "No video processor on this GPU.";
    if (!videoContext && FAILED(context_.As(&videoContext))) {
      return "No video processor on this GPU.";
    }

    D3D11_VIDEO_PROCESSOR_CONTENT_DESC content = {};
    content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    content.InputWidth = sourceWidth;
    content.InputHeight = sourceHeight;
    content.OutputWidth = width_;
    content.OutputHeight = height_;
    content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;
    ComPtr<ID3D11VideoProcessorEnumerator> scalerEnum;
    HRESULT hr = videoDevice->CreateVideoProcessorEnumerator(&content, scalerEnum.GetAddressOf());
    if (FAILED(hr)) return HresultMessage("CreateVideoProcessorEnumerator", hr);
    UINT support = 0;
    if (FAILED(scalerEnum->CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM, &support)) ||
        !(support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT) ||
        (!nv12_ && !(support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT))) {
      return "The GPU's video processor cannot scale BGRA frames.";
    }
    if (nv12_) {
      UINT nv12Support = 0;
      if (FAILED(scalerEnum->CheckVideoProcessorFormat(DXGI_FORMAT_NV12, &nv12Support)) ||
          !(nv12Support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT)) {
        return "The GPU's video processor cannot convert frames to NV12.";
      }
    }
    ComPtr<ID3D11VideoProcessor> scaler;
    hr = videoDevice->CreateVideoProcessor(scalerEnum.Get(), 0, scaler.GetAddressOf());
    if (FAILED(hr)) return HresultMessage("CreateVideoProcessor", hr);

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = sourceWidth;
    desc.Height = sourceHeight;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    ComPtr<ID3D11Texture2D> source;
    hr = device_->CreateTexture2D(&desc, nullptr, source.GetAddressOf());
    if (FAILED(hr)) return HresultMessage("CreateTexture2D(scaler source)", hr);

    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC inDesc = {};
    inDesc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    ComPtr<ID3D11VideoProcessorInputView> scalerInput;
    hr = videoDevice->CreateVideoProcessorInputView(source.Get(), scalerEnum.Get(), &inDesc,
                                                    scalerInput.GetAddressOf());
    if (FAILED(hr)) return HresultMessage("CreateVideoProcessorInputView", hr);

    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC outDesc = {};
    outDesc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    ComPtr<ID3D11VideoProcessorOutputView> scalerOutput;
    hr = videoDevice->CreateVideoProcessorOutputView(encode_ ? input_.Get() : rendered_.Get(),
                                                     scalerEnum.Get(), &outDesc,
                                                     scalerOutput.GetAddressOf());
    if (FAILED(hr)) return HresultMessage("CreateVideoProcessorOutputView", hr);

    // Plain scaling: no driver "enhancements" such as denoise or edge
    // sharpening deciding on their own what a game should look like.
    videoContext->VideoProcessorSetStreamAutoProcessingMode(scaler.Get(), 0, FALSE);
    videoContext->VideoProcessorSetStreamFrameFormat(scaler.Get(), 0,
                                                     D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
    if (nv12_) {
      // Full-range RGB in, BT.709 limited-range YUV out: what ffmpeg is told
      // the frames are (see buildArgs), and what HD video is assumed to be.
      D3D11_VIDEO_PROCESSOR_COLOR_SPACE in = {};
      in.RGB_Range = 0;
      videoContext->VideoProcessorSetStreamColorSpace(scaler.Get(), 0, &in);
      D3D11_VIDEO_PROCESSOR_COLOR_SPACE out = {};
      out.YCbCr_Matrix = 1;
      out.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
      videoContext->VideoProcessorSetOutputColorSpace(scaler.Get(), &out);
    }
    const RECT whole{0, 0, static_cast<LONG>(sourceWidth), static_cast<LONG>(sourceHeight)};
    videoContext->VideoProcessorSetStreamSourceRect(scaler.Get(), 0, TRUE, &whole);

    // Letterboxed into the stream's size; the background fills the bars.
    const double factor = std::min(static_cast<double>(width_) / sourceWidth,
                                   static_cast<double>(height_) / sourceHeight);
    const LONG fittedWidth = static_cast<LONG>(sourceWidth * factor);
    const LONG fittedHeight = static_cast<LONG>(sourceHeight * factor);
    const LONG left = (static_cast<LONG>(width_) - fittedWidth) / 2;
    const LONG top = (static_cast<LONG>(height_) - fittedHeight) / 2;
    const RECT fitted{left, top, left + fittedWidth, top + fittedHeight};
    videoContext->VideoProcessorSetStreamDestRect(scaler.Get(), 0, TRUE, &fitted);
    const RECT target{0, 0, static_cast<LONG>(width_), static_cast<LONG>(height_)};
    videoContext->VideoProcessorSetOutputTargetRect(scaler.Get(), TRUE, &target);
    D3D11_VIDEO_COLOR black = {};
    black.RGBA.A = 1.0f;
    videoContext->VideoProcessorSetOutputBackgroundColor(scaler.Get(), FALSE, &black);

    videoDevice_ = videoDevice;
    videoContext_ = videoContext;
    sourceWidth_ = sourceWidth;
    sourceHeight_ = sourceHeight;
    scalerInput_ = scalerInput;
    scalerOutput_ = scalerOutput;
    scaler_ = scaler;
    scalerEnum_ = scalerEnum;
    source_ = source;
    return {};
  }

  void Emit(std::vector<uint8_t> data, bool keyframe, std::string error) {
    if (!tsfn_) return;
    auto* payload = new std::tuple<std::vector<uint8_t>, bool, std::string>(
        std::move(data), keyframe, std::move(error));

    const napi_status status = tsfn_.NonBlockingCall(
        payload, [](Napi::Env env, Napi::Function callback, decltype(payload) value) {
          auto& [bytes, key, err] = *value;
          if (!err.empty()) {
            callback.Call({Napi::String::New(env, err), env.Undefined(), env.Undefined()});
          } else {
            callback.Call({env.Null(),
                           Napi::Buffer<uint8_t>::Copy(env, bytes.data(), bytes.size()),
                           Napi::Boolean::New(env, key)});
          }
          delete value;
        });

    // The queue is unbounded (see Start), so this only fails once the
    // function is closing. Encoded packets are never dropped on purpose: one
    // missing H.264 frame breaks every frame after it until the next IDR. The
    // raw path bounds its own backlog instead, in OnFrameInternal.
    if (status != napi_ok) delete payload;
  }

  // A raw frame, counted while it waits for the JavaScript thread so the
  // capture can stop reading back frames that would only queue behind it.
  void EmitRaw(std::vector<uint8_t> data) {
    if (!tsfn_) return;
    auto* payload = new std::vector<uint8_t>(std::move(data));
    ++rawInFlight_;
    const napi_status status = tsfn_.NonBlockingCall(
        payload, [this](Napi::Env env, Napi::Function callback, std::vector<uint8_t>* bytes) {
          --rawInFlight_;
          // Torn down with frames still queued: nothing left to deliver to.
          if (env != nullptr && !callback.IsEmpty()) {
            // A copy rather than an external buffer: Electron's V8 memory
            // cage refuses buffers that point outside it.
            callback.Call({env.Null(),
                           Napi::Buffer<uint8_t>::Copy(env, bytes->data(), bytes->size()),
                           Napi::Boolean::New(env, false)});
          }
          delete bytes;
        });
    if (status != napi_ok) {
      --rawInFlight_;
      delete payload;
    }
  }

  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<ID3D11Texture2D> input_;
  // Only when scaling: the captured frame at full size, and the processor
  // that scales it into input_.
  ComPtr<ID3D11Texture2D> source_;
  // Raw path only: the scaler's output, copied into the staging input_.
  ComPtr<ID3D11Texture2D> rendered_;
  ComPtr<ID3D11VideoDevice> videoDevice_;
  ComPtr<ID3D11VideoContext> videoContext_;
  ComPtr<ID3D11VideoProcessorEnumerator> scalerEnum_;
  ComPtr<ID3D11VideoProcessor> scaler_;
  ComPtr<ID3D11VideoProcessorInputView> scalerInput_;
  ComPtr<ID3D11VideoProcessorOutputView> scalerOutput_;
  bool scale_ = false;
  // Raw path only: frames are read back as NV12 rather than BGRA.
  bool nv12_ = false;
  bool hideBorder_ = false;
  enum class BorderAccess { Unknown, Asking, Allowed, Denied };
  // Windows remembers the answer for the life of the process, and so do we.
  std::atomic<BorderAccess> borderAccess_{BorderAccess::Unknown};
  uint32_t sourceWidth_ = 0;
  uint32_t sourceHeight_ = 0;
  wgdx::Direct3D11::IDirect3DDevice winrtDevice_{nullptr};
  wgc::GraphicsCaptureItem item_{nullptr};
  wgc::Direct3D11CaptureFramePool framePool_{nullptr};
  wgc::GraphicsCaptureSession session_{nullptr};
  winrt::event_token frameToken_{};

  std::unique_ptr<VideoEncoder> encoder_;
  AdapterChoice adapter_;
  /** True when NVENC drives this session; false when frames go out raw. */
  bool encode_ = false;
  std::string fallbackReason_;
  std::mutex encodeMutex_;
  std::atomic<bool> running_{false};
  int64_t frameIndex_ = 0;
  std::atomic<uint64_t> arrivedCount_{0};
  std::atomic<uint64_t> encodeNanos_{0};
  std::atomic<uint64_t> offeredCount_{0};
  // Raw path: the slowest scale + readback since stats() last asked.
  std::atomic<uint64_t> maxReadbackNanos_{0};
  // Raw path: frames emitted and not yet handed to JavaScript, and how many
  // were skipped because that backlog was full.
  static constexpr uint32_t kMaxRawInFlight = 2;
  std::atomic<uint32_t> rawInFlight_{0};
  std::atomic<uint64_t> backlogDropped_{0};
  uint32_t width_ = 0;
  uint32_t height_ = 0;
  uint32_t targetFps_ = 0;
  // The preset: the largest the stream may be, and what a resize fits into.
  uint32_t maxWidth_ = 0;
  uint32_t maxHeight_ = 0;
  // When the window last changed size; zero once the stream has followed it.
  std::chrono::steady_clock::time_point sourceChangedAt_{};
  bool resizeFailed_ = false;
  bool scaleErrorLogged_ = false;
  // The frame pool's buffer size, fixed for the session.
  uint32_t poolWidth_ = 0;
  uint32_t poolHeight_ = 0;
  static constexpr std::chrono::milliseconds kResizeSettle{300};
  std::chrono::steady_clock::time_point lastFrameTime_{};
  std::chrono::steady_clock::time_point nextFrameDue_{};
  Napi::ThreadSafeFunction tsfn_;
};

Session g_session;

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "start(options, callback) expects an object and a function")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const Napi::Object options = info[0].As<Napi::Object>();
  // A screen is named by a point on it, in physical pixels, and Windows says
  // which monitor that is. A window by its handle — passed as a string: an
  // HWND does not survive a double precisely enough to be worth trusting.
  HWND hwnd = nullptr;
  HMONITOR monitor = nullptr;
  if (options.Has("monitor") && options.Get("monitor").IsObject()) {
    const Napi::Object at = options.Get("monitor").As<Napi::Object>();
    const POINT point{at.Get("x").ToNumber().Int32Value(), at.Get("y").ToNumber().Int32Value()};
    monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONULL);
    if (!monitor) {
      Napi::Error::New(env, "That screen is no longer connected.").ThrowAsJavaScriptException();
      return env.Undefined();
    }
  } else {
    const std::string handle = options.Get("hwnd").ToString().Utf8Value();
    hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(std::stoull(handle)));
  }
  const uint32_t fps = options.Get("framerate").ToNumber().Uint32Value();
  const uint32_t bitrate = options.Get("bitrate").ToNumber().Uint32Value();
  const uint32_t maxWidth = options.Has("maxWidth") ? options.Get("maxWidth").ToNumber().Uint32Value() : 0;
  const uint32_t maxHeight = options.Has("maxHeight") ? options.Get("maxHeight").ToNumber().Uint32Value() : 0;
  const bool showBorder = options.Has("showBorder") && options.Get("showBorder").ToBoolean().Value();

  if (!monitor && !IsWindow(hwnd)) {
    Napi::Error::New(env, "That window no longer exists.").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto tsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "zoia-capture", 0, 1);
  const std::string error =
      g_session.Start(hwnd, monitor, fps, bitrate, maxWidth, maxHeight, showBorder, tsfn);
  if (!error.empty()) {
    g_session.Stop();
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("width", Napi::Number::New(env, g_session.width()));
  result.Set("height", Napi::Number::New(env, g_session.height()));
  // The caller cannot configure ffmpeg without knowing which of the two kinds
  // of payload is about to start arriving.
  result.Set("output", Napi::String::New(env, g_session.output()));
  result.Set("fallbackReason", Napi::String::New(env, g_session.fallbackReason()));
  result.Set("vendor", Napi::String::New(env, g_session.vendor()));
  result.Set("adapter", Napi::String::New(env, g_session.adapterName()));
  result.Set("encoder", Napi::String::New(env, g_session.encoderName()));
  return result;
}

Napi::Value SetBitrate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "setBitrate(bitsPerSecond) expects a number")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const std::string error = g_session.SetBitrate(info[0].ToNumber().Uint32Value());
  if (!error.empty()) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Napi::Value RequestKeyframe(const Napi::CallbackInfo& info) {
  g_session.RequestKeyframe();
  return info.Env().Undefined();
}

// Running totals, for the raw path's periodic log line; the caller diffs them.
Napi::Value Stats(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object stats = Napi::Object::New(env);
  stats.Set("framesOffered", Napi::Number::New(env, static_cast<double>(g_session.offered())));
  stats.Set("framesArrived", Napi::Number::New(env, static_cast<double>(g_session.arrived())));
  stats.Set("encodeMs", Napi::Number::New(env, g_session.encodeNanos() / 1e6));
  stats.Set("maxReadbackMs", Napi::Number::New(env, g_session.takeMaxReadbackNanos() / 1e6));
  stats.Set("framesBacklogged",
            Napi::Number::New(env, static_cast<double>(g_session.backlogDropped())));
  return stats;
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object stats = Napi::Object::New(env);
  stats.Set("framesArrived", Napi::Number::New(env, static_cast<double>(g_session.arrived())));
  stats.Set("averageEncodeMs", Napi::Number::New(env, g_session.averageEncodeMs()));
  g_session.Stop();
  return stats;
}

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);

  bool wgcOk = false;
  try {
    wgcOk = wgc::GraphicsCaptureSession::IsSupported();
  } catch (...) {
    wgcOk = false;
  }

  // Resolved from the adapter this session would actually run on, not from
  // the mere presence of a driver DLL. A laptop with switchable graphics has
  // NVENC installed and renders on the integrated GPU, so the old check said
  // yes and the broadcast then failed — which is the bug this replaces.
  const AdapterChoice choice = ChooseAdapter();

  // Any hardware adapter can be encoded for: NVIDIA in-process through NVENC,
  // AMD and Intel by handing raw frames to ffmpeg for AMF or Quick Sync.
  const bool encoderOk = static_cast<bool>(choice.adapter);

  out.Set("windowCapture", Napi::Boolean::New(env, wgcOk));
  out.Set("hardwareEncoder", Napi::Boolean::New(env, encoderOk));
  out.Set("vendor", Napi::String::New(env, VendorName(choice.vendorId)));
  out.Set("adapter", Napi::String::New(env, choice.name));
  // Which encoder the frames will meet, so the UI can say so rather than
  // implying every GPU path is NVENC.
  out.Set("encoder", Napi::String::New(env, choice.nvenc ? "nvenc"
                                            : choice.vendorId == kVendorIntel ? "qsv"
                                            : encoderOk ? "amf"
                                                        : "none"));
  return out;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // Electron's main process has already put this thread in an STA, so asking
  // for an MTA throws RPC_E_CHANGED_MODE — which, with C++ exceptions
  // disabled for N-API, took the whole process down. The existing apartment
  // is fine: the frame pool is created free-threaded, so its callbacks do not
  // depend on this thread's model.
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
  } catch (...) {
    // Already initialised, in either mode. Nothing to do.
  }
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("stats", Napi::Function::New(env, Stats));
  exports.Set("requestKeyframe", Napi::Function::New(env, RequestKeyframe));
  exports.Set("setBitrate", Napi::Function::New(env, SetBitrate));
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  return exports;
}

}  // namespace

NODE_API_MODULE(zoia_capture, Init)
