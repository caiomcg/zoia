/**
 * Entrance sounds (ADR 0046): the sound someone chose on their computer,
 * playing for the channel as they arrive, after the usual join cue.
 *
 * Nothing on the server takes part. The arriving app names its sound in an
 * attribute of its own participant, and each listener plays it, which it does
 * only for someone who has just appeared: it waits a few seconds for the sound
 * and for their microphone, since someone who arrives muted arrives without
 * it, and then forgets them. Setting the attribute later plays nothing.
 *
 * Each listener holds the rules for itself: at most five seconds, and one
 * sound per person per minute, by its own count.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type Room,
} from 'livekit-client';
import type { ConnectionState } from '../livekit/useRoom';
import { inVoice } from '../voice/voice-room';
import type { VoiceState } from '../voice/useVoice';
import {
  encodeEntranceAttribute,
  ENTRANCE_ATTRIBUTE,
  parseEntranceAttribute,
  type Sound,
} from '../../shared/soundboard';
import { entranceSound, soundboardSettings } from './library';
import { EntranceCooldown, ENTRANCE_WAIT_MS, hearsEntrance } from './model';
import { playSound, stopAllSounds, stopSound } from './player';

export function useEntrance(
  roomRef: RefObject<Room | null>,
  connection: ConnectionState,
  channel: string | null,
  voice: { state: VoiceState; muted: boolean },
  away: boolean,
): void {
  // Across rooms: moving between channels must not start the minute again.
  const [cooldown] = useState(() => new EntranceCooldown());
  const awayRef = useRef(away);
  awayRef.current = away;
  const [own, setOwn] = useState<{ identity: string; sound: Sound } | null>(null);
  // The room you last arrived in, by name: reconnecting to it is no arrival.
  const arrivedIn = useRef<string | null>(null);

  const announce = useCallback(
    (identity: string, sound: Sound) => {
      const now = performance.now();
      if (!hearsEntrance(soundboardSettings.get(), identity)) return;
      if (!cooldown.ready(identity, now)) return;
      cooldown.mark(identity, now);
      void playSound(identity, sound, true, 'entrance');
    },
    [cooldown],
  );

  // Other people arriving. Each connection is a new Room, so this is set up
  // again on every one. Nobody already there counts: LiveKit tells of them
  // before the room is connected, when it announces nothing.
  useEffect(() => {
    const room = roomRef.current;
    if (!room || connection !== 'connected') return;
    const waiting = new Map<string, ReturnType<typeof setTimeout>>();

    const forget = (identity: string) => {
      clearTimeout(waiting.get(identity));
      waiting.delete(identity);
    };

    // Runs on each thing that may have been the last to arrive.
    const settle = (participant: RemoteParticipant) => {
      const { identity } = participant;
      if (!waiting.has(identity) || awayRef.current) return;
      const sound = parseEntranceAttribute(participant.attributes[ENTRANCE_ATTRIBUTE]);
      const microphone = participant.getTrackPublication(Track.Source.Microphone);
      if (!sound || !microphone || !inVoice(participant)) return;
      forget(identity);
      if (!microphone.isMuted) announce(identity, sound);
    };

    const onArrived = (participant: RemoteParticipant) => {
      const { identity } = participant;
      waiting.set(
        identity,
        setTimeout(() => waiting.delete(identity), ENTRANCE_WAIT_MS),
      );
      settle(participant);
    };
    const onPublished = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (publication.source === Track.Source.Microphone) settle(participant);
    };
    const onAttributes = (_changed: Record<string, string>, participant: Participant) => {
      const remote = room.remoteParticipants.get(participant.identity);
      if (remote) settle(remote);
    };
    const onLeft = (participant: RemoteParticipant) => forget(participant.identity);

    room.on(RoomEvent.ParticipantConnected, onArrived);
    room.on(RoomEvent.TrackPublished, onPublished);
    room.on(RoomEvent.ParticipantAttributesChanged, onAttributes);
    room.on(RoomEvent.ParticipantDisconnected, onLeft);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onArrived);
      room.off(RoomEvent.TrackPublished, onPublished);
      room.off(RoomEvent.ParticipantAttributesChanged, onAttributes);
      room.off(RoomEvent.ParticipantDisconnected, onLeft);
      for (const identity of [...waiting.keys()]) forget(identity);
    };
  }, [roomRef, connection, announce]);

  // Having left for no channel, coming back to the same one is arriving.
  useEffect(() => {
    if (channel === null) arrivedIn.current = null;
  }, [channel]);

  // Your own arrival: tell the room your sound, and play it once voice is on.
  // A reconnect is not told again, so it plays for nobody.
  useEffect(() => {
    const room = roomRef.current;
    if (!room || connection !== 'connected' || arrivedIn.current === room.name) return;
    arrivedIn.current = room.name;
    const sound = entranceSound.get();
    if (!sound || awayRef.current) return;
    const { localParticipant } = room;
    void localParticipant
      .setAttributes({ [ENTRANCE_ATTRIBUTE]: encodeEntranceAttribute(sound) })
      .catch(() => {});
    setOwn({ identity: localParticipant.identity, sound });
  }, [roomRef, connection]);

  const { state: voiceState, muted: voiceMuted } = voice;
  useEffect(() => {
    if (!own) return;
    if (voiceState === 'on') {
      setOwn(null);
      if (!voiceMuted) announce(own.identity, own.sound);
      return;
    }
    const timer = setTimeout(() => setOwn(null), ENTRANCE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [own, voiceState, voiceMuted, announce]);

  // Muting all of them, or one person's, stops what is playing now too.
  useEffect(
    () =>
      soundboardSettings.subscribe(() => {
        const { entrancesMuted, mutedEntrances } = soundboardSettings.get();
        if (entrancesMuted) stopAllSounds('entrance');
        else for (const identity of mutedEntrances) stopSound(identity, 'entrance');
      }),
    [],
  );
}
