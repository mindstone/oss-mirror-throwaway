import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { OperatorDefinition } from '@shared/types/operators';
import { setTracker } from '@core/tracking';
import { executeBuiltinTool, getBuiltinToolDefinitions, isBuiltinToolName } from '../builtinTools';

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  listAvailable: vi.fn(),
  readDiary: vi.fn(),
  appendDiary: vi.fn(),
  callWithModelAuthAware: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock('@core/services/operatorRegistry', () => ({
  getById: mocks.getById,
  listAvailable: mocks.listAvailable,
  invalidateOperatorRegistry: vi.fn(),
}));

vi.mock('@core/services/operatorDiaryStore', () => ({
  readDiary: mocks.readDiary,
  appendDiary: mocks.appendDiary,
}));

vi.mock('@core/services/behindTheScenesClient', () => ({
  callWithModelAuthAware: mocks.callWithModelAuthAware,
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: mocks.getSettings,
  updateSettings: vi.fn(),
}));

const operator: OperatorDefinition = {
  id: '/spaces/acme::risk-operator',
  name: 'Risk Operator',
  description: 'Finds operational risk.',
  consult_when: 'Use for risk questions.',
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
    consult_when: 'Use for risk questions.',
    kind: 'operator',
    roles: ['operator'],
  },
  body: 'Voice: terse.',
};

const parseOutput = (output: string): Record<string, unknown> => JSON.parse(output) as Record<string, unknown>;

describe('operator consult built-in tool', () => {
  let trackMock: ReturnType<typeof vi.fn<(event: string, properties?: Record<string, unknown>) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    trackMock = vi.fn<(event: string, properties?: Record<string, unknown>) => void>();
    setTracker({
      track: (event, properties) => trackMock(event, properties),
      identify: vi.fn(),
      getAnonymousId: () => 'anon',
      isAvailable: () => true,
    });
    mocks.getById.mockReturnValue(operator);
    mocks.listAvailable.mockResolvedValue([operator]);
    mocks.readDiary.mockResolvedValue('');
    mocks.appendDiary.mockResolvedValue(undefined);
    mocks.callWithModelAuthAware.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify({
          perspective: 'Wait for enterprise SSO before launch.',
          evidenceCited: ['Enterprise SSO'],
          confidence: 0.88,
        }),
      }],
    });
    mocks.getSettings.mockReturnValue({ coreDirectory: '/spaces' } as AppSettings);
  });

  it('registers rebel_operator__consult as a built-in tool definition and name', () => {
    const definition = getBuiltinToolDefinitions().find((tool) => tool.name === 'rebel_operator__consult');

    expect(isBuiltinToolName('rebel_operator__consult')).toBe(true);
    expect(definition).toMatchObject({
      name: 'rebel_operator__consult',
      input_schema: {
        required: ['operatorId', 'focus'],
      },
    });
  });

  it('returns a structured validation error envelope for invalid input', async () => {
    const result = await executeBuiltinTool('rebel_operator__consult', {
      operatorId: operator.id,
    }, { surfaceCapability: 'desktop' });

    expect(result.isError).toBe(true);
    expect(result.output).toBe('Operator consult input must include operatorId and focus.');
    expect(mocks.callWithModelAuthAware).not.toHaveBeenCalled();
  });

  it('returns the desktop-only fail-closed error envelope on cloud', async () => {
    const result = await executeBuiltinTool('rebel_operator__consult', {
      operatorId: operator.id,
      focus: 'Launch risk',
    }, { surfaceCapability: 'cloud' });

    expect(result.isError).toBe(true);
    expect(result.output).toBe('Operator consults use local Space files and are only available in the desktop app.');
    expect(mocks.getById).not.toHaveBeenCalled();
  });

  it('increments telemetry and writes the successful consult through to the diary', async () => {
    const result = await executeBuiltinTool('rebel_operator__consult', {
      operatorId: operator.id,
      focus: 'Launch risk',
    }, { surfaceCapability: 'desktop', wasExplicitCouncilIntent: false, rateLimitState: new Map() });

    expect(result.isError).toBe(false);
    expect(parseOutput(result.output)).toMatchObject({
      isError: false,
      calibrated: true,
      operatorId: operator.id,
      perspective: 'Wait for enterprise SSO before launch.',
      diaryAppendFailed: false,
    });
    expect(trackMock).toHaveBeenCalledWith('operator_consult.fanout_count', {
      count: 1,
      wasExplicitCouncilIntent: false,
    });
    expect(mocks.appendDiary).toHaveBeenCalledWith(
      operator.id,
      operator.spacePath,
      expect.stringContaining('Wait for enterprise SSO before launch.'),
    );
  });

  it('passes explicit council intent through to runner telemetry', async () => {
    await executeBuiltinTool('rebel_operator__consult', {
      operatorId: operator.id,
      focus: 'Launch risk',
    }, { surfaceCapability: 'desktop', wasExplicitCouncilIntent: true, rateLimitState: new Map() });

    expect(trackMock).toHaveBeenCalledWith('operator_consult.fanout_count', {
      count: 1,
      wasExplicitCouncilIntent: true,
    });
  });

  it('returns structured error output with operator identity when consult fails after resolution', async () => {
    mocks.callWithModelAuthAware.mockRejectedValueOnce(new Error('network timeout'));

    const result = await executeBuiltinTool('rebel_operator__consult', {
      operatorId: operator.id,
      focus: 'Launch risk',
    }, { surfaceCapability: 'desktop', rateLimitState: new Map() });

    expect(result.isError).toBe(true);
    expect(parseOutput(result.output)).toMatchObject({
      isError: true,
      errorCode: 'consult_failed',
      message: 'Consult with Risk Operator failed before it could return a perspective.',
      operatorId: operator.id,
      operatorName: 'Risk Operator',
    });
  });

  it('includes a warning in the success envelope when the diary append fails', async () => {
    mocks.appendDiary.mockRejectedValueOnce(new Error('lock busy'));

    const result = await executeBuiltinTool('rebel_operator__consult', {
      operatorId: operator.id,
      focus: 'Launch risk',
    }, { surfaceCapability: 'desktop', rateLimitState: new Map() });

    expect(result.isError).toBe(false);
    expect(parseOutput(result.output)).toMatchObject({
      isError: false,
      calibrated: true,
      diaryAppendFailed: true,
      warning: expect.stringContaining('Disclose this briefly'),
    });
  });
});
