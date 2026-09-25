/**
 * Connects to the LiveKit room and tracks the state the UI needs, on both
 * sides: watching whatever is being shared, and publishing this machine's
 * own screen — with its actual application audio, captured via real WASAPI
 * process-loopback in the main process (src/main/audio.ts) and turned into a
 * MediaStreamTrack here (audio/capture-track.ts).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type Participant,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
  type RemoteTrack,
} from 'livekit-client';
import type { QualityPreset, SourceInfo, TokenResult } from '../../shared/ipc';
import { createCaptureAudioTrack, type CaptureTrackHandle } from '../audio/capture-track';

/**
 * The identity suffix a hardware-encoded broadcast publishes under. Must match
 * WHIP_SUFFIX in server/src/whip.js — the server mints the token with it, and
 * this is how the client knows whose picture it is.
 */
export const WHIP_SUFFIX = '-gpu';

/** The person a WHIP publisher belongs to, or the identity unchanged. */
function ownerIdentity(identity: string): string {
  return identity.endsWith(WHIP_SUFFIX) ? identity.slice(0, -WHIP_SUFFIX.length) : identity;
}

function applyRemoteMediaSettings(
  room: Room,
  selected: Set<string>,
  qualityMode: RemoteQualityMode,
  focusedIdentity: string | null,
  audioOnly: Set<string>,
): void {
  for (const participant of room.remoteParticipants.values()) {
    const identity = ownerIdentity(participant.identity);
    const subscribed = selected.has(identity);
    const videoSubscribed = subscribed && !audioOnly.has(identity);
    const quality =
      qualityMode === 'low' || (focusedIdentity && focusedIdentity !== identity)
        ? VideoQuality.LOW
        : VideoQuality.HIGH;
    for (const publication of participant.videoTrackPublications.values()) {
      try {
        publication.setSubscribed(videoSubscribed);
        publication.setVideoQuality(quality);
      } catch {
        // The participant may leave while settings are being applied.
      }
    }
    for (const publication of participant.audioTrackPublications.values()) {
      try {
        publication.setSubscribed(subscribed);
      } catch {
        // The participant may leave while settings are being applied.
      }
    }
  }
}

export interface RemoteScreen {
  participantIdentity: string;
  participantName: string;
  videoTrack: RemoteTrack | null;
  audioTrack: RemoteTrack | null;
}

export type RemoteQualityMode = 'auto' | 'low';

/**
 * Read from the live RTP sender rather than inferred from GPU feature flags:
 * `encoderImplementation` names the encoder WebRTC actually instantiated, so
 * it is the only honest answer to "are we encoding on the GPU". Chromium's
 * getGPUFeatureStatus() can report software while a hardware encoder is in
 * use, and vice versa.
 */
export interface VideoStats {
  encoder: string;
  codec: string;
  width: number;
  height: number;
  fps: number;
  kbps: number;
}

