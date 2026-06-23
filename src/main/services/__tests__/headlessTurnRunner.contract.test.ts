import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeadlessTurnOptions } from '@core/types/headlessTurnOptions';
import type { SessionType } from '@core/services/promptTemplateService';
import { derivePolicy } from '@core/services/turnPolicy';
import { AUTOMATION_HARD_CEILING_MS } from '@core/services/turnPipeline/watchdogConstants';
import {
  configureCliSessionPersistence,
  configureHeadlessTurnExecutor,
  runHeadlessTurn,
} from '../headlessTurnRunner';
import type { IncrementalSessionStore } from '@core/services/incrementalSessionStore';
import type { SessionLockManager } from '@core/utils/sessionFileLock';
import type { AgentTurnServiceDeps } from '@core/services/agentTurnService';
import type { executeAgentTurn as executeAgentTurnFn } from '../agentTurnExecutor';

const mockedExecuteAgentTurn = vi.fn<typeof executeAgentTurnFn>(async () => undefined);

const noopReleaseHandle = { release: vi.fn(async () => undefined) };
const noopSyncReleaseHandle = { release: vi.fn(() => undefined) };
const stubLockManager: SessionLockManager = {
  acquirePerSession: vi.fn(async () => noopReleaseHandle),
  acquireGlobalIndex: vi.fn(async () => noopReleaseHandle),
  acquirePerSessionSync: vi.fn(() => noopSyncReleaseHandle),
  acquireGlobalIndexSync: vi.fn(() => noopSyncReleaseHandle),
};
const stubSessionStore: IncrementalSessionStore = {
  getSession: vi.fn(async () => null),
  upsertSessionsSync: vi.fn(() => undefined),
  // Stage 3/final-review F1: the runner now consumes the discriminated outcome.
  upsertSessionsSyncWithReload: vi.fn((sessions: Array<{ id: string }>) => ({
    outcome: 'persisted',
    persistedSessionIds: sessions.map((session) => session.id),
    droppedTombstonedSessionIds: [],
  })),
} as unknown as IncrementalSessionStore;

