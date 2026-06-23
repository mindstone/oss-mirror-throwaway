// mobile/src/components/PendingRecordingRow.tsx
//
// Per-recording row in the pending recordings section. Shows duration,
// relative timestamp, target session name, status, and action buttons.

import { memo, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';

import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { spacing, radius } from '../theme/tokens';
import { Pressable } from './Pressable';
import { usePulseAnimation } from '../hooks/usePulseAnimation';
import type { QueueItem } from '@rebel/cloud-client';

const typography = createTypography(true);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format milliseconds duration as "M:SS" */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** Format a timestamp as a short relative string (e.g., "2 min ago") */
function formatShortRelativeTime(epoch: number): string {
  const diff = Math.max(0, Date.now() - epoch);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

type RecordingStatus = 'pending' | 'processing' | 'failed-transient' | 'failed-permanent';

function getRecordingStatus(item: QueueItem): RecordingStatus {
  if (item.status === 'processing') return 'processing';
  if (item.isPermanentFailure) return 'failed-permanent';
  if (item.lastError) return 'failed-transient';
  return 'pending';
}

function getStatusLabel(item: QueueItem, status: RecordingStatus): string {
  switch (status) {
    case 'pending': return 'Waiting in line';
    case 'processing': return 'Sending…';
    case 'failed-transient': return 'Paused — will retry shortly';
    case 'failed-permanent':
      // Copy keyed to the actual errorCategory so the message is honest about
      // what happened. A retry icon is always shown for failed rows, so the
      // label states the cause; it doesn't promise success.
      switch (item.errorCategory) {
        case 'provider-auth':
          return 'Check voice settings';
        case 'auth':
          // Cloud connection / pairing expired — reconnect, then retry.
          return 'Reconnect to send';
        case 'billing':
          return 'Check voice billing';
        case 'permanent':
          // Genuine bad input (400/413/415/422) — retrying won't help.
          return "This recording couldn't be processed";
        case 'temporary':
        case 'network':
          // Retried and eventually gave up — the cause may be server-side; worth retrying.
          return "Couldn't send to the cloud — tap retry";
        case 'timeout':
          // 48h stale sweep — never got sent in time.
          return "Couldn't send this in time — tap retry";
        default:
          // Calm generic that still invites a retry.
          return "Couldn't send — tap retry";
      }
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 12,
      gap: spacing.sm + 2,
    },
    playButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    playButtonActive: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    body: {
      flex: 1,
      gap: 2,
    },
    topRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    durationBadge: {
      backgroundColor: colors.background,
      borderRadius: radius.sm,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    durationText: {
      ...typography.caption,
      fontSize: 11,
      fontWeight: '600',
      color: colors.textSecondary,
    },
    sessionName: {
      ...typography.bodySmall,
      fontSize: 13,
      fontWeight: '500',
      color: colors.textPrimary,
      flex: 1,
    },
    timeText: {
      ...typography.caption,
      fontSize: 11,
      color: colors.textTertiary,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    statusText: {
      ...typography.caption,
      fontSize: 11,
    },
    statusPending: {
      color: colors.textTertiary,
    },
    statusProcessing: {
      color: colors.accent,
    },
    statusWarning: {
      color: colors.warning,
    },
    statusError: {
      color: colors.error,
    },
    pulsingDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.accent,
    },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
    },
    actionButton: {
      width: 28,
      height: 28,
      borderRadius: 16,
      justifyContent: 'center',
      alignItems: 'center',
    },
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface PendingRecordingRowProps {
  item: QueueItem;
  sessionName: string | null;
  isPlaying: boolean;
  onTogglePlay: (id: string, payloadUri: string) => void;
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
  variant?: 'voice' | 'meeting-chunk';
  meetingSummary?: {
    meetingSessionId: string;
    meetingTitle?: string;
    uploadedChunks: number;
    totalChunks: number;
    pendingChunks: number;
    failedChunks: number;
  };
}

export const PendingRecordingRow = memo(function PendingRecordingRow({
  item,
  sessionName,
  isPlaying,
  onTogglePlay,
  onRetry,
  onDelete,
  variant = 'voice',
  meetingSummary,
}: PendingRecordingRowProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const isMeetingVariant = variant === 'meeting-chunk' && Boolean(meetingSummary);
  const voiceStatus = getRecordingStatus(item);

  const displayDuration = useMemo(() => {
    if (isMeetingVariant && meetingSummary) {
      return `${meetingSummary.uploadedChunks}/${meetingSummary.totalChunks}`;
    }
    const durationMs = (item.metadata as Record<string, unknown>).durationMs as number | undefined;
    return durationMs != null ? formatDuration(durationMs) : '0:00';
  }, [isMeetingVariant, item.metadata, meetingSummary]);

  const displayTime = formatShortRelativeTime(item.enqueuedAt);
  const displaySession = useMemo(() => {
    if (isMeetingVariant && meetingSummary) {
      return meetingSummary.meetingTitle || 'Meeting recording';
    }
    return sessionName || 'New conversation';
  }, [isMeetingVariant, meetingSummary, sessionName]);

  const statusLabel = useMemo(() => {
    if (isMeetingVariant && meetingSummary) {
      if (meetingSummary.failedChunks > 0) return 'Paused — upload hit a snag';
      if (meetingSummary.pendingChunks > 0) return `Uploading ${meetingSummary.pendingChunks} chunk${meetingSummary.pendingChunks === 1 ? '' : 's'}`;
      return 'Processing transcript…';
    }
    return getStatusLabel(item, voiceStatus);
  }, [isMeetingVariant, item, meetingSummary, voiceStatus]);

  const statusTone = useMemo<'pending' | 'processing' | 'warning' | 'error'>(() => {
    if (isMeetingVariant && meetingSummary) {
      if (meetingSummary.failedChunks > 0) return 'error';
      if (meetingSummary.pendingChunks > 0) return 'processing';
      return 'pending';
    }
    if (voiceStatus === 'processing') return 'processing';
    if (voiceStatus === 'failed-transient') return 'warning';
    if (voiceStatus === 'failed-permanent') return 'error';
    return 'pending';
  }, [isMeetingVariant, meetingSummary, voiceStatus]);

  const pulseStyle = usePulseAnimation(statusTone === 'processing');
  const isFailed = statusTone === 'warning' || statusTone === 'error';

  const handlePlay = useCallback(() => {
    if (isMeetingVariant) return;
    if (item.payloadUri) {
      onTogglePlay(item.id, item.payloadUri);
    }
  }, [isMeetingVariant, item.id, item.payloadUri, onTogglePlay]);

  const handleRetry = useCallback(() => {
    if (isMeetingVariant && meetingSummary) {
      onRetry(meetingSummary.meetingSessionId);
      return;
    }
    onRetry(item.id);
  }, [isMeetingVariant, item.id, meetingSummary, onRetry]);

  const handleDelete = useCallback(() => {
    if (isMeetingVariant && meetingSummary) {
      onDelete(meetingSummary.meetingSessionId);
      return;
    }
    onDelete(item.id);
  }, [isMeetingVariant, item.id, meetingSummary, onDelete]);

  const statusColor = useMemo(() => {
    switch (statusTone) {
      case 'pending': return s.statusPending;
      case 'processing': return s.statusProcessing;
      case 'warning': return s.statusWarning;
      case 'error': return s.statusError;
    }
  }, [statusTone, s]);

  return (
    <View testID={`pending-recording-row-${item.id}`} style={s.row}>
      {/* Play/pause button */}
      <Pressable
        testID={`pending-recording-play-${item.id}`}
        style={[s.playButton, isPlaying && s.playButtonActive]}
        onPress={handlePlay}
        accessibilityLabel={
          isMeetingVariant
            ? 'Meeting upload status'
            : isPlaying
              ? 'Pause recording'
              : 'Play recording'
        }
      >
        <Feather
          name={isMeetingVariant ? 'upload-cloud' : isPlaying ? 'pause' : 'play'}
          size={14}
          color={isPlaying && !isMeetingVariant ? '#fff' : colors.textSecondary}
        />
      </Pressable>

      {/* Body: session name, duration, time, status */}
      <View style={s.body}>
        <View style={s.topRow}>
          <View style={s.durationBadge}>
            <Text style={s.durationText}>{displayDuration}</Text>
          </View>
          <Text style={s.sessionName} numberOfLines={1}>
            {displaySession}
          </Text>
          <Text style={s.timeText}>{displayTime}</Text>
        </View>

        <View style={s.statusRow}>
          {statusTone === 'pending' && (
            <Feather name="clock" size={10} color={colors.textTertiary} />
          )}
          {statusTone === 'processing' && (
            <Animated.View style={pulseStyle}>
              <View style={s.pulsingDot} />
            </Animated.View>
          )}
          {statusTone === 'warning' && (
            <Feather name="alert-triangle" size={10} color={colors.warning} />
          )}
          {statusTone === 'error' && (
            <Feather name="alert-circle" size={10} color={colors.error} />
          )}
          <Text style={[s.statusText, statusColor]}>{statusLabel}</Text>
        </View>
      </View>

      {/* Action buttons */}
      <View style={s.actions}>
        {isFailed && (
          <Pressable
            testID={`pending-recording-retry-${item.id}`}
            style={s.actionButton}
            onPress={handleRetry}
            accessibilityLabel="Retry recording"
          >
            <Feather name="refresh-cw" size={14} color={colors.accent} />
          </Pressable>
        )}
        <Pressable
          testID={`pending-recording-delete-${item.id}`}
          style={s.actionButton}
          onPress={handleDelete}
          accessibilityLabel="Delete recording"
        >
          <Feather name="trash-2" size={14} color={colors.textTertiary} />
        </Pressable>
      </View>
    </View>
  );
});
