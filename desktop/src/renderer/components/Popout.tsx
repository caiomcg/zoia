import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RemoteTrack } from 'livekit-client';
import { IconVolume } from './Player';
import { useT } from '../i18n';

/** Must start with the main process's PIP_FRAME_PREFIX, which allows it. */
const FRAME_PREFIX = 'zoia-pip';

/** Only one player at a time: opening another closes this one. */
let closeCurrent: (() => void) | null = null;

/**
 * A picture-in-picture player of our own. Electron has no Document
 * Picture-in-Picture, and Chromium's video PiP offers only play and "back to
 * tab": no volume. So this opens a blank, same-origin window that the main
 * process makes small, frameless and always on top, copies the app's styles
 * into it, and lets the caller render into its body with a portal. The
 * window shares this renderer, so a MediaStream can be shown there directly.
 */
export function usePopout() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const windowRef = useRef<Window | null>(null);

  function close() {
    windowRef.current?.close();
    windowRef.current = null;
    setTarget(null);
  }

  function open() {
    closeCurrent?.();
    const child = window.open('about:blank', `${FRAME_PREFIX}-${Date.now()}`);
    if (!child) return;
    windowRef.current = child;

    const doc = child.document;
    doc.title = document.title;
    for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      const copy = doc.importNode(node, true);
      // An imported link keeps its attribute; make the address absolute so it
      // does not depend on the blank page's base URL.
      if (copy instanceof HTMLLinkElement && node instanceof HTMLLinkElement) copy.href = node.href;
      doc.head.appendChild(copy);
    }
    doc.body.className = 'pip-body';

    // Closed from its own button, Alt+F4 or the main window going away.
    const watch = setInterval(() => {
      if (!child.closed) return;
      clearInterval(watch);
      if (windowRef.current === child) {
        windowRef.current = null;
        setTarget(null);
      }
    }, 250);

    closeCurrent = close;
    setTarget(doc.body);
  }

  // The broadcast stopped being watched, or ended: no player for nothing.
  useEffect(
    () => () => {
      windowRef.current?.close();
      windowRef.current = null;
    },
    [],
  );

  return {
    active: target !== null,
    target,
    toggle: () => (target ? close() : open()),
    close,
  };
}

export function PopoutPlayer({
  target,
  name,
  videoTrack,
  hasAudio,
  volume,
  muted,
  onAudioChange,
  onClose,
}: {
  target: HTMLElement;
  name: string;
  videoTrack: RemoteTrack | null;
  hasAudio: boolean;
  volume: number;
  muted: boolean;
  onAudioChange: (next: { volume: number; muted: boolean }) => void;
  onClose: () => void;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);

  // Picture only, and muted: the sound keeps coming from the tile in the
  // main window, which these controls drive, so it is never heard twice.
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.srcObject = videoTrack ? new MediaStream([videoTrack.mediaStreamTrack]) : null;
    void element.play().catch(() => {});
    return () => {
      element.srcObject = null;
    };
  }, [videoTrack]);

  return createPortal(
    <div className="pip-player">
      <video ref={videoRef} playsInline autoPlay muted />
      <div className="pip-drag" />
      <button
        className="icon-button pip-close"
        onClick={onClose}
        title={t('common.exitPip')}
        aria-label={t('common.exitPip')}
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      <div className="pip-controls">
        <span className="pip-name">{name}</span>
        {hasAudio && (
          <>
            <button
              className="icon-button"
              onClick={() =>
                onAudioChange({ volume: muted && volume === 0 ? 1 : volume, muted: !muted })
              }
              title={muted ? t('common.unmute') : t('common.mute')}
              aria-label={muted ? t('common.unmute') : t('common.mute')}
            >
              <IconVolume muted={muted || volume === 0} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(event) => {
                const value = Number(event.target.value);
                onAudioChange({ volume: value, muted: value === 0 });
              }}
              className="remote-volume"
              aria-label={t('grid.volumeFor', { name })}
            />
          </>
        )}
      </div>
    </div>,
    target,
  );
}
