import { useEffect, useRef, useState } from 'react';
import { useCameraDevices } from '../livekit/useCamera';
import { useT } from '../i18n';

/**
 * Choosing a camera before sharing it.
 *
 * A camera turning itself on the moment a button is pressed is startling, and
 * gives no chance to check what it is pointed at. The preview here is local
 * only — nothing is published until the button at the bottom is pressed. It
 * is a picture only: your voice goes out through voice (ADR 0039).
 */
export default function CameraDialog({
  onStart,
  onCancel,
  closing = false,
}: {
  onStart: (constraints: MediaStreamConstraints) => void;
  onCancel: () => void;
  /** Fading out: it stays on screen for that, and ignores clicks. */
  closing?: boolean;
}) {
  const t = useT();
  const camera = useCameraDevices();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { cameraId } = camera;

  // Re-opened whenever the chosen device changes, so the preview always shows
  // what pressing the button would actually share.
  useEffect(() => {
    let cancelled = false;

    const stop = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };

    (async () => {
      stop();
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: cameraId ? { deviceId: { exact: cameraId } } : true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [cameraId]);

  function start() {
    // The published stream is opened fresh by the room; this preview is
    // released so the device is not held twice.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    onStart(camera.constraints());
  }

  return (
    <div className={`picker-backdrop${closing ? ' closing' : ''}`} onClick={onCancel}>
      <div className="camera-dialog" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{t('camera.title')}</h2>
        </header>

        <div className="camera-preview">
          <video ref={videoRef} autoPlay playsInline muted />
          {error && <p className="error">{error}</p>}
        </div>

        <div className="camera-controls">
          <label>
            <span className="muted">{t('camera.camera')}</span>
            <select value={cameraId} onChange={(e) => camera.chooseCamera(e.target.value)}>
              <option value="">{t('common.default')}</option>
              {camera.devices.cameras.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <footer>
          <button onClick={onCancel}>{t('common.cancel')}</button>
          <button className="primary" onClick={start} disabled={Boolean(error)}>
            {t('camera.share')}
          </button>
        </footer>
      </div>
    </div>
  );
}
