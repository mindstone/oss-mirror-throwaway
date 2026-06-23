import { useCallback } from 'react';
import {
  Pressable as RNPressable,
  type PressableProps as RNPressableProps,
  type ViewStyle,
  type StyleProp,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  useReducedMotion,
} from 'react-native-reanimated';
import { hapticLight } from '../utils/haptics';

const AnimatedPressable = Animated.createAnimatedComponent(RNPressable);

const SCALE_DOWN = 0.97;
const SPRING_CONFIG = { damping: 15, stiffness: 400, mass: 0.3 };

export type PressableProps = Omit<RNPressableProps, 'style'> & {
  /** Style applied to the animated pressable wrapper. */
  style?: StyleProp<ViewStyle>;
  /** Whether haptic feedback fires on press. Defaults to true. */
  haptic?: boolean;
};

/**
 * Animated pressable with spring scale-down feedback and optional haptic.
 * Replaces TouchableOpacity with a more tactile interaction pattern.
 *
 * - Uses Reanimated `withSpring` for a fast scale-down to 0.97 on press.
 * - Fires `hapticLight()` on press-in (configurable via `haptic` prop).
 * - Respects `useReducedMotion()` — scales instantly without spring if preferred.
 * - Based on RN's built-in `Pressable`, not `TouchableOpacity`.
 */
export function Pressable({
  onPress,
  onPressIn,
  onPressOut,
  haptic = true,
  style,
  disabled,
  ...rest
}: PressableProps) {
  const scale = useSharedValue(1);
  const reducedMotion = useReducedMotion();

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = useCallback(
    (e: Parameters<NonNullable<RNPressableProps['onPressIn']>>[0]) => {
      scale.value = reducedMotion
        ? SCALE_DOWN
        : withSpring(SCALE_DOWN, SPRING_CONFIG);
      onPressIn?.(e);
    },
    [onPressIn, scale, reducedMotion],
  );

  const handlePressOut = useCallback(
    (e: Parameters<NonNullable<RNPressableProps['onPressOut']>>[0]) => {
      scale.value = reducedMotion
        ? 1
        : withSpring(1, SPRING_CONFIG);
      onPressOut?.(e);
    },
    [onPressOut, scale, reducedMotion],
  );

  const handlePress = useCallback(
    (e: Parameters<NonNullable<RNPressableProps['onPress']>>[0]) => {
      if (haptic) hapticLight();
      onPress?.(e);
    },
    [haptic, onPress],
  );

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[animatedStyle, style]}
      disabled={disabled}
      {...rest}
    />
  );
}
