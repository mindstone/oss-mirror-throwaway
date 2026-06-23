import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockLogger,
  mockTracker,
  mockHumanizeAgentError,
  mockClassifyErrorUx,
  mockCheckpointTerminal,
  getTurnCheckpointManagerMock,
  mockGetSession,
  mockUpdateSession,
  mockProcessAutoTitle,
  mockIsDefaultOrFallbackTitle,
  mockGetSettings,
  mockMaybeGenerateActivitySummaryForTurn,
} = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  mockTracker: {
    track: vi.fn(),
    identify: vi.fn(),
    getAnonymousId: vi.fn(() => 'anon-test-id'),
    isAvailable: vi.fn(() => true),
  },
  mockHumanizeAgentError: vi.fn(),
  mockClassifyErrorUx: vi.fn(),
  mockCheckpointTerminal: vi.fn(),
  getTurnCheckpointManagerMock: vi.fn(),
  mockGetSession: vi.fn(),
  mockUpdateSession: vi.fn(),
  mockProcessAutoTitle: vi.fn(),
  mockIsDefaultOrFallbackTitle: vi.fn(),
  mockGetSettings: vi.fn(),
  mockMaybeGenerateActivitySummaryForTurn: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLogger,
}));

vi.mock('@core/tracking', () => ({
  getTracker: () => mockTracker,
}));

vi.mock('@core/services/turnCheckpointService', () => ({
  getTurnCheckpointManager: getTurnCheckpointManagerMock,
}));

vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    getSession: mockGetSession,
    updateSession: mockUpdateSession,
  }),
}));

vi.mock('../conversationTitleService', () => ({
  processAutoTitle: mockProcessAutoTitle,
  isDefaultOrFallbackTitle: mockIsDefaultOrFallbackTitle,
}));

vi.mock('../settingsStore', () => ({
  getSettings: mockGetSettings,
}));

// Stub the activity-summary generator (260618 show-more-activity). The
// dispatcher dynamically imports this module on the `result` event; mocking it
// keeps the test off the real BTS/model path and lets us assert the
// `session:activity-summary-generated` broadcast fires only on a fresh sentence.
vi.mock('../activitySummaryService', () => ({
  maybeGenerateActivitySummaryForTurn: mockMaybeGenerateActivitySummaryForTurn,
}));

// Mock the humanizer sub-module so specific tests can force `humanizeAgentError`
// to throw (verifying the dispatcher's belt-and-braces catch). The default
// implementation delegates to the real function, so non-override tests behave
// as if the mock is absent. The barrel `@rebel/shared` re-exports from this
// sub-module, so the dispatcher's `import ... from '@rebel/shared'` resolves
// through Vitest's module registry to the mock.

vi.mock('@rebel/shared/utils/humanizeAgentError', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@rebel/shared/utils/humanizeAgentError')>();
  mockHumanizeAgentError.mockImplementation(actual.humanizeAgentError);
  return {
    ...actual,
    humanizeAgentError: mockHumanizeAgentError,
  };
});

// Mock the classifyErrorUx sub-module so specific tests can force the
// classifier to throw (verifying the dispatcher's belt-and-braces catch around
// resolution attachment). The default implementation delegates to the real
// function, so non-override tests behave as if the mock is absent.

vi.mock('@rebel/shared/utils/classifyErrorUx', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@rebel/shared/utils/classifyErrorUx')>();
  mockClassifyErrorUx.mockImplementation(actual.classifyErrorUx);
  return {
    ...actual,
    classifyErrorUx: mockClassifyErrorUx,
  };
});

import { classifyError, ModelError } from '@core/rebelCore/modelErrors';
import {
  ConnectionNotConfiguredError,
  UnsupportedModelError,
} from '@shared/utils/connectionCredentials';
import type { AgentErrorResolution } from '@rebel/shared/utils/classifyErrorUx';
import type { AgentEvent } from '@shared/types';
import {
  dispatchAgentEvent,
  dispatchAgentErrorEvent,
  clearAnswerPhaseStartedSentinel,
  KNOWN_NO_RENDERER_SUBSCRIBER,
  RENDERER_ONLY_LIFECYCLE_EVENTS,
  __peekAnswerPhaseStartedSentinelForTests,
  __resetHumanizerObserverWiredFlagForTests,
  __enforceErrorKindWireContractForTests,
  wireHumanizerFailureObserver,
} from '../agentEventDispatcher';
import { agentTurnRegistry } from '../agentTurnRegistry';
import { resetSessionSeqIndexForTests } from '../sessionSeqIndex';
import { InvariantViolationError } from '@shared/utils/invariant';
import { HUMANIZER_SAFE_FALLBACK } from '@rebel/shared';
import {
  __clearHumanizerFailureObserverForTests,
  setHumanizerFailureObserver,
} from '@rebel/shared/utils/humanizeAgentError';

const trackedTurnIds = new Set<string>();
let turnCounter = 0;

function nextTurnId(): string {
  turnCounter += 1;
  const turnId = `agent-error-dispatch-${turnCounter}`;
  trackedTurnIds.add(turnId);
  return turnId;
}

function createWindow(options?: { throwOnSend?: boolean }) {
  const send = vi.fn((_channel: string, _payload: unknown) => {
    if (options?.throwOnSend) {
      throw new Error('send failed');
    }
  });

  return {
    send,
    win: {
      id: 1,
      isDestroyed: () => false,
      webContents: { send },
    },
  };
}

const timeoutDiagnostic = {
  kind: 'transient_stall' as const,
  indicator: 'No new events for 30s',
  description: 'The model appears stalled.',
};

const watchdogDiagnostic = {
  phase: 'awaiting_tool_result',
  messageCount: 7,
  rawStreamEventCount: 12,
  rawStreamLastEventType: 'content_block_delta',
  rawStreamLastEventAgeMs: 15_000,
  watchdogLevel: 2,
  maxWatchdogLevel: 3,
  effectiveAbortMs: 90_000,
  model: 'claude-sonnet-4-5',
};

const rateLimitMetaOverride = {
  rawError: '429 Too Many Requests',
  retryAfterMs: 45_000,
  resetAtMs: 1_762_000_000_000,
};

beforeEach(async () => {
  vi.clearAllMocks();
  getTurnCheckpointManagerMock.mockReturnValue(null);
  resetSessionSeqIndexForTests();
  vi.stubEnv('REBEL_E2E_TEST_MODE', '0');
  // Default: no summary generated (gated out / failed). Individual tests
  // override to assert the broadcast fires on a fresh sentence.
  mockMaybeGenerateActivitySummaryForTurn.mockResolvedValue(null);
  // Re-install the default humanizer implementation after clearAllMocks wipes
  // history + one-shot overrides. Using vi.importActual avoids the mock we
  // installed above for `@rebel/shared/utils/humanizeAgentError`.
  const actual = await vi.importActual<typeof import('@rebel/shared/utils/humanizeAgentError')>(
    '@rebel/shared/utils/humanizeAgentError',
  );
  mockHumanizeAgentError.mockImplementation(actual.humanizeAgentError);
  // Re-install the default classifyErrorUx implementation for the same reason.
  const classifyActual = await vi.importActual<
    typeof import('@rebel/shared/utils/classifyErrorUx')
  >('@rebel/shared/utils/classifyErrorUx');
  mockClassifyErrorUx.mockImplementation(classifyActual.classifyErrorUx);
});

