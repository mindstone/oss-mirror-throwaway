import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import * as ReactNative from 'react-native';

type CameraPermission = { granted: boolean; canAskAgain: boolean } | null;

const mockRequestPermission = jest.fn();
const mockPair = jest.fn().mockResolvedValue(undefined);
const mockClearError = jest.fn();
let mockCameraPermission: CameraPermission = { granted: true, canAskAgain: true };
let mockWindowWidth = 1024;

const mockAuthState = {
  pair: mockPair,
  isValidating: false,
  error: null as string | null,
  clearError: mockClearError,
};

jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return {
    ...Reanimated,
    useReducedMotion: () => false,
  };
});

jest.mock('expo-camera', () => {
  const { View } = require('react-native');
  return {
    CameraView: (props: Record<string, unknown>) => <View {...props} />,
    useCameraPermissions: () => [mockCameraPermission, mockRequestPermission],
  };
});

jest.mock('expo-blur', () => {
  const { View } = require('react-native');
  return {
    BlurView: (props: Record<string, unknown>) => <View {...props} />,
  };
});

jest.mock('expo-status-bar', () => ({
  StatusBar: () => null,
}));

jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  impactAsync: jest.fn().mockResolvedValue(undefined),
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  NotificationFeedbackType: { Success: 'success' },
  ImpactFeedbackStyle: { Light: 'light' },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@rebel/cloud-client', () => ({
  __esModule: true,
  useAuthStore: Object.assign(
    jest.fn(() => mockAuthState),
    { getState: () => mockAuthState },
  ),
}));

const mockedCloudClient = jest.requireMock('@rebel/cloud-client') as {
  useAuthStore: jest.Mock & { getState: () => typeof mockAuthState };
};

import { PairScreen } from '../screens/PairScreen';

function isDisabled(element: { props: Record<string, unknown> }) {
  const accessibilityState = element.props.accessibilityState as { disabled?: boolean } | undefined;
  return Boolean(element.props.disabled ?? accessibilityState?.disabled);
}

describe('PairScreen', () => {
  let useWindowDimensionsSpy: jest.SpyInstance;

  beforeEach(() => {
    mockCameraPermission = { granted: true, canAskAgain: true };
    mockWindowWidth = 1024;
    mockAuthState.isValidating = false;
    mockAuthState.error = null;
    mockRequestPermission.mockClear();
    mockPair.mockClear();
    mockClearError.mockClear();
    mockedCloudClient.useAuthStore.mockClear();
    useWindowDimensionsSpy = jest.spyOn(ReactNative, 'useWindowDimensions').mockReturnValue({
      width: mockWindowWidth,
      height: 1024,
      scale: 2,
      fontScale: 2,
    });
  });

  afterEach(() => {
    useWindowDimensionsSpy.mockRestore();
  });

  it('renders in scan mode by default', () => {
    const { getByTestId, queryByTestId } = render(<PairScreen />);

    expect(getByTestId('pair-screen')).toBeTruthy();
    expect(getByTestId('pair-qr-scanner')).toBeTruthy();
    expect(queryByTestId('pair-url-input')).toBeNull();
  });

  it('shows camera permission request when camera access is not granted', () => {
    mockCameraPermission = { granted: false, canAskAgain: true };

    const { getByTestId, getByText } = render(<PairScreen />);

    expect(getByTestId('pair-camera-permission-button')).toBeTruthy();
    expect(getByText('We need your camera to scan the pairing code. Nothing else.')).toBeTruthy();
  });

  it('switches to manual mode when manual link is tapped', () => {
    const { getByTestId, queryByTestId } = render(<PairScreen />);

    fireEvent.press(getByTestId('pair-manual-toggle-button'));

    expect(getByTestId('pair-url-input')).toBeTruthy();
    expect(getByTestId('pair-token-input')).toBeTruthy();
    expect(queryByTestId('pair-qr-scanner')).toBeNull();
  });

  it('switches back to scan mode from manual mode', () => {
    const { getByTestId, queryByTestId } = render(<PairScreen />);

    fireEvent.press(getByTestId('pair-manual-toggle-button'));
    expect(getByTestId('pair-scan-toggle-button')).toBeTruthy();

    fireEvent.press(getByTestId('pair-scan-toggle-button'));

    expect(getByTestId('pair-qr-scanner')).toBeTruthy();
    expect(queryByTestId('pair-url-input')).toBeNull();
  });

  it('keeps manual connect disabled until both fields are filled', () => {
    const { getByTestId } = render(<PairScreen />);

    fireEvent.press(getByTestId('pair-manual-toggle-button'));

    expect(isDisabled(getByTestId('pair-connect-button'))).toBe(true);

    fireEvent.changeText(getByTestId('pair-url-input'), 'https://rebel.example');
    expect(isDisabled(getByTestId('pair-connect-button'))).toBe(true);

    fireEvent.changeText(getByTestId('pair-token-input'), 'pairing-token');
    expect(isDisabled(getByTestId('pair-connect-button'))).toBe(false);
  });

  it('exposes all required testIDs across supported states', () => {
    const firstRender = render(<PairScreen />);

    expect(firstRender.getByTestId('pair-screen')).toBeTruthy();
    expect(firstRender.getByTestId('pair-qr-scanner')).toBeTruthy();
    expect(firstRender.getByTestId('pair-manual-toggle-button')).toBeTruthy();

    fireEvent.press(firstRender.getByTestId('pair-manual-toggle-button'));

    expect(firstRender.getByTestId('pair-url-input')).toBeTruthy();
    expect(firstRender.getByTestId('pair-token-input')).toBeTruthy();
    expect(firstRender.getByTestId('pair-connect-button')).toBeTruthy();
    expect(firstRender.getByTestId('pair-scan-toggle-button')).toBeTruthy();

    mockAuthState.error = 'Network timeout';
    firstRender.rerender(<PairScreen />);
    expect(firstRender.getByTestId('pair-error')).toBeTruthy();

    firstRender.unmount();
    mockAuthState.error = null;
    mockCameraPermission = { granted: false, canAskAgain: true };

    const permissionRender = render(<PairScreen />);
    expect(permissionRender.getByTestId('pair-camera-permission-button')).toBeTruthy();
  });

  it('renders an error banner when the auth store has an error', () => {
    mockAuthState.error = 'connect failed';

    const { getByTestId } = render(<PairScreen />);

    expect(getByTestId('pair-error')).toBeTruthy();
  });
});
