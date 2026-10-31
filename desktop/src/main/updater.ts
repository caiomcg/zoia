import { app, dialog, shell } from 'electron';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { t } from './language';
import type { ReleaseInfo } from '../shared/ipc';
import { checkUpdateFile, updateAssetUrl } from './update-release';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const CONFIG_NAME = 'updater-config.json';
const STATE_NAME = 'updater-state.json';
const HELPER_NAME = 'zoia-update-helper.cjs';
const RELAUNCHER_NAME = 'zoia-update-relauncher.cjs';

/**
 * Where updates come from: a GitHub repository, whose latest release carries
 * an `update.json` written by the release workflow beside its installer and
 * OTA archive. Settings from older versions also held a branch and a manifest
 * path on it; they are ignored.
 */
export interface UpdaterConfig {
  repository: string;
  checkOnStartup?: boolean;
  autoInstall?: boolean;
}

interface UpdateManifest {
  version: string;
  updateType?: 'asar' | 'full';
  /**
   * The oldest installed version an `asar` update may be applied to: the last
   * full release. The OTA replaces app.asar only, so an install older than
   * that would run new code against an Electron, FFmpeg or native addon it
   * was not built for. Such an install is sent to `installerUrl` instead.
   */
  minimumVersion?: string;
  artifactUrl?: string;
  sha256?: string;
  installerUrl?: string;
  notes?: string;
}

type RemoteUpdate = UpdateManifest;

export type UpdaterCheckResult =
  | { status: 'up-to-date' }
  | { status: 'available'; version: string; notes: string | null }
  | { status: 'full-required'; version: string; installerUrl: string; notes: string | null }
  | { status: 'disabled' }
  | { status: 'error'; message: string };

/**
 * Swaps app.asar once Zoia has exited, then reopens it when `relaunch` is
 * "1". An install the user cannot write to (Program Files) runs this
 * elevated, and anything it opened would be elevated too: there it only
 * swaps, and the relauncher below, started by Zoia as the user, reopens it.
 * Either way `donePath` is written at the end, success or not.
 */
const HELPER_SOURCE = String.raw`process.noAsar = true;
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

const [target, staged, backup, parentPid, executable, statePath, version, relaunch, donePath] =
  process.argv.slice(2);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = async (path) => { try { await fs.access(path); return true; } catch { return false; } };

async function parentExited() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    // Only ESRCH means it is gone: EPERM is a process that is there but
    // will not be signalled, and swapping under it fails.
    try { process.kill(Number(parentPid), 0); } catch (error) { if (error && error.code === 'ESRCH') return true; }
    await wait(250);
  }
  throw new Error('Zoia did not exit in time');
}

// Something else can still hold the archive for a moment: an antivirus scan,
// or a Zoia process that is slow to go.
async function retry(action) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await action(); } catch (error) {
      if (attempt >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(error && error.code)) throw error;
      await wait(250);
    }
  }
}

async function main() {
  await parentExited();
  await fs.rm(backup, { force: true }).catch(() => {});
  if (await exists(target)) await retry(() => fs.rename(target, backup));
  try {
    await retry(() => fs.rename(staged, target));
  } catch (error) {
    if (await exists(backup)) await fs.rename(backup, target).catch(() => {});
    throw error;
  }
  if (statePath && version) await fs.writeFile(statePath, JSON.stringify({ version }, null, 2));
}

async function finish(swapped) {
  if (donePath) await fs.writeFile(donePath, swapped ? 'ok' : 'failed').catch(() => {});
  // Reopened whether or not the swap worked: the old version is still there.
  if (relaunch === '1') {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(executable, [], { detached: true, stdio: 'ignore', env }).unref();
  }
  if (swapped) {
    await wait(5000);
    await fs.rm(backup, { force: true }).catch(() => {});
  }
}

main().then(() => finish(true), async (error) => {
  console.error('[zoia-updater]', error?.stack || error);
  try {
    const errorLog = require('node:path').join(__dirname, 'update-error.log');
    await fs.writeFile(errorLog, String(error?.stack || error), 'utf8');
  } catch {}
  if (await exists(backup) && !(await exists(target))) await fs.rename(backup, target).catch(() => {});
  process.exitCode = 1;
  await finish(false);
});
`;

