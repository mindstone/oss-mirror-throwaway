/**
 * Tests for FOX-2969: Request-too-large detection in structured runtime errors.
 *
 * Verifies that when the runtime sends `{ error: 'invalid_request' }` with text
 * containing "request too large", the handler throws (to trigger session
 * recovery) instead of dispatching a generic "invalid request" error event.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

// ---------------------------------------------------------------------------
// vi.hoisted mock refs
// ---------------------------------------------------------------------------
const {
  dispatchAgentEventMock,
  dispatchAgentErrorEventMock,
  registryMocks,
} = vi.hoisted(() => {
  const mockTurnLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };

  return {
    dispatchAgentEventMock: vi.fn(),
    dispatchAgentErrorEventMock: vi.fn((win: unknown, turnId: string, rawError: unknown, opts?: {
      humanizedOverride?: string;
      isTransient?: boolean;
      errorKindOverride?: string;
      providerOverride?: string;
      markActionable?: boolean;
      timeoutDiagnostic?: unknown;
      watchdogDiagnostic?: unknown;
      rateLimitMetaOverride?: unknown;
      timestampOverride?: number;
    }) => {
      const rawMessage = rawError instanceof Error
        ? rawError.message
        : typeof rawError === 'string'
          ? rawError
          : String(rawError ?? '');
      const errorKind = opts?.errorKindOverride;
      const provider = opts?.providerOverride;

      dispatchAgentEventMock(win, turnId, {
        type: 'error',
        error: opts?.humanizedOverride ?? rawMessage,
        ...(opts?.isTransient !== undefined ? { isTransient: opts.isTransient } : {}),
        ...(errorKind && errorKind !== 'unknown' ? { errorKind } : {}),
        ...(provider ? { provider } : {}),
        ...(opts?.timeoutDiagnostic ? { timeoutDiagnostic: opts.timeoutDiagnostic } : {}),
        ...(opts?.watchdogDiagnostic ? { watchdogDiagnostic: opts.watchdogDiagnostic } : {}),
        ...(errorKind === 'rate_limit' && opts?.rateLimitMetaOverride ? { rateLimitMeta: opts.rateLimitMetaOverride } : {}),
        errorSource: 'main',
        timestamp: opts?.timestampOverride ?? Date.now(),
      });

      if (opts?.markActionable === true || (errorKind === 'billing' && opts?.markActionable !== false)) {
        registryMocks.markActionableErrorDispatched(turnId);
      }

      return {
        ok: true,
        ...(errorKind && errorKind !== 'unknown' ? { dispatchedErrorKind: errorKind } : {}),
      };
    }),
    mockTurnLogger,
    registryMocks: {
      getTurnLogger: vi.fn(() => mockTurnLogger),
      getRendererSession: vi.fn(() => 'renderer-session-1'),
      getActiveTurnCount: vi.fn(() => 1),
      setTurnModel: vi.fn(),
      markActionableErrorDispatched: vi.fn(),
      hasActionableErrorDispatched: vi.fn(() => false),
      hasContextOverflowDispatched: vi.fn(() => false),
      markContextOverflowDispatched: vi.fn(),
      getTurnCategory: vi.fn(() => null),
      getTurnAuthMethod: vi.fn(() => null),
      getTurnPlanningModel: vi.fn(() => undefined),
      getTurnFastModel: vi.fn(() => undefined),
      getTurnModel: vi.fn(() => 'claude-sonnet-4-5'),
      getTurnActiveProvider: vi.fn(() => undefined),
      setTurnActiveProvider: vi.fn(),
      markCostRecorded: vi.fn(),
      hasOutputCapRetryAttempted: vi.fn(() => false),
      markOutputCapRetryAttempted: vi.fn(),
      clearOutputCapRetryAttempted: vi.fn(),
      hasSuccessResultDispatched: vi.fn(() => false),
      markSuccessResultDispatched: vi.fn(),
      recordSessionTurn: vi.fn(),
      hasSessionHadTurns: vi.fn(() => false),
    },
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: registryMocks,
}));

vi.mock('../agentEventDispatcher', () => ({
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: dispatchAgentErrorEventMock,
}));

vi.mock('../../tracking', () => ({
  getTurnAggregator: () => ({
    getToolNameByUseId: vi.fn(),
    addToolStart: vi.fn(),
    addToolEnd: vi.fn(),
    getToolCount: vi.fn(() => 0),
  }),
  mainTracking: { chatSessionCreated: vi.fn() },
}));

vi.mock('@core/services/tracking', () => ({
  trackMainEvent: vi.fn(),
  getOrGenerateAnonymousId: vi.fn(() => 'anon-id'),
}));

vi.mock('../costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

vi.mock('../memoryUpdateService', () => ({
  triggerMemoryUpdate: vi.fn(),
}));

vi.mock('../timeSavedService', () => ({
  triggerTimeSavedEstimation: vi.fn(),
}));

vi.mock('../achievementsStore', () => ({
  updateStreakOnSessionComplete: vi.fn(),
}));

vi.mock('../../services/superMcpHttpManager', () => ({
  superMcpHttpManager: { getState: () => ({ isRunning: false }) },
}));

vi.mock('@shared/utils/agentErrorCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/utils/agentErrorCatalog')>();
  return {
    ...actual,
    createRoutedError: (kind: string, msg: string) => {
      const err = new Error(msg);
      (err as any).errorKind = kind;
      return err;
    },
  };
});

vi.mock('@shared/utils/eventSanitization', () => ({
  isSubAgentTool: vi.fn(() => false),
}));

vi.mock('@shared/utils/friendlyErrors', () => ({
  humanizeError: vi.fn((msg: string) => msg),
  isNetworkError: vi.fn(() => false),
  isRateLimitMessage: vi.fn(() => false),
}));

vi.mock('@shared/utils/modelNormalization', () => ({
  MODEL_OPTIONS: [],
  isExtendedContextUnavailableError: vi.fn(() => false),
  isThinkingModelUnavailableError: vi.fn(() => false),
  PLAN_MODE_ALIAS: 'planner',
  normalizeModel: vi.fn((m: string) => m),
}));

vi.mock('@shared/data/modelProviderPresets', () => ({
  getKnownContextWindowForModel: vi.fn(() => null),
  PROVIDER_PRESETS: { openai: { models: [] }, google: { models: [] } },
}));

vi.mock('@shared/utils/toolNameValidation', () => ({
  isToolNameLengthError: vi.fn(() => false),
  truncateToolName: vi.fn((name: string) => name),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------
import { handleAgentMessage } from '../agentMessageHandler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeAssistantMessageWithError(error: string, text: string) {
  return {
    type: 'assistant' as const,
    message: {
      content: [{ type: 'text', text }],
    },
    error,
  };
}

function makeAssistantMessageWithErrorNoText(error: string) {
  return {
    type: 'assistant' as const,
    message: {
      content: [],
    },
    error,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  initTestPlatformConfig();
});

describe('handleAgentMessage — request-too-large in structured error (FOX-2969)', () => {
  it('throws when runtime sends invalid_request with "Request too large" text', () => {
    const msg = makeAssistantMessageWithError(
      'invalid_request',
      'Request too large (max 20MB). Try with a smaller file.',
    );

    expect(() => handleAgentMessage(null, 'turn-1', msg as any)).toThrow(
      'Request too large',
    );

    // Should NOT dispatch the generic "invalid request" error event
    const errorEvents = dispatchAgentEventMock.mock.calls.filter(
      (call: unknown[]) => (call[2] as { type: string }).type === 'error',
    );
    expect(errorEvents).toHaveLength(0);
  });

  it('throws when runtime sends invalid_request with "request_too_large" text', () => {
    const msg = makeAssistantMessageWithError(
      'invalid_request',
      'Error: request_too_large — payload exceeds limit',
    );

    expect(() => handleAgentMessage(null, 'turn-1', msg as any)).toThrow(
      'request_too_large',
    );
  });

  it('throws when runtime sends invalid_request with "413" and "request" in text', () => {
    const msg = makeAssistantMessageWithError(
      'invalid_request',
      'API Error: 413 request entity too large',
    );

    expect(() => handleAgentMessage(null, 'turn-1', msg as any)).toThrow(
      '413',
    );
  });

  it('dispatches a user-friendly attachment-size error for Anthropic per-image byte-limit text', () => {
    const msg = makeAssistantMessageWithError(
      'invalid_request',
      'messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 12494812 bytes > 5242880 bytes',
    );

    expect(() => handleAgentMessage(null, 'turn-1', msg as any)).not.toThrow();

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'turn-1',
      expect.objectContaining({
        type: 'error',
        error: 'One of your images is over the 5 MB per-image limit. Try a smaller or lower-resolution version.',
      }),
    );
  });

  it('does NOT throw for generic invalid_request without request-too-large text', () => {
    const msg = makeAssistantMessageWithError(
      'invalid_request',
      'The model parameter is invalid.',
    );

    // Should NOT throw — should dispatch as generic error
    expect(() => handleAgentMessage(null, 'turn-1', msg as any)).not.toThrow();

    // Should dispatch the generic error event
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'turn-1',
      expect.objectContaining({
        type: 'error',
        error: 'The request was invalid. Try rephrasing or check Settings > Diagnose.',
      }),
    );
  });

  it('does NOT throw for invalid_request with no text', () => {
    const msg = makeAssistantMessageWithErrorNoText('invalid_request');

    expect(() => handleAgentMessage(null, 'turn-1', msg as any)).not.toThrow();

    // Should dispatch generic error
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'turn-1',
      expect.objectContaining({
        type: 'error',
        error: 'The request was invalid. Try rephrasing or check Settings > Diagnose.',
      }),
    );
  });
});
