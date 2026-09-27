import { useCallback, useEffect, useState } from 'react';
import type { UpdaterConfig } from '../../shared/ipc';
import Avatar from './Avatar';

type Section = 'profile' | 'broadcast' | 'general' | 'updates' | 'about';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'broadcast', label: 'Broadcast' },
  { id: 'general', label: 'General' },
  { id: 'updates', label: 'Updates' },
  { id: 'about', label: 'About' },
];

interface SettingsDialogProps {
  onClose: () => void;
  myName: string;
  onRename: (name: string) => Promise<void>;
  /** Which encoder and card, or why there isn't one. */
  hardwareDetail: string;
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
  hardwareDetail,
}: SettingsDialogProps) {
  const [section, setSection] = useState<Section>('profile');

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <section
        className="picker settings-dialog"
        role="dialog"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-header">
          <h2>Settings</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close settings"
            title="Close"
          >
            ×
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={section === s.id ? 'active' : undefined}
                aria-current={section === s.id ? 'page' : undefined}
                onClick={() => setSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="settings-pane">
            {section === 'profile' && <ProfileSection myName={myName} onRename={onRename} />}
            {section === 'broadcast' && <BroadcastSection hardwareDetail={hardwareDetail} />}
            {section === 'general' && <GeneralSection />}
            {section === 'updates' && <UpdatesSection />}
            {section === 'about' && <AboutSection />}
          </div>
        </div>
      </section>
    </div>
  );
}

function ProfileSection({
  myName,
  onRename,
}: {
  myName: string;
  onRename: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(myName);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      setMessage('Saved. Everyone in the room sees the new name now.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>Profile</h3>
      <div className="settings-profile">
        <Avatar name={next || myName} live={false} />
        <p className="muted">
          This is how other people see you in the room and on your broadcasts.
        </p>
      </div>
      <label className="settings-field">
        <span>Display name</span>
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
            Save
          </button>
        </div>
      </label>
      {error && <p className="settings-error">{error}</p>}
      {message && <p className="settings-message">{message}</p>}
    </>
  );
}

function BroadcastSection({ hardwareDetail }: { hardwareDetail: string }) {
  return (
    <>
      <h3>Broadcast</h3>
      {/* Switched off for now: the GPU path is the one that has broken on
          other people's machines. Shown, so its absence is not a mystery. */}
      <label className="settings-check unavailable" title={hardwareDetail}>
        <input type="checkbox" checked={false} disabled readOnly />
        <span>
          Hardware acceleration
          <span className="settings-badge">Coming soon</span>
          <small>{hardwareDetail}</small>
        </span>
      </label>
    </>
  );
}

function GeneralSection() {
  // Applied as soon as it is toggled, like the same checkbox in the tray menu.
  const [closeToTray, setCloseToTray] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.zoia.tray
      .closeToTray()
      .then(setCloseToTray)
      .catch(() => {});
  }, []);

  async function toggleCloseToTray(value: boolean) {
    setCloseToTray(value);
    setError(null);
    try {
      setCloseToTray(await window.zoia.tray.setCloseToTray(value));
    } catch {
      setCloseToTray(!value);
      setError('Could not change the system tray setting.');
    }
  }

  return (
    <>
      <h3>General</h3>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={closeToTray}
          onChange={(event) => void toggleCloseToTray(event.target.checked)}
        />
        Keep Zoia in the system tray when the window is closed
      </label>
      {error && <p className="settings-error">{error}</p>}
    </>
  );
}

const emptyConfig: UpdaterConfig = {
  repository: '',
  branch: '',
  manifestPath: '',
  checkOnStartup: true,
  autoInstall: false,
};

