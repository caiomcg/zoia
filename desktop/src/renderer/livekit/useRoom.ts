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
  type RemoteTrack,
} from 'livekit-client';
import type { QualityPreset, SourceInfo, TokenResult } from '../../shared/ipc';
import { createCaptureAudioTrack, type CaptureTrackHandle } from '../audio/capture-track';

export interface RemoteScreen {
  participantIdentity: string;
  participantName: string;
  videoTrack: RemoteTrack;
  audioTrack: RemoteTrack | null;
}

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
   * The hardware-encoding path joins as its own ingress participant, which
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
  const [remoteScreen, setRemoteScreen] = useState<RemoteScreen | null>(null);
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

  const findRemoteScreen = useCallback((room: Room): RemoteScreen | null => {
    for (const participant of room.remoteParticipants.values()) {
      const videoPub = participant.getTrackPublication(Track.Source.ScreenShare);
      if (videoPub?.track) {
        const audioPub = participant.getTrackPublication(Track.Source.ScreenShareAudio);
        return {
          participantIdentity: participant.identity,
          participantName: participant.name || participant.identity,
          videoTrack: videoPub.track,
          audioTrack: audioPub?.track ?? null,
        };
      }
    }
    return null;
  }, []);

  const connect = useCallback(
    async (wsUrl: string, token: string, quality?: TokenResult['quality']) => {
      setState('connecting');
      setError(null);
      if (quality) qualityRef.current = quality;

      const room = new Room({ adaptiveStream: false, dynacast: false });
      roomRef.current = room;

      const refresh = () => {
        setRemoteScreen(findRemoteScreen(room));
        setParticipantCount(room.remoteParticipants.size);

        const describe = (p: Participant, isLocal: boolean): RoomMember => ({
          identity: p.identity,
          name: p.name || p.identity,
          isLocal,
          isBroadcasting: Boolean(p.getTrackPublication(Track.Source.ScreenShare)),
          // Ingress participants are created by the server with a "-nvenc"
          // suffix on the publisher's own identity, so they can be folded
          // back into that person rather than listed separately.
          isIngress: p.identity.endsWith('-nvenc'),
        });

        const all = [
          describe(room.localParticipant, true),
          ...[...room.remoteParticipants.values()].map((p) => describe(p, false)),
        ];

        // Fold each ingress participant into the human it belongs to, so one
        // person sharing their screen is one row that says "live".
        const ingressOwners = new Set(
          all.filter((m) => m.isIngress).map((m) => m.identity.replace(/-nvenc$/, '')),
        );
        setMembers(
          all
            .filter((m) => !m.isIngress)
            .map((m) => (ingressOwners.has(m.identity) ? { ...m, isBroadcasting: true } : m)),
        );
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
    await window.zoia.stage.release().catch(() => {});
  }, []);

  /**
   * Claims the stage, then captures and publishes the chosen source. The two
   * steps happen in that order deliberately: if someone else already holds
   * the stage, the user never sees a capture prompt at all.
   */
  const startBroadcast = useCallback(
    async (source: SourceInfo, preset?: QualityPreset) => {
      setBroadcastError(null);
      setAudioWarning(null);
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

        const serverQuality = qualityRef.current;
        const quality = preset ? { ...serverQuality, ...preset } : serverQuality;

        // Resolved by the main-process display-media handler, which uses
        // exactly the source just selected above — no native picker appears.
        // Without explicit constraints Chromium picks its own (often lower)
        // resolution and frame rate for screen capture.
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

          if (source.processId === null) {
            setAudioWarning('Sharing a screen captures your whole system’s audio, not one app.');
          }
        } catch (audioErr) {
          setAudioWarning(
            `Audio capture failed for this window: ${
              audioErr instanceof Error ? audioErr.message : String(audioErr)
            }`,
          );
        }

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
    members,
    connect,
    disconnect,
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
    startBroadcast,
    stopBroadcast,
  };
}
