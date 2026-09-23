/**
 * Parsing and validating a `zoia-invite.json`.
 *
 * Deliberately free of any `electron` import, and of any knowledge of where
 * invites live on disk — callers hand it a string, it hands back a verdict.
 * That keeps it testable with `node --test` directly, which matters because
 * this is the one place a hostile or mistyped file meets the app.
 *
 * The invite is not a secret store. It is an *invitation*: the pairing token
 * inside it is spent once for a per-device credential and is capped and
 * revocable server-side (see docs/adr/0007-device-pairing.md). What this
 * module guards against is not theft of the token but the app being pointed
 * somewhere it should not go.
 */

export interface Invite {
  serverUrl: string;
  pairingToken: string;
}

/**
 * Mirrors `parseCredential` in server/src/store.js: an 8-hex id and a
 * base64url secret of at least 32 characters. Checking the shape here means a
 * mistyped token fails immediately, with a message about the token, rather
 * than as an opaque 401 after a round trip.
 */
const TOKEN_PATTERN = /^zpair_[0-9a-f]{8}_[A-Za-z0-9_-]{32,}$/;

/** Loopback only. See `assertUsableUrl` for why this list is so short. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export class InviteError extends Error {
  // Set explicitly: subclassing Error does not change `name`, so without this
  // every rejection reports itself as a plain "Error" in logs and crash
  // reports, which is exactly where telling the two apart matters.
  override name = 'InviteError';
}

function fail(message: string): never {
  throw new InviteError(message);
}

/**
 * Returns the URL with any trailing slashes removed, so `https://host/` and
 * `https://host` behave identically — every call site concatenates a path
 * beginning with `/`, and `https://host//api/pair` is not the same request.
 */
function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(`"${raw}" is not a valid URL. It should look like https://zoia.example.com`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail(`The server URL must start with https://, not ${url.protocol}//`);
  }

  // Plaintext is refused anywhere but loopback. This invite arrived from
  // somewhere else, and honouring an http:// URL in it would mean a device
  // credential — and every later request carrying the session cookie —
  // crossing the network in the clear, at the choosing of whoever wrote the
  // file. Localhost is exempt so somebody can try the server they just
  // started without first arranging a certificate.
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    fail(
      `Refusing to use http:// for ${url.hostname}. ` +
        'An invite may only use https, except on localhost.',
    );
  }

  if (url.search || url.hash) {
    fail('The server URL should be a plain origin, with no query string or fragment.');
  }

  return url.href.replace(/\/+$/, '');
}

/**
 * Parses the contents of an invite file. Throws `InviteError` with a message
 * meant to be shown to the person holding the file, naming the actual problem
 * — "invalid invite" with no detail is the error people send screenshots of.
 */
export function parseInvite(contents: string): Invite {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    fail('This file is not valid JSON. It may have been altered in transit.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('An invite should be a JSON object with serverUrl and pairingToken.');
  }

  const { serverUrl, pairingToken } = parsed as Record<string, unknown>;

  if (typeof serverUrl !== 'string' || serverUrl.trim() === '') {
    fail('This invite has no serverUrl, so there is nothing to connect to.');
  }
  if (typeof pairingToken !== 'string' || pairingToken.trim() === '') {
    fail('This invite has no pairingToken, so it cannot pair anything.');
  }

  const token = pairingToken.trim();
  if (!TOKEN_PATTERN.test(token)) {
    fail('The pairing token in this invite is not in the expected format.');
  }

  return { serverUrl: normalizeUrl(serverUrl.trim()), pairingToken: token };
}

/** The filename looked for beside the executable and in the app's data dir. */
export const INVITE_FILENAME = 'zoia-invite.json';
