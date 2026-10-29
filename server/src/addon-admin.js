/**
 * The super admin's addon routes, `/api/admin/addons` (ADR 0041): install an
 * addon from a GitHub repository, enable, disable, update and uninstall it,
 * set its settings, command names and chats, read its logs.
 *
 * Only the super admin, re-read on every request (AGENTS.md invariant 4).
 * Installing is trusting an addon's author with what it asks for, so it is
 * theirs alone, as the super admin is the one account nobody else can touch.
 *
 * A manifest is always read from GitHub by the server, never taken from the
 * app: what is installed is what the release says, at the moment of install.
 */

import express from 'express';

import { PERMISSIONS, REPO, effectiveSettings, shownSettings, validateManifest } from './addons.js';
import { botIdentity } from './token.js';

/** The release asset an addon publishes its manifest as. */
export const MANIFEST_ASSET = 'zoia-addon.json';
const MANIFEST_MAX_BYTES = 64 * 1024;

const ERRORS = {
  forbidden: 403,
  not_found: 404,
  no_release: 404,
  no_manifest: 404,
  installed: 409,
  needs_permissions: 409,
  release_changed: 409,
  up_to_date: 409,
  duplicate_command: 409,
  github_failed: 502,
  host_failed: 502,
  host_unreachable: 502,
  addons_off: 503,
};

const refuse = (res, reason, extra = {}) =>
  res.status(ERRORS[reason] ?? 400).json({ error: reason, ...extra });

/** `owner/name` from what was typed: that, or a github.com address. */
export function repoOf(input) {
  if (typeof input !== 'string') return null;
  const tidy = input
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  return REPO.test(tidy) ? tidy : null;
}

/**
 * The latest release of `repo` and its checked manifest. The image must be
 * under the same owner as the repository, so a release cannot hand over
 * somebody else's image under its own name.
 */