afterEach(() => {
  for (const turnId of trackedTurnIds) {
    agentTurnRegistry.clearActionableErrorDispatched(turnId);
    agentTurnRegistry.cleanupTurn(turnId);
  }
  trackedTurnIds.clear();
  resetSessionSeqIndexForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('dispatchAgentEvent auto-title trigger', () => {
  it('passes a getCurrentSession callback to processAutoTitle so the retry path can re-read state (wiring contract)', async () => {
    const turnId = nextTurnId();
    const sessionId = 'session-wiring-contract';
    const { win } = createWindow();

    agentTurnRegistry.setRendererSession(turnId, sessionId);
    mockGetSession.mockResolvedValue({
      id: sessionId,
      title: 'New conversation',
      messages: [{ id: 'm1', turnId, role: 'user' as const, text: 'hi', createdAt: 1 }],
      eventsByTurn: {},
    });
    mockProcessAutoTitle.mockResolvedValue(null);

    dispatchAgentEvent(win as any, turnId, {
      type: 'result',
      text: 'ok',
      timestamp: 1,
    });

    await vi.waitFor(() => {
      expect(mockProcessAutoTitle).toHaveBeenCalledOnce();
    });

    const optionsArg = mockProcessAutoTitle.mock.calls[0]?.[1] as {
      getSettings: unknown;
      getCurrentSession?: unknown;
    };
    expect(typeof optionsArg.getSettings).toBe('function');
    expect(typeof optionsArg.getCurrentSession).toBe('function');
  });

  it('injects the captured turn prompt when persisted and accumulated messages lack a user message', async () => {
    const turnId = nextTurnId();
    const sessionId = 'session-auto-title-race';
    const { win } = createWindow();

    agentTurnRegistry.setRendererSession(turnId, sessionId);
    agentTurnRegistry.setTurnPrompt(
      turnId,
      '<meeting-context>notes</meeting-context>\n<user-request>\nDraft a board update\n</user-request>',
    );
    mockGetSession.mockResolvedValue({
      id: sessionId,
      title: 'New Agent Run',
      messages: [],
      eventsByTurn: {},
    });
    mockProcessAutoTitle.mockResolvedValue(null);

    dispatchAgentEvent(win as any, turnId, {
      type: 'result',
      text: 'Here is the draft.',
      timestamp: 123,
    });

    await vi.waitFor(() => {
      expect(mockProcessAutoTitle).toHaveBeenCalledOnce();
    });

    const sessionForTitle = mockProcessAutoTitle.mock.calls[0]?.[0] as {
      messages: Array<Record<string, unknown>>;
    };
    expect(sessionForTitle.messages.at(0)).toMatchObject({
      id: `auto-title-user-${turnId}`,
      turnId,
      role: 'user',
      text: 'Draft a board update',
    });
  });

  it('generates + persists a title for a HEADLESS (win === null) content-titled run, without a renderer notify', async () => {
    const turnId = nextTurnId();
    // A plain id classifies as 'conversation' → persistable, no fixed title → content-titled.
    const sessionId = `chat-${turnId}`;

    agentTurnRegistry.setRendererSession(turnId, sessionId);
    agentTurnRegistry.setTurnPrompt(turnId, 'Summarize my week');
    mockGetSession.mockResolvedValue({
      id: sessionId,
      title: 'New Agent Run',
      messages: [{ id: 'r1', turnId, role: 'result' as const, text: 'Here is your week', createdAt: 1 }],
      eventsByTurn: {},
    });
    mockIsDefaultOrFallbackTitle.mockReturnValue(true);
    mockProcessAutoTitle.mockResolvedValue({ title: 'Weekly Summary', reason: 'initial', turnCount: 1 });
    mockUpdateSession.mockImplementation(
      async (_id: string, fn: (current: unknown) => unknown) =>
        fn({ title: 'New Agent Run', messages: [], updatedAt: 1 }),
    );

    // win === null → headless. Must NOT throw on the absent webContents.send.
    dispatchAgentEvent(null, turnId, {
      type: 'result',
      text: 'Here is your week',
      timestamp: 42,
    });

    await vi.waitFor(() => {
      expect(mockProcessAutoTitle).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      expect(mockUpdateSession).toHaveBeenCalledOnce();
    });
    expect(mockProcessAutoTitle.mock.calls[0]?.[0]).toMatchObject({ id: sessionId });
  });

  it('does NOT auto-title a fixed-title kind (use-case-discovery) even though it persists', async () => {
    const turnId = nextTurnId();
    // use-case-discovery persists (not a skip kind) but carries a fixed title, so
    // it must never be Haiku-titled — independent of checkpoint timing. This is
    // the guard that keeps the model off the user's private synthesized content.
    const sessionId = `use-case-discovery-${turnId}`;

    agentTurnRegistry.setRendererSession(turnId, sessionId);
    agentTurnRegistry.setTurnPrompt(turnId, 'Find my best Rebel use cases');
    mockProcessAutoTitle.mockResolvedValue(null);

    dispatchAgentEvent(null, turnId, {
      type: 'result',
      text: 'Here are 3 use cases (synthesized from private data)',
      timestamp: 11,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockProcessAutoTitle).not.toHaveBeenCalled();
    expect(mockUpdateSession).not.toHaveBeenCalled();
  });

  it('does NOT auto-title a HEADLESS run for a skip-checkpointing kind (e.g. memory-update)', async () => {
    const turnId = nextTurnId();
    // memory-update IS in SKIP_CHECKPOINTING_KINDS → not persisted → not titled.
    const sessionId = `memory-update-${turnId}`;

    agentTurnRegistry.setRendererSession(turnId, sessionId);
    agentTurnRegistry.setTurnPrompt(turnId, 'update memory');
    mockProcessAutoTitle.mockResolvedValue(null);

    dispatchAgentEvent(null, turnId, {
      type: 'result',
      text: 'memory updated',
      timestamp: 7,
    });

    // The skip-kind gate is SYNCHRONOUS — the async title closure must never be
    // scheduled at all. Flush a real macrotask so any (incorrectly-scheduled)
    // dynamic-import chain would have had time to reach its first await, then
    // assert silence at the closure's entry point (`getSession`) as well as the
    // LLM/persist calls. Asserting on `getSession` guards against a regression
    // that moved the gate *inside* the closure (where microtask drains wouldn't
    // catch it because `await import(...)` takes more than a couple of ticks).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockProcessAutoTitle).not.toHaveBeenCalled();
    expect(mockUpdateSession).not.toHaveBeenCalled();
  });

  it('sends the session:title-generated IPC when a live window IS present', async () => {
    const turnId = nextTurnId();
    const sessionId = `chat-${turnId}`;
    const { win, send } = createWindow();

    agentTurnRegistry.setRendererSession(turnId, sessionId);
    agentTurnRegistry.setTurnPrompt(turnId, 'Summarize my week');
    mockGetSession.mockResolvedValue({
      id: sessionId,
      title: 'New Agent Run',
      messages: [{ id: 'r1', turnId, role: 'result' as const, text: 'ok', createdAt: 1 }],
      eventsByTurn: {},
    });
    mockIsDefaultOrFallbackTitle.mockReturnValue(true);
    mockProcessAutoTitle.mockResolvedValue({ title: 'Weekly Summary', reason: 'initial', turnCount: 1 });
    mockUpdateSession.mockImplementation(
      async (_id: string, fn: (current: unknown) => unknown) =>
        fn({ title: 'New Agent Run', messages: [], updatedAt: 1 }),
    );

    dispatchAgentEvent(win as any, turnId, {
      type: 'result',
      text: 'ok',
      timestamp: 9,
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        'session:title-generated',
        expect.objectContaining({ sessionId, title: 'Weekly Summary' }),
      );
    });
  });
});

describe('activity summary live swap-in broadcast (260618 show-more-activity)', () => {
  it('emits session:activity-summary-generated when a fresh summary is persisted', async () => {
    const turnId = nextTurnId();
    const sessionId = `chat-${turnId}`;
    const { win, send } = createWindow();

    agentTurnRegistry.setRendererSession(turnId, sessionId);
    agentTurnRegistry.setTurnPrompt(turnId, 'Pull my Q3 numbers');
    // Title path is a no-op (already titled) so it can't pollute the assertion.
    mockGetSession.mockResolvedValue({ id: sessionId, title: 'Existing title', messages: [], eventsByTurn: {} });
    mockIsDefaultOrFallbackTitle.mockReturnValue(false);
    mockProcessAutoTitle.mockResolvedValue(null);
    // Fresh, persisted sentence → broadcast expected.
    mockMaybeGenerateActivitySummaryForTurn.mockResolvedValue(
      'Pulled your Q3 numbers from Slack and drafted the update.',
    );

    // The broadcast is gated on the mock's return value (a fresh persisted
    // sentence), NOT on `toolMetrics` (the real gating lives inside the mocked
    // `maybeGenerateActivitySummaryForTurn`), so a minimal `result` event is
    // sufficient here — mirrors the auto-title test above.
    dispatchAgentEvent(win as any, turnId, {
      type: 'result',
      text: 'ok',
      timestamp: 9,
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        'session:activity-summary-generated',
        expect.objectContaining({
          sessionId,
          turnId,
          summary: 'Pulled your Q3 numbers from Slack and drafted the update.',
        }),
      );
    });
  });

  it('does NOT broadcast when no fresh summary is produced (gated out / failed / idempotency skip)', async () => {
    const turnId = nextTurnId();
    const sessionId = `chat-${turnId}`;
    const { win, send } = createWindow();

    agentTurnRegistry.setRendererSession(turnId, sessionId);
    agentTurnRegistry.setTurnPrompt(turnId, 'A quick question');
    mockGetSession.mockResolvedValue({ id: sessionId, title: 'Existing title', messages: [], eventsByTurn: {} });
    mockIsDefaultOrFallbackTitle.mockReturnValue(false);
    mockProcessAutoTitle.mockResolvedValue(null);
    mockMaybeGenerateActivitySummaryForTurn.mockResolvedValue(null);

    dispatchAgentEvent(win as any, turnId, {
      type: 'result',
      text: 'ok',
      timestamp: 9,
    });

    // Give the fire-and-forget generation a real macrotask to settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).not.toHaveBeenCalledWith(
      'session:activity-summary-generated',
      expect.anything(),
    );
  });
});

describe('dispatchAgentEvent progress tracking', () => {
  it('marks per-turn progress for assistant/tool-result style events', () => {
    const turnId = nextTurnId();
    const { win } = createWindow();
    const progressSpy = vi.spyOn(agentTurnRegistry, 'markTurnProgress');

    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant_delta',
      text: 'streaming chunk',
      timestamp: 100,
    });
    dispatchAgentEvent(win as any, turnId, {
      type: 'result',
      text: 'done',
      timestamp: 200,
    });

    expect(progressSpy).toHaveBeenCalledTimes(2);
    expect(progressSpy).toHaveBeenNthCalledWith(1, turnId);
    expect(progressSpy).toHaveBeenNthCalledWith(2, turnId);
    expect(agentTurnRegistry.getLastProgressAt(turnId)).toBeTypeOf('number');
  });

  it('does not treat status-only events as progress signals', () => {
    const turnId = nextTurnId();
    const { win } = createWindow();
    const progressSpy = vi.spyOn(agentTurnRegistry, 'markTurnProgress');

    dispatchAgentEvent(win as any, turnId, {
      type: 'status',
      message: 'still waiting',
      timestamp: 300,
    });

    expect(progressSpy).not.toHaveBeenCalled();
    expect(agentTurnRegistry.getLastProgressAt(turnId)).toBeNull();
  });
});

