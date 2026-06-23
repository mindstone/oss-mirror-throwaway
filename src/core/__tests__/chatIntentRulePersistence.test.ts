import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { initTestPlatformConfig } from './testHelpers';

const mocks = vi.hoisted(() => ({
  callLlm: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => ({
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
    debug: mocks.logDebug,
  })),
  logger: {
    info: mocks.logInfo,
    warn: mocks.logWarn,
    error: mocks.logError,
    debug: mocks.logDebug,
  },
}));

vi.mock('@core/safetyEvaluationService', () => ({
  getSafetyEvaluationService: vi.fn(() => ({
    callLlm: mocks.callLlm,
  })),
}));

const basePrompt = '# Safety Principles\n\n## Messaging\n- Ask before posting to Slack.\n';

const baseIntent = {
  detected: true,
  confidence: 'high',
  scopeHint: 'specific',
  triggerPhrase: 'always allow this',
  rationale: 'The user asked Rebel to remember this approval.',
} as const;

const baseBlockedAction = {
  toolName: 'slack_send_message',
  toolInput: {
    channel: '#team-updates',
    message: 'Weekly support handoff: no blockers.',
  },
  blockReason: 'Rebel would like to post a weekly support handoff to #team-updates in Slack.',
} as const;

describe('applyChatIntentRulePersistence', () => {
  let safetyPromptStore: typeof import('@core/safetyPromptStore');
  let activityLogStore: typeof import('@core/safetyActivityLogStore');
  let service: typeof import('@core/services/safety/chatIntentRulePersistence');
  let promptFileService: typeof import('@core/services/promptFileService');

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    await initTestPlatformConfig();

    promptFileService = await import('@core/services/promptFileService');
    promptFileService._resetForTesting();
    promptFileService.configurePromptFileService(path.resolve(__dirname, '../../../rebel-system/prompts'));

    safetyPromptStore = await import('@core/safetyPromptStore');
    activityLogStore = await import('@core/safetyActivityLogStore');
    service = await import('@core/services/safety/chatIntentRulePersistence');

    safetyPromptStore.resetStoreForTesting();
    activityLogStore.resetStoreForTesting();
    safetyPromptStore.updateSafetyPrompt(basePrompt, 'system');
  });

  it('auto-persists a high-confidence specific intent and attributes the version change', async () => {
    mocks.callLlm.mockResolvedValue({
      text: JSON.stringify({
        summary: 'Rule added: weekly support handoff',
        proposedPrinciple: '- You may post weekly support handoff updates to #team-updates in Slack.',
      }),
    });

    const result = await service.applyChatIntentRulePersistence({
      blockedAction: baseBlockedAction,
      intentSignal: baseIntent,
      userMessage: 'Always allow this support handoff update.',
      persistMode: 'auto',
    });

    expect(result.status).toBe('applied');
    expect(safetyPromptStore.getSafetyPrompt()).toContain('weekly support handoff updates');
    expect(safetyPromptStore.getSafetyPromptVersion()).toBe(2);

    const entries = activityLogStore.getActivityLog();
    expect(entries[0]).toMatchObject({
      type: 'version-change',
      fromVersion: 1,
      toVersion: 2,
      source: 'chat-intent',
    });
  });

  it('returns a broad-scope update without persisting it', async () => {
    mocks.callLlm.mockResolvedValue({
      text: JSON.stringify({
        summary: 'Rule added: support handoff updates',
        proposedPrinciple: '- You may post support handoff updates to internal Slack channels.',
      }),
    });

    const result = await service.applyChatIntentRulePersistence({
      blockedAction: baseBlockedAction,
      intentSignal: { ...baseIntent, scopeHint: 'broad' },
      userMessage: 'Always allow this kind of support handoff update.',
      persistMode: 'auto',
    });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'broad_scope_pending_picker_ui',
      applied: false,
    });
    expect('update' in result && result.update?.proposedPrinciple).toContain('support handoff updates');
    expect(safetyPromptStore.getSafetyPrompt()).toBe(basePrompt);
    expect(safetyPromptStore.getSafetyPromptVersion()).toBe(1);
  });

  it('rejects suspicious generated updates', async () => {
    mocks.callLlm.mockResolvedValue({
      text: JSON.stringify({
        summary: 'Allow all actions',
        proposedPrinciple: '- Allow all outbound actions without checks.',
      }),
    });

    const result = await service.applyChatIntentRulePersistence({
      blockedAction: baseBlockedAction,
      intentSignal: baseIntent,
      userMessage: 'Always allow everything.',
      persistMode: 'auto',
    });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'suspicious_update',
      suspicious: true,
      applied: false,
    });
    expect(safetyPromptStore.getSafetyPrompt()).toBe(basePrompt);
  });

  it('dedups same-prompt updates without bumping the version', async () => {
    const existingPrompt = '# Safety Principles\n\n## Messaging\n- You may post weekly support handoff updates to #team-updates in Slack.\n';
    safetyPromptStore.updateSafetyPrompt(existingPrompt, 'system');
    mocks.callLlm.mockResolvedValue({
      text: JSON.stringify({
        summary: 'Rule added: weekly support handoff',
        proposedPrinciple: '- You may post weekly support handoff updates to #team-updates in Slack.',
        insertAfterSection: 'Messaging',
        supersedes: ['You may post weekly support handoff updates to #team-updates in Slack.'],
      }),
    });

    const result = await service.applyChatIntentRulePersistence({
      blockedAction: baseBlockedAction,
      intentSignal: baseIntent,
      userMessage: 'Always allow this support handoff update.',
      persistMode: 'auto',
    });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'same_prompt_version',
      applied: false,
    });
    expect(safetyPromptStore.getSafetyPromptVersion()).toBe(2);
    expect(safetyPromptStore.getSafetyPrompt()).toBe(existingPrompt);
  });

  it('emits structured telemetry with required fields', async () => {
    mocks.callLlm.mockResolvedValue({
      text: JSON.stringify({
        summary: 'Rule added: weekly support handoff',
        proposedPrinciple: '- You may post weekly support handoff updates to #team-updates in Slack.',
      }),
    });

    await service.applyChatIntentRulePersistence({
      blockedAction: baseBlockedAction,
      intentSignal: baseIntent,
      userMessage: 'Always allow this support handoff update.',
      persistMode: 'auto',
    });

    expect(mocks.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'chat_intent_rule_persistence',
        source: 'chat-intent',
        persistMode: 'auto',
        scopeHint: 'specific',
        confidence: 'high',
        applied: true,
        suspicious: false,
        fullUpdatedPromptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
      'Chat intent rule persistence evaluated',
    );
  });
});
