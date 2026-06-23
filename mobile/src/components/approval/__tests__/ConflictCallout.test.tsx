/**
 * ConflictCallout tests — verify the three action buttons fire the right
 * callbacks, offline mode disables all actions + shows the hint, and
 * each button has the expected accessibility wiring. Round-1 remediation
 * (F6-R1-5) adds coverage for internal per-action busy state and
 * single-fire haptics under rapid-tap conditions.
 */

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name, testID }: { name: string; testID?: string }) => (
      <Text testID={testID}>{name}</Text>
    ),
  };
});

// Haptics: replace with mocks so we can assert they fire exactly once
// per successful tap. Mock variables must be prefixed with `mock` so
// jest hoists them correctly ahead of the `jest.mock()` factory.
const mockHapticMedium = jest.fn();
const mockHapticWarning = jest.fn();
jest.mock('../../../utils/haptics', () => ({
  hapticMedium: (...args: unknown[]) => mockHapticMedium(...args),
  hapticWarning: (...args: unknown[]) => mockHapticWarning(...args),
}));

import { ConflictCallout } from '../ConflictCallout';

beforeEach(() => {
  mockHapticMedium.mockReset();
  mockHapticWarning.mockReset();
});

describe('ConflictCallout', () => {
  it('renders all three actions and header copy', () => {
    const { getByTestId, getByText } = render(
      <ConflictCallout
        onResolveWithRebel={jest.fn()}
        onKeepMine={jest.fn()}
        onKeepTheirs={jest.fn()}
      />,
    );

    expect(getByText('This file conflicts with a recent change')).toBeTruthy();
    expect(getByTestId('conflict-callout-resolve-with-rebel')).toBeTruthy();
    expect(getByTestId('conflict-callout-keep-mine')).toBeTruthy();
    expect(getByTestId('conflict-callout-keep-theirs')).toBeTruthy();
  });

  it('fires onResolveWithRebel when the primary button is tapped', () => {
    const onResolveWithRebel = jest.fn();
    const { getByTestId } = render(
      <ConflictCallout
        onResolveWithRebel={onResolveWithRebel}
        onKeepMine={jest.fn()}
        onKeepTheirs={jest.fn()}
      />,
    );

    fireEvent.press(getByTestId('conflict-callout-resolve-with-rebel'));
    expect(onResolveWithRebel).toHaveBeenCalledTimes(1);
  });

  it('fires onKeepMine when "Keep mine" is tapped', () => {
    const onKeepMine = jest.fn();
    const { getByTestId } = render(
      <ConflictCallout
        onResolveWithRebel={jest.fn()}
        onKeepMine={onKeepMine}
        onKeepTheirs={jest.fn()}
      />,
    );
    fireEvent.press(getByTestId('conflict-callout-keep-mine'));
    expect(onKeepMine).toHaveBeenCalledTimes(1);
  });

  it('fires onKeepTheirs when "Keep theirs" is tapped', () => {
    const onKeepTheirs = jest.fn();
    const { getByTestId } = render(
      <ConflictCallout
        onResolveWithRebel={jest.fn()}
        onKeepMine={jest.fn()}
        onKeepTheirs={onKeepTheirs}
      />,
    );
    fireEvent.press(getByTestId('conflict-callout-keep-theirs'));
    expect(onKeepTheirs).toHaveBeenCalledTimes(1);
  });

  it('disables all actions and shows the offline hint when isOnline=false', () => {
    const onResolveWithRebel = jest.fn();
    const onKeepMine = jest.fn();
    const onKeepTheirs = jest.fn();

    const { getByTestId } = render(
      <ConflictCallout
        onResolveWithRebel={onResolveWithRebel}
        onKeepMine={onKeepMine}
        onKeepTheirs={onKeepTheirs}
        isOnline={false}
      />,
    );

    expect(getByTestId('conflict-callout-offline')).toBeTruthy();

    // Disabled buttons in RN don't fire onPress.
    fireEvent.press(getByTestId('conflict-callout-resolve-with-rebel'));
    fireEvent.press(getByTestId('conflict-callout-keep-mine'));
    fireEvent.press(getByTestId('conflict-callout-keep-theirs'));

    expect(onResolveWithRebel).not.toHaveBeenCalled();
    expect(onKeepMine).not.toHaveBeenCalled();
    expect(onKeepTheirs).not.toHaveBeenCalled();
  });

  it('disables all actions when external busy=true', () => {
    const onResolveWithRebel = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <ConflictCallout
        onResolveWithRebel={onResolveWithRebel}
        onKeepMine={jest.fn()}
        onKeepTheirs={jest.fn()}
        busy
      />,
    );

    // Busy does NOT imply offline, so the offline hint should NOT render.
    expect(queryByTestId('conflict-callout-offline')).toBeNull();

    fireEvent.press(getByTestId('conflict-callout-resolve-with-rebel'));
    expect(onResolveWithRebel).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // F6-R1-5 — internal busy state + single-fire haptics
  // -------------------------------------------------------------------

  describe('rapid-tap defense + single-fire haptics (F6-R1-5)', () => {
    it('rapid-double-tap on "Keep mine" fires dispatch exactly once and haptic exactly once', () => {
      // Handler that returns a pending promise so the callout stays
      // internally-busy between taps.
      let resolveIt!: () => void;
      const pending = new Promise<void>((res) => {
        resolveIt = res;
      });
      const onKeepMine = jest.fn(() => pending);
      const { getByTestId } = render(
        <ConflictCallout
          onResolveWithRebel={jest.fn()}
          onKeepMine={onKeepMine}
          onKeepTheirs={jest.fn()}
        />,
      );

      const btn = getByTestId('conflict-callout-keep-mine');
      // Two rapid taps in the same synchronous pass.
      fireEvent.press(btn);
      fireEvent.press(btn);
      fireEvent.press(btn);

      expect(onKeepMine).toHaveBeenCalledTimes(1);
      expect(mockHapticWarning).toHaveBeenCalledTimes(1);

      // Resolve the pending promise so other tests don't see lingering
      // state.
      resolveIt();
    });

    it('disables ALL actions while ANY action is in-flight', () => {
      let resolveIt!: () => void;
      const pending = new Promise<void>((res) => {
        resolveIt = res;
      });
      const onResolveWithRebel = jest.fn(() => pending);
      const onKeepMine = jest.fn();
      const onKeepTheirs = jest.fn();

      const { getByTestId } = render(
        <ConflictCallout
          onResolveWithRebel={onResolveWithRebel}
          onKeepMine={onKeepMine}
          onKeepTheirs={onKeepTheirs}
        />,
      );

      fireEvent.press(getByTestId('conflict-callout-resolve-with-rebel'));
      expect(onResolveWithRebel).toHaveBeenCalledTimes(1);

      // Now try to tap Keep mine / Keep theirs while the primary
      // dispatch is in-flight. Both should be blocked.
      fireEvent.press(getByTestId('conflict-callout-keep-mine'));
      fireEvent.press(getByTestId('conflict-callout-keep-theirs'));

      expect(onKeepMine).not.toHaveBeenCalled();
      expect(onKeepTheirs).not.toHaveBeenCalled();

      resolveIt();
    });

    it('clears busy state after the async handler resolves', async () => {
      let resolveIt!: () => void;
      const pending = new Promise<void>((res) => {
        resolveIt = res;
      });
      const onKeepMine = jest.fn(() => pending);
      const onKeepTheirs = jest.fn();

      const { getByTestId } = render(
        <ConflictCallout
          onResolveWithRebel={jest.fn()}
          onKeepMine={onKeepMine}
          onKeepTheirs={onKeepTheirs}
        />,
      );

      fireEvent.press(getByTestId('conflict-callout-keep-mine'));
      expect(onKeepMine).toHaveBeenCalledTimes(1);

      // While still pending, sibling button is disabled.
      fireEvent.press(getByTestId('conflict-callout-keep-theirs'));
      expect(onKeepTheirs).not.toHaveBeenCalled();

      // Resolve and flush the microtask queue so the `finally` callback
      // runs and busy state clears.
      await act(async () => {
        resolveIt();
        await Promise.resolve();
        await Promise.resolve();
      });

      // Now the sibling action should be tappable again.
      await waitFor(() => {
        fireEvent.press(getByTestId('conflict-callout-keep-theirs'));
        expect(onKeepTheirs).toHaveBeenCalledTimes(1);
      });
    });

    it('clears busy state after the async handler REJECTS', async () => {
      let rejectIt!: (err: Error) => void;
      const pending = new Promise<void>((_res, rej) => {
        rejectIt = rej;
      });
      const onKeepMine = jest.fn(() => pending);
      const onKeepTheirs = jest.fn();

      const { getByTestId } = render(
        <ConflictCallout
          onResolveWithRebel={jest.fn()}
          onKeepMine={onKeepMine}
          onKeepTheirs={onKeepTheirs}
        />,
      );

      fireEvent.press(getByTestId('conflict-callout-keep-mine'));
      expect(onKeepMine).toHaveBeenCalledTimes(1);

      fireEvent.press(getByTestId('conflict-callout-keep-theirs'));
      expect(onKeepTheirs).not.toHaveBeenCalled();

      await act(async () => {
        rejectIt(new Error('boom'));
        // Suppress unhandled-rejection noise from the internal .finally(),
        // then flush.
        pending.catch(() => undefined);
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() => {
        fireEvent.press(getByTestId('conflict-callout-keep-theirs'));
        expect(onKeepTheirs).toHaveBeenCalledTimes(1);
      });
    });
  });
});
