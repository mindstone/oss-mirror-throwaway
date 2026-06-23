import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    Feather: ({ name }: { name: string }) => ReactLocal.createElement(RNLocal.Text, { testID: `icon-${name}` }, name),
  };
});

jest.mock('../approval/ApprovalSheetShell', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    ApprovalSheetShell: ({
      children,
      visible,
      title,
      subtitle,
      testID,
      maxHeight,
    }: {
      children: React.ReactNode;
      visible: boolean;
      title: string;
      subtitle?: string;
      testID: string;
      maxHeight?: string;
    }) => {
      if (!visible) return null;
      return ReactLocal.createElement(
        RNLocal.View,
        { testID, maxHeight },
        ReactLocal.createElement(RNLocal.Text, { testID: `${testID}-title` }, title),
        subtitle
          ? ReactLocal.createElement(RNLocal.Text, { testID: `${testID}-subtitle` }, subtitle)
          : null,
        children,
      );
    },
  };
});

import { ASK_SPARK_OPTIONS, AskSparkPicker } from '../AskSparkPicker';

describe('AskSparkPicker', () => {
  it('renders the locked header, default subtitle, max-height shell, and five options', () => {
    const { getByTestId, getByText } = render(
      <AskSparkPicker visible onClose={jest.fn()} onSelectPrompt={jest.fn()} />,
    );

    expect(getByTestId('ask-spark-picker-title').props.children).toBe('Ask Spark');
    expect(getByTestId('ask-spark-picker-subtitle').props.children).toBe('Pick a question. Answers stay here, not in the call.');
    expect(getByTestId('ask-spark-picker').props.maxHeight).toBe('55%');
    for (const option of ASK_SPARK_OPTIONS) {
      expect(getByText(option.label)).toBeTruthy();
      expect(getByTestId(`icon-${option.icon}`)).toBeTruthy();
    }
  });

  it.each([
    ['offline', 'Pick a question. Spark will answer when reconnected.'],
    ['rate-limited', 'Voice trigger is paused. The button still works.'],
  ] as const)('renders the %s subtitle variant', (subtitleVariant, expected) => {
    const { getByTestId } = render(
      <AskSparkPicker
        visible
        onClose={jest.fn()}
        onSelectPrompt={jest.fn()}
        subtitleVariant={subtitleVariant}
      />,
    );

    expect(getByTestId('ask-spark-picker-subtitle').props.children).toBe(expected);
  });

  it('dismisses and submits the exact triggerExtracted prompt for each option', () => {
    for (const option of ASK_SPARK_OPTIONS) {
      const onClose = jest.fn();
      const onSelectPrompt = jest.fn();
      const { getByTestId, unmount } = render(
        <AskSparkPicker visible onClose={onClose} onSelectPrompt={onSelectPrompt} />,
      );

      fireEvent.press(getByTestId(`ask-spark-option-${option.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSelectPrompt).toHaveBeenCalledWith(option.triggerExtracted);
      unmount();
    }
  });
});
