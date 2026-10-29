import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  addPad,
  MAX_PAD_NAME,
  MAX_PADS,
  onPad,
  padEmoji,
  padSound,
  removePad,
  renamePad,
  type Pad,
  type Sound,
  type SoundPage,
} from '../../shared/soundboard';
import {
  shortcutSound,
  soundShortcut,
  type ShortcutsState,
  type SoundShortcut,
} from '../../shared/shortcuts';
import type { MessageKey } from '../../shared/i18n';
import { useT } from '../i18n';
import {
  pads as padStore,
  recents,
  soundboardSettings,
  stepSoundboardVolume,
  usePads,
  useRecents,
  useSoundboardSettings,
} from '../soundboard/library';
import { removeRecent, SEND_INTERVAL_MS } from '../soundboard/model';
import { useWheelRange } from './useWheelRange';
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

/** What a pad may show, offered when editing it. Any other is a click away. */
const PAD_EMOJI = (
  '📢 🎺 🥁 🎸 🎤 🎵 🔔 🚨 💥 💣 🔥 ✨ 😂 🤣 😱 😭 😡 🤡 💀 👻 ' +
  '🤖 👽 🐐 🐸 🐱 🐶 🦆 🐔 👏 🙌 👀 🍿 🎉 🏆 ❌ ✅ ❓ ⏰ 🚀 💸 🫡'
).split(' ');

interface Search {
  query: string;
  sounds: Sound[];
  next: number | null;
  loading: boolean;
  failed: boolean;
}

