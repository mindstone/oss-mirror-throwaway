import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { HookCallback, SyncHookJSONOutput } from '@core/agentRuntimeTypes';
import type { KeyValueStore } from '@core/store';
import { setStoreFactory } from '@core/storeFactory';
import {
  resetSafetyEvaluationServiceForTesting,
  setSafetyEvaluationService,
  type SafetyEvaluationService,
} from '@core/safetyEvaluationService';
import { safetyEvalDegradationCooldown, safetyEvalRateLimitCooldown } from '@core/services/apiRateLimitCooldown';
import { clearAll as clearSessionToolDecisionCache } from '@core/services/safety/sessionToolDecisionCache';
import { clearAllPendingApprovals, getPendingApprovals } from '@main/services/safety/pendingApprovalsStore';
import { clearAllStagedCalls, getPendingStagedCalls } from '@main/services/safety/stagedToolCallsService';
import { resetForTesting as resetSafetyPromptLogicForTesting } from '@core/safetyPromptLogic';
import { TOOL_SAFETY_EVALUATING_COMPLETE_CHANNEL } from '@shared/ipc/channels/safety';
import { createToolSafetyHook } from '../toolSafetyService';

const mocks = vi.hoisted(() => ({
  sendToAllWindows: vi.fn(),
  addEvaluationEntry: vi.fn(),
  applyChatIntentRulePersistence: vi.fn(),
  recordToolCall: vi.fn(),
  recordSecurityDenial: vi.fn(),
  incrementAutomationSafetyBlock: vi.fn(),
  getAutomationSafetyBlockCount: vi.fn(() => 0),
  getApprovalHandler: vi.fn(() => undefined),
  resolveAlias: vi.fn((_packageId: string, toolId: string) => toolId),
  getCachedAuthConfig: vi.fn(() => null),
  getSettings: vi.fn(() => ({
    activeProvider: 'anthropic',
    safetyEvalBlockConsensus: false,
    claude: { apiKey: 'test-key' },
    localModel: { profiles: [] },
  })),
  createBtsRoutePlan: vi.fn(async () => {
    throw new Error('fallback routing disabled in verdict-routing integration test');
  }),
  getCodexAuthProvider: vi.fn(() => ({
    isConnected: vi.fn(async () => false),
    getAccessToken: vi.fn(),
    getAccountId: vi.fn(),
    forceRefreshToken: vi.fn(),
    getStatus: vi.fn(),
  })),
  getPrompt: vi.fn(() => 'You are a safety evaluator. Return strict JSON.'),
  getSafetyPrompt: vi.fn(() => '- Require explicit approval before external side effects.'),
  getSafetyPromptVersion: vi.fn(() => 1),
  isMigrationComplete: vi.fn(() => true),
  getIncrementalSessionStore: vi.fn(() => ({
    listSessions: vi.fn(() => [{ id: 'session-verdict-routing', title: 'Verdict routing' }]),
  })),
  trackItem: vi.fn(),
  storeSingleUseApproval: vi.fn(),
  consumeSingleUseApproval: vi.fn(() => false),
  clearSessionSingleUseApprovals: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerDebug: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ sendToAllWindows: mocks.sendToAllWindows });
});

vi.mock('@core/safetyActivityLogStore', () => ({
  addEvaluationEntry: mocks.addEvaluationEntry,
}));

vi.mock('@core/services/safety/chatIntentRulePersistence', () => ({
  applyChatIntentRulePersistence: mocks.applyChatIntentRulePersistence,
}));

vi.mock('@main/services/safety', async () => {
  const pendingApprovals = await import('@main/services/safety/pendingApprovalsStore');
  return {
    getPendingApprovals: pendingApprovals.getPendingApprovals,
    addPendingApproval: pendingApprovals.addPendingApproval,
    removePendingApproval: pendingApprovals.removePendingApproval,
    clearPendingApprovalsForSession: pendingApprovals.clearPendingApprovalsForSession,
    clearPendingMemoryApprovalsForSession: pendingApprovals.clearPendingMemoryApprovalsForSession,
    storeSingleUseApproval: mocks.storeSingleUseApproval,
    consumeSingleUseApproval: mocks.consumeSingleUseApproval,
    clearSessionSingleUseApprovals: mocks.clearSessionSingleUseApprovals,
  };
});

vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getApprovalHandler: mocks.getApprovalHandler,
    recordSecurityDenial: mocks.recordSecurityDenial,
    recordToolCall: mocks.recordToolCall,
    incrementAutomationSafetyBlock: mocks.incrementAutomationSafetyBlock,
    getAutomationSafetyBlockCount: mocks.getAutomationSafetyBlockCount,
  },
}));

vi.mock('@core/services/toolAliasCache', () => ({
  resolveAlias: mocks.resolveAlias,
  updateAliases: vi.fn(),
  clearAliases: vi.fn(),
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
    getCachedAuthConfig: mocks.getCachedAuthConfig,
  }),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: mocks.getSettings,
}));

vi.mock('@core/services/behindTheScenesClient', () => ({
  createBtsRoutePlan: mocks.createBtsRoutePlan,
}));

vi.mock('@core/codexAuth', () => ({
  getCodexAuthProvider: mocks.getCodexAuthProvider,
}));

vi.mock('@core/services/promptFileService', () => ({
  getPrompt: mocks.getPrompt,
  PROMPT_IDS: {
    SAFETY_EVAL_SYSTEM: 'safety/eval-system',
  },
}));

vi.mock('@core/safetyPromptStore', () => ({
  getSafetyPrompt: mocks.getSafetyPrompt,
  getSafetyPromptVersion: mocks.getSafetyPromptVersion,
  isMigrationComplete: mocks.isMigrationComplete,
}));

vi.mock('@core/services/incrementalSessionStore', () => ({
  getIncrementalSessionStore: mocks.getIncrementalSessionStore,
}));

vi.mock('@main/services/safety/automationPendingItemsTracker', () => ({
  trackItem: mocks.trackItem,
}));

vi.mock('@main/services/safety/automationContextLookup', () => ({
  getAutomationContext: vi.fn(() => undefined),
}));

vi.mock('@main/services/spaceService', () => ({
  readSpaceReadmeBody: vi.fn(async () => null),
  readSpaceReadmeFrontmatter: vi.fn(async () => null),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => ({
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    debug: mocks.loggerDebug,
    error: mocks.loggerError,
  })),
}));

type StoreShape = Record<string, unknown>;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function createMemoryStore<T extends StoreShape>(defaults: T): KeyValueStore<T> {
  let data = clone(defaults);
  function get<K extends keyof T & string>(key: K): T[K] | undefined;
  function get<K extends keyof T & string>(key: K, defaultValue: T[K]): T[K];
  function get<K extends keyof T & string>(key: K, defaultValue?: T[K]): T[K] | undefined {
    return key in data ? clone(data[key]) : clone(defaultValue);
  }
  function set<K extends keyof T & string>(key: K, value: T[K]): void;
  function set(values: Partial<T>): void;
  function set<K extends keyof T & string>(keyOrValues: K | Partial<T>, value?: T[K]): void {
    if (typeof keyOrValues === 'string') {
      data = { ...data, [keyOrValues]: clone(value) };
      return;
    }
    data = { ...data, ...clone(keyOrValues) };
  }
  return {
    get,
    set,
    has(key) {
      return key in data;
    },
    delete(key) {
      const { [key]: _removed, ...rest } = data;
      data = rest as T;
    },
    clear() {
      data = {} as T;
    },
    get store() {
      return clone(data);
    },
    set store(value) {
      data = clone(value);
    },
    path: '/tmp/verdict-routing-memory-store.json',
  };
}

const baseSettings = {
  claude: { apiKey: 'test-key' },
  safetyEvalUserIntentFence: false,
  safetyEvalSessionIntent: false,
  chatIntentRulePersistence: false,
} as AppSettings;

function installStoreFactory(): void {
  const stores = new Map<string, KeyValueStore<Record<string, unknown>>>();
  setStoreFactory((options) => {
    const existing = stores.get(options.name);
    if (existing) {
      return existing as never;
    }
    const store = createMemoryStore((options.defaults ?? {}) as Record<string, unknown>);
    stores.set(options.name, store);
    return store as never;
  });
}

function installFixtureSafetyEvaluationService(
  implementation: SafetyEvaluationService['callLlm'],
): ReturnType<typeof vi.fn> {
  const callLlm = vi.fn(implementation);
  setSafetyEvaluationService({ callLlm });
  return callLlm;
}

function jsonVerdict(decision: 'allow' | 'block', confidence: 'high' | 'medium' | 'low', reason: string): string {
  return JSON.stringify({ decision, confidence, reason });
}

