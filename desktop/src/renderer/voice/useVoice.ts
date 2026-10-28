/**
 * Voice in the current channel (ADR 0039): the microphone, mute and deafen,
 * and who is speaking.
 *
 * Every channel is a voice channel: App joins on connecting, and leaving the
 * channel leaves voice, since the server forgets the participant with it.
 * Joining asks the server for the microphone alone, then publishes it. The
 * audio is never mixed on the server: each voice goes to every listener as its
 * own Opus stream, and each app plays them together (VoiceAudio). So all the
 * cleaning up of a voice happens here, before the encoder.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  createLocalAudioTrack,
  ParticipantEvent,
  RoomEvent,
  Track,
  type LocalAudioTrack,
  type Room,
  type TrackPublishOptions,
} from 'livekit-client';
import type { ConnectionState } from '../livekit/useRoom';
import { tNow } from '../i18n';
import { captureOptions, getVoiceSettings, subscribeVoiceSettings } from './settings';
import { VOICE_SAMPLE_RATE, VoiceProcessor } from './pipeline';
import { useSpeaking } from './speaking';
import { DEAFENED_ATTRIBUTE } from './voice-room';

export type VoiceState = 'off' | 'joining' | 'on';

/** TrackSource.MICROPHONE in LiveKit's protocol, which is what a permission lists. */
const MICROPHONE_SOURCE = 2;

/** How long the server's grant may take to reach this app before joining gives up. */
const GRANT_TIMEOUT_MS = 5000;

/**
 * Speech, not music: about 32 kbps of mono Opus. DTX sends next to nothing
 * while someone is quiet, which is most of the time for most people in a
 * call. RED sends each packet again inside the next, so a lost one is heard
 * as nothing at all rather than as a click.
 */
const PUBLISH_OPTIONS: TrackPublishOptions = {
  source: Track.Source.Microphone,
  audioPreset: { maxBitrate: 32_000 },
  dtx: true,
  red: true,
  forceStereo: false,
  stream: 'voice',
};

/**
 * Whether the microphone was left muted. Voice starts on entering a channel,
 * so someone who left muted would otherwise come back heard without knowing.
 */
const MUTED_KEY = 'zoia.voice.muted';

function rememberedMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberMuted(muted: boolean) {
  try {
    localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
  } catch {
    // Remembering is a convenience; the mute still applies this session.
  }
}

/**
 * Tells everyone else whether you are hearing them (DEAFENED_ATTRIBUTE), for
 * the icon by your name. Best effort: deafening works without it.
 */
async function announceDeafened(room: Room | null, deafened: boolean) {
  await room?.localParticipant
    .setAttributes({ [DEAFENED_ATTRIBUTE]: deafened ? '1' : '' })
    .catch(() => {});
}

/** What a restart is needed for: the capture, and which suppression runs after it. */
function processingKey(): string {
  const settings = getVoiceSettings();
  return JSON.stringify([captureOptions(settings), settings.noiseSuppression]);
}

function mayPublishMicrophone(room: Room): boolean {
  const permissions = room.localParticipant.permissions;
  if (!permissions?.canPublish) return false;
  const sources = permissions.canPublishSources ?? [];
  return sources.length === 0 || sources.includes(MICROPHONE_SOURCE);
}

/** Resolves once LiveKit has pushed the server's grant down to this app. */
function grantArrives(room: Room): Promise<void> {
  if (mayPublishMicrophone(room)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const participant = room.localParticipant;
    const timer = setTimeout(() => {
      participant.off(ParticipantEvent.ParticipantPermissionsChanged, check);
      reject(new Error(tNow('voice.noGrant')));
    }, GRANT_TIMEOUT_MS);
    function check() {
      if (!mayPublishMicrophone(room)) return;
      clearTimeout(timer);
      participant.off(ParticipantEvent.ParticipantPermissionsChanged, check);
      resolve();
    }
    participant.on(ParticipantEvent.ParticipantPermissionsChanged, check);
  });
}

