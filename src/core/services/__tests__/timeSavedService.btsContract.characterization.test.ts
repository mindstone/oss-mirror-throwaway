/**
 * CHARACTERIZATION (behaviour-preserving) test net for the TimeSaved BTS consumer.
 *
 * Pins the CURRENT observable behaviour of `timeSavedService.ts` BEFORE it is
 * refactored into a per-use-case BTS client (CHIEF_ENGINEER2 Stage 4a, PoC #1).
 * These tests assert on what the service SENDS to the BTS dispatch seam and how
 * it PARSES the response — they mock `behindTheScenesClient` and never hit a live
 * model. If a test here fails after the refactor, the refactor changed observable
 * behaviour.
 *
 * Three pins (per the spike PoC plan §6):
 *  1. Wire-contract: the exact `outputFormat` JSON Schema sent to the BTS call
 *     today (all 7 fields in `required`, additionalProperties:false, category).
 *  2. Parse-success: a well-formed model response → the parsed estimate that is
 *     broadcast/persisted.
 *  3. Parse-resilience: malformed / non-JSON and missing-optional-field responses
 *     → the CURRENT fallback behaviour (terminal "unavailable" broadcast on
 *     parse_failure; `impact` defaults to 'medium' when missing).
 *
 * Seam mocked: `../behindTheScenesClient` (same seam as
 * timeSavedService.recover.test.ts).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TIME_SAVED_JSON_SCHEMA } from '../timeSavedService';

const {
  mockCallBehindTheScenesWithAuth,
  mockCallWithModelAuthAware,
  mockSafeJsonParseFromModelText,
  mockBroadcastTimeSavedStatus,
  mockBroadcastCommunityShareEligible,
  mockAddTimeSavedEntry,
  mockAddTimeSavedEntryAt,
  mockHasTimeSavedEntryForTurn,
} = vi.hoisted(() => ({
  mockCallBehindTheScenesWithAuth: vi.fn<(...args: unknown[]) => unknown>(),
  mockCallWithModelAuthAware: vi.fn<(...args: unknown[]) => unknown>(),
  mockSafeJsonParseFromModelText: vi.fn<(...args: unknown[]) => unknown>(),
  mockBroadcastTimeSavedStatus: vi.fn<(...args: unknown[]) => unknown>(),
  mockBroadcastCommunityShareEligible: vi.fn<(...args: unknown[]) => unknown>(),
  mockAddTimeSavedEntry: vi.fn<(...args: unknown[]) => unknown>(),
  mockAddTimeSavedEntryAt: vi.fn<(...args: unknown[]) => unknown>(() => ({ added: true, timestamp: 1 })),
  mockHasTimeSavedEntryForTurn: vi.fn<(...args: unknown[]) => boolean>(() => false),
}));

vi.mock('../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: (...args: unknown[]) => mockCallBehindTheScenesWithAuth(...args),
  callWithModelAuthAware: (...args: unknown[]) => mockCallWithModelAuthAware(...args),
  getEffectiveModelName: vi.fn(() => 'openrouter/test-model'),
}));

vi.mock('@shared/utils/safeJsonParse', () => ({
  safeJsonParseFromModelText: (...args: unknown[]) => mockSafeJsonParseFromModelText(...args),
}));

vi.mock('../timeSavedStore', () => ({
  addTimeSavedEntry: (...args: unknown[]) => mockAddTimeSavedEntry(...args),
  addTimeSavedEntryAt: (...args: unknown[]) => mockAddTimeSavedEntryAt(...args),
  hasTimeSavedEntryForTurn: (...args: unknown[]) => mockHasTimeSavedEntryForTurn(...args),
}));

vi.mock('../../utils/authEnvUtils', () => ({
  hasValidAuth: vi.fn(() => true),
}));

vi.mock('../communityShareService', () => ({
  checkSessionEligibility: vi.fn(() => null),
}));

vi.mock('../communityShareStore', () => ({
  isOptedOut: vi.fn(() => false),
  isSessionEvaluated: vi.fn(() => false),
  markSessionEvaluated: vi.fn(),
  getDailyCount: vi.fn(() => 0),
  incrementDailyCount: vi.fn(),
  storeEligibility: vi.fn(),
}));

import {
  initializeTimeSavedService,
  triggerTimeSavedEstimation,
  recoverTimeSavedEntryForTurn,
} from '../timeSavedService';

const baseContext = {
  turnId: 'turn-char-1',
  sessionId: 'session-char-1',
  userPrompt: 'Draft a customer update email.',
  finalSummary: 'Produced a structured 3-section update.',
  toolSummary: 'No tools used.',
  durationSeconds: 90,
};

/** A representative well-formed model response (all 7 fields present, valid enums). */
const WELL_FORMED = {
  estimate_minutes_low: 8,
  estimate_minutes_high: 14,
  confidence: 'medium' as const,
  task_type: 'writing' as const,
  reasoning: 'Drafted a customer update email.',
  reasoning_detail: 'Manual drafting plus edits.',
  impact: 'high' as const,
};

