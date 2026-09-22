/**
 * The hardware-encoded broadcast path.
 *
 * Unlike the Chromium path, nothing here touches getDisplayMedia or a
 * PeerConnection: ffmpeg captures the desktop on the GPU, encodes with NVENC
 * and publishes over WHIP to a LiveKit ingress, which joins the room as its
 * own participant. This renderer only starts it, stops it, and watches.
 *
 * Two consequences worth knowing:
 *  - it captures the whole screen, not one window, because ddagrab is
 *    Desktop Duplication; per-application *audio* still works, which is the
 *    combination that matters for sharing a game;
 *  - the broadcaster has no local preview from it, since the frames never
 *    enter this process. The preview shows what viewers get by subscribing
 *    to the ingress participant like anyone else.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NvencStatus, QualityPreset } from '../../shared/ipc';

export type GpuBroadcastState = 'idle' | 'starting' | 'live';

export function useGpuBroadcast() {
  const [state, setState] = useState<GpuBroadcastState>('idle');
  const [status, setStatus] = useState<NvencStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(false);

  useEffect(() => {
    return window.zoia.nvenc.onStatus((next) => {
      setStatus(next);
      if (!next.running && activeRef.current) {
        activeRef.current = false;
        setState('idle');
        if (next.error) setError(next.error);
      }
    });
  }, []);

  const start = useCallback(async (preset: QualityPreset, processId: number | null) => {
    setError(null);
    setState('starting');
    try {
      // The stage is claimed by the caller; this only obtains somewhere to
      // publish to. The ingress is per-user and reused across broadcasts.
      const endpoint = await window.zoia.ingress.get();
      await window.zoia.nvenc.start({
        whipUrl: endpoint.url,
        width: preset.width,
        height: preset.height,
        framerate: preset.maxFramerate,
        bitrate: preset.maxBitrate,
        processId,
      });
      activeRef.current = true;
      setState('live');
      return true;
    } catch (err) {
      setState('idle');
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, []);

  const stop = useCallback(async () => {
    activeRef.current = false;
    await window.zoia.nvenc.stop().catch(() => {});
    await window.zoia.ingress.release().catch(() => {});
    setState('idle');
    setStatus(null);
  }, []);

  return { state, status, error, start, stop };
}