describe('dispatchAgentErrorEvent', () => {
  it('dispatches a billing event for ModelError and marks it actionable by default', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    const markActionableSpy = vi.spyOn(agentTurnRegistry, 'markActionableErrorDispatched');

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new ModelError(
        'billing',
        'This request requires more credits, or fewer max_tokens.',
        402,
        'OpenRouter',
      ),
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'billing' });
    expect(markActionableSpy).toHaveBeenCalledOnce();
    expect(agentTurnRegistry.hasActionableErrorDispatched(turnId)).toBe(true);

    const dispatchedEvent = send.mock.calls[0]?.[1] as { event: Record<string, unknown> };
    const { timestamp, resolution, ...eventWithoutTimestamp } = dispatchedEvent.event;
    expect(typeof timestamp).toBe('number');
    expect(resolution).toMatchObject({
      category: 'user-fixable',
      kind: 'billing',
      alternatives: [
        expect.objectContaining({ action: 'open-settings' }),
      ],
    });
    expect(eventWithoutTimestamp).toMatchInlineSnapshot(`
      {
        "billingMeta": {
          "rawError": "This request requires more credits, or fewer max_tokens.",
          "subtype": "credits",
        },
        "error": "Your OpenRouter account has run out of credits. You can set up auto top-up in your OpenRouter settings to avoid this.",
        "errorKind": "billing",
        "errorSource": "main",
        "headlineClass": "billing_quota",
        "provider": "OpenRouter",
        "rawError": "This request requires more credits, or fewer max_tokens.",
        "seq": 1,
        "type": "error",
      }
    `);
  });

  it('classifies plain credit-balance errors as billing', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new Error('Your credit balance is too low to complete this request'),
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'billing' });
    const dispatchedEvent = send.mock.calls[0]?.[1] as { event: { errorKind?: string } };
    expect(dispatchedEvent.event.errorKind).toBe('billing');
  });

  it('preserves upstream provider in billingMeta when ModelError carries it', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    dispatchAgentErrorEvent(
      win as any,
      turnId,
      new ModelError(
        'billing',
        'This request requires more credits.',
        402,
        'OpenRouter',
        {
          rawMessage: '{"error":{"message":"This request requires more credits.","metadata":{"provider_name":"anthropic"}}}',
          upstreamProvider: 'anthropic',
        },
      ),
    );

    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: { billingMeta?: { upstreamProviderName?: string } };
    };
    expect(dispatchedEvent.event.billingMeta?.upstreamProviderName).toBe('anthropic');
  });

  it('tracks ai_error_shown after a billing event is successfully dispatched', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new ModelError(
        'billing',
        'This request requires more credits.',
        402,
        'OpenRouter',
        {
          rawMessage: '{"error":{"message":"This request requires more credits.","metadata":{"provider_name":"anthropic"}}}',
          upstreamProvider: 'anthropic',
        },
      ),
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'billing' });
    expect(send).toHaveBeenCalledOnce();
    expect(mockTracker.track).toHaveBeenCalledWith('ai_error_shown', {
      errorKind: 'billing',
      owner: 'billing_handler',
      headlineClass: 'billing_quota',
      billingSubtype: 'credits',
      provider: 'OpenRouter',
      upstreamProvider: 'anthropic',
    });
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(mockTracker.track.mock.invocationCallOrder[0]);
  });

  it('tracks an explicit recoveryOwner when caller provides actual handler ownership', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new Error('Some unknown provider failure'),
      {
        errorKindOverride: 'unknown',
        recoveryOwner: 'classify_and_dispatch_tail',
      },
    );

    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledOnce();
    expect(mockTracker.track).toHaveBeenCalledWith('ai_error_shown', {
      errorKind: 'unknown',
      owner: 'classify_and_dispatch_tail',
      headlineClass: 'other',
    });
  });

  it('tracks network errors by kind without leaking transport details into user copy or analytics', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    const raw = 'TypeError: fetch failed UND_ERR_CONNECT_TIMEOUT chatgpt.com 2606:4700::1';

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new ModelError('network', raw),
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'network' });
    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: Extract<AgentEvent, { type: 'error' }>;
    };
    const rendered = JSON.stringify({
      error: dispatchedEvent.event.error,
      resolution: dispatchedEvent.event.resolution,
    });
    const aiErrorShownPayload = mockTracker.track.mock.calls.find(
      ([eventName]) => eventName === 'ai_error_shown',
    )?.[1];

    expect(dispatchedEvent.event.errorKind).toBe('network');
    expect(dispatchedEvent.event.isTransient).toBe(true);
    expect(dispatchedEvent.event.error).toContain("Can't reach the AI service.");
    expect(aiErrorShownPayload).toMatchObject({
      errorKind: 'network',
      owner: 'alt_model_then_transient_retry',
      headlineClass: 'other',
    });
    for (const value of [rendered, JSON.stringify(aiErrorShownPayload)]) {
      expect(value).not.toContain('UND_ERR_CONNECT_TIMEOUT');
      expect(value).not.toContain('chatgpt.com');
      expect(value).not.toContain('2606:4700::1');
    }
  });

  it('keeps network rawError as the existing redacted internal diagnostic field', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    const raw = Object.assign(new Error('request failed Bearer network-token-123'), {
      cause: { code: 'ECONNREFUSED', hostname: 'chatgpt.com', address: '2606:4700::1' },
    });
    const classified = classifyError(raw);
    expect(classified.kind).toBe('network');

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      classified,
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'network' });
    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: Extract<AgentEvent, { type: 'error' }>;
    };

    expect(dispatchedEvent.event.rawError).toBe('request failed Bearer ***REDACTED***');
    expect(dispatchedEvent.event.rawError).not.toContain('network-token-123');
    expect(dispatchedEvent.event.rawError).not.toContain('chatgpt.com');
    expect(dispatchedEvent.event.rawError).not.toContain('2606:4700::1');
  });

  it('threads limitScope + credentialSource and derives subscription headlineClass', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new ModelError('billing', 'The usage limit has been reached', 429, 'OpenAI'),
      {
        recoveryOwner: 'billing_handler',
        credentialSource: 'codex-subscription',
        limitScopeOverride: 'plan',
      },
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'billing' });
    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: Extract<AgentEvent, { type: 'error' }>;
    };
    expect(dispatchedEvent.event.limitScope).toBe('plan');
    expect(dispatchedEvent.event.credentialSource).toBe('codex-subscription');
    expect(dispatchedEvent.event.headlineClass).toBe('subscription_entitlement');
    expect(mockTracker.track).toHaveBeenCalledWith('ai_error_shown', {
      errorKind: 'billing',
      owner: 'billing_handler',
      headlineClass: 'subscription_entitlement',
      limitScope: 'plan',
      credentialSource: 'codex-subscription',
      billingSubtype: 'unknown',
      provider: 'OpenAI',
    });
  });

  it('keeps billing headlineClass as billing_quota for BYO fallback billing even when route credentialSource is codex-subscription', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new ModelError('billing', 'Anthropic returned a billing error', 429, 'Anthropic'),
      {
        recoveryOwner: 'billing_handler',
        credentialSource: 'codex-subscription',
      },
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'billing' });
    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: Extract<AgentEvent, { type: 'error' }>;
    };
    expect(dispatchedEvent.event.headlineClass).toBe('billing_quota');
    expect(dispatchedEvent.event.credentialSource).toBe('codex-subscription');
    expect(mockTracker.track).toHaveBeenCalledWith(
      'ai_error_shown',
      expect.objectContaining({
        errorKind: 'billing',
        owner: 'billing_handler',
        headlineClass: 'billing_quota',
        credentialSource: 'codex-subscription',
      }),
    );
  });

  it.each([
    { name: 'plan-scoped rate limit', limitScopeOverride: 'plan' as const, expectedHeadlineClass: 'subscription_entitlement' as const },
    { name: 'provider-scoped rate limit', limitScopeOverride: 'provider' as const, expectedHeadlineClass: 'rate_limit' as const },
  ])('derives headlineClass for $name', ({ limitScopeOverride, expectedHeadlineClass }) => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new ModelError('rate_limit', 'Rate limit exceeded', 429, 'OpenAI', {
        limitScope: limitScopeOverride,
      }),
      {
        recoveryOwner: 'rate_limit_handler',
        credentialSource: 'codex-subscription',
        limitScopeOverride,
      },
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'rate_limit' });
    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: Extract<AgentEvent, { type: 'error' }>;
    };
    expect(dispatchedEvent.event.limitScope).toBe(limitScopeOverride);
    expect(dispatchedEvent.event.headlineClass).toBe(expectedHeadlineClass);
    expect(mockTracker.track).toHaveBeenCalledWith(
      'ai_error_shown',
      expect.objectContaining({
        errorKind: 'rate_limit',
        owner: 'rate_limit_handler',
        headlineClass: expectedHeadlineClass,
        limitScope: limitScopeOverride,
      }),
    );
  });

  it('classifies negative-balance billing messages into billingMeta subtype', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    dispatchAgentErrorEvent(
      win as any,
      turnId,
      new ModelError(
        'billing',
        'This request requires more credits.',
        402,
        'OpenRouter',
        {
          rawMessage: '{"error":{"message":"Your account has a negative balance of -$0.01, so this request requires more credits."}}',
        },
      ),
    );

    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: { billingMeta?: { subtype?: string } };
    };
    expect(dispatchedEvent.event.billingMeta?.subtype).toBe('negative_balance');
  });

  it('classifies invalid x-api-key errors as auth', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new Error('invalid x-api-key provided'),
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'auth' });
    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: { error: string; errorKind?: string; billingMeta?: unknown };
    };
    expect(dispatchedEvent.event.errorKind).toBe('auth');
    expect(dispatchedEvent.event.billingMeta).toBeUndefined();
    // Guard against silent Stage 2 copy regression — auth classification
    // must route through the legacy substring ladder (CALLER_OVERRIDE_KIND)
    // and produce the existing "issue with your API key" phrasing rather
    // than silently falling through to HUMANIZER_SAFE_FALLBACK.
    expect(dispatchedEvent.event.error).toContain("issue with your API key");
  });

  it('preserves connection-not-configured reconnect copy', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new ConnectionNotConfiguredError('Reconnect OpenRouter to use this model', 'OpenRouter'),
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'connection-not-configured' });
    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: { error: string; errorKind?: string; provider?: string };
    };
    expect(dispatchedEvent.event.errorKind).toBe('connection-not-configured');
    expect(dispatchedEvent.event.provider).toBe('OpenRouter');
    expect(dispatchedEvent.event.error).toBe('Reconnect OpenRouter to use this model');
  });

  it('returns ok false and logs when dispatch throws', () => {
    const turnId = nextTurnId();
    const { win } = createWindow({ throwOnSend: true });

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new ModelError('billing', 'This request requires more credits.', 402, 'OpenRouter'),
    );

    expect(result).toEqual({ ok: false });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        turnId,
        errorKind: 'billing',
        provider: 'OpenRouter',
      }),
      'Failed to dispatch agent error event',
    );
    expect(mockTracker.track).not.toHaveBeenCalled();
  });

  it('does not mark rate-limit errors actionable unless explicitly opted in', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    const markActionableSpy = vi.spyOn(agentTurnRegistry, 'markActionableErrorDispatched');

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new ModelError('rate_limit', 'Retry after 30 seconds', 429, 'OpenRouter'),
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'rate_limit' });
    expect(markActionableSpy).not.toHaveBeenCalled();
    expect(agentTurnRegistry.hasActionableErrorDispatched(turnId)).toBe(false);

    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: { rateLimitMeta?: { retryAfterMs?: number } };
    };
    expect(dispatchedEvent.event.rateLimitMeta?.retryAfterMs).toBe(30_000);
  });

  it('dispatches duplicate billing calls for the same turn without helper-side dedupe', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    const error = new ModelError('billing', 'This request requires more credits.', 402, 'OpenRouter');

    dispatchAgentErrorEvent(win as any, turnId, error);
    dispatchAgentErrorEvent(win as any, turnId, error);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('classifies a status-prefixed managed 403 payload as managed_model_not_allowed (not billing)', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    const proxyBody = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'MANAGED_MODEL_NOT_ALLOWED',
        requested: 'claude-haiku-4-5',
        allowed: ['deepseek/deepseek-v4-flash', 'openai/gpt-5.4'],
      },
    });

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      `403 ${proxyBody}`,
      { providerOverride: 'Mindstone' },
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'managed_model_not_allowed' });
    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: { errorKind?: string; error: string; billingMeta?: unknown };
    };
    expect(dispatchedEvent.event.errorKind).toBe('managed_model_not_allowed');
    expect(dispatchedEvent.event.billingMeta).toBeUndefined();
    expect(dispatchedEvent.event.error).toContain("isn't included in your Mindstone plan");
  });

  it('classifies a status-prefixed 429 JSON payload using parsed body fields', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    const quotaBody = JSON.stringify({
      error: {
        message: 'Request rejected by upstream gate.',
        type: 'usage_limit_reached',
      },
    });

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      `429 ${quotaBody}`,
      { providerOverride: 'OpenAI' },
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'billing' });
    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: { errorKind?: string; rateLimitMeta?: unknown };
    };
    expect(dispatchedEvent.event.errorKind).toBe('billing');
    expect(dispatchedEvent.event.rateLimitMeta).toBeUndefined();
  });

  it('keeps non-prefixed JSON classification behavior unchanged', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    const proxyBody = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'MANAGED_MODEL_NOT_ALLOWED',
        requested: 'claude-haiku-4-5',
        allowed: ['deepseek/deepseek-v4-flash', 'openai/gpt-5.4'],
      },
    });

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      { status: 403, message: proxyBody },
      { providerOverride: 'Mindstone' },
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'managed_model_not_allowed' });
    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: { errorKind?: string };
    };
    expect(dispatchedEvent.event.errorKind).toBe('managed_model_not_allowed');
  });

  it('preserves fallback behavior when prefixed payload remains malformed JSON', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    const malformed = '403 {"type":"error","error":{"code":"MANAGED_MODEL_NOT_ALLOWED"';

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      malformed,
      { providerOverride: 'Mindstone' },
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'billing' });
    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: { errorKind?: string };
    };
    expect(dispatchedEvent.event.errorKind).toBe('billing');
  });

  it.each([
    {
      name: 'forwards humanizedOverride',
      rawError: new Error('Original failure'),
      opts: { humanizedOverride: 'Custom human copy' },
      expectedEvent: { error: 'Custom human copy' },
    },
    {
      name: 'forwards isTransient',
      rawError: new Error('Transient failure'),
      opts: { isTransient: true },
      expectedEvent: { isTransient: true },
    },
    {
      name: 'forwards providerOverride',
      rawError: new Error('Provider failure'),
      opts: { providerOverride: 'Together' },
      expectedEvent: { provider: 'Together' },
    },
    {
      name: 'forwards errorKindOverride',
      rawError: new Error('Unknown failure'),
      opts: { errorKindOverride: 'auth' as const },
      expectedEvent: { errorKind: 'auth' },
      expectedDispatchedErrorKind: 'auth' as const,
    },
    {
      name: 'marks actionable when explicitly requested',
      rawError: new Error('Needs attention'),
      opts: { errorKindOverride: 'auth' as const, markActionable: true },
      expectedEvent: { errorKind: 'auth' },
      expectedDispatchedErrorKind: 'auth' as const,
      expectMarkedActionable: true,
    },
    {
      name: 'forwards timeoutDiagnostic',
      rawError: new Error('Timed out'),
      opts: {
        errorKindOverride: 'message_timeout' as const,
        timeoutDiagnostic,
      },
      expectedEvent: {
        errorKind: 'message_timeout',
        timeoutDiagnostic,
      },
      expectedDispatchedErrorKind: 'message_timeout' as const,
    },
    {
      name: 'forwards watchdogDiagnostic',
      rawError: new Error('Watchdog abort'),
      opts: { watchdogDiagnostic },
      expectedEvent: { watchdogDiagnostic },
    },
    {
      name: 'uses timestampOverride',
      rawError: new Error('Timestamp override'),
      opts: { timestampOverride: 123_456_789 },
      expectedEvent: {},
      expectedTimestamp: 123_456_789,
    },
    {
      name: 'combines all overrides',
      rawError: new Error('Everything failed'),
      opts: {
        humanizedOverride: 'Combined copy',
        isTransient: true,
        providerOverride: 'Anthropic',
        errorKindOverride: 'auth' as const,
        markActionable: true,
        timeoutDiagnostic,
        watchdogDiagnostic,
        timestampOverride: 987_654_321,
      },
      expectedEvent: {
        error: 'Combined copy',
        isTransient: true,
        provider: 'Anthropic',
        errorKind: 'auth',
        timeoutDiagnostic,
        watchdogDiagnostic,
      },
      expectedDispatchedErrorKind: 'auth' as const,
      expectedTimestamp: 987_654_321,
      expectMarkedActionable: true,
    },
  ])('$name', ({ rawError, opts, expectedEvent, expectedDispatchedErrorKind, expectedTimestamp, expectMarkedActionable }) => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    const markActionableSpy = vi.spyOn(agentTurnRegistry, 'markActionableErrorDispatched');

    const result = dispatchAgentErrorEvent(win as any, turnId, rawError, opts);

    expect(result.ok).toBe(true);
    expect(result.dispatchedErrorKind).toBe(expectedDispatchedErrorKind);

    const dispatchedEvent = send.mock.calls[0]?.[1] as { event: Record<string, unknown> };
    expect(dispatchedEvent.event).toEqual(expect.objectContaining(expectedEvent));
    if (expectedTimestamp !== undefined) {
      expect(dispatchedEvent.event.timestamp).toBe(expectedTimestamp);
    } else {
      expect(dispatchedEvent.event.timestamp).toEqual(expect.any(Number));
    }

    if (expectMarkedActionable) {
      expect(markActionableSpy).toHaveBeenCalledOnce();
      expect(agentTurnRegistry.hasActionableErrorDispatched(turnId)).toBe(true);
    } else {
      expect(markActionableSpy).not.toHaveBeenCalled();
      expect(agentTurnRegistry.hasActionableErrorDispatched(turnId)).toBe(false);
    }
  });

  it('forwards rateLimitMetaOverride when paired with a rate-limit error kind override', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new Error('friendly rate limit copy'),
      {
        errorKindOverride: 'rate_limit',
        rateLimitMetaOverride,
      },
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'rate_limit' });
    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: { errorKind?: string; rateLimitMeta?: typeof rateLimitMetaOverride };
    };
    expect(dispatchedEvent.event.errorKind).toBe('rate_limit');
    expect(dispatchedEvent.event.rateLimitMeta).toEqual(rateLimitMetaOverride);
  });

  it('ignores rateLimitMetaOverride when the emitted error is not rate-limited', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new Error('auth failure'),
      {
        errorKindOverride: 'auth',
        rateLimitMetaOverride,
      },
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'auth' });
    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: { errorKind?: string; rateLimitMeta?: unknown };
    };
    expect(dispatchedEvent.event.errorKind).toBe('auth');
    expect(dispatchedEvent.event.rateLimitMeta).toBeUndefined();
  });
});

