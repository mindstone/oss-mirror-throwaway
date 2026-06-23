import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    Feather: ({ name, testID }: { name: string; testID?: string }) =>
      ReactLocal.createElement(RNLocal.Text, { testID }, name),
  };
});

import { FinishLineChip } from '../FinishLineChip';

describe('FinishLineChip', () => {
  it('renders the empty affordance', () => {
    const { getByText, getByTestId } = render(
      <FinishLineChip value={undefined} onPress={jest.fn()} />,
    );

    expect(getByText('Set finish line')).toBeTruthy();
    const chip = getByTestId('finish-line-chip');
    expect(chip.props.accessibilityLabel).toBe('Set finish line');
    expect(chip.props.accessibilityHint).toBe('Tell Rebel what finished looks like.');
    expect(chip.props.accessibilityState).toEqual({ selected: false });
    expect(chip.props.hitSlop).toBe(8);
  });

  it('renders a populated criterion with the flag icon', () => {
    const { getByText, getByTestId } = render(
      <FinishLineChip value="The brief is ready to send" onPress={jest.fn()} />,
    );

    expect(getByText('The brief is ready to send')).toBeTruthy();
    expect(getByTestId('finish-line-chip-icon').props.children).toBe('flag');
    const chip = getByTestId('finish-line-chip');
    expect(chip.props.accessibilityLabel).toBe(
      'Finish line: The brief is ready to send',
    );
    expect(chip.props.accessibilityHint).toBe(
      'Rebel stops when this is met. Opens the editor to edit or clear it.',
    );
    expect(chip.props.accessibilityState).toEqual({ selected: true });
  });

  it('presses through to onPress', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <FinishLineChip value={undefined} onPress={onPress} />,
    );

    fireEvent.press(getByTestId('finish-line-chip'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