function makeHook(userMessage = 'Send this message to the team.'): HookCallback {
  return createToolSafetyHook(
    userMessage,
    baseSettings,
    'balanced',
    undefined,
    [],
    undefined,
    null,
    'turn-verdict-routing',
    'session-verdict-routing',
  );
}

async function runHook(
  params: {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolUseId: string;
    userMessage?: string;
  },
): Promise<SyncHookJSONOutput> {
  const hook = makeHook(params.userMessage);
  return await hook(
    {
      tool_name: params.toolName,
      tool_input: params.toolInput,
      tool_use_id: params.toolUseId,
    },
    params.toolUseId,
    { signal: new AbortController().signal },
  ) as SyncHookJSONOutput;
}

function broadcastsFor(channel: string): unknown[] {
  return mocks.sendToAllWindows.mock.calls
    .filter((call) => call[0] === channel)
    .map((call) => call[1]);
}

function expectEvaluatingComplete(toolUseId: string, outcome: string): void {
  expect(broadcastsFor(TOOL_SAFETY_EVALUATING_COMPLETE_CHANNEL)).toContainEqual(
    expect.objectContaining({
      toolUseId,
      outcome,
      sessionId: 'session-verdict-routing',
      turnId: 'turn-verdict-routing',
    }),
  );
}

