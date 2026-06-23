// mobile/src/components/ConnectivityBanner.tsx
//
// Persistent top banner showing queue/connectivity status.
// Queue states: online-live (hidden), online-draining, offline-queued,
// offline-empty, limited, auth-expired, queue-full, has-failures, reconnecting.
//
// Presentation-only — receives derived QueueStatus via props.
// The connected wrapper (ConnectivityBannerConnected) handles store wiring.

import { useEffect, useState, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  cancelAnimation,
  useReducedMotion,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import { useColors, type ColorTokens } from '../theme/colors';
import type { QueueState, QueueStatus } from '@rebel/cloud-client';
import { bannerCopy, type BannerCopyVariant } from '../utils/queueCopy';

// ---------------------------------------------------------------------------
// Style factory
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: {
      overflow: 'hidden',
    },
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingBottom: BANNER_VERTICAL_PADDING,
      paddingHorizontal: 12,
      gap: 8,
    },
    textContainer: {
      flex: 1,
    },
    title: {
      fontSize: 12,
      fontWeight: '600',
      color: '#fff',
    },
    subtitle: {
      fontSize: 11,
      fontWeight: '400',
      color: 'rgba(255, 255, 255, 0.85)',
      marginTop: 1,
    },
    cta: {
      fontSize: 12,
      fontWeight: '700',
      color: '#fff',
    },
    ctaButton: {
      marginLeft: 4,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderRadius: 999,
      backgroundColor: 'rgba(255, 255, 255, 0.16)',
    },
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BANNER_VERTICAL_PADDING = 6;
const MIN_BANNER_CONTENT_HEIGHT = 48;
const ICON_SIZE = 14;

type FeatherIconName = React.ComponentProps<typeof Feather>['name'];

/** Map QueueState → background color token key. */
function getBannerColor(state: QueueState, colors: ColorTokens): string {
  switch (state) {
    case 'has-failures':
      return colors.error;
    case 'auth-expired':
    case 'queue-full':
    case 'offline-queued':
    case 'offline-empty':
    case 'limited':
      return colors.warning;
    case 'online-draining':
    case 'reconnecting':
      return colors.accent;
    default:
      return colors.accent;
  }
}

