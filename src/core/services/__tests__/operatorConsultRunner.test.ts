import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { OperatorDefinition } from '@shared/types/operators';
import { ModelError } from '@core/rebelCore/modelErrors';
import type { OperatorConsultRunnerDeps } from '../operatorConsultRunner';
import { _resetOperatorConsultRunnerTelemetryForTests, runConsult } from '../operatorConsultRunner';

const makeOperator = (overrides: Partial<OperatorDefinition> = {}): OperatorDefinition => ({
  id: '/spaces/acme::risk-operator',
  name: 'Risk Operator',
  description: 'Finds operational risk.',
  consult_when: 'Use for risk, compliance, and launch readiness questions.',
  kind: 'operator',
  roles: ['operator'],
  operatorSlug: 'risk-operator',
  spacePath: '/spaces/acme',
  operatorDirAbsolutePath: '/spaces/acme/operators/risk-operator',
  operatorFileAbsolutePath: '/spaces/acme/operators/risk-operator/OPERATOR.md',
  groundingPath: '/spaces/acme/operators/risk-operator/grounding.md',
  diaryPath: '/spaces/acme/operators/risk-operator/diary.md',
  frontmatter: {
    name: 'Risk Operator',
    description: 'Finds operational risk.',
    consult_when: 'Use for risk, compliance, and launch readiness questions.',
    kind: 'operator',
    roles: ['operator'],
  },
  body: 'Voice: blunt, practical, and evidence-first.',
  ...overrides,
});

function makeDeps(overrides: Partial<OperatorConsultRunnerDeps> = {}): OperatorConsultRunnerDeps {
  const operator = makeOperator();
  return {
    registry: {
      getById: vi.fn(() => operator),
      listAvailable: vi.fn(async () => [operator]),
    },
    diaryStore: {
      readDiary: vi.fn(async () => 'Diary: launch before SSO to move faster.'),
      appendDiary: vi.fn(async () => undefined),
    },
    getSettings: vi.fn(() => ({ coreDirectory: '/spaces' } as AppSettings)),
    callModel: vi.fn(async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          perspective: 'Do not launch until enterprise SSO is ready.',
          evidenceCited: ['Diary: launch readiness'],
          confidence: 0.91,
        }),
      }],
    })),
    tracker: { track: vi.fn() },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

