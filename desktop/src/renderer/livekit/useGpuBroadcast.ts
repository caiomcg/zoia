/**
 * The hardware-encoded broadcast path.
 *
 * Nothing here touches a PeerConnection. A native module captures the window
 * with Windows Graphics Capture and encodes it with NVENC without the pixels
 * ever leaving the GPU; ffmpeg muxes the resulting H.264 with the captured
 * application audio and publishes it over WHIP straight to the SFU, where it
 * joins the room as its own participant (`<identity>-gpu`). The main process
 * fetches the endpoint and its publish token; this hook never sees either.
 *
 * Chromium's WebRTC encoder is never involved, which is the entire point: it
 * has no hardware encoder on Windows.
 *
 * There is no local preview, because the encoded stream goes straight out
 * rather than back through this process.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EncoderStatus, QualityPreset, SourceInfo } from '../../shared/ipc';

export type GpuBroadcastState = 'idle' | 'starting' | 'live';

const LEAGUE_CLIENT_EXECUTABLE = 'leagueclient.exe';
const LEAGUE_GAME_EXECUTABLE = 'league of legends.exe';

function executableName(source: SourceInfo): string {
  const path = source.processPath?.replaceAll('\\', '/');
  return path?.slice(path.lastIndexOf('/') + 1).toLowerCase() ?? '';
}

function isLeagueSource(source: SourceInfo, executable: string): boolean {
  return source.kind === 'window' && executableName(source) === executable;
}

export function useGpuBroadcast() {
  const [state, setState] = useState<GpuBroadcastState>('idle');
  const [status, setStatus] = useState<EncoderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(false);
  const activeSourceRef = useRef<SourceInfo | null>(null);
  const leagueClientRef = useRef<SourceInfo | null>(null);
  const presetRef = useRef<QualityPreset | null>(null);
  const switchingRef = useRef(false);
  const startRef = useRef<
    ((preset: QualityPreset, source: SourceInfo | null) => Promise<boolean>) | null
  >(null);

  useEffect(() => {
    return window.zoia.encoder.onStatus((next) => {
      setStatus(next);
      if (!next.running && activeRef.current) {
        activeRef.current = false;
        setState('idle');
        if (next.error) setError(next.error);
      }
    });
  }, []);

  const stop = useCallback(async () => {
    activeRef.current = false;
    activeSourceRef.current = null;
    leagueClientRef.current = null;
    await window.zoia.encoder.stop().catch(() => {});
    setState('idle');
    setStatus(null);
  }, []);

  const start = useCallback(
    async (preset: QualityPreset, source: SourceInfo | null) => {
      setError(null);
      setState('starting');
      presetRef.current = preset;
      activeSourceRef.current = source;
      if (source && isLeagueSource(source, LEAGUE_CLIENT_EXECUTABLE)) {
        leagueClientRef.current = source;
      } else if (!source || !isLeagueSource(source, LEAGUE_GAME_EXECUTABLE)) {
        leagueClientRef.current = null;
      }
      try {
        const isWindow = source?.kind === 'window';
        await window.zoia.encoder.start({
          framerate: preset.maxFramerate,
          bitrate: preset.maxBitrate,
          // Audio and video both follow the chosen application. Sharing a
          // whole screen sends no audio: the alternative is capturing the
          // whole system, which means every notification and every other app
          // going out too.
          processId: isWindow ? source.processId : null,
          hwnd: isWindow ? source.hwnd : null,
          withAudio: isWindow,
          sourceName: source?.name ?? 'Tela',
          sourceKind: source?.kind ?? 'screen',
        });
        activeRef.current = true;
        setState('live');
        return true;
      } catch (err) {
        await stop();
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [stop],
  );

  startRef.current = start;

  // The GPU path uses the same native window identity, so it also follows the
  // League launcher/game handoff instead of remaining pinned to the launcher.
  useEffect(() => {
    let disposed = false;

    const followLeagueWindow = async () => {
      const current = activeSourceRef.current;
      const client = leagueClientRef.current;
      if (!activeRef.current || !current || !client || switchingRef.current) return;

      const sources = await window.zoia.sources.list().catch(() => []);
      if (disposed) return;

      const game = sources.find((source) => isLeagueSource(source, LEAGUE_GAME_EXECUTABLE));
      const launcher =
        sources.find((source) => isLeagueSource(source, LEAGUE_CLIENT_EXECUTABLE)) ?? client;
      const target = game ?? launcher;
      if (!target || target.id === current.id || !startRef.current || !presetRef.current) return;

      switchingRef.current = true;
      try {
        await window.zoia.encoder.stop().catch(() => {});
        await startRef.current(presetRef.current, target);
      } finally {
        switchingRef.current = false;
      }
    };

    const timer = setInterval(() => void followLeagueWindow(), 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return { state, status, error, start, stop };
}
