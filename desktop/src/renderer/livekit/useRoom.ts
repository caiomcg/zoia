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
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  ScreenSharePresets,
  Track,
  VideoQuality,
  type RemoteTrack,
  type RemoteVideoTrack,
} from 'livekit-client';
import type { QualityPreset, SourceInfo, TokenResult } from '../../shared/ipc';
import { isLeagueClient, isLeagueGame, isLeagueSource } from '../../shared/league';
import {
  createCaptureAudioTrack,
  wrapAudioTrack,
  type CaptureTrackHandle,
} from '../audio/capture-track';
import { WATCHING_ATTRIBUTE, isWatching, watchingValue } from './watching';
import { AVATAR_ATTRIBUTE, avatarVersion } from '../avatars';
import { createNativeVideo, type NativeVideo } from './native-video';
import { tNow } from '../i18n';

/**
 * macOS shares differently: audio from ScreenCaptureKit's loopback and a
 * single, hardware-encoded video layer. See startBroadcast.
 */
const isMac = window.zoia.app.platform === 'darwin';

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

/**
 * A game launcher commonly destroys its client window and creates a second
 * window for the game. Chromium reports the first capture track as `ended`
 * even though sharing should continue. Give the replacement window time to
 * appear before treating that event as an actual stop.
 *
 * Only a window that appeared after the share started counts. Closing one
 * browser window used to hand the broadcast to another the same browser
 * already had open — same process — so closing what you shared never ended
 * the share.
 */
