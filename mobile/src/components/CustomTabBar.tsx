// mobile/src/components/CustomTabBar.tsx

import React, { useCallback, useMemo } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Platform,
  StyleSheet,
  Text,
  useColorScheme,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import {
  BottomTabBarHeightCallbackContext,
  type BottomTabBarProps,
} from '@react-navigation/bottom-tabs';
import { useColors, type ColorTokens } from '../theme/colors';
import { shadows } from '../theme/tokens';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';
import { hapticMedium } from '../utils/haptics';
import { generateMobileSessionId } from '../utils/sessionId';
import { Pressable } from './Pressable';
import { ListeningGlow } from './ListeningGlow';
import { ActiveRecordingBanner } from './ActiveRecordingBanner';

/**
 * Custom bottom tab bar with a raised center mic button.
 *
 * Renders visible tabs (hidden routes like `approvals` are filtered by name)
 * split into two groups around a center mic button that navigates to a new
 * conversation with `autoRecord=true`. Purely navigational — no recording
 * state or voice hook.
 */
export function CustomTabBar({ state, descriptors, navigation, insets }: BottomTabBarProps) {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const router = useRouter();
  const onHeightChange = React.useContext(BottomTabBarHeightCallbackContext);

  const s = useMemo(() => createStyles(colors), [colors]);

  // Filter out tabs that shouldn't be visible (e.g. approvals).
  // Uses route name instead of checking `href` from descriptor options because
  // expo-router may strip `href` at the <Tabs.Screen> level, making it `undefined`
  // (which passes a `!== null` check). See (tabs)/_layout.tsx for route config.
  const visibleRoutes = useMemo(
    () => state.routes.filter((route) => !['approvals'].includes(route.name)),
    [state.routes],
  );

  // Split visible tabs into left and right groups around the center button
  const midpoint = Math.ceil(visibleRoutes.length / 2);
  const leftTabs = visibleRoutes.slice(0, midpoint);
  const rightTabs = visibleRoutes.slice(midpoint);

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      onHeightChange?.(e.nativeEvent.layout.height);
    },
    [onHeightChange],
  );

  const handleCenterPress = useCallback(() => {
    const sessionId = generateMobileSessionId();
    router.push(`/conversation/${sessionId}?autoRecord=true`);
  }, [router]);

  const handleTypePress = useCallback(() => {
    const sessionId = generateMobileSessionId();
    router.push(`/conversation/${sessionId}?compose=text`);
  }, [router]);

  const handleCenterLongPress = useCallback(() => {
    hapticMedium();
    const isRecordingActive = useActiveRecordingStore.getState().isActive;
    const actionLabel = isRecordingActive ? 'Return to Recording' : 'Record Meeting';

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ['Cancel', actionLabel], cancelButtonIndex: 0 },
        (buttonIndex) => {
          if (buttonIndex === 1) router.navigate('/meeting-recording');
        },
      );
    } else {
      Alert.alert('Options', undefined, [
        { text: actionLabel, onPress: () => router.navigate('/meeting-recording') },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [router]);

  const bottomPadding = Math.max(insets.bottom, 6);

  return (
    <View style={s.wrapper} onLayout={handleLayout}>
      <BlurView
        tint={colorScheme === 'light' ? 'light' : 'dark'}
        intensity={80}
        style={StyleSheet.absoluteFill}
      />

      {/* Recording banner — renders above tab content when active; height is
          included in the wrapper's onLayout measurement automatically.
          Placed after BlurView so it renders on top of the blur background. */}
      <ActiveRecordingBanner />

      <View style={[s.content, { paddingBottom: bottomPadding }]}>
        {/* Left tab group */}
        <View style={s.tabGroup}>
          {leftTabs.map((route) =>
            renderTabButton(route, state, descriptors, navigation, colors),
          )}
        </View>

        {/* Center mic button */}
        <View style={s.centerButtonContainer}>
          <ListeningGlow isActive={false} size={MIC_BUTTON_SIZE}>
            <Pressable
              onPress={handleCenterPress}
              onLongPress={handleCenterLongPress}
              style={[s.centerButton, { backgroundColor: colors.accent }]}
              accessibilityLabel="Start a conversation. Long press for more options."
              accessibilityRole="button"
              testID="tab-bar-mic-button"
            >
              <Feather name="mic" size={26} color="#fff" />
            </Pressable>
          </ListeningGlow>
          <Pressable
            onPress={handleTypePress}
            hitSlop={{ top: 8, bottom: 12, left: 16, right: 16 }}
            accessibilityLabel="Start by typing"
            accessibilityRole="button"
            testID="tab-bar-type-button"
          >
            <Text style={[typeLabelStyle, { color: colors.textTertiary }]}>Type</Text>
          </Pressable>
        </View>

        {/* Right tab group */}
        <View style={s.tabGroup}>
          {rightTabs.map((route) =>
            renderTabButton(route, state, descriptors, navigation, colors),
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * Renders a single tab button with icon, label, and optional badge.
 */
function renderTabButton(
  route: BottomTabBarProps['state']['routes'][number],
  state: BottomTabBarProps['state'],
  descriptors: BottomTabBarProps['descriptors'],
  navigation: BottomTabBarProps['navigation'],
  colors: ColorTokens,
) {
  const descriptor = descriptors[route.key];
  if (!descriptor) return null;

  const { options } = descriptor;
  const focused = state.index === state.routes.indexOf(route);
  const activeTintColor = options.tabBarActiveTintColor ?? colors.accent;
  const inactiveTintColor = options.tabBarInactiveTintColor ?? colors.textTertiary;
  const tintColor = focused ? activeTintColor : inactiveTintColor;
  const label = options.title ?? route.name;
  const badge = options.tabBarBadge;

  const handlePress = () => {
    const event = navigation.emit({
      type: 'tabPress',
      target: route.key,
      canPreventDefault: true,
    });

    if (!focused && !event.defaultPrevented) {
      navigation.navigate(route.name, route.params);
    }
  };

  const handleLongPress = () => {
    navigation.emit({
      type: 'tabLongPress',
      target: route.key,
    });
  };

  return (
    <Pressable
      key={route.key}
      onPress={handlePress}
      onLongPress={handleLongPress}
      haptic={false}
      style={tabButtonStyle}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={options.tabBarAccessibilityLabel ?? label}
      testID={options.tabBarButtonTestID}
    >
      <View style={iconContainerStyle}>
        {options.tabBarIcon?.({ focused, color: tintColor, size: 24 })}
        {badge != null && (
          <View style={[badgeStyle, { backgroundColor: colors.accent }]}>
            <Text style={badgeTextStyle}>{String(badge)}</Text>
          </View>
        )}
      </View>
      <Text style={[labelTextStyle, { color: tintColor }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const MIC_BUTTON_SIZE = 56;
const MIC_BUTTON_RAISE = 12;

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    wrapper: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      borderTopColor: 'transparent',
      backgroundColor: 'transparent',
      overflow: 'visible',
    },
    content: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingTop: 6,
    },
    tabGroup: {
      flex: 1,
      flexDirection: 'row',
      justifyContent: 'space-evenly',
    },
    centerButtonContainer: {
      alignItems: 'center',
      justifyContent: 'flex-end',
      width: MIC_BUTTON_SIZE + 16,
      marginTop: -MIC_BUTTON_RAISE,
    },
    centerButton: {
      width: MIC_BUTTON_SIZE,
      height: MIC_BUTTON_SIZE,
      borderRadius: MIC_BUTTON_SIZE / 2,
      alignItems: 'center',
      justifyContent: 'center',
      ...shadows.md,
      shadowColor: colors.shadowColor,
      shadowOpacity: colors.shadowOpacity + 0.1,
    },
  });
}

// Static styles that don't depend on theme colors
const tabButtonStyle: import('react-native').ViewStyle = {
  flex: 1,
  alignItems: 'center',
  justifyContent: 'center',
  paddingVertical: 4,
};

const iconContainerStyle: import('react-native').ViewStyle = {
  position: 'relative',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
};

const badgeStyle: import('react-native').ViewStyle = {
  position: 'absolute',
  top: -4,
  right: -10,
  minWidth: 18,
  height: 18,
  borderRadius: 9,
  alignItems: 'center',
  justifyContent: 'center',
  paddingHorizontal: 4,
};

const badgeTextStyle: import('react-native').TextStyle = {
  color: '#fff',
  fontSize: 11,
  fontWeight: '700',
  textAlign: 'center',
};

const labelTextStyle: import('react-native').TextStyle = {
  fontSize: 10,
  marginTop: 2,
  textAlign: 'center',
};

const typeLabelStyle: import('react-native').TextStyle = {
  fontSize: 10,
  marginTop: 4,
  textAlign: 'center',
};
