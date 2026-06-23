// mobile/src/components/ActiveRecordingBanner.tsx
// Persistent green banner above the tab bar when a meeting recording is active.
// Inspired by the iOS green phone-call bar — shows elapsed time and a pulsing
// recording dot. Tapping navigates back to the recording screen.

import { useEffect, useMemo, useCallback, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  cancelAnimation,
  runOnJS,
} from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';
import { useColors, type ColorTokens } from '../theme/colors';
import { Pressable } from './Pressable';

const BANNER_HEIGHT = 36;
const DOT_SIZE = 8;

/**
 * Format elapsed time since `startTime` as "m:ss", "mm:ss", or "h:mm:ss".
 *
 * Examples: "0:05", "1:23", "12:05", "1:02:30"
 */
function formatElapsedTime(startTime: number | null): string {
  if (!startTime) return '0:00';
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function ActiveRecordingBanner() {
  const isActive = useActiveRecordingStore((s) => s.isActive);
  const startTime = useActiveRecordingStore((s) => s.startTime);
  const colors = useColors();
  const router = useRouter();
  const s = useMemo(() => createStyles(colors), [colors]);

  // Whether the banner occupies layout space (set immediately on enter, delayed on exit)
  const [mounted, setMounted] = useState(false);
  const [elapsed, setElapsed] = useState('0:00');

  // Animation shared values
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(-BANNER_HEIGHT);
  const dotOpacity = useSharedValue(1);

  // --- Mount/unmount with animation ---
  // Height is set IMMEDIATELY for layout (onLayout fires once with final value).
  // Visual appearance animates via opacity + translateY to avoid continuous
  // onLayout fires that would jitter BottomTabBarHeightCallbackContext.
  useEffect(() => {
    if (isActive) {
      setMounted(true);
      // Reset to start values for clean entrance
      opacity.value = 0;
      translateY.value = -BANNER_HEIGHT;
      // Animate visual appearance in
      opacity.value = withTiming(1, { duration: 250 });
      translateY.value = withTiming(0, { duration: 250 });
      // Pulse the recording dot
      dotOpacity.value = withRepeat(
        withSequence(
          withTiming(0.3, { duration: 800 }),
          withTiming(1, { duration: 800 }),
        ),
        -1, // infinite
      );
    } else {
      // Animate visual appearance out, then remove from layout
      cancelAnimation(dotOpacity);
      dotOpacity.value = 1;
      opacity.value = withTiming(0, { duration: 200 });
      translateY.value = withTiming(-BANNER_HEIGHT, { duration: 200 }, (finished) => {
        if (finished) {
          runOnJS(setMounted)(false);
        }
      });
    }
    // Shared values are refs (stable); setMounted is stable.
  }, [isActive]);

  // --- Elapsed time counter ---
  useEffect(() => {
    if (!isActive || !startTime) {
      setElapsed('0:00');
      return;
    }

    setElapsed(formatElapsedTime(startTime));

    const interval = setInterval(() => {
      setElapsed(formatElapsedTime(startTime));
    }, 1000);

    return () => clearInterval(interval);
  }, [isActive, startTime]);

  // --- Animated styles ---
  const contentStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  const animatedDotStyle = useAnimatedStyle(() => ({
    opacity: dotOpacity.value,
  }));

  const companionSessionId = useActiveRecordingStore((s) => s.companionSessionId);

  const handlePress = useCallback(() => {
    if (companionSessionId) {
      router.navigate(`/conversation/${companionSessionId}`);
    } else {
      // Fallback: navigate to recording screen if no companion ID
      router.navigate('/meeting-recording');
    }
  }, [router, companionSessionId]);

  if (!mounted) return null;

  return (
    <View style={s.wrapper}>
      <Animated.View style={[s.banner, contentStyle]}>
        <Pressable
          onPress={handlePress}
          style={s.pressable}
          accessibilityRole="button"
          accessibilityLabel={`Recording in progress, ${elapsed}. Tap to return.`}
          accessibilityHint="Returns to the meeting conversation"
          testID="active-recording-banner"
        >
          <Animated.View style={[s.dot, animatedDotStyle]} />
          <Text style={s.text}>Recording • {elapsed}</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    // Outer wrapper: fixed height for layout, clips translateY animation
    wrapper: {
      height: BANNER_HEIGHT,
      overflow: 'hidden',
    },
    // Inner animated view: slides in/out via translateY
    banner: {
      height: BANNER_HEIGHT,
      backgroundColor: colors.success,
    },
    pressable: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    dot: {
      width: DOT_SIZE,
      height: DOT_SIZE,
      borderRadius: DOT_SIZE / 2,
      backgroundColor: '#ef4444', // Red recording dot — fixed color for visibility on green
    },
    text: {
      color: '#ffffff',
      fontSize: 13,
      fontWeight: '600',
    },
  });
}
