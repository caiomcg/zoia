import { useCallback, useEffect, useState } from 'react';
import type {
  AddonInfo,
  AddonOutcome,
  AddonPermission,
  AddonPreview,
  AddonSetting,
  AddonSettingValue,
} from '../../shared/ipc';
import type { MessageKey } from '../../shared/i18n';
import { useT } from '../i18n';
import { useConfirm } from './ConfirmDialog';

/** Refusals with words of their own; anything else is shown by its code. */
const ERRORS: Record<string, MessageKey> = {
  invalid_repo: 'addons.error.invalid_repo',
  no_release: 'addons.error.no_release',
  no_manifest: 'addons.error.no_manifest',
  invalid_manifest: 'addons.error.invalid_manifest',
  installed: 'addons.error.installed',
  github_failed: 'addons.error.github_failed',
  release_changed: 'addons.error.release_changed',
  up_to_date: 'addons.error.up_to_date',
  addons_off: 'addons.off',
  host_failed: 'addons.error.host_failed',
  host_unreachable: 'addons.error.host_unreachable',
  duplicate_command: 'addons.error.duplicate_command',
  invalid_commands: 'addons.error.invalid_commands',
  invalid_settings: 'addons.error.invalid_settings',
};

interface Option {
  id: string;
  name: string;
}

/**
 * Settings › Addons, for the super admin (ADR 0041): install an addon from a
 * GitHub repository, after reading what it asks to do; turn it on and off,
 * update and uninstall it; and set what it listens to, what its commands are
 * called, and its own settings, drawn from what its manifest declares. No
 * addon code runs here. The server checks every call again.
 */
