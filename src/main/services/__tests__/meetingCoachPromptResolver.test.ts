import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorRegistry } from '@core/services/operatorRegistry';
import type { OperatorDefinition } from '@shared/types/operators';
import { createOperatorId } from '@shared/types/operators';

const loggerInfo = vi.fn();

function hashPrompt(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function buildRegistry(operators: OperatorDefinition[]): OperatorRegistry {
  const byId = new Map<string, OperatorDefinition>(operators.map((operator) => [operator.id, operator]));
  return {
    listAvailable: async () => operators,
    listAvailableWithDiagnostics: async () => ({ operators, failures: [] }),
    getById: (operatorId: string) => byId.get(operatorId),
    invalidate: () => undefined,
  };
}

function buildOperator(args: {
  spacePath: string;
  operatorSlug: string;
  operatorFileAbsolutePath: string;
  roles: Array<'operator' | 'live_meeting'>;
  body: string;
  livePrompt?: string;
  proactiveIntervalMinutes?: number;
}): OperatorDefinition {
  const operatorDirAbsolutePath = path.dirname(args.operatorFileAbsolutePath);
  return {
    id: createOperatorId(args.spacePath, args.operatorSlug),
    operatorSlug: args.operatorSlug,
    spacePath: args.spacePath,
    sourceSpacePath: args.spacePath,
    category: 'space',
    operatorDirAbsolutePath,
    operatorFileAbsolutePath: args.operatorFileAbsolutePath,
    groundingPath: path.join(operatorDirAbsolutePath, 'grounding.md'),
    diaryPath: path.join(operatorDirAbsolutePath, 'diary.md'),
    frontmatter: {
      name: args.operatorSlug,
      description: 'Test operator',
      consult_when: 'When asked',
      kind: 'operator',
      roles: args.roles,
      ...(args.livePrompt ? { live_prompt: args.livePrompt } : {}),
      ...(args.proactiveIntervalMinutes !== undefined
        ? { proactive_interval_minutes: args.proactiveIntervalMinutes }
        : {}),
    },
    name: args.operatorSlug,
    description: 'Test operator',
    consult_when: 'When asked',
    kind: 'operator',
    roles: args.roles,
    ...(args.livePrompt ? { livePrompt: args.livePrompt } : {}),
    ...(args.proactiveIntervalMinutes !== undefined
      ? { proactiveIntervalMinutes: args.proactiveIntervalMinutes }
      : {}),
    body: args.body,
  };
}

async function loadResolverModule(): Promise<typeof import('../meetingCoachPromptResolver')> {
  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => ({
      debug: vi.fn(),
      info: loggerInfo,
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }));
  return import('../meetingCoachPromptResolver');
}

