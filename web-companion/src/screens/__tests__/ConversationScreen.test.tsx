// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';

/**
 * RTL harness for `ConversationScreen`. Scope (OW-5): wiring-level tests that
 * exercise the integration between routing, stores/hooks, the markdown
 * renderer, and the anchor click dispatcher. Decision-logic coverage lives
 * in `conversationRouteSync.test.ts` (pure, faster).
 *
 * Design choices (per plan AMD-6 / AMD-7):
 *   - Do NOT mock `SafeWebMarkdown` — we test the full urlTransform +
 *     preserveSchemes + onAnchorClick + handleLinkClick +
 *     createMarkdownLinkHandler chain. (Updated R1 Stage 2b 2026-04-27:
 *     `components.a` override replaced by typed `onAnchorClick` prop.)
 *   - `createMarkdownLinkHandler` stays real (it's a pure helper).
 *   - Only stores/hooks/API functions are mocked.
 *   - jsdom is scoped to this file only via the environment directive above;
 *     the default `node` env remains for cheap pure-TS suites.
 */

// --- Mocks -----------------------------------------------------------------

const mockStartTurn = vi.fn();
const mockHandleStop = vi.fn();
const mockCloseSocket = vi.fn();
const mockFetchSession = vi.fn(async () => undefined);
const mockClearCurrentSession = vi.fn();
const mockToggleRecording = vi.fn();

interface MockSessionState {
  currentSession: unknown;
  isLoadingSession: boolean;
  error: string | null;
  completedStepsByTurnId: Record<string, unknown[]>;
  fetchSession: typeof mockFetchSession;
  clearCurrentSession: typeof mockClearCurrentSession;
}

const sessionState: MockSessionState = {
  currentSession: null,
  isLoadingSession: false,
  error: null,
  completedStepsByTurnId: {},
  fetchSession: mockFetchSession,
  clearCurrentSession: mockClearCurrentSession,
};

interface MockAuthState {
  cloudUrl: string | null;
}

const authState: MockAuthState = { cloudUrl: null };

vi.mock('@rebel/cloud-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rebel/cloud-client')>();
  return {
    ...actual,
    useAuthStore: Object.assign(
      <T,>(selector: (s: MockAuthState) => T) => selector(authState),
      { getState: () => authState },
    ),
    useSessionStore: Object.assign(
      <T,>(selector: (s: MockSessionState) => T) => selector(sessionState),
      { getState: () => sessionState },
    ),
    useAgentTurn: () => ({
      isSending: false,
      streamingText: '',
      statusText: null,
      activeTurnId: null,
      optimisticMessages: [],
      completedSteps: [],
      missionContext: null,
      taskProgress: [],
      subAgentItems: [],
      thinkingHeadline: '',
      error: null,
      hasMissionSet: false,
      touchedTaskIds: [],
      userQuestionEventsByTurn: {},
      startTurn: mockStartTurn,
      handleStop: mockHandleStop,
      closeSocket: mockCloseSocket,
      clearError: vi.fn(),
    }),
    useWebVoiceRecording: () => ({
      isRecording: false,
      isTranscribing: false,
      audioLevel: 0,
      error: null,
      toggleRecording: mockToggleRecording,
    }),
    useWebFileAttachments: () => ({
      attachments: [],
      addFiles: vi.fn(),
      removeAttachment: vi.fn(),
      clearAttachments: vi.fn(),
      canAddMore: true,
      isDragging: false,
      dragHandlers: {
        onDragEnter: vi.fn(),
        onDragLeave: vi.fn(),
        onDragOver: vi.fn(),
        onDrop: vi.fn(),
      },
    }),
    getSettings: vi.fn(async () => ({})),
    createShareLink: vi.fn(async () => ({ shareId: 'share-id' })),
    getShareStatus: vi.fn(async () => null),
    revokeShareLink: vi.fn(async () => undefined),
    isCouncilReviewAvailable: () => false,
  };
});

import { renderConversationScreen } from '../../test-utils/renderConversationScreen';

// --- Lifecycle helpers ------------------------------------------------------

function resetMocks(): void {
  mockStartTurn.mockClear();
  mockHandleStop.mockClear();
  mockCloseSocket.mockClear();
  mockFetchSession.mockClear();
  mockClearCurrentSession.mockClear();
  mockToggleRecording.mockClear();
  sessionState.currentSession = null;
  sessionState.isLoadingSession = false;
  sessionState.error = null;
  sessionState.completedStepsByTurnId = {};
  authState.cloudUrl = null;
}

beforeEach(() => {
  resetMocks();
});

afterEach(() => {
  cleanup();
});

// --- Tests ------------------------------------------------------------------

