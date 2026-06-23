/**
 * Unified Voice Recorders Section
 *
 * Combines Limitless Pendant (BLE) and Plaud (cloud sync) device management
 * into a single settings section with device cards.
 */

import { useCallback, useEffect, useState } from 'react';
import { useVisibilityAwareInterval } from '@renderer/hooks/useVisibilityAwareInterval';
import { Button } from '@renderer/components/ui';
import {
  Bluetooth,
  BluetoothSearching,
  BluetoothConnected,
  Battery,
  BatteryLow,
  BatteryMedium,
  BatteryFull,
  Mic,
  RefreshCw,
  Loader2,
  Circle,
  Square,
  Unplug,
  Cloud,
  CloudOff,
  CheckCircle,
  AlertCircle,
} from 'lucide-react';
import type { MeetingBotSettings } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { ConnectorSetupDialog } from '../ConnectorSetupDialog';
import { useConnectorSetupGuidance } from '../../hooks/useConnectorSetupGuidance';
import styles from '../SettingsSurface.module.css';

interface VoiceRecordersSectionProps {
  meetingBot: MeetingBotSettings;
  updateMeetingBot: (updates: Partial<MeetingBotSettings>) => void;
  spaces: SpaceInfo[];
  defaultOneOnOneName: string;
  /** The Chief of Staff space (for persisting defaults) */
  chiefOfStaffSpace?: SpaceInfo;
  /** Whether transcription is available (either local model installed or OpenAI API key configured) */
  canTranscribe: boolean;
  /** Reason why transcription isn't available (for display in UI) */
  transcriptionBlockedReason?: string;
}

// Limitless device types
interface LimitlessDeviceInfo {
  id: string;
  name: string;
  rssi: number;
}

interface LimitlessState {
  status: 'disconnected' | 'scanning' | 'connecting' | 'connected' | 'error';
  device?: LimitlessDeviceInfo;
  batteryLevel?: number;
  isRecording: boolean;
  recordingStartTime?: string;
  error?: string;
}

// Plaud connection types
interface PlaudConnectionState {
  connected: boolean;
  account?: {
    userId: string;
    email: string;
    nickname?: string;
    connectedAt: string;
  };
  lastSyncTime: string | null;
  syncInProgress: boolean;
  error?: string;
}

