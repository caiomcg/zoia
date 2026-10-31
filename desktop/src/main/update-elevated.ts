/**
 * An update to an install the user cannot write (Program Files, ADR 0045)
 * swaps app.asar elevated. This is the PowerShell that does it from outside:
 * started by Zoia as the user, it asks Windows for the elevated swap and
 * waits for it, then reopens Zoia as the user.
 *
 * Waiting on the swap itself is the point. 0.14.0 waited a fixed two
 * minutes for it instead and reopened Zoia either way, so a prompt nobody
 * answered reopened the old version, which found the update again and
 * installed it again: a restart every two minutes.
 *
 * No Electron here, so the tests can load it.
 */

/** A single-quoted PowerShell string: a quote inside is doubled. */
function quoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function elevatedUpdateScript({
  pid,
  runner,
  executable,
}: {
  /** This Zoia, which must be gone before it is reopened. */
  pid: number;
  /** The batch file that runs the swap helper. */
  runner: string;
  executable: string;
}): string {
  // A refused prompt throws: nothing was swapped, and Zoia reopens at once
  // on the version it has.
  const args = quoted(`/c "${runner}"`);
  return [
    `try { Start-Process -FilePath $env:ComSpec -ArgumentList ${args} -Verb RunAs -WindowStyle Hidden -Wait } catch {}`,
    // A Zoia started while this one still holds the single-instance lock
    // would close itself.
    `Wait-Process -Id ${pid} -Timeout 60 -ErrorAction SilentlyContinue`,
    `Start-Process -FilePath ${quoted(executable)}`,
  ].join('; ');
}

/**
 * Whether to ask before installing rather than install on its own. An
 * automatic install of a version already attempted, which is offered again
 * because the attempt never landed, would only try the same thing again.
 */
export function askBeforeInstall(
  autoInstall: boolean,
  attempted: string | null,
  version: string,
): boolean {
  return !autoInstall || attempted === version;
}
