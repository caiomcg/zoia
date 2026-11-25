import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCameraDevices } from '../livekit/useCamera';
import type { CameraBackground } from '../livekit/camera-background';
import BackgroundPicker, { backgroundLabel } from './BackgroundPicker';
import { useT } from '../i18n';

/** Your screen share, for its row in the live card. */
export interface SidebarLive {
  /** The window or screen's name, when known. */
  source: string | null;
  /** When it went live, in ms since the epoch; kept across a switch. */
  since: number | null;
  watching: number;
  onStop: () => void;
  onSwitch: () => void;
}

/** Your camera while it is on, for its row in the live card. */
export interface SidebarCamera {
  /** When it went on, in ms since the epoch. */
  since: number;
  deviceId: string | null;
  background: CameraBackground;
  onStop: () => void;
  onBackground: (background: CameraBackground) => void;
  onDevice: (deviceId: string) => void;
}

/**
 * What you are sharing, said in words, in one card above the share buttons:
 * since when, who is watching, and a row each for the screen and the camera,
 * with the buttons that stop or change that one alone (ADR 0034 keeps them
 * apart). Both on, a last button stops everything. Stopping is never more
 * than one obvious click away. The camera's settings menu changes its
 * background and device without turning it off (ADR 0053).
 */
export default function LiveCard({
  screen,
  camera,
  onStopAll,
}: {
  screen: SidebarLive | null;
  camera: SidebarCamera | null;
  onStopAll: () => void;
}) {
  const t = useT();
  const since = earliest(screen?.since ?? null, camera?.since ?? null);
  const now = useClock(since);
  if (!screen && !camera) return null;

  return (
    <section className="live-card" aria-label={t('player.youreLive')}>
      <div className="live-card-head">
        <span className="live-card-dot" aria-hidden="true" />
        <span className="live-card-title">{t('player.youreLive')}</span>
        {since !== null && <span className="live-card-time">{elapsed(now - since)}</span>}
      </div>
      {/* Who is watching is known for the screen: viewers name it, not the camera. */}
      {screen && (
        <span className="live-card-watching">
          {screen.watching === 0
            ? t('live.watchingNone')
            : screen.watching === 1
              ? t('live.watchingOne')
              : t('live.watching', { count: screen.watching })}
        </span>
      )}

      {screen && (
        <div className="live-card-row">
          <IconScreen />
          <span className="live-card-row-text">
            <b>{t('live.screenRow')}</b>
            <span className="live-card-source" title={screen.source ?? undefined}>
              {screen.source ?? t('live.screen')}
            </span>
          </span>
          <button
            className="icon-button live-card-switch"
            onClick={screen.onSwitch}
            title={t('player.switchTitle')}
            aria-label={t('player.switch')}
          >
            <IconSwitchArrows />
          </button>
          <button
            className="icon-button live-card-stop square"
            onClick={screen.onStop}
            title={t('live.stopScreen')}
            aria-label={t('live.stopScreen')}
          >
            <IconStopSquare />
          </button>
        </div>
      )}

      {camera && <CameraRow camera={camera} />}

      {screen && camera && (
        <button className="live-card-stop-all" onClick={onStopAll}>
          <IconStopSquare />
          {t('live.stopAll')}
        </button>
      )}
    </section>
  );
}

function CameraRow({ camera }: { camera: SidebarCamera }) {
  const t = useT();
  const devices = useCameraDevices();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const device = devices.devices.cameras.find((c) => c.deviceId === camera.deviceId);
  const detail = [device?.label, backgroundLabel(t, camera.background)].filter(Boolean).join(' · ');

  return (
    <div className="live-card-row">
      <IconCamera />
      <span className="live-card-row-text">
        <b>{t('camera.camera')}</b>
        <span className="live-card-source" title={detail}>
          {detail}
        </span>
      </span>
      <button
        className={`icon-button live-card-switch camera-card-settings${anchor ? ' active' : ''}`}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget.getBoundingClientRect())}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        title={t('camera.settings')}
        aria-label={t('camera.settings')}
      >
        <IconGear />
      </button>
      <button
        className="icon-button live-card-stop square"
        onClick={camera.onStop}
        title={t('camera.stop')}
        aria-label={t('camera.stop')}
      >
        <IconStopSquare />
      </button>
      {anchor && (
        <CameraMenu
          camera={camera}
          anchor={anchor}
          cameras={devices.devices.cameras}
          onDevice={(id) => {
            // Remembered, so the dialog offers it next time too.
            devices.chooseCamera(id);
            camera.onDevice(id);
          }}
          onClose={() => setAnchor(null)}
        />
      )}
    </div>
  );
}

function CameraMenu({
  camera,
  anchor,
  cameras,
  onDevice,
  onClose,
}: {
  camera: SidebarCamera;
  anchor: DOMRect;
  cameras: { deviceId: string; label: string }[];
  onDevice: (deviceId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      const target = event.target as Element;
      if (!ref.current?.contains(target) && !target.closest?.('.camera-card-settings')) onClose();
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [onClose]);

  // Beside the sidebar, its bottom level with the button, kept on screen.
  const style = {
    left: Math.min(anchor.right + 10, window.innerWidth - 340),
    bottom: Math.max(8, window.innerHeight - anchor.bottom),
  };

  return createPortal(
    <div
      ref={ref}
      className="camera-menu"
      role="dialog"
      aria-label={t('camera.settings')}
      style={style}
    >
      <header>
        <b>{t('camera.settings')}</b>
      </header>
      {cameras.length > 1 && (
        <div className="camera-menu-section">
          <span className="muted">{t('camera.camera')}</span>
          <div className="camera-menu-devices" role="radiogroup" aria-label={t('camera.camera')}>
            {cameras.map((c) => {
              const selected = c.deviceId === camera.deviceId;
              return (
                <button
                  key={c.deviceId}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`camera-menu-device${selected ? ' selected' : ''}`}
                  onClick={() => !selected && onDevice(c.deviceId)}
                >
                  <span className="camera-menu-radio" aria-hidden="true" />
                  <span className="camera-menu-device-name">{c.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="camera-menu-section camera-bg">
        <span className="muted">{t('camera.background')}</span>
        <BackgroundPicker value={camera.background} onChange={camera.onBackground} />
      </div>
    </div>,
    document.body,
  );
}

function earliest(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** Re-renders once a second while `since` is set, for the card's running clock. */
function useClock(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return now;
}

/** "1:05" or "1:02:05": how long you have been live. */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function IconScreen() {
  return (
    <svg
      className="live-card-row-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      {...stroke}
    >
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

function IconCamera() {
  return (
    <svg
      className="live-card-row-icon"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      {...stroke}
    >
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M16 10l6-3v10l-6-3" />
    </svg>
  );
}

function IconStopSquare() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" />
    </svg>
  );
}

/** Two arrows passing: one thing for another. */
function IconSwitchArrows() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" {...stroke}>
      <path d="M4 7h13l-3-3M20 17H7l3 3" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </svg>
  );
}
