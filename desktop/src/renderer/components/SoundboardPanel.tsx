import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Sound, SoundPage } from '../../shared/soundboard';
import {
  shortcutSound,
  soundShortcut,
  type ShortcutsState,
  type SoundShortcut,
} from '../../shared/shortcuts';
import type { MessageKey } from '../../shared/i18n';
import { useT } from '../i18n';
import {
  favorites,
  soundboardSettings,
  useFavorites,
  useRecents,
  useSoundboardSettings,
} from '../soundboard/library';
import { addFavorite, isFavorite, MAX_FAVORITES, removeFavorite } from '../soundboard/model';
import { playSound } from '../soundboard/player';
import type { SoundboardControls } from '../soundboard/useSoundboard';

/** Marks the button that opens the panel, which a click outside it does not count. */
export const TOGGLE_ATTRIBUTE = 'data-soundboard-toggle';

/** How far the panel stays from the window's left and right edges. */
const EDGE_GAP = 16;

/** How long typing must pause before Myinstants is asked. */
const SEARCH_DELAY_MS = 300;

const BLOCK_MESSAGES: Record<NonNullable<SoundboardControls['blocked']>, MessageKey> = {
  notInVoice: 'soundboard.notInVoice',
  micMuted: 'soundboard.micMuted',
  effectsMuted: 'soundboard.effectsMuted',
};

interface Search {
  query: string;
  sounds: Sound[];
  next: number | null;
  loading: boolean;
  failed: boolean;
}

/**
 * The soundboard (ADR 0040), above its button in the sidebar's footer:
 * Myinstants' search, your favourites and recent sounds, the effects' volume,
 * and a shortcut per favourite. Clicking a sound plays it for the channel; the
 * preview plays it for you alone. Closes on a click elsewhere or Escape.
 */
