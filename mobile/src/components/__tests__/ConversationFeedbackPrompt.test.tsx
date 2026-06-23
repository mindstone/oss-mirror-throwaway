import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { ConversationFeedbackPrompt } from '../ConversationFeedbackPrompt';

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

jest.mock('../ConversationFeedbackBottomSheet', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    ConversationFeedbackBottomSheet: ({
      visible,
      rating,
    }: {
      visible: boolean;
      rating: number;
    }) => ReactLocal.createElement(
      RNLocal.View,
      { testID: 'mock-feedback-bottom-sheet' },
      ReactLocal.createElement(
        RNLocal.Text,
        { testID: 'mock-feedback-bottom-sheet-state' },
        visible ? `open-${rating}` : 'closed',
      ),
    ),
  };
});

jest.mock('@rebel/cloud-client', () => {
  const actual = jest.requireActual('@rebel/cloud-client');
  return {
    ...actual,
    ipcCall: jest.fn(),
    formatRelativeTime: jest.fn((value: number) => `time-${value}`),
  };
});

const cloudClient = require('@rebel/cloud-client');

function buildVote(overrides: Record<string, unknown> = {}) {
  return {
    voteId: 'vote-1',
    sessionId: 'session-1',
    rating: 4,
    comment: 'solid response',
    chips: [],
    ratedAt: 1_700_000_000_000,
    includeDiagnostics: false,
    ...overrides,
  };
}

function renderPrompt(overrides: Partial<React.ComponentProps<typeof ConversationFeedbackPrompt>> = {}) {
  const props: React.ComponentProps<typeof ConversationFeedbackPrompt> = {
    sessionId: 'session-1',
    lastAssistantMessageId: 'assistant-message-1',
    lastAssistantTurnId: 'turn-1',
    lastAssistantMessageIndex: 4,
    isSending: false,
    ...overrides,
  };

  return {
    ...render(<ConversationFeedbackPrompt {...props} />),
    props,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  cloudClient.ipcCall.mockResolvedValue({ votes: [], dismissedAt: null });
});

describe('ConversationFeedbackPrompt', () => {
  it('fetches votes on mount via feedback:conversation-get', async () => {
    renderPrompt();

    await waitFor(() => {
      expect(cloudClient.ipcCall).toHaveBeenCalledWith('feedback:conversation-get', {
        sessionId: 'session-1',
      });
    });
  });

  it('renders the history pill at two or more votes', async () => {
    cloudClient.ipcCall.mockResolvedValueOnce({
      votes: [
        buildVote({ voteId: 'vote-1', rating: 5 }),
        buildVote({ voteId: 'vote-2', rating: 4 }),
      ],
      dismissedAt: null,
    });

    const { getByTestId } = renderPrompt();

    await waitFor(() => {
      expect(getByTestId('conversation-feedback-history-pill')).toBeTruthy();
    });
  });

  it('opens the feedback bottom sheet with the selected draft rating', async () => {
    const { getByTestId } = renderPrompt();

    await waitFor(() => {
      expect(getByTestId('conversation-feedback-prompt-stars-star-4')).toBeTruthy();
    });

    fireEvent.press(getByTestId('conversation-feedback-prompt-stars-star-4'));

    await waitFor(() => {
      expect(getByTestId('mock-feedback-bottom-sheet-state').props.children).toBe('open-4');
    });
  });

  it('reflects migrated five-star votes as a filled five-star selection', async () => {
    cloudClient.ipcCall.mockResolvedValueOnce({
      votes: [
        buildVote({ voteId: 'legacy-vote', rating: 5 }),
      ],
      dismissedAt: null,
    });

    const { getByTestId } = renderPrompt();

    await waitFor(() => {
      expect(getByTestId('conversation-feedback-prompt-stars-star-5').props.accessibilityState.checked).toBe(true);
    });

    const firstStarColor = getByTestId('conversation-feedback-prompt-stars-icon-1').props.color;
    const fifthStarColor = getByTestId('conversation-feedback-prompt-stars-icon-5').props.color;
    expect(firstStarColor).toBe(fifthStarColor);
  });
});
