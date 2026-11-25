/**
 * Voice in the current channel (ADR 0039): the microphone, mute and deafen,
 * and who is speaking.
 *
 * Every channel is a voice channel: App joins on connecting, and leaving the
 * channel leaves voice, since the server forgets the participant with it.
 * Joining asks the server for the microphone alone, then publishes it. With
 * no microphone to capture, voice is joined to listen only: you hear everyone
 * and watch every stream, and the microphone is published once one turns up.
 * The
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
  TrackEvent,
  type LocalAudioTrack,
  type Room,
  type TrackPublishOptions,
} from 'livekit-client';
import type { ConnectionState } from '../livekit/useRoom';
import { tNow } from '../i18n';
import {
  captureOptions,
  defaultDeviceKey,
  defaultDeviceName,
  getVoiceSettings,
  subscribeVoiceSettings,
  type ListedDevice,
} from './settings';
import { deviceNow, subscribeDevices } from './device-watch';
import { VOICE_SAMPLE_RATE, VoiceProcessor } from './pipeline';
import { registerAudioSink } from './audioSink';
import { useSpeaking } from './speaking';
import { DEAFENED_ATTRIBUTE } from './voice-room';
import { setDeafenedHere } from './deafen';

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

/** The microphone a track was captured from: '' for the system default, and which device that was. */
interface MicrophoneInUse {
  id: string;
  defaultKey: string;
  /** What the system default is called, for the message when falling back to it. */
  defaultName: string;
}

function listDevices(): Promise<ListedDevice[]> {
  return navigator.mediaDevices.enumerateDevices().catch(() => []);
}

/**
 * The microphone to capture from now: the chosen one if it is plugged in,
 * else the one held while a new device is asked about, else the default.
 */
async function microphoneNow(): Promise<MicrophoneInUse> {
  const devices = await listDevices();
  return {
    id: deviceNow('audioinput', devices),
    defaultKey: defaultDeviceKey(devices, 'audioinput'),
    defaultName: defaultDeviceName(devices.filter((d) => d.kind === 'audioinput')),
  };
}

/** The message for a chosen microphone that is gone, naming what is used instead. */
function deviceLostMessage(microphone: MicrophoneInUse): string {
  return microphone.defaultName
    ? tNow('voice.deviceLostTo', { name: microphone.defaultName })
    : tNow('voice.deviceLost');
}