function UpdatesSection() {
  const [config, setConfig] = useState<UpdaterConfig>(emptyConfig);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [canInstall, setCanInstall] = useState(false);
  const [installerUrl, setInstallerUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      setMessage(`Version ${result.version} is available.`);
    } else if (result.status === 'full-required') {
      setAvailableVersion(result.version);
      setInstallerUrl(result.installerUrl);
      setCanInstall(false);
      setMessage(`Version ${result.version} requires the full installer.`);
    } else if (result.status === 'up-to-date') {
      setAvailableVersion(appVersion);
      setInstallerUrl(null);
      setCanInstall(false);
      setMessage('You are up to date.');
    } else if (result.status === 'disabled') {
      setCanInstall(false);
      setMessage('Updates are disabled for this build.');
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
      .catch(() => setError('Could not load updater settings.'))
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
      setMessage('Saved. The new feed will be used on the next update check.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save updater settings.');
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
      setMessage('Default updater settings restored.');
    } catch {
      setError('Could not restore the default settings.');
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    setUpdating(true);
    setError(null);
    setMessage('Downloading and installing update…');
    try {
      await window.zoia.updater.install();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not install update.');
      setUpdating(false);
    }
  }

  return (
    <>
      <h3>Updates</h3>
      <div className="settings-version" aria-live="polite">
        <span>Installed version</span>
        <strong>{currentVersion ? `v${currentVersion}` : 'Loading…'}</strong>
        <span>Available version</span>
        <strong>{availableVersion ? `v${availableVersion}` : 'Not checked yet'}</strong>
      </div>
      <p className="muted">Choose where Zoia looks for lightweight application updates.</p>

      <div className="settings-warning">
        Only use a repository you trust. An update can run code on this computer.
      </div>

      <label className="settings-field">
        <span>Git repository</span>
        <input
          value={config.repository}
          onChange={(event) => update('repository', event.target.value)}
          placeholder="https://github.com/owner/repository"
          disabled={busy || updating}
        />
      </label>
      <label className="settings-field">
        <span>Branch</span>
        <input
          value={config.branch}
          onChange={(event) => update('branch', event.target.value)}
          placeholder="main"
          disabled={busy || updating}
        />
      </label>
      <label className="settings-field">
        <span>Manifest path</span>
        <input
          value={config.manifestPath}
          onChange={(event) => update('manifestPath', event.target.value)}
          placeholder="desktop/updater-manifest.json"
          disabled={busy || updating}
        />
      </label>

      <label className="settings-check">
        <input
          type="checkbox"
          checked={config.checkOnStartup !== false}
          onChange={(event) => update('checkOnStartup', event.target.checked)}
          disabled={busy || updating}
        />
        Check for updates when Zoia starts
      </label>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={config.autoInstall === true}
          onChange={(event) => update('autoInstall', event.target.checked)}
          disabled={busy || updating}
        />
        Install available updates automatically
      </label>

      {error && <p className="settings-error">{error}</p>}
      {message && <p className="settings-message">{message}</p>}

      {installerUrl && (
        <button
          className="primary settings-download"
          onClick={() =>
            void window.zoia.updater.openInstaller(installerUrl).catch(() => {
              setError('Could not open the installer download.');
            })
          }
        >
          Download installer
        </button>
      )}

      {canInstall && !installerUrl && (
        <button
          className="primary settings-download"
          onClick={() => void install()}
          disabled={busy || updating}
        >
          {updating ? 'Updating…' : 'Update now'}
        </button>
      )}

      <div className="settings-actions">
        <button onClick={() => void reset()} disabled={busy || updating}>
          Restore defaults
        </button>
        <button onClick={() => void check()} disabled={busy || updating}>
          Check now
        </button>
        <button className="primary" onClick={() => void save()} disabled={busy || updating}>
          Save
        </button>
      </div>
    </>
  );
}

const REPOSITORY = 'https://github.com/caiomcg/zoia';

/** Who made this, in a line each. Links open in the real browser. */
const PEOPLE = [
  {
    name: 'Caio',
    handle: 'caiomcg',
    role: 'Started Zoia: capture, channels and the server.',
  },
  {
    name: 'Nycholas',
    handle: 'nycholassousa',
    role: 'Updates, League hand-off and multi-stream viewing.',
  },
];

function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
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
        {version && <span className="about-version">v{version}</span>}
      </div>

      <p className="about-lede">
        Share a window, a screen or a camera with a few friends, with that app&rsquo;s own sound.
        Self-hosted, and open source.
      </p>

      <a className="about-repo" href={REPOSITORY} target="_blank" rel="noreferrer">
        <IconGitHub />
        View on GitHub
      </a>

      <h3>Made by</h3>
      <ul className="about-people">
        {PEOPLE.map((person) => (
          <li key={person.handle}>
            <Avatar name={person.name} live={false} />
            <div>
              <a href={`https://github.com/${person.handle}`} target="_blank" rel="noreferrer">
                {person.name}
              </a>
              <span className="muted"> @{person.handle}</span>
              <p>{person.role}</p>
            </div>
          </li>
        ))}
      </ul>
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