function lastBroadcast(): any {
  const calls = mockBroadcastTimeSavedStatus.mock.calls;
  return calls[calls.length - 1]?.[0];
}

describe('timeSavedService — BTS wire-contract & parse characterization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasTimeSavedEntryForTurn.mockReturnValue(false);
    mockAddTimeSavedEntry.mockReturnValue({ added: true, timestamp: 1 });
    mockAddTimeSavedEntryAt.mockReturnValue({ added: true, timestamp: 1 });
    initializeTimeSavedService({
      getSettings: () => ({ timeSavedEstimation: { enabled: true } } as any),
      broadcastTimeSavedStatus: (...args: unknown[]) => mockBroadcastTimeSavedStatus(...args),
      broadcastCommunityShareEligible: (...args: unknown[]) =>
        mockBroadcastCommunityShareEligible(...args),
    });
  });

  // ── Pin 1: WIRE CONTRACT (the critical one) ────────────────────────────────
  describe('wire contract: outputFormat sent to the BTS call', () => {
    it('exports a TIME_SAVED_JSON_SCHEMA with all 7 fields required + additionalProperties:false', () => {
      // This is the load-bearing wire contract the model sees today. A refactor
      // that derives the schema from a laxer source must reproduce this exactly.
      expect(TIME_SAVED_JSON_SCHEMA.type).toBe('object');
      expect((TIME_SAVED_JSON_SCHEMA as any).additionalProperties).toBe(false);
      expect((TIME_SAVED_JSON_SCHEMA as any).required).toEqual([
        'estimate_minutes_low',
        'estimate_minutes_high',
        'confidence',
        'task_type',
        'reasoning',
        'reasoning_detail',
        'impact',
      ]);
      // Enum + description detail is part of the wire contract too.
      expect((TIME_SAVED_JSON_SCHEMA as any).properties.confidence.enum).toEqual([
        'low',
        'medium',
        'high',
      ]);
      expect((TIME_SAVED_JSON_SCHEMA as any).properties.task_type.enum).toEqual([
        'research',
        'writing',
        'coordination',
        'analysis',
        'automation',
        'mixed',
      ]);
      expect((TIME_SAVED_JSON_SCHEMA as any).properties.impact.enum).toEqual([
        'trivial',
        'low',
        'medium',
        'high',
        'critical',
      ]);
    });

    it('passes exactly TIME_SAVED_JSON_SCHEMA as outputFormat.schema with category "timeSaved"', async () => {
      mockCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(WELL_FORMED) }],
        _resolvedModel: 'openrouter/test-model',
      });
      mockSafeJsonParseFromModelText.mockReturnValue(WELL_FORMED);

      await triggerTimeSavedEstimation(baseContext);

      expect(mockCallBehindTheScenesWithAuth).toHaveBeenCalledTimes(1);
      const [, requestOptions, tracking] = mockCallBehindTheScenesWithAuth.mock.calls[0] as [
        unknown,
        { outputFormat: { type: string; schema: unknown }; maxTokens: number; timeout: number },
        { category: string },
      ];
      // The schema sent on the wire is the exact exported constant — byte-for-byte.
      expect(requestOptions.outputFormat).toEqual({
        type: 'json_schema',
        schema: TIME_SAVED_JSON_SCHEMA,
      });
      expect(requestOptions.maxTokens).toBe(512);
      expect(requestOptions.timeout).toBe(30000);
      expect(tracking.category).toBe('timeSaved');
    });
  });

  // ── Pin 2: PARSE SUCCESS ───────────────────────────────────────────────────
  describe('parse-success', () => {
    it('parses a well-formed response into the broadcast/persisted estimate', async () => {
      mockCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(WELL_FORMED) }],
        _resolvedModel: 'openrouter/test-model',
      });
      mockSafeJsonParseFromModelText.mockReturnValue(WELL_FORMED);

      await triggerTimeSavedEstimation(baseContext);

      expect(mockAddTimeSavedEntry).toHaveBeenCalledWith(
        baseContext.turnId,
        baseContext.sessionId,
        {
          lowMinutes: 8,
          highMinutes: 14,
          confidence: 'medium',
          taskType: 'writing',
          reasoning: 'Drafted a customer update email.',
          reasoningDetail: 'Manual drafting plus edits.',
          impact: 'high',
        },
      );
      const success = lastBroadcast();
      expect(success.status).toBe('success');
      expect(success.estimate).toMatchObject({ lowMinutes: 8, highMinutes: 14, impact: 'high' });
    });
  });

  // ── Pin 3: PARSE RESILIENCE (capture current fallback, do not fix) ──────────
  describe('parse-resilience', () => {
    it('non-JSON response → terminal "error" broadcast (unavailable), no entry written', async () => {
      mockCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [{ type: 'text', text: 'not json at all' }],
        _resolvedModel: 'openrouter/test-model',
      });
      mockSafeJsonParseFromModelText.mockReturnValue(null);

      await triggerTimeSavedEstimation(baseContext);

      expect(mockAddTimeSavedEntry).not.toHaveBeenCalled();
      const broadcast = lastBroadcast();
      expect(broadcast.status).toBe('error');
      expect(broadcast.error).toBe('Time saved estimate unavailable for this turn.');
    });

    it('missing/invalid `impact` defaults to "medium" (current parser tolerance)', async () => {
      const missingImpact = { ...WELL_FORMED } as Record<string, unknown>;
      delete missingImpact.impact;
      mockCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(missingImpact) }],
        _resolvedModel: 'openrouter/test-model',
      });
      mockSafeJsonParseFromModelText.mockReturnValue(missingImpact);

      await triggerTimeSavedEstimation(baseContext);

      expect(mockAddTimeSavedEntry).toHaveBeenCalledWith(
        baseContext.turnId,
        baseContext.sessionId,
        expect.objectContaining({ impact: 'medium' }),
      );
    });

    it('valid JSON but missing required field (reasoning) → invalid_structure → one retry on DEFAULT_AUXILIARY_MODEL', async () => {
      // Current fallback policy (timeSavedService.ts:438-450): an invalid structure
      // on the primary model triggers exactly one retry via callWithModelAuthAware
      // against DEFAULT_AUXILIARY_MODEL. Pin that the retry happens.
      const noReasoning = { ...WELL_FORMED } as Record<string, unknown>;
      delete noReasoning.reasoning;
      mockCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(noReasoning) }],
        _resolvedModel: 'openrouter/test-model',
      });
      // Retry response: still invalid so we can assert the retry occurred without
      // depending on success-path persistence.
      mockCallWithModelAuthAware.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(noReasoning) }],
        _resolvedModel: 'auxiliary-model',
      });
      mockSafeJsonParseFromModelText.mockReturnValue(noReasoning);

      await triggerTimeSavedEstimation(baseContext);

      expect(mockCallWithModelAuthAware).toHaveBeenCalledTimes(1);
      const retryArgs = mockCallWithModelAuthAware.mock.calls[0] as unknown[];
      // 2nd positional arg is the model name.
      expect(typeof retryArgs[1]).toBe('string');
      expect(mockAddTimeSavedEntry).not.toHaveBeenCalled();
    });
  });

  // ── Pin 4: RESTORED-EDGE HARDENING (CHIEF_ENGINEER2 Stage 4b reviewer net) ──
  //
  // These three pins lock the highest-value behaviours the use-case-client
  // migration drifted on, then restored. Each assertion is cross-checked
  // against the HEAD (pre-PoC) implementation so a future client migration
  // cannot silently re-introduce the drift. Cited HEAD lines are from
  // `git show HEAD:src/core/services/timeSavedService.ts`.
  describe('restored-edge hardening', () => {
    // (i) Empty-string `reasoning` MUST be rejected as invalid_structure, never
    //     treated as a successful estimate. HEAD:338 rejected falsy reasoning
    //     via `!reasoning` (empty string is falsy → returned null → invalid).
    //     Observable: no entry is persisted and the parser reaches the
    //     invalid_structure fallback (one retry on the auxiliary model fires,
    //     mirroring the invalid_structure retry policy at parse-resilience Pin 3).
    it('(i) empty `reasoning` → invalid_structure (not success); no entry written, retry fires', async () => {
      const emptyReasoning = { ...WELL_FORMED, reasoning: '' } as Record<string, unknown>;
      mockCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(emptyReasoning) }],
        _resolvedModel: 'openrouter/test-model',
      });
      // Retry also empty so we land terminally on invalid_structure without
      // depending on success-path persistence.
      mockCallWithModelAuthAware.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(emptyReasoning) }],
        _resolvedModel: 'auxiliary-model',
      });
      mockSafeJsonParseFromModelText.mockReturnValue(emptyReasoning);

      await triggerTimeSavedEstimation(baseContext);

      // invalid_structure (not success) → exactly one retry, then no entry, terminal error broadcast.
      expect(mockCallWithModelAuthAware).toHaveBeenCalledTimes(1);
      expect(mockAddTimeSavedEntry).not.toHaveBeenCalled();
      expect(lastBroadcast().status).toBe('error');
    });

    // (ii) An explicit empty-string `reasoning_detail` MUST be preserved on the
    //      output, not coerced to undefined. HEAD:358 returned the value
    //      whenever `typeof response.reasoning_detail === 'string'` (an empty
    //      string satisfies that), so `reasoningDetail: ''` reached the store.
    //      Note: `reasoning` itself must be non-empty here (see (i)) so the
    //      record is a SUCCESS and we can observe the persisted detail.
    it('(ii) empty-string `reasoning_detail` is preserved as "" on the persisted estimate', async () => {
      const emptyDetail = { ...WELL_FORMED, reasoning_detail: '' } as Record<string, unknown>;
      mockCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(emptyDetail) }],
        _resolvedModel: 'openrouter/test-model',
      });
      mockSafeJsonParseFromModelText.mockReturnValue(emptyDetail);

      await triggerTimeSavedEstimation(baseContext);

      expect(mockCallWithModelAuthAware).not.toHaveBeenCalled();
      expect(mockAddTimeSavedEntry).toHaveBeenCalledWith(
        baseContext.turnId,
        baseContext.sessionId,
        expect.objectContaining({ reasoningDetail: '' }),
      );
    });

    // (iii) The invalid_structure `detail` string MUST be built from the RAW
    //       parsed payload (the model's actual JSON), not the post-normalize
    //       object. HEAD:385 built the detail from `parsed` (the raw parse) so
    //       a diagnostic key such as `malformed` present in the raw payload
    //       surfaces in the detail. We read the detail off the recover path's
    //       return value (the only call path that surfaces it directly).
    it('(iii) invalid_structure detail reflects the RAW payload (a malformed:true key surfaces)', async () => {
      // Missing several required fields → invalid_structure; includes a
      // distinctive `malformed` key so we can prove the RAW payload was used.
      const rawMalformed = { malformed: true, confidence: 'medium' } as Record<string, unknown>;
      mockCallBehindTheScenesWithAuth.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(rawMalformed) }],
        _resolvedModel: 'openrouter/test-model',
      });
      mockCallWithModelAuthAware.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(rawMalformed) }],
        _resolvedModel: 'auxiliary-model',
      });
      mockSafeJsonParseFromModelText.mockReturnValue(rawMalformed);

      const outcome = await recoverTimeSavedEntryForTurn(baseContext, 123);

      expect(outcome.status).toBe('invalid_structure');
      // `persisted` carries no `detail`; the failure branches do. Read it via
      // the broad union member shape rather than narrowing on a runtime expect.
      const detail = (outcome as { detail?: string }).detail;
      // RAW key:type pairs — `malformed:boolean` proves the raw (not normalized)
      // object drove the detail. The normalized object never carries `malformed`.
      expect(detail).toContain('malformed:boolean');
      expect(detail).not.toContain('estimate_minutes_low');
    });
  });
});
