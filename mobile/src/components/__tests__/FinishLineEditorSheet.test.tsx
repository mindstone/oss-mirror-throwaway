import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Modal } from 'react-native';

jest.mock('@expo/vector-icons', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    Feather: ({ name, testID }: { name: string; testID?: string }) =>
      ReactLocal.createElement(RNLocal.Text, { testID }, name),
  };
});

import { FinishLineEditorSheet } from '../FinishLineEditorSheet';

function renderSheet(overrides: Partial<React.ComponentProps<typeof FinishLineEditorSheet>> = {}) {
  const props: React.ComponentProps<typeof FinishLineEditorSheet> = {
    visible: true,
    initialValue: undefined,
    onClose: jest.fn(),
    onSave: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  return {
    ...render(<FinishLineEditorSheet {...props} />),
    props,
  };
}

describe('FinishLineEditorSheet', () => {
  it('renders the initial value', () => {
    const { getByDisplayValue } = renderSheet({
      initialValue: 'Ready to send',
    });

    expect(getByDisplayValue('Ready to send')).toBeTruthy();
  });

  it('uses the canonical placeholder and helper text for an empty draft', () => {
    const { getByPlaceholderText, getByText } = renderSheet();

    expect(getByPlaceholderText('Example: The brief is ready to send, with risks called out.')).toBeTruthy();
    expect(getByText('No finish line. Rebel will use its usual judgment.')).toBeTruthy();
  });

  it('switches helper text when the draft has content', () => {
    const { getByTestId, getByText } = renderSheet();

    fireEvent.changeText(getByTestId('finish-line-editor-input'), 'Ready to send');

    expect(getByText('Rebel stops when this is met.')).toBeTruthy();
  });

  it('marks the modal as screen-reader modal', () => {
    const { UNSAFE_getByType, getByLabelText } = renderSheet();

    expect(UNSAFE_getByType(Modal).props.accessibilityViewIsModal).toBe(true);
    expect(getByLabelText('Finish line editor')).toBeTruthy();
  });

  it('saves the normalized value', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const { getByTestId } = renderSheet({ onSave });

    fireEvent.changeText(getByTestId('finish-line-editor-input'), '  Ready to send  ');
    fireEvent.press(getByTestId('finish-line-editor-save-button'));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('Ready to send');
    });
  });

  it('updates the save button accessibility while saving', async () => {
    let resolveSave: (() => void) | undefined;
    const onSave = jest.fn().mockImplementation(() => new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));
    const { getByTestId } = renderSheet({ onSave });

    fireEvent.changeText(getByTestId('finish-line-editor-input'), 'Ready to send');
    fireEvent.press(getByTestId('finish-line-editor-save-button'));

    await waitFor(() => {
      expect(getByTestId('finish-line-editor-save-button').props.accessibilityLabel).toBe(
        'Saving finish line',
      );
      expect(getByTestId('finish-line-editor-save-button').props.accessibilityState).toEqual({
        disabled: true,
        busy: true,
      });
    });

    await act(async () => {
      resolveSave?.();
    });
  });

  it('clears the existing value', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const { getByTestId } = renderSheet({
      initialValue: 'Ready to send',
      onSave,
    });

    fireEvent.press(getByTestId('finish-line-editor-clear-button'));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('');
    });
  });

  it('shows the character counter after 400 characters', () => {
    const { getByText, getByTestId } = renderSheet();
    const longCriterion = 'a'.repeat(401);

    fireEvent.changeText(getByTestId('finish-line-editor-input'), longCriterion);

    expect(getByText('401/500')).toBeTruthy();
  });
});
