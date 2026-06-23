import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelError } from '@core/rebelCore/modelErrors';

const {
  mockLogger,
  mockCallBehindTheScenesWithAuth,
  mockCallWithModelAuthAware,
  mockBroadcastTimeSavedStatus,
  mockBroadcastCommunityShareEligible,
} = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  mockCallBehindTheScenesWithAuth: vi.fn(),
  mockCallWithModelAuthAware: vi.fn(),
  mockBroadcastTimeSavedStatus: vi.fn(),
  mockBroadcastCommunityShareEligible: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLogger,
}));

vi.mock('../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: (...args: unknown[]) => mockCallBehindTheScenesWithAuth(...args),
  callWithModelAuthAware: (...args: unknown[]) => mockCallWithModelAuthAware(...args),
  getEffectiveModelName: vi.fn(() => 'openrouter/test-model'),
}));

vi.mock('../timeSavedStore', () => ({
  // Returns a persisted-acceptance result by default so the analytics emit (now
  // gated on `{ added: true }`) runs on the success path.
  addTimeSavedEntry: vi.fn(() => ({ added: true, timestamp: Date.now() })),
}));

vi.mock('../../utils/authEnvUtils', () => ({
  hasValidAuth: vi.fn(() => true),
}));

vi.mock('@shared/utils/safeJsonParse', () => ({
  safeJsonParseFromModelText: vi.fn(),
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

describe('timeSavedService fail-quiet billing handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializeTimeSavedService({
      getSettings: () => ({ timeSavedEstimation: { enabled: true } } as any),
      broadcastTimeSavedStatus: (...args: unknown[]) => mockBroadcastTimeSavedStatus(...args),
      broadcastCommunityShareEligible: (...args: unknown[]) => mockBroadcastCommunityShareEligible(...args),
    });
  });

  it('logs a humanized billing error and only updates time-saved status', async () => {
    // Stage 7: classification-first humanization now produces subtype+provider-aware copy.
    // See docs/plans/260421_classification_driven_error_humanizer.md.
    const humanizedBillingError =
      'Your OpenRouter account has run out of credits. You can set up auto top-up in your OpenRouter settings to avoid this.';
    mockCallBehindTheScenesWithAuth.mockRejectedValue(
      new ModelError(
        'billing',
        'This request requires more credits, or fewer max_tokens.',
        402,
        'OpenRouter',
      ),
    );

    await triggerTimeSavedEstimation({
      turnId: 'turn-1',
      sessionId: 'session-1',
      userPrompt: 'Help me draft an email.',
      finalSummary: 'Drafted the email.',
      toolSummary: 'No tools used.',
      durationSeconds: 45,
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'turn-1',
        error: humanizedBillingError,
        status: undefined,
      }),
      'Time saved estimation failed',
    );
    expect(mockBroadcastTimeSavedStatus).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        turnId: 'turn-1',
        status: 'running',
      }),
    );
    expect(mockBroadcastTimeSavedStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        turnId: 'turn-1',
        status: 'error',
        error: humanizedBillingError,
      }),
    );
    expect(mockBroadcastCommunityShareEligible).not.toHaveBeenCalled();
  });
});
