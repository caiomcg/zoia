/**
 * Connects to the LiveKit room and tracks the state the UI needs, on both
 * sides: watching whatever is being shared, and — new in this step —
 * publishing this machine's own screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { LocalVideoTrack, Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import type { SourceInfo } from '../../shared/ipc';

export interface RemoteScreen {
  participantIdentity: string;
  participantName: string;
  videoTrack: RemoteTrack;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';
export type BroadcastState = 'idle' | 'starting' | 'live';

export function useRoom() {
  const roomRef = useRef<Room | null>(null);
  const localTrackRef = useRef<LocalVideoTrack | null>(null);

  const [state, setState] = useState<ConnectionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [remoteScreen, setRemoteScreen] = useState<RemoteScreen | null>(null);
  const [participantCount, setParticipantCount] = useState(0);
  const [broadcastState, setBroadcastState] = useState<BroadcastState>('idle');
  const [broadcastError, setBroadcastError] = useState<string | null>(null);
  const [localTrack, setLocalTrack] = useState<LocalVideoTrack | null>(null);

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
          setBroadcastState('idle');
          localTrackRef.current = null;
          setLocalTrack(null);
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

  /**
   * Ends the local publish and releases the stage, unconditionally — this
   * runs whether the user clicked Stop, the OS ended capture out from under
   * us, or the room disconnected. It must never itself depend on broadcast
   * state, so it stays a single stable reference other callbacks can close
   * over safely, and is declared first so nothing needs a forward reference.
   */
  const stopBroadcast = useCallback(async () => {
    const room = roomRef.current;
    const track = localTrackRef.current;
    if (room && track) {
      await room.localParticipant.unpublishTrack(track, true).catch(() => {});
    }
    track?.mediaStreamTrack.stop();
    localTrackRef.current = null;
    setLocalTrack(null);
    setBroadcastState('idle');
    await window.zoia.stage.release().catch(() => {});
  }, []);

  /**
   * Claims the stage, then captures and publishes the chosen source. The two
   * steps happen in that order deliberately: if someone else already holds
   * the stage, the user never sees a capture prompt at all.
   */
  const startBroadcast = useCallback(
    async (source: SourceInfo) => {
      setBroadcastError(null);
      setBroadcastState('starting');

      const claim = await window.zoia.stage.claim();
      if (!claim.ok) {
        setBroadcastState('idle');
        setBroadcastError(
          claim.holder ? `${claim.holder.name} is already broadcasting.` : 'The stage is busy.',
        );
        return false;
      }

      try {
        await window.zoia.sources.select({
          id: source.id,
          name: source.name,
          processId: source.processId,
        });

        // Resolved by the main-process display-media handler, which uses
        // exactly the source just selected above — no native picker appears.
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const [mediaTrack] = stream.getVideoTracks();
        if (!mediaTrack) throw new Error('No video track was returned for that source.');

        mediaTrack.contentHint = 'detail';
        const track = new LocalVideoTrack(mediaTrack, undefined, false);
        track.source = Track.Source.ScreenShare;

        const room = roomRef.current;
        if (!room) throw new Error('Not connected to the room.');

        await room.localParticipant.publishTrack(track, {
          source: Track.Source.ScreenShare,
          simulcast: false,
          degradationPreference: 'maintain-resolution',
        });

        localTrackRef.current = track;
        setLocalTrack(track);
        setBroadcastState('live');

        // The OS/Chromium can end capture out from under us (window closed,
        // "Stop sharing" bar) — treat that exactly like clicking Stop here.
        mediaTrack.addEventListener('ended', () => {
          void stopBroadcast();
        });

        return true;
      } catch (err) {
        await window.zoia.stage.release();
        setBroadcastState('idle');
        setBroadcastError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [stopBroadcast],
  );

  useEffect(
    () => () => {
      void stopBroadcast();
      void roomRef.current?.disconnect();
    },
    [stopBroadcast],
  );

  return {
    room: roomRef,
    state,
    error,
    remoteScreen,
    participantCount,
    connect,
    disconnect,
    broadcastState,
    broadcastError,
    localTrack,
    startBroadcast,
    stopBroadcast,
  };
}
