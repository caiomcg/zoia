/**
 * Who is on the server, and your own status (ADR 0038). Read when the chat's
 * stream connects, and kept current by its `presence` events; the stream is
 * also what puts you on the server, so it is open whenever you are signed in.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Presence, ShownPresence } from '../../shared/ipc';
import { ownDot } from './status';

export function usePresence({ usable, me }: { usable: boolean; me: string | null }) {
  // What you chose; null until the server has said, or against one without it.
  const [chosen, setChosen] = useState<Presence | null>(null);
  const [people, setPeople] = useState<Record<string, ShownPresence>>({});

  const load = useCallback(async () => {
    const result = await window.zoia.presence.get();
    if (!result.ok) return;
    setChosen(result.value.status);
    setPeople(result.value.people);
  }, []);

  useEffect(() => {
    if (!usable) {
      setChosen(null);
      setPeople({});
      return undefined;
    }
    void load();
    return window.zoia.chat.onEvent((event) => {
      // Reconnected: whatever changed while the stream was down was missed.
      if (event.type === 'stream' && event.connected) void load();
      if (event.type !== 'presence') return;
      setPeople((known) => {
        const next = { ...known };
        if (event.status === 'offline') delete next[event.accountId];
        else next[event.accountId] = event.status;
        return next;
      });
    });
  }, [usable, load]);

  /** Says so at once, and goes back if the server refuses. */
  const choose = useCallback(
    async (status: Presence) => {
      const before = chosen;
      setChosen(status);
      const result = await window.zoia.presence.set(status);
      if (!result.ok) setChosen(before);
    },
    [chosen],
  );

  return {
    /** Whether the server knows statuses at all; older ones do not. */
    enabled: chosen !== null,
    chosen,
    people,
    own: ownDot(chosen, people, me),
    choose,
  };
}

export type PresenceController = ReturnType<typeof usePresence>;
