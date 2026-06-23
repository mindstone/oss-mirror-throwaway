import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { AgentToolContext } from '../types';
import type { PlanningStep } from '../planningMode';

const { loggerMocks, mockRunAgentLoop } = vi.hoisted(() => ({
  loggerMocks: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
  mockRunAgentLoop: vi.fn(),
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: loggerMocks.info,
    warn: loggerMocks.warn,
    debug: loggerMocks.debug,
    error: loggerMocks.error,
    trace: loggerMocks.trace,
    fatal: loggerMocks.fatal,
  }),
}));

 
vi.mock('../agentLoop', () => ({
  runAgentLoop: mockRunAgentLoop,
}));

import { claimSubAgentAssignment, executeAgentTool } from '../agentTool';

function buildSameAgentPlan(): PlanningStep[] {
  return [
    {
      id: 's1',
      sub_agents: [
        { task: 'Use researcher to inspect California weather data', model: unsafeAssertRoutingModelId('gpt-5.5') },
        { task: 'Use researcher to inspect NASDAQ tech stock prices', model: unsafeAssertRoutingModelId('gpt-5.5') },
      ],
    },
  ];
}

function buildSingleAssignmentPlan(): PlanningStep[] {
  return [
    {
      id: 's1',
      sub_agents: [
        { task: 'Use researcher to gather routing evidence', model: unsafeAssertRoutingModelId('gpt-5.5') },
      ],
    },
  ];
}

function buildCapQueueSimulationPlan(): PlanningStep[] {
  return [
    {
      id: 's1',
      sub_agents: [
        { task: 'Use researcher to investigate alpha routing signal', model: unsafeAssertRoutingModelId('gpt-5.5') },
        { task: 'Use researcher to investigate beta routing signal', model: unsafeAssertRoutingModelId('gpt-5.5') },
        { task: 'Use researcher to investigate gamma routing signal', model: unsafeAssertRoutingModelId('gpt-5.5') },
        { task: 'Use researcher to investigate delta routing signal', model: unsafeAssertRoutingModelId('gpt-5.5') },
      ],
    },
  ];
}

function makeSettings(adaptiveRoutingEnabled = true): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: { enabled: false },
    models: {
      apiKey: 'fake-ant-test',
      oauthToken: null,
      authMethod: 'api-key',
      model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
      thinkingModel: undefined,
      workingProfileId: null,
      thinkingProfileId: null,
      behindTheScenesModel: undefined,
    },
    diagnostics: { enabled: false },
    experimental: {
      adaptiveRoutingEnabled,
    },
    localModel: {
      activeProfileId: null,
      profiles: [
        {
          id: 'local-gpt-55',
          name: 'Local GPT-5.5',
          providerType: 'local',
          serverUrl: 'http://localhost:11434/v1',
          model: unsafeAssertRoutingModelId('gpt-5.5'),
          enabled: true,
          routingEligible: true,
          createdAt: Date.now(),
        },
      ],
    },
  } as unknown as AppSettings;
}

function makeAgentToolCtx(overrides: {
  settings?: AppSettings;
  planSteps?: PlanningStep[];
  consumedAssignments?: Set<string>;
  signal?: AbortSignal;
} = {}): AgentToolContext {
  return {
    agents: {
      researcher: {
        description: 'Researches information',
        prompt: 'You are a research sub-agent.',
        model: 'inherit',
        lightweight: true,
      },
    },
    client: {} as AgentToolContext['client'],
    settings: overrides.settings ?? makeSettings(),
    parentModel: unsafeAssertRoutingModelId('claude-sonnet-4-20250514'),
    parentMaxTokens: 4096,
    parentEffort: 'low',
    planRouting: {
      default_model: 'claude-sonnet-4-20250514',
      default_effort: 'low',
    },
    planSteps: overrides.planSteps,
    consumedAssignments: overrides.consumedAssignments ?? new Set<string>(),
    ...(overrides.signal ? { signal: overrides.signal } : {}),
    codexConnectivity: 'unknown',
  };
}