/** Map QueueState → Feather icon name. */
function getIconName(state: QueueState): FeatherIconName {
  switch (state) {
    case 'offline-queued':
    case 'offline-empty':
      return 'wifi-off';
    case 'limited':
      return 'cloud-off';
    case 'auth-expired':
    case 'queue-full':
      return 'alert-triangle';
    case 'has-failures':
      return 'alert-circle';
    case 'reconnecting':
    case 'online-draining':
      return 'refresh-cw';
    default:
      return 'refresh-cw';
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ConnectivityBannerProps {
  status: QueueStatus;
  /** Called when user taps the auth-expired banner CTA. */
  onSignIn?: () => void;
  /** Called when user taps the has-failures banner. */
  onFailuresTap?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConnectivityBanner({ status, onSignIn, onFailuresTap }: ConnectivityBannerProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const s = useMemo(() => createStyles(colors), [colors]);
  const reducedMotion = useReducedMotion();

  const heightValue = useSharedValue(0);
  const pulseOpacity = useSharedValue(1);

  // Suppress the banner for the first 3 seconds after mount to avoid
  // a brief "Reconnecting" flash while the initial WS connection is established.
  const [isStartupComplete, setIsStartupComplete] = useState(false);
  const minimumExpandedHeight = insets.top + MIN_BANNER_CONTENT_HEIGHT;
  const [measuredExpandedHeight, setMeasuredExpandedHeight] = useState(minimumExpandedHeight);
  useEffect(() => {
    const timer = setTimeout(() => setIsStartupComplete(true), 3_000);
    return () => clearTimeout(timer);
  }, []);

  const isVisible = isStartupComplete && status.shouldShowBanner;
  const expandedHeight = Math.max(minimumExpandedHeight, measuredExpandedHeight);

  const handleBannerLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.ceil(event.nativeEvent.layout.height);
    if (nextHeight > 0) {
      setMeasuredExpandedHeight(nextHeight);
    }
  }, []);

  // Animate banner height in/out
  useEffect(() => {
    heightValue.value = withTiming(isVisible ? expandedHeight : 0, { duration: 250 });
  }, [isVisible, expandedHeight, heightValue]);

  // Pulse the icon for reconnecting/draining states
  const shouldPulse =
    status.state === 'reconnecting' || status.state === 'online-draining';
  useEffect(() => {
    if (shouldPulse && !reducedMotion) {
      pulseOpacity.value = withRepeat(
        withSequence(
          withTiming(0.3, { duration: 600 }),
          withTiming(1, { duration: 600 }),
        ),
        -1,
      );
    } else {
      cancelAnimation(pulseOpacity);
      pulseOpacity.value = withTiming(1, { duration: 150 });
    }
  }, [shouldPulse, pulseOpacity, reducedMotion]);

  const containerStyle = useAnimatedStyle(() => ({
    height: heightValue.value,
  }));

  const iconAnimStyle = useAnimatedStyle(() => ({
    opacity: pulseOpacity.value,
  }));

  // Hidden when online-live
  if (status.state === 'online-live' && !isVisible) return null;

  // Derive copy from centralized banner copy
  const { state } = status;
  const copy: BannerCopyVariant | null =
    state === 'online-live'
      ? null
      : state === 'auth-expired'
        ? bannerCopy['auth-expired'](status.totalPending)
        : bannerCopy[state];
  if (!copy) return null;

  const title = copy.title;
  // has-failures subtitle uses totalFailed; all others use totalPending
  const subtitleCount = state === 'has-failures' ? status.totalFailed : status.totalPending;
  const subtitle =
    'subtitle' in copy && copy.subtitle !== null
      ? typeof copy.subtitle === 'function'
        ? copy.subtitle(subtitleCount)
        : copy.subtitle
      : null;
  const ctaText = 'cta' in copy ? copy.cta : null;

  const backgroundColor = getBannerColor(state, colors);
  const iconName = getIconName(state);

  const accessibilityLabel = subtitle
    ? `${title}. ${subtitle}`
    : title;

  const isFailureBanner = state === 'has-failures' && Boolean(onFailuresTap);
  const hasInlineCta = state === 'auth-expired' && Boolean(ctaText) && Boolean(onSignIn);

  const bannerContent = (
    <View
      style={[
        s.banner,
        {
          backgroundColor,
          minHeight: minimumExpandedHeight,
          paddingTop: insets.top + BANNER_VERTICAL_PADDING,
        },
      ]}
      onLayout={handleBannerLayout}
      testID="connectivity-banner-content"
      accessible={!isFailureBanner && !hasInlineCta}
      accessibilityRole={!isFailureBanner && !hasInlineCta ? 'alert' : undefined}
      accessibilityLabel={!isFailureBanner && !hasInlineCta ? accessibilityLabel : undefined}
    >
      <Animated.View style={iconAnimStyle}>
        <Feather name={iconName} size={ICON_SIZE} color="#fff" />
      </Animated.View>
      <View style={s.textContainer}>
        <Text style={s.title}>{title}</Text>
        {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
      </View>
      {hasInlineCta ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={ctaText ?? undefined}
          activeOpacity={0.8}
          onPress={onSignIn}
          style={s.ctaButton}
        >
          <Text style={s.cta}>{ctaText}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );

  return (
    <Animated.View style={[s.container, containerStyle]}>
      {isFailureBanner ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          activeOpacity={0.85}
          onPress={onFailuresTap}
        >
          {bannerContent}
        </TouchableOpacity>
      ) : (
        bannerContent
      )}
    </Animated.View>
  );
}