export const VoiceRecordersSection = ({
  meetingBot,
  updateMeetingBot,
  spaces,
  defaultOneOnOneName,
  chiefOfStaffSpace,
  canTranscribe,
  transcriptionBlockedReason,
}: VoiceRecordersSectionProps) => {
  // Persist default physical meeting space when spaces are loaded and setting is empty
  // This ensures the backend has an explicit path rather than relying on scanSpaces() fallback
  useEffect(() => {
    if (spaces.length === 0) return;
    
    // If physical meeting space is not set but we have a Chief of Staff, persist it
    if (!meetingBot.physicalMeetingSpaceId && chiefOfStaffSpace) {
      updateMeetingBot({ physicalMeetingSpaceId: chiefOfStaffSpace.path });
    }
  }, [spaces, chiefOfStaffSpace, meetingBot.physicalMeetingSpaceId, updateMeetingBot]);
  // Limitless state
  const [limitlessState, setLimitlessState] = useState<LimitlessState>({
    status: 'disconnected',
    isRecording: false,
  });
  const [discoveredDevices, setDiscoveredDevices] = useState<LimitlessDeviceInfo[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);

  // Plaud state
  const [plaudState, setPlaudState] = useState<PlaudConnectionState>({
    connected: false,
    lastSyncTime: null,
    syncInProgress: false,
  });
  const [isPlaudConnecting, setIsPlaudConnecting] = useState(false);
  const [plaudConnectError, setPlaudConnectError] = useState<string | null>(null);
  const setupGuidanceDialog = useConnectorSetupGuidance();

  // Fetch Plaud state on mount
  useEffect(() => {
    const fetchPlaudState = async () => {
      try {
        const result = await window.plaudApi.getConnectionState();
        setPlaudState(result);
      } catch (err) {
        console.error('Failed to get Plaud state:', err);
      }
    };
    fetchPlaudState();
  }, []);

  // Poll for Limitless state changes (auto-connect may complete after settings opened)
  // Pause when hidden since settings UI only matters when visible
  useVisibilityAwareInterval(
    async () => {
      try {
        const result = await window.physicalRecordingApi.getState();
        setLimitlessState(result);
      } catch (err) {
        console.error('Failed to get Limitless state:', err);
      }
    },
    2000, // foreground: 2s
    null  // background: pause completely
  );

  // Reset recording duration when not recording
  useEffect(() => {
    if (!limitlessState.isRecording) {
      setRecordingDuration(0);
    }
  }, [limitlessState.isRecording]);

  // Limitless recording duration timer
  // Pause when hidden since settings UI only matters when visible
  useVisibilityAwareInterval(
    async () => {
      if (!limitlessState.isRecording) return;
      try {
        const result = await window.physicalRecordingApi.getRecordingDuration();
        setRecordingDuration(result.duration);
      } catch {
        // Ignore errors
      }
    },
    1000, // foreground: 1s
    null, // background: pause completely
    [limitlessState.isRecording]
  );

  // Limitless handlers
  const handleLimitlessScan = useCallback(async () => {
    setIsScanning(true);
    setDiscoveredDevices([]);

    try {
      const result = await window.physicalRecordingApi.scanDevices({ timeoutMs: 10000 });
      if (result.success) {
        setDiscoveredDevices(result.devices);
      }
    } catch (err) {
      console.error('Failed to scan for devices:', err);
    } finally {
      setIsScanning(false);
      const newState = await window.physicalRecordingApi.getState();
      setLimitlessState(newState);
    }
  }, []);

  const handleLimitlessConnect = useCallback(async (deviceId: string) => {
    try {
      setLimitlessState((prev) => ({ ...prev, status: 'connecting' }));
      const result = await window.physicalRecordingApi.connect({ deviceId });
      if (!result.success) {
        setLimitlessState((prev) => ({ ...prev, status: 'error', error: result.error }));
        return;
      }
      const newState = await window.physicalRecordingApi.getState();
      setLimitlessState(newState);
    } catch (err) {
      setLimitlessState((prev) => ({
        ...prev,
        status: 'error',
        error: err instanceof Error ? err.message : 'Connection failed',
      }));
    }
  }, []);

  const handleLimitlessDisconnect = useCallback(async () => {
    try {
      const result = await window.physicalRecordingApi.disconnect();
      if (!result.success) {
        console.error('Failed to disconnect Limitless:', result.error);
        setLimitlessState((prev) => ({ ...prev, status: 'error', error: result.error }));
        return;
      }
      const newState = await window.physicalRecordingApi.getState();
      setLimitlessState(newState);
    } catch (err) {
      console.error('Failed to disconnect Limitless:', err);
      setLimitlessState((prev) => ({
        ...prev,
        status: 'error',
        error: err instanceof Error ? err.message : 'Disconnect failed',
      }));
    }
  }, []);

  const handleStartRecording = useCallback(async () => {
    try {
      const result = await window.physicalRecordingApi.startRecording();
      if (!result.success) {
        console.error('Failed to start recording:', result.error);
        return;
      }
      const newState = await window.physicalRecordingApi.getState();
      setLimitlessState(newState);
    } catch (err) {
      console.error('Failed to start recording:', err);
    }
  }, []);

  const handleStopRecording = useCallback(async () => {
    try {
      const result = await window.physicalRecordingApi.stopRecording({});
      if (!result.success) {
        console.error('Failed to stop recording:', result.error);
      }
      const newState = await window.physicalRecordingApi.getState();
      setLimitlessState(newState);
    } catch (err) {
      console.error('Failed to stop recording:', err);
    }
  }, []);

  // Plaud handlers
  const handlePlaudConnect = useCallback(async () => {
    setIsPlaudConnecting(true);
    setPlaudConnectError(null);
    try {
      const result = await window.plaudApi.startAuth();
      if (result.success) {
        const newState = await window.plaudApi.getConnectionState();
        setPlaudState(newState);
        updateMeetingBot({
          plaud: {
            enabled: true,
            userEmail: result.email,
            autoSyncIntervalMinutes: 15,
          },
        });
      } else if (!setupGuidanceDialog.handleResult(result)) {
        // Plaud is selfServe=false: when guidance is present the dialog explains the limited-access
        // (waitlist/beta) state; otherwise fall back to the inline error.
        setPlaudConnectError(result.error || 'Connection failed');
      }
    } catch (err) {
      setPlaudConnectError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setIsPlaudConnecting(false);
    }
  }, [updateMeetingBot, setupGuidanceDialog]);

  const handlePlaudDisconnect = useCallback(async () => {
    try {
      await window.plaudApi.disconnect();
      setPlaudState({
        connected: false,
        lastSyncTime: null,
        syncInProgress: false,
      });
      updateMeetingBot({
        plaud: undefined,
      });
    } catch (err) {
      console.error('Failed to disconnect Plaud:', err);
    }
  }, [updateMeetingBot]);

  const handlePlaudSync = useCallback(async () => {
    setPlaudState((prev) => ({ ...prev, syncInProgress: true }));
    try {
      const result = await window.plaudApi.triggerSync();
      if (result.success) {
        const newState = await window.plaudApi.getConnectionState();
        setPlaudState(newState);
      }
    } catch (err) {
      console.error('Failed to sync Plaud recordings:', err);
    } finally {
      setPlaudState((prev) => ({ ...prev, syncInProgress: false }));
    }
  }, []);

  // Utility functions
  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatLastSync = (isoTime: string | null): string => {
    if (!isoTime) return 'Never';
    const date = new Date(isoTime);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;

    return date.toLocaleDateString();
  };

  const getBatteryIcon = (level?: number) => {
    if (level === undefined) return <Battery size={16} />;
    if (level < 20) return <BatteryLow size={16} className={styles.batteryLow} />;
    if (level < 50) return <BatteryMedium size={16} />;
    return <BatteryFull size={16} />;
  };

  const getLimitlessStatusIcon = () => {
    switch (limitlessState.status) {
      case 'scanning':
        return <BluetoothSearching size={20} className={styles.scanning} />;
      case 'connecting':
        return <Loader2 size={20} className={styles.spinning} />;
      case 'connected':
        return <BluetoothConnected size={20} className={styles.connected} />;
      default:
        return <Bluetooth size={20} />;
    }
  };

  const getPlaudStatusIcon = () => {
    if (plaudState.syncInProgress) {
      return <Loader2 size={20} className={styles.spinning} />;
    }
    if (plaudState.connected) {
      return <Cloud size={20} className={styles.connected} />;
    }
    return <CloudOff size={20} />;
  };

  return (
    <section className={styles.cluster} data-section="voice-recorders">
      <div className={styles.clusterHeader}>
        <h2 className={styles.clusterTitle}>Voice Recorders</h2>
        <p className={styles.clusterDescription}>
          Import recordings from physical devices
        </p>
      </div>

      {/* Limitless Pendant Card */}
      <div className={styles.deviceCard}>
        <div className={styles.deviceCardHeader}>
          {getLimitlessStatusIcon()}
          <div className={styles.deviceCardInfo}>
            <span className={styles.deviceCardLabel}>Limitless Pendant</span>
            {limitlessState.status === 'connected' && limitlessState.device ? (
              <>
                <span className={styles.deviceName}>{limitlessState.device.name}</span>
                <span className={styles.deviceStatus}>
                  {getBatteryIcon(limitlessState.batteryLevel)}
                  {limitlessState.batteryLevel !== undefined
                    ? `${limitlessState.batteryLevel}%`
                    : 'Connected'}
                </span>
              </>
            ) : limitlessState.status === 'scanning' ? (
              <span className={styles.deviceStatus}>Scanning for devices...</span>
            ) : limitlessState.status === 'connecting' ? (
              <span className={styles.deviceStatus}>Connecting...</span>
            ) : limitlessState.status === 'error' ? (
              <span className={styles.deviceError}>{limitlessState.error}</span>
            ) : (
              <span className={styles.deviceStatus}>Not connected</span>
            )}
          </div>

          <div className={styles.deviceCardActions}>
            {limitlessState.status === 'connected' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLimitlessDisconnect}
                title="Disconnect"
              >
                <Unplug size={16} />
              </Button>
            ) : limitlessState.status === 'disconnected' || limitlessState.status === 'error' ? (
              <Button variant="ghost" size="sm" onClick={handleLimitlessScan} disabled={isScanning}>
                {isScanning ? (
                  <Loader2 size={16} className={styles.spinning} />
                ) : (
                  <RefreshCw size={16} />
                )}
                Scan
              </Button>
            ) : null}
          </div>
        </div>

        {/* Discovered devices list */}
        {discoveredDevices.length > 0 && limitlessState.status !== 'connected' && (
          <div className={styles.deviceList}>
            {discoveredDevices.map((device) => (
              <button
                key={device.id}
                type="button"
                className={styles.deviceListItem}
                onClick={() => handleLimitlessConnect(device.id)}
              >
                <Bluetooth size={16} />
                <span className={styles.deviceListName}>{device.name}</span>
                <span className={styles.deviceListRssi}>
                  {device.rssi > -50 ? 'Excellent' : device.rssi > -70 ? 'Good' : 'Weak'}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Recording controls */}
        {limitlessState.status === 'connected' && (
          <div className={styles.recordingControls}>
            {limitlessState.isRecording ? (
              <>
                <div className={styles.recordingIndicator}>
                  <Circle size={12} className={styles.recordingDot} fill="currentColor" />
                  <span>Recording {formatDuration(recordingDuration)}</span>
                </div>
                <Button variant="destructive" size="sm" onClick={handleStopRecording}>
                  <Square size={14} fill="currentColor" />
                  Stop
                </Button>
              </>
            ) : (
              <Button variant="default" size="sm" onClick={handleStartRecording}>
                <Mic size={14} />
                Start Recording
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Plaud Device Card */}
      <div className={styles.deviceCard}>
        <div className={styles.deviceCardHeader}>
          {getPlaudStatusIcon()}
          <div className={styles.deviceCardInfo}>
            <span className={styles.deviceCardLabel}>Plaud</span>
            {plaudState.connected && plaudState.account ? (
              <>
                <span className={styles.deviceName}>{plaudState.account.email}</span>
                <span className={styles.deviceStatus}>
                  <CheckCircle size={14} className={styles.connected} />
                  Connected
                  {plaudState.lastSyncTime && ` | Last sync: ${formatLastSync(plaudState.lastSyncTime)}`}
                </span>
              </>
            ) : isPlaudConnecting ? (
              <span className={styles.deviceStatus}>Connecting to Plaud...</span>
            ) : plaudConnectError ? (
              <>
                <span className={styles.deviceStatus}>Connection Failed</span>
                <span className={styles.deviceError}>
                  <AlertCircle size={14} />
                  {plaudConnectError}
                </span>
              </>
            ) : (
              <span className={styles.deviceStatus}>Not connected</span>
            )}
          </div>

          <div className={styles.deviceCardActions}>
            {plaudState.connected ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handlePlaudSync}
                  disabled={plaudState.syncInProgress || !canTranscribe}
                  title={canTranscribe ? 'Sync recordings' : (transcriptionBlockedReason || 'Transcription not available')}
                >
                  {plaudState.syncInProgress ? (
                    <Loader2 size={16} className={styles.spinning} />
                  ) : (
                    <RefreshCw size={16} />
                  )}
                  Sync
                </Button>
                <Button variant="ghost" size="sm" onClick={handlePlaudDisconnect} title="Disconnect">
                  <Unplug size={16} />
                </Button>
              </>
            ) : (
              <Button
                variant="default"
                size="sm"
                onClick={handlePlaudConnect}
                disabled={isPlaudConnecting}
              >
                {isPlaudConnecting ? (
                  <Loader2 size={16} className={styles.spinning} />
                ) : (
                  <Cloud size={16} />
                )}
                Connect
              </Button>
            )}
          </div>
        </div>

        {/* Warning when connected but transcription not available */}
        {plaudState.connected && !canTranscribe && transcriptionBlockedReason && (
          <div className={styles.deviceCardWarning}>
            <AlertCircle size={16} />
            <span>{transcriptionBlockedReason}</span>
          </div>
        )}
      </div>

      {/* Shared transcript routing */}
      <div className={styles.transcriptSentence}>
        <p className={styles.transcriptSentenceText}>
          Voice recordings are saved to{' '}
          <select
            value={meetingBot.physicalMeetingSpaceId ?? ''}
            onChange={(e) =>
              updateMeetingBot({ physicalMeetingSpaceId: e.target.value || undefined })
            }
            className={styles.transcriptInlineSelect}
            disabled={spaces.length === 0}
            aria-label="Space for voice recording transcripts"
          >
            <option value="">{defaultOneOnOneName}</option>
            {spaces
              .filter((s) => s.name !== defaultOneOnOneName)
              .map((space) => (
                <option key={space.path} value={space.path}>
                  {space.name}
                </option>
              ))}
          </select>
        </p>
      </div>

      <ConnectorSetupDialog
        guidance={setupGuidanceDialog.guidance}
        open={setupGuidanceDialog.isOpen}
        onOpenChange={setupGuidanceDialog.setOpen}
      />
    </section>
  );
};
