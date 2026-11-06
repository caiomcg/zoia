import { useEffect, useRef } from 'react';
import { notify, type NotifyTarget } from '../notify/notify';
import { useT } from '../i18n';

export interface BellAlert {
  /** What it is about; a new text under the same key is told again. */
  key: string;
  text: string | null | undefined;
  tone?: 'error' | 'warn';
  action?: { target: NotifyTarget; label: string };
  /** Called once it is told, for a message that is cleared rather than kept. */
  onTold?: () => void;
}

/**
 * The app's errors and warnings, said under the bell instead of as banners
 * over the window. Each is told once while it stands; when it clears, the
 * same words can be told again. Renders nothing.
 */
export default function BellAlerts({ alerts }: { alerts: BellAlert[] }) {
  const t = useT();
  const told = useRef(new Map<string, string>());
  useEffect(() => {
    for (const alert of alerts) {
      const text = alert.text || null;
      if (!text) {
        told.current.delete(alert.key);
        continue;
      }
      if (told.current.get(alert.key) === text) continue;
      told.current.set(alert.key, text);
      notify({
        kind: 'alert',
        group: `alert:${alert.key}`,
        title: t(alert.tone === 'warn' ? 'notify.warning' : 'notify.error'),
        body: text,
        target: alert.action?.target,
        actionLabel: alert.action?.label,
        tone: alert.tone ?? 'error',
      });
      alert.onTold?.();
    }
  });
  return null;
}