export interface RoomMember {
  identity: string;
  name: string;
  isLocal: boolean;
  /** True while this member is the one sharing their screen. */
  isBroadcasting: boolean;
  /**
   * The hardware-encoding path joins as its own WHIP participant, which
   * would otherwise show up as a second, duplicate person in the list.
   */
  isIngress: boolean;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';
export type BroadcastState = 'idle' | 'starting' | 'live';

async function samplePublishStats(
  track: LocalVideoTrack,
  lastSample: { current: { bytes: number; at: number } | null },
  onStats: (stats: VideoStats) => void,
): Promise<void> {
  const sender = track.sender;
  if (!sender) return;

  const report = await sender.getStats();
  let outbound: RTCOutboundRtpStreamStats | undefined;
  report.forEach((entry) => {
    const stat = entry as RTCOutboundRtpStreamStats & { kind?: string };
    if (stat.type === 'outbound-rtp' && stat.kind === 'video') outbound = stat;
  });
  if (!outbound) return;

  const withExtras = outbound as RTCOutboundRtpStreamStats & {
    encoderImplementation?: string;
    frameWidth?: number;
    frameHeight?: number;
    framesPerSecond?: number;
    bytesSent?: number;
    codecId?: string;
  };

  let codec = 'unknown';
  if (withExtras.codecId) {
    const entry = report.get(withExtras.codecId) as { mimeType?: string } | undefined;
    if (entry?.mimeType) codec = entry.mimeType.replace('video/', '');
  }

  const bytes = withExtras.bytesSent ?? 0;
  const now = performance.now();
  const previous = lastSample.current;
  const kbps =
    previous && now > previous.at
      ? Math.round(((bytes - previous.bytes) * 8) / (now - previous.at))
      : 0;
  lastSample.current = { bytes, at: now };

  onStats({
    encoder: withExtras.encoderImplementation ?? 'unknown',
    codec,
    width: withExtras.frameWidth ?? 0,
    height: withExtras.frameHeight ?? 0,
    fps: Math.round(withExtras.framesPerSecond ?? 0),
    kbps,
  });
}

export function useRoom() {
  const roomRef = useRef<Room | null>(null);
  const localTrackRef = useRef<LocalVideoTrack | null>(null);
  const localAudioRef = useRef<{ track: LocalAudioTrack; capture: CaptureTrackHandle } | null>(
    null,
  );
  // Populated by connect(); startBroadcast reads it so capture and encoding
  // actually match what the server tuned, instead of LiveKit's bare defaults.
  const qualityRef = useRef<NonNullable<TokenResult['quality']>>({
    maxBitrate: 12_000_000,
    maxFramerate: 60,
    width: 1920,
    height: 1080,
    codec: 'h264',
  });

  const [state, setState] = useState<ConnectionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [roomNotice, setRoomNotice] = useState<string | null>(null);
  const [remoteScreens, setRemoteScreens] = useState<RemoteScreen[]>([]);
  const selectedRemoteIdsRef = useRef<Set<string>>(new Set());
  const remoteQualityModeRef = useRef<RemoteQualityMode>('auto');
  const focusedRemoteIdRef = useRef<string | null>(null);
  const audioOnlyRemoteIdsRef = useRef<Set<string>>(new Set());
  const selectionInitializedRef = useRef(false);
  const broadcastingNamesRef = useRef(new Map<string, string>());
  const [selectedRemoteIds, setSelectedRemoteIds] = useState<Set<string>>(new Set());
  const [participantCount, setParticipantCount] = useState(0);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [broadcastState, setBroadcastState] = useState<BroadcastState>('idle');
  const [broadcastError, setBroadcastError] = useState<string | null>(null);
  const [audioWarning, setAudioWarning] = useState<string | null>(null);
  const [localTrack, setLocalTrack] = useState<LocalVideoTrack | null>(null);
  // Peak level of the audio actually being captured, 0..1. This is what lets
  // a broadcaster confirm audio is flowing without a second machine.
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioLatencyMs, setAudioLatencyMs] = useState(0);
  const [videoStats, setVideoStats] = useState<VideoStats | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSampleRef = useRef<{ bytes: number; at: number } | null>(null);
  const [canMonitor, setCanMonitor] = useState(false);
  // Which of the two share controls is lit; they are independent.
  const [sharingKind, setSharingKind] = useState<'screen' | 'camera' | null>(null);

  const findRemoteScreens = useCallback((room: Room): RemoteScreen[] => {
    // The hardware path publishes over WHIP, which joins as its own
    // participant — and from this app's point of view that participant is
    // *remote*, including on the machine that is doing the broadcasting.
    // Rendering it there plays your own captured audio back out of your own
    // speakers, which is heard as an echo of whatever you are sharing.
    const ownIngress = `${room.localParticipant.identity}${WHIP_SUFFIX}`;

    const screens: RemoteScreen[] = [];
    for (const participant of room.remoteParticipants.values()) {
      if (participant.identity === ownIngress) continue;
      // Where the stream came from decides how it is labelled, and viewers
      // must not care. The in-app path publishes ScreenShare; the hardware
      // path publishes over WHIP, which may label its tracks CAMERA and
      // MICROPHONE because WHIP carries no notion of a screen share. Looking
      // only for ScreenShare meant the NVENC stream published perfectly and
      // nobody could see it.
      const videoPub =
        participant.getTrackPublication(Track.Source.ScreenShare) ??
        [...participant.videoTrackPublications.values()].find((pub) => pub.track);
      const audioPub =
        participant.getTrackPublication(Track.Source.ScreenShareAudio) ??
        [...participant.audioTrackPublications.values()].find((pub) => pub.track);

      if (videoPub?.track || audioPub?.track) {
        // A WHIP publisher carries the name it joined with, so a later rename
        // would leave viewers looking at a stale label. The human it belongs
        // to is in the same room and always current.
        const ingressOwnerId = ownerIdentity(participant.identity);
        const owner =
          ingressOwnerId === participant.identity
            ? participant
            : ([...room.remoteParticipants.values()].find((p) => p.identity === ingressOwnerId) ??
              (room.localParticipant.identity === ingressOwnerId
                ? room.localParticipant
                : participant));

        screens.push({
          participantIdentity: owner.identity,
          participantName: owner.name || owner.identity,
          videoTrack: videoPub?.track ?? null,
          audioTrack: audioPub?.track ?? null,
        });
      }
    }
    return screens;
  }, []);

