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
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.zoia.updater
      .config()
      .then(setConfig)
      .catch(() => setError('Could not load updater settings.'))
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

  async function check() {
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = await window.zoia.updater.check();
    if (result.status === 'available') setMessage(`Version ${result.version} is available.`);
    else if (result.status === 'up-to-date') setMessage('You are up to date.');
    else if (result.status === 'disabled') setMessage('Updates are disabled for this build.');
    else setError(result.message);
    setBusy(false);
  }

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <section className="picker settings-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <div>
            <h2>Update settings</h2>
            <p className="muted">Choose where Zoia looks for lightweight application updates.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings" title="Close">
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
