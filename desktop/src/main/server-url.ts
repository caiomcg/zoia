/**
 * Checking a server address someone typed on the sign-in screen.
 *
 * Deliberately free of any `electron` import, so it is testable with
 * `node --test` directly: this is where a mistyped or hostile address meets
 * the app, and a password is about to follow it.
 */

/** Loopback only. See `normalizeServerUrl` for why this list is so short. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export class ServerUrlError extends Error {
  // Set explicitly: subclassing Error does not change `name`, so without this
  // every rejection reports itself as a plain "Error" in logs and crash
  // reports, which is exactly where telling the two apart matters.
  override name = 'ServerUrlError';
}

function fail(message: string): never {
  throw new ServerUrlError(message);
}

/**
 * The address as the app uses it: an origin with no trailing slash, so
 * `https://host/` and `https://host` behave identically — every caller
 * appends a path starting with `/`, and `https://host//api/login` is not the
 * same request. An address typed without a scheme is taken as https.
 *
 * Plain http is refused anywhere but this machine: the password, and every
 * later request carrying the session cookie, would cross the network in the
 * clear. Localhost is exempt so a server just started can be tried without
 * first arranging a certificate.
 */
export function normalizeServerUrl(raw: string): string {
  const typed = raw.trim();
  if (!typed) fail('No server address was given.');

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return fail(`"${typed}" is not a valid address. It should look like https://zoia.example.com`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail(`The server address must start with https://, not ${url.protocol}//`);
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    fail(
      `Refusing to use http:// for ${url.hostname}. Only https is allowed, except on localhost.`,
    );
  }
  if (url.search || url.hash || url.username || url.password) {
    fail('The server address should be a plain origin, with nothing after the host.');
  }

  return url.href.replace(/\/+$/, '');
}
