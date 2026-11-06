/**
 * Photos and videos in chats (ADR 0036), as the window shows them.
 *
 * The files need the session cookie, which lives in this process, and a
 * video needs Range requests to be scrubbed, which a data: URL cannot do. So
 * the window loads them from a scheme of its own, zoia-media://, and this
 * fetches each request from the server with the session, Range and all.
 * Saving one to disk goes the same way, after asking where.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  app,
  clipboard,
  ClipboardItem,
  dialog,
  nativeImage,
  net,
  protocol,
  type BrowserWindow,
} from 'electron';
import { CHAT_MEDIA_SCHEME, type ActionOutcome } from '../shared/ipc';
import { getServerUrl } from './config';
import { saveName } from './media-name';

/**
 * A chat's id, a direct chat's (ADR 0047), or a thread's in either (ADR 0048):
 * the chat's id, a tilde and the message the thread answers.
 */
const CHAT =
  '(?:[0-9a-f]{8}|dm-[0-9a-f]{16})(?:~[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})?';

/** zoia-media://file/<chat id>/<media id>; anything else is not asked for. */
const MEDIA_PATH = new RegExp(`^/(${CHAT})/([0-9a-f]{16})$`);
const CHAT_ID = new RegExp(`^${CHAT}$`);
const MEDIA_ID = /^[0-9a-f]{16}$/;

/**
 * Asks where to save a chat photo or video, then fetches it with the session
 * and writes it there. Resolves to whether it was saved; closing the dialog
 * is not a failure.
 */
export async function saveMedia(
  window: BrowserWindow | null,
  chatId: string,
  mediaId: string,
  name: string | null,
  type: string,
): Promise<ActionOutcome<{ saved: boolean }>> {
  const base = getServerUrl();
  if (!base || !CHAT_ID.test(chatId) || !MEDIA_ID.test(mediaId)) {
    return { ok: false, error: 'not_found' };
  }
  const options = { defaultPath: join(app.getPath('downloads'), saveName(name, mediaId, type)) };
  const choice = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options);
  if (choice.canceled || !choice.filePath) return { ok: true, value: { saved: false } };
  try {
    const response = await net.fetch(`${base}/api/chats/${chatId}/media/${mediaId}`, {
      credentials: 'include',
    });
    if (!response.ok) return { ok: false, error: `http_${response.status}` };
    await writeFile(choice.filePath, Buffer.from(await response.arrayBuffer()));
    return { ok: true, value: { saved: true } };
  } catch {
    return { ok: false, error: 'save_failed' };
  }
}

/**
 * Puts a chat photo on the clipboard, as the picture itself, to paste into
 * any app. Fetched here, signed in: the window's copy is on a scheme of its
 * own that a page cannot read back into a picture.
 */
export async function copyMedia(chatId: string, mediaId: string): Promise<ActionOutcome> {
  const base = getServerUrl();
  if (!base || !CHAT_ID.test(chatId) || !MEDIA_ID.test(mediaId)) {
    return { ok: false, error: 'not_found' };
  }
  try {
    const response = await net.fetch(`${base}/api/chats/${chatId}/media/${mediaId}`, {
      credentials: 'include',
    });
    if (!response.ok) return { ok: false, error: `http_${response.status}` };
    const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
    // PNG and JPEG decode here; a format that does not comes back empty.
    if (image.isEmpty()) return { ok: false, error: 'unsupported' };
    // As PNG, which every app pastes, whatever the photo was sent as.
    const png = new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' });
    await clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return { ok: true, value: undefined };
  } catch {
    return { ok: false, error: 'copy_failed' };
  }
}

/** Must run before the app is ready: a scheme's privileges are fixed at startup. */
export function registerMediaScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CHAT_MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

export function handleMediaScheme() {
  protocol.handle(CHAT_MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const match = url.hostname === 'file' ? MEDIA_PATH.exec(url.pathname) : null;
    const base = getServerUrl();
    if (!match || !base) return new Response(null, { status: 404 });
    const [, chatId, mediaId] = match;
    const range = request.headers.get('range');
    return net.fetch(`${base}/api/chats/${chatId}/media/${mediaId}`, {
      credentials: 'include',
      headers: range ? { range } : {},
    });
  });
}
