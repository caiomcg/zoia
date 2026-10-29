/**
 * The soundboard in the current channel (ADR 0040): playing a sound to
 * everyone in it, and hearing what they play.
 *
 * Playing is a message to the room on SOUNDBOARD_TOPIC, never audio: each
 * listener fetches the file and plays it at their own volume, or not at all.
 * Nothing on the server takes part, so each listener holds the rules for
 * itself: the sender must be in voice with their microphone on, may play one
 * sound every two seconds, and must not be someone you muted. The sender
 * hears nothing of their own; the preview is for that.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { RoomEvent, Track, type RemoteParticipant, type Room } from 'livekit-client';
import type { ConnectionState } from '../livekit/useRoom';
import { inVoice } from '../voice/voice-room';
import type { VoiceState } from '../voice/useVoice';
import {
  decodeSoundMessage,
  encodeSoundMessage,
  SOUNDBOARD_TOPIC,
  type Sound,
} from '../../shared/soundboard';
import { favorites, recents, soundboardSettings, useSoundboardSettings } from './library';
import {
  addRecent,
  RECEIVE_INTERVAL_MS,
  SEND_INTERVAL_MS,
  sendBlock,
  Throttle,
  type SendBlock,
} from './model';
import { playSound, stopAllSounds, stopSound } from './player';

/** What the panel needs: whether you may play, and the way to. */
export interface SoundboardControls {
  /** Why playing to the channel is off, or null when it is on. */
  blocked: SendBlock | null;
  /** Playing was just used: on again when this passes (performance.now()). */
  readyAt: number;
  /** Plays `sound` for everyone else in the channel. */
  send(sound: Sound): Promise<void>;
  /** Plays a favourite, from its shortcut. */
  sendFavorite(slug: string): void;
}

/** The sender's microphone is on, as voice needs to play a sound. */
function speaking(participant: RemoteParticipant): boolean {
  const microphone = participant.getTrackPublication(Track.Source.Microphone);
  return inVoice(participant) && !!microphone && !microphone.isMuted;
}

export function useSoundboard(
  roomRef: RefObject<Room | null>,
  connection: ConnectionState,
  voice: { state: VoiceState; muted: boolean },
): SoundboardControls {
  const settings = useSoundboardSettings();
  const [readyAt, setReadyAt] = useState(0);
  const sendThrottle = useRef(new Throttle(SEND_INTERVAL_MS));
  const blocked = sendBlock({ inVoice: voice.state === 'on', muted: voice.muted }, settings);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;

  // What others play. Each connection is a new Room, so this is set up again
  // on every one, and leaving stops whatever was playing.
  useEffect(() => {
    const room = roomRef.current;
    if (!room || connection !== 'connected') return;
    const throttle = new Throttle(RECEIVE_INTERVAL_MS);
    const onData = (
      payload: Uint8Array,
      participant: RemoteParticipant | undefined,
      _kind: unknown,
      topic: string | undefined,
    ) => {
      if (topic !== SOUNDBOARD_TOPIC || !participant) return;
      const sound = decodeSoundMessage(payload);
      if (!sound || !speaking(participant)) return;
      const { identity } = participant;
      const { muted, mutedPeople } = soundboardSettings.get();
      if (muted || mutedPeople.includes(identity)) return;
      if (!throttle.take(identity, performance.now())) return;
      void playSound(identity, sound, true);
    };
    // Someone leaving takes their sound with them.
    const onLeft = (participant: RemoteParticipant) => stopSound(participant.identity);
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.ParticipantDisconnected, onLeft);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.ParticipantDisconnected, onLeft);
      stopAllSounds();
    };
  }, [roomRef, connection]);

  // Muting everything, or one person, stops what is playing now too.
  useEffect(
    () =>
      soundboardSettings.subscribe(() => {
        const { muted, mutedPeople } = soundboardSettings.get();
        if (muted) stopAllSounds();
        else for (const identity of mutedPeople) stopSound(identity);
      }),
    [],
  );

  const send = useCallback(
    async (sound: Sound) => {
      const room = roomRef.current;
      if (!room || blockedRef.current) return;
      const now = performance.now();
      if (!sendThrottle.current.take('me', now)) return;
      setReadyAt(now + SEND_INTERVAL_MS);
      recents.set(addRecent(recents.get(), sound));
      await room.localParticipant
        .publishData(encodeSoundMessage(sound), { reliable: true, topic: SOUNDBOARD_TOPIC })
        .catch(() => {});
    },
    [roomRef],
  );

  const sendFavorite = useCallback(
    (slug: string) => {
      const sound = favorites.get().find((s) => s.slug === slug);
      if (sound) void send(sound);
    },
    [send],
  );

  return { blocked, readyAt, send, sendFavorite };
}