describe('dispatchAgentEvent seq handling', () => {
  it('broadcasts sanitized stamped tool events while storing sanitized stamped copies', () => {
    const turnId = nextTurnId();
    const sessionId = 'dispatcher-seq-session';
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    const { send, win } = createWindow();
    const fullDetail = 'x'.repeat(12_500);
    dispatchAgentEvent(
      win as any,
      turnId,
      {
        type: 'tool',
        stage: 'end',
        toolName: 'Read',
        toolUseId: 'toolu_dispatcher',
        detail: fullDetail,
        timestamp: 1_700_000_100_000,
      },
    );

    expect(send).toHaveBeenCalledOnce();
    const payload = send.mock.calls[0]?.[1] as {
      sessionId?: string;
      event: Extract<AgentEvent, { type: 'tool' }>;
    };
    expect(payload.sessionId).toBe(sessionId);
    expect(payload.event.detail.length).toBeLessThan(fullDetail.length);
    expect(Number.isInteger(payload.event.seq) && Number(payload.event.seq) > 0).toBe(true);

    const accumulated = agentTurnRegistry.getContextAccumulator(turnId);
    const stored = accumulated?.eventsByTurn[turnId]?.[0] as Extract<AgentEvent, { type: 'tool' }>;
    expect(stored).toBeDefined();
    expect(stored.seq).toBe(payload.event.seq);
    expect(stored.detail.length).toBeLessThan(fullDetail.length);
  });

  it('strips renderer IPC imageContent when imageRef is present while preserving listener payloads', () => {
    const turnId = nextTurnId();
    const sessionId = 'dispatcher-image-session';
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    const listener = vi.fn();
    agentTurnRegistry.setEventListener(turnId, listener);
    const { send, win } = createWindow();
    const imageRef = { assetId: 'turn-1-1-0', mimeType: 'image/png', byteSize: 123 };

    dispatchAgentEvent(
      win as any,
      turnId,
      {
        type: 'tool',
        stage: 'end',
        toolName: 'screenshot',
        toolUseId: 'toolu_image',
        detail: 'captured',
        timestamp: 1_700_000_100_001,
        imageContent: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
        imageRef: [imageRef],
        toolResult: {
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'base64data',
              },
              imageRef,
            },
          ],
        },
      },
    );

    const payload = send.mock.calls[0]?.[1] as {
      event: Extract<AgentEvent, { type: 'tool' }>;
    };
    expect(payload.event.imageContent).toEqual([
      { type: 'image', data: '', mimeType: 'image/png' },
    ]);
    expect(payload.event.imageRef).toEqual([imageRef]);
    expect(payload.event.toolResult?.content?.[0]).toEqual({ type: 'image', imageRef });

    const listenerEvent = listener.mock.calls[0]?.[0] as Extract<AgentEvent, { type: 'tool' }>;
    expect(listenerEvent.imageContent).toHaveLength(1);
    expect(listenerEvent.imageRef).toEqual([imageRef]);
  });

  it('emits an answer_phase_started marker on the first assistant_delta and never re-broadcasts deltas (Stage 2 R3-arbiter-1)', () => {
    const turnId = nextTurnId();
    const sessionId = 'dispatcher-delta-session';
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    const { send, win } = createWindow();
    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant_delta',
      text: 'A',
      timestamp: 1_700_000_200_000,
    });
    dispatchAgentEvent(win as any, turnId, {
      type: 'status',
      message: 'working',
      timestamp: 1_700_000_200_100,
    });
    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant_delta',
      text: 'B',
      timestamp: 1_700_000_200_200,
    });
    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant',
      text: 'Done',
      timestamp: 1_700_000_200_300,
    });

    const streamedEvents = send.mock.calls.map((call) => (call[1] as { event: AgentEvent }).event);
    expect(streamedEvents.map((event) => event.type)).toEqual([
      'answer_phase_started',
      'status',
      'assistant',
    ]);

    const stampedSeqs = streamedEvents
      .filter((event) => event.type !== 'answer_phase_started')
      .map((event) => event.seq);
    expect(stampedSeqs).toHaveLength(2);
    expect(stampedSeqs.every((seq) => Number.isInteger(seq) && Number(seq) > 0)).toBe(true);
    expect(stampedSeqs).toEqual([...stampedSeqs].sort((a, b) => Number(a) - Number(b)));
  });

  it('does NOT re-emit answer_phase_started on subsequent deltas of the same turn (R3-arbiter idempotency)', () => {
    const turnId = nextTurnId();
    const sessionId = 'dispatcher-marker-idempotent-session';
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    const { send, win } = createWindow();
    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant_delta',
      text: 'A',
      timestamp: 1_700_000_300_000,
    });
    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant_delta',
      text: 'B',
      timestamp: 1_700_000_300_100,
    });
    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant_delta',
      text: 'C',
      timestamp: 1_700_000_300_200,
    });

    const markerCalls = send.mock.calls.filter(
      (call) => (call[1] as { event: AgentEvent }).event.type === 'answer_phase_started',
    );
    expect(markerCalls).toHaveLength(1);
  });

  it('routes assistant_delta to CLI listener and multi-subscribers but NOT to webContents (R3-arbiter dual-path)', () => {
    const turnId = nextTurnId();
    const sessionId = 'dispatcher-delta-fanout-session';
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    const cliListener = vi.fn();
    const cloudSubscriber = vi.fn();
    agentTurnRegistry.setEventListener(turnId, cliListener);
    const unsubscribe = agentTurnRegistry.subscribeTurnEvents(turnId, cloudSubscriber);

    const { send, win } = createWindow();
    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant_delta',
      text: 'streaming',
      timestamp: 1_700_000_400_000,
    });

    // CLI listener AND cloud subscriber both receive the full payload.
    expect(cliListener).toHaveBeenCalledTimes(1);
    expect((cliListener.mock.calls[0]?.[0] as AgentEvent).type).toBe('assistant_delta');
    expect(cloudSubscriber).toHaveBeenCalledTimes(1);
    expect((cloudSubscriber.mock.calls[0]?.[0] as AgentEvent).type).toBe('assistant_delta');

    // Renderer IPC sees only the marker — never the delta payload.
    const sentTypes = send.mock.calls.map(
      (call) => (call[1] as { event: AgentEvent }).event.type,
    );
    expect(sentTypes).toEqual(['answer_phase_started']);

    unsubscribe();
    agentTurnRegistry.deleteEventListener(turnId);
  });

  it('streams thinking_delta to renderer while skipping accumulator persistence (Stage 2 cleanup)', () => {
    const turnId = nextTurnId();
    const sessionId = 'dispatcher-thinking-transient-session';
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    const { send, win } = createWindow();
    dispatchAgentEvent(win as any, turnId, {
      type: 'thinking_delta',
      text: 't1',
      timestamp: 1_700_000_410_000,
    });
    dispatchAgentEvent(win as any, turnId, {
      type: 'thinking_delta',
      text: 't2',
      timestamp: 1_700_000_410_100,
    });
    dispatchAgentEvent(win as any, turnId, {
      type: 'thinking_delta',
      text: 't3',
      timestamp: 1_700_000_410_200,
    });
    dispatchAgentEvent(win as any, turnId, {
      type: 'tool',
      stage: 'start',
      toolName: 'Read',
      toolUseId: 'tool-thinking-gap',
      detail: 'probe',
      timestamp: 1_700_000_410_300,
    });

    const streamedEvents = send.mock.calls.map((call) => (call[1] as { event: AgentEvent }).event);
    const streamedThinking = streamedEvents.filter((event) => event.type === 'thinking_delta');
    expect(streamedThinking).toHaveLength(3);
    expect(streamedThinking.every((event) => Number.isInteger(event.seq) && Number(event.seq) > 0)).toBe(true);

    const streamedTool = streamedEvents.find(
      (event) => event.type === 'tool',
    ) as Extract<AgentEvent, { type: 'tool' }> | undefined;
    expect(streamedTool?.seq).toBe(4);

    const accumulated = agentTurnRegistry.getContextAccumulator(turnId);
    const persistedTurnEvents = accumulated?.eventsByTurn[turnId] ?? [];
    expect(accumulated?.messages ?? []).toEqual([]);
    expect(persistedTurnEvents.some((event) => event.type === 'thinking_delta')).toBe(false);
    expect(persistedTurnEvents).toHaveLength(1);
    expect(persistedTurnEvents[0]?.type).toBe('tool');
    expect(persistedTurnEvents[0]?.seq).toBe(4);
  });

  it('keeps assistant_delta non-persisted behavior unchanged while consuming seq', () => {
    const turnId = nextTurnId();
    const sessionId = 'dispatcher-assistant-transient-session';
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    const { send, win } = createWindow();
    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant_delta',
      text: 'delta',
      timestamp: 1_700_000_420_000,
    });
    dispatchAgentEvent(win as any, turnId, {
      type: 'tool',
      stage: 'start',
      toolName: 'Read',
      toolUseId: 'tool-assistant-gap',
      detail: 'probe',
      timestamp: 1_700_000_420_100,
    });

    const streamedTypes = send.mock.calls.map(
      (call) => (call[1] as { event: AgentEvent }).event.type,
    );
    expect(streamedTypes).toEqual(['answer_phase_started', 'tool']);

    const streamedTool = send.mock.calls
      .map((call) => (call[1] as { event: AgentEvent }).event)
      .find((event) => event.type === 'tool') as Extract<AgentEvent, { type: 'tool' }> | undefined;
    expect(streamedTool?.seq).toBe(2);

    const accumulated = agentTurnRegistry.getContextAccumulator(turnId);
    const persistedTurnEvents = accumulated?.eventsByTurn[turnId] ?? [];
    expect(persistedTurnEvents.some((event) => event.type === 'assistant_delta')).toBe(false);
    expect(persistedTurnEvents).toHaveLength(1);
    expect(persistedTurnEvents[0]?.type).toBe('tool');
    expect(persistedTurnEvents[0]?.seq).toBe(2);
  });

  it('re-arms the answer_phase_started sentinel after registry cleanup (F16 invariant)', () => {
    const turnId = nextTurnId();
    const sessionId = 'dispatcher-marker-cleanup-session';
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    const { send, win } = createWindow();
    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant_delta',
      text: 'A',
      timestamp: 1_700_000_500_000,
    });
    expect(
      send.mock.calls.filter(
        (call) => (call[1] as { event: AgentEvent }).event.type === 'answer_phase_started',
      ),
    ).toHaveLength(1);

    // cleanupForRetry simulates a retry path — the registry fires turnCleanup
    // listeners and the dispatcher clears the sentinel set so the next answer
    // phase re-emits the marker.
    agentTurnRegistry.cleanupForRetry(turnId);
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant_delta',
      text: 'B',
      timestamp: 1_700_000_500_100,
    });
    expect(
      send.mock.calls.filter(
        (call) => (call[1] as { event: AgentEvent }).event.type === 'answer_phase_started',
      ),
    ).toHaveLength(2);
  });

  // Phase 6 regression — completeness specialist DI-1.5 #3: the sentinel
  // set is desktop-only state. A cloud / headless dispatch (win === null)
  // must NOT populate the set; otherwise the marker bookkeeping silently
  // leaks into surfaces that never consume it (and could miss eventual
  // cleanup if the registry-cleanup callback runs in a different process).
  it('does NOT populate the sentinel set when win is null (DI-1.5 #3 cloud invariant)', () => {
    const turnId = nextTurnId();
    const sessionId = 'cloud-headless-dispatch';
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    expect(__peekAnswerPhaseStartedSentinelForTests().has(turnId)).toBe(false);

    dispatchAgentEvent(null, turnId, {
      type: 'assistant_delta',
      text: 'cloud',
      timestamp: 1_700_000_600_000,
    });

    expect(__peekAnswerPhaseStartedSentinelForTests().has(turnId)).toBe(false);
  });

  // Phase 6 regression — completeness + behavioral-safety: each of the six
  // R2-6 cleanup paths must clear the sentinel. cleanupTurn fires the
  // turn-cleanup listeners that the dispatcher subscribes to at module load.
  it('clears the sentinel via agentTurnRegistry.cleanupTurn (R2-6 path)', () => {
    const turnId = nextTurnId();
    const sessionId = 'r2-6-cleanupTurn';
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    const { win } = createWindow();
    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant_delta',
      text: 'A',
      timestamp: 1_700_000_700_000,
    });
    expect(__peekAnswerPhaseStartedSentinelForTests().has(turnId)).toBe(true);

    agentTurnRegistry.cleanupTurn(turnId);
    expect(__peekAnswerPhaseStartedSentinelForTests().has(turnId)).toBe(false);
  });

  it('clears the sentinel via agentTurnRegistry.releaseActiveSession (R2-6 path)', () => {
    const turnId = nextTurnId();
    const sessionId = 'r2-6-releaseActiveSession';
    agentTurnRegistry.setRendererSession(turnId, sessionId);
    agentTurnRegistry.setActiveTurnController(turnId, new AbortController());

    const { win } = createWindow();
    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant_delta',
      text: 'A',
      timestamp: 1_700_000_700_100,
    });
    expect(__peekAnswerPhaseStartedSentinelForTests().has(turnId)).toBe(true);

    agentTurnRegistry.releaseActiveSession(turnId);
    expect(__peekAnswerPhaseStartedSentinelForTests().has(turnId)).toBe(false);
  });

  it('clears the sentinel inline on terminal "result" event (R2-6 belt path)', () => {
    const turnId = nextTurnId();
    const sessionId = 'r2-6-terminal-result';
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    const { win } = createWindow();
    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant_delta',
      text: 'A',
      timestamp: 1_700_000_700_200,
    });
    expect(__peekAnswerPhaseStartedSentinelForTests().has(turnId)).toBe(true);

    dispatchAgentEvent(win as any, turnId, {
      type: 'result',
      text: 'done',
      timestamp: 1_700_000_700_300,
    });
    expect(__peekAnswerPhaseStartedSentinelForTests().has(turnId)).toBe(false);
  });

  it('clears the sentinel inline on terminal "turn_superseded" event (R2-6 belt path)', () => {
    const turnId = nextTurnId();
    const sessionId = 'r2-6-turn-superseded';
    agentTurnRegistry.setRendererSession(turnId, sessionId);

    const { win } = createWindow();
    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant_delta',
      text: 'A',
      timestamp: 1_700_000_700_400,
    });
    expect(__peekAnswerPhaseStartedSentinelForTests().has(turnId)).toBe(true);

    dispatchAgentEvent(win as any, turnId, {
      type: 'turn_superseded',
      newTurnId: 'turn-next',
      timestamp: 1_700_000_700_500,
    });
    expect(__peekAnswerPhaseStartedSentinelForTests().has(turnId)).toBe(false);
  });

  // Phase 6 regression — F16 invariant. The two exemption arrays document the
  // long-term contract: renderer-only lifecycle events bypass listener /
  // subscriber fan-out; "no renderer subscriber" event types are intentionally
  // asymmetric and must not flag the F16 counter as send-and-forget anomalies.
  it('exposes RENDERER_ONLY_LIFECYCLE_EVENTS and KNOWN_NO_RENDERER_SUBSCRIBER for F16/R2-8', () => {
    expect(RENDERER_ONLY_LIFECYCLE_EVENTS).toContain('answer_phase_started');
    expect(KNOWN_NO_RENDERER_SUBSCRIBER).toContain('assistant_delta');
    expect(KNOWN_NO_RENDERER_SUBSCRIBER).toContain('thinking_delta');
    // The two lists must remain disjoint by construction — a renderer-only
    // marker IS by definition something the renderer subscribes to.
    for (const t of RENDERER_ONLY_LIFECYCLE_EVENTS) {
      expect(KNOWN_NO_RENDERER_SUBSCRIBER).not.toContain(t);
    }
  });

  it('exports clearAnswerPhaseStartedSentinel for the recovery pipeline', () => {
    const turnId = nextTurnId();
    const sessionId = 'phase6-recovery-export';
    agentTurnRegistry.setRendererSession(turnId, sessionId);
    const { win } = createWindow();
    dispatchAgentEvent(win as any, turnId, {
      type: 'assistant_delta',
      text: 'A',
      timestamp: 1_700_000_700_600,
    });
    expect(__peekAnswerPhaseStartedSentinelForTests().has(turnId)).toBe(true);

    expect(clearAnswerPhaseStartedSentinel(turnId)).toBe(true);
    expect(__peekAnswerPhaseStartedSentinelForTests().has(turnId)).toBe(false);

    // Idempotent: clearing an already-cleared turn is a no-op.
    expect(clearAnswerPhaseStartedSentinel(turnId)).toBe(false);
  });

  it('skips terminal checkpointing for delete-eligible sessions', () => {
    const turnId = nextTurnId();
    const sessionId = 'memory-update-checkpoint-skip';
    agentTurnRegistry.setRendererSession(turnId, sessionId);
    getTurnCheckpointManagerMock.mockReturnValue({
      checkpointTerminal: mockCheckpointTerminal,
    });

    const { win } = createWindow();
    dispatchAgentEvent(win as any, turnId, {
      type: 'result',
      text: 'Done',
      timestamp: 1_700_000_300_000,
    });

    expect(mockCheckpointTerminal).not.toHaveBeenCalled();
  });
});