async function replacementWindow(
  original: SourceInfo,
  known: ReadonlySet<string>,
): Promise<SourceInfo | null> {
  const originalName = original.name.trim().toLocaleLowerCase();
  const leagueSource = isLeagueSource(original) || /league|riot/.test(originalName);

  // Every close waits out this whole window unless a replacement turns up,
  // so it stays short: a launcher opens the game about as it closes itself.
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const sources = await window.zoia.sources.windows().catch(() => []);
    const replacement = sources.find((candidate) => {
      if (candidate.kind !== 'window' || candidate.id === original.id) return false;

      const name = candidate.name.trim().toLocaleLowerCase();
      // The HWND changes during the LoL client -> game handoff, and the game
      // can also have a different PID. Its window title still identifies it.
      if (leagueSource && (isLeagueSource(candidate) || /league|riot/.test(name))) return true;
      if (known.has(candidate.id)) return false;
      // For ordinary applications, prefer the same process or title. This
      // also handles apps that recreate their main window during an update.
      return (
        (original.processId !== null && candidate.processId === original.processId) ||
        name === originalName
      );
    });
    if (replacement) return replacement;

    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function applyRemoteMediaSettings(
  room: Room,
  selected: Set<string>,
  // Broadcasts that get the high layer. null means no layout has said yet:
  // everything high.
  focused: ReadonlySet<string> | null,
  // Broadcasts whose video the server should stop forwarding for now. Their
  // audio keeps flowing; thumbnails resume video only to take a snapshot.
  paused: ReadonlySet<string>,
): void {
  const ownIngress = `${room.localParticipant.identity}${WHIP_SUFFIX}`;
  for (const participant of room.remoteParticipants.values()) {
    if (participant.identity === ownIngress) {
      // Audio of own ingress must NEVER be subscribed (would cause audio feedback loop).
      for (const publication of participant.audioTrackPublications.values()) {
        try {
          publication.setSubscribed(false);
          publication.setEnabled(false);
        } catch {
          // The participant may leave while settings are being applied.
        }
      }
      // Video of own ingress is subscribed for local preview when broadcasting via GPU/WHIP (AMD/Intel).
      for (const publication of participant.videoTrackPublications.values()) {
        try {
          publication.setSubscribed(true);
          publication.setEnabled(true);
        } catch {
          // The participant may leave while settings are being applied.
        }
      }
      continue;
    }
    const identity = ownerIdentity(participant.identity);
    const subscribed = selected.has(identity);
    const quality = focused && !focused.has(identity) ? VideoQuality.LOW : VideoQuality.HIGH;
    for (const publication of participant.videoTrackPublications.values()) {
      try {
        publication.setSubscribed(subscribed);
        publication.setVideoQuality(quality);
        if (subscribed) publication.setEnabled(!paused.has(identity));
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
  sourceName: string | null;
  sourceKind: 'screen' | 'window' | 'camera' | null;
  /** False for a WHIP (hardware) broadcast: one layer, so quality cannot change. */
  simulcast: boolean;
}

/**
 * The one extra layer every in-app broadcast sends. Thumbnails and the "low"
 * quality setting take it; without it there is only the full stream, and
 * asking for a lower quality does nothing. Costs the broadcaster ~400 kbps.
 */
const LOW_LAYER = [ScreenSharePresets.h360fps15];

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
  /** The top simulcast layer: what a viewer on full quality receives. */
  width: number;
  height: number;
  fps: number;
  /** Every layer together: what actually leaves this machine. */
  kbps: number;
  /** What the capture delivers before encoding, measured (media-source stats). */
  captureWidth: number;
  captureHeight: number;
  captureFps: number;
  /** WebRTC's own reason for sending less than asked: cpu, bandwidth, or none. */
  limitation: string;
}

/**
 * What the hardware path is actually sending, measured.
 *
 * The WHIP path has no local RTP sender to ask — ffmpeg publishes straight to
 * the SFU, so `samplePublishStats` has nothing to read and `videoStats` stays
 * null for the whole broadcast. That left the stats card showing the preset's
 * configured bitrate as though it were a measurement. Under `-rc cbr` that
 * happened to be true; under `vbr_latency` it is wrong by up to 300x on a
 * still screen, which is exactly when someone would look.
 *
 * The broadcast does come back, though: a WHIP publisher joins the room under
 * `<identity>-gpu` and the sharer subscribes to it for their own preview (see
 * WHIP_SUFFIX). Its inbound RTP is the stream after the round trip through the
 * SFU, so these are the numbers a viewer gets, not the ones we hoped to send.
 */
export interface IngressStats {
  width: number;
  height: number;
  fps: number;
  kbps: number;
}

/**
 * This machine's own WHIP broadcast, as subscribed back from the room.
 *
 * Looked up per sample rather than held in a ref: the ingress joins, leaves
 * and republishes on its own schedule — every broadcast switch is a new
 * participant — and a ref would need clearing at each of the seven places the
 * preview is torn down. Missing one leaves the card reporting a stream that
 * has stopped.
 */
function ownIngressVideo(room: Room): RemoteVideoTrack | null {
  const participant = room.remoteParticipants.get(
    `${room.localParticipant.identity}${WHIP_SUFFIX}`,
  );
  if (!participant) return null;
  const publication =
    participant.getTrackPublication(Track.Source.ScreenShare) ??
    participant.getTrackPublication(Track.Source.Camera) ??
    [...participant.videoTrackPublications.values()].find((pub) => pub.track);
  const track = publication?.track;
  return track ? (track as RemoteVideoTrack) : null;
}

/**
 * The inbound half of the arithmetic `samplePublishStats` does outbound: a
 * byte counter is cumulative, so a rate needs the previous sample.
 */
async function sampleIngressStats(
  track: RemoteVideoTrack,
  lastSample: { current: { bytes: number; at: number } | null },
  onStats: (stats: IngressStats) => void,
): Promise<void> {
  const receiver = track.receiver;
  if (!receiver) return;

  type Inbound = RTCInboundRtpStreamStats & {
    kind?: string;
    frameWidth?: number;
    frameHeight?: number;
    framesPerSecond?: number;
    bytesReceived?: number;
  };

  const report = await receiver.getStats();
  let inbound: Inbound | undefined;
  report.forEach((entry) => {
    const stat = entry as Inbound;
    if (stat.type === 'inbound-rtp' && stat.kind === 'video') inbound = stat;
  });
  if (!inbound) return;

  const bytes = inbound.bytesReceived ?? 0;
  const now = performance.now();
  const previous = lastSample.current;
  const kbps =
    previous && now > previous.at
      ? Math.round(((bytes - previous.bytes) * 8) / (now - previous.at))
      : 0;
  lastSample.current = { bytes, at: now };

  onStats({
    width: inbound.frameWidth ?? 0,
    height: inbound.frameHeight ?? 0,
    // Instantaneous, unlike ffmpeg's `fps=`, which is a running average over
    // the whole broadcast and so sits frozen on its target after a minute.
    fps: Math.round(inbound.framesPerSecond ?? 0),
    kbps,
  });
}

export interface Viewer {
  identity: string;
  name: string;
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
  broadcastSource: string | null;
  /** The version of their profile picture, when they have one. */
  avatar?: string;
}

function broadcastMetadata(participant: Participant): {
  sourceName: string | null;
  sourceKind: 'screen' | 'window' | 'camera' | null;
} {
  try {
    const value = JSON.parse(participant.metadata || '') as {
      sourceName?: unknown;
      sourceKind?: unknown;
    };
    return {
      sourceName:
        typeof value.sourceName === 'string' && value.sourceName ? value.sourceName : null,
      sourceKind:
        value.sourceKind === 'screen' ||
        value.sourceKind === 'window' ||
        value.sourceKind === 'camera'
          ? value.sourceKind
          : null,
    };
  } catch {
    return { sourceName: null, sourceKind: null };
  }
}

function sourceLabel(sourceName: string | null, sourceKind: string | null): string | null {
  // A camera sends no name: each viewer calls it "Camera" in their own language.
  if (!sourceName) return sourceKind === 'camera' ? tNow('grid.source.camera') : null;
  if (sourceKind === 'window') return tNow('grid.sourceWindow', { name: sourceName });
  if (sourceKind === 'screen') return tNow('grid.sourceScreen', { name: sourceName });
  return sourceName;
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

  type Outbound = RTCOutboundRtpStreamStats & {
    kind?: string;
    encoderImplementation?: string;
    frameWidth?: number;
    frameHeight?: number;
    framesPerSecond?: number;
    bytesSent?: number;
    codecId?: string;
    qualityLimitationReason?: string;
  };

  // A simulcast sender reports one outbound-rtp per layer. This used to keep
  // whichever came last — often a reduced layer — so the numbers looked like
  // the broadcast was missing its resolution and frame rate when only the
  // measurement was. The top layer is the widest; the bitrate is all of them.
  const report = await sender.getStats();
  const layers: Outbound[] = [];
  // What the capture actually delivers, measured: the track's settings only
  // echo what was asked for, so they said 60fps whatever arrived.
  let source: { width?: number; height?: number; framesPerSecond?: number } | undefined;
  report.forEach((entry) => {
    const stat = entry as Outbound;
    if (stat.type === 'outbound-rtp' && stat.kind === 'video') layers.push(stat);
    if (stat.type === 'media-source' && stat.kind === 'video') source = stat;
  });
  if (layers.length === 0) return;
  const top = layers.reduce((best, layer) =>
    (layer.frameWidth ?? 0) > (best.frameWidth ?? 0) ? layer : best,
  );

  let codec = 'unknown';
  if (top.codecId) {
    const entry = report.get(top.codecId) as { mimeType?: string } | undefined;
    if (entry?.mimeType) codec = entry.mimeType.replace('video/', '');
  }

  const bytes = layers.reduce((sum, layer) => sum + (layer.bytesSent ?? 0), 0);
  const now = performance.now();
  const previous = lastSample.current;
  const kbps =
    previous && now > previous.at
      ? Math.round(((bytes - previous.bytes) * 8) / (now - previous.at))
      : 0;
  lastSample.current = { bytes, at: now };

  const settings = track.mediaStreamTrack.getSettings();
  onStats({
    encoder: top.encoderImplementation ?? 'unknown',
    codec,
    width: top.frameWidth ?? 0,
    height: top.frameHeight ?? 0,
    fps: Math.round(top.framesPerSecond ?? 0),
    kbps,
    captureWidth: source?.width ?? settings.width ?? 0,
    captureHeight: source?.height ?? settings.height ?? 0,
    captureFps: Math.round(source?.framesPerSecond ?? 0),
    limitation: top.qualityLimitationReason ?? 'none',
  });
}

export interface SendAudio {
  volume: number;
  muted: boolean;
}

const DEFAULT_SEND_AUDIO: SendAudio = { volume: 1, muted: false };

/** How long the watch list must hold still before it is announced. */
const WATCHING_SETTLE_MS = 1500;

export function useRoom() {
  const roomRef = useRef<Room | null>(null);
  const localTrackRef = useRef<LocalVideoTrack | null>(null);
  // Set while NVENC frames are being sent in place of the track's own.
  const nativeVideoRef = useRef<NativeVideo | null>(null);
  // Track subscribed from own WHIP ingress (AMD/Intel GPU broadcast) for local preview.
  const ingressPreviewRef = useRef<LocalVideoTrack | null>(null);
  // `capture` is null for a camera's microphone: a plain MediaStream, with no
  // WASAPI bridge to meter, set the level of, or stop.
  const localAudioRef = useRef<{
    track: LocalAudioTrack;
    capture: CaptureTrackHandle | null;
  } | null>(null);
  // What viewers hear of the audio this device sends. Kept while you switch
  // source, so a switch does not unmute behind your back; reset when you stop,
  // so the next broadcast starts audible.
  const sendAudioRef = useRef<SendAudio>(DEFAULT_SEND_AUDIO);
  const [sendAudio, setSendAudioState] = useState<SendAudio>(sendAudioRef.current);
  const [sendingAudio, setSendingAudio] = useState(false);
  // Windows that already existed when the share started; see replacementWindow.
  const knownWindowsRef = useRef<Set<string>>(new Set());
  const restartWindowRef = useRef<
    ((source: SourceInfo, preset?: QualityPreset) => Promise<boolean>) | null
  >(null);
  const leagueFollowRef = useRef<{
    client: SourceInfo | null;
    current: SourceInfo;
    preset?: QualityPreset;
  } | null>(null);
  const switchingWindowRef = useRef(false);
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
  const pausedRemoteIdsRef = useRef<ReadonlySet<string>>(new Set());
  const focusedRemoteIdsRef = useRef<ReadonlySet<string> | null>(null);
  // Owners who were publishing at the last refresh. Whoever appears in the
  // next one and not here started broadcasting since, and is watched by default.
  const knownBroadcastersRef = useRef<Set<string>>(new Set());
  const broadcastingNamesRef = useRef(new Map<string, string>());
  const [selectedRemoteIds, setSelectedRemoteIds] = useState<Set<string>>(new Set());
  const [participantCount, setParticipantCount] = useState(0);
  const [members, setMembers] = useState<RoomMember[]>([]);
  // Who is watching this device's broadcast, from their own announcements.
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const announcedWatchingRef = useRef<string | null>(null);
  // The picture version set in this session, if any; undefined until one is.
  const avatarRef = useRef<string | null | undefined>(undefined);
  const announceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Tells the room whose broadcasts this device is watching, once it has
   * settled. A new broadcast is selected the instant it appears and paused
   * into a thumbnail a moment later; announcing each step made a broadcaster's
   * eyes blink on and off for people who were never really watching.
   */
  const announceWatching = useCallback((room: Room) => {
    if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
    announceTimerRef.current = setTimeout(() => {
      announceTimerRef.current = null;
      if (roomRef.current !== room) return;
      const value = watchingValue(selectedRemoteIdsRef.current, pausedRemoteIdsRef.current);
      if (value === announcedWatchingRef.current) return;
      announcedWatchingRef.current = value;
      room.localParticipant.setAttributes({ [WATCHING_ATTRIBUTE]: value }).catch(() => {
        // Forgotten, so the next change tries again rather than assuming it landed.
        announcedWatchingRef.current = null;
      });
    }, WATCHING_SETTLE_MS);
  }, []);

  // The hardware path's own numbers. Same 2s cadence as the Chromium path's
  // `samplePublishStats`, and for the same reason: a rate needs two samples
  // far enough apart that the byte counter has moved.
  useEffect(() => {
    const timer = setInterval(() => {
      const room = roomRef.current;
      const track = room ? ownIngressVideo(room) : null;
      if (!track) {
        // Not sharing on this path, or the ingress went away. Drop the last
        // reading rather than leaving a stale rate on screen.
        ingressSampleRef.current = null;
        setIngressStats(null);
        return;
      }
      void sampleIngressStats(track, ingressSampleRef, setIngressStats).catch(() => {
        // The ingress can leave mid-sample; the next tick finds it gone.
      });
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  // Round trip to the server, from LiveKit's own signalling pings.
  const [pingMs, setPingMs] = useState<number | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      const rtt = roomRef.current?.engine?.client?.rtt;
      setPingMs(typeof rtt === 'number' && rtt > 0 ? Math.round(rtt) : null);
    }, 2000);
    return () => clearInterval(timer);
  }, []);
  const [broadcastState, setBroadcastState] = useState<BroadcastState>('idle');
  const [broadcastError, setBroadcastError] = useState<string | null>(null);
  const [audioWarning, setAudioWarning] = useState<string | null>(null);
  const [localTrack, setLocalTrack] = useState<LocalVideoTrack | null>(null);
  // Peak level of the audio actually being captured, 0..1. This is what lets
  // a broadcaster confirm audio is flowing without a second machine.
  const [audioLevel, setAudioLevel] = useState(0);
  const [audioLatencyMs, setAudioLatencyMs] = useState(0);
  const [videoStats, setVideoStats] = useState<VideoStats | null>(null);
  const [ingressStats, setIngressStats] = useState<IngressStats | null>(null);
  const ingressSampleRef = useRef<{ bytes: number; at: number } | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const titleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSampleRef = useRef<{ bytes: number; at: number } | null>(null);
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
          sourceName:
            broadcastMetadata(participant).sourceName ?? broadcastMetadata(owner).sourceName,
          sourceKind:
            broadcastMetadata(participant).sourceKind ?? broadcastMetadata(owner).sourceKind,
          simulcast: Boolean(videoPub?.simulcasted),
        });
      }
    }
    return screens;
  }, []);

  const connect = useCallback(
    async (wsUrl: string, token: string, quality?: TokenResult['quality']) => {
      setState('connecting');
      setIsReconnecting(false);
      setError(null);
      setRoomNotice(null);
      knownBroadcastersRef.current = new Set();
      if (quality) qualityRef.current = quality;

      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;

      const refresh = () => {
        // Judged by publications, not tracks: a broadcast this viewer chose
        // not to watch has no subscribed track, and must not look new again.
        const publishing = new Set<string>();
        for (const participant of room.remoteParticipants.values()) {
          const owner = ownerIdentity(participant.identity);
          if (owner === room.localParticipant.identity) continue;
          if (participant.trackPublications.size > 0) publishing.add(owner);
        }
        const nextSelected = new Set<string>();
        for (const id of publishing) {
          if (selectedRemoteIdsRef.current.has(id) || !knownBroadcastersRef.current.has(id)) {
            nextSelected.add(id);
          }
        }
        knownBroadcastersRef.current = publishing;
        selectedRemoteIdsRef.current = nextSelected;
        setSelectedRemoteIds(nextSelected);
        // LiveKit auto-subscribes to every new publication. Settling it here
        // is what keeps a deselected broadcast from being downloaded anyway.
        applyRemoteMediaSettings(
          room,
          nextSelected,
          focusedRemoteIdsRef.current,
          pausedRemoteIdsRef.current,
        );
        setRemoteScreens(findRemoteScreens(room));
        setParticipantCount(room.remoteParticipants.size);
        announceWatching(room);

        const ownIngress = `${room.localParticipant.identity}${WHIP_SUFFIX}`;
        const ingressParticipant = room.remoteParticipants.get(ownIngress);
        if (ingressParticipant) {
          const videoPub =
            ingressParticipant.getTrackPublication(Track.Source.ScreenShare) ??
            ingressParticipant.getTrackPublication(Track.Source.Camera) ??
            [...ingressParticipant.videoTrackPublications.values()].find((pub) => pub.track);
          if (videoPub?.track) {
            const mediaStreamTrack = videoPub.track.mediaStreamTrack;
            if (
              !nativeVideoRef.current &&
              localTrackRef.current?.mediaStreamTrack !== mediaStreamTrack
            ) {
              const preview = new LocalVideoTrack(mediaStreamTrack, undefined, false);
              ingressPreviewRef.current = preview;
              localTrackRef.current = preview;
              setLocalTrack(preview);
            }
          }
        } else if (ingressPreviewRef.current) {
          ingressPreviewRef.current = null;
          if (!nativeVideoRef.current) {
            localTrackRef.current = null;
            setLocalTrack(null);
          }
        }

        const me = room.localParticipant.identity;
        setViewers(
          [...room.remoteParticipants.values()]
            .filter((p) => !p.identity.endsWith(WHIP_SUFFIX) && isWatching(p.attributes, me))
            .map((p) => ({ identity: p.identity, name: p.name || p.identity }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );

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
          broadcastSource: sourceLabel(
            broadcastMetadata(p).sourceName,
            broadcastMetadata(p).sourceKind,
          ),
          avatar: avatarVersion(p.attributes?.[AVATAR_ATTRIBUTE]),
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
        const ingressSources = new Map(
          all
            .filter((m) => m.isIngress && m.broadcastSource)
            .map((m) => [ownerIdentity(m.identity), m.broadcastSource as string]),
        );
        const nextMembers = all
          .filter((m) => !m.isIngress)
          .map((m) =>
            ingressOwners.has(m.identity)
              ? {
                  ...m,
                  isBroadcasting: true,
                  broadcastSource: ingressSources.get(m.identity) ?? m.broadcastSource,
                }
              : m,
          );
        broadcastingNamesRef.current = new Map(
          nextMembers
            .filter((member) => member.isBroadcasting)
            .map((member) => [member.identity, member.name]),
        );
        setMembers(nextMembers);
      };

      room
        // Without this, a rename updated the server record and the person's
        // own footer while every list in every client kept the old name.
        .on(RoomEvent.ParticipantNameChanged, () => refresh())
        .on(RoomEvent.ParticipantMetadataChanged, () => refresh())
        .on(RoomEvent.ParticipantAttributesChanged, () => refresh())
        // Permission changes are how losing the stage arrives: the server
        // revokes canPublish and LiveKit pushes it down live.
        .on(RoomEvent.ParticipantPermissionsChanged, () => refresh())
        .on(RoomEvent.LocalTrackUnpublished, () => refresh())
        .on(RoomEvent.TrackPublished, () => refresh())
        .on(RoomEvent.TrackUnpublished, () => refresh())
        .on(RoomEvent.TrackSubscribed, () => refresh())
        .on(RoomEvent.TrackUnsubscribed, () => refresh())
        .on(RoomEvent.ParticipantConnected, () => refresh())
        .on(RoomEvent.ParticipantDisconnected, (participant) => {
          const ownIngress = `${room.localParticipant.identity}${WHIP_SUFFIX}`;
          if (participant.identity === ownIngress && ingressPreviewRef.current) {
            ingressPreviewRef.current = null;
            if (!nativeVideoRef.current) {
              localTrackRef.current = null;
              setLocalTrack(null);
            }
          }
          const ownerId = ownerIdentity(participant.identity);
          const name = broadcastingNamesRef.current.get(ownerId);
          refresh();
          if (name && !broadcastingNamesRef.current.has(ownerId)) {
            setRoomNotice(tNow('room.stoppedSharing', { name }));
          }
        })
        // Every handler below first checks this is still the current room: a
        // room being left (on a channel switch) can emit after its successor
        // has connected, and must not knock that one back to "disconnected".
        .on(RoomEvent.Reconnecting, () => {
          if (roomRef.current !== room) return;
          setIsReconnecting(true);
          setState('connecting');
        })
        .on(RoomEvent.Reconnected, () => {
          if (roomRef.current !== room) return;
          setIsReconnecting(false);
          setState('connected');
          // A full reconnect is a new session, which starts without attributes.
          announcedWatchingRef.current = null;
          // Its token carries the picture as it was when the token was issued,
          // so one changed since is put back.
          if (avatarRef.current !== undefined) {
            room.localParticipant
              .setAttributes({ [AVATAR_ATTRIBUTE]: avatarRef.current ?? '' })
              .catch(() => {});
          }
          refresh();
        })
        .on(RoomEvent.Disconnected, (reason) => {
          if (roomRef.current !== room) return;
          // Leaving on purpose is not a lost connection: disconnect() already
          // puts the state back to idle. Reporting it flashed a red
          // "connection lost" banner, and the top bar's state, on every switch.
          if (reason === DisconnectReason.CLIENT_INITIATED) return;
          setIsReconnecting(false);
          setState('disconnected');
          setError(reason ? tNow('room.closedReason', { reason }) : tNow('room.closed'));
          setBroadcastState('idle');
          ingressPreviewRef.current = null;
          localTrackRef.current = null;
          setLocalTrack(null);
        });

      try {
        await room.connect(wsUrl, token);
        announcedWatchingRef.current = null;
        setState('connected');
        refresh();
      } catch (err) {
        setState('error');
        setError(
          tNow('room.couldNotConnect', {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    },
    [findRemoteScreens, announceWatching],
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

  /**
   * Publishes a new picture version (null: no picture) to the room, for the
   * same reason as setDisplayName: the token only carries the one it was
   * issued with. An empty value removes the attribute.
   */
  const setAvatar = useCallback(async (version: string | null) => {
    avatarRef.current = version;
    await roomRef.current?.localParticipant.setAttributes({ [AVATAR_ATTRIBUTE]: version ?? '' });
  }, []);

  const disconnect = useCallback(async () => {
    // Forgotten before leaving, so the room's own events during the leave are
    // recognised as stale and ignored.
    const leaving = roomRef.current;
    roomRef.current = null;
    await leaving?.disconnect();
    setState('idle');
    setIsReconnecting(false);
    setRoomNotice(null);
    setRemoteScreens([]);
    knownBroadcastersRef.current = new Set();
    pausedRemoteIdsRef.current = new Set();
    focusedRemoteIdsRef.current = null;
    selectedRemoteIdsRef.current = new Set();
    setSelectedRemoteIds(new Set());
    announcedWatchingRef.current = null;
    if (announceTimerRef.current) clearTimeout(announceTimerRef.current);
    announceTimerRef.current = null;
    setViewers([]);
    ingressPreviewRef.current = null;
    localTrackRef.current = null;
    setLocalTrack(null);
  }, []);

  /** The broadcasts shown large with HQ on get the high layer; the rest, the low. */
  const setRemoteFocus = useCallback((identities: readonly string[]) => {
    const focused = new Set(identities);
    focusedRemoteIdsRef.current = focused;
    const room = roomRef.current;
    if (room) {
      applyRemoteMediaSettings(
        room,
        selectedRemoteIdsRef.current,
        focused,
        pausedRemoteIdsRef.current,
      );
    }
  }, []);

  /** Stops video (not audio) for these broadcasts until they are unpaused. */
  const setRemotePaused = useCallback(
    (identities: readonly string[]) => {
      const paused = new Set(identities);
      pausedRemoteIdsRef.current = paused;
      const room = roomRef.current;
      if (room) {
        applyRemoteMediaSettings(
          room,
          selectedRemoteIdsRef.current,
          focusedRemoteIdsRef.current,
          paused,
        );
        announceWatching(room);
      }
    },
    [announceWatching],
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
    if (room && track && !ingressPreviewRef.current) {
      await room.localParticipant.unpublishTrack(track, true).catch(() => {});
    }
    ingressPreviewRef.current = null;
    if (room) await room.localParticipant.setMetadata('').catch(() => {});
    // Clear the identity before stopping the MediaStreamTrack. `stop()` can
    // synchronously emit `ended`; clearing first prevents an explicit Stop or
    // source switch from being mistaken for the LoL window handoff.
    localTrackRef.current = null;
    track?.mediaStreamTrack.stop();
    setLocalTrack(null);
    const native = nativeVideoRef.current;
    nativeVideoRef.current = null;
    if (native) await native.stop();

    const audio = localAudioRef.current;
    if (audio) {
      if (room) await room.localParticipant.unpublishTrack(audio.track, true).catch(() => {});
      if (audio.capture) await audio.capture.stop().catch(() => {});
      else audio.track.mediaStreamTrack.stop();
      localAudioRef.current = null;
    }
    setSendingAudio(false);
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    if (titleTimerRef.current) {
      clearInterval(titleTimerRef.current);
      titleTimerRef.current = null;
    }
    lastSampleRef.current = null;
    setVideoStats(null);
    setAudioWarning(null);
    setAudioLevel(0);
    setAudioLatencyMs(0);

    setBroadcastState('idle');
    setSharingKind(null);
  }, []);

  /**
   * Ends the local publish and releases the stage, unconditionally — whether
   * the user clicked Stop, the OS ended capture, or the room disconnected.
   */
  const stopBroadcast = useCallback(async () => {
    leagueFollowRef.current = null;
    await stopPublishing();
    sendAudioRef.current = DEFAULT_SEND_AUDIO;
    setSendAudioState(DEFAULT_SEND_AUDIO);
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
    async (constraints: MediaStreamConstraints, muteMicrophone = false) => {
      setBroadcastError(null);
      setAudioWarning(null);
      setBroadcastState('starting');

      const claim = await window.zoia.stage.claim();
      if (!claim.ok) {
        setBroadcastState('idle');
        setBroadcastError(tNow('room.couldNotStart'));
        return false;
      }
      try {
        setSharingKind('camera');
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const [videoTrack] = stream.getVideoTracks();
        if (!videoTrack) throw new Error(tNow('room.cameraNoVideo'));

        const room = roomRef.current;
        if (!room) throw new Error(tNow('room.notConnected'));
        await room.localParticipant.setMetadata(
          JSON.stringify({ sourceName: null, sourceKind: 'camera' }),
        );

        // 'motion' rather than 'detail': a camera image is moving video, not
        // text, and the encoder should favour frame rate over sharpness.
        videoTrack.contentHint = 'motion';
        const local = new LocalVideoTrack(videoTrack, undefined, false);
        local.source = Track.Source.ScreenShare;

        await room.localParticipant.publishTrack(local, {
          source: Track.Source.ScreenShare,
          simulcast: true,
          screenShareSimulcastLayers: LOW_LAYER,
          videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
          stream: 'screen',
        });

        ingressPreviewRef.current = null;
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
          // The camera dialog's choice is the footer's mute too, so the two
          // never disagree about what viewers hear.
          sendAudioRef.current = { ...sendAudioRef.current, muted: muteMicrophone };
          setSendAudioState(sendAudioRef.current);
          if (muteMicrophone) await audioTrack.mute();
          await room.localParticipant.publishTrack(audioTrack, {
            source: Track.Source.ScreenShareAudio,
            stream: 'screen',
          });
          localAudioRef.current = { track: audioTrack, capture: null };
          setSendingAudio(true);
        } else {
          setAudioWarning(tNow('room.noMicrophone'));
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
    async (
      source: SourceInfo,
      preset?: QualityPreset,
      { keepStage = false, nativeVideo = false } = {},
    ) => {
      setBroadcastError(null);
      setAudioWarning(null);
      setBroadcastState('starting');

      if (!keepStage) {
        if (isLeagueSource(source)) {
          // When starting a League broadcast, opt for game if open, otherwise client
          const { game, client } = await window.zoia.sources
            .league()
            .catch(() => ({ game: null, client: null }));
          const target = game ?? client ?? source;
          leagueFollowRef.current = {
            client: client ?? (isLeagueClient(source) ? source : null),
            current: target,
            preset,
          };
          source = target;
        } else {
          leagueFollowRef.current = null;
        }
      } else if (!isLeagueSource(source)) {
        // A manual source change turns off the automatic League handoff.
        leagueFollowRef.current = null;
      } else if (leagueFollowRef.current) {
        leagueFollowRef.current.current = source;
        if (isLeagueClient(source)) {
          leagueFollowRef.current.client = source;
        }
      }

      // Switching what you are sharing keeps the stage you already hold:
      // releasing and re-claiming would briefly free it for someone else and
      // makes the viewer's picture drop out for no reason.
      if (keepStage) {
        await stopPublishing();
      } else {
        const claim = await window.zoia.stage.claim();
        if (!claim.ok) {
          setBroadcastState('idle');
          setBroadcastError(tNow('room.couldNotStart'));
          return false;
        }
      }

      // A restart keeps what the original share knew about: the windows open
      // back then are still not replacements for the one being shared.
      const known = await window.zoia.sources.windows().catch(() => []);
      if (!keepStage) knownWindowsRef.current = new Set();
      for (const candidate of known) knownWindowsRef.current.add(candidate.id);

      // Set once the capture is live: what to do when it ends on its own.
      let onCaptureEnded: (() => void) | null = null;

      // The macOS loopback track, from getDisplayMedia until the audio step
      // takes it. Held out here so a video failure in between stops it rather
      // than leaving the system audio capture running.
      let pendingSystemAudio: MediaStreamTrack | null = null;
      try {
        await window.zoia.sources.select({
          id: source.id,
          name: source.name,
          processId: source.processId,
        });

        const serverQuality = qualityRef.current;
        const quality = preset ? { ...serverQuality, ...preset } : serverQuality;

        // NVIDIA on Windows can send NVENC's frames on this same connection
        // instead of Chromium's own encode (see native-video.ts). Everything
        // else about the broadcast — stage, audio, teardown — is shared.
        const nativeTarget =
          source.kind === 'window' && source.hwnd !== null
            ? { hwnd: source.hwnd }
            : source.kind === 'screen' && source.displayId
              ? { displayId: source.displayId }
              : null;
        const useNative = nativeVideo && !isMac && nativeTarget !== null;
        let mediaTrack: MediaStreamTrack;
        if (useNative && nativeTarget) {
          setSharingKind('screen');
          const native = createNativeVideo(nativeTarget, quality, (message) => {
            console.warn('[native-video] capture failed:', message);
            if (nativeVideoRef.current !== native) return;
            if (onCaptureEnded) onCaptureEnded();
            else void stopBroadcast();
          });
          nativeVideoRef.current = native;
          mediaTrack = native.track;
        } else {
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
            // macOS has no per-application capture to lean on, so audio comes
            // with the display stream: ScreenCaptureKit's system loopback,
            // requested by the main-process handler. Measured on macOS 26:
            // without these it arrives mono, with echo cancellation, noise
            // suppression and AGC all on — wrong for music or a game — and it
            // includes Zoia's own playback, so viewers would hear each other
            // come back. restrictOwnAudio removes that (peak 0.80 -> 0.00).
            ...(isMac && {
              audio: {
                channelCount: 2,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                restrictOwnAudio: true,
              } as MediaTrackConstraints,
            }),
          });
          pendingSystemAudio = stream.getAudioTracks()[0] ?? null;
          const [displayTrack] = stream.getVideoTracks();
          if (!displayTrack) throw new Error(tNow('room.noVideoTrack'));
          mediaTrack = displayTrack;

          // 'detail'/'text' tell Chromium to favour per-frame quality, which
          // in practice steers it to a *software* encoder (OpenH264) — measured
          // here via encoderImplementation on a machine with an idle RTX 4070.
          // 'motion' keeps the hardware encoder in play, which matters far more
          // at 1080p60 and is the only way 4K is viable at all.
          mediaTrack.contentHint = 'motion';
        }

        const track = new LocalVideoTrack(mediaTrack, undefined, false);
        track.source = Track.Source.ScreenShare;

        const room = roomRef.current;
        if (!room) throw new Error(tNow('room.notConnected'));
        await room.localParticipant.setMetadata(
          JSON.stringify({ sourceName: source.name, sourceKind: source.kind }),
        );

        // Without an explicit encoding, LiveKit falls back to a conservative
        // default bitrate meant for camera video — on a desktop/text-heavy
        // screen share that reads as laggy and blurry. maintain-resolution
        // sheds frame rate before resolution under pressure, the right
        // tradeoff for anything with text in it.
        const encoding = {
          maxBitrate: quality.maxBitrate,
          maxFramerate: quality.maxFramerate,
        };
        // No simulcast on macOS. Measured there (Electron 44, M1): a single
        // H.264 layer is encoded by VideoToolbox, but the moment a second
        // layer is added Chromium moves *both* to OpenH264 in software, which
        // showed up as skipped frames and 25–50fps against a 58fps target.
        // Viewers lose the 360p layer and always get the full one.
        // One layer for native video: its frames are NVENC's, and a second
        // layer would be the placeholder's.
        const simulcast = !isMac && !useNative;
        await room.localParticipant.publishTrack(track, {
          source: Track.Source.ScreenShare,
          simulcast,
          ...(simulcast && { screenShareSimulcastLayers: LOW_LAYER }),
          degradationPreference: 'maintain-resolution',
          videoEncoding: encoding,
          screenShareEncoding: encoding,
          videoCodec: useNative ? 'h264' : (quality.codec as 'h264' | 'vp8' | 'vp9' | 'av1'),
          stream: 'screen',
        });

        const native = nativeVideoRef.current;
        let nativeSize: { width: number; height: number } | null = null;
        if (useNative && native) {
          // Before any frame exists, so none goes out as the placeholder.
          const sender = track.sender;
          if (!sender) throw new Error('The published track has no sender.');
          native.attach(sender);
          nativeSize = await native.start();
        }

        ingressPreviewRef.current = null;
        localTrackRef.current = track;
        // The native path's published track is a placeholder with no picture;
        // what the sharer sees of themselves is NVENC's output, decoded.
        setLocalTrack(
          useNative && native ? new LocalVideoTrack(native.preview, undefined, false) : track,
        );
        setBroadcastState('live');

        statsTimerRef.current = setInterval(() => {
          // On the native path the sender's own numbers describe the
          // placeholder it encodes; frame rate and bitrate are the real
          // stream's, but the encoder and size are NVENC's.
          // Asked each time: the stream changes size with the shared window.
          const size = nativeSize && native ? native.size() : null;
          void samplePublishStats(
            track,
            lastSampleRef,
            size
              ? (stats) =>
                  setVideoStats({
                    ...stats,
                    encoder: 'NVENC',
                    codec: 'H264',
                    width: size.width,
                    height: size.height,
                    captureWidth: size.width,
                    captureHeight: size.height,
                    captureFps: stats.fps,
                  })
              : setVideoStats,
          );
        }, 2000);

        // A window's title moves on (a browser tab, a document), and the
        // label viewers see was only ever the one it had at the start.
        const hwnd = source.kind === 'window' ? source.hwnd : null;
        if (hwnd !== null) {
          let label = source.name;
          titleTimerRef.current = setInterval(() => {
            void window.zoia.sources.title(hwnd).then(async (title) => {
              if (!title || title === label || localTrackRef.current !== track) return;
              label = title;
              await room.localParticipant
                .setMetadata(JSON.stringify({ sourceName: title, sourceKind: source.kind }))
                .catch(() => {});
            });
          }, 3000);
        }

        // The OS/Chromium can end capture out from under us (window closed,
        // "Stop sharing" bar) — treat that exactly like clicking Stop here.
        // The native path learns of it as an error rather than `ended`.
        onCaptureEnded = () => {
          // `stopPublishing()` deliberately stops the same MediaStreamTrack.
          // Do not start a recovery for an explicit stop or source switch.
          if (localTrackRef.current?.mediaStreamTrack !== mediaTrack) return;

          void (async () => {
            if (leagueFollowRef.current && restartWindowRef.current) {
              setRoomNotice(tNow('league.matchEnded'));
              for (let attempt = 0; attempt < 24; attempt += 1) {
                if (!leagueFollowRef.current) return;
                const { game, client } = await window.zoia.sources
                  .league()
                  .catch(() => ({ game: null, client: null }));
                const target = game ?? client;
                if (target && target.id !== source.id) {
                  const ok = await restartWindowRef.current(target, leagueFollowRef.current.preset);
                  if (ok) {
                    leagueFollowRef.current.current = target;
                    if (isLeagueClient(target)) leagueFollowRef.current.client = target;
                    setRoomNotice(
                      isLeagueGame(target) ? tNow('league.toGame') : tNow('league.toClient'),
                    );
                    return;
                  }
                }
                await new Promise((r) => setTimeout(r, 500));
              }
            }

            if (source.kind === 'window') {
              const replacement = await replacementWindow(source, knownWindowsRef.current);
              if (replacement && restartWindowRef.current) {
                const ok = await restartWindowRef.current(replacement, preset);
                if (ok) return;
              }
            }
            await stopBroadcast();
          })();
        };
        mediaTrack.addEventListener('ended', onCaptureEnded);

        // Audio is captured and published as its own step, deliberately not
        // inside the same try block as the video path above: a window whose
        // audio session WASAPI can't resolve (a rare edge case) should not
        // take down the video that is already live and working.
        // Screens are shared silently here too, for the same reason: the only
        // audio available for a whole screen is the whole system's.
        // On macOS a window's audio cannot be isolated, so screens and windows
        // alike carry the system's, minus Zoia's own.
        const systemAudio = pendingSystemAudio;
        pendingSystemAudio = null;
        if (isMac && !systemAudio) {
          setAudioWarning(tNow('room.macNoAudio'));
          return true;
        }
        if (!isMac && (source.kind !== 'window' || source.processId === null)) {
          setAudioWarning(
            source.kind === 'window' ? tNow('room.windowNoAudio') : tNow('room.screenNoAudio'),
          );
          return true;
        }

        try {
          const capture = systemAudio
            ? await wrapAudioTrack(systemAudio)
            : await createCaptureAudioTrack(source.processId);
          const audioTrack = new LocalAudioTrack(capture.track, undefined, false);
          audioTrack.source = Track.Source.ScreenShareAudio;

          await room.localParticipant.publishTrack(audioTrack, {
            source: Track.Source.ScreenShareAudio,
            stream: 'screen',
          });

          capture.setSendGain(sendAudioRef.current.volume);
          if (sendAudioRef.current.muted) await audioTrack.mute();
          localAudioRef.current = { track: audioTrack, capture };
          setSendingAudio(true);
          capture.onStats((stats) => {
            setAudioLevel(stats.peak);
            setAudioLatencyMs(stats.latencyMs);
          });
          // Said every time, because it is the surprising part: a notification
          // or another app's sound goes out too.
          if (systemAudio) setAudioWarning(tNow('room.macSystemAudio'));
        } catch (audioErr) {
          systemAudio?.stop();
          setAudioWarning(
            tNow('room.audioFailed', {
              error: audioErr instanceof Error ? audioErr.message : String(audioErr),
            }),
          );
        }

        return true;
      } catch (err) {
        pendingSystemAudio?.stop();
        const native = nativeVideoRef.current;
        nativeVideoRef.current = null;
        if (native) await native.stop();
        if (!keepStage) await window.zoia.stage.release().catch(() => {});
        setBroadcastState('idle');
        setBroadcastError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [stopBroadcast, stopPublishing],
  );

  // Keep this in a ref so the ended-track listener can restart through the
  // same publishing path without closing over a stale callback.
  restartWindowRef.current = (source, preset) =>
    startBroadcast(source, preset, { keepStage: true });

  // League of Legends keeps its launcher window open while the game creates a
  // separate window and process. Follow that process pair without asking the
  // user to stop and start the broadcast manually.
  useEffect(() => {
    let disposed = false;

    const followLeagueWindow = async () => {
      const follow = leagueFollowRef.current;
      if (!follow || !localTrackRef.current || switchingWindowRef.current) return;

      const { game, client } = await window.zoia.sources
        .league()
        .catch(() => ({ game: null, client: null }));
      if (disposed) return;

      if (client) {
        follow.client = client;
      }
      const target = game ?? client;

      if (!target || target.id === follow.current.id || !restartWindowRef.current) return;

      switchingWindowRef.current = true;
      try {
        const ok = await restartWindowRef.current(target, follow.preset);
        if (ok) {
          follow.current = target;
          if (isLeagueGame(target)) {
            setRoomNotice(tNow('league.toGame'));
          } else if (isLeagueClient(target)) {
            setRoomNotice(tNow('league.toClient'));
          }
        }
      } finally {
        switchingWindowRef.current = false;
      }
    };

    const timer = setInterval(() => void followLeagueWindow(), 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

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
    setRemotePaused,
    setRemoteFocus,
    participantCount,
    members,
    viewers,
    pingMs,
    connect,
    disconnect,
    setDisplayName,
    setAvatar,
    broadcastState,
    broadcastError,
    audioWarning,
    audioLevel,
    audioLatencyMs,
    videoStats,
    ingressStats,
    sendingAudio,
    /**
     * Only the WASAPI path has a gain stage; a camera's microphone can only
     * mute. Read at render: the ref is set before setSendingAudio(true), which
     * is what re-renders.
     */
    canSetSendVolume: sendingAudio && Boolean(localAudioRef.current?.capture),
    sendAudio,
    /**
     * Sets what viewers hear. The track stays published and captured while
     * muted, so unmuting is instant.
     */
    setSendAudio: useCallback(async (next: SendAudio) => {
      const previous = sendAudioRef.current;
      sendAudioRef.current = next;
      setSendAudioState(next);
      const audio = localAudioRef.current;
      if (!audio) return;
      audio.capture?.setSendGain(next.volume);
      if (next.muted !== previous.muted) {
        await (next.muted ? audio.track.mute() : audio.track.unmute());
      }
    }, []),
    localTrack,
    sharingKind,
    startBroadcast,
    startCamera,
    stopBroadcast,
  };
}
