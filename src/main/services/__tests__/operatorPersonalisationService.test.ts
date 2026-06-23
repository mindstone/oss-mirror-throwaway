import { describe, expect, it, vi } from 'vitest';
import { CONVERSATIONS_START_REQUESTED_CHANNEL } from '@shared/ipc/broadcasts';
import type { OperatorDefinition } from '@shared/types/operators';
import type { OperatorPersonalisationServiceDeps } from '../operatorPersonalisationService';
import { startOperatorPersonalisation } from '../operatorPersonalisationService';

const makeOperator = (overrides: Partial<OperatorDefinition> = {}): OperatorDefinition => ({
  id: '/workspace/Chief-of-Staff::brand-critic',
  operatorSlug: 'brand-critic',
  spacePath: '/workspace/Chief-of-Staff',
  sourceSpacePath: '/workspace/Chief-of-Staff',
  category: 'space',
  operatorDirAbsolutePath: '/workspace/Chief-of-Staff/operators/brand-critic',
  operatorFileAbsolutePath: '/workspace/Chief-of-Staff/operators/brand-critic/OPERATOR.md',
  groundingPath: '/workspace/Chief-of-Staff/operators/brand-critic/grounding.md',
  diaryPath: '/workspace/Chief-of-Staff/operators/brand-critic/diary.md',
  name: 'Brand Critic',
  description: 'Keeps the message honest.',
  consult_when: 'When claims need pressure-testing.',
  kind: 'operator',
  roles: ['operator'],
  frontmatter: {
    name: 'Brand Critic',
    description: 'Keeps the message honest.',
    consult_when: 'When claims need pressure-testing.',
    kind: 'operator',
    roles: ['operator'],
  },
  body: 'Voice: blunt.',
  ...overrides,
});

function makeDeps(overrides: Partial<OperatorPersonalisationServiceDeps> = {}): OperatorPersonalisationServiceDeps {
  const operator = makeOperator();
  const workspaceFileSystem = {
    listDirectory: vi.fn(async () => []),
    realPath: vi.fn(async (root: string, target: string) => `${root}/${target}`),
    stat: vi.fn(async () => ({ isDirectory: false, mtimeMs: 0 })),
    readFile: vi.fn(async () => '---\nname: Brand Critic\n---\nBody'),
    writeFile: vi.fn(async () => undefined),
    appendFile: vi.fn(async () => undefined),
    renameFile: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
    exists: vi.fn(async () => true),
  };
  return {
    registry: {
      getById: vi.fn(() => operator),
      listAvailable: vi.fn(async () => [operator]),
    },
    workspaceFileSystem,
    broadcast: vi.fn(),
    generateSessionId: vi.fn(() => 'session-fixed-1'),
    buildPrompt: vi.fn(() => ({
      systemPromptPrefix: 'system prefix',
      firstUserMessage: 'first user message',
    })),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    registerTrustedPrefix: vi.fn(),
    clearTrustedPrefix: vi.fn(),
    ...overrides,
  };
}

describe('startOperatorPersonalisation', () => {
  it('emits a conversations:start-requested broadcast with the personalisation origin and prompt prefix', async () => {
    const deps = makeDeps();

    const result = await startOperatorPersonalisation(
      { operatorSlug: 'brand-critic', targetSpacePath: '/workspace/Chief-of-Staff' },
      deps,
    );

    expect(result).toEqual({ success: true, sessionId: 'session-fixed-1' });
    expect(deps.broadcast).toHaveBeenCalledWith(
      CONVERSATIONS_START_REQUESTED_CHANNEL,
      expect.objectContaining({
        sessionId: 'session-fixed-1',
        text: 'first user message',
        sendMessage: true,
        switchToConversation: true,
        origin: 'operator-personalisation',
        systemPromptPrefix: 'system prefix',
      }),
    );
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ operatorSlug: 'brand-critic' }),
      'operators:personalisation_broadcast_emitted',
    );
  });

  it('returns operator_not_found when the registry has no matching operator', async () => {
    const deps = makeDeps({
      registry: {
        getById: vi.fn(() => undefined),
        listAvailable: vi.fn(async () => []),
      },
    });

    const result = await startOperatorPersonalisation(
      { operatorSlug: 'missing', targetSpacePath: '/workspace/Chief-of-Staff' },
      deps,
    );

    expect(result).toEqual({ success: false, errorCode: 'operator_not_found' });
    expect(deps.broadcast).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ operatorSlug: 'missing' }),
      'operators:personalisation_failed',
    );
  });

  it('returns operator_not_found when reading OPERATOR.md throws', async () => {
    const deps = makeDeps();
    (deps.workspaceFileSystem.readFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ENOENT'));

    const result = await startOperatorPersonalisation(
      { operatorSlug: 'brand-critic', targetSpacePath: '/workspace/Chief-of-Staff' },
      deps,
    );

    expect(result).toEqual({ success: false, errorCode: 'operator_not_found' });
    expect(deps.broadcast).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ operatorSlug: 'brand-critic' }),
      'operators:personalisation_read_failed',
    );
  });

  it('returns broadcast_failed when the broadcast throws', async () => {
    const deps = makeDeps({
      broadcast: vi.fn(() => { throw new Error('disconnected'); }),
    });

    const result = await startOperatorPersonalisation(
      { operatorSlug: 'brand-critic', targetSpacePath: '/workspace/Chief-of-Staff' },
      deps,
    );

    expect(result).toEqual({ success: false, errorCode: 'broadcast_failed' });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ operatorSlug: 'brand-critic', sessionId: 'session-fixed-1' }),
      'operators:personalisation_broadcast_failed',
    );
  });

  it('prefers the operator displayName when building the prompt', async () => {
    const operator = makeOperator({ displayName: 'Brand Critic — Enterprise' });
    const deps = makeDeps({
      registry: {
        getById: vi.fn(() => operator),
        listAvailable: vi.fn(async () => [operator]),
      },
    });

    await startOperatorPersonalisation(
      { operatorSlug: 'brand-critic', targetSpacePath: '/workspace/Chief-of-Staff' },
      deps,
    );

    expect(deps.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({
      operatorName: 'Brand Critic — Enterprise',
      operatorPath: operator.operatorFileAbsolutePath,
    }));
  });
});
