/**
 * Connects to the LiveKit room and tracks the state the UI needs. Publishing
 * is added in later steps; for now this only ever subscribes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';

export interface RemoteScreen {
  participantIdentity: string;
  participantName: string;
  videoTrack: RemoteTrack;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';

export function useRoom() {
  const roomRef = useRef<Room | null>(null);
  const [state, setState] = useState<ConnectionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [remoteScreen, setRemoteScreen] = useState<RemoteScreen | null>(null);
  const [participantCount, setParticipantCount] = useState(0);

  const findRemoteScreen = useCallback((room: Room): RemoteScreen | null => {
    for (const participant of room.remoteParticipants.values()) {
      const pub = participant.getTrackPublication(Track.Source.ScreenShare);
      if (pub?.track) {
        return {
          participantIdentity: participant.identity,
          participantName: participant.name || participant.identity,
          videoTrack: pub.track,
        };
      }
    }
    return null;
  }, []);

  const connect = useCallback(
    async (wsUrl: string, token: string) => {
      setState('connecting');
      setError(null);

      const room = new Room({ adaptiveStream: false, dynacast: false });
      roomRef.current = room;

      const refresh = () => {
        setRemoteScreen(findRemoteScreen(room));
        setParticipantCount(room.remoteParticipants.size);
      };

      room
        .on(RoomEvent.TrackSubscribed, refresh)
        .on(RoomEvent.TrackUnsubscribed, refresh)
        .on(RoomEvent.ParticipantConnected, refresh)
        .on(RoomEvent.ParticipantDisconnected, refresh)
        .on(RoomEvent.Reconnecting, () => setState('connecting'))
        .on(RoomEvent.Reconnected, () => {
          setState('connected');
          refresh();
        })
        .on(RoomEvent.Disconnected, (reason) => {
          setState('disconnected');
          setError(reason ? `Disconnected: ${reason}` : 'Disconnected');
        });

      try {
        await room.connect(wsUrl, token);
        setState('connected');
        refresh();
      } catch (err) {
        setState('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [findRemoteScreen],
  );

  const disconnect = useCallback(async () => {
    await roomRef.current?.disconnect();
    roomRef.current = null;
    setState('idle');
    setRemoteScreen(null);
  }, []);

  useEffect(() => () => void roomRef.current?.disconnect(), []);

  return { room: roomRef, state, error, remoteScreen, participantCount, connect, disconnect };
}
