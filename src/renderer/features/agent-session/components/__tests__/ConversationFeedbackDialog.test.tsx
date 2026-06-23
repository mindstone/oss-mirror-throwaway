// @vitest-environment happy-dom

import React, { act } from 'react';
import { fireEvent } from '@testing-library/dom';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NEGATIVE_CHIPS,
  NEUTRAL_CHIPS,
  POSITIVE_CHIPS,
  slugifyChip,
} from '@shared/data/conversationFeedbackChips';
import { ConversationFeedbackDialog } from '../ConversationFeedbackDialog';

const feedbackSubmittedSpy = vi.hoisted(() => vi.fn());

vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    conversation: {
      feedbackSubmitted: feedbackSubmittedSpy,
    },
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function installApis(options: { voteCount?: number } = {}): {
  conversationRate: ReturnType<typeof vi.fn>;
  conversationGet: ReturnType<typeof vi.fn>;
  healthExportWithLogs: ReturnType<typeof vi.fn>;
} {
  const voteCount = options.voteCount ?? 0;
  const conversationRate = vi.fn(async () => ({ success: true, voteId: 'vote-new' }));
  const conversationGet = vi.fn(async () => ({
    votes: Array.from({ length: voteCount }, (_unused, index) => ({
      voteId: `vote-${index + 1}`,
      sessionId: 'session-1',
      rating: 3 as const,
      comment: 'Existing',
      chips: [],
      ratedAt: 1000 + index,
      includeDiagnostics: false,
    })),
    dismissedAt: null,
  }));
  const healthExportWithLogs = vi.fn(async () => ({
    content: '# diagnostics',
    filename: 'diagnostics.md',
  }));

  Object.defineProperty(window, 'feedbackApi', {
    configurable: true,
    value: {
      conversationRate,
      conversationGet,
      conversationDismiss: vi.fn(async () => ({ success: true })),
    },
  });
  Object.defineProperty(window, 'systemHealthApi', {
    configurable: true,
    value: {
      healthExportWithLogs,
    },
  });

  return {
    conversationRate,
    conversationGet,
    healthExportWithLogs,
  };
}

