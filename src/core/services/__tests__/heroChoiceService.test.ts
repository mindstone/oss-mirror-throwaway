import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupPromptService, teardownPromptService } from './helpers/promptTestSetup';
import { createModelNormalizationMock } from '@shared/__tests__/testModuleMocks';

const MockCodexDisconnectedBtsError = vi.hoisted(() =>
  class CodexDisconnectedBtsError extends Error {
    constructor() {
      super(
        'Background task cannot use the selected ChatGPT Pro model because ChatGPT Pro is not connected. ' +
        'Reconnect ChatGPT Pro in Settings or choose a different model for this task.'
      );
      this.name = 'CodexDisconnectedBtsError';
    }
  }
);

const logState = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockCallBts = vi.fn();
vi.mock('../behindTheScenesClient', () => ({
  callWithModelAuthAware: (...args: unknown[]) => mockCallBts(...args),
  getEffectiveModelName: () => 'claude-opus-4-7',
  CodexDisconnectedBtsError: MockCodexDisconnectedBtsError,
}));

vi.mock('@shared/utils/modelNormalization', () =>
  createModelNormalizationMock(
    { resolveModelConfigMock: vi.fn() },
    {
      modelSupportsExtendedContext: vi.fn((model: string) =>
        model.includes('opus-4-7') || model.includes('sonnet-4-6')),
    },
  ));

vi.mock('@shared/utils/safeJsonParse', () => ({
  safeJsonParseFromModelText: vi.fn((text: string) => {
    try {
      let candidate = text.trim();
      const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (fenceMatch) candidate = fenceMatch[1].trim();
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }),
}));

vi.mock('../heroChoiceContextAssembler', () => ({
  assembleHeroChoiceContext: vi.fn().mockResolvedValue('## Your Goals\n- Ship v2\n\n## Recent Sessions\nSome session data'),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => logState,
}));

// Import after mocks
import { generateHeroChoice } from '../heroChoiceService';
import { CodexDisconnectedBtsError } from '../behindTheScenesClient';
import type { HeroChoiceContextDeps } from '../heroChoiceContextAssembler';
import type { AppSettings } from '@shared/types';
import {
  installCaptureRecorder,
  resetErrorReporter,
} from './testUtils/errorReporterCapture';

const mockDeps: HeroChoiceContextDeps = {
  listSessionSummaries: () => [],
  loadSession: async () => null,
  getPersonalGoals: async () => null,
  getSkillSummaries: async () => [],
  getUseCases: () => [],
  getUpcomingEvents: () => [],
  getPastCandidates: () => [],
  timeZone: 'UTC',
};

const mockSettings = {
  behindTheScenesModel: 'claude-haiku-4-5',
  claude: { thinkingModel: 'claude-opus-4-7' },
} as unknown as AppSettings;

function makeValidResponse() {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        candidates: [
          {
            type: 'meeting_prep',
            headline: 'Prepare for standup with Alice',
            body: 'You have a standup in 2 hours.',
            actionLabel: 'Prepare now',
            actionPrompt: 'Help me prepare for my standup meeting with Alice',
            priority: 1,
            sourceSessionId: 'sess-123',
          },
          {
            type: 'coaching',
            headline: 'You ask great follow-up questions',
            body: 'Across your last 5 sessions, you consistently dig deeper.',
            actionLabel: 'Explore',
            actionPrompt: 'Tell me more about my questioning patterns',
            priority: 2,
          },
        ],
        weekSummary: 'Productive week — 12 sessions, mostly research and writing.',
      }),
    }],
    model: 'claude-sonnet-4-20250514',
    usage: { input_tokens: 50000, output_tokens: 500 },
  };
}

