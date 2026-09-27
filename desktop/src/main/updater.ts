import { app, dialog } from 'electron';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const CONFIG_NAME = 'updater-config.json';
const STATE_NAME = 'updater-state.json';
const HELPER_NAME = 'zoia-update-helper.cjs';

interface UpdaterConfig {
  repository: string;
  branch: string;
  manifestPath: string;
  manifestUrl?: string;
  commitUrl?: string;
  checkOnStartup?: boolean;
  autoInstall?: boolean;
}

interface UpdateManifest {
  version: string;
  commit: string;
  artifactUrl: string;
  sha256: string;
  artifactType?: 'asar';
  notes?: string;
}

interface UpdateState {
  commit: string;
}

interface RemoteUpdate extends UpdateManifest {
  commit: string;
}

const HELPER_SOURCE = String.raw`const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

const [target, staged, backup, parentPid, executable, statePath, commit] = process.argv.slice(2);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = async (path) => { try { await fs.access(path); return true; } catch { return false; } };

async function parentExited() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { process.kill(Number(parentPid), 0); } catch { return true; }
    await wait(250);
  }
  throw new Error('Zoia did not exit in time');
}

async function main() {
  await parentExited();
  await fs.rename(target, backup).catch(() => {});
  try {
    await fs.rename(staged, target);
  } catch (error) {
    if (await exists(backup)) await fs.rename(backup, target).catch(() => {});
    throw error;
  }
  if (statePath && commit) await fs.writeFile(statePath, JSON.stringify({ commit }, null, 2));
  const child = spawn(executable, [], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  await wait(5000);
  await fs.rm(backup, { force: true }).catch(() => {});
}

main().catch(async (error) => {
  console.error('[zoia-updater]', error?.stack || error);
  if (await exists(backup) && !(await exists(target))) await fs.rename(backup, target).catch(() => {});
  process.exitCode = 1;
});
`;

function isUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function githubRepository(repository: string): { owner: string; name: string } | null {
  try {
    const url = new URL(repository);
    if (url.hostname !== 'github.com') return null;
    const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    const [owner, name] = parts;
    return owner && name ? { owner, name } : null;
  } catch {
    return null;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function loadConfig(): Promise<UpdaterConfig | null> {
  const configured = process.env.ZOIA_UPDATER_CONFIG;
  const candidates = [
    configured,
    join(app.getPath('userData'), CONFIG_NAME),
    join(dirname(process.execPath), CONFIG_NAME),
    join(app.getAppPath(), CONFIG_NAME),
  ].filter((path): path is string => Boolean(path));

  for (const path of candidates) {
    const config = await readJson<UpdaterConfig>(path);
    if (!config || typeof config.repository !== 'string' || typeof config.branch !== 'string') continue;
    if (!config.manifestPath && !config.manifestUrl) continue;
    return config;
  }
  return null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Zoia-Updater' } });
  if (!response.ok) throw new Error(`Updater request failed (${response.status})`);
  return (await response.json()) as T;
}

function githubUrls(config: UpdaterConfig): { manifestUrl: string; commitUrl: string } | null {
  const repo = githubRepository(config.repository);
  if (!repo) return null;
  const base = `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${encodeURIComponent(config.branch)}`;
  return {
    manifestUrl: `${base}/${config.manifestPath}`,
    commitUrl: `https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(config.branch)}`,
  };
}

async function getRemoteUpdate(config: UpdaterConfig): Promise<RemoteUpdate> {
  const urls = githubUrls(config);
  const manifestUrl = config.manifestUrl ?? urls?.manifestUrl;
  const commitUrl = config.commitUrl ?? urls?.commitUrl;
  if (!manifestUrl || !commitUrl || !isUrl(manifestUrl) || !isUrl(commitUrl)) {
    throw new Error('Updater requires HTTPS manifestUrl/commitUrl or a GitHub repository URL');
  }

  const [manifest, commitInfo] = await Promise.all([
    fetchJson<UpdateManifest>(manifestUrl),
    fetchJson<{ sha?: string }>(commitUrl),
  ]);
  const commit = commitInfo.sha ?? manifest.commit;
  if (!manifest.version || !manifest.artifactUrl || !manifest.sha256 || !commit) {
    throw new Error('Updater manifest is incomplete');
  }
  if (manifest.commit && manifest.commit !== commit) {
    throw new Error('Updater manifest does not match the branch commit');
  }
  if (manifest.artifactType && manifest.artifactType !== 'asar') {
    throw new Error('Only app.asar OTA artifacts are supported');
  }
  if (!isUrl(manifest.artifactUrl) || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
    throw new Error('Updater manifest contains an invalid artifact URL or SHA-256');
  }
  return { ...manifest, commit };
}

function newerVersion(remote: string, local: string): boolean {
  const parse = (value: string) => value.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(remote);
  const b = parse(local);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

async function downloadArtifact(url: string, expectedSha256: string, destination: string): Promise<void> {
  const response = await fetch(url, { headers: { 'user-agent': 'Zoia-Updater' } });
  if (!response.ok || !response.body) throw new Error(`Update download failed (${response.status})`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination, { flags: 'wx' }));
  const hash = createHash('sha256');
  const contents = await readFile(destination);
  hash.update(contents);
  if (hash.digest('hex').toLowerCase() !== expectedSha256.toLowerCase()) {
    await rm(destination, { force: true });
    throw new Error('Downloaded update failed SHA-256 verification');
  }
}

async function writeHelper(path: string): Promise<void> {
  await writeFile(path, HELPER_SOURCE, { encoding: 'utf8', mode: 0o600 });
}

async function install(update: RemoteUpdate): Promise<void> {
  if (!app.isPackaged) throw new Error('OTA updates are disabled in development builds');
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    throw new Error('OTA app.asar updates require the installed build; portable builds need a new exe');
  }

  const target = join(process.resourcesPath, 'app.asar');
  await access(target);
  const updateDir = join(app.getPath('userData'), 'updates', update.commit);
  await mkdir(updateDir, { recursive: true });
  const staged = join(updateDir, 'app.asar');
  const partial = `${staged}.partial`;
  const backup = `${target}.previous`;
  const helper = join(updateDir, HELPER_NAME);
  const statePath = join(app.getPath('userData'), STATE_NAME);
  await rm(partial, { force: true });
  await downloadArtifact(update.artifactUrl, update.sha256, partial);
  await rename(partial, staged);
  await writeHelper(helper);

  spawn(process.execPath, [helper, target, staged, backup, String(process.pid), process.execPath, statePath, update.commit], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).unref();
  app.quit();
}

export async function startUpdater(): Promise<void> {
  if (!app.isPackaged) return;
  const config = await loadConfig();
  if (!config || config.checkOnStartup === false) return;

  try {
    const update = await getRemoteUpdate(config);
    const state = await readJson<UpdateState>(join(app.getPath('userData'), STATE_NAME));
    if (state?.commit === update.commit) return;
    const versionUpgrade = newerVersion(update.version, app.getVersion());
    const commitUpgrade = Boolean(state?.commit && state.commit !== update.commit);
    if (!versionUpgrade && !commitUpgrade) return;

    if (!config.autoInstall) {
      const result = await dialog.showMessageBox({
        type: 'info',
        title: 'Atualização disponível',
        message: `A versão ${update.version} está disponível.`,
        detail: update.notes ?? 'O código da aplicação será atualizado sem baixar novamente o Electron.',
        buttons: ['Atualizar agora', 'Depois'],
        defaultId: 0,
        cancelId: 1,
      });
      if (result.response !== 0) return;
    }
    await install(update);
  } catch (error) {
    console.warn('[updater] update skipped:', error instanceof Error ? error.message : String(error));
  }
}
