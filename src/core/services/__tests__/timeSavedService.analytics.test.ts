/**
 * Tests for the per-turn `Time Saved Estimated` analytics event
 * (Stage 2 of docs/plans/260614_client-surface-analytics-tagging/PLAN.md).
 *
 * Contract:
 *   - On a successful estimate, `triggerTimeSavedEstimation` emits exactly ONE
 *     `Time Saved Estimated` event via the shared tracker (single emit site →
 *     no double-count across surfaces; mobile turns execute on cloud).
 *   - The event carries categorical/metric props only (lowMinutes, highMinutes,
 *     taskType, confidence, impact, turnId, sessionId) — NO free-text
 *     reasoning / reasoningDetail.
 *   - `client_surface` is NOT manually added here (it attaches via the
 *     analytics context-provider merge in trackMainEvent).
 *   - Emission is gated on `tracker.isAvailable()` and is fire-and-forget: a
 *     throwing tracker never breaks the turn path.
 *
 * The shape mirrors timeSavedService.crossSession.test.ts to keep mocks
 * consistent; the tracker is wired via the real `setTracker` singleton.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCallBehindTheScenesWithAuth,
  mockCallWithModelAuthAware,
  mockSafeJsonParseFromModelText,
  mockBroadcastTimeSavedStatus,
  mockBroadcastCommunityShareEligible,
  mockAddTimeSavedEntry,
} = vi.hoisted(() => ({
  mockCallBehindTheScenesWithAuth: vi.fn(),
  mockCallWithModelAuthAware: vi.fn(),
  mockSafeJsonParseFromModelText: vi.fn(),
  mockBroadcastTimeSavedStatus: vi.fn(),
  mockBroadcastCommunityShareEligible: vi.fn(),
  mockAddTimeSavedEntry: vi.fn(),
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

import { initializeTimeSavedService, triggerTimeSavedEstimation } from '../timeSavedService';
import { setTracker, type Tracker } from '@core/tracking';
import type { AppSettings } from '@shared/types';

const defaultSettings = { timeSavedEstimation: { enabled: true } } as AppSettings;

const baseContext = {
  turnId: 'turn-ts-1',
  sessionId: 'session-ts-1',
  userPrompt: 'Draft a customer update',
  finalSummary: 'Produced a polished draft',
  toolSummary: 'No tools',
  durationSeconds: 45,
};

function mockSuccessfulEstimate(): void {
  mockCallBehindTheScenesWithAuth.mockResolvedValue({
    content: [{ type: 'text', text: '{"ok":true}' }],
  });
  mockSafeJsonParseFromModelText.mockReturnValue({
    estimate_minutes_low: 7,
    estimate_minutes_high: 12,
    confidence: 'medium',
    task_type: 'writing',
    reasoning: 'Drafted a customer update email',
    reasoning_detail: 'Manual drafting + edits',
    impact: 'medium',
  });
}

describe('timeSavedService — Time Saved Estimated analytics event', () => {
  let trackMock: ReturnType<typeof vi.fn<(event: string, properties?: Record<string, unknown>) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: the store accepted (persisted) the entry. The emit is gated on
    // this — individual tests override with `{ added: false, ... }` to assert
    // the no-emit-on-rejected-write guardrail.
    mockAddTimeSavedEntry.mockReturnValue({ added: true, timestamp: 1_700_000_000_000 });
    initializeTimeSavedService({
      getSettings: () => defaultSettings,
      broadcastTimeSavedStatus: (...args: unknown[]) => mockBroadcastTimeSavedStatus(...args),
      broadcastCommunityShareEligible: (...args: unknown[]) => mockBroadcastCommunityShareEligible(...args),
    });
    trackMock = vi.fn<(event: string, properties?: Record<string, unknown>) => void>();
    const tracker: Tracker = {
      track: (event, properties) => trackMock(event, properties),
      identify: vi.fn(),
      getAnonymousId: () => 'anon-test',
      isAvailable: () => true,
    };
    setTracker(tracker);
  });

  it('emits exactly one Time Saved Estimated event with categorical/metric props (no free text) on success', async () => {
    mockSuccessfulEstimate();

    await triggerTimeSavedEstimation(baseContext);

    const timeSavedCalls = trackMock.mock.calls.filter((c) => c[0] === 'Time Saved Estimated');
    expect(timeSavedCalls).toHaveLength(1);

    const [, props] = timeSavedCalls[0] as [string, Record<string, unknown>];
    expect(props).toEqual({
      turnId: 'turn-ts-1',
      sessionId: 'session-ts-1',
      lowMinutes: 7,
      highMinutes: 12,
      taskType: 'writing',
      confidence: 'medium',
      impact: 'medium',
    });

    // No free-text reasoning leaks into analytics.
    expect(props).not.toHaveProperty('reasoning');
    expect(props).not.toHaveProperty('reasoningDetail');
    // client_surface is NOT added here — it attaches via the context-provider merge.
    expect(props).not.toHaveProperty('client_surface');
  });

  it('carries the normalizer default impact (medium) when the model omits impact', async () => {
    // The live normalizer defaults a missing impact to 'medium'
    // (timeSavedService normalizeTimeSavedModelResponse), so the per-turn
    // event always carries an impact dimension on the real path. The emit's
    // `...(estimate.impact ? {} : {})` guard is defensive (impact is typed
    // optional on TimeSavedEstimate) but unreachable from this path.
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      content: [{ type: 'text', text: '{"ok":true}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({
      estimate_minutes_low: 5,
      estimate_minutes_high: 9,
      confidence: 'low',
      task_type: 'research',
      reasoning: 'Looked up a figure.',
      reasoning_detail: 'Manual lookup.',
      // no impact field — normalizer fills 'medium'
    });

    await triggerTimeSavedEstimation(baseContext);

    const timeSavedCalls = trackMock.mock.calls.filter((c) => c[0] === 'Time Saved Estimated');
    expect(timeSavedCalls).toHaveLength(1);
    const [, props] = timeSavedCalls[0] as [string, Record<string, unknown>];
    expect(props.impact).toBe('medium');
    expect(props.taskType).toBe('research');
  });

  it('does NOT emit when the tracker is unavailable', async () => {
    setTracker({
      track: (event, properties) => trackMock(event, properties),
      identify: vi.fn(),
      getAnonymousId: () => 'anon-test',
      isAvailable: () => false,
    });
    mockSuccessfulEstimate();

    await triggerTimeSavedEstimation(baseContext);

    expect(trackMock.mock.calls.filter((c) => c[0] === 'Time Saved Estimated')).toHaveLength(0);
  });

  it('does NOT emit when the turn produced no estimate (parse failure) — no double/spurious counts', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      content: [{ type: 'text', text: 'not json' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue(null);

    await triggerTimeSavedEstimation(baseContext);

    expect(trackMock.mock.calls.filter((c) => c[0] === 'Time Saved Estimated')).toHaveLength(0);
  });

  it('does NOT emit when the store rejected the write as a same-turn duplicate (no double-count)', async () => {
    // F1 guardrail: the live store rejects a second write for the same turnId
    // (`{ added: false, reason: 'duplicate' }`). The analytics event must gate
    // on persisted acceptance, so a duplicate write produces NO emit — one
    // event per persisted turn, never a double-count on a retried turn.
    mockAddTimeSavedEntry.mockReturnValue({ added: false, reason: 'duplicate' });
    mockSuccessfulEstimate();

    await triggerTimeSavedEstimation(baseContext);

    expect(trackMock.mock.calls.filter((c) => c[0] === 'Time Saved Estimated')).toHaveLength(0);
    // The turn path still completes with a success broadcast.
    expect(mockBroadcastTimeSavedStatus).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'turn-ts-1', status: 'success' }),
    );
  });

  it('does NOT emit when the store is in read-only mode (write rejected)', async () => {
    // F1 guardrail: protective read-only mode rejects the write
    // (`{ added: false, reason: 'read_only' }`). No persisted entry → no emit.
    mockAddTimeSavedEntry.mockReturnValue({ added: false, reason: 'read_only' });
    mockSuccessfulEstimate();

    await triggerTimeSavedEstimation(baseContext);

    expect(trackMock.mock.calls.filter((c) => c[0] === 'Time Saved Estimated')).toHaveLength(0);
  });

  it('is fire-and-forget: a throwing tracker does not break the turn path (success broadcast still fires)', async () => {
    setTracker({
      track: () => {
        throw new Error('tracker boom');
      },
      identify: vi.fn(),
      getAnonymousId: () => 'anon-test',
      isAvailable: () => true,
    });
    mockSuccessfulEstimate();

    await expect(triggerTimeSavedEstimation(baseContext)).resolves.toBeUndefined();
    // The turn path completed: the success status broadcast still fired.
    expect(mockBroadcastTimeSavedStatus).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'turn-ts-1', status: 'success' }),
    );
  });
});