describe('ConversationScreen (RTL harness)', () => {
  // T-CS.1 — initialPrompt fires startTurn exactly once per id
  it('fires startTurn once when mounted with ?initialPrompt= on a fresh id', async () => {
    renderConversationScreen('/conversations/conv-1?initialPrompt=hello');

    await waitFor(() => {
      expect(mockStartTurn).toHaveBeenCalledTimes(1);
    });
    expect(mockStartTurn).toHaveBeenCalledWith('conv-1', 'hello');
  });

  // T-CS.2 — navigating from one ?initialPrompt= URL to another fires
  // startTurn for the SECOND conversation (regression guard for the
  // `initialSentForIdRef` fix in AMD-8 of the prior plan).
  // Uses same-router navigation (`navigateTo`) so the ConversationScreen
  // stays mounted through the id change — otherwise we'd be testing the
  // remount path, not the id-swap effect path.
  it('fires startTurn for a second conversation when navigating between two ?initialPrompt= URLs', async () => {
    const result = renderConversationScreen('/conversations/conv-a?initialPrompt=first');

    await waitFor(() => {
      expect(mockStartTurn).toHaveBeenCalledTimes(1);
    });
    expect(mockStartTurn).toHaveBeenNthCalledWith(1, 'conv-a', 'first');

    act(() => {
      result.navigateTo('/conversations/conv-b?initialPrompt=second');
    });

    await waitFor(() => {
      expect(mockStartTurn).toHaveBeenCalledTimes(2);
    });
    expect(mockStartTurn).toHaveBeenNthCalledWith(2, 'conv-b', 'second');
  });

  // T-CS.2a — navigating with same id but changed query (e.g. ?compose=text)
  // documents current behavior: the id-keyed effect does NOT rerun, so
  // startTurn stays at its prior call count. If this changes in the future,
  // the test must change too.
  it('documents that same-id query-only changes do NOT rerun the route-sync effect', async () => {
    const result = renderConversationScreen('/conversations/conv-c?initialPrompt=first');

    await waitFor(() => expect(mockStartTurn).toHaveBeenCalledTimes(1));
    mockStartTurn.mockClear();

    act(() => {
      result.navigateTo('/conversations/conv-c?compose=text');
    });

    // The effect is keyed to [id]; since id is unchanged across this navigation,
    // neither startTurn nor fetchSession fires again. This documents the gap;
    // if product requires query-driven reactivity, key the effect differently.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  // T-CS.3 — clicking an anchor with href="rebel://conversation/abc" routes
  // via the real createMarkdownLinkHandler + navigate + MemoryRouter.
  // Uses REAL SafeWebMarkdown (no mock) per AMD-6.
  it('routes rebel://conversation/abc anchor clicks to /conversations/abc', async () => {
    // Seed the session with an assistant message containing a rebel:// link.
    sessionState.currentSession = {
      id: 'conv-1',
      title: 'Test',
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          text: 'See [that other conversation](rebel://conversation/abc).',
        },
      ],
    } as unknown;

    const result = renderConversationScreen('/conversations/conv-1');

    // Wait for the assistant bubble to mount with the real markdown content.
    const anchor = await waitFor(() => {
      const el = result.container.querySelector('a[href^="rebel://conversation/"]');
      if (!el) throw new Error('rebel://conversation anchor not yet in DOM');
      return el as HTMLAnchorElement;
    });

    expect(anchor.getAttribute('href')).toBe('rebel://conversation/abc');

    fireEvent.click(anchor);

    await waitFor(() => {
      expect(result.getCurrentPath()).toBe('/conversations/abc');
    });
  });

  // T-CS.4 — unmounting the screen calls BOTH clearCurrentSession AND
  // closeSocket (per the `cleanupConversationForRoute` effect event).
  it('calls clearCurrentSession and closeSocket on unmount', async () => {
    const { unmount } = renderConversationScreen('/conversations/conv-unmount');

    await waitFor(() => {
      expect(mockFetchSession).toHaveBeenCalled();
    });

    mockClearCurrentSession.mockClear();
    mockCloseSocket.mockClear();

    unmount();

    expect(mockClearCurrentSession).toHaveBeenCalledTimes(1);
    expect(mockCloseSocket).toHaveBeenCalledTimes(1);
  });

  // T-CS.5 — ?compose=text puts the screen in text-input mode on mount.
  // Asserts textarea receives focus. Per Behavioral Safety lens review, we
  // deliberately do NOT assert mic-button visibility here — current UI keeps
  // a fallback mic even in text mode; adding such an assertion would either
  // force a product change or produce false negatives.
  it('focuses the textarea when mounted with ?compose=text', async () => {
    const result = renderConversationScreen('/conversations/conv-1?compose=text');

    await waitFor(() => {
      const textarea = result.container.querySelector('textarea');
      if (!textarea) throw new Error('textarea not yet rendered');
      expect(document.activeElement).toBe(textarea);
    });
  });
});
