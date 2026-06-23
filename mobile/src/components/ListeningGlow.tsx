import { type ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
  useReducedMotion,
} from 'react-native-reanimated';
import { useEffect } from 'react';
import { useColors } from '../theme/colors';

type ListeningGlowProps = {
  isActive: boolean;
  size: number;
  children: ReactNode;
  /** Visual mode — 'listening' uses accent color with fast pulse, 'speaking' uses success color with slower pulse */
  mode?: 'listening' | 'speaking';
};

/**
 * Wraps a mic button with an animated pulsing glow ring that breathes
 * while recording is active. Respects reduced motion preferences.
 */
export function ListeningGlow({ isActive, size, children, mode = 'listening' }: ListeningGlowProps) {
  const colors = useColors();
  const reducedMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const opacity = useSharedValue(0);

  const isSpeakingMode = mode === 'speaking';
  // Speaking mode: slower, smoother pulse; Listening mode: faster, more energetic
  const scalePeak = isSpeakingMode ? 1.3 : 1.4;
  const pulseDuration = isSpeakingMode ? 1200 : 1000;

  useEffect(() => {
    if (isActive) {
      if (reducedMotion) {
        scale.value = 1.15;
        opacity.value = 0.3;
      } else {
        scale.value = withRepeat(
          withSequence(
            withTiming(scalePeak, { duration: pulseDuration }),
            withTiming(1, { duration: pulseDuration }),
          ),
          -1,
        );
        opacity.value = withRepeat(
          withSequence(
            withTiming(0.5, { duration: pulseDuration }),
            withTiming(0, { duration: pulseDuration }),
          ),
          -1,
        );
      }
    } else {
      cancelAnimation(scale);
      cancelAnimation(opacity);
      scale.value = withTiming(1, { duration: 150 });
      opacity.value = withTiming(0, { duration: 150 });
    }
  }, [isActive, scale, opacity, reducedMotion, scalePeak, pulseDuration]);

  // Speaking mode uses success (green) color, listening mode uses accent (indigo)
  const ringColor = isSpeakingMode ? colors.success : colors.accent;

  const glowStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <Animated.View
        style={[
          styles.ring,
          glowStyle,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            borderColor: ringColor,
          },
        ]}
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
  },
  ring: {
    position: 'absolute',
    borderWidth: 2.5,
  },
});
