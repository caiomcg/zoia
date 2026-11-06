import { captureBorderEnabled, setCaptureBorderEnabled } from '../capture-border';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountInfo, UpdaterConfig } from '../../shared/ipc';
import AccountPanel from './AccountPanel';
import AccountsSection from './AccountsSection';
import AddonsSection from './AddonsSection';
import Avatar from './Avatar';
import AvatarCropDialog from './AvatarCropDialog';
import EntranceSettingsSection from './EntranceSettings';
import { encodeAvatar, type AvatarCrop, type EncodedAvatar } from '../avatars';
import { tNow, useT } from '../i18n';
import LanguagePicker from './LanguagePicker';
import type { MessageKey } from '../../shared/i18n';
import {
  CUE_EVENTS,
  CUE_STYLES,
  DEFAULT_SOUND_SETTINGS,
  PITCH_RANGE,
  isFixedCue,
  type CueEvent,
  type CueSettings,
} from '../sounds/cues';
import { setSoundSettings, useSoundSettings } from '../sounds/settings';
import {
  soundboardSettings,
  stepSoundboardVolume,
  useSoundboardSettings,
} from '../soundboard/library';
import { useWheelRange } from './useWheelRange';
import VoiceSettingsSection from './VoiceSettings';
import { playCue } from '../sounds/synth';
import ReleaseNotesDialog from './ReleaseNotesDialog';
import { useExit } from '../presence';
import {
  NOTIFY_KINDS,
  notify,
  setNotifyPrefs,
  useNotifyPrefs,
  type NotifyKind,
} from '../notify/notify';
import { SettingsCard, SettingsToggle } from './SettingsCard';

export type Section =
  | 'profile'
  | 'accounts'
  | 'server'
  | 'addons'
  | 'broadcast'
  | 'voice'
  | 'general'
  | 'sounds'
  | 'notifications'
  | 'updates'
  | 'about';

/** One of the server's limits, for an admin to change. The server checks both. */
export interface AwayChoice {
  /** The channels that may be it: every one but the default. */
  channels: { id: string; name: string }[];
  current: string | null;
  onChange: (id: string | null) => void;
}

export interface ServerLimit {
  /** How many there are now. */
  count: number;
  max: number;
  /** The most an admin may allow. */
  ceiling: number;
  onChange: (max: number) => void;
}

const SECTIONS: { id: Section; label: MessageKey; adminOnly?: boolean; superOnly?: boolean }[] = [
  { id: 'profile', label: 'settings.nav.profile' },
  { id: 'accounts', label: 'settings.nav.accounts', adminOnly: true },
  { id: 'server', label: 'settings.nav.server', adminOnly: true },
  // Installing an addon is trusting its author: the super admin's alone (ADR 0041).
  { id: 'addons', label: 'settings.nav.addons', superOnly: true },
  { id: 'broadcast', label: 'settings.nav.broadcast' },
  { id: 'voice', label: 'settings.nav.voice' },
  { id: 'general', label: 'settings.nav.general' },
  { id: 'sounds', label: 'settings.nav.sounds' },
  { id: 'notifications', label: 'settings.nav.notifications' },
  { id: 'updates', label: 'settings.nav.updates' },
  { id: 'about', label: 'settings.nav.about' },
];

interface SettingsDialogProps {
  onClose: () => void;
  myName: string;
  onRename: (name: string) => Promise<void>;
  /** Yours, so the profile shows your own picture. */
  myIdentity?: string;
  hasAvatar?: boolean;
  /** Publishes a new picture, or removes it with null. */
  onAvatarChange?: (avatar: EncodedAvatar | null) => Promise<void>;
  /** Which encoder and card, or why there isn't one. */
  hardwareDetail: string;
  hardware?: boolean;
  onHardwareChange?: (enabled: boolean) => void;
  hardwareAvailable?: boolean;
  /** Fading out: it stays on screen for that, and ignores clicks. */
  closing?: boolean;
  /** This machine's account, or none for one paired before accounts. */
  account?: AccountInfo | null;
  onSignOut?: () => Promise<void>;
  /** Asks the server again, after an admin action changes what is waiting. */
  onAccountsChanged?: () => void;
  /** Where to open: Accounts, when a sign-up notice was clicked. */
  initialSection?: Section;
  /** Admins: how many channels and chats there may be. No chats without chat. */
  limits?: { channels: ServerLimit; chats?: ServerLimit };
  /** Which channel is the away channel (ADR 0044), for Settings › Server. */
  away?: AwayChoice;
}

