import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { HookCallback } from '@core/agentRuntimeTypes';
import { createToolSafetyHook } from '../toolSafetyService';
import { clearAll as clearSessionToolDecisionCache } from '../sessionToolDecisionCache';

const {
  mockEvaluateSafetyPrompt,
  mockShouldAllow,
  mockSendToAllWindows,
  mockLogInfo,
  mockLogWarn,
  mockLogDebug,
  mockLogError,
} = vi.hoisted(() => ({
  mockEvaluateSafetyPrompt: vi.fn(),
  mockShouldAllow: vi.fn(),
  mockSendToAllWindows: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogDebug: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@core/services/safety/chatIntentRulePersistence', () => ({
  applyChatIntentRulePersistence: vi.fn(),
}));

vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getApprovalHandler: vi.fn(),
    recordSecurityDenial: vi.fn(),
    recordToolCall: vi.fn(),
    incrementAutomationSafetyBlock: vi.fn(),
    getAutomationSafetyBlockCount: vi.fn().mockReturnValue(0),
  },
}));

vi.mock('@main/services/safety', () => ({
  addPendingApproval: vi.fn(),
  removePendingApproval: vi.fn(),
  getPendingApprovals: vi.fn().mockReturnValue([]),
  clearPendingApprovalsForSession: vi.fn().mockReturnValue([]),
  storeSingleUseApproval: vi.fn(),
  consumeSingleUseApproval: vi.fn().mockReturnValue(false),
  clearSessionSingleUseApprovals: vi.fn(),
}));

vi.mock('@main/services/safety/stagedToolCallsService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/services/safety/stagedToolCallsService')>();
  return {
    ...actual,
    getPendingStagedCalls: vi.fn().mockReturnValue([]),
  };
});

vi.mock('@core/safetyPromptLogic', () => ({
  evaluateSafetyPrompt: mockEvaluateSafetyPrompt,
  shouldAllow: mockShouldAllow,
  clearCache: vi.fn(),
}));

vi.mock('@core/safetyPromptStore', () => ({
  getSafetyPrompt: vi.fn().mockReturnValue('safety prompt'),
  getSafetyPromptVersion: vi.fn().mockReturnValue(1),
  isMigrationComplete: vi.fn().mockReturnValue(true),
}));

vi.mock('@core/safetyActivityLogStore', () => ({
  addEvaluationEntry: vi.fn(),
}));

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ sendToAllWindows: mockSendToAllWindows });
});

vi.mock('@core/services/toolAliasCache', () => ({
  resolveAlias: vi.fn((_packageId: string, toolId: string) => toolId),
  updateAliases: vi.fn(),
  clearAliases: vi.fn(),
}));

const baseSettings: AppSettings = {
  claude: { apiKey: 'test-key' },
} as AppSettings;

const sessionIntent = {
  recentUserMessages: [
    'Generate an image of a sunset using OpenAI image generation',
    'where is the image?',
  ],
  totalChars: 80,
};

function makeHook(
  overrides: {
    settings?: AppSettings;
    getSessionIntent?: (sid: string | undefined) => Promise<typeof sessionIntent | null>;
  } = {},
): HookCallback {
  return createToolSafetyHook(
    'where is the image?',
    overrides.settings ?? baseSettings,
    'balanced',
    undefined,
    [],
    {
      info: mockLogInfo,
      warn: mockLogWarn,
      debug: mockLogDebug,
      error: mockLogError,
    } as never,
    null,
    'turn-session-intent',
    'sess-session-intent',
    null,
    undefined,
    false,
    overrides.getSessionIntent
      ? { getSessionIntent: overrides.getSessionIntent }
      : undefined,
  );
}

async function runHook(hook: HookCallback) {
  return await hook(
    {
      tool_name: 'OpenAIImageGeneration__generate_image',
      tool_input: { prompt: 'a sunset', model: 'dall-e-3' },
      tool_use_id: 'tool-1',
    },
    'tool-1',
    { signal: new AbortController().signal },
  );
}

describe('createToolSafetyHook session intent (Stage 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionToolDecisionCache();
    mockEvaluateSafetyPrompt.mockResolvedValue({
      decision: 'allow',
      confidence: 'high',
      reason: 'OK',
    });
    mockShouldAllow.mockReturnValue(true);
  });

  it('passes the supplied session intent through to evaluateSafetyPrompt', async () => {
    const supplier = vi.fn().mockResolvedValue(sessionIntent);
    const hook = makeHook({ getSessionIntent: supplier });
    await runHook(hook);

    expect(supplier).toHaveBeenCalledTimes(1);
    expect(supplier).toHaveBeenCalledWith('sess-session-intent');

    const lastCall = mockEvaluateSafetyPrompt.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const ctx = lastCall![2] as { sessionIntent?: typeof sessionIntent };
    expect(ctx.sessionIntent).toEqual(sessionIntent);
  });

  it('emits a session_intent_injected log when the supplier returns a payload', async () => {
    const hook = makeHook({ getSessionIntent: vi.fn().mockResolvedValue(sessionIntent) });
    await runHook(hook);
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'safety.session_intent_injected',
        sessionId: 'sess-session-intent',
        messageCount: 2,
      }),
      expect.any(String),
    );
  });

  it('skips the supplier and omits sessionIntent when the kill-switch is off', async () => {
    const supplier = vi.fn();
    const hook = makeHook({
      settings: { ...baseSettings, safetyEvalSessionIntent: false } as AppSettings,
      getSessionIntent: supplier,
    });
    await runHook(hook);
    expect(supplier).not.toHaveBeenCalled();
    const ctx = mockEvaluateSafetyPrompt.mock.calls.at(-1)![2] as { sessionIntent?: unknown };
    expect(ctx.sessionIntent).toBeUndefined();
  });

  it('memoizes the supplier within a single turn (one call across two tool invocations)', async () => {
    const supplier = vi.fn().mockResolvedValue(sessionIntent);
    const hook = makeHook({ getSessionIntent: supplier });
    await runHook(hook);
    await hook(
      {
        tool_name: 'OpenAIImageGeneration__generate_image',
        tool_input: { prompt: 'a sunset', model: 'dall-e-3', size: '1024x1024' },
        tool_use_id: 'tool-2',
      },
      'tool-2',
      { signal: new AbortController().signal },
    );
    expect(supplier).toHaveBeenCalledTimes(1);
  });

  it('survives supplier errors by attaching no session intent and emitting a warn', async () => {
    const supplier = vi.fn().mockRejectedValue(new Error('store unavailable'));
    const hook = makeHook({ getSessionIntent: supplier });
    const result = await runHook(hook);
    expect((result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision)
      .toBe('allow');
    const ctx = mockEvaluateSafetyPrompt.mock.calls.at(-1)![2] as { sessionIntent?: unknown };
    expect(ctx.sessionIntent).toBeUndefined();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'safety.session_intent_provider_error' }),
      expect.any(String),
    );
  });
});