describe('heroChoiceService', () => {
  beforeEach(() => {
    setupPromptService();
    vi.clearAllMocks();
    resetErrorReporter();
  });

  afterEach(() => {
    teardownPromptService();
    resetErrorReporter();
  });

  it('returns a valid HeroChoiceResult with UUIDs on candidates', async () => {
    mockCallBts.mockResolvedValue(makeValidResponse());

    const result = await generateHeroChoice(mockDeps, mockSettings);
    expect(result).not.toBeNull();
    expect(result!.candidates).toHaveLength(2);
    expect(result!.weekSummary).toBe('Productive week — 12 sessions, mostly research and writing.');
    expect(result!.modelUsed).toBe('claude-sonnet-4-20250514');

    // Each candidate should have a UUID (not the raw source values)
    for (const c of result!.candidates) {
      expect(c.id).toMatch(/^[0-9a-f-]{36}$/);
    }

    // Sorted by priority
    expect(result!.candidates[0].priority).toBe(1);
    expect(result!.candidates[1].priority).toBe(2);
  });

  it('returns null when LLM returns empty response', async () => {
    mockCallBts.mockResolvedValue({ content: [], model: 'claude-sonnet-4-20250514' });
    const result = await generateHeroChoice(mockDeps, mockSettings);
    expect(result).toBeNull();
  });

  it('returns null when LLM returns malformed JSON', async () => {
    mockCallBts.mockResolvedValue({
      content: [{ type: 'text', text: 'This is not JSON at all' }],
      model: 'claude-sonnet-4-20250514',
    });
    const result = await generateHeroChoice(mockDeps, mockSettings);
    expect(result).toBeNull();
  });

  it('returns null when LLM response has no candidates', async () => {
    mockCallBts.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ candidates: [], weekSummary: 'Nothing' }) }],
      model: 'claude-sonnet-4-20250514',
    });
    const result = await generateHeroChoice(mockDeps, mockSettings);
    expect(result).toBeNull();
  });

  it('filters out invalid candidates', async () => {
    mockCallBts.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          candidates: [
            { type: 'coaching', headline: 'Valid one', body: 'body', actionLabel: 'act', actionPrompt: 'prompt', priority: 1 },
            { type: 'invalid_type', headline: 'Bad type', body: 'body', actionLabel: 'act', actionPrompt: 'prompt', priority: 2 },
            { headline: 'Missing type', body: 'body', actionLabel: 'act', actionPrompt: 'prompt', priority: 3 },
          ],
          weekSummary: 'Summary',
        }),
      }],
      model: 'claude-sonnet-4-20250514',
    });

    const result = await generateHeroChoice(mockDeps, mockSettings);
    expect(result).not.toBeNull();
    expect(result!.candidates).toHaveLength(1);
    expect(result!.candidates[0].type).toBe('coaching');
  });

  it('returns null when LLM call throws', async () => {
    mockCallBts.mockRejectedValue(new Error('API timeout'));
    const result = await generateHeroChoice(mockDeps, mockSettings);
    expect(result).toBeNull();
  });

  it('re-throws Codex-disconnected BTS errors after logging them', async () => {
    const blockedError = new CodexDisconnectedBtsError();
    const captured = installCaptureRecorder();
    mockCallBts.mockRejectedValue(blockedError);

    const action = generateHeroChoice(mockDeps, mockSettings);

    await expect(action).rejects.toBe(blockedError);
    expect(logState.error).toHaveBeenCalledWith(
      { reason: 'codex-profile-bts-blocked', caller: 'heroChoice' },
      'Hero choice BTS blocked'
    );
    expect(captured).toHaveLength(0);
  });

  it('provides fallback weekSummary when LLM omits it', async () => {
    mockCallBts.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          candidates: [
            { type: 'insight', headline: 'An insight', body: 'body', actionLabel: 'Explore', actionPrompt: 'prompt', priority: 1 },
          ],
          // weekSummary omitted
        }),
      }],
      model: 'claude-sonnet-4-20250514',
    });

    const result = await generateHeroChoice(mockDeps, mockSettings);
    expect(result).not.toBeNull();
    expect(result!.weekSummary).toBeTruthy();
  });

  it('preserves optional sourceSessionId and sourceSkill', async () => {
    mockCallBts.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          candidates: [
            {
              type: 'improvement',
              headline: 'Improve something',
              body: 'body',
              actionLabel: 'Improve',
              actionPrompt: 'prompt',
              priority: 1,
              sourceSessionId: 'sess-abc',
              sourceSkill: 'meeting-prep',
            },
          ],
          weekSummary: 'Summary',
        }),
      }],
      model: 'claude-sonnet-4-20250514',
    });

    const result = await generateHeroChoice(mockDeps, mockSettings);
    expect(result!.candidates[0].sourceSessionId).toBe('sess-abc');
    expect(result!.candidates[0].sourceSkill).toBe('meeting-prep');
  });

  it('keeps the generic null fallback for non-codex BTS errors', async () => {
    const captured = installCaptureRecorder();
    mockCallBts.mockRejectedValue(new Error('API timeout'));

    const result = await generateHeroChoice(mockDeps, mockSettings);

    expect(result).toBeNull();
    expect(logState.error).toHaveBeenCalledWith(
      { error: 'API timeout' },
      'Hero choice generation failed'
    );
    expect(captured).toHaveLength(0);
  });
});
