/**
 * Tests for `recoverTimeSavedEntryForTurn` — the backfill recovery entry
 * point added in docs-private/investigations/260520_time_saved_zero_or_missing.md
 * (implementation notes).
 *
 * The shape mirrors `timeSavedService.crossSession.test.ts` to keep mocks
 * consistent. The recovery path's contract is:
 *   - Same gating as the live trigger (disabled, short turn, no auth).
 *   - Per-turn dedup before running the LLM.
 *   - Same BTS estimator + schema-invalid fallback policy.
 *   - On success, writes a timestamp-preserving entry via addTimeSavedEntryAt.
 *   - Does NOT broadcast (no live UI for past turns).
 *   - Does NOT trigger community-share evaluation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCallBehindTheScenesWithAuth,
  mockCallWithModelAuthAware,
  mockSafeJsonParseFromModelText,
  mockBroadcastTimeSavedStatus,
  mockBroadcastCommunityShareEligible,
  mockAddTimeSavedEntryAt,
  mockHasTimeSavedEntryForTurn,
  mockAddTimeSavedEntry,
} = vi.hoisted(() => ({
  mockCallBehindTheScenesWithAuth: vi.fn<(...args: unknown[]) => unknown>(),
  mockCallWithModelAuthAware: vi.fn<(...args: unknown[]) => unknown>(),
  mockSafeJsonParseFromModelText: vi.fn<(...args: unknown[]) => unknown>(),
  mockBroadcastTimeSavedStatus: vi.fn<(...args: unknown[]) => unknown>(),
  mockBroadcastCommunityShareEligible: vi.fn<(...args: unknown[]) => unknown>(),
  mockAddTimeSavedEntryAt: vi.fn<(...args: unknown[]) => { added: boolean; timestamp?: number; reason?: string }>(
    () => ({ added: true, timestamp: 1_700_000_000_000 }),
  ),
  mockHasTimeSavedEntryForTurn: vi.fn<(...args: unknown[]) => boolean>(() => false),
  mockAddTimeSavedEntry: vi.fn<(...args: unknown[]) => unknown>(),
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

import { initializeTimeSavedService, recoverTimeSavedEntryForTurn } from '../timeSavedService';

const baseContext = {
  turnId: 'turn-recover-1',
  sessionId: 'session-recover-1',
  userPrompt: 'Summarise the proposal.',
  finalSummary: 'Produced a structured 3-section summary.',
  toolSummary: 'No tools used.',
  durationSeconds: 90,
};

const ORIGINAL_TS = new Date('2026-04-22T10:00:00.000Z').getTime();

describe('recoverTimeSavedEntryForTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasTimeSavedEntryForTurn.mockReturnValue(false);
    mockAddTimeSavedEntryAt.mockReturnValue({ added: true, timestamp: ORIGINAL_TS });
    initializeTimeSavedService({
      getSettings: () => ({ timeSavedEstimation: { enabled: true } } as any),
      broadcastTimeSavedStatus: (...args: unknown[]) => mockBroadcastTimeSavedStatus(...args),
      broadcastCommunityShareEligible: (...args: unknown[]) => mockBroadcastCommunityShareEligible(...args),
    });
  });

  it('persists a timestamp-preserving entry on success and does NOT broadcast cross-session status', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      content: [{ type: 'text', text: '{"ok":true}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({
      estimate_minutes_low: 8,
      estimate_minutes_high: 14,
      confidence: 'medium',
      task_type: 'writing',
      reasoning: 'Drafted a customer update email.',
      reasoning_detail: 'Manual drafting + edits.',
      impact: 'medium',
    });

    const outcome = await recoverTimeSavedEntryForTurn(baseContext, ORIGINAL_TS);

    expect(outcome.status).toBe('persisted');
    expect(mockAddTimeSavedEntryAt).toHaveBeenCalledWith(
      baseContext.turnId,
      baseContext.sessionId,
      expect.objectContaining({ lowMinutes: 8, highMinutes: 14, impact: 'medium' }),
      ORIGINAL_TS,
    );
    expect(mockBroadcastTimeSavedStatus).not.toHaveBeenCalled();
    expect(mockBroadcastCommunityShareEligible).not.toHaveBeenCalled();
  });

  it('skips BEFORE the LLM call when the store already has an entry for the turn', async () => {
    mockHasTimeSavedEntryForTurn.mockReturnValue(true);
    const outcome = await recoverTimeSavedEntryForTurn(baseContext, ORIGINAL_TS);
    expect(outcome.status).toBe('skipped_duplicate');
    expect(mockCallBehindTheScenesWithAuth).not.toHaveBeenCalled();
    expect(mockAddTimeSavedEntryAt).not.toHaveBeenCalled();
  });

  it('skips when the turn is too short, never calls the LLM', async () => {
    const outcome = await recoverTimeSavedEntryForTurn({ ...baseContext, durationSeconds: 5 }, ORIGINAL_TS);
    expect(outcome.status).toBe('skipped_short');
    expect(mockCallBehindTheScenesWithAuth).not.toHaveBeenCalled();
  });

  it('returns parse_failure status without throwing when the model response cannot be JSON-parsed', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      content: [{ type: 'text', text: 'not actually json' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue(null);

    const outcome = await recoverTimeSavedEntryForTurn(baseContext, ORIGINAL_TS);
    expect(outcome.status).toBe('parse_failure');
    expect(mockAddTimeSavedEntryAt).not.toHaveBeenCalled();
  });

  it('forwards a duplicate-write outcome from the store layer back to the caller', async () => {
    // Race: scan-time pre-check said "no entry", but a concurrent writer
    // (another agent) raced in and inserted an entry before our write
    // landed. The store-level dedup is the authoritative gate.
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      content: [{ type: 'text', text: '{"ok":true}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({
      estimate_minutes_low: 8,
      estimate_minutes_high: 14,
      confidence: 'medium',
      task_type: 'writing',
      reasoning: 'ok',
      reasoning_detail: 'ok',
      impact: 'medium',
    });
    mockAddTimeSavedEntryAt.mockReturnValue({ added: false, reason: 'duplicate' });

    const outcome = await recoverTimeSavedEntryForTurn(baseContext, ORIGINAL_TS);
    expect(outcome.status).toBe('skipped_duplicate');
  });
});