/**
 * Started by Zoia itself, so as the user, beside an elevated swap: reopens
 * Zoia once the swap is done. A cancelled elevation prompt never writes
 * `donePath`, so after a while it reopens the old version anyway.
 */
const RELAUNCHER_SOURCE = String.raw`process.noAsar = true;
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

const [donePath, executable] = process.argv.slice(2);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  for (let attempt = 0; attempt < 480; attempt += 1) {
    try { await fs.access(donePath); break; } catch { await wait(250); }
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(executable, [], { detached: true, stdio: 'ignore', env }).unref();
}

main();
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
    const parts = url.pathname
      .replace(/\.git$/, '')
      .split('/')
      .filter(Boolean);
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
    if (!config || typeof config.repository !== 'string') continue;
    return {
      repository: config.repository,
      checkOnStartup: config.checkOnStartup !== false,
      autoInstall: config.autoInstall === true,
    };
  }
  return null;
}

const defaultConfig: UpdaterConfig = {
  repository: 'https://github.com/caiomcg/zoia',
  checkOnStartup: true,
  autoInstall: false,
};

function userConfigPath(): string {
  return join(app.getPath('userData'), CONFIG_NAME);
}

function validateConfig(input: unknown): UpdaterConfig {
  if (!input || typeof input !== 'object') throw new Error('Configuration must be an object');
  const value = input as Partial<UpdaterConfig>;
  if (!isUrl(value.repository) || !githubRepository(value.repository)) {
    throw new Error(
      'Repository must be a GitHub repository URL, such as https://github.com/owner/zoia',
    );
  }
  return {
    repository: value.repository,
    checkOnStartup: value.checkOnStartup !== false,
    autoInstall: value.autoInstall === true,
  };
}

export async function getUpdaterConfig(): Promise<UpdaterConfig> {
  return (await loadConfig()) ?? defaultConfig;
}

export async function saveUpdaterConfig(input: unknown): Promise<UpdaterConfig> {
  const config = validateConfig(input);
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(userConfigPath(), JSON.stringify(config, null, 2), 'utf8');
  return config;
}

export async function resetUpdaterConfig(): Promise<UpdaterConfig> {
  await rm(userConfigPath(), { force: true });
  return (await loadConfig()) ?? defaultConfig;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Zoia-Updater',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
    },
  });
  if (!response.ok) throw new Error(`Updater request failed (${response.status})`);
  return (await response.json()) as T;
}

/**
 * The latest release and what its update.json says about it. `latest` skips
 * drafts and pre-releases, so a release is offered only once it is published.
 * One API call per check; the asset itself comes from the download host,
 * which does not count against the API's hourly limit.
 */
async function getRemoteUpdate(config: UpdaterConfig): Promise<RemoteUpdate> {
  const repo = githubRepository(config.repository);
  if (!repo) throw new Error('Updates need a GitHub repository in the update settings');

  const release = await fetchJson<GitHubRelease>(
    `https://api.github.com/repos/${repo.owner}/${repo.name}/releases/latest`,
  );
  const manifest = checkUpdateFile(
    release,
    repo,
    await fetchJson<UpdateManifest>(updateAssetUrl(release)),
  );

  const updateType = manifest.updateType ?? 'asar';
  if (updateType === 'asar') {
    if (
      !manifest.artifactUrl ||
      !manifest.sha256 ||
      !isUrl(manifest.artifactUrl) ||
      !/^[a-f0-9]{64}$/i.test(manifest.sha256)
    ) {
      throw new Error('Updater manifest contains an invalid OTA artifact URL or SHA-256');
    }
  } else if (updateType === 'full') {
    if (!manifest.installerUrl || !isUrl(manifest.installerUrl)) {
      throw new Error('Full update manifest contains an invalid installer URL');
    }
  } else {
    throw new Error('Updater manifest has an unknown update type');
  }
  if (process.platform === 'darwin') {
    // The OTA swap is Windows plumbing throughout (a .bat runner, elevate.exe,
    // PowerShell), and replacing app.asar inside a signed .app would break its
    // seal. The manifest's installer is the Windows .exe. So a Mac is always
    // sent to the release page, where the .dmg sits beside it.
    return { ...manifest, updateType: 'full', installerUrl: release.html_url };
  }
  if (
    updateType === 'asar' &&
    manifest.minimumVersion &&
    newerVersion(manifest.minimumVersion, app.getVersion())
  ) {
    // Refused rather than applied without the installer to fall back on: a
    // mismatched app.asar can fail to start at all, and then the updater
    // that would fix it never runs again.
    if (!manifest.installerUrl || !isUrl(manifest.installerUrl)) {
      throw new Error(
        `This update needs Zoia ${manifest.minimumVersion} or newer, and the manifest has no installer URL`,
      );
    }
    return { ...manifest, updateType: 'full' };
  }
  return manifest;
}

