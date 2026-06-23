import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, LayoutChangeEvent, StyleSheet, Text } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Feather } from '@expo/vector-icons';

import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';
import { Pressable } from './Pressable';

const typography = createTypography(true);
const MIN_TOUCH_TARGET = 44;
const LABEL_COLLAPSE_WIDTH = 96;

export interface AskSparkButtonProps {
  onPress: () => void;
  disabled?: boolean;
  submitting?: boolean;
  pulsing?: boolean;
  reducedMotionOverride?: boolean;
  testID?: string;
}

export function AskSparkButton({
  onPress,
  disabled = false,
  submitting = false,
  pulsing = false,
  reducedMotionOverride,
  testID = 'ask-spark-button',
}: AskSparkButtonProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const reduceMotion = useReducedMotion();
  const shouldReduceMotion = reducedMotionOverride ?? reduceMotion;
  const pulseOpacity = useSharedValue(0);
  const [hideLabel, setHideLabel] = useState(false);

  useEffect(() => {
    if (pulsing && !shouldReduceMotion) {
      pulseOpacity.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 750 }),
          withTiming(0.25, { duration: 750 }),
        ),
        2,
        true,
      );
      return () => cancelAnimation(pulseOpacity);
    }

    cancelAnimation(pulseOpacity);
    pulseOpacity.value = pulsing ? 1 : 0;
    return undefined;
  }, [pulsing, pulseOpacity, shouldReduceMotion]);

  const animatedPulseStyle = useAnimatedStyle(() => ({
    opacity: pulseOpacity.value,
  }));

  const handleLayout = (event: LayoutChangeEvent) => {
    setHideLabel(event.nativeEvent.layout.width < LABEL_COLLAPSE_WIDTH);
  };

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      haptic={!disabled}
      onLayout={handleLayout}
      style={[s.button, disabled && s.buttonDisabled]}
      accessibilityRole="button"
      accessibilityLabel="Ask Spark during this meeting"
      accessibilityHint="Opens meeting questions you can send to Spark."
      accessibilityState={disabled ? { disabled: true } : undefined}
      testID={testID}
    >
      <Animated.View
        pointerEvents="none"
        style={[s.pulseRing, pulsing && shouldReduceMotion ? s.pulseRingReducedMotion : null, animatedPulseStyle]}
        testID={`${testID}-pulse-ring`}
      />
      {submitting ? (
        <ActivityIndicator size="small" color={colors.accent} testID={`${testID}-submitting`} />
      ) : (
        <Feather name="message-circle" size={16} color={disabled ? colors.textTertiary : colors.accent} />
      )}
      {!hideLabel ? (
        <Text style={[s.label, disabled && s.labelDisabled]} numberOfLines={1}>
          Ask Spark
        </Text>
      ) : null}
    </Pressable>
  );
}

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    button: {
      minHeight: MIN_TOUCH_TARGET,
      minWidth: MIN_TOUCH_TARGET,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingHorizontal: 10,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accentMuted,
      backgroundColor: colors.surface,
      overflow: 'hidden',
    },
    buttonDisabled: {
      opacity: 0.55,
    },
    pulseRing: {
      ...StyleSheet.absoluteFillObject,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.accent,
      backgroundColor: colors.accentLight,
    },
    pulseRingReducedMotion: {
      opacity: 1,
    },
    label: {
      ...typography.caption,
      fontSize: 12,
      fontWeight: '700',
      color: colors.accent,
    },
    labelDisabled: {
      color: colors.textTertiary,
    },
  });
}
