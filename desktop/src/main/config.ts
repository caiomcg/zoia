/**
 * Which server this copy of Zoia talks to.
 *
 * Nothing secret is configured anywhere: people sign in with an account
 * (ADR 0031), so all a copy needs is the address, and the sign-in screen asks
 * for it. What is resolved here is only where that field starts, and, once
 * signed in, which server the stored credential belongs to.
 */

export type ConfigSource = 'environment' | 'credential' | 'typed' | 'embedded' | 'none';

let current: { serverUrl: string | null; source: ConfigSource } = {
  serverUrl: null,
  source: 'none',
};

/**
 * Resolves the starting address, at startup, before anything talks to a
 * server: the environment (for `npm run dev`), else one compiled into the
 * build (make-exe.bat with ZOIA_SERVER_URL set), else none — a published
 * release, whose sign-in screen starts empty. A stored credential overrides
 * it afterwards; see `useCredentialServer`.
 */
export async function init(): Promise<void> {
  const fromEnvironment = process.env.ZOIA_SERVER_URL;
  if (fromEnvironment) {
    current = { serverUrl: fromEnvironment.replace(/\/+$/, ''), source: 'environment' };
  } else if (__ZOIA_SERVER_URL__) {
    current = { serverUrl: __ZOIA_SERVER_URL__.replace(/\/+$/, ''), source: 'embedded' };
  }
}

/**
 * Adopts the server a stored credential was issued by. It is only valid
 * there, so once a machine is signed in its own record is the authority.
 */
export function useCredentialServer(serverUrl: string): void {
  current = { serverUrl: serverUrl.replace(/\/+$/, ''), source: 'credential' };
}

/**
 * Adopts an address typed on the sign-in screen, already checked by
 * `normalizeServerUrl`. It is kept with the credential once a sign-in
 * succeeds, which is what makes it stick across launches.
 */
export function useTypedServer(serverUrl: string): void {
  current = { serverUrl, source: 'typed' };
}

export function getServerUrl(): string | null {
  return current.serverUrl;
}
