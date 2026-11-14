import { useEffect, useRef, useState } from 'react';
import { LocalVideoTrack } from 'livekit-client';
import { useCameraDevices } from '../livekit/useCamera';
import { NO_BACKGROUND, type CameraBackground } from '../livekit/camera-background';
import {
  applyBackground,
  backgroundEffectsSupported,
  rememberBackground,
  rememberedBackground,
} from '../livekit/background-effect';
import BackgroundPicker from './BackgroundPicker';
import { useT } from '../i18n';

/**
 * Choosing a camera before sharing it.
 *
 * A camera turning itself on the moment a button is pressed is startling, and
 * gives no chance to check what it is pointed at. The preview here is local
 * only — nothing is published until the button at the bottom is pressed. It
 * is a picture only: your voice goes out through voice (ADR 0039).
 *
 * The background is chosen here too (ADR 0053), and the preview shows it as
 * viewers will see it, so nothing behind you goes out by surprise.
 */
export default function CameraDialog({
  onStart,
  onCancel,
  closing = false,
}: {
  onStart: (constraints: MediaStreamConstraints, background: CameraBackground) => void;
  onCancel: () => void;
  /** Fading out: it stays on screen for that, and ignores clicks. */
  closing?: boolean;
}) {
  const t = useT();
  const camera = useCameraDevices();
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<LocalVideoTrack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [background, setBackground] = useState<CameraBackground>(() =>
    backgroundEffectsSupported() ? rememberedBackground() : NO_BACKGROUND,
  );
  const backgroundRef = useRef(background);
  backgroundRef.current = background;
  const [backgroundError, setBackgroundError] = useState<string | null>(null);

  const { cameraId } = camera;

  // Re-opened whenever the chosen device changes, so the preview always shows
  // what pressing the button would actually share.
  useEffect(() => {
    let cancelled = false;

    const stop = () => {
      const track = trackRef.current;
      trackRef.current = null;
      if (!track) return;
      void track.stopProcessor().catch(() => {});
      track.detach();
      track.mediaStreamTrack.stop();
    };

    (async () => {
      stop();
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: cameraId ? { deviceId: { exact: cameraId } } : true,
        });
        const [videoTrack] = stream.getVideoTracks();
        if (cancelled || !videoTrack) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        // A LiveKit track, though nothing is published: it is what runs the
        // background effect, and shows its result on whatever it is attached to.
        const track = new LocalVideoTrack(videoTrack, undefined, false);
        trackRef.current = track;
        if (videoRef.current) track.attach(videoRef.current);
        await applyBackground(track, backgroundRef.current).catch(() => {
          if (!cancelled) setBackgroundError(t('camera.backgroundFailed'));
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
    // t is stable for a language; a language change does not reopen the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId]);

  function choose(next: CameraBackground) {
    setBackground(next);
    setBackgroundError(null);
    const track = trackRef.current;
    if (track) {
      void applyBackground(track, next).catch(() =>
        setBackgroundError(t('camera.backgroundFailed')),
      );
    }
  }

  function start() {
    rememberBackground(background);
    // The published stream is opened fresh by the room; this preview is
    // released so the device is not held twice.
    const track = trackRef.current;
    trackRef.current = null;
    if (track) {
      void track.stopProcessor().catch(() => {});
      track.detach();
      track.mediaStreamTrack.stop();
    }
    onStart(camera.constraints(), background);
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

          <div className="camera-bg">
            <span className="muted">{t('camera.background')}</span>
            <BackgroundPicker value={background} onChange={choose} error={backgroundError} />
          </div>
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
