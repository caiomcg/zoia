/**
 * NVIDIA only: a window captured and encoded by NVENC in the native addon,
 * sent on the room's own WebRTC connection.
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
 * AMD and Intel stay on the ffmpeg route; macOS never gets here, because the
 * native addon is Windows-only.
 */

interface TrackGenerator extends MediaStreamTrack {
  writable: WritableStream<VideoFrame>;
}

declare const MediaStreamTrackGenerator: {
  new (init: { kind: 'video' }): TrackGenerator;
};

// The placeholder is never seen by anyone; it only has to be a valid frame.
const PLACEHOLDER_SIZE = 16;
const PLACEHOLDER_PIXELS = new Uint8Array(PLACEHOLDER_SIZE * PLACEHOLDER_SIZE * 4);

export interface NativeVideo {
  /** The placeholder track, to publish like any other video track. */
  track: MediaStreamTrack;
  /** Puts NVENC's frames in place of the placeholder's on this sender. */
  attach(sender: RTCRtpSender): void;
  /** Starts capture and encoding. Call after `attach`, so no frame goes out untransformed. */
  start(): Promise<{ width: number; height: number }>;
  stop(): Promise<void>;
}

export function createNativeVideo(
  hwnd: number,
  quality: { maxFramerate: number; maxBitrate: number; width: number; height: number },
  onError: (message: string) => void,
): NativeVideo {
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const writer = generator.writable.getWriter();
  const worker = new Worker(new URL('./native-transform.worker.ts', import.meta.url), {
    type: 'module',
  });
  let stopped = false;
  let started = false;

  worker.onmessage = (event: MessageEvent) => {
    const message = event.data as { type: string };
    if (message.type === 'tick') {
      writePlaceholder();
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
  const attachTo = (sender: RTCRtpSender) => {
    if (attached) return;
    attached = true;
    sender.transform = new RTCRtpScriptTransform(worker, { role: 'sender' });
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
    attach(sender) {
      // Only if the sender was not created through addTransceiver above.
      restoreAddTransceiver();
      attachTo(sender);
    },
    async start() {
      started = true;
      return window.zoia.nativeVideo.start({
        hwnd,
        framerate: quality.maxFramerate,
        bitrate: quality.maxBitrate,
        maxWidth: quality.width,
        maxHeight: quality.height,
      });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      restoreAddTransceiver();
      window.removeEventListener('message', onPort);
      offError();
      if (started) await window.zoia.nativeVideo.stop().catch(() => {});
      await writer.close().catch(() => {});
      generator.stop();
      worker.terminate();
    },
  };
}