describe('tool safety real-verdict routing integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installStoreFactory();
    resetSafetyPromptLogicForTesting();
    clearSessionToolDecisionCache();
    safetyEvalRateLimitCooldown.reset();
    safetyEvalDegradationCooldown.reset();
    resetSafetyEvaluationServiceForTesting();
    clearAllPendingApprovals();
    clearAllStagedCalls();
  });

  afterEach(() => {
    resetSafetyPromptLogicForTesting();
    clearSessionToolDecisionCache();
    safetyEvalRateLimitCooldown.reset();
    safetyEvalDegradationCooldown.reset();
    resetSafetyEvaluationServiceForTesting();
    clearAllPendingApprovals();
    clearAllStagedCalls();
  });

  it('F2 routes real non-MCP fail-closed verdicts to an eval_error approval card', async () => {
    const callLlm = installFixtureSafetyEvaluationService(async () => ({ text: 'not valid json' }));

    const result = await runHook({
      toolName: 'send_message',
      toolInput: { channel: '#team', message: 'Customer escalation update' },
      toolUseId: 'tool-f2',
    });

    expect(callLlm).toHaveBeenCalled();
    expect(result.continue).toBeUndefined();
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain("SAFETY CHECK COULDN'T RUN");

    expect(getPendingStagedCalls('session-verdict-routing')).toEqual([]);
    expect(getPendingApprovals()).toEqual([
      expect.objectContaining({
        toolUseID: 'tool-f2',
        turnId: 'turn-verdict-routing',
        sessionId: 'session-verdict-routing',
        toolName: 'send_message',
        effectiveToolId: 'send_message',
        input: { channel: '#team', message: 'Customer escalation update' },
        riskLevel: 'high',
        allowPermanentTrust: false,
        blockedBy: 'eval_error',
      }),
    ]);
    expect(broadcastsFor('tool-safety:approval-request')).toEqual([
      expect.objectContaining({
        toolUseID: 'tool-f2',
        toolName: 'send_message',
        effectiveToolId: 'send_message',
        riskLevel: 'high',
        allowPermanentTrust: false,
        blockedBy: 'eval_error',
      }),
    ]);
    expectEvaluatingComplete('tool-f2', 'blocked');
  });

  it('F3 routes real MCP rate-limited fail-closed verdicts to one coalesced eval_error staged call', async () => {
    const callLlm = installFixtureSafetyEvaluationService(async () => {
      throw new Error('callLlm should not run while safety eval cooldown is active');
    });
    safetyEvalRateLimitCooldown.recordRateLimit(60_000);
    const toolInput = {
      package_id: 'Linear',
      tool_id: 'create_issue',
      args: { title: 'Customer escalation' },
    };

    const first = await runHook({
      toolName: 'mcp__super-mcp-router__use_tool',
      toolInput,
      toolUseId: 'tool-f3-a',
      userMessage: 'Create the customer escalation issue.',
    });
    const second = await runHook({
      toolName: 'mcp__super-mcp-router__use_tool',
      toolInput,
      toolUseId: 'tool-f3-b',
      userMessage: 'Create the customer escalation issue.',
    });

    expect(callLlm).not.toHaveBeenCalled();
    expect(first.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(first.hookSpecificOutput?.updatedInput).toMatchObject({ _rebel_staged: true });
    expect(second.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(second.hookSpecificOutput?.updatedInput).toMatchObject({ _rebel_staged: true });

    const stagedCalls = getPendingStagedCalls('session-verdict-routing');
    expect(stagedCalls).toHaveLength(1);
    expect(stagedCalls[0]).toEqual(
      expect.objectContaining({
        sessionId: 'session-verdict-routing',
        turnId: 'turn-verdict-routing',
        mcpPayload: {
          packageId: 'Linear',
          toolId: 'create_issue',
          args: { title: 'Customer escalation' },
        },
        riskLevel: 'high',
        allowPermanentTrust: false,
        blockedBy: 'eval_error',
      }),
    );
    expect(stagedCalls[0]?.coalesceKey).toMatch(/^eval_error:create_issue:/);

    const stagedBroadcasts = broadcastsFor('tool-safety:staged-call');
    expect(stagedBroadcasts).toHaveLength(2);
    expect(stagedBroadcasts).toEqual([
      expect.objectContaining({
        id: stagedCalls[0]?.id,
        packageId: 'Linear',
        toolId: 'create_issue',
        riskLevel: 'high',
        allowPermanentTrust: false,
        blockedBy: 'eval_error',
      }),
      expect.objectContaining({
        id: stagedCalls[0]?.id,
        packageId: 'Linear',
        toolId: 'create_issue',
        riskLevel: 'high',
        allowPermanentTrust: false,
        blockedBy: 'eval_error',
      }),
    ]);
    expect(getPendingApprovals()).toEqual([]);
    expectEvaluatingComplete('tool-f3-a', 'staged');
    expectEvaluatingComplete('tool-f3-b', 'staged');
  });

  it('F4 routes real allow/medium verdicts for side-effect tools to a safety_prompt approval card', async () => {
    installFixtureSafetyEvaluationService(async () => ({
      text: jsonVerdict('allow', 'medium', 'Probably okay to send this message.'),
    }));

    const result = await runHook({
      toolName: 'send_message',
      toolInput: { channel: '#team', message: 'Customer escalation update' },
      toolUseId: 'tool-f4',
    });

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(getPendingStagedCalls('session-verdict-routing')).toEqual([]);
    expect(getPendingApprovals()).toEqual([
      expect.objectContaining({
        toolUseID: 'tool-f4',
        toolName: 'send_message',
        effectiveToolId: 'send_message',
        reason: 'Safety Rules blocked: Probably okay to send this message.',
        riskLevel: 'high',
        allowPermanentTrust: false,
        blockedBy: 'safety_prompt',
      }),
    ]);
    expect(broadcastsFor('tool-safety:approval-request')).toEqual([
      expect.objectContaining({
        toolUseID: 'tool-f4',
        blockedBy: 'safety_prompt',
        allowPermanentTrust: false,
      }),
    ]);
    expect(broadcastsFor('tool-safety:staged-call')).toEqual([]);
    expect(result.hookSpecificOutput?.permissionDecisionReason).not.toContain('Safety evaluator');
    expectEvaluatingComplete('tool-f4', 'blocked');
  });

  it('F5 routes real block/high policy verdicts with the safety_prompt discriminator', async () => {
    installFixtureSafetyEvaluationService(async () => ({
      text: jsonVerdict('block', 'high', 'External posting violates the safety rule.'),
    }));

    const result = await runHook({
      toolName: 'send_message',
      toolInput: { channel: '#team', message: 'Customer escalation update' },
      toolUseId: 'tool-f5',
    });

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(getPendingStagedCalls('session-verdict-routing')).toEqual([]);
    expect(getPendingApprovals()).toEqual([
      expect.objectContaining({
        toolUseID: 'tool-f5',
        toolName: 'send_message',
        effectiveToolId: 'send_message',
        reason: 'Safety Rules blocked: External posting violates the safety rule.',
        riskLevel: 'high',
        allowPermanentTrust: false,
        blockedBy: 'safety_prompt',
      }),
    ]);
    expect(broadcastsFor('tool-safety:approval-request')).toEqual([
      expect.objectContaining({
        toolUseID: 'tool-f5',
        blockedBy: 'safety_prompt',
        allowPermanentTrust: false,
      }),
    ]);
    expect(broadcastsFor('tool-safety:staged-call')).toEqual([]);
    expect(result.hookSpecificOutput?.permissionDecisionReason).not.toContain('Safety evaluator');
    expectEvaluatingComplete('tool-f5', 'blocked');
  });
});
