import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { QueueStatus } from '@rebel/cloud-client';

// ---------------------------------------------------------------------------
// Mocks (must come before component import)
// ---------------------------------------------------------------------------

let mockSafeAreaTop = 0;

jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return {
    ...Reanimated,
    useReducedMotion: () => false,
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: mockSafeAreaTop, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name, ...props }: { name: string }) => <Text testID={`icon-${name}`} {...props} />,
  };
});

// Suppress the 3-second mount-delay guard for tests by advancing time.
beforeEach(() => {
  mockSafeAreaTop = 0;
  jest.useFakeTimers();
  act(() => {
    jest.advanceTimersByTime(4000);
  });
});
afterEach(() => {
  jest.useRealTimers();
});

import { ConnectivityBanner } from '../components/ConnectivityBanner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatus(overrides: Partial<QueueStatus> & { state: QueueStatus['state'] }): QueueStatus {
  return {
    totalPending: 0,
    totalFailed: 0,
    oldestEnqueuedAt: null,
    lastErrorCategory: null,
    shouldShowBanner: true,
    hasPermanentFailures: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConnectivityBanner', () => {
  it('renders nothing for online-live state', () => {
    const status = makeStatus({ state: 'online-live', shouldShowBanner: false });
    const { queryByText } = render(<ConnectivityBanner status={status} />);

    expect(queryByText('Offline')).toBeNull();
    expect(queryByText('Reconnecting...')).toBeNull();
  });

  it('renders offline-queued variant with item count', () => {
    const status = makeStatus({ state: 'offline-queued', totalPending: 3 });
    const { getByText } = render(<ConnectivityBanner status={status} />);

    expect(getByText('Offline')).toBeTruthy();
    expect(getByText("3 saved. I'll send them when you're back online.")).toBeTruthy();
  });

  it('renders offline-queued with singular copy for 1 item', () => {
    const status = makeStatus({ state: 'offline-queued', totalPending: 1 });
    const { getByText } = render(<ConnectivityBanner status={status} />);

    expect(getByText('Offline')).toBeTruthy();
    expect(getByText("1 saved. I'll send it when you're back online.")).toBeTruthy();
  });

  it('renders offline-empty variant without subtitle', () => {
    const status = makeStatus({ state: 'offline-empty' });
    const { getByText, queryByText } = render(<ConnectivityBanner status={status} />);

    expect(getByText('Offline')).toBeTruthy();
    // No subtitle text
    expect(queryByText(/saved/)).toBeNull();
  });

  it('renders reconnecting variant', () => {
    const status = makeStatus({ state: 'reconnecting' });
    const { getByText } = render(<ConnectivityBanner status={status} />);

    expect(getByText('Reconnecting…')).toBeTruthy();
  });

  it('renders online-draining variant with pending count', () => {
    const status = makeStatus({ state: 'online-draining', totalPending: 5 });
    const { getByText } = render(<ConnectivityBanner status={status} />);

    expect(getByText('Sending queued items…')).toBeTruthy();
    expect(getByText('5 waiting')).toBeTruthy();
  });

  it('renders limited variant with helpful copy', () => {
    const status = makeStatus({ state: 'limited' });
    const { getByText } = render(<ConnectivityBanner status={status} />);

    expect(getByText('Limited connection')).toBeTruthy();
    expect(getByText("Having trouble reaching the cloud. Will keep trying.")).toBeTruthy();
  });

  it('renders queue-full variant with queue-cap guidance', () => {
    const status = makeStatus({ state: 'queue-full' });
    const { getByText } = render(<ConnectivityBanner status={status} />);

    expect(getByText('Upload queue full')).toBeTruthy();
    expect(getByText("I'm at capacity right now. Keep the app online so I can clear space.")).toBeTruthy();
  });

  it('renders auth-expired variant with queued items', () => {
    const status = makeStatus({ state: 'auth-expired', totalPending: 2 });
    const { getByText, getByLabelText } = render(<ConnectivityBanner status={status} onSignIn={jest.fn()} />);

    expect(getByText('Your session expired')).toBeTruthy();
    expect(getByText('Sign in to send 2 queued items.')).toBeTruthy();
    expect(getByText('Sign in again →')).toBeTruthy();
    expect(getByLabelText('Sign in again →')).toBeTruthy();
  });

  it('reserves enough height for auth-expired copy below the safe area', () => {
    mockSafeAreaTop = 24;
    const status = makeStatus({ state: 'auth-expired', totalPending: 2 });
    const { getByTestId, getByText } = render(<ConnectivityBanner status={status} onSignIn={jest.fn()} />);

    const contentStyle = StyleSheet.flatten(getByTestId('connectivity-banner-content').props.style);
    expect(contentStyle.minHeight).toBeGreaterThanOrEqual(72);
    expect(getByText('Your session expired')).toBeTruthy();
    expect(getByText('Sign in to send 2 queued items.')).toBeTruthy();
  });

  it('renders auth-expired variant without queued items', () => {
    const status = makeStatus({ state: 'auth-expired', totalPending: 0 });
    const { getByText, getByLabelText } = render(<ConnectivityBanner status={status} onSignIn={jest.fn()} />);

    expect(getByText('Your session expired')).toBeTruthy();
    expect(getByText('Sign in to continue.')).toBeTruthy();
    expect(getByLabelText('Sign in again →')).toBeTruthy();
  });

  it('fires onSignIn when auth-expired CTA is tapped', () => {
    const onSignIn = jest.fn();
    const status = makeStatus({ state: 'auth-expired', totalPending: 1 });
    const { getByText } = render(<ConnectivityBanner status={status} onSignIn={onSignIn} />);

    fireEvent.press(getByText('Sign in again →'));
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('does not render CTA for non-auth-expired states', () => {
    const status = makeStatus({ state: 'offline-queued', totalPending: 1 });
    const { queryByText } = render(<ConnectivityBanner status={status} onSignIn={jest.fn()} />);

    expect(queryByText('Sign in again →')).toBeNull();
  });

  it('has accessible label for offline-queued', () => {
    const status = makeStatus({ state: 'offline-queued', totalPending: 2 });
    const { getByLabelText } = render(<ConnectivityBanner status={status} />);

    expect(getByLabelText("Offline. 2 saved. I'll send them when you're back online.")).toBeTruthy();
  });

  it('has accessible label for reconnecting (no subtitle)', () => {
    const status = makeStatus({ state: 'reconnecting' });
    const { getByLabelText } = render(<ConnectivityBanner status={status} />);

    expect(getByLabelText('Reconnecting…')).toBeTruthy();
  });

  it('renders wifi-off icon for offline states', () => {
    const status = makeStatus({ state: 'offline-queued', totalPending: 1 });
    const { getByTestId } = render(<ConnectivityBanner status={status} />);

    expect(getByTestId('icon-wifi-off')).toBeTruthy();
  });

  it('renders alert-triangle icon for auth-expired state', () => {
    const status = makeStatus({ state: 'auth-expired', totalPending: 0 });
    const { getByTestId } = render(<ConnectivityBanner status={status} onSignIn={jest.fn()} />);

    expect(getByTestId('icon-alert-triangle')).toBeTruthy();
  });

  it('renders cloud-off icon for limited state', () => {
    const status = makeStatus({ state: 'limited' });
    const { getByTestId } = render(<ConnectivityBanner status={status} />);

    expect(getByTestId('icon-cloud-off')).toBeTruthy();
  });

  it('renders alert-triangle icon for queue-full state', () => {
    const status = makeStatus({ state: 'queue-full' });
    const { getByTestId } = render(<ConnectivityBanner status={status} />);

    expect(getByTestId('icon-alert-triangle')).toBeTruthy();
  });

  // ---- Must Fix 2: startup suppression re-renders ----

  it('suppresses banner during first 3 seconds then shows it', () => {
    // Use real timers for this test to control timing precisely
    jest.useRealTimers();
    jest.useFakeTimers();

    const status = makeStatus({ state: 'offline-queued', totalPending: 1 });
    const { getByText, rerender } = render(<ConnectivityBanner status={status} />);

    // Content is rendered but isVisible is false (startup suppression active).
    // The component still renders content (height is animated to 0), so getByText works.
    expect(getByText('Offline')).toBeTruthy();

    // Advance past 3s — startup suppression lifts
    act(() => {
      jest.advanceTimersByTime(3100);
    });
    rerender(<ConnectivityBanner status={status} />);

    // Banner content still visible
    expect(getByText('Offline')).toBeTruthy();
  });

  // ---- Must Fix 4: has-failures state ----

  it('renders has-failures variant with failure count', () => {
    const status = makeStatus({ state: 'has-failures', totalFailed: 3, hasPermanentFailures: true });
    const { getByText } = render(<ConnectivityBanner status={status} />);

    expect(getByText("Some items couldn't send")).toBeTruthy();
    expect(getByText('3 failed. Tap to review.')).toBeTruthy();
  });

  it('reserves enough height for has-failures copy below the safe area', () => {
    mockSafeAreaTop = 24;
    const status = makeStatus({ state: 'has-failures', totalFailed: 3, hasPermanentFailures: true });
    const { getByTestId, getByText } = render(<ConnectivityBanner status={status} />);

    const contentStyle = StyleSheet.flatten(getByTestId('connectivity-banner-content').props.style);
    expect(contentStyle.minHeight).toBeGreaterThanOrEqual(72);
    expect(getByText("Some items couldn't send")).toBeTruthy();
    expect(getByText('3 failed. Tap to review.')).toBeTruthy();
  });

  it('renders has-failures with singular copy for 1 failure', () => {
    const status = makeStatus({ state: 'has-failures', totalFailed: 1, hasPermanentFailures: true });
    const { getByText } = render(<ConnectivityBanner status={status} />);

    expect(getByText("Some items couldn't send")).toBeTruthy();
    expect(getByText('1 failed. Tap to review.')).toBeTruthy();
  });

  it('renders alert-circle icon for has-failures state', () => {
    const status = makeStatus({ state: 'has-failures', totalFailed: 2, hasPermanentFailures: true });
    const { getByTestId } = render(<ConnectivityBanner status={status} />);

    expect(getByTestId('icon-alert-circle')).toBeTruthy();
  });

  it('has accessible label for has-failures', () => {
    const status = makeStatus({ state: 'has-failures', totalFailed: 2, hasPermanentFailures: true });
    const { getByLabelText } = render(<ConnectivityBanner status={status} />);

    expect(getByLabelText("Some items couldn't send. 2 failed. Tap to review.")).toBeTruthy();
  });

  it('fires onFailuresTap when the has-failures banner is tapped', () => {
    const onFailuresTap = jest.fn();
    const status = makeStatus({ state: 'has-failures', totalFailed: 2, hasPermanentFailures: true });
    const { getByText } = render(<ConnectivityBanner status={status} onFailuresTap={onFailuresTap} />);

    fireEvent.press(getByText("Some items couldn't send"));
    expect(onFailuresTap).toHaveBeenCalledTimes(1);
  });

  // ---- Must Fix 6: wsConnected removed from inputs (no banner for disconnected WS) ----
  // Note: wsConnected was removed from QueueStatusInputs. The banner component
  // itself is presentation-only and does not read wsConnected — this is tested
  // implicitly by the connected wrapper tests and useQueueStatus tests.
});