describe('dispatchAgentErrorEvent — humanizer integration (Stage 2)', () => {
  it('dispatches a billing event with classification-driven subtype-aware copy for bare OpenAI quota text', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new Error(
        'You exceeded your current quota, please check your plan and billing details.',
      ),
      { errorKindOverride: 'billing', providerOverride: 'OpenAI' },
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'billing' });

    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: { error: string; errorKind?: string; provider?: string };
    };
    // Regression guard for the target bug (conversation 82d61626): bare OpenAI
    // `insufficient_quota` text MUST NOT surface as "That request was too large".
    expect(dispatchedEvent.event.error).toContain("You've reached your OpenAI usage limit");
    expect(dispatchedEvent.event.error).not.toContain('too large');
    expect(dispatchedEvent.event.errorKind).toBe('billing');
    expect(dispatchedEvent.event.provider).toBe('OpenAI');
  });

  it('falls back to HUMANIZER_SAFE_FALLBACK and tracks ai_error_humanization_failed when humanizeAgentError throws', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    // Monkey-patch the humanizer to propagate a throw past its own try/catch —
    // exercises the dispatcher's belt-and-braces catch (Stage 2 spec).
    mockHumanizeAgentError.mockImplementationOnce(() => {
      throw new Error('simulated humanizer crash');
    });

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new ModelError(
        'billing',
        'This request requires more credits.',
        402,
        'OpenRouter',
      ),
    );

    // The event STILL fires — dropping an error event is never acceptable.
    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();

    const dispatchedEvent = send.mock.calls[0]?.[1] as { event: { error: string } };
    expect(dispatchedEvent.event.error).toBe(HUMANIZER_SAFE_FALLBACK);

    // Dispatcher-layer observability: a Pino warn + dedicated tracker event.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        turnId,
        errorKind: 'billing',
        provider: 'OpenRouter',
        layer: 'dispatcher',
      }),
      'humanizeAgentError threw in dispatcher; using safe fallback',
    );
    expect(mockTracker.track).toHaveBeenCalledWith('ai_error_humanization_failed', {
      layer: 'dispatcher',
    });
  });

  it("does NOT call console.warn on humanizer internal failure once the dispatcher's observer is wired", () => {
    // Stage 1 installed a `console.warn` last-ditch diagnostic in `reportHumanizerFailure`
    // that fires only when no observer is wired. Stage 2 wires an observer at
    // module init, so the console.warn path should be unreachable in production.
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Trigger a humanizer internal failure: pass a malformed input that causes
    // `humanizeAgentErrorCore` (the real implementation) to throw inside its
    // own try/catch, which in turn invokes the observer. Cast through `as any`
    // to bypass the discriminated-union type guard — `null` for `rawMessage`
    // is specifically what makes `classifyBillingSubtype` throw. The mock's
    // default implementation (set in `beforeEach`) delegates to the real fn.
    const result = mockHumanizeAgentError({
      kind: 'classified',
      errorKind: 'billing',
      rawMessage: null as unknown as string,
    });

    // Humanizer returns the safe fallback (Stage 1 behaviour).
    expect(result).toBe(HUMANIZER_SAFE_FALLBACK);

    // Observer fired → Pino + tracker wired by the dispatcher module handled it.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        inputKind: 'classified',
        errorKind: 'billing',
        layer: 'humanizer',
      }),
      'humanizeAgentError threw; safe fallback returned',
    );
    expect(mockTracker.track).toHaveBeenCalledWith('ai_error_humanization_failed', {
      layer: 'humanizer',
      inputKind: 'classified',
      errorKind: 'billing',
    });

    // Critical: console.warn must NOT have fired — the observer now owns this
    // diagnostic path.
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('wireHumanizerFailureObserver is idempotent — a second call does not replace the wired observer', () => {
    // The dispatcher module init already wired the observer. Invoking
    // `wireHumanizerFailureObserver` a second time must NOT replace it (the
    // idempotency guard prevents re-wiring). We verify by installing a custom
    // observer AFTER module init, then calling `wireHumanizerFailureObserver`
    // again — the custom observer must survive.
    const customObserver = vi.fn();
    setHumanizerFailureObserver(customObserver);

    wireHumanizerFailureObserver(); // second call — should be a no-op

    // Trigger a failure through the real humanizer (mock's default impl
    // delegates to the real function via beforeEach).
    mockHumanizeAgentError({
      kind: 'classified',
      errorKind: 'billing',
      rawMessage: null as unknown as string,
    });

    expect(customObserver).toHaveBeenCalledOnce();
    // The dispatcher's wired observer (mockLogger/mockTracker) must NOT have fired.
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'humanizeAgentError threw; safe fallback returned',
    );

    // Reset the observer + the module-level wired flag so subsequent tests see
    // a re-wired dispatcher observer.
    __clearHumanizerFailureObserverForTests();
    __resetHumanizerObserverWiredFlagForTests();
    wireHumanizerFailureObserver();
  });

  it('short-circuits to humanizedOverride without invoking humanizeAgentError', () => {
    // GPT S1 regression guard: `humanizedOverride` must take precedence
    // over any humanizer path — even if the humanizer itself is currently
    // throwing. This protects `handleBillingError`-style call sites that
    // pre-compute bespoke copy from ever being silently overwritten by
    // HUMANIZER_SAFE_FALLBACK when the humanizer goes sideways.
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    mockHumanizeAgentError.mockImplementationOnce(() => {
      throw new Error('humanizer must NOT have been called');
    });

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new Error('Some raw upstream text we intentionally want hidden'),
      {
        humanizedOverride: 'Bespoke copy from handleBillingError',
        errorKindOverride: 'billing',
      },
    );

    expect(result).toEqual({ ok: true, dispatchedErrorKind: 'billing' });
    expect(mockHumanizeAgentError).not.toHaveBeenCalled();

    const dispatchedEvent = send.mock.calls[0]?.[1] as { event: { error: string } };
    expect(dispatchedEvent.event.error).toBe('Bespoke copy from handleBillingError');

    // No humanizer failure was triggered → dispatcher must NOT have tracked one.
    expect(mockTracker.track).not.toHaveBeenCalledWith(
      'ai_error_humanization_failed',
      expect.anything(),
    );
  });

  it('routes unclassified errors (kind=unclassified) through the humanizer', () => {
    // GPT S2 regression guard: plain `Error` with no classification hints
    // must route through `humanizeAgentError` as `kind: 'unclassified'`
    // (NOT bypass the humanizer and emit raw text, and NOT regress to the
    // pre-Stage-2 direct-`humanizeError` call path).
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new Error('Network request failed mid-flight'),
    );

    expect(result.ok).toBe(true);

    // Assert humanizer was called with a discriminated-union `unclassified` input —
    // this is the Stage 2 architectural contract for unknown-classification errors.
    expect(mockHumanizeAgentError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unclassified' }),
    );

    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: { error: string; errorKind?: string };
    };
    // Unknown-kind errors omit `errorKind` from the event (see `...(errorKind !== 'unknown' ? ...)`)
    expect(dispatchedEvent.event.errorKind).toBeUndefined();
    // Humanized copy must be non-empty and non-raw — legacy `humanizeError` maps
    // "Network ... failed" to a user-friendly network-down message; worst case
    // the unclassified branch returns HUMANIZER_SAFE_FALLBACK. Either way, the
    // raw "mid-flight" substring must NOT leak.
    expect(dispatchedEvent.event.error).not.toContain('mid-flight');
    expect(dispatchedEvent.event.error.length).toBeGreaterThan(0);
  });

  // I2 emit-boundary fence (260529 error-emit-funnel, Stage 2; hardened Stage 5).
  // The funnel runs `enforceErrorKindWireContract` immediately after event
  // construction. The wire contract: a `'unknown'` kind is *omitted* from the
  // emitted event (never present as the literal string). Stage 5 made the
  // *response* to a violation environment-gated (mirroring `errorReporter.ts`):
  // throw in test/CI (loud, blocks merge); normalize-and-report in prod (strip
  // the offending `errorKind` so the error STILL surfaces — never dropped).
  // These tests pin: (1) the live unknown path passes the fence and dispatches
  // with `errorKind` omitted; (2) test-env throws on a planted violation;
  // (3) prod-env normalizes (omits errorKind) + reports + does NOT throw.
  it('I2 fence: the unknown path passes the emit-boundary fence (errorKind omitted, no throw)', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    // A genuinely-unknown error — its kind resolves to `'unknown'`, which the
    // funnel must omit. The dispatch must succeed (the invariant must NOT fire
    // for the correctly-omitted case).
    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new Error('Something inscrutable happened'),
    );

    expect(result.ok).toBe(true);
    const dispatchedEvent = send.mock.calls[0]?.[1] as {
      event: Record<string, unknown>;
    };
    // The wire contract: `errorKind` is absent entirely, not present-as-unknown.
    expect('errorKind' in dispatchedEvent.event).toBe(false);
  });

  it("I2 fence (test/CI): throws on a planted event carrying errorKind: 'unknown'", () => {
    // In test/CI the fence keeps the loud failure so a future edit that lets the
    // funnel build an event with `errorKind: 'unknown'` (e.g. by dropping the
    // omission spread) fails before merge. We're already running under
    // NODE_ENV='test', so the gate selects the throw branch.
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const offendingEvent = {
        type: 'error' as const,
        error: 'x',
        errorKind: 'unknown' as const,
        errorSource: 'main' as const,
        timestamp: 0,
      } as unknown as Parameters<typeof __enforceErrorKindWireContractForTests>[0];
      expect(() =>
        __enforceErrorKindWireContractForTests(offendingEvent, {
          turnId: 'turn-i2-throw',
          provider: undefined,
        }),
      ).toThrow(InvariantViolationError);
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it("I2 fence (prod): normalizes (strips errorKind) + reports, does NOT throw, never drops the error", () => {
    // In production the fence must NOT crash on the error-dispatch path (that
    // would drop the very error event the funnel exists to surface). Instead it
    // normalizes the event to the wire-correct shape (errorKind omitted) and
    // reports the violation observably, leaving every other field intact.
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    mockLogger.warn.mockClear();
    try {
      const offendingEvent = {
        type: 'error' as const,
        error: 'still-surfaces',
        errorKind: 'unknown' as const,
        isTransient: true,
        resolution: 'retry',
        provider: 'Mindstone',
        errorSource: 'main' as const,
        timestamp: 42,
      } as unknown as Parameters<typeof __enforceErrorKindWireContractForTests>[0];

      expect(() =>
        __enforceErrorKindWireContractForTests(offendingEvent, {
          turnId: 'turn-i2-normalize',
          provider: 'Mindstone',
        }),
      ).not.toThrow();

      // Normalized: errorKind stripped entirely (now wire-correct).
      expect('errorKind' in offendingEvent).toBe(false);
      // The error still surfaces — the event object is intact except for the
      // stripped errorKind: all other fields preserved.
      const surviving = offendingEvent as unknown as Record<string, unknown>;
      expect(surviving.type).toBe('error');
      expect(surviving.error).toBe('still-surfaces');
      expect(surviving.isTransient).toBe(true);
      expect(surviving.resolution).toBe('retry');
      expect(surviving.provider).toBe('Mindstone');
      expect(surviving.errorSource).toBe('main');
      expect(surviving.timestamp).toBe(42);

      // Reported observably (the never-block-the-path warn).
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: 'turn-i2-normalize', layer: 'dispatcher' }),
        expect.stringContaining('I2 wire-contract violation normalized'),
      );
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it("I2 fence: a well-formed event (errorKind omitted) passes untouched in both envs", () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const wellFormed = {
      type: 'error' as const,
      error: 'x',
      errorSource: 'main' as const,
      timestamp: 0,
    } as unknown as Parameters<typeof __enforceErrorKindWireContractForTests>[0];
    try {
      for (const env of ['test', 'production'] as const) {
        process.env.NODE_ENV = env;
        expect(() =>
          __enforceErrorKindWireContractForTests(wellFormed, {
            turnId: 'turn-i2-ok',
            provider: undefined,
          }),
        ).not.toThrow();
      }
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it('falls through to the humanizer when humanizedOverride is an empty string', () => {
    // Defense-in-depth: a caller that accidentally passes
    // `humanizedOverride: ''` (e.g., extracted from an upstream
    // `new Error()` without a message) must NOT emit a blank error banner.
    // The dispatcher routes the empty override through `humanizeAgentError`
    // exactly as if it were `undefined`, which always returns non-empty copy.
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new Error('silent-fail-source'),
      { humanizedOverride: '' },
    );

    expect(result.ok).toBe(true);
    // Humanizer must have been consulted — the empty override is treated as "no override".
    expect(mockHumanizeAgentError).toHaveBeenCalled();

    const dispatchedEvent = send.mock.calls[0]?.[1] as { event: { error: string } };
    expect(dispatchedEvent.event.error.length).toBeGreaterThan(0);
    expect(dispatchedEvent.event.error).not.toBe('');
  });

  it('falls through to the humanizer when humanizedOverride is whitespace-only', () => {
    // Same guard class as the empty-string case: a `'   '` or `'\n'`
    // override would otherwise render as a visually blank banner. The
    // `.trim().length > 0` check in the predicate routes these through the
    // humanizer as well, without coercing legitimate messages that happen
    // to have incidental padding.
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new Error('padding-only-override'),
      { humanizedOverride: '   \n\t  ' },
    );

    expect(result.ok).toBe(true);
    expect(mockHumanizeAgentError).toHaveBeenCalled();

    const dispatchedEvent = send.mock.calls[0]?.[1] as { event: { error: string } };
    expect(dispatchedEvent.event.error.trim().length).toBeGreaterThan(0);
  });

  it('preserves leading/trailing whitespace on otherwise-valid humanizedOverride copy', () => {
    // The predicate uses `.trim()` *for the guard only* — the emitted
    // copy must be the original, untrimmed string. This guards against a
    // future refactor that coerces the stored value through `.trim()` and
    // silently strips intentional padding from legitimate messages.
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const paddedCopy = '  Your session timed out.  ';
    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new Error('upstream'),
      { humanizedOverride: paddedCopy },
    );

    expect(result.ok).toBe(true);
    expect(mockHumanizeAgentError).not.toHaveBeenCalled();

    const dispatchedEvent = send.mock.calls[0]?.[1] as { event: { error: string } };
    expect(dispatchedEvent.event.error).toBe(paddedCopy);
  });

  it('honours a non-empty humanizedOverride verbatim even when the humanizer would also return a valid copy', () => {
    // Regression guard for the truthy-check boundary: any non-empty string
    // still short-circuits the humanizer. This locks the `if (opts?.humanizedOverride)`
    // predicate against a future well-meaning tightening that would, for
    // example, only accept overrides longer than some arbitrary length.
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new Error('upstream detail'),
      { humanizedOverride: 'x' },
    );

    expect(result.ok).toBe(true);
    expect(mockHumanizeAgentError).not.toHaveBeenCalled();

    const dispatchedEvent = send.mock.calls[0]?.[1] as { event: { error: string } };
    expect(dispatchedEvent.event.error).toBe('x');
  });

  it('guard: throws in test when rate_limit copy override is unmarked', () => {
    const turnId = nextTurnId();
    const { win } = createWindow();

    expect(() =>
      dispatchAgentErrorEvent(
        win as any,
        turnId,
        new ModelError('rate_limit', 'Rate limit reached. Please wait a moment and try again.', 429, 'OpenAI'),
        { humanizedOverride: 'Custom copy that bypasses the humanizer.' },
      ),
    ).toThrow(InvariantViolationError);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId,
        errorKind: 'rate_limit',
        layer: 'dispatcher',
      }),
      expect.stringContaining('humanizedOverride'),
    );
  });

  it('guard: warns but never throws in production for an unmarked rate_limit override', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const turnId = nextTurnId();
      const { send, win } = createWindow();

      const result = dispatchAgentErrorEvent(
        win as any,
        turnId,
        new ModelError('rate_limit', 'Rate limit reached. Please wait a moment and try again.', 429, 'OpenAI'),
        { humanizedOverride: 'Custom copy that bypasses the humanizer.' },
      );

      expect(result.ok).toBe(true);
      expect(send).toHaveBeenCalledOnce();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          turnId,
          errorKind: 'rate_limit',
          layer: 'dispatcher',
        }),
        expect.stringContaining('humanizedOverride'),
      );
    } finally {
      vi.stubEnv('NODE_ENV', 'test');
    }
  });

  it('guard: stays silent when rate_limit copy override is intentionally marked', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new ModelError('rate_limit', 'Rate limit reached. Please wait a moment and try again.', 429, 'OpenAI'),
      {
        humanizedOverride: 'Intentional bespoke rate-limit copy.',
        errorKindOverride: 'rate_limit',
        intentionalCopyOverrideForKind: 'rate_limit',
      },
    );

    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('humanizedOverride'),
    );
  });

  it('guard: stays silent for non-owned kinds even when override is unmarked', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new Error('Authentication failed'),
      {
        humanizedOverride: 'Reconnect your provider in settings.',
        errorKindOverride: 'auth',
      },
    );

    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('humanizedOverride'),
    );
  });

  it('guard: stays silent when no override is provided for rate_limit', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();

    const result = dispatchAgentErrorEvent(
      win as any,
      turnId,
      new ModelError('rate_limit', 'Rate limit reached. Please wait a moment and try again.', 429, 'OpenAI'),
    );

    expect(result.ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('humanizedOverride'),
    );
  });
});

