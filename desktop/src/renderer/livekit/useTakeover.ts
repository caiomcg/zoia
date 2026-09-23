/**
 * Asking for the stage while somebody else has it.
 *
 * Requests travel over LiveKit's data channel rather than the server: the
 * token already grants canPublishData, and the only two parties that care are
 * the asker and the holder.
 *
 * The holder can hand it over or refuse. If they do neither — which is what
 * happens when somebody leaves a machine broadcasting and walks away — the
 * asker may take it after a grace period. Taking it is not a privilege:
 * anyone in the room can, and the holder is told, so nobody gains a power the
 * rest of the room lacks.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Participant, Room } from 'livekit-client';
import type { RoomMessage } from '../../shared/ipc';

/** How long to wait for an answer before the asker may take the stage. */
const TAKEOVER_GRACE_MS = 30_000;

export interface IncomingRequest {
  identity: string;
  name: string;
}

export interface OutgoingRequest {
  holderName: string;
  /** Counts down to zero, at which point the stage can be taken anyway. */
  secondsLeft: number;
  denied: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function publish(room: Room, message: RoomMessage): void {
  void room.localParticipant
    .publishData(encoder.encode(JSON.stringify(message)), { reliable: true })
    .catch(() => {
      // A request nobody receives simply never gets answered, and the grace
      // period still expires — which is the behaviour we want anyway.
    });
}

export function useTakeover(
  roomRef: { current: Room | null },
  { onGranted }: { onGranted: () => void },
) {
  const [incoming, setIncoming] = useState<IncomingRequest | null>(null);
  const [outgoing, setOutgoing] = useState<OutgoingRequest | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  /** Wired up by useRoom once the room exists. */
  const handleData = useCallback(
    (payload: Uint8Array, participant?: Participant) => {
      const room = roomRef.current;
      if (!room) return;

      let message: RoomMessage;
      try {
        message = JSON.parse(decoder.decode(payload)) as RoomMessage;
      } catch {
        return;
      }

      if (message.type === 'takeover-request') {
        // Only the current holder is in a position to answer.
        if (!room.localParticipant.permissions?.canPublish) return;
        setIncoming({
          identity: message.from,
          name: message.fromName || participant?.name || message.from,
        });
        return;
      }

      if (message.to !== room.localParticipant.identity) return;

      if (message.type === 'takeover-granted') {
        clearTimer();
        setOutgoing(null);
        onGranted();
      } else {
        setOutgoing((current) => (current ? { ...current, denied: true } : current));
      }
    },
    [roomRef, onGranted, clearTimer],
  );

  /** Asks the current holder to hand the stage over. */
  const request = useCallback(
    (holderName: string) => {
      const room = roomRef.current;
      if (!room) return;

      publish(room, {
        type: 'takeover-request',
        from: room.localParticipant.identity,
        fromName: room.localParticipant.name || room.localParticipant.identity,
      });

      clearTimer();
      setOutgoing({
        holderName,
        secondsLeft: Math.round(TAKEOVER_GRACE_MS / 1000),
        denied: false,
      });

      timerRef.current = setInterval(() => {
        setOutgoing((current) => {
          if (!current) return current;
          const secondsLeft = current.secondsLeft - 1;
          if (secondsLeft <= 0) clearTimer();
          return { ...current, secondsLeft: Math.max(0, secondsLeft) };
        });
      }, 1000);
    },
    [roomRef, clearTimer],
  );

  const cancelRequest = useCallback(() => {
    clearTimer();
    setOutgoing(null);
  }, [clearTimer]);

  /** The holder answering an incoming request. */
  const respond = useCallback(
    (accept: boolean) => {
      const room = roomRef.current;
      if (!room || !incoming) return;
      publish(room, {
        type: accept ? 'takeover-granted' : 'takeover-denied',
        to: incoming.identity,
      });
      setIncoming(null);
    },
    [roomRef, incoming],
  );

  const dismissIncoming = useCallback(() => setIncoming(null), []);

  return { incoming, outgoing, request, cancelRequest, respond, dismissIncoming, handleData };
}
