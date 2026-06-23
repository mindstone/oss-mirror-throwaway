// mobile/src/components/MeetingRecordingBanner.tsx
// Compact banner for the conversation screen during an active meeting recording.
// Shows recording status, elapsed time, meeting title, transcript status, and stop button.
//
// Performance: elapsed time updates via useState + setInterval inside React.memo.
// The parent conversation screen should NOT re-render from this — the banner is
// a self-contained leaf component. The pulsing recording dot uses Reanimated
// shared values to avoid JS-thread overhead.

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useColors, type ColorTokens } from '../theme/colors';
import { Pressable } from './Pressable';
import { AskSparkButton } from './AskSparkButton';
import { useMeetingFirstUseOnboarding } from '../hooks/useMeetingFirstUseOnboarding';
import type { TriggerDroppedReason } from '@rebel/cloud-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TranscriptStatus = 'listening' | 'live' | 'uploading' | 'offline';

export interface MeetingRecordingBannerProps {
  title: string;
  startTime: number; // Unix ms
  isRecording: boolean;
  transcriptStatus: TranscriptStatus;
  onStop: () => void;
  onAskSparkPress?: () => void;
  askSparkDisabled?: boolean;
  askSparkSubmitting?: boolean;
  askSparkPulsing?: boolean;
  askSparkReducedMotion?: boolean;
  rateLimited?: boolean;
  awaitingTurn?: boolean;
  lastDropReason?: TriggerDroppedReason | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAIN_ROW_HEIGHT = 52;
const STATUS_ROW_HEIGHT = 20;
const DOT_SIZE = 8;
const STOP_BUTTON_SIZE = 28;

/**
 * Format elapsed time since `startTime` as "mm:ss" or "h:mm:ss".
 */
function formatElapsed(startTime: number): string {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

const TRANSCRIPT_STATUS_LABELS: Record<TranscriptStatus, string> = {
  listening: 'Listening…',
  live: 'Live transcript',
  uploading: 'Uploading…',
  offline: 'Offline',
};

function getTriggerDropCopy(reason: TriggerDroppedReason | null | undefined): string | null {
  switch (reason) {
    case 'action-timeout':
    case 'service-restart':
    case 'action-failed':
    case 'missing-companion-id':
      return 'Your last question didn\'t go through. Please ask again.';
    case 'session-ended':
      return 'Recording\'s stopped, so Spark isn\'t listening right now.';
    case 'rate-limited':
    case 'coalesced':
    case null:
    case undefined:
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function MeetingRecordingBannerInner({
  title,
  startTime,
  isRecording,
  transcriptStatus,
  onStop,
  onAskSparkPress,
  askSparkDisabled = false,
  askSparkSubmitting = false,
  askSparkPulsing = false,
  askSparkReducedMotion,
  rateLimited = false,
  awaitingTurn = false,
  lastDropReason = null,
}: MeetingRecordingBannerProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const firstUse = useMeetingFirstUseOnboarding();

  // --- Elapsed time (1s interval, self-contained) ---
  const [elapsed, setElapsed] = useState(() => formatElapsed(startTime));

  useEffect(() => {
    if (!isRecording) return;

    setElapsed(formatElapsed(startTime));
    const interval = setInterval(() => {
      setElapsed(formatElapsed(startTime));
    }, 1000);

    return () => clearInterval(interval);
  }, [isRecording, startTime]);

  // --- Pulsing recording dot (Reanimated) ---
  const dotOpacity = useSharedValue(1);

  useEffect(() => {
    if (isRecording) {
      dotOpacity.value = withRepeat(
        withSequence(
          withTiming(0.3, { duration: 800 }),
          withTiming(1, { duration: 800 }),
        ),
        -1,
      );
    } else {
      cancelAnimation(dotOpacity);
      dotOpacity.value = 1;
    }
  }, [isRecording]);

  const animatedDotStyle = useAnimatedStyle(() => ({
    opacity: dotOpacity.value,
  }));

  const handleStop = useCallback(() => {
    onStop();
  }, [onStop]);

  const dropCopy = getTriggerDropCopy(lastDropReason);
  const statusLabel = useMemo(() => {
    if (askSparkPulsing) return 'Spark heard you';
    if (!isRecording) return 'Recording\'s stopped, so Spark isn\'t listening right now.';
    if (transcriptStatus === 'offline') return 'Offline - voice trigger paused. Ask Spark still saves questions.';
    if (rateLimited || lastDropReason === 'rate-limited') return 'Voice trigger is paused for this meeting. Ask Spark still works.';
    if (dropCopy) return dropCopy;
    if (awaitingTurn) return 'Still drafting...';
    return TRANSCRIPT_STATUS_LABELS[transcriptStatus];
  }, [askSparkPulsing, awaitingTurn, dropCopy, isRecording, lastDropReason, rateLimited, transcriptStatus]);

  return (
    <View style={s.container}>
      {/* Main row: dot + time + title ... stop button */}
      <View style={s.mainRow}>
        <Animated.View style={[s.dot, animatedDotStyle]} />
        <Text style={s.elapsed}>{elapsed}</Text>
        <Text style={s.title} numberOfLines={1} ellipsizeMode="tail">
          {title}
        </Text>
        <AskSparkButton
          onPress={onAskSparkPress ?? (() => {})}
          disabled={askSparkDisabled || !isRecording || !onAskSparkPress}
          submitting={askSparkSubmitting}
          pulsing={askSparkPulsing}
          reducedMotionOverride={askSparkReducedMotion}
        />
        <Pressable
          onPress={handleStop}
          style={s.stopButton}
          accessibilityRole="button"
          accessibilityLabel="Stop recording"
          testID="meeting-banner-stop"
        >
          <Feather name="square" size={14} color={colors.error} />
        </Pressable>
      </View>
      {/* Status row: transcript status */}
      <View style={s.statusRow}>
        {transcriptStatus === 'offline' ? (
          <Feather name="wifi-off" size={11} color={colors.textTertiary} />
        ) : (
          <View style={[s.statusDot, s.statusDotActive]} />
        )}
        <Text style={s.statusText}>{statusLabel}</Text>
      </View>
      {firstUse.showTip && isRecording ? (
        <View style={s.firstUseRow} testID="ask-spark-first-use-tip">
          <Feather name="info" size={13} color={colors.textTertiary} />
          <Text style={s.firstUseText}>
            Try: "Hey Spark, summarise so far." Answers stay here, not in the call.
          </Text>
          <Pressable
            onPress={firstUse.dismiss}
            style={s.dismissTipButton}
            accessibilityRole="button"
            accessibilityLabel="Dismiss Ask Spark tip"
            testID="ask-spark-first-use-dismiss"
          >
            <Feather name="x" size={12} color={colors.textTertiary} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export const MeetingRecordingBanner = React.memo(MeetingRecordingBannerInner);

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  // Subtle red-tinted background that works in both themes
  const bannerBg = colors.background === '#ffffff'
    ? 'rgba(255,59,48,0.08)'   // light mode
    : 'rgba(255,69,58,0.15)';  // dark mode

  return StyleSheet.create({
    container: {
      backgroundColor: bannerBg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    mainRow: {
      height: MAIN_ROW_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      gap: 10,
    },
    dot: {
      width: DOT_SIZE,
      height: DOT_SIZE,
      borderRadius: DOT_SIZE / 2,
      backgroundColor: colors.error,
    },
    elapsed: {
      fontSize: 15,
      fontWeight: '700',
      fontVariant: ['tabular-nums'],
      color: colors.textPrimary,
      minWidth: 44,
    },
    title: {
      flex: 1,
      fontSize: 14,
      color: colors.textSecondary,
      minWidth: 0,
    },
    stopButton: {
      width: STOP_BUTTON_SIZE,
      height: STOP_BUTTON_SIZE,
      borderRadius: STOP_BUTTON_SIZE / 2,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    statusRow: {
      minHeight: STATUS_ROW_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingBottom: 4,
      gap: 6,
    },
    statusDot: {
      width: 5,
      height: 5,
      borderRadius: 2.5,
    },
    statusDotActive: {
      backgroundColor: colors.success,
    },
    statusDotOffline: {
      backgroundColor: colors.textTertiary,
    },
    statusText: {
      flex: 1,
      fontSize: 11,
      color: colors.textTertiary,
    },
    firstUseRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 16,
      paddingTop: 2,
      paddingBottom: 8,
    },
    firstUseText: {
      flex: 1,
      fontSize: 11,
      lineHeight: 15,
      color: colors.textSecondary,
    },
    dismissTipButton: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}