export default function AddonsSection() {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const [addons, setAddons] = useState<AddonInfo[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [chats, setChats] = useState<Option[]>([]);
  const [channels, setChannels] = useState<Option[]>([]);
  const [error, setError] = useState<string | null>(null);

  const explain = useCallback(
    (outcome: Extract<AddonOutcome<unknown>, { ok: false }>) => {
      const key = ERRORS[outcome.error];
      const text = key
        ? t(key, { field: outcome.field ?? '?' })
        : t('admin.actionFailed', { code: outcome.error });
      return outcome.message
        ? `${text} ${t('addons.hostSaid', { message: outcome.message })}`
        : text;
    },
    [t],
  );

  const load = useCallback(async () => {
    const outcome = await window.zoia.addons.list();
    if (!outcome.ok) return setError(explain(outcome));
    setAddons(outcome.value.addons);
    setAvailable(outcome.value.available);
    setError(null);
  }, [explain]);

  useEffect(() => {
    void load();
    // What a chat or channel setting may name.
    void window.zoia.chat.list().then((outcome) => {
      if (outcome.ok) setChats(outcome.value.chats.map(({ id, name }) => ({ id, name })));
    });
    void window.zoia.rooms
      .list()
      .then((list) => setChannels(list.rooms.map(({ id, name }) => ({ id, name }))))
      .catch(() => {});
  }, [load]);

  /** Puts one addon's new state in the list. */
  const replace = (addon: AddonInfo) =>
    setAddons((list) => list?.map((a) => (a.id === addon.id ? addon : a)) ?? null);

  return (
    <>
      <h3>{t('settings.nav.addons')}</h3>
      <p className="muted">{t('addons.intro')}</p>
      {!available && <p className="settings-error">{t('addons.off')}</p>}
      {error && <p className="settings-error">{error}</p>}

      {available && <Installer explain={explain} onInstalled={() => void load()} />}

      <h4 className="settings-subheading">{t('addons.installed')}</h4>
      {addons === null && !error && <p className="muted">{t('common.loading')}</p>}
      {addons?.length === 0 && <p className="muted">{t('addons.none')}</p>}
      <ul className="addon-list">
        {addons?.map((addon) => (
          <AddonCard
            key={addon.id}
            addon={addon}
            chats={chats}
            channels={channels}
            explain={explain}
            onChanged={replace}
            onRemoved={() => setAddons((list) => list?.filter((a) => a.id !== addon.id) ?? null)}
            confirm={confirm}
          />
        ))}
      </ul>
      {dialog}
    </>
  );
}

type Explain = (outcome: Extract<AddonOutcome<unknown>, { ok: false }>) => string;

/** A repository, read from GitHub, shown, and only then installed. */
function Installer({ explain, onInstalled }: { explain: Explain; onInstalled: () => void }) {
  const t = useT();
  const [repo, setRepo] = useState('');
  const [preview, setPreview] = useState<AddonPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function find() {
    setBusy(true);
    setError(null);
    setPreview(null);
    const outcome = await window.zoia.addons.preview(repo.trim());
    setBusy(false);
    if (outcome.ok) setPreview(outcome.value);
    else setError(explain(outcome));
  }

  async function install() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    const outcome = await window.zoia.addons.install(preview.repo, preview.addon.version);
    setBusy(false);
    if (!outcome.ok) {
      setError(explain(outcome));
      // Installed but not started still shows in the list, off.
      onInstalled();
      return;
    }
    setPreview(null);
    setRepo('');
    onInstalled();
  }

  return (
    <div className="addon-installer">
      <form
        className="addon-repo"
        onSubmit={(event) => {
          event.preventDefault();
          if (repo.trim()) void find();
        }}
      >
        <label className="settings-field">
          {t('addons.repo')}
          <input
            value={repo}
            placeholder={t('addons.repoPlaceholder')}
            onChange={(event) => setRepo(event.target.value)}
            spellCheck={false}
          />
        </label>
        <button type="submit" disabled={busy || !repo.trim()}>
          {t('addons.find')}
        </button>
      </form>
      {error && <p className="settings-error">{error}</p>}
      {preview && (
        <div className="addon-review" role="group" aria-label={preview.addon.name}>
          <strong>
            {preview.addon.name} {preview.addon.version}
          </strong>
          {preview.addon.description && <p className="muted">{preview.addon.description}</p>}
          <p>{t('addons.asksTo')}</p>
          <Permissions list={preview.addon.permissions} />
          {preview.addon.commands.length > 0 && (
            <p className="muted">
              {t('addons.commands')}: {preview.addon.commands.map((c) => `!${c.name}`).join(', ')}
            </p>
          )}
          <p className="addon-trust">{t('addons.trust')}</p>
          <span className="admin-actions">
            <button type="button" disabled={busy} onClick={() => setPreview(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void install()}
            >
              {t('addons.install')}
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

function Permissions({ list }: { list: AddonPermission[] }) {
  const t = useT();
  if (list.length === 0) return <p className="muted">{t('addons.noPermissions')}</p>;
  return (
    <ul className="addon-permissions">
      {list.map((p) => (
        <li key={p.id}>
          <code>{p.id}</code> {p.description}
        </li>
      ))}
    </ul>
  );
}

function AddonCard({
  addon,
  chats,
  channels,
  explain,
  onChanged,
  onRemoved,
  confirm,
}: {
  addon: AddonInfo;
  chats: Option[];
  channels: Option[];
  explain: Explain;
  onChanged: (addon: AddonInfo) => void;
  onRemoved: () => void;
  confirm: (message: string, confirmLabel: string) => Promise<boolean>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);

  /** Runs one call, showing what it said, and takes the addon it answers with. */
  async function run<T>(call: () => Promise<AddonOutcome<T>>, done?: (value: T) => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const outcome = await call();
      if (!outcome.ok) {
        setError(explain(outcome));
        return outcome;
      }
      done?.(outcome.value);
      return outcome;
    } finally {
      setBusy(false);
    }
  }

  async function update() {
    const first = await run(() => window.zoia.addons.update(addon.id, false), onChanged);
    if (first.ok || first.error !== 'needs_permissions' || !first.added) return;
    const asked = first.added.map((p) => `• ${p.description}`).join('\n');
    if (
      !(await confirm(
        `${t('addons.grant', { name: addon.name })}\n\n${asked}`,
        t('addons.grantConfirm'),
      ))
    ) {
      setError(null);
      return;
    }
    await run(() => window.zoia.addons.update(addon.id, true), onChanged);
  }

  async function uninstall() {
    if (
      !(await confirm(t('addons.uninstallConfirm', { name: addon.name }), t('addons.uninstall')))
    ) {
      return;
    }
    const outcome = await run(() => window.zoia.addons.uninstall(addon.id));
    if (outcome.ok) onRemoved();
  }

  const state = !addon.enabled
    ? t('addons.state.off')
    : addon.state?.running
      ? t('addons.state.running')
      : t('addons.state.stopped');

  return (
    <li className={`addon-card${addon.enabled ? '' : ' off'}`}>
      <div className="addon-head">
        <button
          type="button"
          className="addon-title"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <strong>{addon.name}</strong>
          <span className="muted">
            {addon.version} · {addon.repo}
          </span>
          <span className={`settings-badge addon-state${addon.state?.running ? ' running' : ''}`}>
            {state}
          </span>
        </button>
        <span className="admin-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(
                () =>
                  addon.enabled
                    ? window.zoia.addons.disable(addon.id)
                    : window.zoia.addons.enable(addon.id),
                onChanged,
              )
            }
          >
            {addon.enabled ? t('addons.disable') : t('addons.enable')}
          </button>
          <button type="button" disabled={busy} onClick={() => void update()}>
            {t('addons.update')}
          </button>
          <button type="button" className="danger" disabled={busy} onClick={() => void uninstall()}>
            {t('addons.uninstall')}
          </button>
        </span>
      </div>
      {error && <p className="settings-error">{error}</p>}
      {notice && <p className="settings-message">{notice}</p>}

      {open && (
        <div className="addon-body">
          {addon.description && <p className="muted">{addon.description}</p>}

          <h5>{t('addons.permissions')}</h5>
          <Permissions list={addon.permissions} />

          <h5>{t('addons.chats')}</h5>
          <ul className="addon-chats">
            {chats.map((chat) => (
              <li key={chat.id}>
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={addon.chats.includes(chat.id)}
                    disabled={busy}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...addon.chats, chat.id]
                        : addon.chats.filter((c) => c !== chat.id);
                      void run(() => window.zoia.addons.chats(addon.id, next), onChanged);
                    }}
                  />
                  {chat.name}
                </label>
              </li>
            ))}
          </ul>

          {addon.commands.length > 0 && (
            <CommandNames
              addon={addon}
              busy={busy}
              onSave={(names) =>
                void run(
                  () => window.zoia.addons.commands(addon.id, names),
                  (value) => {
                    onChanged(value);
                    setNotice(t('addons.saved'));
                  },
                )
              }
            />
          )}

          {addon.settings.schema.length > 0 && (
            <SettingsForm
              schema={addon.settings.schema}
              values={addon.settings.values}
              chats={chats}
              channels={channels}
              busy={busy}
              onSave={(values) =>
                void run(
                  () => window.zoia.addons.settings(addon.id, values),
                  (value) => {
                    onChanged(value);
                    setNotice(t('addons.saved'));
                  },
                )
              }
            />
          )}

          <button
            type="button"
            className="addon-logs-toggle"
            onClick={() => {
              if (logs !== null) return setLogs(null);
              void run(
                () => window.zoia.addons.logs(addon.id),
                (text) => setLogs(text || '—'),
              );
            }}
          >
            {logs === null ? t('addons.logs') : t('addons.hideLogs')}
          </button>
          {logs !== null && <pre className="addon-logs">{logs}</pre>}
        </div>
      )}
    </li>
  );
}

