/**
 * Camera and microphone devices.
 *
 * A webcam is nothing like a screen share: there is no window to capture, the
 * audio comes from a microphone rather than an application, and the frame is
 * small enough that software encoding is a non-issue. So it publishes through
 * LiveKit directly rather than through the hardware encoder.
 */

import { useCallback, useEffect, useState } from 'react';

export interface MediaDeviceChoice {
  deviceId: string;
  label: string;
}

export interface Devices {
  cameras: MediaDeviceChoice[];
  microphones: MediaDeviceChoice[];
}

const CAMERA_KEY = 'zoia.cameraId';
const MIC_KEY = 'zoia.microphoneId';

/**
 * Labels are hidden until a capture permission has been granted at least
 * once, so an unprompted enumeration returns anonymous entries. Rather than
 * show "Camera 1", this asks for a stream, reads the list, and immediately
 * stops the tracks.
 */
async function enumerateWithLabels(): Promise<Devices> {
  let devices = await navigator.mediaDevices.enumerateDevices();

  if (devices.some((d) => (d.kind === 'videoinput' || d.kind === 'audioinput') && !d.label)) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      probe.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      // Permission refused, or no device at all. The anonymous list is still
      // more useful than nothing.
    }
  }

  const pick = (kind: MediaDeviceKind, fallback: string) =>
    devices
      .filter((d) => d.kind === kind)
      .map((d, index) => ({
        deviceId: d.deviceId,
        label: d.label || `${fallback} ${index + 1}`,
      }));

  return {
    cameras: pick('videoinput', 'Camera'),
    microphones: pick('audioinput', 'Microphone'),
  };
}

export function useCameraDevices() {
  const [devices, setDevices] = useState<Devices>({ cameras: [], microphones: [] });
  const [cameraId, setCameraId] = useState(() => localStorage.getItem(CAMERA_KEY) ?? '');
  const [microphoneId, setMicrophoneId] = useState(() => localStorage.getItem(MIC_KEY) ?? '');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await enumerateWithLabels();
      setDevices(next);
      setError(null);

      // A remembered device that has since been unplugged would otherwise
      // fail at capture time; falling back to the system default is what
      // someone expects from "my webcam".
      setCameraId((current) =>
        current && !next.cameras.some((c) => c.deviceId === current) ? '' : current,
      );
      setMicrophoneId((current) =>
        current && !next.microphones.some((m) => m.deviceId === current) ? '' : current,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange);
  }, [refresh]);

  const chooseCamera = useCallback((id: string) => {
    setCameraId(id);
    localStorage.setItem(CAMERA_KEY, id);
  }, []);

  const chooseMicrophone = useCallback((id: string) => {
    setMicrophoneId(id);
    localStorage.setItem(MIC_KEY, id);
  }, []);

  /** An empty id means "whatever Windows considers the default". */
  const constraints = useCallback(
    (): MediaStreamConstraints => ({
      video: cameraId ? { deviceId: { exact: cameraId } } : true,
      audio: microphoneId ? { deviceId: { exact: microphoneId } } : true,
    }),
    [cameraId, microphoneId],
  );

  return {
    devices,
    cameraId,
    microphoneId,
    chooseCamera,
    chooseMicrophone,
    constraints,
    error,
    refresh,
  };
}
