#!/usr/bin/env node
/**
 * Copies the LiveKit browser SDK into server/public/vendor.
 *
 * The client is served from our own origin rather than a CDN: this app exists
 * to gate access, and a third-party script tag in that path would be able to
 * read the session it protects. Vendoring also means it keeps working when the
 * CDN does not.
 */

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Resolve through the package's "exports" map — livekit-client does not expose
// its package.json as a subpath, so requiring that directly fails.
const entry = fileURLToPath(import.meta.resolve('livekit-client'));
const pkgRoot = dirname(dirname(entry));
const { version } = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'));

const destDir = 'server/public/vendor';
const dest = join(destDir, 'livekit-client.esm.mjs');

await mkdir(destDir, { recursive: true });
await copyFile(entry, dest);

console.log(`vendored livekit-client ${version} -> ${dest}`);
