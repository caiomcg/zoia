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
import {
  findLeagueSources,
  isLeagueClient,
  isLeagueSource,
  resolveLeagueTarget,
} from '../../shared/league';

export type GpuBroadcastState = 'idle' | 'starting' | 'live';

export function useGpuBroadcast() {
  const [state, setState] = useState<GpuBroadcastState>('idle');
  const [status, setStatus] = useState<EncoderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(false);
  const activeSourceRef = useRef<SourceInfo | null>(null);
  const leagueFollowRef = useRef<{
    client: SourceInfo | null;
    current: SourceInfo;
    preset: QualityPreset;
  } | null>(null);
  const presetRef = useRef<QualityPreset | null>(null);
  const switchingRef = useRef(false);
  const startRef = useRef<
    ((preset: QualityPreset, source: SourceInfo | null) => Promise<boolean>) | null
  >(null);

  useEffect(() => {
    return window.zoia.encoder.onStatus((next) => {
      setStatus(next);
      if (!next.running && activeRef.current && !switchingRef.current) {
        // If encoder stopped and League is active (e.g. game closed),
        // try to switch back to client instead of going idle immediately.
        if (leagueFollowRef.current && startRef.current && presetRef.current) {
          void (async () => {
            await window.zoia.sources.list(true).catch(() => []);
            for (let attempt = 0; attempt < 24; attempt += 1) {
              if (!activeRef.current) return;
              const currentSources = await window.zoia.sources.list().catch(() => []);
              const target = resolveLeagueTarget(currentSources);
              if (target && target.id !== activeSourceRef.current?.id) {
                const ok = await startRef.current!(presetRef.current!, target);
                if (ok) {
                  if (leagueFollowRef.current) {
                    leagueFollowRef.current.current = target;
                    if (isLeagueClient(target)) leagueFollowRef.current.client = target;
                  }
                  return;
                }
              }
              await new Promise((r) => setTimeout(r, 500));
            }
            activeRef.current = false;
            setState('idle');
            if (next.error) setError(next.error);
            void window.zoia.stage.release().catch(() => {});
          })();
          return;
        }
        activeRef.current = false;
        setState('idle');
        if (next.error) setError(next.error);
        void window.zoia.stage.release().catch(() => {});
      }
    });
  }, []);

  const stop = useCallback(async () => {
    activeRef.current = false;
    activeSourceRef.current = null;
    leagueFollowRef.current = null;
    await window.zoia.encoder.stop().catch(() => {});
    setState('idle');
    setStatus(null);
  }, []);

  const start = useCallback(
    async (preset: QualityPreset, source: SourceInfo | null) => {
      setError(null);
      setState('starting');
      presetRef.current = preset;

      if (source && isLeagueSource(source)) {
        const allSources = await window.zoia.sources.list().catch(() => []);
        const { game, client } = findLeagueSources(allSources);
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

      activeSourceRef.current = source;
      try {
        const isWindow = source?.kind === 'window';
        await window.zoia.encoder.start({
          framerate: preset.maxFramerate,
          bitrate: preset.maxBitrate,
          // Audio and video both follow the chosen application. Sharing a
          // whole screen sends no audio: the alternative is capturing the
          // whole system, which means every notification and every other app
          // going out too.
          processId: isWindow && source ? source.processId : null,
          hwnd: isWindow && source ? source.hwnd : null,
          withAudio: isWindow,
          sourceName: source?.name ?? 'Screen',
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
      const follow = leagueFollowRef.current;
      if (!activeRef.current || !follow || switchingRef.current) return;

      const sources = await window.zoia.sources.list().catch(() => []);
      if (disposed) return;

      const { game, client } = findLeagueSources(sources);
      if (client) {
        follow.client = client;
      }
      const target = game ?? client;
      if (!target || target.id === follow.current.id || !startRef.current || !presetRef.current)
        return;

      switchingRef.current = true;
      try {
        await window.zoia.encoder.stop().catch(() => {});
        const ok = await startRef.current(presetRef.current, target);
        if (ok) {
          follow.current = target;
        }
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