beforeEach(() => {
  mockRunAgentLoop.mockReset();
  mockRunAgentLoop.mockResolvedValue(undefined);
  loggerMocks.info.mockClear();
  loggerMocks.warn.mockClear();
  loggerMocks.debug.mockClear();
  loggerMocks.error.mockClear();
  loggerMocks.trace.mockClear();
  loggerMocks.fatal.mockClear();
});

describe('claimSubAgentAssignment same-agent prompt overlap (C7)', () => {
  it('matches reverse-order same-agent calls by prompt overlap, not call order', () => {
    const consumed = new Set<string>();
    const planSteps = buildSameAgentPlan();

    const firstClaim = claimSubAgentAssignment(
      'Researcher',
      'Get me the latest NASDAQ tech stock prices',
      planSteps,
      consumed,
    );
    expect(firstClaim?.assignment.task).toBe('Use researcher to inspect NASDAQ tech stock prices');

    const secondClaim = claimSubAgentAssignment(
      'Researcher',
      'What are California weather conditions',
      planSteps,
      consumed,
    );
    expect(secondClaim?.assignment.task).toBe('Use researcher to inspect California weather data');
  });

  it('returns null when multiple exact-name candidates exist but prompt has insufficient overlap', () => {
    const consumed = new Set<string>();

    const claim = claimSubAgentAssignment(
      'researcher',
      'help',
      buildSameAgentPlan(),
      consumed,
    );

    expect(claim).toBeNull();
    expect(consumed.size).toBe(0);
  });
});

describe('claimSubAgentAssignment word-boundary exact-name match (Stage 4 over-claim fix)', () => {
  it('does NOT treat the agent name as a match when it is a substring of a larger word', () => {
    const consumed = new Set<string>();
    // Agent "research" must not match a task that only contains "researcher"
    // (the name embedded in a larger word). With no genuine exact-name match
    // and weak keyword overlap, this falls through to null.
    const claim = claimSubAgentAssignment(
      'research',
      'help me',
      [{
        id: 's1',
        sub_agents: [
          { task: 'Use researcher to inspect California weather data', model: unsafeAssertRoutingModelId('gpt-5.5') },
        ],
      }],
      consumed,
    );

    expect(claim).toBeNull();
    expect(consumed.size).toBe(0);
  });

  it('matches the agent name as a whole word (with sufficient overlap)', () => {
    const consumed = new Set<string>();
    const claim = claimSubAgentAssignment(
      'research',
      'inspect California weather data',
      [{
        id: 's1',
        sub_agents: [
          // "research" appears here as a standalone word, not embedded.
          { task: 'Use the research helper to inspect California weather data', model: unsafeAssertRoutingModelId('gpt-5.5') },
        ],
      }],
      consumed,
    );

    expect(claim).not.toBeNull();
    expect(consumed.has('0:0')).toBe(true);
  });
});

describe('claimSubAgentAssignment single exact-name overlap floor (Stage 4)', () => {
  it('does NOT claim a single exact-name candidate when prompt overlap is insufficient', () => {
    const consumed = new Set<string>();
    // One exact-name candidate, but the prompt shares no meaningful tokens with
    // the task — the agent name alone is no longer enough to claim.
    const claim = claimSubAgentAssignment(
      'researcher',
      'help',
      buildSingleAssignmentPlan(),
      consumed,
    );

    expect(claim).toBeNull();
    expect(consumed.size).toBe(0);
  });

  it('DOES claim a single exact-name candidate with sufficient prompt overlap', () => {
    const consumed = new Set<string>();
    const claim = claimSubAgentAssignment(
      'researcher',
      'Gather routing evidence',
      buildSingleAssignmentPlan(),
      consumed,
    );

    expect(claim).not.toBeNull();
    expect(claim?.assignment.task).toBe('Use researcher to gather routing evidence');
    expect(consumed.has('0:0')).toBe(true);
  });
});

