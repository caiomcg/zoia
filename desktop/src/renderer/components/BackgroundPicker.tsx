import { useRef, useState, type CSSProperties } from 'react';
import {
  CUSTOM_IMAGE,
  CUSTOM_IMAGE_KEY,
  NO_BACKGROUND,
  PRESETS,
  sameBackground,
  type CameraBackground,
} from '../livekit/camera-background';
import {
  backgroundEffectsSupported,
  customImage,
  presetImage,
  readBackgroundFile,
} from '../livekit/background-effect';
import { useT, type T } from '../i18n';
import type { MessageKey } from '../../shared/i18n';

/** What a background is called, as the picker's buttons name it. */
export function backgroundLabel(t: T, background: CameraBackground): string {
  if (background.kind === 'blur') {
    return t(background.strength === 'light' ? 'camera.bgBlurLight' : 'camera.bgBlurStrong');
  }
  if (background.kind === 'image') {
    return background.image === CUSTOM_IMAGE
      ? t('camera.bgYourImage')
      : t(`camera.bgPreset.${background.image}` as MessageKey);
  }
  return t('camera.bgNone');
}

/**
 * The camera's background choices (ADR 0053): none, two blurs, the pictures
 * that come with Zoia and one of your own, with the button to upload it. The
 * same in the camera dialog, before going live, and in the camera card's
 * menu, while live.
 */
export default function BackgroundPicker({
  value,
  onChange,
  error = null,
}: {
  value: CameraBackground;
  onChange: (background: CameraBackground) => void;
  /** The effect failed to start, as the caller found out. */
  error?: string | null;
}) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [supported] = useState(backgroundEffectsSupported);
  const [custom, setCustom] = useState(customImage);
  const [uploadError, setUploadError] = useState<string | null>(null);

  if (!supported) return <p className="muted camera-bg-hint">{t('camera.bgUnsupported')}</p>;

  async function upload(file: File | undefined) {
    if (!file) return;
    let url: string;
    try {
      url = await readBackgroundFile(file);
    } catch {
      setUploadError(t('camera.bgBadFile'));
      return;
    }
    try {
      localStorage.setItem(CUSTOM_IMAGE_KEY, url);
    } catch {
      setUploadError(t('camera.bgTooBig'));
      return;
    }
    setCustom(url);
    setUploadError(null);
    // Told even if it was already chosen: the picture behind it is new.
    onChange({ kind: 'image', image: CUSTOM_IMAGE });
  }

  const option = (key: string, background: CameraBackground, swatch: SwatchProps) => {
    const selected = sameBackground(background, value);
    const label = backgroundLabel(t, background);
    return (
      <button
        key={key}
        type="button"
        className={`camera-bg-option${selected ? ' selected' : ''}`}
        aria-pressed={selected}
        title={label}
        onClick={() => {
          setUploadError(null);
          if (!selected) onChange(background);
        }}
      >
        <span
          className={`camera-bg-swatch ${swatch.className ?? ''}`}
          style={swatch.style}
          aria-hidden="true"
        />
        <span className="camera-bg-label">{label}</span>
      </button>
    );
  };

  const shown = uploadError ?? error;

  return (
    <>
      <div className="camera-bg-options" role="group" aria-label={t('camera.background')}>
        {option('none', NO_BACKGROUND, { className: 'none' })}
        {option('light', { kind: 'blur', strength: 'light' }, { className: 'blur light' })}
        {option('strong', { kind: 'blur', strength: 'strong' }, { className: 'blur strong' })}
        {PRESETS.map((preset) =>
          option(
            preset.id,
            { kind: 'image', image: preset.id },
            { style: { backgroundImage: `url(${presetImage(preset.id) ?? ''})` } },
          ),
        )}
        {custom &&
          option(
            CUSTOM_IMAGE,
            { kind: 'image', image: CUSTOM_IMAGE },
            { style: { backgroundImage: `url(${custom})` } },
          )}
      </div>
      <div className="camera-bg-upload">
        <button type="button" onClick={() => fileRef.current?.click()}>
          {custom ? t('camera.bgReplace') : t('camera.bgUpload')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {shown ? (
        <p className="error">{shown}</p>
      ) : (
        <p className="muted camera-bg-hint">{t('camera.bgHint')}</p>
      )}
    </>
  );
}

interface SwatchProps {
  className?: string;
  style?: CSSProperties;
}