describe('dispatchAgentErrorEvent — isTransient defaulting (F4)', () => {
  type DispatchedEvent = {
    event: {
      isTransient?: boolean;
      errorKind?: string;
    };
  };
  const getEvent = (send: ReturnType<typeof vi.fn>): DispatchedEvent['event'] =>
    (send.mock.calls[0]?.[1] as DispatchedEvent).event;

  it('defaults isTransient=true when errorKind classifies as server_error', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    dispatchAgentErrorEvent(
      win as unknown as Parameters<typeof dispatchAgentErrorEvent>[0],
      turnId,
      new ModelError('server_error', '503 Service Unavailable', 503, 'Anthropic'),
    );
    const event = getEvent(send);
    expect(event.isTransient).toBe(true);
    expect(event.errorKind).toBe('server_error');
  });

  it('does not default isTransient for billing errors (would block memory-update retry)', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    dispatchAgentErrorEvent(
      win as unknown as Parameters<typeof dispatchAgentErrorEvent>[0],
      turnId,
      new ModelError('billing', 'Insufficient quota', 402, 'OpenAI'),
    );
    const event = getEvent(send);
    expect(event.isTransient).toBeUndefined();
    expect(event.errorKind).toBe('billing');
  });

  it('does not default isTransient for rate_limit errors (preserves memoryUpdateService retry semantics)', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    dispatchAgentErrorEvent(
      win as unknown as Parameters<typeof dispatchAgentErrorEvent>[0],
      turnId,
      new ModelError('rate_limit', '429 Too Many Requests', 429, 'Anthropic'),
    );
    const event = getEvent(send);
    expect(event.isTransient).toBeUndefined();
    expect(event.errorKind).toBe('rate_limit');
  });

  it('defaults isTransient=true for unclassified errors that match the transient text regex', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    dispatchAgentErrorEvent(
      win as unknown as Parameters<typeof dispatchAgentErrorEvent>[0],
      turnId,
      new Error('request ended without sending any chunks'),
    );
    const event = getEvent(send);
    expect(event.isTransient).toBe(true);
  });

  it('omits isTransient when error is unclassified and does not match the regex', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    dispatchAgentErrorEvent(
      win as unknown as Parameters<typeof dispatchAgentErrorEvent>[0],
      turnId,
      new Error('Some random failure that is not a known transient pattern'),
    );
    const event = getEvent(send);
    expect(event.isTransient).toBeUndefined();
  });

  it('explicit opts.isTransient=false overrides the server_error default', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    dispatchAgentErrorEvent(
      win as unknown as Parameters<typeof dispatchAgentErrorEvent>[0],
      turnId,
      new ModelError('server_error', '503 Service Unavailable', 503, 'Anthropic'),
      { isTransient: false },
    );
    const event = getEvent(send);
    expect(event.isTransient).toBe(false);
  });
});

