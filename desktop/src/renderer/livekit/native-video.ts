/**
 * NVIDIA and AMD: a window captured and encoded by NVENC or AMF in the native
 * addon, sent on the room's own WebRTC connection.
 *
 * The ffmpeg + WHIP route put a muxer between audio and video, and it kept
 * stalling one on the other. This follows the shape Discord describes
 * instead: a hardware encoder, and audio and video as separate RTP streams on
 * one connection, synchronised by the receiver.
 *
 * Chromium has no way to accept an already-encoded frame directly, so a
 * placeholder track carries the timing: one tiny frame is written for every
 * frame NVENC produces, and native-transform.worker.ts replaces each encoded
 * placeholder with the NVENC frame before it is packetized.
 *
 * Intel stays on the ffmpeg route; macOS never gets here, because the native
 * addon is Windows-only.
 */

import { captureBorderEnabled } from '../capture-border';
import { createBitrateController, limitsFor } from './adaptive-bitrate';

interface TrackGenerator extends MediaStreamTrack {
  writable: WritableStream<VideoFrame>;
}

declare const MediaStreamTrackGenerator: {
  new (init: { kind: 'video' }): TrackGenerator;
};

/** The fields of an RTCIceCandidatePairStats this reads. */
interface CandidatePairStats {
  type: string;
  nominated?: boolean;
  state?: string;
  availableOutgoingBitrate?: number;
}

// The placeholder is never seen by anyone; it only has to be a valid frame.
const PLACEHOLDER_SIZE = 16;
const PLACEHOLDER_PIXELS = new Uint8Array(PLACEHOLDER_SIZE * PLACEHOLDER_SIZE * 4);

export interface NativeVideo {
  /** The placeholder track, to publish like any other video track. */
  track: MediaStreamTrack;
  /** What is actually being sent, decoded, for the sharer's own preview. Never published. */
  preview: MediaStreamTrack;
  /** Puts NVENC's frames in place of the placeholder's on this sender. */
  attach(sender: RTCRtpSender): void;
  /** Starts capture and encoding. Call after `attach`, so no frame goes out untransformed. */
  start(): Promise<{ width: number; height: number }>;
  /** The size being sent now: it follows the shared window when that is resized. */
  size(): { width: number; height: number };
  /** "nvenc" or "amf", once started. */
  encoder(): string;
  stop(): Promise<void>;
}

