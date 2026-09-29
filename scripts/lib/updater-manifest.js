/**
 * The updater manifest, `desktop/updater-manifest.json`, for a published
 * release. Installed apps read it from `main` to learn there is an update; see
 * docs/DISTRIBUTING.md and desktop/src/main/updater.ts.
 *
 * Built from the assets actually attached to the release, so the manifest can
 * never point at a file the release does not have, or carry a checksum of a
 * file other than the one people download.
 *
 * It carries no `commit`: the updater rejects a manifest whose commit is not
 * the branch head, and `main` moves on after the release.
 */

/**
 * @param {{
 *   version: string,
 *   repository: string,
 *   updateType: string,
 *   minimumVersion?: string | null,
 *   assets: Record<string, string>,
 *   notes?: string | null,
 * }} release  `assets` maps each attached file name to its SHA-256.
 */
export function buildManifest({ version, repository, updateType, minimumVersion, assets, notes }) {
  const download = (name) =>
    `https://github.com/${repository}/releases/download/v${version}/${name}`;

  const installer = `Zoia-Setup-${version}-x64.exe`;
  if (!assets[installer]) throw new Error(`The release has no ${installer}`);

  const manifest = { version, updateType };
  if (updateType === 'asar') {
    const ota = `Zoia-OTA-${version}.asar`;
    if (!assets[ota]) throw new Error(`An asar release needs ${ota} attached`);
    // Without it an install older than the last full release would be handed
    // an app.asar built for an Electron and native addon it does not have.
    if (!minimumVersion) throw new Error('An asar release needs a minimum version');
    manifest.minimumVersion = minimumVersion;
    manifest.artifactUrl = download(ota);
    manifest.sha256 = assets[ota];
  } else if (updateType !== 'full') {
    throw new Error(`No manifest for a "${updateType}" release`);
  }
  manifest.installerUrl = download(installer);
  if (notes) manifest.notes = notes;
  return manifest;
}

/** Numeric x.y.z comparison; enough for the tags this repo makes. */
export function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}