export function useVoice(roomRef: RefObject<Room | null>, connection: ConnectionState) {
  const [state, setState] = useState<VoiceState>('off');
  const [muted, setMutedState] = useState(rememberedMuted);
  const [deafened, setDeafenedState] = useState(false);
  // Who is speaking, worked out from the sound itself (speaking.ts).
  const speaking = useSpeaking();
  const [error, setError] = useState<string | null>(null);

  const trackRef = useRef<LocalAudioTrack | null>(null);
  // The 48 kHz context the processing runs in, for as long as voice is on.
  const contextRef = useRef<AudioContext | null>(null);
  // The room voice was joined in. Another room, or none, means it is over.
  const voiceRoomRef = useRef<Room | null>(null);
  const mutedRef = useRef(muted);
  const deafenedRef = useRef(false);
  // What mute was before deafening, so undeafening puts it back.
  const mutedBeforeDeafenRef = useRef(false);
  // The capture options last applied, to tell a change worth a restart.
  const captureRef = useRef(processingKey());

  const applyMuted = useCallback(async (next: boolean) => {
    mutedRef.current = next;
    setMutedState(next);
    const track = trackRef.current;
    if (track) await (next ? track.mute() : track.unmute());
  }, []);

  const applyDeafened = useCallback(async (next: boolean) => {
    if (deafenedRef.current === next) return;
    deafenedRef.current = next;
    setDeafenedState(next);
    await Promise.all([
      window.zoia.voice.deafen(next).catch(() => {}),
      announceDeafened(voiceRoomRef.current, next),
    ]);
  }, []);

  /** Ends voice here, without telling the server: for a room that is already gone. */
  const teardown = useCallback(async () => {
    const track = trackRef.current;
    trackRef.current = null;
    voiceRoomRef.current = null;
    await track?.stopProcessor().catch(() => {});
    track?.stop();
    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    setState('off');
    // Deafen is part of being in voice: left on outside it, nothing would
    // play and there would be no button to say why.
    await applyDeafened(false);
  }, [applyDeafened]);

  const publish = useCallback(async (room: Room) => {
    await grantArrives(room);
    const track = await createLocalAudioTrack(captureOptions(getVoiceSettings()));
    if (voiceRoomRef.current !== room) {
      track.stop();
      return;
    }
    trackRef.current = track;
    // Noise suppression and the sensitivity gate, between capture and encoder.
    contextRef.current ??= new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
    track.setAudioContext(contextRef.current);
    // Without it, the microphone still goes out as captured: being heard with
    // the noise beats not being heard at all.
    await track
      .setProcessor(new VoiceProcessor(room.localParticipant.identity))
      .catch((err: unknown) =>
        setError(
          tNow('voice.processingFailed', {
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      );
    if (mutedRef.current) await track.mute();
    await room.localParticipant.publishTrack(track, PUBLISH_OPTIONS);
  }, []);

  const join = useCallback(async () => {
    const room = roomRef.current;
    if (!room || voiceRoomRef.current) return;
    voiceRoomRef.current = room;
    setState('joining');
    setError(null);
    try {
      if (!(await window.zoia.voice.join())) throw new Error(tNow('room.notConnected'));
      await publish(room);
      if (voiceRoomRef.current === room) setState('on');
    } catch (err) {
      if (voiceRoomRef.current !== room) return;
      const track = trackRef.current;
      if (track) await room.localParticipant.unpublishTrack(track, true).catch(() => {});
      await teardown();
      await window.zoia.voice.leave().catch(() => {});
      setError(
        tNow('voice.couldNotJoin', { error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }, [roomRef, publish, teardown]);

  /**
   * Unmuting while deafened undeafens too: being heard while hearing nobody
   * helps no one. Only this choice is remembered; deafening's mute is not.
   */
  const setMuted = useCallback(
    async (next: boolean) => {
      if (!next && deafenedRef.current) await applyDeafened(false);
      rememberMuted(next);
      await applyMuted(next);
    },
    [applyMuted, applyDeafened],
  );

  const setDeafened = useCallback(
    async (next: boolean) => {
      if (next === deafenedRef.current) return;
      if (next) {
        mutedBeforeDeafenRef.current = mutedRef.current;
        await applyDeafened(true);
        await applyMuted(true);
      } else {
        await applyDeafened(false);
        await applyMuted(mutedBeforeDeafenRef.current);
      }
    },
    [applyMuted, applyDeafened],
  );

  // A channel switch, a sign-out or a lost connection ends voice: the server
  // forgets it with the participant, so this app has to as well. Reconnecting
  // keeps the same room, and voice with it.
  useEffect(() => {
    const room = voiceRoomRef.current;
    if (!room) return;
    const gone = roomRef.current !== room || ['idle', 'disconnected', 'error'].includes(connection);
    if (gone) void teardown();
  }, [connection, roomRef, teardown]);

  // Each connection is a new Room, so this is set up again on every one.
  useEffect(() => {
    const room = roomRef.current;
    if (!room || connection !== 'connected') return;
    // A full reconnect is a new session, which starts without the grant and
    // the attribute. Asking again is harmless after a mere resume.
    const onReconnected = () => {
      if (voiceRoomRef.current !== room) return;
      void (async () => {
        try {
          if (!(await window.zoia.voice.join())) return;
          // A new session starts without what this app said of itself.
          if (deafenedRef.current) await announceDeafened(room, true);
          if (!room.localParticipant.getTrackPublication(Track.Source.Microphone)) {
            trackRef.current?.stop();
            trackRef.current = null;
            await publish(room);
          }
        } catch {
          if (voiceRoomRef.current === room) void teardown();
        }
      })();
    };
    room.on(RoomEvent.Reconnected, onReconnected);
    return () => {
      room.off(RoomEvent.Reconnected, onReconnected);
    };
  }, [connection, roomRef, publish, teardown]);

  // A setting changed in Settings › Voice applies to the live microphone.
  // restartTrack captures afresh with the new options and swaps the track
  // under the publication, so listeners hear no gap worth mentioning.
  useEffect(
    () =>
      subscribeVoiceSettings(() => {
        const track = trackRef.current;
        const options = processingKey();
        // Sensitivity is read live by the gate; the capture and the
        // suppression need a restart, which rebuilds the processing too.
        if (options === captureRef.current) return;
        captureRef.current = options;
        if (!track) return;
        void track
          .restartTrack(captureOptions(getVoiceSettings()))
          .then(() => (mutedRef.current ? track.mute() : undefined))
          .catch((err) =>
            setError(
              tNow('voice.couldNotRestart', {
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
          );
      }),
    [],
  );

  // An unplugged microphone ends its track. The system default is what
  // someone expects to fall back to, as the camera does.
  useEffect(() => {
    const onChange = async () => {
      const track = trackRef.current;
      const { microphoneId } = getVoiceSettings();
      if (!track || !microphoneId) return;
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (devices.some((d) => d.kind === 'audioinput' && d.deviceId === microphoneId)) return;
      setError(tNow('voice.deviceLost'));
      await track
        .restartTrack({ ...captureOptions(getVoiceSettings()), deviceId: undefined })
        .then(() => (mutedRef.current ? track.mute() : undefined))
        .catch(() => {});
    };
    const listener = () => void onChange();
    navigator.mediaDevices.addEventListener('devicechange', listener);
    return () => navigator.mediaDevices.removeEventListener('devicechange', listener);
  }, []);

  useEffect(
    () => () => {
      trackRef.current?.stop();
      void window.zoia.voice.deafen(false).catch(() => {});
    },
    [],
  );

  return {
    state,
    muted,
    deafened,
    speaking,
    error,
    clearError: useCallback(() => setError(null), []),
    join,
    setMuted,
    setDeafened,
  };
}
