/**
 * "System default" says which device that is right now, since the default
 * moves when a device is plugged in or out. While Zoia holds on to the device
 * it had instead of following Windows onto one just plugged in
 * (device-watch.ts), it names the held one: that is what is in use.
 */

import type { T } from '../i18n';
import { defaultDeviceName } from './settings';
import { heldDeviceName } from './device-watch';
import type { AudioKind } from './device-hold';

export function systemDefaultLabel(
  t: T,
  devices: readonly { deviceId: string; label: string }[],
  kind: AudioKind,
): string {
  const name = heldDeviceName(kind) || defaultDeviceName(devices);
  return name ? t('voiceSettings.systemDefaultNamed', { name }) : t('voiceSettings.systemDefault');
}