describe('runHeadlessTurn contract', () => {
  beforeEach(() => {
    mockedExecuteAgentTurn.mockClear();
    configureHeadlessTurnExecutor(mockedExecuteAgentTurn);
    configureCliSessionPersistence({
      getSessionStore: () => stubSessionStore,
      lockManager: stubLockManager,
      ownerKind: 'cli',
    });
  });

  it('forwards every HeadlessTurnOptions executor field and strips runner-only fields', async () => {
    const approvalHandler = vi.fn();
    const options: HeadlessTurnOptions = {
      sessionType: 'cli',
      persistMode: { kind: 'cli-session' },
      sessionId: 'session-1',
      resetConversation: true,
      attachments: [
        {
          id: 'att-1',
          name: 'note.txt',
          type: 'textfile',
          mimeType: 'text/plain',
          content: 'hello',
          originalSizeBytes: 5,
          contentSizeBytes: 5,
        },
      ],
      privateMode: true,
      modelOverride: 'claude-sonnet-4-5',
      thinkingModelOverride: '',
      workingProfileOverrideId: 'working-profile',
      thinkingProfileOverrideId: 'thinking-profile',
      thinkingEffortOverride: 'high',
      councilMode: true,
      unleashedMode: true,
      finishLine: 'ready to send',
      activeProviderOverride: 'openrouter',
      bypassToolSafety: true,
      approvalHandler,
    };

    await runHeadlessTurn({
      prompt: 'hello',
      onEvent: vi.fn(),
      options,
    });

    expect(mockedExecuteAgentTurn).toHaveBeenCalledTimes(1);
    expect(mockedExecuteAgentTurn).toHaveBeenCalledWith(
      null,
      expect.any(String),
      'hello',
      {
        sessionId: 'session-1',
        resetConversation: true,
        attachments: options.attachments,
        privateMode: true,
        modelOverride: 'claude-sonnet-4-5',
        thinkingModelOverride: '',
        workingProfileOverrideId: 'working-profile',
        thinkingProfileOverrideId: 'thinking-profile',
        thinkingEffortOverride: 'high',
        councilMode: true,
        unleashedMode: true,
        finishLine: 'ready to send',
        activeProviderOverride: 'openrouter',
        bypassToolSafety: true,
        sessionType: 'cli',
      },
    );
    expect(mockedExecuteAgentTurn.mock.calls[0]?.[3]).not.toHaveProperty('persistMode');
    expect(mockedExecuteAgentTurn.mock.calls[0]?.[3]).not.toHaveProperty('approvalHandler');
  });

  it('forwards policy overrides when options.policy is provided', async () => {
    const policy: NonNullable<HeadlessTurnOptions['policy']> = {
      semanticContext: 'off',
      lane: 'background',
    };

    await runHeadlessTurn({
      prompt: 'policy override',
      onEvent: vi.fn(),
      options: {
        sessionType: 'automation',
        persistMode: { kind: 'none' },
        sessionId: 'policy-session',
        policy,
      },
    });

    expect(mockedExecuteAgentTurn).toHaveBeenCalledTimes(1);
    expect(mockedExecuteAgentTurn.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        sessionId: 'policy-session',
        sessionType: 'automation',
        policyOverrides: policy,
      }),
    );
  });

  it('applies caller-supplied policy overrides on top of sessionType defaults', async () => {
    const policy: NonNullable<HeadlessTurnOptions['policy']> = {
      semanticContext: 'sync',
      prefetchUrls: true,
    };

    await runHeadlessTurn({
      prompt: 'policy merge',
      onEvent: vi.fn(),
      options: {
        sessionType: 'automation',
        persistMode: { kind: 'none' },
        sessionId: 'policy-merge-session',
        policy,
      },
    });

    expect(mockedExecuteAgentTurn).toHaveBeenCalledTimes(1);
    const forwardedTurnOptions = mockedExecuteAgentTurn.mock.calls[0]?.[3];
    expect(forwardedTurnOptions).toEqual(
      expect.objectContaining({
        sessionType: 'automation',
        policyOverrides: policy,
      }),
    );
    if (!forwardedTurnOptions) {
      throw new Error('Expected runHeadlessTurn to forward turn options.');
    }
    const resolvedPolicy = forwardedTurnOptions.policy
      ?? derivePolicy(forwardedTurnOptions.sessionType, forwardedTurnOptions.policyOverrides);

    expect(resolvedPolicy.semanticContext).toBe('sync');
    expect(resolvedPolicy.prefetchUrls).toBe(true);
    expect(resolvedPolicy.watchdogHardCeilingMs).toBe(AUTOMATION_HARD_CEILING_MS);
    expect(resolvedPolicy.lane).toBe('background');
  });

  it('omits policy forwarding when options.policy is absent so executor derives defaults for all session types', async () => {
    const sessionTypes: SessionType[] = ['interactive', 'automation', 'cli', 'mcp_server'];

    for (const sessionType of sessionTypes) {
      mockedExecuteAgentTurn.mockClear();
      await runHeadlessTurn({
        prompt: `derive-${sessionType}`,
        onEvent: vi.fn(),
        options: {
          sessionType,
          persistMode: { kind: 'none' },
          sessionId: `session-${sessionType}`,
        },
      });

      expect(mockedExecuteAgentTurn.mock.calls[0]?.[3]).toEqual(
        expect.objectContaining({
          sessionType,
          sessionId: `session-${sessionType}`,
        }),
      );
      expect(mockedExecuteAgentTurn.mock.calls[0]?.[3]).not.toHaveProperty('policy');
      expect(mockedExecuteAgentTurn.mock.calls[0]?.[3]).not.toHaveProperty('policyOverrides');
    }
  });

  it('enforces cli-session persistence is only used with cli sessionType', async () => {
    await expect(
      runHeadlessTurn({
        prompt: 'hello',
        onEvent: vi.fn(),
        options: {
          sessionType: 'automation',
          persistMode: { kind: 'cli-session' },
        },
      }),
    ).rejects.toThrow('Headless CLI session persistence requires sessionType "cli".');
    expect(mockedExecuteAgentTurn).not.toHaveBeenCalled();
  });

  it('throws (no silent skip) when persistMode is cli-session but sessionId is missing', async () => {
    await expect(
      runHeadlessTurn({
        prompt: 'hello',
        onEvent: vi.fn(),
        options: {
          sessionType: 'cli',
          persistMode: { kind: 'cli-session' },
        },
      }),
    ).rejects.toThrow('requires options.sessionId');
  });

  it('accepts all Stage 1 call-site option shapes', async () => {
    const callSiteShapes: Array<{
      label: string;
      options: HeadlessTurnOptions;
      expected: Partial<NonNullable<Parameters<AgentTurnServiceDeps['executeAgentTurn']>[3]>>;
    }> = [
      {
        label: 'smoke-test',
        options: { sessionType: 'cli', persistMode: { kind: 'none' }, sessionId: 'smoke', resetConversation: true },
        expected: { sessionType: 'cli', sessionId: 'smoke', resetConversation: true },
      },
      {
        label: 'rebel run',
        options: { sessionType: 'cli', persistMode: { kind: 'cli-session' }, sessionId: 'run', resetConversation: false },
        expected: { sessionType: 'cli', sessionId: 'run', resetConversation: false },
      },
      {
        label: 'chat reset',
        options: { sessionType: 'cli', persistMode: { kind: 'cli-session' }, sessionId: 'chat', resetConversation: true },
        expected: { sessionType: 'cli', sessionId: 'chat', resetConversation: true },
      },
      {
        label: 'chat prompt',
        options: { sessionType: 'cli', persistMode: { kind: 'cli-session' }, sessionId: 'chat', resetConversation: false },
        expected: { sessionType: 'cli', sessionId: 'chat', resetConversation: false },
      },
      {
        label: 'mcp-server',
        options: { sessionType: 'mcp_server', persistMode: { kind: 'none' }, sessionId: 'mcp', resetConversation: false },
        expected: { sessionType: 'mcp_server', sessionId: 'mcp', resetConversation: false },
      },
      {
        label: 'meeting analysis',
        options: { sessionType: 'automation', persistMode: { kind: 'none' }, sessionId: 'meeting-analysis', resetConversation: true },
        expected: { sessionType: 'automation', sessionId: 'meeting-analysis', resetConversation: true },
      },
      {
        label: 'bot Q&A',
        options: { sessionType: 'automation', persistMode: { kind: 'none' }, sessionId: 'meeting-qa', resetConversation: true },
        expected: { sessionType: 'automation', sessionId: 'meeting-qa', resetConversation: true },
      },
      {
        label: 'live coach search',
        options: { sessionType: 'automation', persistMode: { kind: 'none' }, sessionId: 'meeting-kb-search', resetConversation: true },
        expected: { sessionType: 'automation', sessionId: 'meeting-kb-search', resetConversation: true },
      },
      {
        label: 'live coach participation',
        options: { sessionType: 'automation', persistMode: { kind: 'none' }, sessionId: 'meeting-participation', resetConversation: true },
        expected: { sessionType: 'automation', sessionId: 'meeting-participation', resetConversation: true },
      },
      {
        label: 'calendar sync',
        options: { sessionType: 'automation', persistMode: { kind: 'none' }, sessionId: 'automation-calendar-sync', resetConversation: true },
        expected: { sessionType: 'automation', sessionId: 'automation-calendar-sync', resetConversation: true },
      },
    ];

    for (const shape of callSiteShapes) {
      mockedExecuteAgentTurn.mockClear();
      await runHeadlessTurn({
        prompt: shape.label,
        onEvent: vi.fn(),
        options: shape.options,
      });
      expect(mockedExecuteAgentTurn.mock.calls[0]?.[3]).toEqual(expect.objectContaining(shape.expected));
    }
  });
});
