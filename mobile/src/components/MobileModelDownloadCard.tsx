/**
 * Model download card for the mobile Settings screen.
 *
 * Displays Moonshine model status (not-downloaded, downloading, downloaded, error)
 * with download/cancel/remove actions and progress feedback.
 *
 * Matches the visual style of existing cards in the Help screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Switch,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { useMobileModelDownload } from '../hooks/useMobileModelDownload';
import { hapticLight, hapticSuccess } from '../utils/haptics';
import { getMobileVoiceProvider, setMobileVoiceProvider } from '../storage/mobileVoiceSettings';
import { resetCrashState } from '../utils/localSttCrashGuard';

const typography = createTypography(true);

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 16,
      marginBottom: 16,
      gap: 12,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: colors.shadowColor,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: colors.shadowOpacity,
      shadowRadius: 3,
      elevation: 2,
    },
    cardLabel: {
      ...typography.overline,
      fontSize: 13,
      fontWeight: '700',
      color: colors.textTertiary,
      letterSpacing: 1.5,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    modelInfo: {
      flex: 1,
    },
    modelName: {
      ...typography.body,
      fontSize: 16,
      fontWeight: '600',
      color: colors.textPrimary,
    },
    modelSize: {
      ...typography.bodySmall,
      fontSize: 13,
      color: colors.textSecondary,
      marginTop: 2,
    },
    downloadButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 16,
    },
    downloadButtonText: {
      ...typography.body,
      fontWeight: '600',
      color: '#fff',
      fontSize: 14,
    },
    cancelButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 16,
      borderWidth: 1,
      borderColor: colors.border,
    },
    cancelButtonText: {
      ...typography.body,
      fontWeight: '600',
      color: colors.textSecondary,
      fontSize: 14,
    },
    removeButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 16,
      borderWidth: 1,
      borderColor: colors.error,
    },
    removeButtonText: {
      ...typography.body,
      fontWeight: '600',
      color: colors.error,
      fontSize: 14,
    },
    progressContainer: {
      gap: 6,
    },
    progressBarOuter: {
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.border,
      overflow: 'hidden',
    },
    progressBarInner: {
      height: '100%',
      borderRadius: 3,
      backgroundColor: colors.accent,
    },
    progressText: {
      ...typography.caption,
      fontSize: 12,
      color: colors.textTertiary,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: '#22c55e',
    },
    statusText: {
      ...typography.body,
      fontSize: 14,
      color: colors.textPrimary,
    },
    errorText: {
      ...typography.bodySmall,
      fontSize: 13,
      color: colors.error,
    },
    cellularWarning: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.warningLight,
      borderRadius: 8,
      padding: 10,
    },
    cellularWarningText: {
      ...typography.bodySmall,
      fontSize: 12,
      color: colors.warning,
      flex: 1,
    },
    retryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 16,
    },
    retryButtonText: {
      ...typography.body,
      fontWeight: '600',
      color: '#fff',
      fontSize: 14,
    },
    buttonRow: {
      flexDirection: 'row',
      gap: 8,
    },
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 4,
    },
    toggleLabel: {
      ...typography.body,
      fontSize: 14,
      color: colors.textPrimary,
      flex: 1,
    },
    toggleDescription: {
      ...typography.bodySmall,
      fontSize: 12,
      color: colors.textTertiary,
      marginTop: 4,
    },
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MobileModelDownloadCard() {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  const {
    status,
    progress,
    downloadedBytes,
    totalBytes,
    isCellular,
    errorMessage,
    startDownload,
    cancelDownload,
    removeModel,
    totalSizeDisplay,
    modelName,
  } = useMobileModelDownload();

  // Local voice provider toggle state
  const [localEnabled, setLocalEnabled] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const provider = await getMobileVoiceProvider();
        setLocalEnabled(provider === 'local-moonshine');
      } catch {
        setLocalEnabled(false);
      }
    })();
  }, []);

  const handleToggleLocal = useCallback(async (value: boolean) => {
    hapticLight();
    setLocalEnabled(value);
    await setMobileVoiceProvider(value ? 'local-moonshine' : 'cloud');
    if (value) {
      // Re-enable: clear any crash state from previous issues
      await resetCrashState();
    }
  }, []);

  // Fire success haptic and auto-enable when download completes
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (prevStatusRef.current === 'downloading' && (status === 'downloaded' || status === 'update-available')) {
      hapticSuccess();
      // Auto-enable local transcription after successful download
      void handleToggleLocal(true);
    }
    if ((prevStatusRef.current === 'downloaded' || prevStatusRef.current === 'update-available') && status === 'not-downloaded') {
      // Model was removed — disable local transcription
      void handleToggleLocal(false);
    }
    prevStatusRef.current = status;
  }, [status, handleToggleLocal]);

  const handleDownload = useCallback(() => {
    hapticLight();
    void startDownload();
  }, [startDownload]);

  const handleCancel = useCallback(() => {
    hapticLight();
    cancelDownload();
  }, [cancelDownload]);

  const handleRemove = useCallback(() => {
    Alert.alert(
      'Remove Model',
      `This will delete the ${modelName} model (${totalSizeDisplay}) from your device. You can download it again anytime.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            hapticLight();
            await removeModel();
          },
        },
      ],
    );
  }, [modelName, totalSizeDisplay, removeModel]);

  const handleRetry = useCallback(async () => {
    hapticLight();
    await startDownload();
  }, [startDownload]);

  const progressPercent = Math.round(progress * 100);

  return (
    <View style={s.card}>
      <Text style={s.cardLabel}>Voice Model</Text>

      {/* Not downloaded state */}
      {status === 'not-downloaded' && (
        <>
          <View style={s.row}>
            <View style={s.modelInfo}>
              <Text style={s.modelName}>{modelName}</Text>
              <Text style={s.modelSize}>{totalSizeDisplay}</Text>
            </View>
          </View>

          {isCellular && (
            <View style={s.cellularWarning}>
              <Feather name="alert-triangle" size={14} color={colors.warning} />
              <Text style={s.cellularWarningText}>
                You're on mobile data. Downloading will use {totalSizeDisplay}.
              </Text>
            </View>
          )}

          <TouchableOpacity
            testID="model-download-button"
            style={s.downloadButton}
            onPress={handleDownload}
            activeOpacity={0.7}
          >
            <Feather name="download" size={16} color="#fff" />
            <Text style={s.downloadButtonText}>Download</Text>
          </TouchableOpacity>
        </>
      )}

      {/* Downloading state */}
      {status === 'downloading' && (
        <>
          <View style={s.row}>
            <View style={s.modelInfo}>
              <Text style={s.modelName}>{modelName}</Text>
              <Text style={s.modelSize}>
                {formatBytes(downloadedBytes)} of {totalSizeDisplay}
              </Text>
            </View>
          </View>

          <View style={s.progressContainer}>
            <View style={s.progressBarOuter}>
              <View style={[s.progressBarInner, { width: `${progressPercent}%` }]} />
            </View>
            <Text style={s.progressText}>{progressPercent}%</Text>
          </View>

          <TouchableOpacity
            testID="model-cancel-button"
            style={s.cancelButton}
            onPress={handleCancel}
            activeOpacity={0.7}
          >
            <Feather name="x" size={16} color={colors.textSecondary} />
            <Text style={s.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
        </>
      )}

      {/* Downloaded / update-available states */}
      {(status === 'downloaded' || status === 'update-available') && (
        <>
          <View style={s.row}>
            <View style={s.modelInfo}>
              <View style={s.statusRow}>
                <View style={[s.statusDot, status === 'update-available' && { backgroundColor: colors.warning }]} />
                <Text style={s.statusText}>{modelName}</Text>
              </View>
              <Text style={s.modelSize}>
                {status === 'update-available' ? 'Update available' : `Downloaded • ${totalSizeDisplay}`}
              </Text>
            </View>
          </View>

          {status === 'update-available' && (
            <TouchableOpacity
              testID="model-update-button"
              style={s.downloadButton}
              onPress={handleDownload}
              activeOpacity={0.7}
            >
              <Feather name="download" size={16} color="#fff" />
              <Text style={s.downloadButtonText}>Update Model</Text>
            </TouchableOpacity>
          )}

          <View style={s.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.toggleLabel}>Use on-device transcription</Text>
              <Text style={s.toggleDescription}>
                {localEnabled ? 'Voice works offline — no data sent to cloud' : 'Using cloud transcription'}
              </Text>
            </View>
            <Switch
              testID="local-stt-toggle"
              value={localEnabled}
              onValueChange={handleToggleLocal}
              trackColor={{ false: colors.border, true: colors.accent }}
            />
          </View>

          <TouchableOpacity
            testID="model-remove-button"
            style={s.removeButton}
            onPress={handleRemove}
            activeOpacity={0.7}
          >
            <Feather name="trash-2" size={14} color={colors.error} />
            <Text style={s.removeButtonText}>Remove</Text>
          </TouchableOpacity>
        </>
      )}

      {/* Error state */}
      {status === 'error' && (
        <>
          <View style={s.row}>
            <View style={s.modelInfo}>
              <Text style={s.modelName}>{modelName}</Text>
              <Text style={s.modelSize}>{totalSizeDisplay}</Text>
            </View>
          </View>

          {errorMessage && (
            <Text testID="model-download-error" style={s.errorText}>{errorMessage}</Text>
          )}

          <TouchableOpacity
            testID="model-retry-button"
            style={s.retryButton}
            onPress={handleRetry}
            activeOpacity={0.7}
          >
            <Feather name="refresh-cw" size={16} color="#fff" />
            <Text style={s.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}
