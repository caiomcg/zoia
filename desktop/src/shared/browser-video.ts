/**
 * Browsers whose videos can reach a broadcast as a black rectangle.
 *
 * With hardware acceleration on, a browser hands a playing video to
 * DirectComposition, and on some GPUs (seen on a Radeon RX 7800 XT) the
 * video then sits in a layer that Windows Graphics Capture does not see:
 * viewers get the screen with a black hole where the video is.
 *
 * Chromium browsers (Chrome, Edge) only stop doing that when started with
 * both flags in VIDEO_FLAGS; one alone was not enough for a 4K 60 fps video.
 * The flags are read only at startup and only from the command line, so a
 * running browser is judged by its main process's command line, and fixing
 * it means restarting it.
 *
 * Firefox takes no such flags. Its equivalents are preferences, kept in the
 * profile's prefs.js, and are written while it is closed (it rewrites that
 * file on exit). Whether Firefox shows the problem at all is not yet tested.
 *
 * Kept free of imports so `node --test` can load it directly.
 */

export type BrowserKind = 'chromium' | 'firefox';

export interface BrowserSpec {
  id: string;
  name: string;
  /** The executable's file name, lower case. */
  exe: string;
  kind: BrowserKind;
}

export const BROWSERS: readonly BrowserSpec[] = [
  { id: 'chrome', name: 'Google Chrome', exe: 'chrome.exe', kind: 'chromium' },
  { id: 'edge', name: 'Microsoft Edge', exe: 'msedge.exe', kind: 'chromium' },
  { id: 'firefox', name: 'Firefox', exe: 'firefox.exe', kind: 'firefox' },
];

export const VIDEO_FLAGS = [
  '--disable-direct-composition-video-overlays',
  '--disable-direct-composition',
] as const;

/** Reopens the tabs a Chromium browser had when it was closed for the fix. */
export const RESTORE_FLAG = '--restore-last-session';

/** Firefox's DirectComposition, as a whole and for video overlays, all off. */
export const FIREFOX_PREFS: Readonly<Record<string, boolean>> = {
  'gfx.webrender.dcomp-win.enabled': false,
  'gfx.webrender.dcomp-video-hw-overlay-win': false,
  'gfx.webrender.dcomp-video-sw-overlay-win': false,
};

/** Restores the session on the next start only; Firefox clears it after. */
export const FIREFOX_RESUME_ONCE = 'browser.sessionstore.resume_session_once';

export interface BrowserVideoStatus {
  id: string;
  name: string;
  kind: BrowserKind;
  /** Whether the browser's main process is running right now. */
  running: boolean;
  /** Running with the fix in place. False when not running. */
  ready: boolean;
}

export type BrowserVideoFix =
  | { ok: true; shortcutsUpdated: number }
  | { ok: false; reason: 'still-running' | 'not-found' | 'unsupported' | 'failed'; error?: string };

/**
 * Splits a Windows command line the way programs see their arguments, enough
 * to compare flags: whitespace separates them, double quotes group them.
 */
export function splitCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let any = false;
  for (const ch of commandLine) {
    if (ch === '"') {
      quoted = !quoted;
      any = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (any) args.push(current);
      current = '';
      any = false;
    } else {
      current += ch;
      any = true;
    }
  }
  if (any) args.push(current);
  return args;
}

/**
 * A browser runs one main process and many helpers. Chromium starts every
 * helper with a `--type=`; Firefox starts its content processes with
 * `-contentproc`.
 */
export function isMainProcess(commandLine: string, kind: BrowserKind = 'chromium'): boolean {
  const args = splitCommandLine(commandLine);
  if (kind === 'firefox') return !args.includes('-contentproc');
  return !args.some((arg) => arg.startsWith('--type='));
}

/**
 * The video flags a command line lacks. Compared whole, so the longer
 * `--disable-direct-composition-video-overlays` does not pass for
 * `--disable-direct-composition`; `--flag=value` counts as the flag.
 */