describe('dispatchAgentErrorEvent — resolution field', () => {
  type DispatchedEvent = {
    event: {
      resolution?: AgentErrorResolution;
      errorKind?: string;
    };
  };
  const getEvent = (send: ReturnType<typeof vi.fn>): DispatchedEvent['event'] =>
    (send.mock.calls[0]?.[1] as DispatchedEvent).event;

  it('attaches a user-fixable resolution with open-settings action for auth errors', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    dispatchAgentErrorEvent(
      win as unknown as Parameters<typeof dispatchAgentErrorEvent>[0],
      turnId,
      new ModelError('auth', '401 Unauthorized', 401, 'Anthropic'),
    );
    const event = getEvent(send);
    expect(event.resolution).toBeDefined();
    expect(event.resolution).toMatchObject({
      category: 'user-fixable',
      persistent: true,
    });
    expect(event.resolution?.alternatives[0]).toMatchObject({
      label: 'Open settings',
      action: 'open-settings',
      payload: { settingsSection: 'providerKeys' },
      variant: 'primary',
    });
  });

  it('attaches a transient retry resolution for server_error', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    dispatchAgentErrorEvent(
      win as unknown as Parameters<typeof dispatchAgentErrorEvent>[0],
      turnId,
      new ModelError('server_error', '503 Service Unavailable', 503, 'Anthropic'),
    );
    const event = getEvent(send);
    expect(event.resolution).toBeDefined();
    expect(event.resolution).toMatchObject({
      category: 'transient',
      persistent: false,
    });
    expect(event.resolution?.alternatives[0]).toMatchObject({
      label: 'Try again',
      action: 'retry',
      variant: 'primary',
    });
  });

  it('attaches a transient retry resolution for rate_limit', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    dispatchAgentErrorEvent(
      win as unknown as Parameters<typeof dispatchAgentErrorEvent>[0],
      turnId,
      new ModelError('rate_limit', '429 Too Many Requests', 429, 'Anthropic'),
    );
    const event = getEvent(send);
    expect(event.resolution).toBeDefined();
    expect(event.resolution).toMatchObject({
      category: 'transient',
      persistent: false,
    });
    expect(event.resolution?.alternatives[0]).toMatchObject({
      label: 'Try again',
      action: 'retry',
      variant: 'primary',
    });
  });

  it('attaches locked Codex unsupported-model resolution when Anthropic credentials exist', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    dispatchAgentErrorEvent(
      win as unknown as Parameters<typeof dispatchAgentErrorEvent>[0],
      turnId,
      new UnsupportedModelError(
        'gpt-5.5-pro not supported with ChatGPT account',
        'gpt-5.5-pro',
        'codex',
      ),
      {
        settingsContext: {
          activeProvider: 'codex',
          hasAnthropicCredentials: true,
          hasOpenRouterCredentials: false,
          hasCodexSubscription: true,
        },
      },
    );
    const event = getEvent(send);
    expect(event.resolution).toBeDefined();
    expect(event.resolution).toMatchObject({
      category: 'unsupported-feature',
      persistent: true,
    });
    expect(event.resolution?.alternatives[0]).toMatchObject({
      label: 'Use GPT-5.5',
      action: 'switch-model',
      payload: { model: 'gpt-5.5' },
      variant: 'primary',
    });
    expect(event.resolution?.alternatives[1]).toMatchObject({
      label: 'Open settings',
      action: 'open-settings',
      payload: { settingsSection: 'providerKeys' },
      variant: 'secondary',
    });
  });

  it('attaches an unsupported-feature switch-model resolution when no settingsContext is provided', () => {
    const turnId = nextTurnId();
    const { send, win } = createWindow();
    dispatchAgentErrorEvent(
      win as unknown as Parameters<typeof dispatchAgentErrorEvent>[0],
      turnId,
      new UnsupportedModelError(
        'gpt-5.5-pro not supported with ChatGPT account',
        'gpt-5.5-pro',
        'codex',
      ),
    );
    const event = getEvent(send);
    expect(event.resolution).toBeDefined();
    expect(event.resolution).toMatchObject({
      category: 'unsupported-feature',
      persistent: true,
    });
    expect(event.resolution?.alternatives[0]).toMatchObject({
      label: 'Use GPT-5.5',
      action: 'switch-model',
      payload: { model: 'gpt-5.5' },
      variant: 'primary',
    });
  });

  it('omits resolution and logs a warning when classifyErrorUx throws', () => {
    const turnId = nextTurnId();
    const errorKind = 'server_error';
    mockClassifyErrorUx.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const { send, win } = createWindow();
    dispatchAgentErrorEvent(
      win as unknown as Parameters<typeof dispatchAgentErrorEvent>[0],
      turnId,
      new ModelError(errorKind, '503 Service Unavailable', 503, 'Anthropic'),
    );
    const event = getEvent(send);
    expect(event.resolution).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        turnId,
        errorKind,
        layer: 'dispatcher',
      }),
      'classifyErrorUx threw; omitting resolution from error event',
    );
    expect(mockTracker.track).toHaveBeenCalledWith(
      'ai_error_resolution_classification_failed',
      {
        turnId,
        errorKind,
        layer: 'dispatcher',
      },
    );
  });
});

