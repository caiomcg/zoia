/**
 * "System default" says which device that is right now, since the default
 * moves when a device is plugged in or out.
 */

import type { T } from '../i18n';
import { defaultDeviceName } from './settings';

export function systemDefaultLabel(
  t: T,
  devices: readonly { deviceId: string; label: string }[],
): string {
  const name = defaultDeviceName(devices);
  return name ? t('voiceSettings.systemDefaultNamed', { name }) : t('voiceSettings.systemDefault');
}