/** What each command is typed as on this server, for everyone. */
function CommandNames({
  addon,
  busy,
  onSave,
}: {
  addon: AddonInfo;
  busy: boolean;
  onSave: (names: Record<string, string | null>) => void;
}) {
  const t = useT();
  const [names, setNames] = useState(() =>
    Object.fromEntries(addon.commands.map((c) => [c.command, c.name])),
  );
  return (
    <form
      className="addon-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(
          Object.fromEntries(
            addon.commands.map((c) => [c.command, names[c.command]?.trim() || null]),
          ),
        );
      }}
    >
      <h5>{t('addons.commands')}</h5>
      <p className="muted">{t('addons.commandsHint')}</p>
      {addon.commands.map((c) => (
        <label key={c.command} className="settings-field addon-command">
          <span>
            <code>!{c.command}</code> {c.description}
          </span>
          <span className="addon-command-input">
            <span aria-hidden="true">!</span>
            <input
              value={names[c.command] ?? ''}
              placeholder={c.command}
              spellCheck={false}
              onChange={(event) =>
                setNames((n) => ({ ...n, [c.command]: event.target.value.replace(/^!/, '') }))
              }
            />
          </span>
        </label>
      ))}
      <button type="submit" disabled={busy}>
        {t('addons.save')}
      </button>
    </form>
  );
}