export async function readRelease(repo, { api, fetchImpl = fetch }) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'zoia-addons' };
  let release;
  try {
    const res = await fetchImpl(`${api}/repos/${repo}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return { ok: false, reason: 'no_release' };
    if (!res.ok) return { ok: false, reason: 'github_failed' };
    release = await res.json();
  } catch {
    return { ok: false, reason: 'github_failed' };
  }

  const asset = (release.assets ?? []).find((a) => a.name === MANIFEST_ASSET);
  if (!asset?.browser_download_url) return { ok: false, reason: 'no_manifest' };
  let raw;
  try {
    const res = await fetchImpl(asset.browser_download_url, {
      headers: { 'User-Agent': 'zoia-addons', Accept: 'application/octet-stream' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, reason: 'github_failed' };
    const text = await res.text();
    if (text.length > MANIFEST_MAX_BYTES) return { ok: false, reason: 'invalid_manifest' };
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_manifest' };
  }

  const checked = validateManifest(raw);
  if (!checked.ok) return checked;
  const owner = repo.split('/')[0].toLowerCase();
  if (checked.manifest.image.split('/')[1] !== owner) {
    return { ok: false, reason: 'invalid_manifest', field: 'image' };
  }
  return {
    ok: true,
    manifest: checked.manifest,
    release: {
      tag: release.tag_name ?? null,
      url: release.html_url ?? null,
      publishedAt: release.published_at ?? null,
    },
  };
}

/** Each permission with what it means, for the app to show before granting. */
const describe = (permissions) => permissions.map((p) => ({ id: p, description: PERMISSIONS[p] }));

/**
 * @param {object} options
 * @param {ReturnType<import('./addons.js').createAddonStore>} options.addons
 * @param {ReturnType<import('./addon-host.js').createAddonHostClient> | null} options.host
 * @param {ReturnType<import('./addon-routes.js').createAddonHub>} options.hub
 */
export function addonAdminRoutes({
  addons,
  host,
  hub,
  accountStore,
  channelSet,
  requireSession,
  githubApi = 'https://api.github.com',
  fetchImpl = fetch,
  logger = console,
}) {
  const router = express.Router();

  function requireSuper(req, res, next) {
    requireSession(req, res, (err) => {
      if (err) return next(err);
      if (req.user.role !== 'super_admin') return refuse(res, 'forbidden');
      next();
    });
  }
  router.use(requireSuper);

  const read = (repo) => readRelease(repo, { api: githubApi, fetchImpl });

  /** Takes an addon's bots out of every channel. */
  async function dropBots(addonId) {
    const identities = (await accountStore.botsOf(addonId)).map((b) => botIdentity(b.id));
    if (identities.length === 0) return;
    for (const channel of await channelSet.list()) {
      await channel.stage.disconnect?.(identities).catch(() => {});
    }
  }

  /** A fresh token, and the container (re)made with it from the addon's image. */
  async function launch(addon) {
    if (!host) return { ok: false, reason: 'addons_off' };
    const token = await addons.rotateToken(addon.id);
    // Whatever held the old token is cut off now.
    hub.close(addon.id);
    return host.run(addon.id, { image: addon.image, token });
  }

  /** An addon as the app shows it. */
  async function shown(addon) {
    const names = addons.commandNames(addon);
    return {
      id: addon.id,
      key: addon.key,
      repo: addon.repo,
      name: addon.name,
      version: addon.version,
      description: addon.manifest.description ?? null,
      enabled: addon.enabled,
      installedAt: addon.installedAt,
      updatedAt: addon.updatedAt,
      permissions: describe(addon.granted),
      commands: addon.manifest.commands.map((c) => ({
        ...c,
        command: c.name,
        name: names[c.name],
      })),
      settings: {
        schema: addon.manifest.settings,
        values: shownSettings(addon.manifest.settings, addon.settings),
      },
      chats: await addons.bindingsOf(addon.id),
      bots: (await accountStore.botsOf(addon.id)).map((b) => ({ id: b.id, name: b.name })),
      state: host ? await host.state(addon.id) : null,
    };
  }

  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      next(err);
    }
  };

  /** The addon the route names, or a refusal. */
  async function addonOf(req, res) {
    const addon = await addons.get(req.params.id);
    if (!addon) refuse(res, 'not_found');
    return addon;
  }

  router.get(
    '/',
    wrap(async (_req, res) => {
      const list = await addons.list();
      res.json({
        addons: await Promise.all(list.map(shown)),
        available: Boolean(host),
      });
    }),
  );

  // What installing would mean, before it is done: the release, and what the
  // addon asks for, to be read and agreed to.
  router.post(
    '/preview',
    wrap(async (req, res) => {
      const repo = repoOf(req.body?.repo);
      if (!repo) return refuse(res, 'invalid_repo');
      const found = await read(repo);
      if (!found.ok) return refuse(res, found.reason, found.field ? { field: found.field } : {});
      const { manifest, release } = found;
      res.json({
        repo,
        release,
        addon: {
          key: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description ?? null,
          image: manifest.image,
          permissions: describe(manifest.permissions),
          commands: manifest.commands,
        },
      });
    }),
  );

  // Installing what was previewed. The release is read again, and refused if
  // it changed since: what is agreed to is what is installed.
  router.post(
    '/',
    wrap(async (req, res) => {
      if (!host) return refuse(res, 'addons_off');
      const repo = repoOf(req.body?.repo);
      if (!repo) return refuse(res, 'invalid_repo');
      const found = await read(repo);
      if (!found.ok) return refuse(res, found.reason);
      if (found.manifest.version !== req.body?.version) return refuse(res, 'release_changed');

      const result = await addons.install({
        repo,
        manifest: found.manifest,
        by: req.user.accountId,
      });
      if (!result.ok) return refuse(res, result.reason);
      // Enabled before it starts, so its first request is not refused.
      const enabled = await addons.setEnabled(result.addon.id, true, { by: req.user.accountId });
      const ran = await host.run(result.addon.id, {
        image: result.addon.image,
        token: result.token,
      });
      if (!ran.ok) {
        // Installed but not running: the super admin sees it, and may retry.
        logger.warn(
          `[addon] ${result.addon.id} installed but not started: ${ran.message ?? ran.reason}`,
        );
        const off = await addons.setEnabled(result.addon.id, false, { by: req.user.accountId });
        return refuse(res, ran.reason, {
          message: ran.message ?? null,
          addon: await shown(off.addon),
        });
      }
      res.status(201).json({ addon: await shown(enabled.addon) });
    }),
  );

  router.post(
    '/:id/enable',
    wrap(async (req, res) => {
      const addon = await addonOf(req, res);
      if (!addon) return;
      const result = await addons.setEnabled(addon.id, true, { by: req.user.accountId });
      const ran = await launch(addon);
      if (!ran.ok) {
        await addons.setEnabled(addon.id, false, { by: req.user.accountId });
        return refuse(res, ran.reason, { message: ran.message ?? null });
      }
      res.json({ addon: await shown(result.addon) });
    }),
  );

  // Off at once, whatever the host says: the token is refused from now on,
  // the stream ends, the bots leave, and the container is asked to stop.
  router.post(
    '/:id/disable',
    wrap(async (req, res) => {
      const addon = await addonOf(req, res);
      if (!addon) return;
      const result = await addons.setEnabled(addon.id, false, { by: req.user.accountId });
      hub.close(addon.id);
      await dropBots(addon.id);
      const stopped = host ? await host.stop(addon.id) : { ok: true };
      if (!stopped.ok) logger.warn(`[addon] ${addon.id} disabled, but its container did not stop`);
      res.json({ addon: await shown(result.addon) });
    }),
  );

  router.post(
    '/:id/update',
    wrap(async (req, res) => {
      const addon = await addonOf(req, res);
      if (!addon) return;
      const found = await read(addon.repo);
      if (!found.ok) return refuse(res, found.reason);
      if (found.manifest.version === addon.version) return refuse(res, 'up_to_date');
      const result = await addons.upgrade(addon.id, found.manifest, {
        grant: req.body?.grant === true,
        by: req.user.accountId,
      });
      if (!result.ok) {
        return refuse(res, result.reason, result.added ? { added: describe(result.added) } : {});
      }
      if (result.addon.enabled) {
        const ran = await launch(result.addon);
        if (!ran.ok) return refuse(res, ran.reason, { message: ran.message ?? null });
      }
      res.json({ addon: await shown(result.addon) });
    }),
  );

  router.delete(
    '/:id',
    wrap(async (req, res) => {
      const addon = await addonOf(req, res);
      if (!addon) return;
      await addons.setEnabled(addon.id, false, { by: req.user.accountId });
      hub.close(addon.id);
      await dropBots(addon.id);
      if (host) await host.remove(addon.id);
      await addons.remove(addon.id, { by: req.user.accountId });
      res.json({ ok: true });
    }),
  );

  router.put(
    '/:id/settings',
    wrap(async (req, res) => {
      const addon = await addonOf(req, res);
      if (!addon) return;
      const result = await addons.setSettings(addon.id, req.body?.values);
      if (!result.ok) return refuse(res, result.reason, { field: result.field });
      hub.send(addon.id, 'settings', {
        settings: effectiveSettings(result.addon.manifest.settings, result.addon.settings),
      });
      res.json({ addon: await shown(result.addon) });
    }),
  );

  router.put(
    '/:id/commands',
    wrap(async (req, res) => {
      const addon = await addonOf(req, res);
      if (!addon) return;
      const result = await addons.setCommandNames(addon.id, req.body?.names);
      if (!result.ok) return refuse(res, result.reason, { field: result.field });
      hub.send(addon.id, 'commands', { commands: addons.commandNames(result.addon) });
      res.json({ addon: await shown(result.addon) });
    }),
  );

  router.put(
    '/:id/chats',
    wrap(async (req, res) => {
      const addon = await addonOf(req, res);
      if (!addon) return;
      const result = await addons.setBindings(addon.id, req.body?.chats);
      if (!result.ok) return refuse(res, result.reason);
      hub.send(addon.id, 'chats', { chats: result.chats });
      res.json({ addon: await shown(await addons.get(addon.id)) });
    }),
  );

  router.get(
    '/:id/logs',
    wrap(async (req, res) => {
      const addon = await addonOf(req, res);
      if (!addon) return;
      if (!host) return refuse(res, 'addons_off');
      const result = await host.logs(addon.id, Number(req.query.tail ?? 200));
      if (!result.ok) return refuse(res, result.reason, { message: result.message ?? null });
      res.json({ logs: result.logs });
    }),
  );

  return router;
}
