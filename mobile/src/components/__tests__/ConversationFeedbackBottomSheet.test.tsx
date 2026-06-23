import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { ConversationFeedbackBottomSheet } from '../ConversationFeedbackBottomSheet';

jest.mock('@expo/vector-icons', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    Feather: ({ name, testID }: { name: string; testID?: string }) =>
      ReactLocal.createElement(RNLocal.Text, { testID }, name),
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
    }: {
      children: React.ReactNode;
      visible: boolean;
      title: string;
      subtitle?: string;
      testID: string;
    }) => {
      if (!visible) return null;
      return ReactLocal.createElement(
        RNLocal.View,
        { testID },
        ReactLocal.createElement(RNLocal.Text, { testID: `${testID}-title` }, title),
        subtitle
          ? ReactLocal.createElement(RNLocal.Text, { testID: `${testID}-subtitle` }, subtitle)
          : null,
        children,
      );
    },
  };
});

jest.mock('@rebel/cloud-client', () => {
  const actual = jest.requireActual('@rebel/cloud-client');
  return {
    ...actual,
    ipcCall: jest.fn(),
  };
});

const cloudClient = require('@rebel/cloud-client');

function renderSheet(overrides: Partial<React.ComponentProps<typeof ConversationFeedbackBottomSheet>> = {}) {
  const props: React.ComponentProps<typeof ConversationFeedbackBottomSheet> = {
    visible: true,
    onClose: jest.fn(),
    onSubmitted: jest.fn(),
    sessionId: 'session-1',
    rating: 3,
    anchorMessageId: 'assistant-msg-1',
    anchorTurnId: 'turn-1',
    anchorMessageIndex: 4,
    showToast: jest.fn(),
    ...overrides,
  };

  return {
    ...render(<ConversationFeedbackBottomSheet {...props} />),
    props,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  cloudClient.ipcCall.mockResolvedValue({ success: true, voteId: 'vote-1' });
});

describe('ConversationFeedbackBottomSheet', () => {
  it.each([
    [1, 'Tell us what went wrong', 'Got facts wrong', 'Saved me time'],
    [2, 'Tell us what went wrong', 'Got facts wrong', 'Saved me time'],
    [3, 'What would make it better?', 'Partly right', 'Got facts wrong'],
    [4, 'What made it work?', 'Saved me time', 'Partly right'],
    [5, 'What made it work?', 'Saved me time', 'Partly right'],
  ] as const)('renders bucket copy and chip taxonomy for rating %s', (rating, title, includedChip, excludedChip) => {
    const { getByText, queryByText } = renderSheet({ rating });

    expect(getByText(title)).toBeTruthy();
    expect(getByText(includedChip)).toBeTruthy();
    expect(queryByText(excludedChip)).toBeNull();
  });

  it('keeps Send rating disabled until comment has non-whitespace text', () => {
    const { getByTestId } = renderSheet({ rating: 4 });

    const sendButton = getByTestId('conversation-feedback-send-button');
    const commentInput = getByTestId('conversation-feedback-comment-input');

    expect(sendButton.props.accessibilityState.disabled).toBe(true);

    fireEvent.changeText(commentInput, '   ');
    expect(getByTestId('conversation-feedback-send-button').props.accessibilityState.disabled).toBe(true);

    fireEvent.changeText(commentInput, 'Strong summary and right sources');
    expect(getByTestId('conversation-feedback-send-button').props.accessibilityState.disabled).toBe(false);
  });

  it('does not call cloudClient.ipcCall when canceled with a draft comment', () => {
    const { getByTestId, props } = renderSheet({ rating: 4 });

    fireEvent.changeText(getByTestId('conversation-feedback-comment-input'), 'Typed but canceled');
    fireEvent.press(getByTestId('conversation-feedback-cancel-button'));

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(cloudClient.ipcCall).not.toHaveBeenCalled();
  });

  it('submits feedback with chips slugs and anchor payload fields', async () => {
    const { getByTestId } = renderSheet({
      rating: 2,
      anchorMessageId: 'msg-42',
      anchorTurnId: 'turn-42',
      anchorMessageIndex: 7,
    });

    fireEvent.press(getByTestId('conversation-feedback-chip-got-facts-wrong'));
    fireEvent.press(getByTestId('conversation-feedback-chip-made-things-up'));
    fireEvent.changeText(getByTestId('conversation-feedback-comment-input'), '  Missed the source and invented context.  ');
    fireEvent.press(getByTestId('conversation-feedback-send-button'));

    await waitFor(() => {
      expect(cloudClient.ipcCall).toHaveBeenCalledWith('feedback:conversation-rate', {
        sessionId: 'session-1',
        rating: 2,
        comment: 'Missed the source and invented context.',
        chips: ['got-facts-wrong', 'made-things-up'],
        anchorMessageId: 'msg-42',
        anchorTurnId: 'turn-42',
        anchorMessageIndex: 7,
        includeDiagnostics: false,
      });
    });
  });

  it.each([
    [1, true],
    [2, true],
    [3, false],
    [4, false],
    [5, false],
  ] as const)('shows diagnostics only for low ratings (%s)', (rating, shouldShow) => {
    const { queryByTestId } = renderSheet({ rating });

    if (shouldShow) {
      expect(queryByTestId('conversation-feedback-diagnostics-section')).toBeTruthy();
      return;
    }

    expect(queryByTestId('conversation-feedback-diagnostics-section')).toBeNull();
  });
});
