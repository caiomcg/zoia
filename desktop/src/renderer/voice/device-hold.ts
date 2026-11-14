/**
 * Plugging in a headset makes Windows switch its default devices to it, and
 * Zoia, following the default, used to go with it unasked: the call moved to
 * a headset still in its case. Now a default that moves to a device that has
 * just appeared is held off: Zoia keeps the device it had and asks
 * (device-watch.ts). A default that moves because the old device went away
 * is followed at once: there is nothing else to keep.
 *
 * Kept free of imports so `node --test` can load it directly.
 */

export type AudioKind = 'audioinput' | 'audiooutput';

/** What enumerateDevices lists, as far as choosing a device goes. */
export interface Listed {
  kind: string;
  deviceId: string;
  groupId: string;
  label: string;
}

/** Chromium's stand-ins for whatever the system default is. */
const ALIASES = new Set(['default', 'communications']);

/** The real device the system default points at, or null. */
export function defaultDevice(devices: readonly Listed[], kind: AudioKind): Listed | null {
  const alias = devices.find((d) => d.kind === kind && d.deviceId === 'default');
  if (!alias) return null;
  return (
    devices.find(
      (d) => d.kind === kind && !ALIASES.has(d.deviceId) && d.groupId === alias.groupId,
    ) ?? null
  );
}

/**
 * The default moved onto a device that was not there before, while the one it
 * was on is still there: `from` is what to keep using, `to` what to offer.
 * Null for any other change, and on the first listing, when nothing moved.
 */
export function newDefault(
  before: readonly Listed[] | null,
  after: readonly Listed[],
  kind: AudioKind,
): { from: Listed; to: Listed } | null {
  if (!before) return null;
  const from = defaultDevice(before, kind);
  const to = defaultDevice(after, kind);
  if (!from || !to || from.deviceId === to.deviceId) return null;
  const isNew = !before.some((d) => d.kind === kind && d.deviceId === to.deviceId);
  const fromStays = after.some((d) => d.kind === kind && d.deviceId === from.deviceId);
  return isNew && fromStays ? { from, to } : null;
}

/**
 * The device to use for a kind: the one chosen in Settings while it is plugged
 * in; else the one held while the person decides, while it is plugged in;
 * else '' (the system default).
 */
export function deviceToUse(
  chosen: string,
  held: string,
  devices: readonly Listed[],
  kind: AudioKind,
): string {
  const present = (id: string) => devices.some((d) => d.kind === kind && d.deviceId === id);
  if (chosen) return present(chosen) ? chosen : '';
  return held && present(held) ? held : '';
}
