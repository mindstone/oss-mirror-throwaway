// mobile/src/components/QueuedMessageChip.tsx
//
// Reusable chip showing queued-message status: waiting, sending, or failed.
// Subscribes to offlineQueueStore to derive per-item state automatically.
// Used in the conversation transcript beneath queued user messages.

import { useEffect, memo, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  useReducedMotion,
  cancelAnimation,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';
import { useColors, type ColorTokens } from '../theme/colors';

export type QueuedMessageChipState = 'waiting' | 'sending' | 'failed';

interface QueuedMessageChipProps {
  state: QueuedMessageChipState;
  /** When 'failed', show this message after "Failed — " */
  errorMessage?: string;
}

export const QueuedMessageChip = memo(function QueuedMessageChip({
  state,
  errorMessage,
}: QueuedMessageChipProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (state === 'sending' && !reduceMotion) {
      // Breathing animation: 1 → 0.4 → 1 over 1.6s
      opacity.value = withRepeat(
        withSequence(
          withTiming(0.4, { duration: 800 }),
          withTiming(1, { duration: 800 }),
        ),
        -1,
      );
    } else {
      cancelAnimation(opacity);
      opacity.value = withTiming(1, { duration: 150 });
    }
    return () => cancelAnimation(opacity);
  }, [state, reduceMotion, opacity]);

  const iconStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  if (state === 'failed') {
    return (
      <View
        testID="queued-message-chip-failed"
        style={s.chip}
        accessible
        accessibilityLabel={errorMessage ? `Failed: ${errorMessage}` : 'Failed to send'}
      >
        <Feather name="alert-circle" size={11} color={colors.error} />
        <Text style={[s.text, { color: colors.error }]}>
          {errorMessage ? `Failed — ${errorMessage}` : 'Failed to send'}
        </Text>
      </View>
    );
  }

  if (state === 'sending') {
    return (
      <View
        testID="queued-message-chip-sending"
        style={s.chip}
        accessible
        accessibilityLabel="Sending"
      >
        <Animated.View style={iconStyle}>
          <Feather name="loader" size={11} color={colors.accent} />
        </Animated.View>
        <Text style={[s.text, { color: colors.accent }]}>Sending…</Text>
      </View>
    );
  }

  // 'waiting'
  return (
    <View
      testID="queued-message-chip-waiting"
      style={s.chip}
      accessible
      accessibilityLabel="Waiting to send"
    >
      <Feather name="clock" size={11} color={colors.textTertiary} />
      <Text style={s.text}>Queued</Text>
    </View>
  );
});

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginTop: 2,
      alignSelf: 'flex-end',
    },
    text: {
      fontSize: 11,
      color: colors.textTertiary,
      fontWeight: '500',
    },
  });
}

QueuedMessageChip.displayName = 'QueuedMessageChip';
