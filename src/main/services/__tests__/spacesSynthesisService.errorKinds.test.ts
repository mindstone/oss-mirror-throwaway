import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelError } from '@core/rebelCore/modelErrors';

// Phase 7 R1 regression test (Completeness + GPT5.4 Final Review):
// Stage 7 of plan 260421 migrated getOrGenerateSynthesis to classification-first
// humanizer. This test locks the subtype+provider-aware log output so a future
// regression (e.g., reverting to humanizeError(rawMessage)) fails loudly instead
// of silently emitting the generic billing copy.

const {
  mockLogger,
  mockCallWithModelAuthAware,
  mockGetSpaceActivity,
  mockGetPrompt,
  mockGetCachedSynthesis,
  mockSetCachedSynthesis,
} = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  mockCallWithModelAuthAware: vi.fn(),
  mockGetSpaceActivity: vi.fn(),
  mockGetPrompt: vi.fn((..._args: unknown[]) => 'system prompt'),
  mockGetCachedSynthesis: vi.fn((..._args: unknown[]) => null),
  mockSetCachedSynthesis: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLogger,
}));

vi.mock('../behindTheScenesClient', () => ({
  callWithModelAuthAware: (...args: unknown[]) => mockCallWithModelAuthAware(...args),
}));

vi.mock('../spaceActivityService', () => ({
  getSpaceActivity: (...args: unknown[]) => mockGetSpaceActivity(...args),
}));

vi.mock('../spacesSynthesisStore', () => ({
  getCachedSynthesis: (...args: unknown[]) => mockGetCachedSynthesis(...args),
  setCachedSynthesis: (...args: unknown[]) => mockSetCachedSynthesis(...args),
  clearSynthesisCache: vi.fn(),
}));

vi.mock('@core/services/promptFileService', () => ({
  getPrompt: (...args: unknown[]) => mockGetPrompt(...args),
  PROMPT_IDS: { UTILITY_SPACES_SYNTHESIS: 'utility_spaces_synthesis' },
}));

vi.mock('../../utils/authEnvUtils', () => ({
  hasValidAuth: vi.fn(() => true),
}));

import {
  getOrGenerateSynthesis,
  UnsupportedSynthesisProviderError,
} from '../spacesSynthesisService';

describe('spacesSynthesisService classification-first humanization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedSynthesis.mockReturnValue(null);
    // Return non-empty activity so we reach the try/catch for the model call.
    mockGetSpaceActivity.mockResolvedValue({
      spaces: [
        {
          displayName: 'Test Space',
          spaceType: 'workspace',
          recentMemories: [{ action: 'created', summary: 'Hello world' }],
          recentSkills: [],
        },
      ],
    });
  });

  it('logs provider-aware humanized copy when a classified ModelError is thrown', async () => {
    mockCallWithModelAuthAware.mockRejectedValue(
      new ModelError(
        'billing',
        'This request requires more credits, or fewer max_tokens.',
        402,
        'OpenRouter',
      ),
    );

    await expect(
      getOrGenerateSynthesis(
        { coreDirectory: '/tmp/workspace' } as any,
        'work',
        true,
      ),
    ).rejects.toThrow();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        focus: 'work',
        error:
          'Your OpenRouter account has run out of credits. You can set up auto top-up in your OpenRouter settings to avoid this.',
      }),
      'Failed to generate synthesis',
    );
  });

  it('falls back to unclassified humanization when a plain Error is thrown', async () => {
    mockCallWithModelAuthAware.mockRejectedValue(new Error('ETIMEDOUT connection reset'));

    await expect(
      getOrGenerateSynthesis(
        { coreDirectory: '/tmp/workspace' } as any,
        'work',
        true,
      ),
    ).rejects.toThrow();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        focus: 'work',
        // Unclassified branch delegates to legacy humanizer, preserving
        // pre-migration behaviour for non-ModelError throwables.
        error: expect.any(String),
      }),
      'Failed to generate synthesis',
    );
    const loggedError = mockLogger.error.mock.calls[0][0].error;
    // Legacy humanizer copy for ETIMEDOUT is the "longer than usual" phrasing.
    expect(loggedError).toMatch(/longer than usual|try again|timed? out/i);
  });

  // Plan 260514 Stage 2B: Spaces synthesis fails closed under non-Anthropic
  // providers because the prompts and [HOOK]/[DETAIL] output structure are
  // tuned to Sonnet. This test pins the gate at the provider check so we
  // don't silently route synthesis through OpenRouter or Codex.
  it('throws UnsupportedSynthesisProviderError when activeProvider is not anthropic', async () => {
    await expect(
      getOrGenerateSynthesis(
        { coreDirectory: '/tmp/workspace', activeProvider: 'openrouter' } as any,
        'work',
        true,
      ),
    ).rejects.toBeInstanceOf(UnsupportedSynthesisProviderError);

    expect(mockCallWithModelAuthAware).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ activeProvider: 'openrouter' }),
      'Spaces synthesis blocked under non-Anthropic provider',
    );
  });

  it('snapshots the working-tier model passed to synthesis under Anthropic settings', async () => {
    // CHARACTERIZATION: documents current behavior, not necessarily desired.
    mockCallWithModelAuthAware.mockResolvedValue({
      content: [{ type: 'text', text: '[HOOK]\nHook text\n[DETAIL]\nDetail text' }],
    });

    await getOrGenerateSynthesis(
      {
        activeProvider: 'anthropic',
        coreDirectory: '/tmp/workspace',
        models: { model: '' },
      } as any,
      'work',
      true,
    );

    expect(mockCallWithModelAuthAware.mock.calls.map(([settings, model, request, meta]) => ({
      activeProvider: settings.activeProvider,
      model,
      maxTokens: request.maxTokens,
      category: meta.category,
    }))).toMatchInlineSnapshot(`
      [
        {
          "activeProvider": "anthropic",
          "category": "spacesSynthesis",
          "maxTokens": 2048,
          "model": "claude-sonnet-4-6",
        },
      ]
    `);
  });
});