// FOX-3494 (#5 prevention) — Telemetry culprit-attribution contract.
//
// The bug: a ChatGPT-Pro user terminally routed to Anthropic with no Anthropic
// key. `ai_error_shown.provider` stamped the *last route target* (Anthropic),
// masking the real culprit (a claude-* model selected under a connected codex
// subscription) for a week. The fix attaches the route culprit fields
// (`routeInvalidReason`, `failedRouteRole`, `unsupportedModelId`) — derived from
// the `ConnectionNotConfiguredError` detail — to `ai_error_shown` so a
// recurrence is diagnosable from telemetry alone. These tests PIN that
// attribution so it cannot silently regress back to provider-only.
describe('dispatchAgentErrorEvent — telemetry culprit attribution (FOX-3494 #5)', () => {
  const aiErrorShownCall = () =>
    mockTracker.track.mock.calls.find((call) => call[0] === 'ai_error_shown');

  it('emits the route culprit fields for the claude-under-codex terminal, not just the route-target provider', () => {
    const turnId = nextTurnId();
    const { win } = createWindow();

    // The exact incident shape: a claude-* model selected for a PRIMARY turn
    // under connected codex with no Anthropic key. The terminal route TARGET is
    // Anthropic (the masking field), but the culprit is the unservable claude
    // model + its route reason/role.
    dispatchAgentErrorEvent(
      win as unknown as Parameters<typeof dispatchAgentErrorEvent>[0],
      turnId,
      new ConnectionNotConfiguredError(
        'ChatGPT is not connected',
        'Anthropic',
        {
          invalidReason: 'missing-anthropic-credentials-for-claude-model',
          failedRole: 'execution',
          wireModel: 'claude-opus-4-8',
        },
      ),
    );

    const call = aiErrorShownCall();
    expect(call).toBeDefined();
    const payload = call?.[1] as Record<string, unknown>;
    // Culprit fields must be present — this is what was missing for a week.
    expect(payload.routeInvalidReason).toBe(
      'missing-anthropic-credentials-for-claude-model',
    );
    expect(payload.failedRouteRole).toBe('execution');
    expect(payload.unsupportedModelId).toBe('claude-opus-4-8');
    // The route-target provider is still emitted (it is not WRONG, just
    // insufficient on its own) — but it must not be the only attribution signal.
    expect(payload.provider).toBe('Anthropic');
  });

  it('still emits the culprit reason/role when no wire model is attached (unsupportedModelId omitted)', () => {
    const turnId = nextTurnId();
    const { win } = createWindow();

    dispatchAgentErrorEvent(
      win as unknown as Parameters<typeof dispatchAgentErrorEvent>[0],
      turnId,
      new ConnectionNotConfiguredError(
        'ChatGPT is not connected',
        'Anthropic',
        {
          invalidReason: 'missing-anthropic-credentials-for-claude-model',
          failedRole: 'planning',
        },
      ),
    );

    const payload = aiErrorShownCall()?.[1] as Record<string, unknown>;
    expect(payload.routeInvalidReason).toBe(
      'missing-anthropic-credentials-for-claude-model',
    );
    expect(payload.failedRouteRole).toBe('planning');
    // `unsupportedModelId` is only emitted when present — a plain
    // ConnectionNotConfiguredError without a wireModel must omit it (not emit
    // `undefined`), so existing dashboards are unaffected.
    expect('unsupportedModelId' in payload).toBe(false);
  });

  it('does NOT attach route culprit fields to a non-route error (keeps existing dashboards clean)', () => {
    const turnId = nextTurnId();
    const { win } = createWindow();

    dispatchAgentErrorEvent(
      win as unknown as Parameters<typeof dispatchAgentErrorEvent>[0],
      turnId,
      new ModelError('billing', 'This request requires more credits.', 402, 'OpenRouter'),
    );

    const payload = aiErrorShownCall()?.[1] as Record<string, unknown>;
    expect('routeInvalidReason' in payload).toBe(false);
    expect('failedRouteRole' in payload).toBe(false);
    expect('unsupportedModelId' in payload).toBe(false);
  });
});
