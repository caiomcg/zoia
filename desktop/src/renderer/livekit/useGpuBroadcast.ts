/**
 * The hardware-encoded broadcast path.
 *
 * Nothing here touches a PeerConnection. A native module captures the window
 * with Windows Graphics Capture and encodes it with NVENC without the pixels
 * ever leaving the GPU; ffmpeg muxes the resulting H.264 with the captured
 * application audio and publishes it over WHIP to a LiveKit ingress, which
 * joins the room as its own participant.
 *
 * Chromium's WebRTC encoder is never involved, which is the entire point: it
 * has no hardware encoder on Windows.
 *
 * There is no local preview, because the encoded stream goes straight out
 * rather than back through this process.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NvencStatus, QualityPreset, SourceInfo } from '../../shared/ipc';

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

  const stop = useCallback(async () => {
    activeRef.current = false;
    await window.zoia.nvenc.stop().catch(() => {});
    await window.zoia.ingress.release().catch(() => {});
    setState('idle');
    setStatus(null);
  }, []);

  const start = useCallback(
    async (preset: QualityPreset, source: SourceInfo | null) => {
      setError(null);
      setState('starting');
      try {
        const endpoint = await window.zoia.ingress.get();
        await window.zoia.nvenc.start({
          whipUrl: endpoint.url,
          framerate: preset.maxFramerate,
          bitrate: preset.maxBitrate,
          // Audio follows the chosen application; video follows its window.
          processId: source?.processId ?? null,
          hwnd: source?.kind === 'window' ? source.hwnd : null,
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

  return { state, status, error, start, stop };
}
