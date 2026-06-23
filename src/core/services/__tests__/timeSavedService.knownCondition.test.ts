import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelError } from '@core/rebelCore/modelErrors';

const {
  mockCaptureKnownCondition,
  mockCallBehindTheScenesWithAuth,
  mockCallWithModelAuthAware,
  mockSafeJsonParseFromModelText,
  mockBroadcastTimeSavedStatus,
  mockBroadcastCommunityShareEligible,
} = vi.hoisted(() => ({
  mockCaptureKnownCondition: vi.fn(),
  mockCallBehindTheScenesWithAuth: vi.fn(),
  mockCallWithModelAuthAware: vi.fn(),
  mockSafeJsonParseFromModelText: vi.fn(),
  mockBroadcastTimeSavedStatus: vi.fn(),
  mockBroadcastCommunityShareEligible: vi.fn(),
}));

 
vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: (...args: unknown[]) => mockCaptureKnownCondition(...args),
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
  safeJsonParseFromModelText: (...args: unknown[]) => mockSafeJsonParseFromModelText(...args),
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

const baseContext = {
  turnId: 'turn-1',
  sessionId: 'session-1',
  userPrompt: 'Help me draft an email.',
  finalSummary: 'Drafted the email.',
  toolSummary: 'No tools used.',
  durationSeconds: 45,
};

describe('timeSavedService — known_condition emits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializeTimeSavedService({
      getSettings: () => ({ timeSavedEstimation: { enabled: true } } as any),
      broadcastTimeSavedStatus: (...args: unknown[]) => mockBroadcastTimeSavedStatus(...args),
      broadcastCommunityShareEligible: (...args: unknown[]) => mockBroadcastCommunityShareEligible(...args),
    });
  });

  it('emits time_saved_unavailable with reason=parse_failure when JSON parse returns null', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      content: [{ type: 'text', text: 'not actually json' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue(null);

    await triggerTimeSavedEstimation(baseContext);

    expect(mockCaptureKnownCondition).toHaveBeenCalledTimes(1);
    expect(mockCaptureKnownCondition).toHaveBeenCalledWith(
      'time_saved_unavailable',
      expect.objectContaining({
        extra: expect.objectContaining({
          sessionId: 'session-1',
          turnId: 'turn-1',
          reason: 'parse_failure',
        }),
      }),
    );
  });

  it('emits time_saved_unavailable with reason=invalid_structure when estimate parsing yields null', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      content: [{ type: 'text', text: '{}' }],
    });
    mockCallWithModelAuthAware.mockResolvedValue({
      content: [{ type: 'text', text: '{}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({ malformed: true });

    await triggerTimeSavedEstimation(baseContext);

    const conditions = mockCaptureKnownCondition.mock.calls.map((args) => args[0]);
    expect(conditions).toContain('time_saved_unavailable');
    const invalidCall = mockCaptureKnownCondition.mock.calls.find(
      (args) => (args[1] as { extra?: { reason?: string } })?.extra?.reason === 'invalid_structure',
    );
    expect(invalidCall).toBeDefined();
  });

  it('emits time_saved_unavailable with reason=error when the LLM call rejects', async () => {
    mockCallBehindTheScenesWithAuth.mockRejectedValue(
      new ModelError(
        'billing',
        'Out of credits.',
        402,
        'OpenRouter',
      ),
    );

    await triggerTimeSavedEstimation(baseContext);

    expect(mockCaptureKnownCondition).toHaveBeenCalledWith(
      'time_saved_unavailable',
      expect.objectContaining({
        extra: expect.objectContaining({
          sessionId: 'session-1',
          turnId: 'turn-1',
          reason: 'error',
        }),
      }),
    );
  });

  it('does NOT emit a duplicate error emit when invalid_structure path falls through to catch', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      content: [{ type: 'text', text: '{}' }],
    });
    mockCallWithModelAuthAware.mockResolvedValue({
      content: [{ type: 'text', text: '{}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({ malformed: true });

    await triggerTimeSavedEstimation(baseContext);

    const reasons = mockCaptureKnownCondition.mock.calls.map(
      (args) => (args[1] as { extra?: { reason?: string } })?.extra?.reason,
    );
    expect(reasons.filter((r) => r === 'error')).toHaveLength(0);
    expect(reasons.filter((r) => r === 'invalid_structure')).toHaveLength(1);
  });

  it('survives a captureKnownCondition throw (defensive wrap)', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      content: [{ type: 'text', text: 'not json' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue(null);
    mockCaptureKnownCondition.mockImplementation(() => {
      throw new Error('reporter exploded');
    });

    await expect(triggerTimeSavedEstimation(baseContext)).resolves.toBeUndefined();
    expect(mockCaptureKnownCondition).toHaveBeenCalledTimes(1);
  });
});
