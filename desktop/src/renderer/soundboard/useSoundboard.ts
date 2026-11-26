/**
 * The soundboard in the current channel (ADR 0040): playing a sound to
 * everyone in it, and hearing what they play.
 *
 * Playing is a message to the room on SOUNDBOARD_TOPIC, never audio: each
 * listener fetches the file and plays it at their own volume, or not at all.
 * Nothing on the server takes part, so each listener holds the rules for
 * itself: the sender must be in voice with their microphone on, may play
 * again only once their last sound has played out, and must not be someone
 * you muted. The sender
 * hears their own as they send it, at their own volume, as everyone does.
 * A sound lasts only while its sender may play: muting the microphone or
 * leaving voice cuts it, for them and for everyone listening.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  RoomEvent,
  Track,
  type Participant,
  type RemoteParticipant,
  type Room,
} from 'livekit-client';
import type { ConnectionState } from '../livekit/useRoom';
import { inVoice } from '../voice/voice-room';
import type { VoiceState } from '../voice/useVoice';
import {
  cutShorter,
  decodeSoundMessage,
  encodeSoundMessage,
  padSound,
  SOUNDBOARD_TOPIC,
  type Sound,
} from '../../shared/soundboard';
import { pads, recents, soundboardSettings, useSoundboardSettings } from './library';
import {
  addRecent,
  lockMs,
  NETWORK_SLACK_MS,
  playCut,
  sendBlock,
  SoundLock,
  type SendBlock,
} from './model';
import { playSound, stopAllSounds, stopSound } from './player';

/** What the panel needs: whether you may play, and the way to. */
export interface SoundboardControls {
  /** Why playing to the channel is off, or null when it is on. */
  blocked: SendBlock | null;
  /** Your last sound is loading: playing is off, though nothing plays yet. */
  loading: boolean;
  /** When your last sound started playing (performance.now()). */
  lockedAt: number;
  /**
   * Playing is on again when this passes (performance.now()): when the sound
   * that started at `lockedAt` ends.
   */
  readyAt: number;
  /** Plays `sound` for everyone else in the channel, cut at the panel's length. */
  send(sound: Sound): Promise<void>;
  /** Plays a pad, from its shortcut. */
  sendPad(slug: string): void;
}

/** The sender's microphone is on, as voice needs to play a sound. */
function speaking(participant: Participant): boolean {
  const microphone = participant.getTrackPublication(Track.Source.Microphone);
  return inVoice(participant) && !!microphone && !microphone.isMuted;
}

export function useSoundboard(
  roomRef: RefObject<Room | null>,
  connection: ConnectionState,
  voice: { state: VoiceState; muted: boolean },
): SoundboardControls {
  const settings = useSoundboardSettings();
  const [lock, setLock] = useState({ loading: false, lockedAt: 0, readyAt: 0 });
  const loadingRef = useRef(false);
  const readyAtRef = useRef(0);
  const blocked = sendBlock({ inVoice: voice.state === 'on', muted: voice.muted }, settings);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;

  // What others play. Each connection is a new Room, so this is set up again
  // on every one, and leaving stops whatever was playing.
  useEffect(() => {
    const room = roomRef.current;
    if (!room || connection !== 'connected') return;
    const held = new SoundLock(NETWORK_SLACK_MS);
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
      // Held while the sound plays: the sender's own app waits that long
      // before the next.
      const at = performance.now();
      if (!held.take(identity, at)) return;
      void playSound(identity, sound, true).then((played) => {
        if (played) held.hold(identity, at, played.startedAt + lockMs(played.seconds));
      });
    };
    // Someone leaving takes their sound with them.
    const onLeft = (participant: RemoteParticipant) => stopSound(participant.identity);
    // So does muting their microphone or leaving voice: a sound plays only
    // while its sender may play one. Yours is stopped below, from your voice.
    const onVoiceChanged = (participant: Participant) => {
      if (participant === room.localParticipant || speaking(participant)) return;
      stopSound(participant.identity, 'effect');
    };
    const onTrackChanged = (_publication: unknown, participant: Participant) =>
      onVoiceChanged(participant);
    const onAttributesChanged = (_changed: unknown, participant: Participant) =>
      onVoiceChanged(participant);
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.ParticipantDisconnected, onLeft);
    room.on(RoomEvent.TrackMuted, onTrackChanged);
    room.on(RoomEvent.TrackUnpublished, onTrackChanged);
    room.on(RoomEvent.ParticipantAttributesChanged, onAttributesChanged);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.ParticipantDisconnected, onLeft);
      room.off(RoomEvent.TrackMuted, onTrackChanged);
      room.off(RoomEvent.TrackUnpublished, onTrackChanged);
      room.off(RoomEvent.ParticipantAttributesChanged, onAttributesChanged);
      stopAllSounds();
    };
  }, [roomRef, connection]);

  // Muting your microphone or leaving voice cuts the sound you are playing,
  // here as it does for everyone listening.
  const canSpeak = voice.state === 'on' && !voice.muted;
  useEffect(() => {
    const identity = roomRef.current?.localParticipant.identity;
    if (!canSpeak && identity) stopSound(identity, 'effect');
  }, [canSpeak, roomRef]);

  // Muting everything, or one person, stops what is playing now too.
  useEffect(
    () =>
      soundboardSettings.subscribe(() => {
        const { muted, mutedPeople } = soundboardSettings.get();
        if (muted) stopAllSounds('effect');
        else for (const identity of mutedPeople) stopSound(identity, 'effect');
      }),
    [],
  );

  const send = useCallback(
    async (chosen: Sound) => {
      const room = roomRef.current;
      if (!room || blockedRef.current) return;
      if (loadingRef.current || performance.now() < readyAtRef.current) return;
      loadingRef.current = true;
      setLock((current) => ({ ...current, loading: true }));
      // Kept whole: the length is the panel's, set again for each play.
      recents.set(addRecent(recents.get(), chosen, pads.get()));
      const sound = cutShorter(chosen, playCut(soundboardSettings.get()));
      // Yours plays for you as it goes out, beside your name like anyone's.
      // You are locked out from when it starts to when it ends, no longer.
      void playSound(room.localParticipant.identity, sound, true).then((played) => {
        loadingRef.current = false;
        if (!played) {
          setLock((current) => ({ ...current, loading: false }));
          return;
        }
        const readyAt = played.startedAt + lockMs(played.seconds);
        readyAtRef.current = readyAt;
        setLock({ loading: false, lockedAt: played.startedAt, readyAt });
      });
      await room.localParticipant
        .publishData(encodeSoundMessage(sound), { reliable: true, topic: SOUNDBOARD_TOPIC })
        .catch(() => {});
    },
    [roomRef],
  );

  const sendPad = useCallback(
    (slug: string) => {
      const pad = pads.get().find((p) => p.slug === slug);
      if (pad) void send(padSound(pad));
    },
    [send],
  );

  return { blocked, ...lock, send, sendPad };
}
