/**
 * Runs on the sending side of the room's WebRTC connection and puts NVENC's
 * frames on the wire in place of the placeholder track's.
 *
 * native-video.ts writes one tiny placeholder frame for every frame NVENC
 * produces, and posts that NVENC frame here first. Chromium encodes the
 * placeholder (a few bytes, negligible work) and hands the encoded frame to
 * this transform, which swaps its payload for the queued NVENC frame. The two
 * streams therefore line up one to one, and everything after this point —
 * packetizing, pacing, retransmission, bandwidth estimation, and syncing with
 * the audio track — is Chromium's own WebRTC stack doing what it always does.
 */

interface EncodedFrame {
  data: ArrayBuffer;
  type?: 'key' | 'delta' | 'empty';
}

interface RtcTransformer {
  readable: ReadableStream<EncodedFrame>;
  writable: WritableStream<EncodedFrame>;
  onkeyframerequest?: (() => void) | null;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  onrtctransform: ((event: { transformer: RtcTransformer }) => void) | null;
  postMessage(message: unknown): void;
}

const scope = self as unknown as WorkerScope;

// NVENC frames waiting for their placeholder. Normally one deep: the frame is
// posted here just before its placeholder is written.
const queue: ArrayBuffer[] = [];
// After frames had to be thrown away, everything until the next keyframe
// would decode against the wrong picture, so nothing is sent until one comes.
let awaitingKeyframe = false;

function requestKeyframe(): void {
  scope.postMessage({ type: 'keyframe' });
}

function onFrame(message: { data: Uint8Array; keyframe: boolean }): void {
  if (awaitingKeyframe && !message.keyframe) return;
  if (message.keyframe) awaitingKeyframe = false;
  const { data } = message;
  queue.push(
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? (data.buffer as ArrayBuffer)
      : (data.slice().buffer as ArrayBuffer),
  );
  // The page writes one placeholder per frame queued here.
  scope.postMessage({ type: 'tick' });

  // The placeholders fell behind, which means Chromium dropped some. Sending
  // a growing backlog would only add latency, so start again from a keyframe.
  if (queue.length > 4) {
    queue.length = 0;
    awaitingKeyframe = true;
    requestKeyframe();
  }
}

scope.onmessage = (event: MessageEvent) => {
  const message = event.data as { type: string };
  // The channel NVENC frames arrive on, straight from the main process.
  if (message.type === 'port' && event.ports[0]) {
    event.ports[0].onmessage = (frame: MessageEvent) =>
      onFrame(frame.data as { data: Uint8Array; keyframe: boolean });
  }
};

scope.onrtctransform = (event) => {
  const { transformer } = event;
  // A viewer lost packets or just joined and needs a picture to start from.
  transformer.onkeyframerequest = () => requestKeyframe();

  void transformer.readable
    .pipeThrough(
      new TransformStream<EncodedFrame, EncodedFrame>({
        transform(frame, controller) {
          const next = queue.shift();
          if (!next) {
            // A placeholder with no NVENC frame behind it: send nothing.
            return;
          }
          // Chromium made the placeholder a keyframe because a viewer asked
          // for one; ask NVENC for the real thing.
          if (frame.type === 'key') requestKeyframe();
          frame.data = next;
          controller.enqueue(frame);
        },
      }),
    )
    .pipeTo(transformer.writable);
};