describe('meetingCoachPromptResolver', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    loggerInfo.mockReset();
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'meeting-coach-resolver-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns operator-frontmatter prompt when OPERATOR.md has a live_meeting live_prompt even before registry scan', async () => {
    const { resolveMeetingCoachPrompt } = await loadResolverModule();
    const operatorFilePath = path.join(tempDir, 'operators', 'sales-coach', 'OPERATOR.md');
    await fs.promises.mkdir(path.dirname(operatorFilePath), { recursive: true });
    await fs.promises.writeFile(
      operatorFilePath,
      [
        '---',
        'name: Sales Coach',
        'description: Live coaching helper.',
        'kind: operator',
        'roles: [live_meeting]',
        'live_prompt: Frontmatter live prompt',
        'proactive_interval_minutes: 7',
        '---',
        '',
        'Fallback body prompt.',
        '',
      ].join('\n'),
      'utf8',
    );

    const resolved = resolveMeetingCoachPrompt(operatorFilePath, buildRegistry([]));
    expect(resolved).toEqual({
      prompt: 'Frontmatter live prompt',
      contentHash: hashPrompt('Frontmatter live prompt'),
      source: 'operator-frontmatter',
      proactiveIntervalMinutes: 7,
    });
  });

  it('falls back to file body when live_prompt is missing', async () => {
    const { resolveMeetingCoachPrompt } = await loadResolverModule();
    const operatorFilePath = path.join(tempDir, 'operators', 'exec-coach', 'OPERATOR.md');
    await fs.promises.mkdir(path.dirname(operatorFilePath), { recursive: true });
    await fs.promises.writeFile(
      operatorFilePath,
      '---\nname: exec-coach\nkind: operator\nroles: [live_meeting]\n---\n\nBody fallback prompt.\n',
      'utf8',
    );

    const registry = buildRegistry([
      buildOperator({
        spacePath: tempDir,
        operatorSlug: 'exec-coach',
        operatorFileAbsolutePath: operatorFilePath,
        roles: ['live_meeting'],
        body: 'Body fallback prompt.',
      }),
    ]);

    const resolved = resolveMeetingCoachPrompt(operatorFilePath, registry);
    expect(resolved).toEqual({
      prompt: 'Body fallback prompt.',
      contentHash: hashPrompt('Body fallback prompt.'),
      source: 'file-body',
    });
  });

  it('falls back to file body when operator does not have live_meeting role', async () => {
    const { resolveMeetingCoachPrompt } = await loadResolverModule();
    const operatorFilePath = path.join(tempDir, 'operators', 'investor-view', 'OPERATOR.md');
    await fs.promises.mkdir(path.dirname(operatorFilePath), { recursive: true });
    await fs.promises.writeFile(
      operatorFilePath,
      [
        '---',
        'name: investor-view',
        'description: Async perspective.',
        'consult_when: Strategic trade-offs.',
        'kind: operator',
        'roles: [operator]',
        '---',
        '',
        'Operator body prompt.',
        '',
      ].join('\n'),
      'utf8',
    );

    const resolved = resolveMeetingCoachPrompt(operatorFilePath, buildRegistry([]));
    expect(resolved).toEqual({
      prompt: 'Operator body prompt.',
      contentHash: hashPrompt('Operator body prompt.'),
      source: 'file-body',
    });
  });

  it('falls back to file body when path does not resolve to a registered operator', async () => {
    const { resolveMeetingCoachPrompt } = await loadResolverModule();
    const legacySkillPath = path.join(tempDir, 'skills', 'coaching', 'sales', 'SKILL.md');
    await fs.promises.mkdir(path.dirname(legacySkillPath), { recursive: true });
    await fs.promises.writeFile(
      legacySkillPath,
      '---\nname: legacy-skill\nkind: skill\n---\n\nLegacy file body prompt.\n',
      'utf8',
    );

    const resolved = resolveMeetingCoachPrompt(legacySkillPath, buildRegistry([]));
    expect(resolved).toEqual({
      prompt: 'Legacy file body prompt.',
      contentHash: hashPrompt('Legacy file body prompt.'),
      source: 'file-body',
    });
  });

  it('produces different content hashes for different resolved prompts', async () => {
    const { resolveMeetingCoachPrompt } = await loadResolverModule();
    const firstSkillPath = path.join(tempDir, 'skills', 'coach-a', 'SKILL.md');
    const secondSkillPath = path.join(tempDir, 'skills', 'coach-b', 'SKILL.md');
    await fs.promises.mkdir(path.dirname(firstSkillPath), { recursive: true });
    await fs.promises.mkdir(path.dirname(secondSkillPath), { recursive: true });
    await fs.promises.writeFile(firstSkillPath, '---\nname: a\n---\n\nPrompt A.\n', 'utf8');
    await fs.promises.writeFile(secondSkillPath, '---\nname: b\n---\n\nPrompt B.\n', 'utf8');

    const first = resolveMeetingCoachPrompt(firstSkillPath, buildRegistry([]));
    const second = resolveMeetingCoachPrompt(secondSkillPath, buildRegistry([]));

    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it('re-reads OPERATOR.md live_prompt changes and updates content hash', async () => {
    const { resolveMeetingCoachPrompt } = await loadResolverModule();
    const operatorFilePath = path.join(tempDir, 'operators', 'pitch-coach', 'OPERATOR.md');
    await fs.promises.mkdir(path.dirname(operatorFilePath), { recursive: true });

    const writeOperatorFile = async (livePrompt: string) => {
      await fs.promises.writeFile(
        operatorFilePath,
        [
          '---',
          'name: pitch-coach',
          'description: Live pitch coach.',
          'kind: operator',
          'roles: [live_meeting]',
          `live_prompt: ${livePrompt}`,
          '---',
          '',
          'Fallback body prompt.',
          '',
        ].join('\n'),
        'utf8',
      );
    };

    await writeOperatorFile('Prompt Version One');
    const first = resolveMeetingCoachPrompt(operatorFilePath, buildRegistry([]));

    await writeOperatorFile('Prompt Version Two');
    const second = resolveMeetingCoachPrompt(operatorFilePath, buildRegistry([]));

    expect(first.source).toBe('operator-frontmatter');
    expect(second.source).toBe('operator-frontmatter');
    expect(first.prompt).toBe('Prompt Version One');
    expect(second.prompt).toBe('Prompt Version Two');
    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it('emits structured breadcrumb with source/hash metadata', async () => {
    const { resolveMeetingCoachPrompt } = await loadResolverModule();
    const operatorFilePath = path.join(tempDir, 'operators', 'pitch-coach', 'OPERATOR.md');
    await fs.promises.mkdir(path.dirname(operatorFilePath), { recursive: true });
    await fs.promises.writeFile(
      operatorFilePath,
      [
        '---',
        'name: pitch-coach',
        'description: Live pitch coach.',
        'kind: operator',
        'roles: [live_meeting]',
        'live_prompt: Pitch live prompt',
        'proactive_interval_minutes: 3',
        '---',
        '',
        'fallback body',
        '',
      ].join('\n'),
      'utf8',
    );

    const resolved = resolveMeetingCoachPrompt(operatorFilePath, buildRegistry([]));
    expect(resolved.source).toBe('operator-frontmatter');
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        coachSkillPath: operatorFilePath,
        source: 'operator-frontmatter',
        contentHash: resolved.contentHash,
        hasProactiveInterval: true,
      }),
      'operators:meeting_coach_prompt_resolved',
    );
  });
});
