import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateSafetyPrompt, resetForTesting, shouldAllow } from '@core/safetyPromptLogic';
import type { ActionContext, SafetyEvalResult } from '@core/safetyPromptTypes';

const mocks = vi.hoisted(() => ({
  callLlm: vi.fn(),
  getSafetyPrompt: vi.fn(),
  getSafetyPromptVersion: vi.fn(),
  getSettings: vi.fn(),
  isMigrationComplete: vi.fn(),
}));

vi.mock('@core/safetyEvaluationService', () => ({
  getSafetyEvaluationService: vi.fn(() => ({
    callLlm: mocks.callLlm,
  })),
}));

vi.mock('@core/safetyPromptStore', () => ({
  getSafetyPrompt: mocks.getSafetyPrompt,
  getSafetyPromptVersion: mocks.getSafetyPromptVersion,
  isMigrationComplete: mocks.isMigrationComplete,
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: mocks.getSettings,
}));

vi.mock('@core/services/promptFileService', () => ({
  PROMPT_IDS: {
    SAFETY_EVAL_SYSTEM: 'safety/eval-system',
  },
  getPrompt: vi.fn(() => 'Safety eval system prompt'),
}));

describe('conversation trace replay — consensus wiring through shouldAllow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetForTesting();
    mocks.getSafetyPrompt.mockReturnValue('PROMPT');
    mocks.getSafetyPromptVersion.mockReturnValue(1);
    mocks.getSettings.mockReturnValue({ safetyEvalBlockConsensus: true });
    mocks.isMigrationComplete.mockReturnValue(true);
  });

  it('runs consensus overturn through evaluateSafetyPrompt before shouldAllow', async () => {
    const memoryContext: ActionContext = {
      toolName: 'memory_write',
      toolInput: {
        spaceName: 'General',
        filePath: '/product/handoff-notes.md',
        content: 'Routine handoff note',
        sharing: 'shared',
      },
      toolDescription: 'Write a note into a memory space.',
      userMessage: 'Save this handoff note to General so everyone can reference it.',
    };

    mocks.callLlm
      .mockResolvedValueOnce({
        text: JSON.stringify({
          decision: 'block',
          confidence: 'low',
          reason: 'Primary uncertain block before consensus.',
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          decision: 'allow',
          confidence: 'medium',
          reason: 'Consensus confirmation 1 allows the routine memory write.',
        }),
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          decision: 'allow',
          confidence: 'high',
          reason: 'Consensus confirmation 2 allows the routine memory write.',
        }),
      });

    const result = await evaluateSafetyPrompt('PROMPT', 1, memoryContext);

    expect(mocks.callLlm).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      decision: 'allow',
      confidence: 'medium',
      reason: 'Consensus confirmation 1 allows the routine memory write.',
    });
    expect(shouldAllow(result, 'memory_write')).toBe(true);
  });

  it('auto-allows non-side-effect tool when consensus overturns to allow/medium', () => {
    const consensusOverturn: SafetyEvalResult = {
      decision: 'allow',
      confidence: 'medium',
      reason: 'Consensus overturned uncertain block for a routine memory write.',
    };

    expect(shouldAllow(consensusOverturn, 'memory_write')).toBe(true);
  });

  it('keeps side-effect floor when consensus overturns to allow/low', () => {
    const consensusOverturnLowConfidence: SafetyEvalResult = {
      decision: 'allow',
      confidence: 'low',
      reason: 'Consensus overturned uncertain block but confidence stayed low.',
    };

    expect(shouldAllow(consensusOverturnLowConfidence, 'slack_send_message')).toBe(false);
  });

  it('keeps genuine blocks blocked when consensus holds', () => {
    const consensusHeldBlock: SafetyEvalResult = {
      decision: 'block',
      confidence: 'low',
      reason: 'Consensus held: split or both confirmations blocked.',
    };

    expect(shouldAllow(consensusHeldBlock, 'memory_write')).toBe(false);
    expect(shouldAllow(consensusHeldBlock, 'slack_send_message')).toBe(false);
  });
});
