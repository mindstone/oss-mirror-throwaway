 
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCallBehindTheScenesWithAuth,
  mockCallWithModelAuthAware,
  mockSafeJsonParseFromModelText,
  mockBroadcastTimeSavedStatus,
  mockBroadcastCommunityShareEligible,
} = vi.hoisted(() => ({
  mockCallBehindTheScenesWithAuth: vi.fn(),
  mockCallWithModelAuthAware: vi.fn(),
  mockSafeJsonParseFromModelText: vi.fn(),
  mockBroadcastTimeSavedStatus: vi.fn(),
  mockBroadcastCommunityShareEligible: vi.fn(),
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
  // Returns a persisted-acceptance result by default so the analytics emit (now
  // gated on `{ added: true }`) runs on the success path.
  addTimeSavedEntry: vi.fn(() => ({ added: true, timestamp: Date.now() })),
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
import type { AppSettings } from '@shared/types';
import { resolveBtsModel } from '@shared/utils/btsModelResolver';

const defaultSettings = { timeSavedEstimation: { enabled: true } } as AppSettings;

function initializeWithSettings(settings: AppSettings = defaultSettings): void {
  initializeTimeSavedService({
    getSettings: () => settings,
    broadcastTimeSavedStatus: (...args: unknown[]) => mockBroadcastTimeSavedStatus(...args),
    broadcastCommunityShareEligible: (...args: unknown[]) => mockBroadcastCommunityShareEligible(...args),
  });
}

describe('timeSavedService cross-session provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initializeWithSettings();
  });

  it('includes originalSessionId on running + success broadcasts', async () => {
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

    await triggerTimeSavedEstimation({
      turnId: 'turn-1',
      sessionId: 'session-1',
      userPrompt: 'Draft a customer update',
      finalSummary: 'Produced a polished draft',
      toolSummary: 'No tools',
      durationSeconds: 45,
    });

    expect(mockBroadcastTimeSavedStatus).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        turnId: 'turn-1',
        status: 'running',
        originalSessionId: 'session-1',
      }),
    );
    expect(mockBroadcastTimeSavedStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        turnId: 'turn-1',
        status: 'success',
        originalSessionId: 'session-1',
      }),
    );
  });

  it('includes originalSessionId on error broadcasts', async () => {
    mockCallBehindTheScenesWithAuth.mockRejectedValue(new Error('network down'));

    await triggerTimeSavedEstimation({
      turnId: 'turn-err',
      sessionId: 'session-err',
      userPrompt: 'Draft a note',
      finalSummary: 'Failed',
      toolSummary: 'No tools',
      durationSeconds: 45,
    });

    expect(mockBroadcastTimeSavedStatus).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        turnId: 'turn-err',
        status: 'running',
        originalSessionId: 'session-err',
      }),
    );
    expect(mockBroadcastTimeSavedStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        turnId: 'turn-err',
        status: 'error',
        originalSessionId: 'session-err',
      }),
    );
  });

  // Regression: docs-private/investigations/260520_time_saved_zero_or_missing.md.
  // The parse-null path previously returned early after emitting
  // `time_saved_unavailable`, leaving the renderer with no terminal status —
  // weekly aggregate consumers never refreshed and the modal hero rendered
  // unavailable data as a real `0 min`. The fix broadcasts a terminal `error`
  // status (still carrying originalSessionId) without persisting an entry.
  it('broadcasts a terminal error with originalSessionId when the model response cannot be parsed as JSON', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      content: [{ type: 'text', text: 'not actually json' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue(null);

    await triggerTimeSavedEstimation({
      turnId: 'turn-parse',
      sessionId: 'session-parse',
      userPrompt: 'Estimate this',
      finalSummary: 'Done',
      toolSummary: 'No tools',
      durationSeconds: 45,
    });

    expect(mockBroadcastTimeSavedStatus).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        turnId: 'turn-parse',
        status: 'running',
        originalSessionId: 'session-parse',
      }),
    );
    expect(mockBroadcastTimeSavedStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        turnId: 'turn-parse',
        status: 'error',
        originalSessionId: 'session-parse',
      }),
    );
    expect(mockBroadcastTimeSavedStatus).toHaveBeenCalledTimes(2);
  });

  it('retries schema-invalid responses with the timeSaved resolver output before broadcasting success', async () => {
    const settings = {
      timeSavedEstimation: { enabled: true },
      behindTheScenesOverrides: { coaching: 'model:deepseek/deepseek-v4-flash' },
    } as AppSettings;
    initializeWithSettings(settings);
    const fallbackModel = resolveBtsModel(settings, 'timeSaved');

    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      _resolvedModel: 'minimax/minimax-m2.7',
      content: [{ type: 'text', text: '{"malformed":true}' }],
    });
    mockCallWithModelAuthAware.mockResolvedValue({
      content: [{ type: 'text', text: '{"ok":true}' }],
    });
    mockSafeJsonParseFromModelText
      .mockReturnValueOnce({ malformed: true })
      .mockReturnValueOnce({
        estimate_minutes_low: 15,
        estimate_minutes_high: 25,
        confidence: 'medium',
        task_type: 'analysis',
        reasoning: 'Synthesized customer feedback',
        reasoning_detail: 'Manual synthesis and summary',
        impact: 'high',
      });

    await triggerTimeSavedEstimation({
      turnId: 'turn-schema-retry',
      sessionId: 'session-schema-retry',
      userPrompt: 'Summarize feedback',
      finalSummary: 'Produced a synthesis',
      toolSummary: 'No tools',
      durationSeconds: 45,
    });

    expect(mockCallWithModelAuthAware).toHaveBeenCalledTimes(1);
    expect(mockCallWithModelAuthAware).toHaveBeenCalledWith(
      settings,
      fallbackModel,
      expect.objectContaining({
        outputFormat: expect.objectContaining({ type: 'json_schema' }),
      }),
      expect.objectContaining({
        category: 'timeSaved',
        sessionId: 'session-schema-retry',
        turnId: 'turn-schema-retry',
      }),
    );
    expect(mockBroadcastTimeSavedStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        turnId: 'turn-schema-retry',
        status: 'success',
        originalSessionId: 'session-schema-retry',
        estimate: expect.objectContaining({
          lowMinutes: 15,
          highMinutes: 25,
          taskType: 'analysis',
          impact: 'high',
        }),
      }),
    );
  });

  it('accepts common schema variants from structured-output models without retrying', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      _resolvedModel: 'minimax/minimax-m2.7',
      content: [{ type: 'text', text: '{"ok":true}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({
      estimateMinutes: 18,
      confidence: 'Medium',
      taskType: 'analysis',
      summary: 'Synthesized interview notes into a reusable brief',
      impact: 'medium',
    });

    await triggerTimeSavedEstimation({
      turnId: 'turn-schema-variant',
      sessionId: 'session-schema-variant',
      userPrompt: 'Summarize notes',
      finalSummary: 'Produced a brief',
      toolSummary: 'No tools',
      durationSeconds: 45,
    });

    expect(mockCallWithModelAuthAware).not.toHaveBeenCalled();
    expect(mockBroadcastTimeSavedStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        turnId: 'turn-schema-variant',
        status: 'success',
        originalSessionId: 'session-schema-variant',
        estimate: expect.objectContaining({
          lowMinutes: 18,
          highMinutes: 18,
          confidence: 'medium',
          taskType: 'analysis',
        }),
      }),
    );
  });

  it('defaults missing task_type to mixed when the rest of the estimate is valid', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      _resolvedModel: 'claude-haiku-4-5',
      content: [{ type: 'text', text: '{"ok":true}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({
      estimate_minutes_low: 10,
      estimate_minutes_high: 20,
      confidence: 'medium',
      reasoning: 'Produced a reusable planning summary',
      reasoning_detail: 'Manual review and summary',
      impact: 'medium',
    });

    await triggerTimeSavedEstimation({
      turnId: 'turn-missing-task-type',
      sessionId: 'session-missing-task-type',
      userPrompt: 'Make a plan',
      finalSummary: 'Produced a plan',
      toolSummary: 'No tools',
      durationSeconds: 45,
    });

    expect(mockBroadcastTimeSavedStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        status: 'success',
        estimate: expect.objectContaining({
          lowMinutes: 10,
          highMinutes: 20,
          taskType: 'mixed',
        }),
      }),
    );
  });

  it('does not retry schema-invalid responses when the resolved model already matches the timeSaved resolver output', async () => {
    const settings = {
      timeSavedEstimation: { enabled: true },
      behindTheScenesModel: 'deepseek/deepseek-v4-flash',
    } as AppSettings;
    initializeWithSettings(settings);
    const fallbackModel = resolveBtsModel(settings, 'timeSaved');

    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      _resolvedModel: fallbackModel,
      content: [{ type: 'text', text: '{"malformed":true}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({ malformed: true });

    await triggerTimeSavedEstimation({
      turnId: 'turn-schema-default',
      sessionId: 'session-schema-default',
      userPrompt: 'Summarize feedback',
      finalSummary: 'Produced a synthesis',
      toolSummary: 'No tools',
      durationSeconds: 45,
    });

    expect(mockCallWithModelAuthAware).not.toHaveBeenCalled();
    expect(mockBroadcastTimeSavedStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        turnId: 'turn-schema-default',
        status: 'error',
        originalSessionId: 'session-schema-default',
      }),
    );
  });
});
