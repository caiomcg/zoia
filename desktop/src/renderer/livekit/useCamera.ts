/**
 * Camera and microphone devices.
 *
 * A webcam is nothing like a screen share: there is no window to capture, and
 * the frame is small enough that software encoding is a non-issue. So it
 * publishes through LiveKit directly rather than through the hardware
 * encoder. It sends a picture only: what you say goes out through voice
 * (ADR 0039), whose settings choose the microphone from the list here.
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

  /** An empty id means "whatever Windows considers the default". */
  const constraints = useCallback(
    (): MediaStreamConstraints => ({
      video: cameraId ? { deviceId: { exact: cameraId } } : true,
      audio: false,
    }),
    [cameraId],
  );

  return {
    devices,
    cameraId,
    chooseCamera,
    constraints,
    error,
    refresh,
  };
}
