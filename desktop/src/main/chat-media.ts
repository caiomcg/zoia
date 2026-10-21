/**
 * Photos and videos in chats (ADR 0035), as the window shows them.
 *
 * The files need the session cookie, which lives in this process, and a
 * video needs Range requests to be scrubbed, which a data: URL cannot do. So
 * the window loads them from a scheme of its own, zoia-media://, and this
 * fetches each request from the server with the session, Range and all.
 */

import { protocol, net } from 'electron';
import { CHAT_MEDIA_SCHEME } from '../shared/ipc';
import { getServerUrl } from './config';

/** zoia-media://file/<chat id>/<media id>; anything else is not asked for. */
const MEDIA_PATH = /^\/([0-9a-f]{8})\/([0-9a-f]{16})$/;

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