/** An addon's own settings, drawn from the fields its manifest declares. */
function SettingsForm({
  schema,
  values,
  chats,
  channels,
  busy,
  onSave,
}: {
  schema: AddonSetting[];
  values: Record<string, AddonSettingValue>;
  chats: Option[];
  channels: Option[];
  busy: boolean;
  onSave: (values: Record<string, unknown>) => void;
}) {
  const t = useT();
  // Secrets start empty: an empty one is left as it is when saving.
  const [draft, setDraft] = useState<Record<string, string | number | boolean>>(() =>
    Object.fromEntries(
      schema.map((s) => {
        const value = values[s.key];
        if (s.type === 'secret' || typeof value === 'object') return [s.key, ''];
        return [s.key, value ?? (s.type === 'boolean' ? false : '')];
      }),
    ),
  );
  const set = (key: string, value: string | number | boolean) =>
    setDraft((d) => ({ ...d, [key]: value }));

  function submit() {
    const out: Record<string, unknown> = {};
    for (const s of schema) {
      const value = draft[s.key];
      if (s.type === 'secret') {
        if (value !== '') out[s.key] = value;
      } else if (s.type === 'number') {
        out[s.key] = value === '' ? null : Number(value);
      } else if (s.type === 'boolean') {
        out[s.key] = Boolean(value);
      } else {
        out[s.key] = value === '' ? null : value;
      }
    }
    onSave(out);
  }

  return (
    <form
      className="addon-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h5>{t('addons.settings')}</h5>
      {schema.map((s) => {
        const value = draft[s.key];
        const hint = s.description ? <small className="muted">{s.description}</small> : null;
        if (s.type === 'boolean') {
          return (
            <label key={s.key} className="settings-check">
              <input
                type="checkbox"
                checked={Boolean(value)}
                onChange={(event) => set(s.key, event.target.checked)}
              />
              {s.label}
              {hint}
            </label>
          );
        }
        const choices =
          s.type === 'select'
            ? (s.options ?? []).map((o) => ({ id: o.value, name: o.label }))
            : s.type === 'chat'
              ? chats
              : s.type === 'channel'
                ? channels
                : null;
        const secret = values[s.key];
        return (
          <label key={s.key} className="settings-field">
            {s.label}
            {choices ? (
              <select
                className="settings-select"
                value={String(value)}
                onChange={(event) => set(s.key, event.target.value)}
              >
                <option value="">{t('addons.choose')}</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={s.type === 'secret' ? 'password' : s.type === 'number' ? 'number' : 'text'}
                value={String(value)}
                min={s.min}
                max={s.max}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  s.type === 'secret'
                    ? typeof secret === 'object' && secret.set
                      ? t('addons.secretSet')
                      : t('addons.secretUnset')
                    : s.default !== undefined
                      ? String(s.default)
                      : undefined
                }
                onChange={(event) => set(s.key, event.target.value)}
              />
            )}
            {hint}
          </label>
        );
      })}
      <button type="submit" disabled={busy}>
        {t('addons.save')}
      </button>
    </form>
  );
}
