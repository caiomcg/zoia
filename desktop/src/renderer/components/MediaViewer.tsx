import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { chatMediaUrl, type ChatAttachment } from '../../shared/ipc';
import { FIT, clamp, clickScale, fitted, zoomAt, type Size, type View } from '../chat/zoom';
import { useT } from '../i18n';

/** Moving less than this between press and release is a click, not a drag. */
const CLICK_SLOP_PX = 4;

/**
 * A chat photo or video on the whole window, fitted to it. A photo zooms in
 * where it is clicked and back out on the next click; zoomed, it is dragged
 * around, and the wheel zooms about the pointer. Download saves the file
 * where you choose. Escape, the ×, or a click beside the picture closes it.
 */
export default function MediaViewer({
  chatId,
  attachment,
  onClose,
}: {
  chatId: string;
  attachment: ChatAttachment;
  onClose: () => void;
}) {
  const t = useT();
  const src = chatMediaUrl(chatId, attachment.id);
  const isVideo = attachment.kind === 'video';
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<Size>({ width: 0, height: 0 });
  const [view, setView] = useState<View>(FIT);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Where a press started, and the view then: a drag moves from there.
  const press = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const measure = () => setStage({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = fitted(natural, stage);
  const zoomed = view.scale > 1;

  // The window resized: what was in reach may not be.
  useEffect(() => {
    setView((v) => clamp(v, shown, stage));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.width, stage.height]);

  /** A pointer's place relative to the stage's centre. */
  function fromCentre(clientX: number, clientY: number) {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }

  /** On the picture itself, as it is drawn now. */
  function onPicture(clientX: number, clientY: number) {
    const p = fromCentre(clientX, clientY);
    const halfW = (shown.width * view.scale) / 2;
    const halfH = (shown.height * view.scale) / 2;
    return Math.abs(p.x - view.x) <= halfW && Math.abs(p.y - view.y) <= halfH;
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (isVideo || event.button !== 0) return;
    press.current = { x: event.clientX, y: event.clientY, view, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = press.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < CLICK_SLOP_PX) return;
    start.moved = true;
    if (!zoomed) return;
    setDragging(true);
    setView(clamp({ ...start.view, x: start.view.x + dx, y: start.view.y + dy }, shown, stage));
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = press.current;
    press.current = null;
    setDragging(false);
    if (!start || start.moved) return;
    if (zoomed) {
      setView(FIT);
    } else if (onPicture(event.clientX, event.clientY)) {
      const at = fromCentre(event.clientX, event.clientY);
      setView(zoomAt(view, clickScale(natural, shown), at, shown, stage));
    } else {
      onClose();
    }
  }

  function onWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (isVideo || shown.width === 0) return;
    const at = fromCentre(event.clientX, event.clientY);
    setView((v) => zoomAt(v, v.scale * Math.exp(-event.deltaY * 0.0015), at, shown, stage));
  }

  async function download() {
    setSaving(true);
    setError(null);
    const result = await window.zoia.chat.saveMedia(
      chatId,
      attachment.id,
      attachment.name,
      attachment.type,
    );
    setSaving(false);
    if (!result.ok) setError(t('chat.viewer.saveFailed'));
  }

  const cursor = isVideo ? 'default' : dragging ? 'grabbing' : zoomed ? 'grab' : 'zoom-in';

  return createPortal(
    <div
      className="media-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={attachment.name ?? t(isVideo ? 'chat.video' : 'chat.photo')}
    >
      <header className="media-viewer-bar">
        <span className="media-viewer-name">
          {attachment.name ?? t(isVideo ? 'chat.video' : 'chat.photo')}
        </span>
        {!isVideo && (
          <span className="media-viewer-hint">
            {t(zoomed ? 'chat.viewer.hintZoomed' : 'chat.viewer.hint')}
          </span>
        )}
        {error && <span className="media-viewer-error">{error}</span>}
        <button
          type="button"
          className="media-viewer-button"
          onClick={() => void download()}
          disabled={saving}
        >
          <IconDownload />
          {saving ? t('chat.viewer.saving') : t('chat.viewer.download')}
        </button>
        <button
          type="button"
          className="media-viewer-button icon"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          ×
        </button>
      </header>
      <div
        className="media-viewer-stage"
        ref={stageRef}
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          press.current = null;
          setDragging(false);
        }}
        onWheel={onWheel}
        onClick={isVideo ? (event) => event.target === event.currentTarget && onClose() : undefined}
      >
        {isVideo ? (
          <video className="media-viewer-video" src={src} controls autoPlay />
        ) : (
          <img
            className="media-viewer-image"
            src={src}
            alt={attachment.name ?? t('chat.photo')}
            draggable={false}
            onLoad={(event) =>
              setNatural({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            style={{
              width: shown.width || undefined,
              height: shown.height || undefined,
              visibility: shown.width ? 'visible' : 'hidden',
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              transition: dragging ? 'none' : undefined,
            }}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

/** An arrow down into a tray: save this. */
function IconDownload() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 4v11" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}