/**
 * The soundboard (ADR 0040), above its button in the sidebar's footer: your
 * soundpad, the sounds you played last, Myinstants' search and the effects'
 * volume. A pad plays its sound for the channel; its own buttons preview it
 * for you alone and edit it: a name and an emoji of your own, and a
 * shortcut. Closes on a click elsewhere or Escape.
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
  const searchRef = useRef<HTMLInputElement>(null);
  const [place, setPlace] = useState({ left: anchor.left, top: anchor.top });
  const settings = useSoundboardSettings();
  const padList = usePads();
  // What you played that is not on your pad: once added, it is there instead.
  const recentList = useRecents().filter((s) => !onPad(padList, s.slug));
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Search | null>(null);
  const [previewFailed, setPreviewFailed] = useState<string | null>(null);
  // The pad being edited, by its slug.
  const [editing, setEditing] = useState<string | null>(null);
  const shortcuts = useSoundShortcuts();
  const editingPad = editing ? (padList.find((p) => p.slug === editing) ?? null) : null;

  // Kept above its button as it grows and shrinks, from the pad to the editor.
  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    // Its laid-out size, not getBoundingClientRect's: that is scaled down while
    // it pops in, which put it too low until something resized it. Wider than
    // a menu, so kept well clear of the window's edge: right against it, it
    // reads as cut off.
    const fit = () => {
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      setPlace({
        left: Math.max(EDGE_GAP, Math.min(anchor.left, window.innerWidth - width - EDGE_GAP)),
        top: Math.max(4, anchor.top - height - 6),
      });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [anchor]);

  useLayoutEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Not on the window losing focus, unlike a menu: this is somewhere to work.
  // Escape leaves the editor first, and a recording cancels before either.
  const escapeRef = useRef<() => void>(onClose);
  escapeRef.current = () => {
    if (shortcuts.recording !== null) return;
    if (editing) setEditing(null);
    else onClose();
  };
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element;
      // Its own button closes it by being clicked, not by this.
      if (target.closest?.(`[${TOGGLE_ATTRIBUTE}]`)) return;
      if (!ref.current?.contains(target)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') escapeRef.current();
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
  const playDisabled = !!controls.blocked || coolingDown;

  const preview = async (sound: Sound) => {
    setPreviewFailed(null);
    if (!(await playSound('preview', sound, false))) setPreviewFailed(sound.name);
  };

  const padFull = padList.length >= MAX_PADS;
  const remove = (slug: string) => {
    padStore.set(removePad(padStore.get(), slug));
    // A pad's shortcut goes with it.
    if (shortcuts.bound(slug)) void shortcuts.clear(slug);
  };
  const togglePad = (sound: Sound) => {
    const list = padStore.get();
    if (onPad(list, sound.slug)) remove(sound.slug);
    else {
      padStore.set(addPad(list, sound));
      recents.set(removeRecent(recents.get(), sound.slug));
    }
  };

  const setMuted = (muted: boolean) => soundboardSettings.set({ ...settings, muted });
  const percent = Math.round(settings.volume * 100);
  const volumeRef = useWheelRange(stepSoundboardVolume);

  return createPortal(
    <div
      ref={ref}
      className="member-menu soundboard"
      role="dialog"
      aria-label={t('soundboard.title')}
      style={place}
    >
      {/* The title, and beside it how loud everyone's sounds are for you. */}
      <div className="soundboard-head">
        <span className="soundboard-title">
          <IconNote />
          {t('soundboard.title')}
        </span>
        <span className="soundboard-volume">
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
          <input
            ref={volumeRef}
            type="range"
            min={0}
            max={100}
            step={1}
            value={percent}
            disabled={settings.muted}
            onChange={(event) =>
              soundboardSettings.set({ ...settings, volume: Number(event.target.value) / 100 })
            }
            title={t('soundboard.volume')}
            aria-label={t('soundboard.volume')}
            aria-valuetext={`${percent}%`}
          />
          <span className="soundboard-volume-value">{percent}%</span>
        </span>
      </div>

      {editingPad ? (
        <PadEditor
          key={editingPad.slug}
          pad={editingPad}
          shortcut={shortcuts}
          previewDisabled={settings.muted}
          onPreview={() => void preview(editingPad)}
          onSave={(change) => {
            padStore.set(renamePad(padStore.get(), editingPad.slug, change));
            setEditing(null);
          }}
          onRemove={() => {
            remove(editingPad.slug);
            setEditing(null);
          }}
          onBack={() => setEditing(null)}
        />
      ) : (
        <>
          <div className="soundboard-search">
            <IconSearch />
            <input
              ref={searchRef}
              type="search"
              placeholder={t('soundboard.search')}
              aria-label={t('soundboard.search')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              spellCheck={false}
            />
          </div>
          {controls.blocked && (
            <p className="soundboard-note">{t(BLOCK_MESSAGES[controls.blocked])}</p>
          )}
          {previewFailed && (
            <p className="soundboard-note">
              {t('soundboard.previewFailed', { name: previewFailed })}
            </p>
          )}
          {/* Empties over the two seconds before the next sound may play. */}
          <div className="soundboard-cooldown" aria-hidden="true">
            {coolingDown && (
              <span key={controls.readyAt} style={{ animationDuration: `${SEND_INTERVAL_MS}ms` }} />
            )}
          </div>

          <div className="soundboard-list">
            {search ? (
              <>
                {search.sounds.map((sound) => (
                  <SoundRow
                    key={sound.slug}
                    sound={sound}
                    added={onPad(padList, sound.slug)}
                    padFull={padFull}
                    playDisabled={playDisabled}
                    previewDisabled={settings.muted}
                    onPlay={() => void controls.send(sound)}
                    onPreview={() => void preview(sound)}
                    onTogglePad={() => togglePad(sound)}
                  />
                ))}
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
                  {t('soundboard.pad', { count: padList.length, max: MAX_PADS })}
                </h3>
                <div className="soundpad">
                  {padList.map((pad) => (
                    <PadButton
                      key={pad.slug}
                      pad={pad}
                      shortcut={shortcuts.available ? shortcuts.bound(pad.slug) : null}
                      playDisabled={playDisabled}
                      previewDisabled={settings.muted}
                      onPlay={() => void controls.send(padSound(pad))}
                      onPreview={() => void preview(pad)}
                      onEdit={() => setEditing(pad.slug)}
                    />
                  ))}
                  {!padFull && (
                    <button
                      type="button"
                      className={`soundpad-add${padList.length === 0 ? ' empty' : ''}`}
                      onClick={() => searchRef.current?.focus()}
                    >
                      <IconPlus />
                      <span>
                        {padList.length === 0 ? t('soundboard.empty') : t('soundboard.find')}
                      </span>
                    </button>
                  )}
                </div>
                {recentList.length > 0 && (
                  <>
                    <h3 className="soundboard-heading">{t('soundboard.recents')}</h3>
                    {recentList.map((sound) => (
                      <SoundRow
                        key={sound.slug}
                        sound={sound}
                        added={onPad(padList, sound.slug)}
                        padFull={padFull}
                        playDisabled={playDisabled}
                        onPlay={() => void controls.send(sound)}
                        onTogglePad={() => togglePad(sound)}
                        onRemove={() => recents.set(removeRecent(recents.get(), sound.slug))}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
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

/** The pads' shortcuts main holds, and recording one. */
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

/**
 * One pad: pressing it plays its sound for the channel, a right-click edits
 * it. Previewing and editing are its own buttons, in its corner on hover.
 */
function PadButton({
  pad,
  shortcut,
  playDisabled,
  previewDisabled,
  onPlay,
  onPreview,
  onEdit,
}: {
  pad: Pad;
  shortcut: { label: string } | null;
  playDisabled: boolean;
  previewDisabled: boolean;
  onPlay: () => void;
  onPreview: () => void;
  onEdit: () => void;
}) {
  const t = useT();
  return (
    <div className="soundpad-cell">
      <button
        type="button"
        className="soundpad-pad"
        onClick={onPlay}
        onContextMenu={(event) => {
          event.preventDefault();
          onEdit();
        }}
        disabled={playDisabled}
        title={t('soundboard.play', { name: pad.name })}
      >
        <span className="soundpad-emoji" aria-hidden="true">
          {pad.emoji ?? <IconNote />}
        </span>
        <span className="soundpad-name">{pad.name}</span>
        {shortcut && <kbd className="soundpad-key">{shortcut.label}</kbd>}
      </button>
      <span className="soundpad-tools">
        <button
          type="button"
          className="soundpad-tool"
          onClick={onPreview}
          disabled={previewDisabled}
          title={t('soundboard.preview', { name: pad.name })}
          aria-label={t('soundboard.preview', { name: pad.name })}
        >
          <IconPreview />
        </button>
        <button
          type="button"
          className="soundpad-tool"
          onClick={onEdit}
          title={t('soundboard.edit', { name: pad.name })}
          aria-label={t('soundboard.edit', { name: pad.name })}
        >
          <IconEdit />
        </button>
      </span>
    </div>
  );
}

/**
 * Editing a pad, in the pad's place: its emoji, its name, which may hold
 * emoji too, and its shortcut. Saving keeps the name and emoji; a shortcut is
 * kept as soon as it is recorded, as voice's are.
 */
function PadEditor({
  pad,
  shortcut,
  previewDisabled,
  onPreview,
  onSave,
  onRemove,
  onBack,
}: {
  pad: Pad;
  shortcut: SoundShortcuts;
  previewDisabled: boolean;
  onPreview: () => void;
  onSave: (change: { name: string; emoji: string | null }) => void;
  onRemove: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(pad.name);
  const [emoji, setEmoji] = useState(pad.emoji ?? '');
  const nameRef = useRef<HTMLInputElement>(null);
  const emojiRef = useRef<HTMLInputElement>(null);
  // Where the system's picker types: the field used last, the name at first.
  const lastField = useRef<HTMLInputElement | null>(null);
  const bound = shortcut.bound(pad.slug);
  const listening = shortcut.recording === pad.slug;

  useLayoutEffect(() => {
    nameRef.current?.select();
  }, []);

  const save = () => onSave({ name, emoji: emoji || null });
  // The grid's buttons must not take the focus from the field being typed in.
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault();

  return (
    <div className="soundpad-editor">
      <div className="soundpad-editor-head">
        <button
          type="button"
          className="icon-button soundboard-icon"
          onClick={onBack}
          title={t('soundboard.back')}
          aria-label={t('soundboard.back')}
        >
          <IconBack />
        </button>
        <span className="soundboard-title">{t('soundboard.editTitle')}</span>
      </div>

      <div className="soundpad-editor-fields">
        <input
          ref={emojiRef}
          className="soundpad-emoji-input"
          value={emoji}
          placeholder="🔊"
          aria-label={t('soundboard.emoji')}
          title={t('soundboard.emoji')}
          onFocus={(event) => (lastField.current = event.currentTarget)}
          // Only an emoji goes here: the last one typed or picked, or none.
          onChange={(event) => {
            const value = event.target.value;
            if (!value.trim()) setEmoji('');
            else {
              const next = padEmoji(value);
              if (next) setEmoji(next);
            }
          }}
          onKeyDown={(event) => event.key === 'Enter' && save()}
        />
        <input
          ref={nameRef}
          className="soundpad-name-input"
          value={name}
          placeholder={t('soundboard.name')}
          aria-label={t('soundboard.name')}
          // Counted again by character on saving; this only stops a paste of a page.
          maxLength={MAX_PAD_NAME * 4}
          spellCheck={false}
          onFocus={(event) => (lastField.current = event.currentTarget)}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && save()}
        />
      </div>

      <div
        className="emoji-grid soundpad-emoji-grid"
        role="group"
        aria-label={t('soundboard.emoji')}
      >
        {PAD_EMOJI.map((e) => (
          <button
            key={e}
            type="button"
            className={e === emoji ? 'chosen' : undefined}
            onMouseDown={keepFocus}
            onClick={() => setEmoji(e === emoji ? '' : e)}
            aria-label={e}
            aria-pressed={e === emoji}
          >
            {e}
          </button>
        ))}
        {/* Every other emoji, with search: the system's own picker, which types
            into the field used last, so into the name as well. */}
        <button
          type="button"
          className="emoji-more"
          onMouseDown={keepFocus}
          onClick={() => {
            (lastField.current ?? nameRef.current)?.focus();
            void window.zoia.app.emojiPanel();
          }}
          title={t('sidebar.moreEmoji')}
          aria-label={t('sidebar.moreEmoji')}
        >
          …
        </button>
      </div>

      {shortcut.available && (
        <div className="soundpad-editor-row">
          <span className="soundpad-editor-label">{t('soundboard.shortcutLabel')}</span>
          <button
            type="button"
            className={`voice-keybind${listening ? ' recording' : ''}${bound ? '' : ' unset'}`}
            onClick={() => (listening ? shortcut.cancel() : void shortcut.record(pad.slug))}
            title={
              bound
                ? t('soundboard.shortcutOf', { name: pad.name, shortcut: bound.label })
                : t('soundboard.shortcut')
            }
          >
            {listening
              ? t('soundboard.shortcutRecording')
              : bound
                ? bound.label.split(' + ').map((key, i) => <kbd key={i}>{key}</kbd>)
                : t('soundboard.shortcut')}
          </button>
          {bound && !listening && (
            <button
              type="button"
              className="icon-button soundboard-icon"
              onClick={() => void shortcut.clear(pad.slug)}
              title={t('soundboard.shortcutClear')}
              aria-label={t('soundboard.shortcutClear')}
            >
              <IconClose />
            </button>
          )}
        </div>
      )}

      <div className="soundpad-editor-actions">
        <button type="button" className="danger" onClick={onRemove}>
          {t('soundboard.removePad')}
        </button>
        <span className="soundpad-editor-spacer" />
        <button
          type="button"
          className="icon-button soundboard-icon"
          onClick={onPreview}
          disabled={previewDisabled}
          title={t('soundboard.preview', { name: pad.name })}
          aria-label={t('soundboard.preview', { name: pad.name })}
        >
          <IconPreview />
        </button>
        <button type="button" className="primary" onClick={save}>
          {t('soundboard.save')}
        </button>
      </div>
    </div>
  );
}

/**
 * A sound found on Myinstants or played lately: play it, put it on your pad,
 * and preview a found one or take a recent one off the list.
 */
function SoundRow({
  sound,
  added,
  padFull,
  playDisabled,
  previewDisabled,
  onPlay,
  onPreview,
  onTogglePad,
  onRemove,
}: {
  sound: Sound;
  added: boolean;
  padFull: boolean;
  playDisabled: boolean;
  previewDisabled?: boolean;
  onPlay: () => void;
  onPreview?: () => void;
  onTogglePad: () => void;
  onRemove?: () => void;
}) {
  const t = useT();
  const addDisabled = !added && padFull;
  return (
    <div className="soundboard-row">
      <button
        type="button"
        className="soundboard-play"
        onClick={onPlay}
        disabled={playDisabled}
        title={t('soundboard.play', { name: sound.name })}
      >
        <IconNote />
        <span className="soundboard-name">{sound.name}</span>
      </button>
      {onPreview && (
        <button
          type="button"
          className="icon-button soundboard-icon"
          onClick={onPreview}
          disabled={previewDisabled}
          title={t('soundboard.preview', { name: sound.name })}
          aria-label={t('soundboard.preview', { name: sound.name })}
        >
          <IconPreview />
        </button>
      )}
      <button
        type="button"
        className={`icon-button soundboard-icon soundboard-add${added ? ' on' : ''}`}
        onClick={onTogglePad}
        disabled={addDisabled}
        aria-pressed={added}
        title={
          addDisabled
            ? t('soundboard.padFull', { max: MAX_PADS })
            : added
              ? t('soundboard.removePad')
              : t('soundboard.addPad')
        }
        aria-label={added ? t('soundboard.removePad') : t('soundboard.addPad')}
      >
        {added ? <IconCheck /> : <IconPlus />}
      </button>
      {onRemove && (
        <button
          type="button"
          className="icon-button soundboard-icon"
          onClick={onRemove}
          title={t('soundboard.removeRecent')}
          aria-label={t('soundboard.removeRecent')}
        >
          <IconClose />
        </button>
      )}
    </div>
  );
}

const ICON = {
  viewBox: '0 0 24 24',
  'aria-hidden': true,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function IconPreview() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path d="M8 5v14l11-7z" fill="currentColor" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg {...ICON} width="13" height="13">
      <path d="M4 20h4L19 9l-4-4L4 16z" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg {...ICON} width="14" height="14">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg {...ICON} width="14" height="14">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg {...ICON} width="12" height="12">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function IconBack() {
  return (
    <svg {...ICON} width="16" height="16">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg {...ICON} width="14" height="14">
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </svg>
  );
}

/** A speaker: the soundboard. Struck through, its sounds muted. */
export function IconSpeaker({ muted = false }: { muted?: boolean }) {
  return (
    <svg {...ICON} width="18" height="18">
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
    <svg {...ICON} width="18" height="18">
      <path d="M9 18V5l11-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </svg>
  );
}
