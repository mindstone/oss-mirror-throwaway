import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { HookCallback } from '@core/agentRuntimeTypes';
import { createToolSafetyHook } from '../toolSafetyService';
import {
  clearAll as clearSessionToolDecisionCache,
  recordAllow as recordSafetyAllow,
  getCachedAllow as getCachedSafetyAllow,
} from '../sessionToolDecisionCache';

const {
  mockEvaluateSafetyPrompt,
  mockShouldAllow,
  mockSendToAllWindows,
  mockLogInfo,
  mockLogWarn,
  mockLogDebug,
  mockLogError,
  mockExtractUserIntent,
} = vi.hoisted(() => ({
  mockEvaluateSafetyPrompt: vi.fn(),
  mockShouldAllow: vi.fn(),
  mockSendToAllWindows: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogDebug: vi.fn(),
  mockLogError: vi.fn(),
  mockExtractUserIntent: vi.fn(),
}));

vi.mock('@core/services/safety/userIntentExtractor', () => ({
  extractUserIntent: mockExtractUserIntent,
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

function makeHook(
  overrides: {
    settings?: AppSettings;
    userMessage?: string;
  } = {},
): HookCallback {
  return createToolSafetyHook(
    overrides.userMessage ?? 'send it',
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
    'turn-user-intent',
    'sess-user-intent',
    null,
    undefined,
    false,
    undefined,
  );
}

async function runHook(hook: HookCallback, toolUseId = 'tool-1') {
  return await hook(
    {
      tool_name: 'slack_send_message',
      tool_input: { channel: '#team-updates', message: 'hello' },
      tool_use_id: toolUseId,
    },
    toolUseId,
    { signal: new AbortController().signal },
  );
}

describe('createToolSafetyHook user intent (Stage 3)', () => {
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

  it('passes userIntentExplicit through to evaluateSafetyPrompt when classifier returns imperative+high', async () => {
    mockExtractUserIntent.mockResolvedValueOnce({
      signal: 'imperative',
      triggerPhrase: 'send it',
      confidence: 'high',
    });
    const hook = makeHook();
    await runHook(hook);

    expect(mockExtractUserIntent).toHaveBeenCalledTimes(1);
    const lastCall = mockEvaluateSafetyPrompt.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const ctx = lastCall![2] as { userIntentExplicit?: unknown };
    expect(ctx.userIntentExplicit).toEqual({
      signal: 'imperative',
      triggerPhrase: 'send it',
    });
  });

  it('omits userIntentExplicit when classifier returns null', async () => {
    mockExtractUserIntent.mockResolvedValueOnce(null);
    const hook = makeHook();
    await runHook(hook);
    const ctx = mockEvaluateSafetyPrompt.mock.calls.at(-1)![2] as { userIntentExplicit?: unknown };
    expect(ctx.userIntentExplicit).toBeUndefined();
  });

  it('skips the extractor entirely when the kill-switch is off', async () => {
    const hook = makeHook({
      settings: { ...baseSettings, safetyEvalUserIntentFence: false } as AppSettings,
    });
    await runHook(hook);
    expect(mockExtractUserIntent).not.toHaveBeenCalled();
    const ctx = mockEvaluateSafetyPrompt.mock.calls.at(-1)![2] as { userIntentExplicit?: unknown };
    expect(ctx.userIntentExplicit).toBeUndefined();
  });

  it('skips the extractor when the user message is empty', async () => {
    const hook = makeHook({ userMessage: '' });
    await runHook(hook);
    expect(mockExtractUserIntent).not.toHaveBeenCalled();
    const ctx = mockEvaluateSafetyPrompt.mock.calls.at(-1)![2] as { userIntentExplicit?: unknown };
    expect(ctx.userIntentExplicit).toBeUndefined();
  });

  it('survives extractor errors by attaching no userIntentExplicit and emitting a warn', async () => {
    mockExtractUserIntent.mockRejectedValueOnce(new Error('classifier blew up'));
    const hook = makeHook();
    const result = await runHook(hook);
    expect((result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision)
      .toBe('allow');
    const ctx = mockEvaluateSafetyPrompt.mock.calls.at(-1)![2] as { userIntentExplicit?: unknown };
    expect(ctx.userIntentExplicit).toBeUndefined();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'safety.user_intent_classifier_error' }),
      expect.any(String),
    );
  });

  it('does not double-fence when classifier returns signal=none (pre-filtered to null upstream)', async () => {
    mockExtractUserIntent.mockResolvedValueOnce(null);
    const hook = makeHook();
    await runHook(hook);
    const ctx = mockEvaluateSafetyPrompt.mock.calls.at(-1)![2] as { userIntentExplicit?: unknown };
    expect(ctx.userIntentExplicit).toBeUndefined();
  });

  it('omits userIntentExplicit when classifier returns signal=negation (negation is not a fence)', async () => {
    mockExtractUserIntent.mockResolvedValueOnce({
      signal: 'negation',
      triggerPhrase: "wait, don't send it",
      confidence: 'high',
    });
    const hook = makeHook({ userMessage: "wait, don't send it" });
    await runHook(hook);
    const ctx = mockEvaluateSafetyPrompt.mock.calls.at(-1)![2] as { userIntentExplicit?: unknown };
    expect(ctx.userIntentExplicit).toBeUndefined();
  });

  it('on classifier negation, invalidates the matching tool family in the session decision cache', async () => {
    recordSafetyAllow({
      sessionId: 'sess-user-intent',
      normalizedKey: 'cached-key-send',
      result: { decision: 'allow', confidence: 'high', reason: 'OK' },
      promptVersion: 1,
      toolFamily: 'send_message',
    });
    expect(
      getCachedSafetyAllow({
        sessionId: 'sess-user-intent',
        normalizedKey: 'cached-key-send',
        currentPromptVersion: 1,
      }),
    ).not.toBeNull();

    mockExtractUserIntent.mockResolvedValueOnce({
      signal: 'negation',
      triggerPhrase: "don't send it",
      confidence: 'high',
    });
    const hook = makeHook({ userMessage: "don't send it" });
    await runHook(hook);

    expect(
      getCachedSafetyAllow({
        sessionId: 'sess-user-intent',
        normalizedKey: 'cached-key-send',
        currentPromptVersion: 1,
      }),
    ).toBeNull();
  });

  it('does not invalidate cache for a different tool family on negation', async () => {
    recordSafetyAllow({
      sessionId: 'sess-user-intent',
      normalizedKey: 'cached-key-image',
      result: { decision: 'allow', confidence: 'high', reason: 'OK' },
      promptVersion: 1,
      toolFamily: 'image_generation',
    });
    mockExtractUserIntent.mockResolvedValueOnce({
      signal: 'negation',
      triggerPhrase: "don't send it",
      confidence: 'high',
    });
    const hook = makeHook({ userMessage: "don't send it" });
    await runHook(hook);
    expect(
      getCachedSafetyAllow({
        sessionId: 'sess-user-intent',
        normalizedKey: 'cached-key-image',
        currentPromptVersion: 1,
      }),
    ).not.toBeNull();
  });
});