export function createNativeVideo(
  /** A window by its handle, or a whole screen by its display id. */
  target: { hwnd: number } | { displayId: string },
  quality: { maxFramerate: number; maxBitrate: number; width: number; height: number },
  onError: (message: string) => void,
): NativeVideo {
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const writer = generator.writable.getWriter();
  const previewGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
  const previewWriter = previewGenerator.writable.getWriter();
  const worker = new Worker(new URL('./native-transform.worker.ts', import.meta.url), {
    type: 'module',
  });
  let stopped = false;
  let started = false;
  let size = { width: 0, height: 0 };
  let encoderName = '';
  let sender: RTCRtpSender | null = null;
  let adaptTimer: ReturnType<typeof setInterval> | null = null;

  worker.onmessage = (event: MessageEvent) => {
    const message = event.data as { type: string };
    if (message.type === 'tick') {
      writePlaceholder();
    } else if (message.type === 'preview') {
      const { frame } = event.data as { frame: VideoFrame };
      // Decoded from exactly what is sent, so its size is the stream's.
      size = { width: frame.displayWidth, height: frame.displayHeight };
      // A preview that cannot keep up skips frames rather than queue them.
      if (stopped || (previewWriter.desiredSize ?? 1) <= 0) frame.close();
      else previewWriter.write(frame).catch(() => frame.close());
    } else if (message.type === 'keyframe') {
      void window.zoia.nativeVideo.requestKeyframe();
    }
  };

  // A worker that fails to load leaves the transform doing nothing, which
  // looks like a black broadcast rather than an error.
  worker.onerror = (event) => {
    console.error('[native-video] transform worker failed:', event.message);
    if (!stopped) onError(`The video transform failed: ${event.message}`);
  };

  // NVENC frames go from the main process straight to the worker over a
  // MessagePort (see nativePort in main/index.ts); only this small tick per
  // frame comes back through the page, to write the placeholder.
  const writePlaceholder = () => {
    if (stopped) return;
    const placeholder = new VideoFrame(PLACEHOLDER_PIXELS, {
      format: 'RGBA',
      codedWidth: PLACEHOLDER_SIZE,
      codedHeight: PLACEHOLDER_SIZE,
      timestamp: Math.round(performance.now() * 1000),
    });
    writer.write(placeholder).catch(() => placeholder.close());
  };
  const onPort = (event: MessageEvent) => {
    const data = event.data as { type?: string } | null;
    if (event.source !== window || data?.type !== 'zoia:native-video-port') return;
    const [port] = event.ports;
    if (port) worker.postMessage({ type: 'port' }, [port]);
  };
  window.addEventListener('message', onPort);
  const offError = window.zoia.nativeVideo.onError((message) => {
    if (!stopped) onError(message);
  });

  let attached = false;
  const attachTo = (target: RTCRtpSender) => {
    if (attached) return;
    attached = true;
    sender = target;
    target.transform = new RTCRtpScriptTransform(worker, { role: 'sender' });
  };

  /**
   * Fits the hardware encoder to Chromium's estimate of the uplink, once a
   * second (see adaptive-bitrate.ts). Chromium paces and retransmits what goes
   * out but cannot slow an encoder it does not own, so without this the
   * preset's bitrate went out whatever the link could carry.
   */
  const startAdapting = () => {
    const controller = createBitrateController(limitsFor(quality.maxBitrate));
    const startedAt = performance.now();
    let busy = false;
    adaptTimer = setInterval(() => {
      if (stopped || busy || !sender) return;
      busy = true;
      void sender
        .getStats()
        .then(async (report) => {
          let available: number | undefined;
          report.forEach((stat: CandidatePairStats) => {
            if (
              stat.type === 'candidate-pair' &&
              (stat.nominated || stat.state === 'succeeded') &&
              typeof stat.availableOutgoingBitrate === 'number'
            ) {
              available = stat.availableOutgoingBitrate;
            }
          });
          const current = controller.current;
          const next = controller.step(available, performance.now() - startedAt);
          if (next === current || stopped) return;
          await window.zoia.nativeVideo.setBitrate(next);
          console.log(
            `[native-video] bitrate ${(current / 1e6).toFixed(1)} -> ${(next / 1e6).toFixed(1)} Mbps ` +
              `(estimate ${((available ?? 0) / 1e6).toFixed(1)}, ceiling ${(controller.ceiling / 1e6).toFixed(1)})`,
          );
        })
        .catch((err: unknown) => {
          // An encoder that will not change rate keeps the preset's, as before.
          console.warn('[native-video] bitrate adaptation stopped:', err);
          if (adaptTimer) clearInterval(adaptTimer);
          adaptTimer = null;
        })
        .finally(() => {
          busy = false;
        });
    }, 1000);
  };

  // Chromium only runs frames through a sender's transform if it is set
  // before the connection negotiates that sender; set afterwards, it is
  // created but never fed, and the placeholder itself goes out. LiveKit
  // creates the sender inside publishTrack and negotiates straight after, so
  // the transform is attached at the moment the transceiver is added.
  const originalAddTransceiver = RTCPeerConnection.prototype.addTransceiver;
  const restoreAddTransceiver = () => {
    if (RTCPeerConnection.prototype.addTransceiver !== originalAddTransceiver) {
      RTCPeerConnection.prototype.addTransceiver = originalAddTransceiver;
    }
  };
  RTCPeerConnection.prototype.addTransceiver = function (
    this: RTCPeerConnection,
    trackOrKind: MediaStreamTrack | string,
    init?: RTCRtpTransceiverInit,
  ) {
    const transceiver = originalAddTransceiver.call(this, trackOrKind, init);
    if (trackOrKind === generator) {
      restoreAddTransceiver();
      attachTo(transceiver.sender);
    }
    return transceiver;
  };

  return {
    track: generator,
    preview: previewGenerator,
    attach(sender) {
      // Only if the sender was not created through addTransceiver above.
      restoreAddTransceiver();
      attachTo(sender);
    },
    size: () => size,
    encoder: () => encoderName,
    async start() {
      started = true;
      const info = await window.zoia.nativeVideo.start({
        hwnd: 'hwnd' in target ? target.hwnd : null,
        displayId: 'displayId' in target ? target.displayId : null,
        framerate: quality.maxFramerate,
        bitrate: quality.maxBitrate,
        maxWidth: quality.width,
        maxHeight: quality.height,
        showBorder: captureBorderEnabled(),
      });
      size = { width: info.width, height: info.height };
      encoderName = info.encoder;
      startAdapting();
      return size;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (adaptTimer) clearInterval(adaptTimer);
      adaptTimer = null;
      restoreAddTransceiver();
      window.removeEventListener('message', onPort);
      offError();
      if (started) await window.zoia.nativeVideo.stop().catch(() => {});
      await writer.close().catch(() => {});
      await previewWriter.close().catch(() => {});
      generator.stop();
      previewGenerator.stop();
      worker.terminate();
    },
  };
}