/**
 * Everything that is set once and left alone. The sections are one pane each
 * rather than one long form, so a setting is found by where it belongs, and
 * each pane scrolls on its own when it outgrows the dialog.
 */
export default function SettingsDialog({
  onClose,
  myName,
  onRename,
  myIdentity,
  hasAvatar = false,
  onAvatarChange,
  hardwareDetail,
  hardware,
  onHardwareChange,
  hardwareAvailable,
  closing = false,
  account = null,
  onSignOut,
  onAccountsChanged,
  initialSection = 'profile',
  limits,
  away,
}: SettingsDialogProps) {
  const t = useT();
  const [section, setSection] = useState<Section>(initialSection);
  const isAdmin = account?.role === 'admin' || account?.role === 'super_admin';
  const pending = account?.pendingApprovals ?? 0;

  return (
    <div className={`picker-backdrop${closing ? ' closing' : ''}`} onClick={onClose}>
      <section
        className="picker settings-dialog"
        role="dialog"
        aria-label={t('settings.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-header">
          <h2>{t('settings.title')}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label={t('settings.close')}
            title={t('common.close')}
          >
            ×
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav" aria-label={t('settings.sections')}>
            {SECTIONS.filter(
              (s) => (!s.adminOnly || isAdmin) && (!s.superOnly || account?.role === 'super_admin'),
            ).map((s) => (
              <button
                key={s.id}
                className={section === s.id ? 'active' : undefined}
                aria-current={section === s.id ? 'page' : undefined}
                onClick={() => setSection(s.id)}
              >
                {t(s.label)}
                {s.id === 'accounts' && pending > 0 && (
                  <span className="nav-count" aria-label={t('admin.waiting', { count: pending })}>
                    {pending}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {/* Keyed by section, so each one fades in rather than swapping. */}
          <div className="settings-pane" key={section}>
            {section === 'profile' && (
              <ProfileSection
                myName={myName}
                onRename={onRename}
                myIdentity={myIdentity}
                hasAvatar={hasAvatar}
                onAvatarChange={onAvatarChange}
              />
            )}
            {section === 'profile' && account && onSignOut && (
              <AccountPanel account={account} onSignOut={onSignOut} />
            )}
            {section === 'accounts' && account && isAdmin && (
              <AccountsSection me={account} onChanged={() => onAccountsChanged?.()} />
            )}
            {section === 'server' && isAdmin && limits && (
              <ServerSection limits={limits} away={away} />
            )}
            {section === 'addons' && account?.role === 'super_admin' && <AddonsSection />}
            {section === 'broadcast' && (
              <BroadcastSection
                hardwareDetail={hardwareDetail}
                hardware={hardware ?? false}
                onHardwareChange={onHardwareChange}
                hardwareAvailable={hardwareAvailable ?? false}
              />
            )}
            {section === 'voice' && <VoiceSettingsSection closing={closing} />}
            {section === 'general' && <GeneralSection />}
            {section === 'sounds' && <SoundsSection />}
            {section === 'notifications' && <NotificationsSection />}
            {section === 'updates' && <UpdatesSection />}
            {section === 'about' && <AboutSection />}
          </div>
        </div>
      </section>
    </div>
  );
}

/** What the picture chooser offers; the server accepts the same three. */
const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
/**
 * The largest file offered for framing. What is uploaded is always a small
 * 256px WebP, so this is not the server's limit: it keeps a huge photo from
 * making the framing dialog slow to open.
 */
const MAX_PICTURE_MB = 10;

function ProfileSection({
  myName,
  onRename,
  myIdentity,
  hasAvatar,
  onAvatarChange,
}: {
  myName: string;
  onRename: (name: string) => Promise<void>;
  myIdentity?: string;
  hasAvatar: boolean;
  onAvatarChange?: (avatar: EncodedAvatar | null) => Promise<void>;
}) {
  const t = useT();
  const [value, setValue] = useState(myName);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pictureBusy, setPictureBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // A picture being framed before it is published. Kept while the framing
  // dialog fades out, since the state that opened it is already cleared.
  const [picked, setPicked] = useState<File | null>(null);
  const [shownPicked, setShownPicked] = useState<File | null>(null);
  if (picked && picked !== shownPicked) setShownPicked(picked);
  const cropDialog = useExit(picked !== null);

  async function removePicture() {
    if (!onAvatarChange) return;
    setPictureBusy(true);
    setError(null);
    setMessage(null);
    try {
      await onAvatarChange(null);
      setMessage(t('profile.pictureRemoved'));
    } catch {
      // An error crossing IPC is only a message string; this one is kinder.
      setError(t('profile.pictureFailed'));
    } finally {
      setPictureBusy(false);
    }
  }

  /** Publishes the framed picture. A failure stays in the dialog to retry. */
  async function publishPicture(file: File, crop: AvatarCrop) {
    if (!onAvatarChange) return;
    setError(null);
    setMessage(null);
    await onAvatarChange(await encodeAvatar(file, crop));
    setPicked(null);
    setMessage(t('profile.pictureSaved'));
  }

  useEffect(() => setValue(myName), [myName]);

  const next = value.trim();
  const changed = next !== '' && next !== myName;

  async function save() {
    if (!changed) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await onRename(next);
      setMessage(t('profile.saved'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('profile.renameFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>{t('settings.nav.profile')}</h3>
      <SettingsCard id="settings-profile-you" title={t('profile.you')}>
        <div className="settings-profile">
          {onAvatarChange ? (
            <button
              type="button"
              className="avatar-edit"
              onClick={() => fileRef.current?.click()}
              disabled={pictureBusy}
              aria-label={t('profile.changePicture')}
              title={t('profile.changePicture')}
            >
              <Avatar name={next || myName} identity={myIdentity} live={false} />
              <span className="avatar-edit-badge" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 8h3l2-3h6l2 3h3v11H4z" strokeLinejoin="round" strokeLinecap="round" />
                  <circle cx="12" cy="13" r="3.5" />
                </svg>
              </span>
            </button>
          ) : (
            <Avatar name={next || myName} identity={myIdentity} live={false} />
          )}
          <div className="settings-profile-text">
            <p className="muted">{t('profile.body')}</p>
            {onAvatarChange && (
              <p className="settings-profile-actions">
                <span className="muted">
                  {t('profile.pictureHint')} {t('profile.pictureRules', { max: MAX_PICTURE_MB })}
                </span>
                {hasAvatar && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => void removePicture()}
                    disabled={pictureBusy}
                  >
                    {t('profile.removePicture')}
                  </button>
                )}
              </p>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept={PICTURE_TYPES.join(',')}
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared, so choosing the same file again still counts as a change.
              event.target.value = '';
              if (!file) return;
              setMessage(null);
              // The chooser filters by type, but "All files" gets past it.
              if (!PICTURE_TYPES.includes(file.type)) {
                setError(t('profile.pictureWrongType'));
                return;
              }
              if (file.size > MAX_PICTURE_MB * 1024 * 1024) {
                setError(t('profile.pictureTooLarge', { max: MAX_PICTURE_MB }));
                return;
              }
              setError(null);
              setPicked(file);
            }}
          />
        </div>
        {cropDialog.mounted && shownPicked && (
          <AvatarCropDialog
            file={shownPicked}
            closing={cropDialog.closing}
            onCancel={() => setPicked(null)}
            onSave={(crop) => publishPicture(shownPicked, crop)}
          />
        )}
        <label className="settings-field">
          <span>{t('profile.displayName')}</span>
          <div className="settings-inline">
            <input
              value={value}
              maxLength={32}
              disabled={busy}
              onChange={(event) => {
                setValue(event.target.value);
                setMessage(null);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void save();
              }}
            />
            <button className="primary" onClick={() => void save()} disabled={busy || !changed}>
              {t('settings.save')}
            </button>
          </div>
        </label>
        {error && <p className="settings-error">{error}</p>}
        {message && <p className="settings-message">{message}</p>}
      </SettingsCard>
    </>
  );
}

function BroadcastSection({
  hardwareDetail,
  hardware,
  onHardwareChange,
  hardwareAvailable,
}: {
  hardwareDetail: string;
  hardware: boolean;
  onHardwareChange?: (enabled: boolean) => void;
  hardwareAvailable: boolean;
}) {
  const t = useT();
  const [border, setBorder] = useState(captureBorderEnabled);
  return (
    <>
      <h3>{t('settings.nav.broadcast')}</h3>
      <SettingsCard id="settings-broadcast-encoding" title={t('broadcast.encoding')}>
        <SettingsToggle
          label={t('broadcast.hardware')}
          badge={hardwareAvailable ? t('broadcast.beta') : t('broadcast.unavailable')}
          hint={hardwareDetail}
          title={hardwareDetail}
          checked={hardware && hardwareAvailable}
          disabled={!hardwareAvailable}
          onChange={(checked) => onHardwareChange?.(checked)}
        />
        <p className="muted settings-card-note">{t('broadcast.hardwareHelp')}</p>
      </SettingsCard>
      <SettingsCard id="settings-broadcast-capture" title={t('broadcast.capture')}>
        <SettingsToggle
          label={t('broadcast.border')}
          hint={t('broadcast.borderDetail')}
          checked={border}
          disabled={!hardwareAvailable}
          onChange={(checked) => {
            setBorder(checked);
            setCaptureBorderEnabled(checked);
          }}
        />
      </SettingsCard>
    </>
  );
}

function GeneralSection() {
  const t = useT();
  const [closeToTray, setCloseToTray] = useState(false);
  const [devToolsEnabled, setDevToolsEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.zoia.tray
      .closeToTray()
      .then(setCloseToTray)
      .catch(() => {});
    window.zoia.devTools
      .isEnabled()
      .then(setDevToolsEnabled)
      .catch(() => {});
  }, []);

  async function toggleCloseToTray(value: boolean) {
    setCloseToTray(value);
    setError(null);
    try {
      setCloseToTray(await window.zoia.tray.setCloseToTray(value));
    } catch {
      setCloseToTray(!value);
      setError(t('general.trayFailed'));
    }
  }

  async function toggleDevTools(value: boolean) {
    setDevToolsEnabled(value);
    setError(null);
    try {
      setDevToolsEnabled(await window.zoia.devTools.setEnabled(value));
    } catch {
      setDevToolsEnabled(!value);
      setError(t('general.devToolsFailed'));
    }
  }

  return (
    <>
      <h3>{t('settings.nav.general')}</h3>
      <SettingsCard id="settings-general-app" title={t('general.app')}>
        <div className="voice-row">
          <span className="voice-label">{t('general.language')}</span>
          <LanguagePicker />
        </div>
        <SettingsToggle
          label={t('general.tray')}
          checked={closeToTray}
          onChange={(checked) => void toggleCloseToTray(checked)}
        />
      </SettingsCard>
      <SettingsCard id="settings-general-developer" title={t('general.developer')}>
        <SettingsToggle
          label={t('general.devTools')}
          hint={t('general.devToolsHint')}
          checked={devToolsEnabled}
          onChange={(checked) => void toggleDevTools(checked)}
        />
        {devToolsEnabled && (
          <div>
            <button type="button" onClick={() => void window.zoia.devTools.open()}>
              {t('general.openDevTools')}
            </button>
          </div>
        )}
      </SettingsCard>
      {error && <p className="settings-error">{error}</p>}
    </>
  );
}

/**
 * How many channels and chats there may be. Set once and rarely touched, so
 * here rather than beside every heading in the sidebar.
 */
function ServerSection({
  limits,
  away,
}: {
  limits: { channels: ServerLimit; chats?: ServerLimit };
  away?: AwayChoice;
}) {
  const t = useT();
  return (
    <>
      <h3>{t('settings.nav.server')}</h3>
      <SettingsCard id="settings-server-limits" title={t('server.limits')}>
        <p className="muted settings-card-note">{t('server.intro')}</p>
        <LimitField label={t('server.channels')} limit={limits.channels} />
        {limits.chats && <LimitField label={t('server.chats')} limit={limits.chats} />}
      </SettingsCard>
      {away && <AwayField away={away} />}
    </>
  );
}

/**
 * The away channel (ADR 0044): where nobody talks or shares, and the idle
 * limit is longer. Any channel but the default, or none.
 */
function AwayField({ away }: { away: AwayChoice }) {
  const t = useT();
  return (
    <SettingsCard id="settings-server-away" title={t('server.away')}>
      <select
        className="settings-select"
        value={away.current ?? ''}
        onChange={(event) => away.onChange(event.target.value || null)}
        aria-label={t('server.away')}
      >
        <option value="">{t('server.awayNone')}</option>
        {away.channels.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <p className="muted settings-card-note">{t('server.awayHint')}</p>
    </SettingsCard>
  );
}

function LimitField({ label, limit }: { label: string; limit: ServerLimit }) {
  const t = useT();
  const { count, max, ceiling, onChange } = limit;
  return (
    <div className="settings-field server-limit">
      <span className="server-limit-label">
        {label}
        <small>{t('server.inUse', { count })}</small>
      </span>
      <span className="server-limit-stepper">
        <button
          type="button"
          disabled={max <= 1}
          onClick={() => onChange(max - 1)}
          aria-label={t('server.less', { what: label })}
          title={t('server.less', { what: label })}
        >
          −
        </button>
        <span className="server-limit-value" aria-live="polite">
          {max}
        </span>
        <button
          type="button"
          disabled={max >= ceiling}
          onClick={() => onChange(max + 1)}
          aria-label={t('server.more', { what: label })}
          title={t('server.more', { what: label })}
        >
          +
        </button>
      </span>
    </div>
  );
}

const NOTIFY_LABELS: Record<NotifyKind, MessageKey> = {
  event: 'notify.kind.event',
  direct: 'notify.kind.direct',
  mention: 'notify.kind.mention',
  alert: 'notify.kind.alert',
};

/**
 * Where each kind of notification is said (see notify.ts): as a card in Zoia,
 * and from Windows while Zoia is not in front. Kept on this machine.
 */
function NotificationsSection() {
  const t = useT();
  const prefs = useNotifyPrefs();
  const sounds = useSoundSettings();
  const set = (place: 'inApp' | 'system', kind: NotifyKind, on: boolean) =>
    setNotifyPrefs({ ...prefs, [place]: { ...prefs[place], [kind]: on } });
  // The sounds notifications make are cues (Settings › Sounds): events have
  // their own, and mentions and direct messages share the mention one.
  const updateSound = (event: 'eventStart' | 'mention', patch: Partial<CueSettings>) => {
    const cue = { ...sounds.cues[event], ...patch };
    setSoundSettings({ ...sounds, cues: { ...sounds.cues, [event]: cue } });
    return cue;
  };
  const preview = (event: 'eventStart' | 'mention', cue = sounds.cues[event]) => {
    if (cue.enabled) playCue(event, cue, sounds.volume);
  };
  return (
    <>
      <h3>{t('settings.nav.notifications')}</h3>
      <SettingsCard id="settings-notifications" title={t('settings.nav.notifications')}>
        <p className="muted settings-card-note">{t('notify.intro')}</p>
        <div className="notify-grid" role="table">
          <div className="notify-row notify-head" role="row">
            <span role="columnheader" />
            <span role="columnheader">{t('notify.inApp')}</span>
            <span role="columnheader">{t('notify.system')}</span>
          </div>
          {NOTIFY_KINDS.map((kind) => (
            <div className="notify-row" role="row" key={kind}>
              <span role="rowheader">{t(NOTIFY_LABELS[kind])}</span>
              <input
                type="checkbox"
                role="cell"
                aria-label={`${t(NOTIFY_LABELS[kind])} · ${t('notify.inApp')}`}
                checked={prefs.inApp[kind]}
                onChange={(e) => set('inApp', kind, e.target.checked)}
              />
              <input
                type="checkbox"
                role="cell"
                aria-label={`${t(NOTIFY_LABELS[kind])} · ${t('notify.system')}`}
                checked={prefs.system[kind]}
                onChange={(e) => set('system', kind, e.target.checked)}
              />
            </div>
          ))}
        </div>
        <div className="notify-sounds">
          <span className="notify-sounds-title">{t('notify.sounds')}</span>
          {(
            [
              ['eventStart', 'notify.soundEvents'],
              ['mention', 'notify.soundMessages'],
            ] as const
          ).map(([event, label]) => {
            const cue = sounds.cues[event];
            const percent = Math.round(cue.volume * 100);
            return (
              <div key={event} className={`notify-sound ${cue.enabled ? '' : 'off'}`}>
                <label className="notify-sound-toggle">
                  <input
                    type="checkbox"
                    checked={cue.enabled}
                    onChange={(e) =>
                      preview(event, updateSound(event, { enabled: e.target.checked }))
                    }
                  />
                  <span>{t(label)}</span>
                </label>
                <input
                  className="settings-range"
                  type="range"
                  min={0}
                  max={100}
                  value={percent}
                  disabled={!cue.enabled}
                  aria-label={`${t(label)}: ${t('sounds.volume')}`}
                  onChange={(e) => updateSound(event, { volume: Number(e.target.value) / 100 })}
                  onPointerUp={() => preview(event)}
                  onKeyUp={() => preview(event)}
                />
                <span className="notify-sound-percent">
                  {cue.enabled ? `${percent}%` : t('notify.soundOff')}
                </span>
              </div>
            );
          })}
          <small className="muted">{t('notify.soundsHint')}</small>
        </div>
        <button
          type="button"
          className="notify-test"
          onClick={() => {
            notify(
              { kind: 'event', group: 'example', title: 'Zoia', body: t('notify.example') },
              { evenInFront: true },
            );
            preview('eventStart');
          }}
        >
          {t('notify.test')}
        </button>
      </SettingsCard>
    </>
  );
}

const CUE_LABELS: Record<CueEvent, MessageKey> = {
  join: 'sounds.event.join',
  leave: 'sounds.event.leave',
  streamStart: 'sounds.event.streamStart',
  streamStop: 'sounds.event.streamStop',
  viewerJoin: 'sounds.event.viewerJoin',
  viewerLeave: 'sounds.event.viewerLeave',
  mention: 'sounds.event.mention',
  eventStart: 'sounds.event.eventStart',
};

/**
 * Every change is heard straight away — a slider plays the cue it moved when
 * released — so a sound is chosen by listening rather than by name.
 */
function SoundsSection() {
  const t = useT();
  const settings = useSoundSettings();

  function updateCue(event: CueEvent, patch: Partial<CueSettings>, preview = true) {
    const cue = { ...settings.cues[event], ...patch };
    setSoundSettings({ ...settings, cues: { ...settings.cues, [event]: cue } });
    if (preview && cue.enabled) playCue(event, cue, settings.volume);
  }

  return (
    <>
      <h3>{t('settings.nav.sounds')}</h3>
      <SettingsCard id="settings-sounds-cues" title={t('sounds.cues')}>
        <p className="muted settings-card-note">{t('sounds.intro')}</p>

        <label className="settings-field">
          <span>
            {t('sounds.volume')} · {Math.round(settings.volume * 100)}%
          </span>
          <input
            className="settings-range"
            type="range"
            min={0}
            max={100}
            value={Math.round(settings.volume * 100)}
            onChange={(event) =>
              setSoundSettings({ ...settings, volume: Number(event.target.value) / 100 })
            }
            onPointerUp={() => playCue('join', settings.cues.join, settings.volume)}
          />
        </label>

        {CUE_EVENTS.map((event) => {
          const cue = settings.cues[event];
          return (
            <div key={event} className={`sound-cue ${cue.enabled ? '' : 'off'}`}>
              <div className="sound-cue-head">
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={cue.enabled}
                    onChange={(change) => updateCue(event, { enabled: change.target.checked })}
                  />
                  {t(CUE_LABELS[event])}
                </label>
                <button
                  type="button"
                  className="sound-preview"
                  onClick={() => playCue(event, cue, settings.volume)}
                  disabled={settings.volume === 0}
                >
                  ▶ {t('sounds.preview')}
                </button>
              </div>
              {/* A fixed cue has its own sound: only on, off and how loud are yours. */}
              {!isFixedCue(event) && (
                <div className="sound-cue-controls">
                  <div className="sound-styles" role="radiogroup" aria-label={t('sounds.style')}>
                    {CUE_STYLES.map((style) => (
                      <button
                        key={style}
                        type="button"
                        role="radio"
                        aria-checked={cue.style === style}
                        className={cue.style === style ? 'active' : undefined}
                        disabled={!cue.enabled}
                        onClick={() => updateCue(event, { style })}
                      >
                        {t(`sounds.style.${style}`)}
                      </button>
                    ))}
                  </div>
                  <label className="sound-pitch">
                    <span>
                      {t('sounds.pitch')} {cue.pitch > 0 ? `+${cue.pitch}` : cue.pitch}
                    </span>
                    <input
                      className="settings-range"
                      type="range"
                      min={-PITCH_RANGE}
                      max={PITCH_RANGE}
                      step={1}
                      value={cue.pitch}
                      disabled={!cue.enabled}
                      onChange={(change) =>
                        updateCue(event, { pitch: Number(change.target.value) }, false)
                      }
                      onPointerUp={() => playCue(event, cue, settings.volume)}
                    />
                  </label>
                </div>
              )}
              <div className="sound-cue-controls">
                <label className="sound-pitch">
                  <span>
                    {t('sounds.volume')} {Math.round(cue.volume * 100)}%
                  </span>
                  <input
                    className="settings-range"
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(cue.volume * 100)}
                    disabled={!cue.enabled}
                    aria-label={`${t(CUE_LABELS[event])}: ${t('sounds.volume')}`}
                    onChange={(change) =>
                      updateCue(event, { volume: Number(change.target.value) / 100 }, false)
                    }
                    onPointerUp={() => playCue(event, cue, settings.volume)}
                  />
                </label>
              </div>
            </div>
          );
        })}

        <div className="settings-actions">
          <button type="button" onClick={() => setSoundSettings(DEFAULT_SOUND_SETTINGS)}>
            {t('updates.restoreDefaults')}
          </button>
        </div>
      </SettingsCard>

      <SoundboardSettingsSection />
      <EntranceSettingsSection />
    </>
  );
}

/** The soundboard's own volume and mute (ADR 0040), the same ones its panel has. */
function SoundboardSettingsSection() {
  const t = useT();
  const settings = useSoundboardSettings();
  const percent = Math.round(settings.volume * 100);
  const volumeRef = useWheelRange(stepSoundboardVolume);
  return (
    <SettingsCard id="settings-sounds-soundboard" title={t('soundboard.title')}>
      <p className="muted settings-card-note">{t('soundboard.settingsIntro')}</p>
      <SettingsToggle
        label={t('soundboard.muteAll')}
        checked={settings.muted}
        onChange={(muted) => soundboardSettings.set({ ...settings, muted })}
      />
      <label className="settings-field">
        <span>
          {t('soundboard.volume')} · {percent}%
        </span>
        <input
          ref={volumeRef}
          className="settings-range"
          type="range"
          min={0}
          max={100}
          step={1}
          value={percent}
          disabled={settings.muted}
          onChange={(event) =>
            soundboardSettings.set({ ...settings, volume: Number(event.target.value) / 100 })
          }
        />
      </label>
    </SettingsCard>
  );
}

const emptyConfig: UpdaterConfig = {
  repository: '',
  checkOnStartup: true,
  autoInstall: false,
};

function UpdatesSection() {
  const t = useT();
  const [config, setConfig] = useState<UpdaterConfig>(emptyConfig);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [canInstall, setCanInstall] = useState(false);
  const [installerUrl, setInstallerUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // tNow, not t: these run from callbacks, and depending on the language
  // would re-run the update check whenever it changed.
  const check = useCallback(async () => {
    if (updating) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    const [result, appVersion] = await Promise.all([
      window.zoia.updater.check(),
      window.zoia.app.version().catch(() => null),
    ]);
    if (appVersion) setCurrentVersion(appVersion);

    if (result.status === 'available') {
      setAvailableVersion(result.version);
      setInstallerUrl(null);
      setCanInstall(true);
      setMessage(tNow('updates.isAvailable', { version: result.version }));
    } else if (result.status === 'full-required') {
      setAvailableVersion(result.version);
      setInstallerUrl(result.installerUrl);
      setCanInstall(false);
      setMessage(tNow('updates.needsInstaller', { version: result.version }));
    } else if (result.status === 'up-to-date') {
      setAvailableVersion(appVersion);
      setInstallerUrl(null);
      setCanInstall(false);
      setMessage(tNow('updates.upToDate'));
    } else if (result.status === 'disabled') {
      setCanInstall(false);
      setMessage(tNow('updates.disabled'));
    } else {
      setCanInstall(false);
      setError(result.message);
    }
    setBusy(false);
  }, [updating]);

  useEffect(() => {
    window.zoia.app
      .version()
      .then(setCurrentVersion)
      .catch(() => {});
    window.zoia.updater
      .config()
      .then(setConfig)
      .catch(() => setError(tNow('updates.loadFailed')))
      .finally(() => setBusy(false));
    void check();
  }, [check]);

  function update(field: keyof UpdaterConfig, value: string | boolean) {
    setConfig((current) => ({ ...current, [field]: value }));
    setMessage(null);
    setError(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await window.zoia.updater.save(config);
      setConfig(saved);
      setMessage(t('updates.saved'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('updates.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setConfig(await window.zoia.updater.reset());
      setMessage(t('updates.restored'));
    } catch {
      setError(t('updates.restoreFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    setUpdating(true);
    setError(null);
    setMessage(t('updates.installing'));
    try {
      await window.zoia.updater.install();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('updates.installFailed'));
      setUpdating(false);
    }
  }

  return (
    <>
      <h3>{t('settings.nav.updates')}</h3>
      <SettingsCard id="settings-updates-version" title={t('updates.version')}>
        <div className="settings-version" aria-live="polite">
          <span>{t('updates.installed')}</span>
          <strong>{currentVersion ? `v${currentVersion}` : t('common.loading')}</strong>
          <span>{t('updates.available')}</span>
          <strong>{availableVersion ? `v${availableVersion}` : t('updates.notChecked')}</strong>
        </div>
        <p className="muted settings-card-note">{t('updates.body')}</p>

        {error && <p className="settings-error">{error}</p>}
        {message && <p className="settings-message">{message}</p>}

        {installerUrl && (
          <button
            className="primary settings-download"
            onClick={() =>
              void window.zoia.updater.openInstaller(installerUrl).catch(() => {
                setError(t('updates.openInstallerFailed'));
              })
            }
          >
            {t('updates.downloadInstaller')}
          </button>
        )}

        {canInstall && !installerUrl && (
          <button
            className="primary settings-download"
            onClick={() => void install()}
            disabled={busy || updating}
          >
            {updating ? t('updates.updating') : t('updates.updateNow')}
          </button>
        )}

        <div className="settings-actions">
          <button onClick={() => void check()} disabled={busy || updating}>
            {t('updates.checkNow')}
          </button>
        </div>
      </SettingsCard>

      <SettingsCard id="settings-updates-source" title={t('updates.source')}>
        <div className="settings-warning">{t('updates.warning')}</div>

        <label className="settings-field">
          <span>{t('updates.repository')}</span>
          <input
            value={config.repository}
            onChange={(event) => update('repository', event.target.value)}
            placeholder="https://github.com/owner/repository"
            disabled={busy || updating}
          />
        </label>

        <SettingsToggle
          label={t('updates.checkOnStart')}
          checked={config.checkOnStartup !== false}
          disabled={busy || updating}
          onChange={(checked) => update('checkOnStartup', checked)}
        />
        <SettingsToggle
          label={t('updates.autoInstall')}
          checked={config.autoInstall === true}
          disabled={busy || updating}
          onChange={(checked) => update('autoInstall', checked)}
        />

        <div className="settings-actions">
          <button onClick={() => void reset()} disabled={busy || updating}>
            {t('updates.restoreDefaults')}
          </button>
          <button className="primary" onClick={() => void save()} disabled={busy || updating}>
            {t('settings.save')}
          </button>
        </div>
      </SettingsCard>
    </>
  );
}

const REPOSITORY = 'https://github.com/caiomcg/zoia';

/** Who made this, in a line each. Links open in the real browser. */
const PEOPLE = [
  {
    name: 'Caio',
    handle: 'caiomcg',
    role: 'about.role.caio' as MessageKey,
  },
  {
    name: 'Nycholas',
    handle: 'nycholassousa',
    role: 'about.role.nycholas' as MessageKey,
  },
  {
    name: 'Victor',
    handle: 'Rotciv18',
    role: 'about.role.victor' as MessageKey,
  },
  {
    name: 'Flavia',
    handle: 'flaviaspassos',
    role: 'about.role.flavia' as MessageKey,
  },
  {
    name: 'Stefano',
    handle: 'stfn0',
    role: 'about.role.stefano' as MessageKey,
  },
  {
    name: 'Yure',
    handle: 'yuregl',
    role: 'about.role.yure' as MessageKey,
  },
  {
    name: 'Anderson',
    handle: 'Andchh',
    role: 'about.role.anderson' as MessageKey,
  },
  {
    name: 'Amon',
    handle: 'amonn3',
    role: 'about.role.amon' as MessageKey,
  },
];

/**
 * The avatar each person has on GitHub, read from GitHub when About opens.
 * The only remote images the page may load (see the CSP in index.html).
 */
function githubAvatar(handle: string): string {
  return `https://avatars.githubusercontent.com/${handle}?s=96`;
}

function AboutSection() {
  const t = useT();
  const [version, setVersion] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const notes = useExit(notesOpen);
  useEffect(() => {
    window.zoia.app
      .version()
      .then(setVersion)
      .catch(() => {});
  }, []);

  return (
    <div className="about">
      <div className="about-hero">
        <img className="about-logo" src="logo.png" alt="Zoia" draggable={false} />
        {version && (
          <button
            type="button"
            className="about-version"
            onClick={() => setNotesOpen(true)}
            title={t('about.versionNotes')}
          >
            v{version}
          </button>
        )}
      </div>

      <p className="about-lede">{t('about.lede')}</p>

      <a className="about-repo" href={REPOSITORY} target="_blank" rel="noreferrer">
        <IconGitHub />
        {t('about.github')}
      </a>

      <h3>{t('about.madeBy')}</h3>
      <ul className="about-people">
        {PEOPLE.map((person) => (
          <li key={person.handle}>
            <Avatar name={person.name} live={false} image={githubAvatar(person.handle)} />
            <div>
              <a href={`https://github.com/${person.handle}`} target="_blank" rel="noreferrer">
                {person.name}
              </a>
              <span className="muted"> @{person.handle}</span>
              <p>{t(person.role)}</p>
            </div>
          </li>
        ))}
      </ul>

      {notes.mounted && (
        <ReleaseNotesDialog closing={notes.closing} onClose={() => setNotesOpen(false)} />
      )}
    </div>
  );
}

function IconGitHub() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.3 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z" />
    </svg>
  );
}
