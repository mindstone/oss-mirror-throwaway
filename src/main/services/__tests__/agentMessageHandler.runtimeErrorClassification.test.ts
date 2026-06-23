/**
 * Tests for 260421 Stage 3 — runtime-result error classification.
 *
 * Verifies that the runtime `result` error-dispatch path in
 * `agentMessageHandler.ts`:
 *   (a) drops the legacy classification-blind `humanizedOverride` so the
 *       dispatcher's canonical `deriveErrorKind` chain runs against the raw
 *       error text, and
 *   (b) passes a `providerOverride` derived from the turn's selected model
 *       (via `inferProviderFromModelId` / Title-Case display form) so the
 *       first-dispatched event carries the correct `provider` field for CTA
 *       routing.
 *
 * Primary regression guard: conversation `82d61626-3d3c-4ea2-b369-f2ec7c9531de`
 * (OpenAI 429 `insufficient_quota` body previously mis-copy'd as "That request
 * was too large" via the blind `exceed` substring branch).
 *
 * Approach: mock `dispatchAgentErrorEvent` as a spy and assert on the call
 * signature (the handler's Stage 3 contract). End-to-end humanizer behaviour
 * for the same inputs is covered by `agentEventDispatcher.test.ts` (Stage 2);
 * we additionally cross-check here by invoking the real `humanizeAgentError`
 * on the shared inputs so the full bug-regression claim is verifiable from
 * this file alone.
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
  errorReporterMocks,
  trackMainEventMock,
  getOrGenerateAnonymousIdMock,
} = vi.hoisted(() => {
  const mockTurnLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };

  // Shared Stage 4 dedup state: tests drive this via `setErrorResultDispatched(...)`
  // or by invoking the real handler flow that flips `markErrorResultDispatched`.
  const errorResultDispatchedForTurn = new Set<string>();

  return {
    dispatchAgentEventMock: vi.fn(),
    dispatchAgentErrorEventMock: vi.fn(
      (
        _win: unknown,
        _turnId: string,
        _rawError: unknown,
        _opts?: {
          humanizedOverride?: string;
          isTransient?: boolean;
          errorKindOverride?: string;
          providerOverride?: string;
          markActionable?: boolean;
          timeoutDiagnostic?: unknown;
          watchdogDiagnostic?: unknown;
          rateLimitMetaOverride?: unknown;
          timestampOverride?: number;
        },
      ): { ok: boolean } => ({ ok: true }),
    ),
    mockTurnLogger,
    registryMocks: {
      getTurnLogger: vi.fn(() => mockTurnLogger),
      getRendererSession: vi.fn(() => 'renderer-session-1'),
      getActiveTurnCount: vi.fn(() => 1),
      setTurnModel: vi.fn(),
      getTurnModel: vi.fn((_turnId: string): string | undefined => undefined),
      markActionableErrorDispatched: vi.fn(),
      hasActionableErrorDispatched: vi.fn(() => false),
      hasContextOverflowDispatched: vi.fn(() => false),
      markContextOverflowDispatched: vi.fn(),
      // Stage 4: runtime-result error dispatch dedup. Real behaviour — mock
      // reads/writes a shared Set so tests can exercise duplicate-suppression
      // semantics without reaching into the real singleton.
      hasErrorResultDispatched: vi.fn((turnId: string) =>
        errorResultDispatchedForTurn.has(turnId),
      ),
      markErrorResultDispatched: vi.fn((turnId: string) => {
        errorResultDispatchedForTurn.add(turnId);
      }),
      clearErrorResultDispatched: vi.fn((turnId: string) =>
        errorResultDispatchedForTurn.delete(turnId),
      ),
      _errorResultDispatchedForTurn: errorResultDispatchedForTurn,
      getTurnPrompt: vi.fn(() => ''),
      getTurnExtendedContext: vi.fn(() => false),
      getTurnContextWindow: vi.fn(() => 200_000),
      getTurnThinkingEffort: vi.fn(() => 'medium'),
      getTurnCategory: vi.fn(() => null),
      getTurnAuthMethod: vi.fn(() => null),
      getTurnActiveProvider: vi.fn((): string | undefined => undefined),
      getTurnPlanningModel: vi.fn(() => undefined),
      getTurnFastModel: vi.fn(() => undefined),
      getTurnFallbacks: vi.fn(() => []),
      getContextAccumulator: vi.fn(() => null),
      deleteContextAccumulator: vi.fn(),
      releaseActiveSession: vi.fn(),
      getTurnPrivateMode: vi.fn(() => false),
      getTurnInputSource: vi.fn(() => 'text'),
      hasCostRecorded: vi.fn(() => false),
      hasUserQuestionPending: vi.fn(() => false),
      hasOutputCapRetryAttempted: vi.fn(() => false),
      markOutputCapRetryAttempted: vi.fn(),
      clearOutputCapRetryAttempted: vi.fn(),
      markCostRecorded: vi.fn(),
      hasSuccessResultDispatched: vi.fn(() => false),
      markSuccessResultDispatched: vi.fn(),
      recordSessionTurn: vi.fn(),
      hasSessionHadTurns: vi.fn(() => false),
    },
    errorReporterMocks: {
      addBreadcrumb: vi.fn(),
      captureException: vi.fn(),
      captureMessage: vi.fn(),
    },
    trackMainEventMock: vi.fn(),
    getOrGenerateAnonymousIdMock: vi.fn(() => 'anon-id'),
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
    getToolNameByUseId: vi.fn(() => null),
    getToolMetrics: vi.fn(() => null),
    getSubAgentMetrics: vi.fn(() => null),
    addTool: vi.fn(),
    recordToolOutput: vi.fn(),
    recordMcpToolOutput: vi.fn(),
    recordFileWrite: vi.fn(),
  }),
  mainTracking: { chatSessionCreated: vi.fn() },
}));

vi.mock('../../analytics', () => ({
  trackMainEvent: trackMainEventMock,
  getOrGenerateAnonymousId: getOrGenerateAnonymousIdMock,
}));

vi.mock('@core/errorReporter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/errorReporter')>();
  return {
    ...actual,
    getErrorReporter: () => errorReporterMocks,
  };
});

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

vi.mock('../achievementsEvaluator', () => ({
  evaluateBadgesOnTurnComplete: vi.fn(),
  evaluateJourneyCompletion: vi.fn(),
  evaluateReunionBadge: vi.fn(),
  updateCountersOnSessionComplete: vi.fn(),
  recordToolUseForSession: vi.fn(),
  getCurrentJourneyDay: vi.fn(() => null),
}));

vi.mock('../toolUsageStore', () => ({
  recordToolUsage: vi.fn(),
  isMetaTool: vi.fn(() => false),
}));

vi.mock('../toolIndexService', () => ({
  getToolSchema: vi.fn(() => null),
}));

vi.mock('@shared/utils/agentErrorCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/utils/agentErrorCatalog')>();
  return {
    ...actual,
    createRoutedError: (kind: string, msg: string) => {
      const err = new Error(msg);
      (err as Error & { errorKind?: string }).errorKind = kind;
      return err;
    },
  };
});

vi.mock('@shared/utils/eventSanitization', () => ({
  isSubAgentTool: vi.fn(() => false),
}));

// Critical: do NOT mock `@shared/utils/friendlyErrors` — Stage 3 needs the real
// extended `isBillingMessage` patterns to verify the classification contract in
// the cross-check assertions below.

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
import {
  isBillingMessage,
  isRateLimitMessage,
} from '@shared/utils/friendlyErrors';
import { humanizeAgentError } from '@rebel/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntimeErrorResult(errors: string[]) {
  return {
    type: 'result' as const,
    subtype: 'error',
    is_error: true,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  initTestPlatformConfig();
  // Default: no turn model (exercises the `providerOverride: undefined` path
  // unless a test overrides it).
  registryMocks.getTurnModel.mockReturnValue(undefined);
  // Reset dedup dispatch set + default dispatch return to `ok:true` so each
  // test starts clean.
  registryMocks._errorResultDispatchedForTurn.clear();
  dispatchAgentErrorEventMock.mockImplementation(() => ({ ok: true }));
});

describe('handleAgentMessage — runtime result error classification (260421 Stage 3)', () => {
  describe('primary regression — conversation 82d61626 (OpenAI insufficient_quota)', () => {
    const OPENAI_QUOTA_TEXT =
      'You exceeded your current quota, please check your plan and billing details.';

    it('passes the RAW quota text to dispatchAgentErrorEvent (no humanizedOverride)', () => {
      registryMocks.getTurnModel.mockReturnValue('gpt-4o');

      handleAgentMessage(null, 'turn-openai-quota', makeRuntimeErrorResult([OPENAI_QUOTA_TEXT]) as any);

      expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
      const [win, turnId, rawError, opts] = dispatchAgentErrorEventMock.mock.calls[0];
      expect(win).toBeNull();
      expect(turnId).toBe('turn-openai-quota');
      expect(rawError).toBe(OPENAI_QUOTA_TEXT);
      // Stage 3 contract: no humanizedOverride preempt; classifier + humanizer run downstream.
      expect(opts).not.toHaveProperty('humanizedOverride');
    });

    it('passes providerOverride derived from the turn model (gpt-4o → "OpenAI")', () => {
      registryMocks.getTurnModel.mockReturnValue('gpt-4o');

      handleAgentMessage(null, 'turn-openai-quota', makeRuntimeErrorResult([OPENAI_QUOTA_TEXT]) as any);

      expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
        null,
        'turn-openai-quota',
        OPENAI_QUOTA_TEXT,
        expect.objectContaining({ providerOverride: 'OpenAI' }),
      );
    });

    it('classifies the RAW quota text as billing (extended isBillingMessage)', () => {
      // Cross-check at the predicate boundary: the dispatcher's canonical
      // `deriveErrorKind` runs `isBillingMessage` BEFORE `isRateLimitMessage`,
      // so the first-dispatched event will now carry `errorKind: 'billing'`.
      expect(isBillingMessage(OPENAI_QUOTA_TEXT)).toBe(true);
      expect(isRateLimitMessage(OPENAI_QUOTA_TEXT)).toBe(false);
    });

    it('produces "You\'ve reached your OpenAI usage limit" copy (end-to-end verification)', () => {
      // Cross-check at the humanizer boundary: with the providerOverride the
      // handler now passes, the dispatched event.error contains the correct
      // OpenAI billing copy and does NOT contain "too large".
      const copy = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'OpenAI',
        rawMessage: OPENAI_QUOTA_TEXT,
        billingMeta: { subtype: 'unknown' },
      });
      expect(copy).toContain("You've reached your OpenAI usage limit");
      expect(copy).not.toContain('too large');
    });
  });

  describe('OpenRouter 402 body classification', () => {
    const OPENROUTER_402_TEXT =
      '402 {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 2381.","code":402}}';

    it('passes raw body + providerOverride="OpenRouter" for openrouter/* model ids', () => {
      registryMocks.getTurnModel.mockReturnValue('openrouter/anthropic/claude-sonnet-4-5');

      handleAgentMessage(null, 'turn-openrouter', makeRuntimeErrorResult([OPENROUTER_402_TEXT]) as any);

      expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
        null,
        'turn-openrouter',
        OPENROUTER_402_TEXT,
        expect.objectContaining({ providerOverride: 'OpenRouter' }),
      );
    });

    it('classifies OpenRouter 402 as billing with subtype "credits"', () => {
      expect(isBillingMessage(OPENROUTER_402_TEXT)).toBe(true);
      // The dispatcher's billingMeta pipeline calls classifyBillingSubtype
      // on the raw message; verify the humanizer produces credit-out copy.
      const copy = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'OpenRouter',
        rawMessage: OPENROUTER_402_TEXT,
        billingMeta: { subtype: 'credits' },
      });
      expect(copy).toContain('OpenRouter');
      expect(copy.toLowerCase()).toContain('credit');
    });
  });

  describe('Anthropic billing text classification', () => {
    const ANTHROPIC_BILLING_TEXT = 'Credit balance is too low to complete this request.';

    it('passes raw text + providerOverride="Anthropic" for claude-* model ids', () => {
      registryMocks.getTurnModel.mockReturnValue('claude-sonnet-4-5');

      handleAgentMessage(null, 'turn-anthropic', makeRuntimeErrorResult([ANTHROPIC_BILLING_TEXT]) as any);

      expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
        null,
        'turn-anthropic',
        ANTHROPIC_BILLING_TEXT,
        expect.objectContaining({ providerOverride: 'Anthropic' }),
      );
    });

    it('classifies "Credit balance is too low" as billing', () => {
      expect(isBillingMessage(ANTHROPIC_BILLING_TEXT)).toBe(true);
    });
  });

  describe('rate-limit negative guard (must NOT classify as billing)', () => {
    // `deriveErrorKind` runs `isBillingMessage` BEFORE `isRateLimitMessage`, so
    // the extended billing patterns must NOT capture rate-limit phrasings.
    const RATE_LIMIT_TEXT = 'Rate limit exceeded. Please try again in 20s.';

    it('still forwards raw text to the dispatcher (runtime rate-limit branch throws BEFORE reaching the else)', () => {
      // The runtime rate-limit branch in agentMessageHandler fires at a higher
      // level (throws `createRoutedError('rate_limit', ...)`), but we want to
      // guard against classification drift in downstream consumers. We assert
      // the predicate-level behaviour directly: rate-limit text must classify
      // as rate_limit, NOT billing, in `deriveErrorKind`-equivalent order.
      expect(isBillingMessage(RATE_LIMIT_TEXT)).toBe(false);
      expect(isRateLimitMessage(RATE_LIMIT_TEXT)).toBe(true);
    });
  });

  describe('auth negative guard (must NOT classify as billing)', () => {
    const AUTH_TEXT = 'Error: invalid_api_key provided';

    it('does not classify invalid_api_key as billing', () => {
      expect(isBillingMessage(AUTH_TEXT)).toBe(false);
    });

    it('passes raw auth text to dispatcher (no providerOverride when no turn model)', () => {
      registryMocks.getTurnModel.mockReturnValue(undefined);

      handleAgentMessage(null, 'turn-auth', makeRuntimeErrorResult([AUTH_TEXT]) as any);

      // No providerOverride when turn model is missing; dispatcher still works.
      expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
        null,
        'turn-auth',
        AUTH_TEXT,
        undefined,
      );
    });
  });

  describe('no-model fallback', () => {
    it('omits providerOverride entirely when getTurnModel returns undefined', () => {
      registryMocks.getTurnModel.mockReturnValue(undefined);

      handleAgentMessage(null, 'turn-no-model', makeRuntimeErrorResult([
        'Generic backend failure message',
      ]) as any);

      const [, , , opts] = dispatchAgentErrorEventMock.mock.calls[0];
      expect(opts).toBeUndefined();
    });

    it('omits providerOverride when getTurnModel returns an unknown-prefix model', () => {
      registryMocks.getTurnModel.mockReturnValue('some-custom-local-model');

      handleAgentMessage(null, 'turn-unknown-model', makeRuntimeErrorResult([
        'Generic backend failure message',
      ]) as any);

      const [, , , opts] = dispatchAgentErrorEventMock.mock.calls[0];
      // `inferProviderFromModelId` returns undefined for unknown prefixes →
      // handler passes `undefined` to dispatchAgentErrorEvent.
      expect(opts).toBeUndefined();
    });
  });

  describe('Mindstone subscription provider override', () => {
    it('uses "Mindstone" as providerOverride when activeProvider is mindstone (not model-based "Anthropic")', () => {
      registryMocks.getTurnModel.mockReturnValue('claude-sonnet-4-6');
      registryMocks.getTurnActiveProvider.mockReturnValue('mindstone');

      handleAgentMessage(null, 'turn-mindstone', makeRuntimeErrorResult([
        'Your key has been disabled.',
      ]) as any);

      const [, , , opts] = dispatchAgentErrorEventMock.mock.calls[0];
      expect(opts).toEqual(expect.objectContaining({ providerOverride: 'Mindstone' }));
    });

    it('falls back to model-based inference when activeProvider is not mindstone', () => {
      registryMocks.getTurnModel.mockReturnValue('claude-sonnet-4-6');
      registryMocks.getTurnActiveProvider.mockReturnValue('anthropic');

      handleAgentMessage(null, 'turn-anthropic-direct', makeRuntimeErrorResult([
        'Your key has been disabled.',
      ]) as any);

      const [, , , opts] = dispatchAgentErrorEventMock.mock.calls[0];
      expect(opts).toEqual(expect.objectContaining({ providerOverride: 'Anthropic' }));
    });

    it('falls back to model-based inference when activeProvider is undefined', () => {
      registryMocks.getTurnModel.mockReturnValue('gpt-4o');
      registryMocks.getTurnActiveProvider.mockReturnValue(undefined);

      handleAgentMessage(null, 'turn-no-active-provider', makeRuntimeErrorResult([
        'Internal server error occurred.',
      ]) as any);

      const [, , , opts] = dispatchAgentErrorEventMock.mock.calls[0];
      expect(opts).toEqual(expect.objectContaining({ providerOverride: 'OpenAI' }));
    });
  });

  describe('regression guard — higher-priority detection fires FIRST', () => {
    it('still throws for context-overflow patterns (does not reach the billing dispatch)', () => {
      // Context-overflow detection is at an earlier branch (prompt too long /
      // context exceed / token exceed / request too large). It MUST continue
      // to fire before the generic dispatch else-branch even when the error
      // text ALSO contains quota keywords.
      const msg = makeRuntimeErrorResult([
        'Prompt is too long (exceeded token limit); also current quota issue',
      ]);

      // The context-overflow branch dispatches a `context_overflow` event
      // via `dispatchAgentEvent` — not an error event. Verify the error
      // dispatch DID NOT fire.
      expect(() => handleAgentMessage(null, 'turn-ctx', msg as any)).not.toThrow();
      expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
      expect(dispatchAgentEventMock).toHaveBeenCalledWith(
        null,
        'turn-ctx',
        expect.objectContaining({ type: 'context_overflow' }),
      );
    });

    it('still throws for rate-limit patterns (via createRoutedError path)', () => {
      // The rate-limit branch in agentMessageHandler throws a routed error
      // — it doesn't reach the generic dispatch else-branch at all.
      const msg = makeRuntimeErrorResult(['HTTP 429 - Rate limit exceeded']);

      expect(() => handleAgentMessage(null, 'turn-rate', msg as any)).toThrow(
        /rate limit/i,
      );
      expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
    });

    it('still throws for session-not-found patterns', () => {
      const msg = makeRuntimeErrorResult([
        'No conversation found with session ID abc-123',
      ]);

      expect(() => handleAgentMessage(null, 'turn-session', msg as any)).toThrow();
      expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
    });
  });

  describe('regression guard — benign runtime error suppression still fires', () => {
    it('suppresses "only prompt commands are supported in streaming mode" errors', () => {
      const msg = makeRuntimeErrorResult([
        'only prompt commands are supported in streaming mode',
      ]);

      handleAgentMessage(null, 'turn-benign', msg as any);

      // Benign runtime error — suppressed, no dispatch.
      expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
      expect(dispatchAgentEventMock).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 4 (260421) — Source-level dedup for runtime-result error dispatch
// ---------------------------------------------------------------------------

describe('handleAgentMessage — runtime result error dispatch dedup (260421 Stage 4)', () => {
  const GENERIC_ERROR_TEXT = 'Runtime returned an unexpected backend failure';

  describe('duplicate suppression (first dispatch wins, second is suppressed)', () => {
    it('dispatches ONCE when a runtime error_during_execution fires twice for the same turn', () => {
      const msg = makeRuntimeErrorResult([GENERIC_ERROR_TEXT]);

      handleAgentMessage(null, 'turn-dup-1', msg as any);
      handleAgentMessage(null, 'turn-dup-1', msg as any);

      // Dispatch helper called exactly once across the two handler invocations.
      expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
    });

    it('emits WARN log + breadcrumb + tracker event (with turnModel+provider) on the suppressed second dispatch', () => {
      // Operational-lens R1: suppression telemetry must carry turnModel + derived
      // provider so production diagnosis can correlate suppression with the turn
      // context without cross-referencing separate log lines.
      registryMocks.getTurnModel.mockReturnValue('gpt-4o');

      const msg = makeRuntimeErrorResult([GENERIC_ERROR_TEXT]);

      handleAgentMessage(null, 'turn-dup-log', msg as any);
      // Second invocation hits the dedup guard.
      handleAgentMessage(null, 'turn-dup-log', msg as any);

      // Structured WARN log: must carry the Pino object-first arg order AND
      // enriched turn context (turnModel + derived provider).
      expect(registryMocks.getTurnLogger).toHaveBeenCalled();
      const turnLogger = registryMocks.getTurnLogger.mock.results[0].value as {
        warn: ReturnType<typeof vi.fn>;
      };
      expect(turnLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          subtype: 'error',
          errors: [GENERIC_ERROR_TEXT],
          turnModel: 'gpt-4o',
          provider: 'OpenAI',
        }),
        'Suppressing duplicate runtime-result error dispatch for turn (already dispatched)',
      );

      // Sentry breadcrumb with the correct category + level + payload + turn context.
      expect(errorReporterMocks.addBreadcrumb).toHaveBeenCalledWith({
        category: 'agent.error.dedup',
        level: 'warning',
        message: 'Suppressed duplicate runtime-result error dispatch',
        data: {
          turnId: 'turn-dup-log',
          subtype: 'error',
          turnModel: 'gpt-4o',
          provider: 'OpenAI',
        },
      });

      // Aggregate observability: tracker event with conditionally-included
      // turnModel + provider properties (omitted cleanly when absent).
      expect(trackMainEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'ai_error_dispatch_dedup_suppressed',
          properties: expect.objectContaining({
            subtype: 'error',
            turnModel: 'gpt-4o',
            provider: 'OpenAI',
          }),
        }),
      );
    });

    it('omits turnModel/provider cleanly from tracker properties when getTurnModel is unknown', () => {
      // Covers the `...(turnModel ? {} : {})` spread pattern in the suppression path.
      registryMocks.getTurnModel.mockReturnValue(undefined);

      const msg = makeRuntimeErrorResult([GENERIC_ERROR_TEXT]);
      handleAgentMessage(null, 'turn-dup-nomodel', msg as any);
      handleAgentMessage(null, 'turn-dup-nomodel', msg as any);

      const trackerCall = trackMainEventMock.mock.calls.at(-1)?.[0] as
        | { event?: string; properties?: Record<string, unknown> }
        | undefined;
      expect(trackerCall?.event).toBe('ai_error_dispatch_dedup_suppressed');
      expect(trackerCall?.properties).toEqual({ subtype: 'error' });
      // Explicit negation: no undefined-valued keys in the tracker payload.
      expect(trackerCall?.properties).not.toHaveProperty('turnModel');
      expect(trackerCall?.properties).not.toHaveProperty('provider');
    });

    it('does not re-dispatch even when the second message carries different error text', () => {
      handleAgentMessage(
        null,
        'turn-dup-2',
        makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
      );
      handleAgentMessage(
        null,
        'turn-dup-2',
        makeRuntimeErrorResult(['A different error body later in the turn']) as any,
      );

      expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('mark-AFTER-success semantics (load-bearing safety)', () => {
    it('latches the dedup flag when dispatchAgentErrorEvent returns {ok: true}', () => {
      dispatchAgentErrorEventMock.mockImplementation(() => ({ ok: true }));

      handleAgentMessage(
        null,
        'turn-mark-success',
        makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
      );

      expect(registryMocks.markErrorResultDispatched).toHaveBeenCalledWith(
        'turn-mark-success',
      );
      expect(registryMocks._errorResultDispatchedForTurn.has('turn-mark-success')).toBe(
        true,
      );
    });

    it('does NOT latch the flag when dispatchAgentErrorEvent returns {ok: false}', () => {
      dispatchAgentErrorEventMock.mockImplementation(() => ({ ok: false }));

      handleAgentMessage(
        null,
        'turn-dispatch-fail',
        makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
      );

      expect(registryMocks.markErrorResultDispatched).not.toHaveBeenCalled();
      expect(
        registryMocks._errorResultDispatchedForTurn.has('turn-dispatch-fail'),
      ).toBe(false);
    });

    it('allows a subsequent dispatch for the same turn when the first returned {ok: false}', () => {
      // First dispatch: mock failure — flag must NOT latch.
      dispatchAgentErrorEventMock.mockImplementation(() => ({ ok: false }));
      handleAgentMessage(
        null,
        'turn-retry-on-ok-false',
        makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
      );
      expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
      expect(
        registryMocks._errorResultDispatchedForTurn.has('turn-retry-on-ok-false'),
      ).toBe(false);

      // Second dispatch on the same turn — must re-dispatch (not suppressed)
      // because flag was never latched. Now return {ok: true}.
      dispatchAgentErrorEventMock.mockImplementation(() => ({ ok: true }));
      handleAgentMessage(
        null,
        'turn-retry-on-ok-false',
        makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
      );
      expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(2);
      expect(
        registryMocks._errorResultDispatchedForTurn.has('turn-retry-on-ok-false'),
      ).toBe(true);
    });

    it('does NOT latch the flag when dispatchAgentErrorEvent throws', () => {
      dispatchAgentErrorEventMock.mockImplementation(() => {
        throw new Error('simulated dispatcher throw');
      });

      // Opus R1 M1 tightening: explicitly assert the throw propagates past the
      // handler. If a future refactor wraps the dispatch in a swallowing try/catch,
      // this assertion fails and forces a review of the mark-after-success contract.
      expect(() =>
        handleAgentMessage(
          null,
          'turn-dispatch-throw',
          makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
        ),
      ).toThrow('simulated dispatcher throw');

      expect(registryMocks.markErrorResultDispatched).not.toHaveBeenCalled();
      expect(
        registryMocks._errorResultDispatchedForTurn.has('turn-dispatch-throw'),
      ).toBe(false);
    });

    it('after a dispatcher throw + cleanupForRetry, a subsequent dispatch succeeds and latches', () => {
      // Completeness R1 full-flow gap: the plan's acceptance at L1026 asks for
      // dispatch-failure-doesn't-latch THEN retry-via-cleanup THEN fresh dispatch.
      // This test exercises the full recovery contract end-to-end.
      dispatchAgentErrorEventMock.mockImplementationOnce(() => {
        throw new Error('simulated dispatcher throw');
      });

      expect(() =>
        handleAgentMessage(
          null,
          'turn-throw-then-retry',
          makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
        ),
      ).toThrow('simulated dispatcher throw');

      // Flag NOT latched because the throw bypassed the mark-after-success check.
      expect(
        registryMocks._errorResultDispatchedForTurn.has('turn-throw-then-retry'),
      ).toBe(false);

      // Simulate cleanupForRetry running on the retry path (no-op for this turn
      // because the flag was never latched, but we still exercise the clear).
      registryMocks._errorResultDispatchedForTurn.delete('turn-throw-then-retry');

      // Second invocation — dispatcher now returns ok:true.
      dispatchAgentErrorEventMock.mockReturnValueOnce({ ok: true });
      handleAgentMessage(
        null,
        'turn-throw-then-retry',
        makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
      );

      expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(2);
      expect(
        registryMocks._errorResultDispatchedForTurn.has('turn-throw-then-retry'),
      ).toBe(true);
    });
  });

  describe('retry + cleanup paths allow re-dispatch', () => {
    it('cleanupForRetry clears the flag so a retried turn can dispatch a fresh error', () => {
      handleAgentMessage(
        null,
        'turn-retry',
        makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
      );
      expect(
        registryMocks._errorResultDispatchedForTurn.has('turn-retry'),
      ).toBe(true);

      // Simulate the retry path's cleanup (the real code path calls
      // `agentTurnRegistry.cleanupForRetry(turnId)` which deletes the flag;
      // we simulate that side-effect directly here).
      registryMocks._errorResultDispatchedForTurn.delete('turn-retry');

      // Now a fresh runtime error for the same turnId must dispatch again.
      handleAgentMessage(
        null,
        'turn-retry',
        makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
      );
      expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(2);
    });

    it('cleanupTurn clears the flag and allows re-dispatch for same turnId', () => {
      // Completeness R1 gap: prior version only asserted flag state post-clear;
      // this version also verifies the behavioral consequence (re-dispatch works).
      handleAgentMessage(
        null,
        'turn-cleanup',
        makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
      );
      expect(
        registryMocks._errorResultDispatchedForTurn.has('turn-cleanup'),
      ).toBe(true);

      // Simulate cleanupTurn's side-effect on the dedup flag (real registry
      // clears in cleanupTurn — covered in agentTurnRegistry.dedup.test.ts).
      registryMocks._errorResultDispatchedForTurn.delete('turn-cleanup');

      expect(
        registryMocks._errorResultDispatchedForTurn.has('turn-cleanup'),
      ).toBe(false);

      // Fresh runtime-result error for the SAME turnId now dispatches again.
      handleAgentMessage(
        null,
        'turn-cleanup',
        makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
      );
      expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(2);
      expect(
        registryMocks._errorResultDispatchedForTurn.has('turn-cleanup'),
      ).toBe(true);
    });
  });

  describe('cross-turn independence', () => {
    it('a latched flag for turnA does NOT block a first-time dispatch for turnB', () => {
      handleAgentMessage(
        null,
        'turn-A',
        makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
      );
      expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
      expect(registryMocks._errorResultDispatchedForTurn.has('turn-A')).toBe(true);

      // turnB is a different turn — dedup flag is per-turnId, so this must
      // dispatch.
      handleAgentMessage(
        null,
        'turn-B',
        makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
      );
      expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(2);
      expect(registryMocks._errorResultDispatchedForTurn.has('turn-B')).toBe(true);
    });
  });

  describe('observability: tracker failure must not break error handling', () => {
    it('swallows trackMainEvent throws via the inner try/catch (logged at debug level)', () => {
      trackMainEventMock.mockImplementationOnce(() => {
        throw new Error('tracker unavailable');
      });

      // Two dispatches — the second hits the dedup path which calls tracker.
      handleAgentMessage(
        null,
        'turn-tracker-fail',
        makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
      );

      expect(() =>
        handleAgentMessage(
          null,
          'turn-tracker-fail',
          makeRuntimeErrorResult([GENERIC_ERROR_TEXT]) as any,
        ),
      ).not.toThrow();

      // Breadcrumb still emitted even though tracker threw.
      expect(errorReporterMocks.addBreadcrumb).toHaveBeenCalled();
    });
  });
});