function newerVersion(remote: string, local: string): boolean {
  const parse = (value: string) =>
    value
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(remote);
  const b = parse(local);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

async function withNoAsar<T>(action: () => Promise<T>): Promise<T> {
  const proc = process as unknown as { noAsar?: boolean };
  const prev = proc.noAsar;
  proc.noAsar = true;
  try {
    return await action();
  } finally {
    proc.noAsar = prev;
  }
}

async function downloadArtifact(
  url: string,
  expectedSha256: string,
  destination: string,
): Promise<void> {
  const response = await fetch(url, { headers: { 'user-agent': 'Zoia-Updater' } });
  if (!response.ok || !response.body)
    throw new Error(`Update download failed (${response.status})`);
  await withNoAsar(async () => {
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(destination, { flags: 'w' }),
    );
    const hash = createHash('sha256');
    const contents = await readFile(destination);
    hash.update(contents);
    if (hash.digest('hex').toLowerCase() !== expectedSha256.toLowerCase()) {
      await rm(destination, { force: true });
      throw new Error('Downloaded update failed SHA-256 verification');
    }
  });
}

async function writeHelper(path: string, source = HELPER_SOURCE): Promise<void> {
  await writeFile(path, source, { encoding: 'utf8', mode: 0o600 });
}

async function isWritableDirectory(dir: string): Promise<boolean> {
  const probe = join(dir, `.probe-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    await withNoAsar(async () => {
      await writeFile(probe, '');
      await rm(probe, { force: true });
    });
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  return withNoAsar(async () => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  });
}

async function writeRunner(
  path: string,
  args: {
    executable: string;
    helper: string;
    target: string;
    staged: string;
    backup: string;
    pid: number;
    statePath: string;
    version: string;
    donePath: string;
  },
): Promise<void> {
  // Relaunch "0": this runs elevated, and the relauncher reopens Zoia as the user.
  const content = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${args.executable}" "${args.helper}" "${args.target}" "${args.staged}" "${args.backup}" "${args.pid}" "${args.executable}" "${args.statePath}" "${args.version}" "0" "${args.donePath}"\r\n`;
  await writeFile(path, content, { encoding: 'utf8' });
}

async function install(update: RemoteUpdate): Promise<void> {
  if (update.updateType === 'full' || !update.artifactUrl || !update.sha256) {
    throw new Error('This release requires the full installer');
  }
  if (!app.isPackaged) throw new Error('OTA updates are disabled in development builds');
  const target = join(process.resourcesPath, 'app.asar');
  if (!(await fileExists(target))) {
    throw new Error(`Target archive not found: ${target}`);
  }

  const writable = await isWritableDirectory(process.resourcesPath);
  const elevatePath = join(process.resourcesPath, 'elevate.exe');

  const updateDir = join(app.getPath('userData'), 'updates', `v${update.version}`);
  const staged = join(updateDir, 'update.bin');
  const partial = `${staged}.partial`;
  const backup = `${target}.previous`;
  const helper = join(updateDir, HELPER_NAME);
  const runner = join(updateDir, 'zoia-update-runner.bat');
  const relauncher = join(updateDir, RELAUNCHER_NAME);
  const donePath = join(updateDir, 'update-done');
  const statePath = join(app.getPath('userData'), STATE_NAME);

  await withNoAsar(async () => {
    await mkdir(updateDir, { recursive: true });
    await rm(join(updateDir, 'app.asar'), { force: true }).catch(() => {});
    await rm(join(updateDir, 'app.asar.partial'), { force: true }).catch(() => {});
    await rm(partial, { force: true }).catch(() => {});
    await rm(staged, { force: true }).catch(() => {});
    await rm(donePath, { force: true }).catch(() => {});
  });

  await downloadArtifact(update.artifactUrl, update.sha256, partial);

  await withNoAsar(async () => {
    await rename(partial, staged);
  });

  await writeHelper(helper);

  if (writable) {
    spawn(
      process.execPath,
      [
        helper,
        target,
        staged,
        backup,
        String(process.pid),
        process.execPath,
        statePath,
        update.version,
        '1',
        donePath,
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    ).unref();
  } else {
    await writeRunner(runner, {
      executable: process.execPath,
      helper,
      target,
      staged,
      backup,
      pid: process.pid,
      statePath,
      version: update.version,
      donePath,
    });
    await writeHelper(relauncher, RELAUNCHER_SOURCE);
    spawn(process.execPath, [relauncher, donePath, process.execPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }).unref();
    if (await fileExists(elevatePath)) {
      spawn(elevatePath, [process.env.ComSpec || 'cmd.exe', '/c', runner], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else {
      spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Start-Process -FilePath "${process.env.ComSpec || 'cmd.exe'}" -ArgumentList '/c "${runner}"' -Verb RunAs -WindowStyle Hidden`,
        ],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        },
      ).unref();
    }
  }
  app.quit();
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  assets?: { name: string; browser_download_url: string }[];
}

/**
 * Kept for the session: a release's notes do not change once it is out, and
 * GitHub allows 60 unauthenticated API calls an hour, shared with the update
 * check. Only a success is kept, so a failed read can be retried.
 */
let notesCache: ReleaseInfo | null = null;

/**
 * The GitHub release of the running version, for the notes shown after an
 * update and from Settings → About. Null when that version was never
 * published as a release (a local build, say).
 */
export async function currentReleaseNotes(): Promise<ReleaseInfo | null> {
  if (notesCache) return notesCache;
  const config = await loadConfig();
  const repo = config ? githubRepository(config.repository) : null;
  if (!repo) throw new Error('Release notes need a GitHub repository in the update settings');
  const tag = `v${app.getVersion()}`;
  let release: GitHubRelease;
  try {
    release = await fetchJson<GitHubRelease>(
      `https://api.github.com/repos/${repo.owner}/${repo.name}/releases/tags/${encodeURIComponent(tag)}`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('(404)')) return null;
    throw error;
  }
  if (release.draft) return null;
  notesCache = {
    version: release.tag_name.replace(/^v/, ''),
    title: release.name || release.tag_name,
    publishedAt: release.published_at,
    notes: release.body ?? '',
    url: release.html_url,
  };
  return notesCache;
}

export async function checkForUpdate(force = false): Promise<UpdaterCheckResult> {
  if (!app.isPackaged) return { status: 'disabled' };
  const config = await loadConfig();
  if (!config || (!force && config.checkOnStartup === false)) return { status: 'disabled' };
  try {
    const update = await getRemoteUpdate(config);
    // The version alone decides.
    if (!newerVersion(update.version, app.getVersion())) return { status: 'up-to-date' };
    if (update.updateType === 'full') {
      return {
        status: 'full-required',
        version: update.version,
        installerUrl: update.installerUrl!,
        notes: update.notes ?? null,
      };
    }
    return { status: 'available', version: update.version, notes: update.notes ?? null };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
let updateInterval: NodeJS.Timeout | null = null;
let inFlightUpdate: Promise<void> | null = null;
let inFlightInstall: Promise<void> | null = null;
let dismissedVersion: string | null = null;

export async function runUpdateCheck(force = false): Promise<void> {
  if (!app.isPackaged) return;
  if (inFlightInstall) return inFlightInstall;
  if (inFlightUpdate) return inFlightUpdate;

  inFlightUpdate = (async () => {
    const config = await loadConfig();
    if (!config || (!force && config.checkOnStartup === false)) return;

    let userConfirmed = false;
    try {
      const update = await getRemoteUpdate(config);
      if (!newerVersion(update.version, app.getVersion())) return;

      if (!force && dismissedVersion === update.version) return;

      if (update.updateType === 'full') {
        const result = await dialog.showMessageBox({
          type: 'info',
          title: t('update.fullTitle'),
          message: t('update.fullMessage', { version: update.version }),
          detail: update.notes ?? t('update.fullDetail'),
          buttons: [t('update.openDownload'), t('common.later')],
          defaultId: 0,
          cancelId: 1,
        });
        if (result.response === 0 && update.installerUrl) {
          await shell.openExternal(update.installerUrl);
        } else {
          dismissedVersion = update.version;
        }
        return;
      }

      if (!config.autoInstall) {
        const result = await dialog.showMessageBox({
          type: 'info',
          title: t('update.availableTitle'),
          message: t('update.availableMessage', { version: update.version }),
          detail: update.notes ?? t('update.availableDetail'),
          buttons: [t('update.updateNow'), t('common.later')],
          defaultId: 0,
          cancelId: 1,
        });
        if (result.response !== 0) {
          dismissedVersion = update.version;
          return;
        }
        userConfirmed = true;
      }
      await install(update);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[updater] update check failed:', message);
      if (force || userConfirmed) {
        await dialog.showMessageBox({
          type: 'error',
          title: t('update.failedTitle'),
          message: t('update.failedMessage'),
          detail: message,
          buttons: [t('common.ok')],
        });
      }
    }
  })().finally(() => {
    inFlightUpdate = null;
  });

  return inFlightUpdate;
}

export async function installCurrentUpdate(): Promise<void> {
  if (!app.isPackaged) {
    throw new Error('OTA updates are disabled in development builds');
  }
  if (inFlightInstall) return inFlightInstall;
  if (inFlightUpdate) {
    await inFlightUpdate;
  }

  inFlightInstall = (async () => {
    const config = await loadConfig();
    if (!config) throw new Error('Updater configuration not found');
    const update = await getRemoteUpdate(config);
    if (!newerVersion(update.version, app.getVersion())) {
      throw new Error(`Zoia is already on ${app.getVersion()}`);
    }
    if (update.updateType === 'full' || !update.artifactUrl || !update.sha256) {
      throw new Error('This release requires the full installer');
    }
    await install(update);
  })().finally(() => {
    inFlightInstall = null;
  });

  return inFlightInstall;
}

export async function startUpdater(): Promise<void> {
  if (updateInterval) clearInterval(updateInterval);
  updateInterval = setInterval(() => {
    void runUpdateCheck(false);
  }, UPDATE_CHECK_INTERVAL_MS);
  return runUpdateCheck(false);
}

export function stopUpdater(): void {
  if (updateInterval) clearInterval(updateInterval);
  updateInterval = null;
}
