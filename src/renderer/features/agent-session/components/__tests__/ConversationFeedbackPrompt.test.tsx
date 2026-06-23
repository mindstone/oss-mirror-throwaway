// @vitest-environment happy-dom

import React, { act } from 'react';
import { fireEvent } from '@testing-library/dom';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationVote } from '@shared/ipc/schemas';

const dialogPropsSpy = vi.hoisted(() => vi.fn());

vi.mock('../ConversationFeedbackDialog', () => ({
  ConversationFeedbackDialog: (props: {
    open: boolean;
    draftRating: number;
  }) => {
    dialogPropsSpy(props);
    if (!props.open) return null;
    return <div data-testid="conversation-feedback-dialog">Draft rating: {props.draftRating}</div>;
  },
}));

import { ConversationFeedbackPrompt } from '../ConversationFeedbackPrompt';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeVote(
  voteId: string,
  rating: 1 | 2 | 3 | 4 | 5,
  ratedAt: number,
): ConversationVote {
  return {
    voteId,
    sessionId: 'session-1',
    rating,
    comment: rating === 5 ? '(migrated from thumbs rating)' : 'Comment',
    chips: [],
    ratedAt,
    includeDiagnostics: false,
  };
}

function installFeedbackApi(options: { votes?: ConversationVote[]; rejectGet?: boolean; response?: unknown }): {
  conversationGet: ReturnType<typeof vi.fn>;
} {
  const conversationGet = vi.fn(async () => {
    if (options.rejectGet) {
      throw new Error('failed to load feedback');
    }
    if ('response' in options) {
      return options.response;
    }
    return {
      votes: options.votes ?? [],
      dismissedAt: null,
    };
  });

  Object.defineProperty(window, 'feedbackApi', {
    configurable: true,
    value: {
      conversationGet,
      conversationRate: vi.fn(async () => ({ success: true, voteId: 'vote-new' })),
      conversationDismiss: vi.fn(async () => ({ success: true })),
    },
  });

  return { conversationGet };
}

function renderPrompt(
  props: Partial<React.ComponentProps<typeof ConversationFeedbackPrompt>> = {},
): { container: HTMLElement; root: Root; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ConversationFeedbackPrompt
        sessionId="session-1"
        isBusy={false}
        messageCount={8}
        {...props}
      />,
    );
  });
  return {
    container,
    root,
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
    await Promise.resolve();
  });
}

function getStarButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
}

describe('ConversationFeedbackPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('renders the compact prompt and star row when it can render', async () => {
    installFeedbackApi({ votes: [] });
    const rendered = renderPrompt();
    await flushPromises();

    expect(rendered.container.textContent).toContain('How was this response?');
    expect(rendered.container.textContent).not.toContain('Bad');
    expect(rendered.container.textContent).not.toContain('Great');
    expect(rendered.container.querySelector('[role="radiogroup"]')).toBeTruthy();

    rendered.unmount();
  });

  it('supports hover preview on the star row', async () => {
    installFeedbackApi({ votes: [] });
    const rendered = renderPrompt();
    await flushPromises();
    const stars = getStarButtons(rendered.container);

    act(() => {
      fireEvent.mouseOver(stars[2]);
    });

    expect(stars[0].dataset.filled).toBe('true');
    expect(stars[1].dataset.filled).toBe('true');
    expect(stars[2].dataset.filled).toBe('true');
    expect(stars[3].dataset.filled).toBe('false');

    rendered.unmount();
  });

  it('opens the dialog with the selected draft rating when a star is clicked', async () => {
    installFeedbackApi({ votes: [] });
    const rendered = renderPrompt();
    await flushPromises();
    const stars = getStarButtons(rendered.container);

    act(() => {
      fireEvent.click(stars[3]);
    });
    await flushPromises();

    expect(dialogPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
      open: true,
      draftRating: 4,
    }));
    expect(document.body.textContent).toContain('Draft rating: 4');

    rendered.unmount();
  });

  it('shows the history pill only when votes.length >= 2 and caps tooltip history to five entries', async () => {
    installFeedbackApi({ votes: [makeVote('vote-1', 5, 10)] });
    const singleVoteRender = renderPrompt();
    await flushPromises();
    expect(singleVoteRender.container.querySelector('[data-testid="conversation-feedback-history-pill"]')).toBeNull();
    singleVoteRender.unmount();

    const votes: ConversationVote[] = [
      makeVote('vote-6', 5, 6000),
      makeVote('vote-5', 4, 5000),
      makeVote('vote-4', 3, 4000),
      makeVote('vote-3', 2, 3000),
      makeVote('vote-2', 1, 2000),
      makeVote('vote-1', 4, 1000),
    ];
    installFeedbackApi({ votes });
    const rendered = renderPrompt();
    await flushPromises();

    const historyPill = rendered.container.querySelector<HTMLButtonElement>('[data-testid="conversation-feedback-history-pill"]');
    expect(historyPill?.textContent).toContain('6×');

    await act(async () => {
      fireEvent.mouseEnter(historyPill as HTMLButtonElement);
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Rated 6 times');
    const historyItems = Array.from(document.body.querySelectorAll('[data-testid="conversation-feedback-history-item"]'));
    expect(historyItems).toHaveLength(5);
    expect(historyItems[0]?.textContent).toContain('5 stars');
    expect(historyItems[1]?.textContent).toContain('4 stars');
    expect(historyItems[2]?.textContent).toContain('3 stars');
    expect(historyItems[3]?.textContent).toContain('2 stars');
    expect(historyItems[4]?.textContent).toContain('1 star');
    expect(document.body.textContent).toContain('+1 older');

    rendered.unmount();
  });

  it('fails closed when loading feedback state errors', async () => {
    installFeedbackApi({ votes: [], rejectGet: true });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rendered = renderPrompt();
    await flushPromises();

    expect(rendered.container.querySelector('[role="radiogroup"]')).toBeNull();

    consoleErrorSpy.mockRestore();
    rendered.unmount();
  });

  it('fails closed when feedback state has the legacy thumbs response shape', async () => {
    installFeedbackApi({
      response: {
        rating: 'positive',
        ratedAt: 1234,
        dismissedAt: null,
      },
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rendered = renderPrompt();
    await flushPromises();

    expect(rendered.container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Invalid conversation feedback state:',
      expect.anything(),
    );

    consoleErrorSpy.mockRestore();
    rendered.unmount();
  });

  it('fails closed when feedback state is missing votes', async () => {
    installFeedbackApi({ response: undefined });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rendered = renderPrompt();
    await flushPromises();

    expect(rendered.container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Invalid conversation feedback state:',
      expect.anything(),
    );

    consoleErrorSpy.mockRestore();
    rendered.unmount();
  });

  it('fails closed when feedback state contains malformed vote entries', async () => {
    installFeedbackApi({
      response: {
        votes: [{ rating: 5 }],
        dismissedAt: null,
      },
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rendered = renderPrompt();
    await flushPromises();

    expect(rendered.container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Invalid conversation feedback state:',
      expect.anything(),
    );

    consoleErrorSpy.mockRestore();
    rendered.unmount();
  });

  it('renders a migrated v1 thumbs-up vote as filled stars on first render', async () => {
    installFeedbackApi({ votes: [makeVote('legacy-session-1-1111', 5, 1111)] });
    const rendered = renderPrompt();
    await flushPromises();
    const stars = getStarButtons(rendered.container);

    expect(stars).toHaveLength(5);
    expect(stars.every((star) => star.dataset.filled === 'true')).toBe(true);

    rendered.unmount();
  });
});
