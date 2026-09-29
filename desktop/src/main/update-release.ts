/**
 * What the updater trusts from a GitHub release: its update.json, written by
 * the release workflow, and only if it describes that very release. Kept free
 * of Electron so it can be tested on its own (test/update-release.test.ts).
 */

/** The release asset that says what kind of update a release is. */
export const UPDATE_ASSET = 'update.json';

export interface ReleaseAssets {
  tag_name: string;
  assets?: { name: string; browser_download_url: string }[];
}

export interface Repository {
  owner: string;
  name: string;
}

/** Where to fetch the release's update.json, or why it cannot be. */
export function updateAssetUrl(release: ReleaseAssets): string {
  const asset = release.assets?.find((candidate) => candidate.name === UPDATE_ASSET);
  if (!asset || !asset.browser_download_url.startsWith('https://')) {
    throw new Error(`The latest release (${release.tag_name}) has no ${UPDATE_ASSET}`);
  }
  return asset.browser_download_url;
}

/**
 * Refuses an update.json that describes another version, or that points at
 * files outside its own release: it is published with the release, and
 * nothing it names should come from anywhere else.
 */
export function checkUpdateFile<
  T extends { version?: string; artifactUrl?: string; installerUrl?: string },
>(release: ReleaseAssets, repo: Repository, update: T): T & { version: string } {
  const tag = release.tag_name.replace(/^v/, '');
  if (!update.version || update.version.replace(/^v/, '') !== tag) {
    throw new Error(`${UPDATE_ASSET} does not match its release (${release.tag_name})`);
  }
  const prefix = `https://github.com/${repo.owner}/${repo.name}/releases/download/${release.tag_name}/`;
  const own = (url: string | undefined) => url === undefined || url.startsWith(prefix);
  if (!own(update.artifactUrl) || !own(update.installerUrl)) {
    throw new Error(`${UPDATE_ASSET} names files outside its release`);
  }
  return update as T & { version: string };
}
