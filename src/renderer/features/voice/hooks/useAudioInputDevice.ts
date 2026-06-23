import { useCallback, useEffect, useState } from 'react';

export type UseAudioInputDeviceResult = {
  /** The label of the default audio input device, or null if not available */
  deviceLabel: string | null;
  /** Whether we're still loading the device list */
  isLoading: boolean;
  /** Refresh the device list manually */
  refresh: () => void;
};

/**
 * Hook to get the current default audio input device label.
 * Updates automatically when devices are connected/disconnected.
 *
 * Note: Device labels are empty until microphone permission is granted.
 * Returns "Grant permission to see device" in that case.
 */
export function useAudioInputDevice(): UseAudioInputDeviceResult {
  const [deviceLabel, setDeviceLabel] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const updateDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDeviceLabel(null);
      setIsLoading(false);
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === 'audioinput');

      if (audioInputs.length === 0) {
        setDeviceLabel(null);
        setIsLoading(false);
        return;
      }

      // Find the "default" device first, otherwise use the first audioinput
      const defaultDevice =
        audioInputs.find((d) => d.deviceId === 'default') || audioInputs[0];

      if (!defaultDevice.label) {
        // Labels are empty until permission is granted
        setDeviceLabel('Grant permission to see device');
      } else {
        // Clean up common prefixes like "Default - " that browsers add
        let label = defaultDevice.label;
        if (label.startsWith('Default - ')) {
          label = label.slice('Default - '.length);
        }
        setDeviceLabel(label);
      }
    } catch {
      setDeviceLabel(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void updateDevices();

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) return;

    mediaDevices.addEventListener('devicechange', updateDevices);
    return () => {
      mediaDevices.removeEventListener('devicechange', updateDevices);
    };
  }, [updateDevices]);

  return { deviceLabel, isLoading, refresh: updateDevices };
}
