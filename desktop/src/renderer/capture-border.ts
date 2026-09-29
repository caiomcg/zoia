/**
 * Whether Windows 11 outlines a shared window in yellow while Zoia captures
 * it natively (hardware acceleration). Off unless turned on in Settings ›
 * Broadcast: the outline is a reminder on the sharer's own screen, and a
 * distraction over a game. Stored per machine, like the other broadcast
 * settings.
 */

const STORAGE_KEY = 'zoia.captureBorder';

export function captureBorderEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setCaptureBorderEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // Remembering is a convenience; the choice still applies until restart.
  }
}
