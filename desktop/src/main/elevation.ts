/**
 * Whether Zoia runs as administrator, and reopening it as the user.
 *
 * Windows will not let an elevated Chromium capture a window: its sandbox
 * marks the elevated browser process so that Windows Graphics Capture
 * answers CreateForWindow with E_ACCESSDENIED, on the GPU path and
 * Chromium's alike. Zoia ends up elevated when someone runs it as
 * administrator, or when an update from before 0.14 reopened a Program
 * Files install from its elevated helper. Nothing inside an elevated
 * process gets around it, so the way out is to reopen Zoia unelevated.
 *
 * No Electron here, so the tests can load it.
 */

import { execFile, spawn } from 'node:child_process';

/** What a capture refused for lack of rights says, in every path's errors. */
export const ACCESS_DENIED = '0x80070005';

/**
 * Whether `whoami /groups` lists a High or System mandatory level: the
 * process runs as administrator. A normal one is Medium (S-1-16-8192).
 */
export function isElevatedGroups(output: string): boolean {
  return /\bS-1-16-(12288|16384)\b/.test(output);
}

let elevated: Promise<boolean> | null = null;

/** Asked once: elevation does not change while a process runs. */
export function isElevated(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  elevated ??= new Promise((resolve) => {
    execFile('whoami', ['/groups'], { windowsHide: true, timeout: 5000 }, (err, stdout) =>
      resolve(!err && isElevatedGroups(String(stdout))),
    );
  });
  return elevated;
}

/**
 * The PowerShell that waits for this Zoia to exit, then opens it again
 * through Explorer. Explorer hands the launch to the desktop's own shell,
 * which runs as the signed-in user, so the new Zoia is not elevated even
 * though this script is. It waits first because a second Zoia started
 * while this one holds the single-instance lock would close itself.
 */
export function unelevatedRestartScript(pid: number, executable: string): string {
  const exe = executable.replace(/'/g, "''");
  return [
    `Wait-Process -Id ${pid} -Timeout 60 -ErrorAction SilentlyContinue`,
    `Start-Process -FilePath explorer.exe -ArgumentList '"${exe}"'`,
  ].join('; ');
}

/** Starts the reopening, then hands over to `quit`, which must close Zoia. */
export function restartUnelevated(quit: () => void): void {
  spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      unelevatedRestartScript(process.pid, process.execPath),
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  ).unref();
  quit();
}