export default function SoundboardPanel({
  anchor,
  controls,
  onClose,
}: {
  /** The button it opens from: it sits above it, kept inside the window. */
  anchor: DOMRect;
  controls: SoundboardControls;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: anchor.left, top: anchor.top });
  const settings = useSoundboardSettings();
  const favoriteList = useFavorites();
  const recentList = useRecents();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Search | null>(null);
  const [previewFailed, setPreviewFailed] = useState<string | null>(null);
  const shortcuts = useSoundShortcuts();

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    // Wider than a menu, so kept well clear of the window's edge: right
    // against it, it reads as cut off.
    setPlace({
      left: Math.max(EDGE_GAP, Math.min(anchor.left, window.innerWidth - box.width - EDGE_GAP)),
      top: Math.max(4, anchor.top - box.height - 6),
    });
  }, [anchor]);

  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  }, []);

  // Not on the window losing focus, unlike a menu: this is somewhere to work.
  const recordingRef = useRef(false);
  recordingRef.current = shortcuts.recording !== null;
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element;
      // Its own button closes it by being clicked, not by this.
      if (target.closest?.(`[${TOGGLE_ATTRIBUTE}]`)) return;
      if (!ref.current?.contains(target)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      // Escape while recording cancels the recording, not the panel.
      if (event.key === 'Escape' && !recordingRef.current) onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  // Asks Myinstants once typing pauses. An answer to an older query is dropped.
  const latest = useRef('');
  useEffect(() => {
    const trimmed = query.trim();
    latest.current = trimmed;
    if (!trimmed) {
      setSearch(null);
      return;
    }
    setSearch({ query: trimmed, sounds: [], next: null, loading: true, failed: false });
    const timer = setTimeout(() => {
      void window.zoia.soundboard.search(trimmed, 1).then((page) => {
        if (latest.current === trimmed) setSearch(searchFrom(trimmed, [], page));
      });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const loadMore = () => {
    if (!search?.next || search.loading) return;
    const { query: searched, sounds, next } = search;
    setSearch({ ...search, loading: true, failed: false });
    void window.zoia.soundboard.search(searched, next).then((page) => {
      if (latest.current === searched) setSearch(searchFrom(searched, sounds, page));
    });
  };

  // Playing again is held back for two seconds after each sound.
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const wait = controls.readyAt - performance.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(performance.now()), wait);
    return () => clearTimeout(timer);
  }, [controls.readyAt]);
  const coolingDown = controls.readyAt > now;

  const preview = async (sound: Sound) => {
    setPreviewFailed(null);
    if (!(await playSound('preview', sound, false))) setPreviewFailed(sound.name);
  };

  const toggleFavorite = (sound: Sound) => {
    const list = favorites.get();
    if (isFavorite(list, sound.slug)) {
      favorites.set(removeFavorite(list, sound.slug));
      // A favourite's shortcut goes with it.
      if (shortcuts.bound(sound.slug)) void shortcuts.clear(sound.slug);
    } else {
      favorites.set(addFavorite(list, sound));
    }
  };

  const setMuted = (muted: boolean) => soundboardSettings.set({ ...settings, muted });
  const percent = Math.round(settings.volume * 100);

  const row = (sound: Sound, favorite: boolean) => (
    <SoundRow
      key={sound.slug}
      sound={sound}
      favorite={favorite}
      favoritesFull={favoriteList.length >= MAX_FAVORITES}
      playDisabled={!!controls.blocked || coolingDown}
      previewDisabled={settings.muted}
      onPlay={() => void controls.send(sound)}
      onPreview={() => void preview(sound)}
      onToggleFavorite={() => toggleFavorite(sound)}
      shortcut={favorite ? shortcuts : null}
    />
  );

  return createPortal(
    <div
      ref={ref}
      className="member-menu soundboard"
      role="dialog"
      aria-label={t('soundboard.title')}
      style={place}
    >
      <div className="soundboard-head">
        <span className="soundboard-title">{t('soundboard.title')}</span>
        <button
          type="button"
          className={`icon-button soundboard-mute${settings.muted ? ' voice-off' : ''}`}
          onClick={() => setMuted(!settings.muted)}
          aria-pressed={settings.muted}
          title={settings.muted ? t('soundboard.unmute') : t('soundboard.mute')}
          aria-label={settings.muted ? t('soundboard.unmute') : t('soundboard.mute')}
        >
          <IconSpeaker muted={settings.muted} />
        </button>
      </div>
      <label className="member-menu-volume soundboard-volume">
        <span>
          {t('soundboard.volume')}
          <span className="member-menu-volume-value">{percent}%</span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={percent}
          disabled={settings.muted}
          onChange={(event) =>
            soundboardSettings.set({ ...settings, volume: Number(event.target.value) / 100 })
          }
          aria-valuetext={`${percent}%`}
        />
      </label>
      <input
        type="search"
        className="soundboard-search"
        placeholder={t('soundboard.search')}
        aria-label={t('soundboard.search')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        spellCheck={false}
      />
      {controls.blocked && <p className="soundboard-note">{t(BLOCK_MESSAGES[controls.blocked])}</p>}
      {previewFailed && (
        <p className="soundboard-note">{t('soundboard.previewFailed', { name: previewFailed })}</p>
      )}

      <div className="soundboard-list">
        {search ? (
          <>
            {search.sounds.map((sound) => row(sound, isFavorite(favoriteList, sound.slug)))}
            {search.loading && <p className="soundboard-note">{t('soundboard.searching')}</p>}
            {search.failed && <p className="soundboard-note">{t('soundboard.searchFailed')}</p>}
            {!search.loading && !search.failed && search.sounds.length === 0 && (
              <p className="soundboard-note">{t('soundboard.noResults')}</p>
            )}
            {search.next && !search.loading && (
              <button type="button" className="soundboard-more" onClick={loadMore}>
                {t('soundboard.more')}
              </button>
            )}
          </>
        ) : (
          <>
            <h3 className="soundboard-heading">
              {t('soundboard.favorites', { count: favoriteList.length, max: MAX_FAVORITES })}
            </h3>
            {favoriteList.length === 0 && (
              <p className="soundboard-note">{t('soundboard.empty')}</p>
            )}
            {favoriteList.map((sound) => row(sound, true))}
            {recentList.length > 0 && (
              <>
                <h3 className="soundboard-heading">{t('soundboard.recents')}</h3>
                {recentList.map((sound) => row(sound, isFavorite(favoriteList, sound.slug)))}
              </>
            )}
          </>
        )}
      </div>
      <p className="soundboard-from">{t('soundboard.from')}</p>
    </div>,
    document.body,
  );
}

function searchFrom(query: string, before: Sound[], page: SoundPage | null): Search {
  if (!page) return { query, sounds: before, next: null, loading: false, failed: true };
  // A page can repeat a sound from the one before it when Myinstants' list moves.
  const sounds = [...before, ...page.sounds.filter((s) => !before.some((b) => b.slug === s.slug))];
  return { query, sounds, next: page.next, loading: false, failed: false };
}

/** The favourites' shortcuts main holds, and recording one. */
function useSoundShortcuts() {
  const [state, setState] = useState<ShortcutsState | null>(null);
  const [recording, setRecording] = useState<SoundShortcut | null>(null);

  useEffect(() => {
    let live = true;
    void window.zoia.shortcuts.get().then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, []);

  // While recording, what is pressed is the binding, not a key for the page.
  useEffect(() => {
    if (!recording) return;
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const types = ['keydown', 'keyup', 'keypress', 'auxclick'] as const;
    for (const type of types) window.addEventListener(type, swallow, true);
    return () => {
      for (const type of types) window.removeEventListener(type, swallow, true);
    };
  }, [recording]);

  // Closing mid-recording must not leave main listening for one.
  useEffect(() => () => void window.zoia.shortcuts.cancel(), []);

  const record = useCallback(async (slug: string) => {
    const action = soundShortcut(slug);
    setRecording(action);
    const next = await window.zoia.shortcuts.record(action);
    setRecording((current) => (current === action ? null : current));
    if (next) setState(next);
  }, []);

  const cancel = useCallback(() => void window.zoia.shortcuts.cancel(), []);

  const clear = useCallback(async (slug: string) => {
    setState(await window.zoia.shortcuts.clear(soundShortcut(slug)));
  }, []);

  const bound = useCallback(
    (slug: string) => state?.bindings[soundShortcut(slug)] ?? null,
    [state],
  );

  return {
    available: state?.available ?? false,
    recording: recording && shortcutSound(recording),
    bound,
    record,
    cancel,
    clear,
  };
}

type SoundShortcuts = ReturnType<typeof useSoundShortcuts>;

function SoundRow({
  sound,
  favorite,
  favoritesFull,
  playDisabled,
  previewDisabled,
  onPlay,
  onPreview,
  onToggleFavorite,
  shortcut,
}: {
  sound: Sound;
  favorite: boolean;
  favoritesFull: boolean;
  playDisabled: boolean;
  previewDisabled: boolean;
  onPlay: () => void;
  onPreview: () => void;
  onToggleFavorite: () => void;
  /** A favourite's shortcut, when it is one. */
  shortcut: SoundShortcuts | null;
}) {
  const t = useT();
  const starDisabled = !favorite && favoritesFull;
  const bound = shortcut?.bound(sound.slug) ?? null;
  const listening = shortcut?.recording === sound.slug;
  return (
    <div className="soundboard-row">
      <button
        type="button"
        className="soundboard-play"
        onClick={onPlay}
        disabled={playDisabled}
        title={t('soundboard.play', { name: sound.name })}
      >
        <span
          className="soundboard-swatch"
          style={sound.color ? { background: `#${sound.color}` } : undefined}
          aria-hidden="true"
        />
        <span className="soundboard-name">{sound.name}</span>
      </button>
      {shortcut?.available && (
        <span className="soundboard-shortcut">
          <button
            type="button"
            className={`voice-keybind${listening ? ' recording' : ''}${bound ? '' : ' unset'}`}
            onClick={() => (listening ? shortcut.cancel() : void shortcut.record(sound.slug))}
            title={
              bound
                ? t('soundboard.shortcutOf', { name: sound.name, shortcut: bound.label })
                : t('soundboard.shortcut')
            }
          >
            {listening
              ? t('soundboard.shortcutRecording')
              : bound
                ? bound.label.split(' + ').map((key, i) => <kbd key={i}>{key}</kbd>)
                : '⌨'}
          </button>
          {bound && !listening && (
            <button
              type="button"
              className="icon-button soundboard-icon"
              onClick={() => void shortcut.clear(sound.slug)}
              title={t('soundboard.shortcutClear')}
              aria-label={t('soundboard.shortcutClear')}
            >
              <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </span>
      )}
      <button
        type="button"
        className="icon-button soundboard-icon"
        onClick={onPreview}
        disabled={previewDisabled}
        title={t('soundboard.preview', { name: sound.name })}
        aria-label={t('soundboard.preview', { name: sound.name })}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="M8 5v14l11-7z" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        className={`icon-button soundboard-icon soundboard-star${favorite ? ' on' : ''}`}
        onClick={onToggleFavorite}
        disabled={starDisabled}
        aria-pressed={favorite}
        title={
          starDisabled
            ? t('soundboard.favoritesFull', { max: MAX_FAVORITES })
            : favorite
              ? t('soundboard.unfavorite')
              : t('soundboard.favorite')
        }
        aria-label={favorite ? t('soundboard.unfavorite') : t('soundboard.favorite')}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"
            fill={favorite ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}

/** A speaker: the soundboard. Struck through, its sounds muted. */
export function IconSpeaker({ muted = false }: { muted?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      {muted ? (
        <path d="M17 9l4 6M21 9l-4 6" />
      ) : (
        <path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12" />
      )}
    </svg>
  );
}

/** A note: the soundboard's button, and someone playing a sound. */
export function IconNote() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 18V5l11-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </svg>
  );
}
