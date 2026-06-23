/**
 * CustomTabBar tests — center mic button, visible tabs, and badge rendering.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

// --- Mock expo-router ---
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// --- Mock expo-blur ---
jest.mock('expo-blur', () => {
  const { View } = require('react-native');
  return {
    BlurView: (props: Record<string, unknown>) => <View {...props} />,
  };
});

// --- Mock @react-navigation/bottom-tabs ---
// Create the context inside the factory so it's available when jest.mock is hoisted.
const mockOnHeightChange = jest.fn();
jest.mock('@react-navigation/bottom-tabs', () => {
  const R = require('react');
  return {
    useBottomTabBarHeight: () => 0,
    BottomTabBarHeightCallbackContext: R.createContext(undefined),
  };
});

// Retrieve the mocked context so we can wrap components with its Provider.
const { BottomTabBarHeightCallbackContext } = require('@react-navigation/bottom-tabs');

import { CustomTabBar } from '../components/CustomTabBar';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Feather } from '@expo/vector-icons';

/**
 * Build minimal BottomTabBarProps for testing.
 * 5 routes: index (Home), inbox (Actions), conversations, approvals (hidden), help.
 */
function createTabBarProps(overrides: {
  activeIndex?: number;
  badges?: Record<string, string | number>;
} = {}): BottomTabBarProps {
  const { activeIndex = 0, badges = {} } = overrides;

  const routes = [
    { key: 'index-key', name: 'index', params: undefined },
    { key: 'inbox-key', name: 'inbox', params: undefined },
    { key: 'conversations-key', name: 'conversations', params: undefined },
    { key: 'approvals-key', name: 'approvals', params: undefined },
    { key: 'help-key', name: 'help', params: undefined },
  ];

  const descriptors: BottomTabBarProps['descriptors'] = {} as BottomTabBarProps['descriptors'];
  const titles: Record<string, string> = {
    'index-key': 'Home',
    'inbox-key': 'Actions',
    'conversations-key': 'Conversations',
    'approvals-key': 'Approvals',
    'help-key': 'Help',
  };
  const icons: Record<string, string> = {
    'index-key': 'home',
    'inbox-key': 'inbox',
    'conversations-key': 'message-circle',
    'approvals-key': 'check-circle',
    'help-key': 'help-circle',
  };

  for (const route of routes) {
    const iconName = icons[route.key] as keyof typeof Feather.glyphMap;
    (descriptors as Record<string, unknown>)[route.key] = {
      options: {
        title: titles[route.key],
        tabBarIcon: ({ color, size }: { color: string; size: number; focused: boolean }) => (
          <Feather name={iconName} size={size} color={color} />
        ),
        tabBarActiveTintColor: '#007AFF',
        tabBarInactiveTintColor: '#8E8E93',
        // Approvals tab is hidden (href: null)
        ...(route.key === 'approvals-key' ? { href: null } : {}),
        // Optional badge
        ...(badges[route.key] != null ? { tabBarBadge: badges[route.key] } : {}),
      },
      navigation: {} as BottomTabBarProps['navigation'],
      render: () => null,
      route,
    };
  }

  const navigation = {
    emit: jest.fn(() => ({ defaultPrevented: false })),
    navigate: jest.fn(),
  } as unknown as BottomTabBarProps['navigation'];

  return {
    state: {
      index: activeIndex,
      routes,
      key: 'tabs-key',
      routeNames: routes.map((r) => r.name),
      stale: false,
      type: 'tab' as const,
      history: [],
    } as unknown as BottomTabBarProps['state'],
    descriptors: descriptors as BottomTabBarProps['descriptors'],
    navigation,
    insets: { top: 0, bottom: 34, left: 0, right: 0 },
  };
}

/** Wrap CustomTabBar with the height callback context for realistic rendering. */
function renderTabBar(props?: Parameters<typeof createTabBarProps>[0]) {
  const tabBarProps = createTabBarProps(props);
  return {
    ...render(
      <BottomTabBarHeightCallbackContext.Provider value={mockOnHeightChange}>
        <CustomTabBar {...tabBarProps} />
      </BottomTabBarHeightCallbackContext.Provider>,
    ),
    tabBarProps,
  };
}

beforeEach(() => {
  mockPush.mockClear();
  mockOnHeightChange.mockClear();
});

describe('CustomTabBar', () => {
  it('renders 4 visible tab buttons (not the hidden Approvals tab)', () => {
    const { getByText, queryByText } = renderTabBar();

    expect(getByText('Home')).toBeTruthy();
    expect(getByText('Actions')).toBeTruthy();
    expect(getByText('Conversations')).toBeTruthy();
    expect(getByText('Help')).toBeTruthy();
    // Approvals tab is hidden (href: null) and should not be rendered
    expect(queryByText('Approvals')).toBeNull();
  });

  it('renders the center mic button with correct testID', () => {
    const { getByTestId } = renderTabBar();

    const micButton = getByTestId('tab-bar-mic-button');
    expect(micButton).toBeTruthy();
    expect(micButton.props.accessibilityLabel).toBe('Start a conversation. Long press for more options.');
  });

  it('navigates to a new conversation with autoRecord on center mic press', () => {
    const { getByTestId } = renderTabBar();

    fireEvent.press(getByTestId('tab-bar-mic-button'));

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(
      expect.stringMatching(/^\/conversation\/mobile-\d+-\w+\?autoRecord=true$/),
    );
  });

  it('hides Approvals tab even when href is absent from descriptor options', () => {
    // Simulate real expo-router behavior: href may be stripped entirely
    // from descriptor options (making it undefined instead of null).
    const tabBarProps = createTabBarProps();
    const approvalsDescriptor = (tabBarProps.descriptors as Record<string, { options: Record<string, unknown> }>)['approvals-key'];
    delete approvalsDescriptor.options.href;

    const { queryByText, getByText } = render(
      <BottomTabBarHeightCallbackContext.Provider value={mockOnHeightChange}>
        <CustomTabBar {...tabBarProps} />
      </BottomTabBarHeightCallbackContext.Provider>,
    );

    // Approvals should still be hidden via route-name filter
    expect(queryByText('Approvals')).toBeNull();
    // Other tabs are still visible
    expect(getByText('Home')).toBeTruthy();
    expect(getByText('Actions')).toBeTruthy();
    expect(getByText('Conversations')).toBeTruthy();
    expect(getByText('Help')).toBeTruthy();
  });

  it('renders Type button that navigates to text compose', () => {
    const { getByTestId, getByText } = renderTabBar();

    const typeButton = getByTestId('tab-bar-type-button');
    expect(typeButton).toBeTruthy();
    expect(getByText('Type')).toBeTruthy();

    fireEvent.press(typeButton);

    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(
      expect.stringMatching(/^\/conversation\/mobile-\d+-\w+\?compose=text$/),
    );
  });

  it('renders badge when provided in tab options', () => {
    const { getByText } = renderTabBar({
      badges: { 'inbox-key': 3 },
    });

    // Badge text should be visible
    expect(getByText('3')).toBeTruthy();
  });
});
