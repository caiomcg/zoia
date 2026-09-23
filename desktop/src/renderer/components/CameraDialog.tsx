import { useEffect, useRef, useState } from 'react';
import { useCameraDevices } from '../livekit/useCamera';

/**
 * Choosing a camera before sharing it.
 *
 * A camera turning itself on the moment a button is pressed is startling, and
 * gives no chance to check what it is pointed at or which microphone it will
 * use. The preview here is local only — nothing is published until the button
 * at the bottom is pressed.
 */
export default function CameraDialog({
  onStart,
  onCancel,
}: {
  onStart: (constraints: MediaStreamConstraints) => void;
  onCancel: () => void;
}) {
  const camera = useCameraDevices();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);

  const { cameraId, microphoneId } = camera;

  // Re-opened whenever the chosen device changes, so the preview always shows
  // what pressing the button would actually share.
  useEffect(() => {
    let cancelled = false;
    let context: AudioContext | null = null;
    let raf = 0;

    const stop = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (raf) cancelAnimationFrame(raf);
      void context?.close().catch(() => {});
    };

    (async () => {
      stop();
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: cameraId ? { deviceId: { exact: cameraId } } : true,
          audio: microphoneId ? { deviceId: { exact: microphoneId } } : true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;

        // A level meter answers "is this microphone the right one" without
        // having to broadcast first and ask someone.
        const [audio] = stream.getAudioTracks();
        if (audio) {
          context = new AudioContext();
          const analyser = context.createAnalyser();
          analyser.fftSize = 512;
          context.createMediaStreamSource(new MediaStream([audio])).connect(analyser);
          const samples = new Uint8Array(analyser.frequencyBinCount);

          const tick = () => {
            analyser.getByteTimeDomainData(samples);
            let peak = 0;
            for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128) / 128);
            setLevel(peak);
            raf = requestAnimationFrame(tick);
          };
          tick();
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [cameraId, microphoneId]);

  function start() {
    // The published stream is opened fresh by the room; this preview is
    // released so the device is not held twice.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    onStart(camera.constraints());
  }

  const segments = 14;
  const lit = Math.round(level * segments);

  return (
    <div className="picker-backdrop" onClick={onCancel}>
      <div className="camera-dialog" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Share your camera</h2>
        </header>

        <div className="camera-preview">
          <video ref={videoRef} autoPlay playsInline muted />
          {error && <p className="error">{error}</p>}
        </div>

        <div className="camera-controls">
          <label>
            <span className="muted">Camera</span>
            <select value={cameraId} onChange={(e) => camera.chooseCamera(e.target.value)}>
              <option value="">Default</option>
              {camera.devices.cameras.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="muted">Microphone</span>
            <select value={microphoneId} onChange={(e) => camera.chooseMicrophone(e.target.value)}>
              <option value="">Default</option>
              {camera.devices.microphones.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* On its own row under the pickers: the meter answers "is this the
            right microphone", which is a question about the choice just made
            above it, and it needs the width to be readable. */}
        <div className="camera-level">
          <span className="muted">Microphone level</span>
          <div className="level-meter" title="Microphone level">
            {Array.from({ length: segments }, (_, i) => (
              <span key={i} className={`level-seg${i < lit ? ' on' : ''}`} />
            ))}
          </div>
        </div>

        <footer>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={start} disabled={Boolean(error)}>
            Share camera
          </button>
        </footer>
      </div>
    </div>
  );
}