describe('C8 structural invariant', () => {
  it('claimSubAgentAssignment must be synchronous (non-async)', () => {
    const fn = claimSubAgentAssignment;
    const result = fn('agent', 'prompt', [], new Set());
    expect(result).not.toBeInstanceOf(Promise);
    expect(fn.constructor.name).toBe('Function');
  });
});

describe('claimSubAgentAssignment claim lifecycle (C20/F18/F23)', () => {
  it('claim -> commit -> release keeps consumed assignment (release is no-op)', () => {
    const consumed = new Set<string>();
    const claim = claimSubAgentAssignment('researcher', 'Gather routing evidence', buildSingleAssignmentPlan(), consumed);
    expect(consumed.has('0:0')).toBe(true);

    claim?.commit();
    claim?.release();

    expect(consumed.has('0:0')).toBe(true);
  });

  it('claim -> release -> re-claim from same plan succeeds (cross-stage Stage 2a interaction)', () => {
    const consumed = new Set<string>();
    const planSteps = buildSingleAssignmentPlan();
    const firstClaim = claimSubAgentAssignment('researcher', 'Gather routing evidence', planSteps, consumed);
    expect(consumed.has('0:0')).toBe(true);

    firstClaim?.release();
    expect(consumed.has('0:0')).toBe(false);

    const secondClaim = claimSubAgentAssignment('researcher', 'Gather routing evidence', planSteps, consumed);
    expect(secondClaim).not.toBeNull();
    expect(secondClaim?.assignment).toBe(firstClaim?.assignment);
    expect(consumed.has('0:0')).toBe(true);
  });

  it('simulates cap/queue reclaim ordering with shared consumedAssignments state', () => {
    // This helper-level sequential test models the Stage 2a cap/queue interaction:
    // executeAgentTool sibling prefixes run synchronously, so queued siblings observe
    // releases immediately on the same consumedAssignments instance. Full Promise.all
    // integration is deferred to Stage 6 integration coverage.
    const consumed = new Set<string>();
    const planSteps = buildCapQueueSimulationPlan();

    const firstClaim = claimSubAgentAssignment('researcher', 'Investigate alpha routing signal', planSteps, consumed);
    const secondClaim = claimSubAgentAssignment('researcher', 'Investigate beta routing signal', planSteps, consumed);
    const thirdClaim = claimSubAgentAssignment('researcher', 'Investigate gamma routing signal', planSteps, consumed);
    const fourthClaim = claimSubAgentAssignment('researcher', 'Investigate delta routing signal', planSteps, consumed);

    expect(firstClaim).not.toBeNull();
    expect(secondClaim).not.toBeNull();
    expect(thirdClaim).not.toBeNull();
    expect(fourthClaim).not.toBeNull();
    expect(consumed).toEqual(new Set(['0:0', '0:1', '0:2', '0:3']));

    secondClaim?.commit();
    thirdClaim?.commit();
    fourthClaim?.commit();

    // Simulate sibling #1 failing before commit and releasing its reservation.
    firstClaim?.release();
    expect(consumed).toEqual(new Set(['0:1', '0:2', '0:3']));

    // Simulate queued sibling #5 re-claiming the released assignment key.
    const fifthClaim = claimSubAgentAssignment('researcher', 'Investigate alpha routing signal', planSteps, consumed);
    expect(fifthClaim).not.toBeNull();
    expect(fifthClaim?.assignment.task).toBe('Use researcher to investigate alpha routing signal');
    expect(consumed).toEqual(new Set(['0:0', '0:1', '0:2', '0:3']));
  });

  it('claim -> release -> commit keeps assignment released (commit is no-op)', () => {
    const consumed = new Set<string>();
    const claim = claimSubAgentAssignment('researcher', 'Gather routing evidence', buildSingleAssignmentPlan(), consumed);
    expect(claim).not.toBeNull();

    claim?.release();
    claim?.commit();

    expect(consumed.has('0:0')).toBe(false);
  });

  it('claim -> release -> release keeps assignment released (second release is no-op)', () => {
    const consumed = new Set<string>();
    const claim = claimSubAgentAssignment('researcher', 'Gather routing evidence', buildSingleAssignmentPlan(), consumed);
    expect(claim).not.toBeNull();

    claim?.release();
    claim?.release();

    expect(consumed.has('0:0')).toBe(false);
  });

  it('claim -> commit -> commit keeps assignment consumed (second commit is no-op)', () => {
    const consumed = new Set<string>();
    const claim = claimSubAgentAssignment('researcher', 'Gather routing evidence', buildSingleAssignmentPlan(), consumed);
    expect(claim).not.toBeNull();

    claim?.commit();
    claim?.commit();

    expect(consumed.has('0:0')).toBe(true);
  });

  it('claim without commit/release remains consumed (creation claims immediately)', () => {
    const consumed = new Set<string>();
    const firstClaim = claimSubAgentAssignment('researcher', 'Gather routing evidence', buildSingleAssignmentPlan(), consumed);
    expect(firstClaim).not.toBeNull();
    expect(consumed.has('0:0')).toBe(true);

    const secondClaim = claimSubAgentAssignment('researcher', 'Gather routing evidence again', buildSingleAssignmentPlan(), consumed);
    expect(secondClaim).toBeNull();
  });

  it('release after commit is a no-op (F23 boundary)', () => {
    const consumed = new Set<string>();
    const claim = claimSubAgentAssignment('researcher', 'Gather routing evidence', buildSingleAssignmentPlan(), consumed);
    expect(claim).not.toBeNull();

    claim?.commit();
    claim?.release();

    expect(consumed.has('0:0')).toBe(true);
  });
});