  const dataHandlerRef = useRef<((payload: Uint8Array, from?: Participant) => void) | null>(null);

  /** Kept for old data-message consumers; broadcasts no longer use takeover. */
  const onData = useCallback((handler: (payload: Uint8Array, from?: Participant) => void) => {
    dataHandlerRef.current = handler;
  }, []);

  const connect = useCallback(
    async (wsUrl: string, token: string, quality?: TokenResult['quality']) => {
      setState('connecting');
      setIsReconnecting(false);
      setError(null);
      setRoomNotice(null);
      selectionInitializedRef.current = false;
      if (quality) qualityRef.current = quality;

      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;

      const refresh = (initializeSelection = false) => {
        const screens = findRemoteScreens(room);
        const available = new Set(screens.map((screen) => screen.participantIdentity));
        const nextSelected = new Set(selectedRemoteIdsRef.current);
        if (initializeSelection && !selectionInitializedRef.current) {
          for (const id of available) nextSelected.add(id);
          selectionInitializedRef.current = true;
        }
        selectedRemoteIdsRef.current = nextSelected;
        setSelectedRemoteIds(nextSelected);
        setRemoteScreens(screens);
        setParticipantCount(room.remoteParticipants.size);

        const describe = (p: Participant, isLocal: boolean): RoomMember => ({
          identity: p.identity,
          name: p.name || p.identity,
          isLocal,
          // Any published video means sharing, for the same reason as above:
          // an ingress publishes CAMERA rather than ScreenShare.
          isBroadcasting: p.videoTrackPublications.size > 0,
          // WHIP publishers join under their owner's identity plus "-gpu",
          // so they can be folded back into that person rather than listed
          // as someone else.
          isIngress: p.identity.endsWith(WHIP_SUFFIX),
        });

        const all = [
          describe(room.localParticipant, true),
          ...[...room.remoteParticipants.values()].map((p) => describe(p, false)),
        ];

        // Fold each ingress participant into the human it belongs to, so one
        // person sharing their screen is one row that says "live".
        const ingressOwners = new Set(
          all.filter((m) => m.isIngress).map((m) => ownerIdentity(m.identity)),
        );
        const nextMembers = all
          .filter((m) => !m.isIngress)
          .map((m) => (ingressOwners.has(m.identity) ? { ...m, isBroadcasting: true } : m));
        broadcastingNamesRef.current = new Map(
          nextMembers
            .filter((member) => member.isBroadcasting)
            .map((member) => [member.identity, member.name]),
        );
        setMembers(nextMembers);
      };

      const applyRemoteSubscriptions = () => {
        applyRemoteMediaSettings(
          room,
          selectedRemoteIdsRef.current,
          remoteQualityModeRef.current,
          focusedRemoteIdRef.current,
          audioOnlyRemoteIdsRef.current,
        );
      };

      room
        // Without this, a rename updated the server record and the person's
        // own footer while every list in every client kept the old name.
        .on(RoomEvent.ParticipantNameChanged, () => refresh())
        .on(RoomEvent.DataReceived, (payload, participant) =>
          dataHandlerRef.current?.(payload, participant),
        )
        // Permission changes are how losing the stage arrives: the server
        // revokes canPublish and LiveKit pushes it down live.
        .on(RoomEvent.ParticipantPermissionsChanged, () => refresh())
        .on(RoomEvent.LocalTrackUnpublished, () => refresh())
        .on(RoomEvent.TrackSubscribed, () => refresh())
        .on(RoomEvent.TrackUnsubscribed, () => refresh())
        .on(RoomEvent.ParticipantConnected, () => refresh())
        .on(RoomEvent.ParticipantDisconnected, (participant) => {
          const ownerId = ownerIdentity(participant.identity);
          const name = broadcastingNamesRef.current.get(ownerId);
          refresh();
          if (name && !broadcastingNamesRef.current.has(ownerId)) {
            setRoomNotice(`${name} parou de transmitir`);
          }
        })
        .on(RoomEvent.Reconnecting, () => {
          setIsReconnecting(true);
          setState('connecting');
        })
        .on(RoomEvent.Reconnected, () => {
          setIsReconnecting(false);
          setState('connected');
          refresh();
          applyRemoteSubscriptions();
        })
        .on(RoomEvent.Disconnected, (reason) => {
          setIsReconnecting(false);
          setState('disconnected');
          setError(
            reason
              ? `Conexão encerrada (${reason}). Verifique a rede e tente novamente.`
              : 'Conexão encerrada. Verifique a rede e tente novamente.',
          );
          setBroadcastState('idle');
          localTrackRef.current = null;
          setLocalTrack(null);
        });

      try {
        await room.connect(wsUrl, token);
        setState('connected');
        refresh(true);
      } catch (err) {
        setState('error');
        setError(`Não foi possível conectar: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [findRemoteScreens],
  );

  /**
   * Publishes a new display name to the room.
   *
   * The name every other client renders comes from the LiveKit participant,
   * which is set from the token at join time — so changing it on the server
   * alone is invisible until the next reconnect. This pushes it live; the
   * token grants canUpdateOwnMetadata for exactly this, and nothing wider.
   */
  const setDisplayName = useCallback(async (name: string) => {
    await roomRef.current?.localParticipant.setName(name);
  }, []);

  const disconnect = useCallback(async () => {
    await roomRef.current?.disconnect();
    roomRef.current = null;
    setState('idle');
    setIsReconnecting(false);
    setRoomNotice(null);
    setRemoteScreens([]);
    selectionInitializedRef.current = false;
    remoteQualityModeRef.current = 'auto';
    focusedRemoteIdRef.current = null;
    audioOnlyRemoteIdsRef.current = new Set();
    selectedRemoteIdsRef.current = new Set();
    setSelectedRemoteIds(new Set());
  }, []);

  const setRemoteSubscription = useCallback(
    async (identity: string, subscribed: boolean) => {
      const room = roomRef.current;
      if (!room) return;
      const participant = room.remoteParticipants.get(identity);
      if (!participant) return;
      const next = new Set(selectedRemoteIdsRef.current);
      if (subscribed) next.add(identity);
      else next.delete(identity);
      selectedRemoteIdsRef.current = next;
      setSelectedRemoteIds(next);
      applyRemoteMediaSettings(
        room,
        next,
        remoteQualityModeRef.current,
        focusedRemoteIdRef.current,
        audioOnlyRemoteIdsRef.current,
      );
      setRemoteScreens(findRemoteScreens(room));
    },
    [findRemoteScreens],
  );

  const setRemoteQualityMode = useCallback((mode: RemoteQualityMode) => {
    remoteQualityModeRef.current = mode;
    const room = roomRef.current;
    if (room) {
      applyRemoteMediaSettings(
        room,
        selectedRemoteIdsRef.current,
        mode,
        focusedRemoteIdRef.current,
        audioOnlyRemoteIdsRef.current,
      );
    }
  }, []);

  const setRemoteFocus = useCallback((identity: string | null) => {
    focusedRemoteIdRef.current = identity;
    const room = roomRef.current;
    if (room) {
      applyRemoteMediaSettings(
        room,
        selectedRemoteIdsRef.current,
        remoteQualityModeRef.current,
        identity,
        audioOnlyRemoteIdsRef.current,
      );
    }
  }, []);

  const setRemoteAudioOnly = useCallback(
    (identity: string, audioOnly: boolean) => {
      if (audioOnly) audioOnlyRemoteIdsRef.current.add(identity);
      else audioOnlyRemoteIdsRef.current.delete(identity);
      const room = roomRef.current;
      if (room) {
        applyRemoteMediaSettings(
          room,
          selectedRemoteIdsRef.current,
          remoteQualityModeRef.current,
          focusedRemoteIdRef.current,
          audioOnlyRemoteIdsRef.current,
        );
        setRemoteScreens(findRemoteScreens(room));
      }
    },
    [findRemoteScreens],
  );

  /**
   * Ends the local publish and releases the stage, unconditionally — this
   * runs whether the user clicked Stop, the OS ended capture out from under
   * us, or the room disconnected. It must never itself depend on broadcast
   * state, so it stays a single stable reference other callbacks can close
   * over safely, and is declared first so nothing needs a forward reference.
   */
  /** Drops whatever is being published, without touching the stage. */
  const stopPublishing = useCallback(async () => {
    const room = roomRef.current;
    const track = localTrackRef.current;
    if (room && track) {
      await room.localParticipant.unpublishTrack(track, true).catch(() => {});
    }
    track?.mediaStreamTrack.stop();
    localTrackRef.current = null;
    setLocalTrack(null);

    const audio = localAudioRef.current;
    if (audio) {
      if (room) await room.localParticipant.unpublishTrack(audio.track, true).catch(() => {});
      await audio.capture.stop().catch(() => {});
      localAudioRef.current = null;
    }
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    lastSampleRef.current = null;
    setVideoStats(null);
    setAudioWarning(null);
    setAudioLevel(0);
    setAudioLatencyMs(0);
    setCanMonitor(false);

    setBroadcastState('idle');
    setSharingKind(null);
  }, []);

  /**
   * Ends the local publish and releases the stage, unconditionally — whether
   * the user clicked Stop, the OS ended capture, or the room disconnected.
   */
  const stopBroadcast = useCallback(async () => {
    await stopPublishing();
    await window.zoia.stage.release().catch(() => {});
  }, [stopPublishing]);

  /**
   * Publishes a camera and microphone.
   *
   * Kept separate from screen sharing on purpose: there is no window to
   * capture, the audio is a microphone rather than an application, and the
   * frame is small enough that the hardware encoder buys nothing. The tracks
   * still publish as ScreenShare so that every viewer renders them the same
   * way, whatever the stage holder happens to be sharing.
   */
  const startCamera = useCallback(
    async (constraints: MediaStreamConstraints) => {
      setBroadcastError(null);
      setAudioWarning(null);
      setBroadcastState('starting');

      const claim = await window.zoia.stage.claim();
      if (!claim.ok) {
        setBroadcastState('idle');
        setBroadcastError('Could not claim your broadcast slot.');
        return false;
      }

      try {
        setSharingKind('camera');
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const [videoTrack] = stream.getVideoTracks();
        if (!videoTrack) throw new Error('That camera returned no video.');

        const room = roomRef.current;
        if (!room) throw new Error('Not connected to the room.');

        // 'motion' rather than 'detail': a camera image is moving video, not
        // text, and the encoder should favour frame rate over sharpness.
        videoTrack.contentHint = 'motion';
        const local = new LocalVideoTrack(videoTrack, undefined, false);
        local.source = Track.Source.ScreenShare;

        await room.localParticipant.publishTrack(local, {
          source: Track.Source.ScreenShare,
          simulcast: false,
          videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
          stream: 'screen',
        });

        localTrackRef.current = local;
        setLocalTrack(local);
        setBroadcastState('live');

        videoTrack.addEventListener('ended', () => {
          void stopBroadcast();
        });

        const [micTrack] = stream.getAudioTracks();
        if (micTrack) {
          const audioTrack = new LocalAudioTrack(micTrack, undefined, false);
          audioTrack.source = Track.Source.ScreenShareAudio;
          await room.localParticipant.publishTrack(audioTrack, {
            source: Track.Source.ScreenShareAudio,
            stream: 'screen',
          });
          // No capture handle here: the microphone is a plain MediaStream,
          // not the WASAPI bridge, so there is nothing to monitor or meter.
          localAudioRef.current = null;
        } else {
          setAudioWarning('No microphone was available, so the camera is being shared silently.');
        }

        return true;
      } catch (err) {
        await window.zoia.stage.release().catch(() => {});
        setBroadcastState('idle');
        setBroadcastError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [stopBroadcast],
  );

  /**
   * Claims the stage, then captures and publishes the chosen source. The two
   * steps happen in that order deliberately: if someone else already holds
   * the stage, the user never sees a capture prompt at all.
   */
  const startBroadcast = useCallback(
    async (source: SourceInfo, preset?: QualityPreset, { keepStage = false } = {}) => {
      setBroadcastError(null);
      setAudioWarning(null);
      setBroadcastState('starting');

      // Switching what you are sharing keeps the stage you already hold:
      // releasing and re-claiming would briefly free it for someone else and
      // makes the viewer's picture drop out for no reason.
      if (keepStage) {
        await stopPublishing();
      } else {
        const claim = await window.zoia.stage.claim();
        if (!claim.ok) {
          setBroadcastState('idle');
          setBroadcastError('Could not claim your broadcast slot.');
          return false;
        }
      }

      try {
        await window.zoia.sources.select({
          id: source.id,
          name: source.name,
          processId: source.processId,
        });

        const serverQuality = qualityRef.current;
        const quality = preset ? { ...serverQuality, ...preset } : serverQuality;

        // Resolved by the main-process display-media handler, which uses
        // exactly the source just selected above — no native picker appears.
        // Without explicit constraints Chromium picks its own (often lower)
        // resolution and frame rate for screen capture.
        setSharingKind('screen');
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: quality.width },
            height: { ideal: quality.height },
            frameRate: { ideal: quality.maxFramerate },
          },
        });
        const [mediaTrack] = stream.getVideoTracks();
        if (!mediaTrack) throw new Error('No video track was returned for that source.');

        // 'detail'/'text' tell Chromium to favour per-frame quality, which
        // in practice steers it to a *software* encoder (OpenH264) — measured
        // here via encoderImplementation on a machine with an idle RTX 4070.
        // 'motion' keeps the hardware encoder in play, which matters far more
        // at 1080p60 and is the only way 4K is viable at all.
        mediaTrack.contentHint = 'motion';
        const track = new LocalVideoTrack(mediaTrack, undefined, false);
        track.source = Track.Source.ScreenShare;

        const room = roomRef.current;
        if (!room) throw new Error('Not connected to the room.');

        // Without an explicit encoding, LiveKit falls back to a conservative
        // default bitrate meant for camera video — on a desktop/text-heavy
        // screen share that reads as laggy and blurry. maintain-resolution
        // sheds frame rate before resolution under pressure, the right
        // tradeoff for anything with text in it.
        const encoding = {
          maxBitrate: quality.maxBitrate,
          maxFramerate: quality.maxFramerate,
        };
        await room.localParticipant.publishTrack(track, {
          source: Track.Source.ScreenShare,
          simulcast: false,
          degradationPreference: 'maintain-resolution',
          videoEncoding: encoding,
          screenShareEncoding: encoding,
          videoCodec: quality.codec as 'h264' | 'vp8' | 'vp9' | 'av1',
          stream: 'screen',
        });

        localTrackRef.current = track;
        setLocalTrack(track);
        setBroadcastState('live');

        statsTimerRef.current = setInterval(() => {
          void samplePublishStats(track, lastSampleRef, setVideoStats);
        }, 2000);

        // The OS/Chromium can end capture out from under us (window closed,
        // "Stop sharing" bar) — treat that exactly like clicking Stop here.
        mediaTrack.addEventListener('ended', () => {
          void stopBroadcast();
        });

        // Audio is captured and published as its own step, deliberately not
        // inside the same try block as the video path above: a window whose
        // audio session WASAPI can't resolve (a rare edge case) should not
        // take down the video that is already live and working.
        // Screens are shared silently here too, for the same reason: the only
        // audio available for a whole screen is the whole system's.
        if (source.kind !== 'window' || source.processId === null) {
          setAudioWarning(
            source.kind === 'window'
              ? 'That window\u2019s audio could not be identified, so it is being shared silently.'
              : 'Sharing a screen sends no audio. Share a window to send that app\u2019s sound.',
          );
          return true;
        }

        try {
          const capture = await createCaptureAudioTrack(source.processId);
          const audioTrack = new LocalAudioTrack(capture.track, undefined, false);
          audioTrack.source = Track.Source.ScreenShareAudio;

          await room.localParticipant.publishTrack(audioTrack, {
            source: Track.Source.ScreenShareAudio,
            stream: 'screen',
          });

          localAudioRef.current = { track: audioTrack, capture };
          setCanMonitor(capture.canMonitor);
          capture.onStats((stats) => {
            setAudioLevel(stats.peak);
            setAudioLatencyMs(stats.latencyMs);
          });
        } catch (audioErr) {
          setAudioWarning(
            `Audio capture failed for this window: ${
              audioErr instanceof Error ? audioErr.message : String(audioErr)
            }`,
          );
        }

        return true;
      } catch (err) {
        if (!keepStage) await window.zoia.stage.release().catch(() => {});
        setBroadcastState('idle');
        setBroadcastError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [stopBroadcast, stopPublishing],
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
    remoteScreens,
    selectedRemoteIds,
    isReconnecting,
    roomNotice,
    clearRoomNotice: useCallback(() => setRoomNotice(null), []),
    setRemoteSubscription,
    setRemoteQualityMode,
    setRemoteFocus,
    setRemoteAudioOnly,
    participantCount,
    members,
    connect,
    disconnect,
    onData,
    setDisplayName,
    broadcastState,
    broadcastError,
    audioWarning,
    audioLevel,
    audioLatencyMs,
    videoStats,
    canMonitor,
    setMonitorGain: useCallback((value: number) => {
      localAudioRef.current?.capture.setMonitorGain(value);
    }, []),
    localTrack,
    sharingKind,
    startBroadcast,
    startCamera,
    stopBroadcast,
  };
}
