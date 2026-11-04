import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MediaDeviceChoice } from '../livekit/useCamera';
import { useT } from '../i18n';

function IconCheck() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/**
 * Fast popup menu beside the mic or headset button in the sidebar footer
 * to switch the active input or output device without opening full settings.
 */
export default function QuickDeviceMenu({
  anchor,
  title,
  devices,
  selectedId,
  defaultLabel,
  onSelect,
  onOpenSettings,
  onClose,
}: {
  anchor: DOMRect;
  title: string;
  devices: readonly MediaDeviceChoice[];
  selectedId: string;
  defaultLabel: string;
  onSelect: (id: string) => void;
  onOpenSettings?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: anchor.left, top: anchor.top });

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(4, Math.min(anchor.right - box.width, window.innerWidth - box.width - 4));
    const top = Math.max(4, anchor.top - box.height - 6);
    setPlace({ left, top });
    ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [anchor]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const filtered = devices.filter((d) => d.deviceId !== 'default');
  const isDefaultSelected = !selectedId || selectedId === 'default';

  return createPortal(
    <div ref={ref} className="member-menu device-menu" role="menu" aria-label={title} style={place}>
      <div className="device-menu-header">{title}</div>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={isDefaultSelected}
        className={`device-menu-item${isDefaultSelected ? ' chosen' : ''}`}
        onClick={() => {
          onSelect('');
          onClose();
        }}
      >
        <span className="device-menu-label">{defaultLabel}</span>
        {isDefaultSelected && (
          <span className="device-menu-check">
            <IconCheck />
          </span>
        )}
      </button>

      {filtered.map((d) => {
        const isChosen = selectedId === d.deviceId;
        return (
          <button
            key={d.deviceId}
            type="button"
            role="menuitemradio"
            aria-checked={isChosen}
            className={`device-menu-item${isChosen ? ' chosen' : ''}`}
            onClick={() => {
              onSelect(d.deviceId);
              onClose();
            }}
          >
            <span className="device-menu-label">{d.label || d.deviceId}</span>
            {isChosen && (
              <span className="device-menu-check">
                <IconCheck />
              </span>
            )}
          </button>
        );
      })}

      {onOpenSettings && (
        <>
          <div className="device-menu-divider" />
          <button
            type="button"
            role="menuitem"
            className="device-menu-settings"
            onClick={() => {
              onOpenSettings();
              onClose();
            }}
          >
            {t('voiceSettings.voiceSettingsShortcut')}
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
