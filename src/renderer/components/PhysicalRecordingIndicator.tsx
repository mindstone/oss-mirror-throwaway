/**
 * Physical Recording Indicator
 *
 * Shows a small indicator when Limitless Pendant is connected but not recording.
 * When recording starts, status goes through MeetingStatusIndicator via broadcast.
 *
 * Performance: Only polls when user has a Limitless device configured in settings.
 */

import { useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import './PhysicalRecordingIndicator.css';

interface DeviceStatus {
  status: 'disconnected' | 'scanning' | 'connecting' | 'connected' | 'error';
  isRecording: boolean;
  device?: {
    name: string;
    rssi: number;
  };
  batteryLevel?: number;
}

/**
 * Shows a small indicator when Limitless Pendant is connected.
 * Hides when recording (MeetingStatusIndicator takes over).
 */
export function PhysicalRecordingIndicator() {
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const [hasLimitlessDevice, setHasLimitlessDevice] = useState(false);

  // Check settings once on mount to see if user has a Limitless device configured
  useEffect(() => {
    window.settingsApi?.get().then(settings => {
      // Type assertion needed: Zod schema doesn't include limitless yet (schema drift)
      const limitless = (settings?.meetingBot as { limitless?: { lastConnectedDeviceId?: string } } | undefined)?.limitless;
      const hasDevice = !!limitless?.lastConnectedDeviceId;
      setHasLimitlessDevice(hasDevice);
    }).catch(() => {});
  }, []);

  // Only poll when device is configured; use backoff when not connected
  // PERF: Poll every 2s when connected (real-time status matters), every 10s otherwise
  // (reconnect detection only). Polling is the sole reconnect mechanism — never stop entirely.
  const pollIntervalMs = status?.status === 'connected' ? 2000 : 10000;

  useEffect(() => {
    if (!hasLimitlessDevice) return;

    // Get initial status
    window.physicalRecordingApi?.getState?.().then(setStatus).catch(() => {});

    // Poll for status updates (interval adapts via pollIntervalMs dep)
    const interval = setInterval(() => {
      window.physicalRecordingApi?.getState?.().then(setStatus).catch(() => {});
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [hasLimitlessDevice, pollIntervalMs]);

  // Don't render if no device configured or not connected
  if (!hasLimitlessDevice || !status || status.status !== 'connected' || status.isRecording) {
    return null;
  }

  const batteryText = status.batteryLevel != null ? `${status.batteryLevel}%` : '';
  const deviceName = status.device?.name || 'Limitless Pendant';
  // Ensure "Limitless" prefix for clarity
  const displayName = deviceName.toLowerCase().includes('limitless') ? deviceName : `Limitless ${deviceName}`;
  const tooltipText = `${displayName} connected${batteryText ? ` • Battery: ${batteryText}` : ''}`;

  return (
    <Tooltip content={tooltipText} delayShow={300}>
      <div className="physical-recording-indicator">
        <Radio className="physical-recording-indicator__icon" size={12} />
      </div>
    </Tooltip>
  );
}