export function missingVideoFlags(commandLine: string): string[] {
  const present = new Set(splitCommandLine(commandLine).map((arg) => arg.split('=')[0]));
  return VIDEO_FLAGS.filter((flag) => !present.has(flag));
}

/** A shortcut's arguments with any missing video flags appended; null if none are missing. */
export function argumentsWithVideoFlags(args: string): string | null {
  const missing = missingVideoFlags(args);
  if (missing.length === 0) return null;
  return [args.trim(), ...missing].filter(Boolean).join(' ');
}

/**
 * The profiles Firefox opens by default, as paths relative to its data
 * folder (or absolute, when profiles.ini says so). Each installation names
 * its own in an `[Install…]` section; older files mark one `Default=1`.
 */
export function defaultFirefoxProfiles(profilesIni: string): Array<{
  path: string;
  relative: boolean;
}> {
  const sections: Array<{ name: string; values: Record<string, string> }> = [];
  for (const raw of profilesIni.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header?.[1]) {
      sections.push({ name: header[1], values: {} });
    } else if (sections.length > 0 && line.includes('=')) {
      const at = line.indexOf('=');
      sections[sections.length - 1]!.values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  }
  const profiles = sections.filter((s) => /^Profile\d+$/.test(s.name));
  const relativeOf = (path: string) =>
    profiles.find((p) => p.values.Path === path)?.values.IsRelative !== '0';

  const installs = sections
    .filter((s) => s.name.startsWith('Install') && s.values.Default)
    .map((s) => s.values.Default as string);
  const chosen =
    installs.length > 0
      ? installs
      : profiles
          .filter((p) => p.values.Default === '1' && p.values.Path)
          .map((p) => p.values.Path!);
  return [...new Set(chosen)].map((path) => ({ path, relative: relativeOf(path) }));
}

const PREF_LINE = /^\s*user_pref\(\s*"([^"]+)"\s*,\s*(.*?)\s*\)\s*;\s*$/;

/** The FIREFOX_PREFS a prefs.js does not set as wanted. An unset pref keeps Firefox's default (on). */
export function missingFirefoxPrefs(prefsJs: string): string[] {
  const values = new Map<string, string>();
  for (const line of prefsJs.split(/\r?\n/)) {
    const match = PREF_LINE.exec(line);
    if (match?.[1] && match[2] !== undefined) values.set(match[1], match[2]);
  }
  return Object.entries(FIREFOX_PREFS)
    .filter(([name, wanted]) => values.get(name) !== String(wanted))
    .map(([name]) => name);
}

/** prefs.js with each of `prefs` set: an existing line replaced, a new one appended. */
export function prefsJsWith(prefsJs: string, prefs: Record<string, boolean>): string {
  const remaining = new Map(Object.entries(prefs));
  const lines = prefsJs.split(/\r?\n/).map((line) => {
    const name = PREF_LINE.exec(line)?.[1];
    if (name === undefined || !remaining.has(name)) return line;
    const value = remaining.get(name);
    remaining.delete(name);
    return `user_pref("${name}", ${value});`;
  });
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const [name, value] of remaining) lines.push(`user_pref("${name}", ${value});`);
  return `${lines.join('\n')}\n`;
}

/** A shortcut's arguments with the video flags taken out; null if it had none. */
export function argumentsWithoutVideoFlags(args: string): string | null {
  const drop = new Set<string>(VIDEO_FLAGS);
  const kept = args.split(/\s+/).filter((arg) => arg && !drop.has(arg));
  const stripped = kept.join(' ');
  return stripped === args.trim().split(/\s+/).filter(Boolean).join(' ') ? null : stripped;
}

/** prefs.js without the lines that set any of `names`, so Firefox's defaults apply again. */
export function prefsJsWithout(prefsJs: string, names: readonly string[]): string {
  const drop = new Set(names);
  const lines = prefsJs.split(/\r?\n/).filter((line) => {
    const name = PREF_LINE.exec(line)?.[1];
    return name === undefined || !drop.has(name);
  });
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}
