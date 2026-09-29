import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { AvatarCrop } from '../avatars';
import { tNow, useT } from '../i18n';

/** The circle's diameter on screen; the stage around it shows what is cut off. */
const VIEW = 240;
const STAGE = 300;
const MAX_ZOOM = 4;
const STEP = 10;
/** The sizes an avatar is actually shown at: the profile, and the lists. */
const PREVIEW_SIZES = [56, 30];

interface Offset {
  x: number;
  y: number;
}

/**
 * Frames a picked picture before it is published: drag it inside the circle,
 * zoom in or out, and see it at the sizes other people will see it. Nothing
 * is uploaded until Save; Cancel leaves the current picture as it was.
 *
 * Rendered into the body: the settings panel animates with a transform,
 * which would otherwise pin this fixed backdrop inside the panel.
 */
export default function AvatarCropDialog({
  file,
  onCancel,
  onSave,
  closing = false,
}: {
  file: File;
  onCancel: () => void;
  onSave: (crop: AvatarCrop) => Promise<void>;
  closing?: boolean;
}) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoomState] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Read as a data: URL, not a blob: one: the page's CSP allows data: images
  // and nothing else from outside, and a blob: picture is simply blocked.
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setNatural(null);
    setZoomState(1);
    setOffset({ x: 0, y: 0 });
    const reader = new FileReader();
    reader.onload = () => {
      if (!cancelled && typeof reader.result === 'string') setUrl(reader.result);
    };
    reader.onerror = () => {
      if (!cancelled) setError(tNow('crop.unreadable'));
    };
    reader.readAsDataURL(file);
    return () => {
      cancelled = true;
      reader.abort();
    };
  }, [file]);

  // Escape cancels here, before it can reach whatever is behind.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return;
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel, busy]);

  // Pixels on screen per pixel of the picture. At zoom 1 its short side just
  // fills the circle, so there is never an empty edge to frame.
  const scale = natural ? (VIEW / Math.min(natural.w, natural.h)) * zoom : 1;

  /** Keeps the picture covering the circle, whatever was asked for. */
  function clamp(next: Offset, s: number): Offset {
    if (!natural) return next;
    const maxX = Math.max(0, (natural.w * s - VIEW) / 2);
    const maxY = Math.max(0, (natural.h * s - VIEW) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }

  /** Zooms about the circle's centre, so what is in the middle stays there. */
  function setZoom(next: number) {
    if (!natural) return;
    const z = Math.min(MAX_ZOOM, Math.max(1, next));
    const s = (VIEW / Math.min(natural.w, natural.h)) * z;
    setOffset((current) => clamp({ x: current.x * (z / zoom), y: current.y * (z / zoom) }, s));
    setZoomState(z);
  }

  function move(dx: number, dy: number) {
    setOffset((current) => clamp({ x: current.x + dx, y: current.y + dy }, scale));
  }

  /** The square of the picture the circle frames, in the picture's pixels. */
  function crop(): AvatarCrop | null {
    if (!natural) return null;
    const size = Math.min(VIEW / scale, natural.w, natural.h);
    const x = natural.w / 2 - offset.x / scale - size / 2;
    const y = natural.h / 2 - offset.y / scale - size / 2;
    return {
      x: Math.min(natural.w - size, Math.max(0, x)),
      y: Math.min(natural.h - size, Math.max(0, y)),
      size,
    };
  }

  /** Where the picture sits in a box `box` wide, whose circle is `circle` wide. */
  function placement(box: number, circle: number): CSSProperties {
    if (!natural) return { visibility: 'hidden' };
    const k = circle / VIEW;
    const w = natural.w * scale * k;
    const h = natural.h * scale * k;
    return {
      width: w,
      height: h,
      left: box / 2 + offset.x * k - w / 2,
      top: box / 2 + offset.y * k - h / 2,
    };
  }

  async function save() {
    const area = crop();
    if (!area) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(area);
    } catch {
      setError(t('profile.pictureFailed'));
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className={`picker-backdrop crop-backdrop${closing ? ' closing' : ''}`}
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <section
        className="picker crop-dialog"
        role="dialog"
        aria-label={t('crop.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2>{t('crop.title')}</h2>
          <p className="muted">{t('crop.hint')}</p>
        </header>

        <div className="crop-body">
          <div
            className={`crop-stage${dragging ? ' dragging' : ''}`}
            style={{ width: STAGE, height: STAGE }}
            tabIndex={0}
            role="group"
            aria-label={t('crop.stage')}
            onPointerDown={(event) => {
              // Click, hold and drag: the left button only, so a right click
              // does not start moving the picture.
              if (!natural || busy || event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
              setDragging(true);
            }}
            onPointerMove={(event) => {
              const last = drag.current;
              if (!last || last.id !== event.pointerId) return;
              drag.current = { id: last.id, x: event.clientX, y: event.clientY };
              move(event.clientX - last.x, event.clientY - last.y);
            }}
            onPointerUp={() => {
              drag.current = null;
              setDragging(false);
            }}
            onPointerCancel={() => {
              drag.current = null;
              setDragging(false);
            }}
            onWheel={(event) => setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1))}
            onKeyDown={(event) => {
              const keys: Record<string, () => void> = {
                ArrowLeft: () => move(-STEP, 0),
                ArrowRight: () => move(STEP, 0),
                ArrowUp: () => move(0, -STEP),
                ArrowDown: () => move(0, STEP),
                '+': () => setZoom(zoom * 1.1),
                '=': () => setZoom(zoom * 1.1),
                '-': () => setZoom(zoom / 1.1),
              };
              const action = keys[event.key];
              if (!action) return;
              event.preventDefault();
              action();
            }}
          >
            {url && (
              <img
                src={url}
                alt=""
                draggable={false}
                style={placement(STAGE, VIEW)}
                onLoad={(event) =>
                  setNatural({
                    w: event.currentTarget.naturalWidth,
                    h: event.currentTarget.naturalHeight,
                  })
                }
                onError={() => setError(t('crop.unreadable'))}
              />
            )}
            <span className="crop-mask" style={{ width: VIEW, height: VIEW }} aria-hidden="true" />
          </div>

          <div className="crop-side">
            <span className="crop-side-label">{t('crop.preview')}</span>
            <div className="crop-previews">
              {PREVIEW_SIZES.map((size) => (
                <span key={size} className="crop-preview" style={{ width: size, height: size }}>
                  {url && <img src={url} alt="" draggable={false} style={placement(size, size)} />}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="crop-zoom">
          <button
            type="button"
            className="icon-button"
            onClick={() => setZoom(zoom / 1.2)}
            disabled={!natural || busy || zoom <= 1}
            aria-label={t('crop.zoomOut')}
            title={t('crop.zoomOut')}
          >
            −
          </button>
          <input
            type="range"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            disabled={!natural || busy}
            onChange={(event) => setZoom(Number(event.target.value))}
            aria-label={t('crop.zoom')}
          />
          <button
            type="button"
            className="icon-button"
            onClick={() => setZoom(zoom * 1.2)}
            disabled={!natural || busy || zoom >= MAX_ZOOM}
            aria-label={t('crop.zoomIn')}
            title={t('crop.zoomIn')}
          >
            +
          </button>
        </div>

        {error && <p className="settings-error crop-error">{error}</p>}

        <footer>
          <button type="button" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void save()}
            disabled={!natural || busy}
          >
            {busy ? t('crop.saving') : t('crop.save')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
