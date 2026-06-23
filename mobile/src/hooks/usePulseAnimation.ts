import { useEffect } from 'react';
import {
  useSharedValue,
  useAnimatedStyle,
  useReducedMotion,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';

/**
 * Returns a Reanimated animated style that pulses scale between 1 and 1.12
 * while `isActive` is true. Apply directly to a Reanimated `Animated.View`.
 * Respects useReducedMotion() — returns static scale when reduced motion is preferred.
 */
export function usePulseAnimation(isActive: boolean) {
  const scale = useSharedValue(1);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (isActive) {
      if (reducedMotion) {
        scale.value = 1.05;
      } else {
        scale.value = withRepeat(
          withSequence(
            withTiming(1.12, { duration: 600 }),
            withTiming(1, { duration: 600 }),
          ),
          -1,
        );
      }
    } else {
      cancelAnimation(scale);
      scale.value = reducedMotion ? 1 : withTiming(1, { duration: 150 });
    }
  }, [isActive, scale, reducedMotion]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return pulseStyle;
}
