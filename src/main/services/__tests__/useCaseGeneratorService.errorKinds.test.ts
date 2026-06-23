import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelError } from '@core/rebelCore/modelErrors';

const mockRealpath = vi.fn();
const mockReadFile = vi.fn();
const mockMessagesCreate = vi.fn();
const mockFlushSessionLogs = vi.fn();
const mockGetAuthForDirectUse = vi.hoisted(() =>
  vi.fn<() => { apiKey?: string; authToken?: string }>(() => ({ apiKey: 'test-api-key' })),
);

vi.mock('node:fs/promises', () => ({
  default: {
    realpath: (...args: unknown[]) => mockRealpath(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
  createTurnSessionLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flushSessionLogs: (...args: unknown[]) => mockFlushSessionLogs(...args),
  }),
}));

vi.mock('@shared/utils/modelNormalization', () => ({
  MODEL_OPTIONS: [],
  ENV_EXECUTION_MODEL: 'REBEL_EXECUTION_MODEL',
  normalizeModel: (model: string) => model,
  resolveModelConfig: () => ({ model: 'claude-test' }),
  planModeTargetFromThinkingModel: (thinkingModel: string | null | undefined, workingModel: string) => {
    const trimmed = thinkingModel?.trim();
    if (!trimmed || trimmed === workingModel) return null;
    return { thinkingModel: trimmed };
  },
}));

vi.mock('@core/utils/authEnvUtils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@core/utils/authEnvUtils')>();
  return {
    ...original,
    hasValidAuth: () => true,
    getAuthForDirectUse: mockGetAuthForDirectUse,
  };
});

vi.mock('../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: vi.fn(),
}));

vi.mock('../useCaseLibraryStore', () => ({
  addUseCase: vi.fn(),
  forceAddUseCase: vi.fn(),
  importFromSettings: vi.fn(),
  needsMigration: vi.fn(() => false),
  getUseCasesForDisplay: vi.fn(() => []),
}));

vi.mock('@shared/utils/pricingCalculator', () => ({
  calculateCostOrWarn: vi.fn(() => null),
}));

vi.mock('../costLedgerService', () => ({
  appendCostEntry: vi.fn(() => ({ costEntryId: 'test-cost-entry-id' })),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  Anthropic: class {
    readonly messages = {
      create: (...args: unknown[]) => mockMessagesCreate(...args),
    };
  },
}));

import { generatePersonalizedUseCases } from '../useCaseGeneratorService';

describe('generatePersonalizedUseCases error shaping', () => {
  beforeEach(() => {
    mockRealpath.mockReset();
    mockReadFile.mockReset();
    mockMessagesCreate.mockReset();
    mockFlushSessionLogs.mockReset();
    mockGetAuthForDirectUse.mockReset();
    mockGetAuthForDirectUse.mockReturnValue({ apiKey: 'test-api-key' });

    mockRealpath.mockResolvedValue('/workspace/rebel-skill.md');
    mockReadFile.mockResolvedValue('# Skill file');
  });

  it('humanizes phase 2 billing failures and returns the ModelError kind', async () => {
    mockMessagesCreate.mockRejectedValue(
      new ModelError(
        'billing',
        'This request requires more credits, or fewer max_tokens.',
        402,
        'OpenRouter',
      ),
    );

    const result = await generatePersonalizedUseCases(
      {
        coreDirectory: '/workspace',
        claude: {
          model: 'claude-test',
          thinkingModel: null,
          extendedContext: false,
        },
      } as any,
      { existingSessionOutput: 'Already discovered use cases.' },
    );

    // Stage 6b (plan 260421): classification-first humanizer now produces
    // provider-aware subtype copy when provider is known (OpenRouter here).
    expect(result).toEqual({
      success: false,
      error:
        'Your OpenRouter account has run out of credits. You can set up auto top-up in your OpenRouter settings to avoid this.',
      errorKind: 'billing',
    });
    expect(mockFlushSessionLogs).toHaveBeenCalled();
  });

  // R4 (plan 260422): guard tests — non-direct-Anthropic active provider must
  // refuse to construct the direct Anthropic client and fail with a classified
  // invalid_request error so the humanizer surfaces the config mismatch during
  // onboarding rather than silently misattributing phase-2 formatting cost to
  // the user's lingering Anthropic API key.
  it('fails phase 2 with invalid_request when Codex is the active provider (row-19 parallel)', async () => {
    const result = await generatePersonalizedUseCases(
      {
        coreDirectory: '/workspace',
        activeProvider: 'codex',
        claude: {
          model: 'claude-test',
          apiKey: 'fake-ant-lingering-key',
          thinkingModel: null,
          extendedContext: false,
        },
      } as any,
      { existingSessionOutput: 'Already discovered use cases.' },
    );

    expect(result.success).toBe(false);
    expect(result.errorKind).toBe('invalid_request');
    expect(result.error).toContain('direct Anthropic');
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(mockFlushSessionLogs).toHaveBeenCalled();
  });

  it('fails phase 2 with invalid_request when OpenRouter is the active provider (row-18 parallel)', async () => {
    const result = await generatePersonalizedUseCases(
      {
        coreDirectory: '/workspace',
        activeProvider: 'openrouter',
        openRouter: { oauthToken: 'or-token', enabled: true },
        claude: {
          model: 'claude-test',
          apiKey: 'fake-ant-lingering-key',
          thinkingModel: null,
          extendedContext: false,
        },
      } as any,
      { existingSessionOutput: 'Already discovered use cases.' },
    );

    expect(result.success).toBe(false);
    expect(result.errorKind).toBe('invalid_request');
    expect(result.error).toContain('direct Anthropic');
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(mockFlushSessionLogs).toHaveBeenCalled();
  });

  it('fails phase 2 with invalid_request for OpenRouter without a lingering Anthropic key', async () => {
    mockGetAuthForDirectUse.mockReturnValueOnce({});

    const result = await generatePersonalizedUseCases(
      {
        coreDirectory: '/workspace',
        activeProvider: 'openrouter',
        openRouter: { oauthToken: 'or-token', enabled: true },
        claude: {
          model: 'claude-test',
          thinkingModel: null,
          extendedContext: false,
        },
      } as any,
      { existingSessionOutput: 'Already discovered use cases.' },
    );

    expect(result.success).toBe(false);
    expect(result.errorKind).toBe('invalid_request');
    expect(result.error).toContain('direct Anthropic');
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(mockFlushSessionLogs).toHaveBeenCalled();
  });

  it('fails phase 2 with invalid_request for Codex without a lingering Anthropic key', async () => {
    mockGetAuthForDirectUse.mockReturnValueOnce({});

    const result = await generatePersonalizedUseCases(
      {
        coreDirectory: '/workspace',
        activeProvider: 'codex',
        claude: {
          model: 'claude-test',
          thinkingModel: null,
          extendedContext: false,
        },
      } as any,
      { existingSessionOutput: 'Already discovered use cases.' },
    );

    expect(result.success).toBe(false);
    expect(result.errorKind).toBe('invalid_request');
    expect(result.error).toContain('direct Anthropic');
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(mockFlushSessionLogs).toHaveBeenCalled();
  });
});
