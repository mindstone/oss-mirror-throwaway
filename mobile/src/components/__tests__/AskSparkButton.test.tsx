import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

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
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    Feather: ({ name }: { name: string }) => ReactLocal.createElement(RNLocal.Text, { testID: `icon-${name}` }, name),
  };
});

import { AskSparkButton } from '../AskSparkButton';

describe('AskSparkButton', () => {
  beforeEach(() => {
    mockReduceMotion = false;
  });

  it('renders the locked label, icon, and accessibility copy', () => {
    const onPress = jest.fn();
    const { getByLabelText, getByText, getByTestId } = render(<AskSparkButton onPress={onPress} />);

    const button = getByLabelText('Ask Spark during this meeting');
    expect(button.props.accessibilityHint).toBe('Opens meeting questions you can send to Spark.');
    expect(getByText('Ask Spark')).toBeTruthy();
    expect(getByTestId('icon-message-circle')).toBeTruthy();

    fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('keeps a 44pt minimum tap target and exposes disabled state only when disabled', () => {
    const { getByTestId, rerender } = render(<AskSparkButton onPress={jest.fn()} />);
    const enabledStyle = StyleSheet.flatten(getByTestId('ask-spark-button').props.style);

    expect(enabledStyle.minHeight).toBeGreaterThanOrEqual(44);
    expect(enabledStyle.minWidth).toBeGreaterThanOrEqual(44);
    expect(getByTestId('ask-spark-button').props.accessibilityState.disabled).toBe(false);

    rerender(<AskSparkButton onPress={jest.fn()} disabled />);
    expect(getByTestId('ask-spark-button').props.accessibilityState).toEqual({ disabled: true });
  });

  it('uses the reduced-motion seam to hold the pulse ring instead of requiring animation', () => {
    mockReduceMotion = true;
    const { getByTestId } = render(
      <AskSparkButton onPress={jest.fn()} pulsing reducedMotionOverride />,
    );

    expect(getByTestId('ask-spark-button-pulse-ring')).toBeTruthy();
  });
});