describe('claimSubAgentAssignment sibling race-safety regression', () => {
  it('first synchronous sibling claim consumes assignment; second sibling gets null', () => {
    const consumed = new Set<string>();
    const planSteps = buildSingleAssignmentPlan();

    const firstSiblingClaim = claimSubAgentAssignment('researcher', 'Gather routing evidence', planSteps, consumed);
    const secondSiblingClaim = claimSubAgentAssignment('researcher', 'Gather routing evidence', planSteps, consumed);

    expect(firstSiblingClaim).not.toBeNull();
    expect(secondSiblingClaim).toBeNull();
  });
});

describe('executeAgentTool claim release integration (F18)', () => {
  it('warns and falls back to default routing when no exact-name assignment can be confidently claimed', async () => {
    const consumedAssignments = new Set<string>();
    const ctx = makeAgentToolCtx({
      planSteps: buildSameAgentPlan(),
      consumedAssignments,
    });

    const result = await executeAgentTool(
      { agent: 'researcher', prompt: 'help' },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    expect(mockRunAgentLoop.mock.calls[0][0]).toMatchObject({ model: unsafeAssertRoutingModelId('claude-sonnet-4-20250514') });
    expect(consumedAssignments.size).toBe(0);

    const fallbackWarning = loggerMocks.warn.mock.calls.find(
      (call) => call[1] === 'Sub-agent invocation did not match any planner assignment despite active plan routing — falling back to default model. This may indicate ambiguous prompts or a generic agent name.',
    );
    expect(fallbackWarning).toBeDefined();
    expect(fallbackWarning?.[0]).toMatchObject({
      agent: 'researcher',
      promptPrefix: 'help',
      planStepCount: 1,
      assignmentCount: 2,
    });
  });

  it('aborts before commit and releases consumed assignment in finally', async () => {
    const consumedAssignments = new Set<string>();
    const controller = new AbortController();
    controller.abort();

    const ctx = makeAgentToolCtx({
      planSteps: buildSingleAssignmentPlan(),
      consumedAssignments,
      signal: controller.signal,
    });

    await expect(
      executeAgentTool(
        { agent: 'researcher', prompt: 'Gather routing evidence' },
        ctx,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(consumedAssignments.has('0:0')).toBe(false);
    expect(consumedAssignments.size).toBe(0);
  });
});
