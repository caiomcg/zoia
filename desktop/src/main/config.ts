/**
 * Where this copy of Zoia points, and what it may use to get in.
 *
 * Both used to be compiled into the binary. They no longer are, because a
 * published binary is public: a token inside one is a public token, and a
 * hostname inside one is a public hostname. Worse, the repository is public
 * and documented for self-hosting, so whoever downloads a release runs *their
 * own* server — a binary wired to one deployment is useless to them.
 *
 * So a release build knows nothing, and an invite file supplies both at
 * runtime. See docs/adr/0010-invites-outside-the-binary.md.
 *
 * The compiled-in values are still honoured, last, so `make-exe.bat` can keep
 * producing a build that pairs with no file to hand over.
 */

import { app } from 'electron';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { INVITE_FILENAME, InviteError, parseInvite, type Invite } from './invite';

export type ConfigSource = 'environment' | 'invite' | 'credential' | 'embedded' | 'none';

interface Resolved {
  serverUrl: string | null;
  pairingToken: string | null;
  source: ConfigSource;
  /** Where the invite was read from, for messages. Never contains the token. */
  invitePath: string | null;
  /** A malformed invite that was found but rejected, to show the user. */
  error: string | null;
}

let current: Resolved = {
  serverUrl: null,
  pairingToken: null,
  source: 'none',
  invitePath: null,
  error: null,
};

/**
 * Every directory an invite might sit in, most specific first.
 *
 * PORTABLE_EXECUTABLE_DIR is set by electron-builder's portable target and is
 * the folder the exe was launched from — not the temporary directory it
 * unpacks itself into, which is what process.execPath reports for a portable
 * build and which is wiped on exit.
 */
function searchDirs(): string[] {
  const dirs = [process.env.PORTABLE_EXECUTABLE_DIR, dirname(process.execPath), userDataDir()];
  return dirs.filter((dir): dir is string => Boolean(dir));
}

function userDataDir(): string {
  return app.getPath('userData');
}

/** The copy an import writes, so placement stops being the user's problem. */
function storedInvitePath(): string {
  return join(userDataDir(), INVITE_FILENAME);
}

async function readInviteFrom(path: string): Promise<Invite | null> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  // A file that exists but does not parse is reported rather than skipped:
  // silently moving on to the next directory would leave somebody staring at
  // an invite they can see, being told there is no invite.
  return parseInvite(contents);
}

/**
 * Resolves configuration once, at startup, before anything talks to a server.
 * A stored credential can still override the URL afterwards — see
 * `useCredentialServer`.
 */
export async function init(): Promise<void> {
  const envUrl = process.env.ZOIA_SERVER_URL;
  const envToken = process.env.ZOIA_PAIRING_TOKEN;
  if (envUrl) {
    current = {
      serverUrl: envUrl.replace(/\/+$/, ''),
      pairingToken: envToken ?? null,
      source: 'environment',
      invitePath: null,
      error: null,
    };
    return;
  }

  for (const dir of searchDirs()) {
    const path = join(dir, INVITE_FILENAME);
    try {
      const invite = await readInviteFrom(path);
      if (!invite) continue;
      current = {
        serverUrl: invite.serverUrl,
        pairingToken: invite.pairingToken,
        source: 'invite',
        invitePath: path,
        error: null,
      };
      return;
    } catch (err) {
      if (err instanceof InviteError) {
        current = {
          serverUrl: null,
          pairingToken: null,
          source: 'none',
          invitePath: path,
          error: err.message,
        };
        return;
      }
      throw err;
    }
  }

  // Nothing on disk. A build made by make-exe.bat carries its own. Both are
  // required: a published build has neither, and an empty URL is not a server.
  if (__ZOIA_PAIRING_TOKEN__ && __ZOIA_SERVER_URL__) {
    current = {
      serverUrl: __ZOIA_SERVER_URL__.replace(/\/+$/, ''),
      pairingToken: __ZOIA_PAIRING_TOKEN__,
      source: 'embedded',
      invitePath: null,
      error: null,
    };
  }
}

/**
 * Validates an invite the user chose by hand and adopts it, copying it into
 * the app's own directory so the next launch finds it without the file having
 * to stay where it was. Throws `InviteError` with a message worth showing.
 */
export async function importInvite(sourcePath: string): Promise<void> {
  const contents = await readFile(sourcePath, 'utf8');
  const invite = parseInvite(contents);

  const destination = storedInvitePath();
  await mkdir(dirname(destination), { recursive: true });
  // Copied rather than rewritten from the parsed object: whatever else the
  // operator put in the file is theirs, and round-tripping it through
  // JSON.stringify would quietly discard it.
  if (sourcePath !== destination) await copyFile(sourcePath, destination);

  current = {
    serverUrl: invite.serverUrl,
    pairingToken: invite.pairingToken,
    source: 'invite',
    invitePath: destination,
    error: null,
  };
}

/**
 * Adopts the server a stored credential was paired against. That credential is
 * only valid at that server, so once a machine is paired its own record is the
 * authority — ahead of any invite still lying next to the exe.
 */
export function useCredentialServer(serverUrl: string): void {
  current = { ...current, serverUrl: serverUrl.replace(/\/+$/, ''), source: 'credential' };
}

export function getServerUrl(): string | null {
  return current.serverUrl;
}

export function getPairingToken(): string | null {
  return current.pairingToken;
}

/** Everything the UI is allowed to know. Deliberately excludes the token. */
export function describe(): {
  serverUrl: string | null;
  source: ConfigSource;
  hasPairingToken: boolean;
  invitePath: string | null;
  error: string | null;
} {
  return {
    serverUrl: current.serverUrl,
    source: current.source,
    hasPairingToken: Boolean(current.pairingToken),
    invitePath: current.invitePath,
    error: current.error,
  };
}
