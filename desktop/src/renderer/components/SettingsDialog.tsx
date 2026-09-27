import { useEffect, useState } from 'react';
import type { UpdaterConfig } from '../../shared/ipc';

interface SettingsDialogProps {
  onClose: () => void;
}

const emptyConfig: UpdaterConfig = {
  repository: '',
  branch: '',
  manifestPath: '',
  checkOnStartup: true,
  autoInstall: false,
};

export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [config, setConfig] = useState<UpdaterConfig>(emptyConfig);
  const [closeToTray, setCloseToTray] = useState(true);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([window.zoia.updater.config(), window.zoia.tray.config()])
      .then(([updaterConfig, trayConfig]) => {
        setConfig(updaterConfig);
        setCloseToTray(trayConfig.closeToTray);
      })
      .catch(() => setError('Could not load settings.'))
      .finally(() => setBusy(false));
  }, []);

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
      const savedTray = await window.zoia.tray.save(closeToTray);
      setCloseToTray(savedTray.closeToTray);
      setMessage('Settings saved.');
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
      const savedTray = await window.zoia.tray.save(true);
      setCloseToTray(savedTray.closeToTray);
      setMessage('Default settings restored.');
    } catch {
      setError('Could not restore the default settings.');
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await window.zoia.updater.check();
    if (result.status === 'available') setMessage(`Version ${result.version} is available.`);
    else if (result.status === 'full-required') {
      setMessage(
        `Version ${result.version} requires the full installer. Open the release page to download it.`,
      );
    } else if (result.status === 'up-to-date') setMessage('You are up to date.');
    else if (result.status === 'disabled') setMessage('Updates are disabled for this build.');
    else setError(result.message);
    setBusy(false);
  }

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <section className="picker settings-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <div>
            <h2>Settings</h2>
            <p className="muted">Configure updates and what happens when you close Zoia.</p>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close settings"
            title="Close"
          >
            ×
          </button>
        </div>

        <div className="settings-warning">
          Only use a repository you trust. An update can run code on this computer.
        </div>

        <label className="settings-field">
          <span>Git repository</span>
          <input
            value={config.repository}
            onChange={(event) => update('repository', event.target.value)}
            placeholder="https://github.com/owner/repository"
            disabled={busy}
          />
        </label>
        <label className="settings-field">
          <span>Branch</span>
          <input
            value={config.branch}
            onChange={(event) => update('branch', event.target.value)}
            placeholder="main"
            disabled={busy}
          />
        </label>
        <label className="settings-field">
          <span>Manifest path</span>
          <input
            value={config.manifestPath}
            onChange={(event) => update('manifestPath', event.target.value)}
            placeholder="desktop/updater-manifest.json"
            disabled={busy}
          />
        </label>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={config.checkOnStartup !== false}
            onChange={(event) => update('checkOnStartup', event.target.checked)}
            disabled={busy}
          />
          Check for updates when Zoia starts
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={config.autoInstall === true}
            onChange={(event) => update('autoInstall', event.target.checked)}
            disabled={busy}
          />
          Install available updates automatically
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={closeToTray}
            onChange={(event) => {
              setCloseToTray(event.target.checked);
              setMessage(null);
              setError(null);
            }}
            disabled={busy}
          />
          Minimize to the system tray when closing Zoia
        </label>

        {error && <p className="settings-error">{error}</p>}
        {message && <p className="settings-message">{message}</p>}

        <div className="settings-actions">
          <button onClick={() => void reset()} disabled={busy}>
            Restore defaults
          </button>
          <button onClick={() => void check()} disabled={busy}>
            Check now
          </button>
          <button className="primary" onClick={() => void save()} disabled={busy}>
            Save
          </button>
        </div>
      </section>
    </div>
  );
}
