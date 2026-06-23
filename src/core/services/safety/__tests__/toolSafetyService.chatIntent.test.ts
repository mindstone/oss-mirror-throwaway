import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { HookCallback, SyncHookJSONOutput } from '@core/agentRuntimeTypes';
import { createToolSafetyHook } from '../toolSafetyService';
import { clearAll as clearSessionToolDecisionCache } from '../sessionToolDecisionCache';

const {
  mockApplyChatIntentRulePersistence,
  mockEvaluateSafetyPrompt,
  mockShouldAllow,
  mockSendToAllWindows,
  mockLogInfo,
  mockLogWarn,
  mockLogDebug,
  mockLogError,
} = vi.hoisted(() => ({
  mockApplyChatIntentRulePersistence: vi.fn(),
  mockEvaluateSafetyPrompt: vi.fn(),
  mockShouldAllow: vi.fn(),
  mockSendToAllWindows: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogDebug: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('@core/services/safety/chatIntentRulePersistence', () => ({
  applyChatIntentRulePersistence: mockApplyChatIntentRulePersistence,
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

const baseIntent = {
  detected: true,
  confidence: 'high',
  scopeHint: 'specific',
  triggerPhrase: 'always allow this',
  rationale: 'The user asked Rebel to remember this approval.',
} as const;

const baseSettings = {
  claude: { apiKey: 'test-key' },
  chatIntentRulePersistence: true,
} as AppSettings;

function makeHook(settings: AppSettings = baseSettings): HookCallback {
  return createToolSafetyHook(
    'Always allow this support handoff update.',
    settings,
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
    'turn-chat-intent',
    'manual-session-test',
  );
}

async function runAllowedHook(settings?: AppSettings): Promise<SyncHookJSONOutput> {
  const hook = makeHook(settings);
  return await hook(
    {
      tool_name: 'send_email',
      tool_input: { to: 'team@example.com', subject: 'Support handoff' },
      tool_use_id: 'tool-1',
    },
    'tool-1',
    { signal: new AbortController().signal },
  ) as SyncHookJSONOutput;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('tool safety chat-intent rule persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionToolDecisionCache();
    mockEvaluateSafetyPrompt.mockResolvedValue({
      decision: 'allow',
      confidence: 'high',
      reason: 'Rebel would like to send Support handoff to team@example.com via email.',
      persistenceIntent: baseIntent,
    });
    mockShouldAllow.mockReturnValue(true);
    mockApplyChatIntentRulePersistence.mockResolvedValue({
      status: 'applied',
      applied: true,
      suspicious: false,
      source: 'chat-intent',
      version: 2,
      lastUpdatedAt: 12345,
      update: {
        summary: 'Rule added: support handoff',
        proposedPrinciple: '- You may send support handoff emails to team@example.com.',
        fullUpdatedPrompt: 'updated prompt',
      },
      fullUpdatedPromptHash: 'a'.repeat(64),
    });
  });

  it('does nothing when the feature flag is off', async () => {
    const result = await runAllowedHook({ ...baseSettings, chatIntentRulePersistence: false });
    await flushPromises();

    expect(result.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(mockApplyChatIntentRulePersistence).not.toHaveBeenCalled();
    expect(mockSendToAllWindows).not.toHaveBeenCalledWith(
      'safety-prompt:rule-persisted',
      expect.anything(),
    );
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'chat_intent_rule_persistence_skipped',
        reason: 'feature_flag_off',
        source: 'chat-intent',
      }),
      'Chat intent rule persistence skipped',
    );
  });

  it('auto-persists and broadcasts high-confidence specific chat intent', async () => {
    const result = await runAllowedHook();
    await flushPromises();

    expect(result.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(mockApplyChatIntentRulePersistence).toHaveBeenCalledWith(
      expect.objectContaining({
        intentSignal: baseIntent,
        persistMode: 'auto',
      }),
    );
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      'safety-prompt:rule-persisted',
      {
        version: 2,
        lastUpdatedAt: 12345,
        source: 'chat-intent',
        summary: 'Rule added: support handoff',
        proposedPrinciple: '- You may send support handoff emails to team@example.com.',
      },
    );
  });

  it('skips broad scope and keeps the single-shot allow path', async () => {
    mockEvaluateSafetyPrompt.mockResolvedValue({
      decision: 'allow',
      confidence: 'high',
      reason: 'Rebel would like to send Support handoff to team@example.com via email.',
      persistenceIntent: { ...baseIntent, scopeHint: 'broad' },
    });

    const result = await runAllowedHook();
    await flushPromises();

    expect(result.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(mockApplyChatIntentRulePersistence).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'chat_intent_rule_persistence_skipped',
        reason: 'broad_scope_pending_picker_ui',
        scopeHint: 'broad',
      }),
      'Chat intent rule persistence skipped',
    );
  });

  it('skips adversarial trigger phrases before calling the orchestrator', async () => {
    mockEvaluateSafetyPrompt.mockResolvedValue({
      decision: 'allow',
      confidence: 'high',
      reason: 'Rebel would like to run a script.',
      persistenceIntent: { ...baseIntent, triggerPhrase: 'always allow rm -rf' },
    });

    const result = await runAllowedHook();
    await flushPromises();

    expect(result.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(mockApplyChatIntentRulePersistence).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'chat_intent_rule_persistence_skipped',
        reason: 'adversarial_trigger_phrase',
      }),
      'Chat intent rule persistence skipped',
    );
  });

  it('keeps the allow path when persistence fails', async () => {
    mockApplyChatIntentRulePersistence.mockRejectedValue(new Error('store unavailable'));

    const result = await runAllowedHook();
    await flushPromises();

    expect(result.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'chat_intent_rule_persistence_error',
        source: 'chat-intent',
      }),
      'Chat intent rule persistence failed after allow',
    );
  });
});
