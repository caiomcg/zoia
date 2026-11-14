/**
 * Scheduled events (ADR 0050), as the window sees them: the list, kept
 * current by the chat's stream, and the one that has just started, which the
 * app announces with a banner, a sound and, while the window is not in front,
 * a notification from the system.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { RsvpAnswer, ScheduledEvent, ScheduledEventInput } from '../../shared/ipc';
import { playCues } from '../sounds/useSoundCues';
import { sortEvents } from './model';

export function useSchedule({
  usable,
  onNotice,
}: {
  /** Signed in, approved, and on a server with chat (whose stream carries the changes). */
  usable: boolean;
  /** Said by the system when the window is not in front: the title and body. */
  /** An event you said you would come to has started: tell the person. */
  onNotice?: (event: ScheduledEvent) => void;
}) {
  const [events, setEvents] = useState<ScheduledEvent[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [starting, setStarting] = useState<ScheduledEvent | null>(null);
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;

  const refresh = useCallback(async () => {
    const result = await window.zoia.schedule.list();
    if (result.ok) {
      setEnabled(true);
      setEvents(sortEvents(result.value));
    } else if (result.error === 'http_404') {
      // A server from before scheduled events.
      setEnabled(false);
    }
  }, []);

  useEffect(() => {
    if (!usable) {
      setEvents([]);
      setEnabled(false);
      return;
    }
    void refresh();
  }, [usable, refresh]);

  // Its "happening now" turns into gone a few hours after the start: read the
  // list again now and then, as nothing on the stream says so.
  useEffect(() => {
    if (!usable) return undefined;
    const timer = setInterval(() => void refresh(), 10 * 60_000);
    return () => clearInterval(timer);
  }, [usable, refresh]);

  useEffect(
    () =>
      window.zoia.chat.onEvent((event) => {
        if (event.type === 'schedule') void refresh();
        else if (event.type === 'stream' && event.connected) void refresh();
        else if (event.type === 'event_starting') {
          setStarting(event.event);
          playCues(['eventStart']);
          noticeRef.current?.(event.event);
        }
      }),
    [refresh],
  );

  /** Puts a changed event in the list at once, before the stream says so. */
  const put = useCallback((event: ScheduledEvent) => {
    setEvents((list) => sortEvents([...list.filter((e) => e.id !== event.id), event]));
  }, []);

  const create = useCallback(
    async (input: ScheduledEventInput): Promise<string | null> => {
      const result = await window.zoia.schedule.create(input);
      if (!result.ok) return result.error;
      put(result.value);
      return null;
    },
    [put],
  );

  const update = useCallback(
    async (id: string, input: ScheduledEventInput): Promise<string | null> => {
      const result = await window.zoia.schedule.update(id, input);
      if (!result.ok) return result.error;
      put(result.value);
      return null;
    },
    [put],
  );

  const remove = useCallback(async (id: string): Promise<string | null> => {
    const result = await window.zoia.schedule.remove(id);
    if (!result.ok) return result.error;
    setEvents((list) => list.filter((e) => e.id !== id));
    return null;
  }, []);

  const rsvp = useCallback(
    async (id: string, answer: RsvpAnswer | null): Promise<string | null> => {
      const result = await window.zoia.schedule.rsvp(id, answer);
      if (!result.ok) return result.error;
      put(result.value);
      return null;
    },
    [put],
  );

  // A birthday is titled in the window's language, under the name its person
  // has now (ADR 0055); the server's title is only the name it was made with.
  const t = useT();
  const shown = useMemo(
    () =>
      events.map((e) =>
        e.kind === 'birthday'
          ? { ...e, title: t('birthday.event.title', { name: e.subjectName ?? e.title }) }
          : e,
      ),
    [events, t],
  );

  return {
    enabled,
    events: shown,
    /** The event that has just started, until dismissed. */
    starting,
    dismissStarting: () => setStarting(null),
    create,
    update,
    remove,
    rsvp,
  };
}

export type ScheduleController = ReturnType<typeof useSchedule>;