describe('operatorConsultRunner', () => {
  beforeEach(() => {
    _resetOperatorConsultRunnerTelemetryForTests();
    vi.restoreAllMocks();
  });

  it('fails closed on non-desktop surfaces before parsing input or doing any other work', async () => {
    const deps = makeDeps();

    const result = await runConsult(
      { operatorId: '/spaces/acme::risk-operator' },
      { surfaceCapability: 'cloud', wasExplicitCouncilIntent: true },
      deps,
    );

    expect(result).toMatchObject({
      isError: true,
      errorCode: 'operator_consult_desktop_only',
    });
    expect(deps.registry.getById).not.toHaveBeenCalled();
    expect(deps.tracker.track).not.toHaveBeenCalled();
  });

  it('returns operator_not_found with available Operator ids when the registry cannot resolve the id', async () => {
    const available = makeOperator({ id: '/spaces/acme::marketing', operatorSlug: 'marketing' });
    const deps = makeDeps({
      registry: {
        getById: vi.fn(() => undefined),
        listAvailable: vi.fn(async () => [available]),
      },
    });

    const result = await runConsult(
      { operatorId: '/spaces/acme::missing', focus: 'Launch risk' },
      { surfaceCapability: 'desktop', rateLimitState: new Map() },
      deps,
    );

    expect(result).toMatchObject({
      isError: true,
      errorCode: 'operator_not_found',
      operatorId: '/spaces/acme::missing',
      availableIds: ['/spaces/acme::marketing'],
    });
    expect(result).not.toHaveProperty('operatorName');
    expect(deps.callModel).not.toHaveBeenCalled();
  });

  it('proceeds with consult even when the Operator has no diary entries (calibration gate removed)', async () => {
    const deps = makeDeps({
      diaryStore: {
        readDiary: vi.fn(async () => ''),
        appendDiary: vi.fn(async () => undefined),
      },
    });

    const result = await runConsult(
      { operatorId: '/spaces/acme::risk-operator', focus: 'Launch risk' },
      { surfaceCapability: 'desktop', rateLimitState: new Map() },
      deps,
    );

    expect(result).toMatchObject({
      isError: false,
      calibrated: true,
      errorCode: null,
      operatorId: '/spaces/acme::risk-operator',
      operatorName: 'Risk Operator',
    });
    expect(deps.callModel).toHaveBeenCalled();
  });

  it('emits the consult-gate-removed breadcrumb once on first invocation', async () => {
    const deps = makeDeps();

    await runConsult(
      { operatorId: '/spaces/acme::risk-operator', focus: 'Launch risk' },
      { surfaceCapability: 'desktop', rateLimitState: new Map() },
      deps,
    );

    expect(deps.logger.info).toHaveBeenCalledWith({}, 'operators:consult_gate_removed');
  });

  it('prefers consultationPrompt frontmatter over body and logs frontmatter source', async () => {
    const operator = makeOperator({
      consultationPrompt: 'Frontmatter consult prompt',
      body: 'Body consult prompt',
    });
    const deps = makeDeps({
      registry: {
        getById: vi.fn(() => operator),
        listAvailable: vi.fn(async () => [operator]),
      },
    });

    await runConsult(
      { operatorId: operator.id, focus: 'Launch risk' },
      { surfaceCapability: 'desktop', rateLimitState: new Map() },
      deps,
    );

    const systemPrompt = vi.mocked(deps.callModel).mock.calls[0]?.[2].system ?? '';
    expect(systemPrompt).toContain('Frontmatter consult prompt');
    expect(systemPrompt).not.toContain('Body consult prompt');
    expect(deps.logger.info).toHaveBeenCalledWith(
      {
        operatorSlug: operator.operatorSlug,
        source: 'frontmatter',
      },
      'operators:consult_prompt_resolved',
    );
  });

  it('falls back to body when consultationPrompt is missing and logs body source', async () => {
    const operator = makeOperator({
      consultationPrompt: undefined,
      body: 'Body consult prompt',
    });
    const deps = makeDeps({
      registry: {
        getById: vi.fn(() => operator),
        listAvailable: vi.fn(async () => [operator]),
      },
    });

    await runConsult(
      { operatorId: operator.id, focus: 'Launch risk' },
      { surfaceCapability: 'desktop', rateLimitState: new Map() },
      deps,
    );

    const systemPrompt = vi.mocked(deps.callModel).mock.calls[0]?.[2].system ?? '';
    expect(systemPrompt).toContain('Body consult prompt');
    expect(deps.logger.info).toHaveBeenCalledWith(
      {
        operatorSlug: operator.operatorSlug,
        source: 'body',
      },
      'operators:consult_prompt_resolved',
    );
  });

  it('treats whitespace-only consultationPrompt as missing and falls back to body', async () => {
    const operator = makeOperator({
      consultationPrompt: '   ',
      body: 'Body consult prompt',
    });
    const deps = makeDeps({
      registry: {
        getById: vi.fn(() => operator),
        listAvailable: vi.fn(async () => [operator]),
      },
    });

    await runConsult(
      { operatorId: operator.id, focus: 'Launch risk' },
      { surfaceCapability: 'desktop', rateLimitState: new Map() },
      deps,
    );

    const systemPrompt = vi.mocked(deps.callModel).mock.calls[0]?.[2].system ?? '';
    expect(systemPrompt).toContain('Body consult prompt');
    expect(deps.logger.info).toHaveBeenCalledWith(
      {
        operatorSlug: operator.operatorSlug,
        source: 'body',
      },
      'operators:consult_prompt_resolved',
    );
  });

  it('includes recent diary entries in the system prompt and returns the parsed consult result', async () => {
    const deps = makeDeps();

    const result = await runConsult(
      { operatorId: '/spaces/acme::risk-operator', focus: 'Should we launch?' },
      { surfaceCapability: 'desktop', rateLimitState: new Map() },
      deps,
    );

    expect(result).toMatchObject({
      isError: false,
      calibrated: true,
      perspective: 'Do not launch until enterprise SSO is ready.',
      evidenceCited: ['Diary: launch readiness'],
      confidence: 0.91,
    });
    expect(deps.callModel).toHaveBeenCalledWith(
      expect.anything(),
      'claude-haiku-4-5',
      expect.anything(),
      { category: 'council' },
    );
    const systemPrompt = vi.mocked(deps.callModel).mock.calls[0]?.[2].system ?? '';
    expect(systemPrompt).toContain('Diary: launch before SSO to move faster.');
  });

  it('prefers execution-route profile and forwards route effort/connectivity', async () => {
    const deps = makeDeps({
      getSettings: vi.fn(() => ({
        coreDirectory: '/spaces',
        behindTheScenesModel: 'model:claude-sonnet-4-6',
      } as AppSettings)),
    });

    await runConsult(
      { operatorId: '/spaces/acme::risk-operator', focus: 'Launch risk' },
      {
        surfaceCapability: 'desktop',
        rateLimitState: new Map(),
        getExecutionRoute: () => ({
          model: 'gpt-5.4-mini',
          profileId: 'profile-codex',
          effort: 'high',
          codexConnectivity: 'connected',
        }),
      },
      deps,
    );

    expect(deps.callModel).toHaveBeenCalledWith(
      expect.anything(),
      'profile:profile-codex',
      expect.objectContaining({
        codexConnectivity: 'connected',
        effort: 'high',
      }),
      { category: 'council' },
    );
  });

  it('prefers execution-route model when profile id is absent', async () => {
    const deps = makeDeps({
      getSettings: vi.fn(() => ({
        coreDirectory: '/spaces',
        behindTheScenesModel: 'model:claude-sonnet-4-6',
      } as AppSettings)),
    });

    await runConsult(
      { operatorId: '/spaces/acme::risk-operator', focus: 'Launch risk' },
      {
        surfaceCapability: 'desktop',
        rateLimitState: new Map(),
        getExecutionRoute: () => ({
          model: 'gpt-5.4',
          codexConnectivity: 'unknown',
        }),
      },
      deps,
    );

    expect(deps.callModel).toHaveBeenCalledWith(
      expect.anything(),
      'gpt-5.4',
      expect.anything(),
      { category: 'council' },
    );
  });

  it('falls back to BTS council model when execution route is unavailable', async () => {
    const deps = makeDeps({
      getSettings: vi.fn(() => ({
        coreDirectory: '/spaces',
        behindTheScenesModel: 'model:claude-sonnet-4-6',
      } as AppSettings)),
    });

    await runConsult(
      { operatorId: '/spaces/acme::risk-operator', focus: 'Launch risk' },
      { surfaceCapability: 'desktop', rateLimitState: new Map() },
      deps,
    );

    expect(deps.callModel).toHaveBeenCalledWith(
      expect.anything(),
      'claude-sonnet-4-6',
      expect.anything(),
      { category: 'council' },
    );
  });

  it('succeeds for codex-connected execution routes by forwarding connectivity', async () => {
    const deps = makeDeps({
      callModel: vi.fn(async (_settings, _model, options) => {
        if (options.codexConnectivity !== 'connected') {
          throw new Error('CodexDisconnectedBtsError');
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              perspective: 'Proceed with launch prep.',
              evidenceCited: ['Codex route connected'],
              confidence: 0.72,
            }),
          }],
        };
      }),
    });

    const result = await runConsult(
      { operatorId: '/spaces/acme::risk-operator', focus: 'Launch risk' },
      {
        surfaceCapability: 'desktop',
        rateLimitState: new Map(),
        getExecutionRoute: () => ({
          model: 'gpt-5.4-mini',
          profileId: 'profile-codex',
          codexConnectivity: 'connected',
        }),
      },
      deps,
    );

    expect(result).toMatchObject({
      isError: false,
      errorCode: null,
      operatorId: '/spaces/acme::risk-operator',
    });
    expect(deps.callModel).toHaveBeenCalledWith(
      expect.anything(),
      'profile:profile-codex',
      expect.objectContaining({ codexConnectivity: 'connected' }),
      { category: 'council' },
    );
  });

  it('returns consult_failed with a classified reason when the BTS call throws', async () => {
    const deps = makeDeps({
      callModel: vi.fn(async () => {
        throw new ModelError('rate_limit', 'synthetic rate limit exceeded', 429);
      }),
    });

    const result = await runConsult(
      { operatorId: '/spaces/acme::risk-operator', focus: 'Launch risk' },
      { surfaceCapability: 'desktop', rateLimitState: new Map() },
      deps,
    );

    expect(result).toMatchObject({
      isError: true,
      errorCode: 'consult_failed',
      reason: 'rate_limited',
      operatorId: '/spaces/acme::risk-operator',
      operatorName: 'Risk Operator',
    });
    expect(deps.diaryStore.appendDiary).not.toHaveBeenCalled();
  });

  it('surfaces a deterministic provider 400 as reason "invalid_request" (not "unknown")', async () => {
    const deps = makeDeps({
      callModel: vi.fn(async () => {
        throw new ModelError('invalid_request', 'Unsupported parameter: temperature', 400);
      }),
    });

    const result = await runConsult(
      { operatorId: '/spaces/acme::risk-operator', focus: 'Launch risk' },
      { surfaceCapability: 'desktop', rateLimitState: new Map() },
      deps,
    );

    expect(result).toMatchObject({
      isError: true,
      errorCode: 'consult_failed',
      reason: 'invalid_request',
      operatorId: '/spaces/acme::risk-operator',
      operatorName: 'Risk Operator',
    });
    expect(deps.diaryStore.appendDiary).not.toHaveBeenCalled();
  });

  it('returns consult_failed and does not append diary when the BTS response is malformed', async () => {
    const deps = makeDeps({
      callModel: vi.fn(async () => ({
        content: [{ type: 'text', text: '{"perspective": ""}' }],
      })),
    });

    const result = await runConsult(
      { operatorId: '/spaces/acme::risk-operator', focus: 'Launch risk' },
      { surfaceCapability: 'desktop', rateLimitState: new Map() },
      deps,
    );

    expect(result).toMatchObject({
      isError: true,
      errorCode: 'consult_failed',
      reason: 'malformed_response',
      operatorId: '/spaces/acme::risk-operator',
      operatorName: 'Risk Operator',
    });
    expect(deps.diaryStore.appendDiary).not.toHaveBeenCalled();
  });

  it('increments per-turn fanout telemetry tagged with explicit council intent', async () => {
    const deps = makeDeps();
    const rateLimitState = new Map<string, number>();

    await runConsult(
      { operatorId: '/spaces/acme::risk-operator', focus: 'Risk one' },
      { surfaceCapability: 'desktop', wasExplicitCouncilIntent: true, rateLimitState },
      deps,
    );
    await runConsult(
      { operatorId: '/spaces/acme::risk-operator', focus: 'Risk two' },
      { surfaceCapability: 'desktop', wasExplicitCouncilIntent: true, rateLimitState },
      deps,
    );

    expect(rateLimitState.get('operator_consult.fanout_count')).toBe(2);
    expect(deps.tracker.track).toHaveBeenNthCalledWith(1, 'operator_consult.fanout_count', {
      count: 1,
      wasExplicitCouncilIntent: true,
    });
    expect(deps.tracker.track).toHaveBeenNthCalledWith(2, 'operator_consult.fanout_count', {
      count: 2,
      wasExplicitCouncilIntent: true,
    });
  });

  it('returns a successful consult with diaryAppendFailed when diary writing fails', async () => {
    const deps = makeDeps({
      diaryStore: {
        readDiary: vi.fn(async () => ''),
        appendDiary: vi.fn(async () => {
          throw new Error('lock acquisition failed');
        }),
      },
    });

    const result = await runConsult(
      { operatorId: '/spaces/acme::risk-operator', focus: 'Launch risk' },
      { surfaceCapability: 'desktop', rateLimitState: new Map() },
      deps,
    );

    expect(result).toMatchObject({
      isError: false,
      calibrated: true,
      diaryAppendFailed: true,
    });
    expect(result.message).toContain('could not save');
  });

  it('uses operator displayName for persona framing, user prompt, and result label when present', async () => {
    const operator = makeOperator({ displayName: 'Risk Operator ACME' });
    const deps = makeDeps({
      registry: {
        getById: vi.fn(() => operator),
        listAvailable: vi.fn(async () => [operator]),
      },
    });

    const result = await runConsult(
      { operatorId: operator.id, focus: 'Launch risk' },
      { surfaceCapability: 'desktop', rateLimitState: new Map() },
      deps,
    );

    expect(result).toMatchObject({
      isError: false,
      operatorName: 'Risk Operator ACME',
    });
    const systemPrompt = vi.mocked(deps.callModel).mock.calls[0]?.[2].system ?? '';
    expect(systemPrompt).toContain('You are Risk Operator ACME');
    const userMessage = vi.mocked(deps.callModel).mock.calls[0]?.[2].messages[0].content ?? '';
    expect(userMessage).toContain('Consult as Risk Operator ACME');
    const diaryEntry = vi.mocked(deps.diaryStore.appendDiary).mock.calls[0]?.[2] ?? '';
    expect(diaryEntry).toContain('Risk Operator ACME');
  });

  it('keeps parallel consult calls independent', async () => {
    const deps = makeDeps();
    const rateLimitState = new Map<string, number>();

    await Promise.all([
      runConsult(
        { operatorId: '/spaces/acme::risk-operator', focus: 'Pricing risk' },
        { surfaceCapability: 'desktop', rateLimitState },
        deps,
      ),
      runConsult(
        { operatorId: '/spaces/acme::risk-operator', focus: 'Security risk' },
        { surfaceCapability: 'desktop', rateLimitState },
        deps,
      ),
    ]);

    const prompts = vi.mocked(deps.callModel).mock.calls.map((call) => call[2].messages[0].content);
    expect(prompts.some((prompt) => prompt.includes('Focus: Pricing risk'))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes('Focus: Security risk'))).toBe(true);
    expect(deps.diaryStore.appendDiary).toHaveBeenCalledTimes(2);
  });
});
