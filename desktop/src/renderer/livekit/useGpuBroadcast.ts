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

export function useGpuBroadcast() {
  const [state, setState] = useState<GpuBroadcastState>('idle');
  const [status, setStatus] = useState<EncoderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(false);

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
    await window.zoia.encoder.stop().catch(() => {});
    setState('idle');
    setStatus(null);
  }, []);

  const start = useCallback(
    async (preset: QualityPreset, source: SourceInfo | null) => {
      setError(null);
      setState('starting');
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

  return { state, status, error, start, stop };
}