function renderDialog(
  props: Partial<React.ComponentProps<typeof ConversationFeedbackDialog>> = {},
): {
  container: HTMLElement;
  root: Root;
  onOpenChange: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onOpenChange = vi.fn();
  const showToast = vi.fn();

  act(() => {
    root.render(
      <ConversationFeedbackDialog
        open
        onOpenChange={onOpenChange}
        sessionId="session-1"
        draftRating={3}
        showToast={showToast}
        {...props}
      />,
    );
  });

  return {
    container,
    root,
    onOpenChange,
    showToast,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ConversationFeedbackDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it.each([
    [1, 'Tell us what went wrong', 'What needs fixing?', NEGATIVE_CHIPS[0], NEGATIVE_CHIPS[NEGATIVE_CHIPS.length - 1]],
    [2, 'Tell us what went wrong', 'What needs fixing?', NEGATIVE_CHIPS[0], NEGATIVE_CHIPS[NEGATIVE_CHIPS.length - 1]],
    [3, 'What would make it better?', 'What was missing?', NEUTRAL_CHIPS[0], NEUTRAL_CHIPS[NEUTRAL_CHIPS.length - 1]],
    [4, 'What made it work?', 'What should Rebel repeat?', POSITIVE_CHIPS[0], POSITIVE_CHIPS[POSITIVE_CHIPS.length - 1]],
    [5, 'What made it work?', 'What should Rebel repeat?', POSITIVE_CHIPS[0], POSITIVE_CHIPS[POSITIVE_CHIPS.length - 1]],
  ] as const)(
    'swaps copy and chip bucket for rating %i',
    (rating, title, textareaLabel, firstChip, lastChip) => {
      installApis();
      const rendered = renderDialog({ draftRating: rating });

      expect(document.body.textContent).toContain(title);
      expect(document.body.textContent).toContain(textareaLabel);
      expect(document.body.textContent).toContain(firstChip);
      expect(document.body.textContent).toContain(lastChip);

      rendered.unmount();
    },
  );

  it('keeps Send rating disabled until comment is non-whitespace', () => {
    installApis();
    const rendered = renderDialog({ draftRating: 4 });

    const textarea = document.body.querySelector<HTMLTextAreaElement>('#conversation-feedback-comment');
    const sendButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Send rating') as HTMLButtonElement | undefined;

    expect(sendButton?.disabled).toBe(true);

    act(() => {
      fireEvent.input(textarea as HTMLTextAreaElement, { target: { value: '   ' } });
    });
    expect(sendButton?.disabled).toBe(true);

    act(() => {
      fireEvent.input(textarea as HTMLTextAreaElement, { target: { value: 'One sentence.' } });
    });
    expect(sendButton?.disabled).toBe(false);

    rendered.unmount();
  });

  it('does not call conversationRate when canceled with a typed draft', () => {
    const { conversationRate } = installApis();
    const rendered = renderDialog({ draftRating: 2 });

    const textarea = document.body.querySelector<HTMLTextAreaElement>('#conversation-feedback-comment');
    act(() => {
      fireEvent.input(textarea as HTMLTextAreaElement, { target: { value: 'Needs work.' } });
    });

    const cancelButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Cancel');
    act(() => {
      fireEvent.click(cancelButton as HTMLButtonElement);
    });

    expect(conversationRate).not.toHaveBeenCalled();
    expect(rendered.onOpenChange).toHaveBeenCalledWith(false);

    rendered.unmount();
  });

  it('submits the expected IPC payload and tracks slugs with anchor fields', async () => {
    const { conversationRate, healthExportWithLogs } = installApis({ voteCount: 2 });
    const rendered = renderDialog({
      draftRating: 2,
      anchorMessageId: 'message-42',
      anchorTurnId: 'turn-42',
      anchorMessageIndex: 11,
      messageCountBucket: '6-15',
    });

    const chipA = NEGATIVE_CHIPS[0];
    const chipB = NEGATIVE_CHIPS[1];
    act(() => {
      fireEvent.click(Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === chipA) as HTMLButtonElement);
      fireEvent.click(Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === chipB) as HTMLButtonElement);
    });

    act(() => {
      fireEvent.click(Array.from(document.body.querySelectorAll('button'))
        .find((button) => button.textContent === 'Help us investigate') as HTMLButtonElement);
    });
    await flushPromises();

    const diagnosticsCheckbox = Array.from(document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .find((input) => input.nextElementSibling?.textContent?.includes('Include diagnostic logs'));
    act(() => {
      fireEvent.click(diagnosticsCheckbox as HTMLInputElement);
    });

    const textarea = document.body.querySelector<HTMLTextAreaElement>('#conversation-feedback-comment');
    act(() => {
      fireEvent.input(textarea as HTMLTextAreaElement, { target: { value: '  Needs clearer follow-through.  ' } });
    });

    const sendButton = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Send rating');
    act(() => {
      fireEvent.click(sendButton as HTMLButtonElement);
    });
    await flushPromises();

    expect(healthExportWithLogs).toHaveBeenCalledWith({ logWindowMinutes: 15 });
    expect(conversationRate).toHaveBeenCalledWith({
      sessionId: 'session-1',
      rating: 2,
      comment: 'Needs clearer follow-through.',
      chips: [chipA, chipB],
      anchorMessageId: 'message-42',
      anchorTurnId: 'turn-42',
      anchorMessageIndex: 11,
      includeDiagnostics: true,
      diagnosticsMarkdown: '# diagnostics',
    });

    expect(feedbackSubmittedSpy).toHaveBeenCalledWith('session-1', 2, {
      voteSequence: 3,
      sentiment: 'negative',
      chips: [slugifyChip(chipA), slugifyChip(chipB)],
      hasComment: true,
      includeDiagnostics: true,
      messageCountBucket: '6-15',
    });
    expect(rendered.showToast).toHaveBeenCalledWith({
      title: 'Rating sent',
      description: 'Thanks. This gives us something to work with.',
    });

    rendered.unmount();
  });

  it.each([
    [1, true],
    [2, true],
    [3, false],
    [4, false],
    [5, false],
  ] as const)('shows diagnostics disclosure only for rating %i', (rating, expectedVisible) => {
    installApis();
    const rendered = renderDialog({ draftRating: rating });

    const diagnosticsDisclosure = Array.from(document.body.querySelectorAll('button'))
      .find((button) => button.textContent === 'Help us investigate');
    expect(Boolean(diagnosticsDisclosure)).toBe(expectedVisible);

    rendered.unmount();
  });

  it('shows inline validation only after a failed submit attempt', async () => {
    installApis();
    const rendered = renderDialog({ draftRating: 3 });

    expect(document.body.textContent).not.toContain('Add a short note before sending.');

    const textarea = document.body.querySelector<HTMLTextAreaElement>('#conversation-feedback-comment');
    expect(textarea?.getAttribute('aria-invalid')).toBeNull();

    const form = document.body.querySelector('[data-testid="conversation-feedback-form"]');
    act(() => {
      fireEvent.submit(form as HTMLFormElement);
    });
    await flushPromises();

    const validationMessage = Array.from(document.body.querySelectorAll('[role="alert"]'))
      .find((node) => node.textContent?.includes('Add a short note before sending.'));
    expect(validationMessage).toBeTruthy();
    expect(validationMessage?.getAttribute('aria-live')).toBe('polite');

    act(() => {
      fireEvent.input(textarea as HTMLTextAreaElement, { target: { value: 'Specific miss: source handling.' } });
    });
    await flushPromises();
    expect(document.body.textContent).not.toContain('Add a short note before sending.');

    rendered.unmount();
  });
});