/** The message for voice joined without a microphone, saying why. */
function noMicrophoneMessage(err: unknown, devices: readonly ListedDevice[]): string {
  const none =
    !devices.some((d) => d.kind === 'audioinput') ||
    (err instanceof DOMException && err.name === 'NotFoundError');
  if (none) return tNow('voice.noMicrophone');
  return tNow('voice.microphoneUnavailable', {
    error: err instanceof Error ? err.message : String(err),
  });
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
  // In voice without a microphone: listening only, until one can be captured.
  const [noMicrophone, setNoMicrophoneState] = useState(false);
  const noMicrophoneRef = useRef(false);
  // The no-microphone message on screen, if any, to clear it once one is captured.
  const noMicMessageRef = useRef<string | null>(null);

  const trackRef = useRef<LocalAudioTrack | null>(null);
  // The 48 kHz context the processing runs in, for as long as voice is on.
  const contextRef = useRef<AudioContext | null>(null);
  const unregisterSinkRef = useRef<(() => void) | null>(null);
  // The room voice was joined in. Another room, or none, means it is over.
  const voiceRoomRef = useRef<Room | null>(null);
  const mutedRef = useRef(muted);
  const deafenedRef = useRef(false);
  // What mute was before deafening, so undeafening puts it back.
  const mutedBeforeDeafenRef = useRef(false);
  // The capture options last applied, to tell a change worth a restart.
  const captureRef = useRef(processingKey());
  // The microphone the live track was captured from, to tell when it must move.
  const inUseRef = useRef<MicrophoneInUse>({ id: '', defaultKey: '', defaultName: '' });
  // The device-lost message on screen, if any, to clear it once the device is back.
  const lostMessageRef = useRef<string | null>(null);
  // Restarts run one after another: unplugging fires several device changes.
  const restartsRef = useRef<Promise<void>>(Promise.resolve());

  const applyMuted = useCallback(async (next: boolean) => {
    mutedRef.current = next;
    setMutedState(next);
    const track = trackRef.current;
    if (track) await (next ? track.mute() : track.unmute());
  }, []);

  // Hear yourself: deafened for the call, the monitor still playing (it is
  // not one of deafen's sounds). Whether you were deafened before, to go back to it.
  const hearingSelfRef = useRef<{ wasDeafened: boolean } | null>(null);

  const applyDeafened = useCallback(async (next: boolean) => {
    if (deafenedRef.current === next) return;
    deafenedRef.current = next;
    setDeafenedState(next);
    // Voices, the soundboard and cues; never a broadcast (deafen.ts).
    setDeafenedHere(next);
    await announceDeafened(voiceRoomRef.current, next);
  }, []);

  /** Ends voice here, without telling the server: for a room that is already gone. */
  const teardown = useCallback(async () => {
    const track = trackRef.current;
    trackRef.current = null;
    voiceRoomRef.current = null;
    await track?.stopProcessor().catch(() => {});
    track?.stop();
    unregisterSinkRef.current?.();
    unregisterSinkRef.current = null;
    void contextRef.current?.close().catch(() => {});
    contextRef.current = null;
    setState('off');
    noMicrophoneRef.current = false;
    setNoMicrophoneState(false);
    hearingSelfRef.current = null;
    // Deafen is part of being in voice: left on outside it, nothing would
    // play and there would be no button to say why.
    await applyDeafened(false);
  }, [applyDeafened]);

  /**
   * Captures the microphone afresh, from the chosen device if it is plugged
   * in and the system default if not. For a device change, only when the
   * device in use has to move: restarting for nothing would be a gap heard.
   */
  const restartMicrophone = useCallback((onlyIfMoved: boolean) => {
    const run = async () => {
      const track = trackRef.current;
      if (!track) return;
      const microphone = await microphoneNow();
      const before = inUseRef.current;
      const moved =
        microphone.id !== before.id ||
        (microphone.id === '' && microphone.defaultKey !== before.defaultKey) ||
        track.mediaStreamTrack.readyState === 'ended';
      if (onlyIfMoved && !moved) return;
      const settings = getVoiceSettings();
      // One string: the dev console forwards text, and an object reads [object Object].
      console.info(
        `[audio] capturing the microphone again: chose ${settings.microphoneId ? 'a device' : 'the system default'}, ` +
          `using ${microphone.id ? 'that device' : `the system default (${microphone.defaultName})`}, ` +
          `track was ${track.mediaStreamTrack.readyState}`,
      );
      await track.restartTrack(captureOptions({ ...settings, microphoneId: microphone.id }));
      if (trackRef.current !== track) return;
      inUseRef.current = microphone;
      // Both ways: LiveKit may have muted it when the old device vanished.
      await (mutedRef.current ? track.mute() : track.unmute());
      if (settings.microphoneId && !microphone.id) {
        lostMessageRef.current = deviceLostMessage(microphone);
        setError(lostMessageRef.current);
      } else if (lostMessageRef.current) {
        const shown = lostMessageRef.current;
        lostMessageRef.current = null;
        setError((current) => (current === shown ? null : current));
      }
    };
    restartsRef.current = restartsRef.current.then(run).catch((err: unknown) => {
      console.warn('[audio] could not capture the microphone again', err);
      setError(
        tNow('voice.couldNotRestart', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  }, []);

  const publish = useCallback(
    async (room: Room) => {
      await grantArrives(room);
      // A chosen microphone that is not plugged in would fail the whole join.
      const microphone = await microphoneNow();
      const settings = getVoiceSettings();
      let track: LocalAudioTrack;
      try {
        track = await createLocalAudioTrack(
          captureOptions({ ...settings, microphoneId: microphone.id }),
        );
      } catch (err) {
        // No microphone, or none that can be opened: still in voice, to hear
        // everyone and watch the streams. A device change tries again.
        if (voiceRoomRef.current !== room) return;
        console.info('[audio] no microphone to capture; in voice to listen only', err);
        noMicrophoneRef.current = true;
        setNoMicrophoneState(true);
        noMicMessageRef.current = noMicrophoneMessage(err, await listDevices());
        setError(noMicMessageRef.current);
        return;
      }
      if (voiceRoomRef.current !== room) {
        track.stop();
        return;
      }
      if (noMicrophoneRef.current) {
        console.info('[audio] a microphone is available now; publishing it');
        noMicrophoneRef.current = false;
        setNoMicrophoneState(false);
      }
      if (noMicMessageRef.current) {
        const shown = noMicMessageRef.current;
        noMicMessageRef.current = null;
        setError((current) => (current === shown ? null : current));
      }
      trackRef.current = track;
      inUseRef.current = microphone;
      if (settings.microphoneId && !microphone.id) {
        lostMessageRef.current = deviceLostMessage(microphone);
        setError(lostMessageRef.current);
      }
      // When the microphone's device vanishes, LiveKit tries the default itself
      // and, if that fails mid-unplug, mutes the track. Nobody hears you while
      // the app says you are unmuted, so a mute that is not ours is undone by
      // capturing again.
      track.on(TrackEvent.Muted, () => {
        if (trackRef.current !== track || mutedRef.current) return;
        console.info('[audio] microphone muted by LiveKit after a device change; capturing again');
        restartMicrophone(false);
      });
      // Noise suppression and the sensitivity gate, between capture and encoder.
      // Nothing in the graph connects to context.destination, so nothing plays
      // out loud, but the context still needs a real output device's clock:
      // sinkId none runs on Chromium's software timer (FakeAudioWorker), whose
      // jitter causes FIFO underruns that make RNNoise pump the voice volume.
      // Registering with audioSink moves and resumes the context if its output
      // device is unplugged.
      if (!contextRef.current) {
        contextRef.current = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
        unregisterSinkRef.current = registerAudioSink(contextRef.current);
      }
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
    },
    [restartMicrophone],
  );

  /**
   * In voice without a microphone, tries to capture one again: for a device
   * plugged in, or another chosen in Settings. Queued with the restarts.
   */
  const retryMicrophone = useCallback(() => {
    const run = async () => {
      const room = voiceRoomRef.current;
      if (!room || trackRef.current || !noMicrophoneRef.current) return;
      await publish(room);
    };
    restartsRef.current = restartsRef.current.then(run).catch((err: unknown) => {
      console.warn('[audio] could not publish the microphone', err);
    });
  }, [publish]);

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

  /** Leaves voice but not the channel: for the away channel (ADR 0044). */
  const leave = useCallback(async () => {
    const room = voiceRoomRef.current;
    if (!room) return;
    const track = trackRef.current;
    if (track) await room.localParticipant.unpublishTrack(track, true).catch(() => {});
    await teardown();
    await window.zoia.voice.leave().catch(() => {});
  }, [teardown]);

  /**
   * Unmuting while deafened undeafens too: being heard while hearing nobody
   * helps no one. Only this choice is remembered; deafening's mute is not.
   */
  const setMuted = useCallback(
    async (next: boolean) => {
      // Nothing to unmute without a microphone; the choice stays as it was.
      if (!next && noMicrophoneRef.current) return;
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

  /**
   * Hear yourself (Settings › Voice) is deafen, literally: your microphone is
   * off to the call and everyone sees you deafened. The monitor still plays;
   * everything else, broadcasts included, is held down (duck.ts). Off,
   * you are back as you were, unless you undeafened meanwhile.
   */
  const setHearingSelf = useCallback(
    async (on: boolean) => {
      if (on) {
        if (hearingSelfRef.current) return;
        const wasDeafened = deafenedRef.current;
        hearingSelfRef.current = { wasDeafened };
        if (!wasDeafened) {
          mutedBeforeDeafenRef.current = mutedRef.current;
          await applyDeafened(true);
          await applyMuted(true);
        }
        return;
      }
      const before = hearingSelfRef.current;
      if (!before) return;
      hearingSelfRef.current = null;
      if (!deafenedRef.current) return;
      if (!before.wasDeafened) {
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
        if (!track) {
          retryMicrophone();
          return;
        }
        restartMicrophone(false);
      }),
    [restartMicrophone, retryMicrophone],
  );

  // A device coming or going moves the microphone: off a chosen one that was
  // unplugged onto the system default, back onto it when it returns, and onto
  // whatever Windows makes the default when that one goes. A default moved
  // onto a device just plugged in is held off and asked about first, which is
  // why this listens to device-watch rather than to devicechange.
  useEffect(
    () =>
      subscribeDevices(() => {
        if (trackRef.current) restartMicrophone(true);
        else retryMicrophone();
      }),
    [restartMicrophone, retryMicrophone],
  );

  useEffect(
    () => () => {
      trackRef.current?.stop();
      setDeafenedHere(false);
    },
    [],
  );

  return {
    state,
    // Without a microphone nobody hears you, which is what muted shows.
    muted: muted || noMicrophone,
    noMicrophone,
    deafened,
    speaking,
    error,
    clearError: useCallback(() => setError(null), []),
    join,
    leave,
    setMuted,
    setDeafened,
    setHearingSelf,
  };
}
