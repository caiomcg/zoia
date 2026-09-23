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
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <ffnvcodec/nvEncodeAPI.h>

#include <atomic>
#include <chrono>
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

struct AdapterChoice {
  ComPtr<IDXGIAdapter1> adapter;
  UINT vendorId = 0;
  std::string name;
  /** True only when this is an NVIDIA adapter AND the NVENC runtime loaded. */
  bool nvenc = false;
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
 * adapter, whose frames go out to ffmpeg for AMF or Quick Sync.
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

  return choice;
}

// Encoded output handed back to JavaScript.
struct Packet {
  std::vector<uint8_t> data;
  bool keyframe = false;
};

class Encoder {
 public:
  ~Encoder() { Stop(); }

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

  std::string Start(ID3D11Device* device, uint32_t width, uint32_t height, uint32_t fps,
                    uint32_t bitrate) {
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

    NV_ENC_INITIALIZE_PARAMS init = {};
    init.version = NV_ENC_INITIALIZE_PARAMS_VER;
    init.encodeGUID = NV_ENC_CODEC_H264_GUID;
    init.presetGUID = NV_ENC_PRESET_P4_GUID;
    init.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
    init.encodeWidth = width;
    init.encodeHeight = height;
    init.darWidth = width;
    init.darHeight = height;
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
  std::string RegisterInput(ID3D11Texture2D* texture) {
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

  // Encodes one already-on-GPU texture. Returns false only on a real failure;
  // a frame the encoder chooses not to emit is not an error.
  bool Encode(int64_t timestamp, Packet* out, std::string* error) {
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

  void Stop() {
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
  void* encoder_ = nullptr;
  NV_ENC_OUTPUT_PTR bitstream_ = nullptr;
  NV_ENC_REGISTERED_PTR registered_ = nullptr;
  uint32_t width_ = 0;
  uint32_t height_ = 0;
};

class Session {
 public:
  std::string Start(HWND hwnd, uint32_t fps, uint32_t bitrate, Napi::ThreadSafeFunction tsfn) {
    try {
      return StartInternal(hwnd, fps, bitrate, std::move(tsfn));
    } catch (const winrt::hresult_error& err) {
      return HresultMessage("Windows Graphics Capture", err.code());
    } catch (const std::exception& err) {
      return std::string("Capture failed to start: ") + err.what();
    } catch (...) {
      return "Capture failed to start for an unknown reason.";
    }
  }

 private:
  std::string StartInternal(HWND hwnd, uint32_t fps, uint32_t bitrate,
                            Napi::ThreadSafeFunction tsfn) {
    tsfn_ = std::move(tsfn);

    adapter_ = ChooseAdapter();
    if (!adapter_.adapter) return "No hardware graphics adapter was found.";
    // NVENC only when the adapter we are actually rendering on is NVIDIA's.
    // Otherwise the frames go out raw and ffmpeg encodes them with AMF on a
    // Radeon or Quick Sync on an Intel GPU.
    encode_ = adapter_.nvenc;

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

    // The documented way to capture a specific window: WGC itself has no
    // HWND-shaped entry point, only this interop factory.
    auto interop = winrt::get_activation_factory<wgc::GraphicsCaptureItem,
                                                 ::IGraphicsCaptureItemInterop>();
    hr = interop->CreateForWindow(
        hwnd, winrt::guid_of<wgc::GraphicsCaptureItem>(), winrt::put_abi(item_));
    if (FAILED(hr)) return HresultMessage("GraphicsCaptureItem::CreateForWindow", hr);

    const auto size = item_.Size();
    // NVENC rejects odd dimensions.
    width_ = static_cast<uint32_t>(size.Width) & ~1u;
    height_ = static_cast<uint32_t>(size.Height) & ~1u;
    if (width_ == 0 || height_ == 0) return "That window has no visible area to capture.";

    if (encode_) {
      const std::string encoderError = encoder_.Start(device_.Get(), width_, height_, fps, bitrate);
      if (!encoderError.empty()) return encoderError;
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
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
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
      const std::string registerError = encoder_.RegisterInput(input_.Get());
      if (!registerError.empty()) return registerError;
    }

    framePool_ = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(
        winrtDevice_, wgdx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 3, item_.Size());
    session_ = framePool_.CreateCaptureSession(item_);

    // The capture is of the application, not of the cursor floating over it.
    session_.IsCursorCaptureEnabled(false);

    frameToken_ = framePool_.FrameArrived({this, &Session::OnFrame});
    session_.StartCapture();
    running_ = true;
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
    encoder_.Stop();
    if (tsfn_) {
      tsfn_.Release();
      tsfn_ = nullptr;
    }
  }

  uint32_t width() const { return width_; }
  uint32_t height() const { return height_; }

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

    std::lock_guard<std::mutex> guard(encodeMutex_);
    if (!running_) return;

    auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    ComPtr<ID3D11Texture2D> captured;
    if (FAILED(access->GetInterface(IID_PPV_ARGS(captured.GetAddressOf())))) return;

    // A region copy rather than CopyResource: the destination is rounded down
    // to even dimensions for the encoder, so on a window with an odd width the
    // two textures do not match and CopyResource would quietly do nothing.
    const D3D11_BOX box{0, 0, 0, width_, height_, 1};
    context_->CopySubresourceRegion(input_.Get(), 0, 0, 0, 0, captured.Get(), 0, &box);

    ++arrivedCount_;
    const auto encodeStart = std::chrono::steady_clock::now();

    if (encode_) {
      Packet packet;
      std::string error;
      if (!encoder_.Encode(frameIndex_++, &packet, &error)) {
        Emit({}, false, error);
        return;
      }
      encodeNanos_ += std::chrono::duration_cast<std::chrono::nanoseconds>(
                          std::chrono::steady_clock::now() - encodeStart)
                          .count();
      if (!packet.data.empty()) Emit(std::move(packet.data), packet.keyframe, {});
      return;
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

    const size_t rowBytes = static_cast<size_t>(width_) * 4;
    std::vector<uint8_t> frame(rowBytes * height_);
    const auto* src = static_cast<const uint8_t*>(mapped.pData);
    // Row by row: the mapped pitch is the driver's, and is usually padded out
    // beyond width * 4.
    for (uint32_t y = 0; y < height_; ++y) {
      memcpy(frame.data() + y * rowBytes, src + static_cast<size_t>(y) * mapped.RowPitch, rowBytes);
    }
    context_->Unmap(input_.Get(), 0);

    encodeNanos_ += std::chrono::duration_cast<std::chrono::nanoseconds>(
                        std::chrono::steady_clock::now() - encodeStart)
                        .count();
    ++frameIndex_;
    Emit(std::move(frame), false, {});
  }

 public:
  // Distinguishes "the window is not redrawing" from "the encoder is slow",
  // which look identical from the outside.
  uint64_t arrived() const { return arrivedCount_; }
  /** "h264" when NVENC encoded it, "bgra" when raw frames are being sent. */
  const char* output() const { return encode_ ? "h264" : "bgra"; }
  const char* vendor() const { return VendorName(adapter_.vendorId); }
  const std::string& adapterName() const { return adapter_.name; }
  double averageEncodeMs() const {
    return arrivedCount_ ? (static_cast<double>(encodeNanos_) / arrivedCount_) / 1e6 : 0.0;
  }

 private:

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

    // Dropped rather than queued: a frame that cannot be delivered now is
    // already late, and a backlog would only add latency.
    if (status != napi_ok) delete payload;
  }

  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<ID3D11Texture2D> input_;
  wgdx::Direct3D11::IDirect3DDevice winrtDevice_{nullptr};
  wgc::GraphicsCaptureItem item_{nullptr};
  wgc::Direct3D11CaptureFramePool framePool_{nullptr};
  wgc::GraphicsCaptureSession session_{nullptr};
  winrt::event_token frameToken_{};

  Encoder encoder_;
  AdapterChoice adapter_;
  /** True when NVENC drives this session; false when frames go out raw. */
  bool encode_ = false;
  std::mutex encodeMutex_;
  std::atomic<bool> running_{false};
  int64_t frameIndex_ = 0;
  std::atomic<uint64_t> arrivedCount_{0};
  std::atomic<uint64_t> encodeNanos_{0};
  uint32_t width_ = 0;
  uint32_t height_ = 0;
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
  // Passed as a string: an HWND does not survive a double precisely enough to
  // be worth trusting on a 64-bit process.
  const std::string handle = options.Get("hwnd").ToString().Utf8Value();
  const auto hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(std::stoull(handle)));
  const uint32_t fps = options.Get("framerate").ToNumber().Uint32Value();
  const uint32_t bitrate = options.Get("bitrate").ToNumber().Uint32Value();

  if (!IsWindow(hwnd)) {
    Napi::Error::New(env, "That window no longer exists.").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto tsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "zoia-capture", 0, 1);
  const std::string error = g_session.Start(hwnd, fps, bitrate, tsfn);
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
  result.Set("vendor", Napi::String::New(env, g_session.vendor()));
  result.Set("adapter", Napi::String::New(env, g_session.adapterName()));
  return result;
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
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  return exports;
}

}  // namespace

NODE_API_MODULE(zoia_capture, Init)
