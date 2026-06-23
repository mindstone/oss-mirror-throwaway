/**
 * QueuedMessageChip tests — render states, accessibility, reduce motion.
 */

import React from 'react';
import { render } from '@testing-library/react-native';

// ---------------------------------------------------------------------------
// Mocks (must come before component import)
// ---------------------------------------------------------------------------

let mockReduceMotion = false;

jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return {
    ...Reanimated,
    useReducedMotion: () => mockReduceMotion,
  };
});

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name, ...props }: { name: string }) => (
      <Text testID={`icon-${name}`} {...props} />
    ),
  };
});

import { QueuedMessageChip } from '../components/QueuedMessageChip';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueuedMessageChip', () => {
  beforeEach(() => {
    mockReduceMotion = false;
  });

  describe('waiting state', () => {
    it('shows "Queued" text and clock icon', () => {
      const { getByText, getByTestId } = render(
        <QueuedMessageChip state="waiting" />,
      );

      expect(getByText('Queued')).toBeTruthy();
      expect(getByTestId('icon-clock')).toBeTruthy();
      expect(getByTestId('queued-message-chip-waiting')).toBeTruthy();
    });

    it('has accessibility label "Waiting to send"', () => {
      const { getByLabelText } = render(
        <QueuedMessageChip state="waiting" />,
      );

      expect(getByLabelText('Waiting to send')).toBeTruthy();
    });
  });

  describe('sending state', () => {
    it('shows "Sending…" text and loader icon', () => {
      const { getByText, getByTestId } = render(
        <QueuedMessageChip state="sending" />,
      );

      expect(getByText('Sending…')).toBeTruthy();
      expect(getByTestId('icon-loader')).toBeTruthy();
      expect(getByTestId('queued-message-chip-sending')).toBeTruthy();
    });

    it('has accessibility label "Sending"', () => {
      const { getByLabelText } = render(
        <QueuedMessageChip state="sending" />,
      );

      expect(getByLabelText('Sending')).toBeTruthy();
    });
  });

  describe('failed state', () => {
    it('shows "Failed to send" with alert-circle icon when no error message', () => {
      const { getByText, getByTestId } = render(
        <QueuedMessageChip state="failed" />,
      );

      expect(getByText('Failed to send')).toBeTruthy();
      expect(getByTestId('icon-alert-circle')).toBeTruthy();
      expect(getByTestId('queued-message-chip-failed')).toBeTruthy();
    });

    it('shows custom error message', () => {
      const { getByText } = render(
        <QueuedMessageChip state="failed" errorMessage="Server unreachable" />,
      );

      expect(getByText('Failed — Server unreachable')).toBeTruthy();
    });

    it('has accessibility label with error message', () => {
      const { getByLabelText } = render(
        <QueuedMessageChip state="failed" errorMessage="Auth expired" />,
      );

      expect(getByLabelText('Failed: Auth expired')).toBeTruthy();
    });

    it('has accessibility label without error message', () => {
      const { getByLabelText } = render(
        <QueuedMessageChip state="failed" />,
      );

      expect(getByLabelText('Failed to send')).toBeTruthy();
    });
  });

  describe('reduce motion', () => {
    it('does not animate in sending state when reduce motion is enabled', () => {
      mockReduceMotion = true;
      // Should render without error — animation is skipped
      const { getByText } = render(
        <QueuedMessageChip state="sending" />,
      );

      expect(getByText('Sending…')).toBeTruthy();
    });
  });
});
