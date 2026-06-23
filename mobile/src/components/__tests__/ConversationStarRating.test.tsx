import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

import { ConversationStarRating } from '../ConversationStarRating';

jest.mock('@expo/vector-icons', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    Feather: ({ name, testID }: { name: string; testID?: string }) =>
      ReactLocal.createElement(RNLocal.Text, { testID }, name),
  };
});

describe('ConversationStarRating', () => {
  it('renders five radios and marks the selected star as checked', () => {
    const { getByTestId } = render(
      <ConversationStarRating value={3} onSelect={jest.fn()} />,
    );

    expect(getByTestId('conversation-star-rating-star-1').props.accessibilityRole).toBe('radio');
    expect(getByTestId('conversation-star-rating-star-2').props.accessibilityRole).toBe('radio');
    expect(getByTestId('conversation-star-rating-star-3').props.accessibilityRole).toBe('radio');
    expect(getByTestId('conversation-star-rating-star-4').props.accessibilityRole).toBe('radio');
    expect(getByTestId('conversation-star-rating-star-5').props.accessibilityRole).toBe('radio');

    expect(getByTestId('conversation-star-rating-star-1').props.accessibilityState.checked).toBe(false);
    expect(getByTestId('conversation-star-rating-star-2').props.accessibilityState.checked).toBe(false);
    expect(getByTestId('conversation-star-rating-star-3').props.accessibilityState.checked).toBe(true);
    expect(getByTestId('conversation-star-rating-star-4').props.accessibilityState.checked).toBe(false);
    expect(getByTestId('conversation-star-rating-star-5').props.accessibilityState.checked).toBe(false);
  });

  it('calls onSelect with the tapped star rating', () => {
    const onSelect = jest.fn();
    const { getByTestId } = render(
      <ConversationStarRating value={null} onSelect={onSelect} />,
    );

    fireEvent.press(getByTestId('conversation-star-rating-star-4'));
    expect(onSelect).toHaveBeenCalledWith(4);
  });
});
