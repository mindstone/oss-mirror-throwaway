import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings, SpaceConfig } from '@shared/types';
import {
  DEFAULT_VOICE_ACTIVATION_HOTKEY,
  DEFAULT_VOICE_ACTIVATION_VOICE_MODE,
} from '@shared/types';
import { canonicalOrganisationKey } from '@core/services/spaceOrganisationHeuristics';
import { buildSpaceSummaries } from '../mcpService';

const baseSettings: AppSettings = {
  coreDirectory: null,
  mcpConfigFile: null,
  onboardingCompleted: false,
  userEmail: null,
  onboardingFirstCompletedAt: null,
  voice: {
    provider: 'openai-whisper',
    openaiApiKey: null,
    elevenlabsApiKey: null,
    model: 'whisper-1',
    ttsVoice: null,
    activationHotkey: DEFAULT_VOICE_ACTIVATION_HOTKEY,
    activationHotkeyVoiceMode: DEFAULT_VOICE_ACTIVATION_VOICE_MODE,
  },
  models: {
    apiKey: 'test-key',
    oauthToken: null,
    authMethod: 'api-key',
    model: 'claude-sonnet-4-5',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: true,
    extendedContext: true,
    thinkingEffort: 'high',
  },
  diagnostics: {
    debugBreadcrumbsUntil: null,
  },
};

const makeSpaceConfig = (overrides: Partial<SpaceConfig> & Pick<SpaceConfig, 'name' | 'path'>): SpaceConfig => ({
  type: 'company',
  isSymlink: false,
  createdAt: 1234567890,
  ...overrides,
});

const writeSpaceReadme = async (
  workspaceDir: string,
  relativePath: string,
  options: {
    description?: string;
    organisationName?: string;
    sharing?: string;
    spaceType?: string;
  } = {},
): Promise<void> => {
  const fullPath = path.join(workspaceDir, relativePath);
  await fs.mkdir(fullPath, { recursive: true });
  const lines = [
    '---',
    `rebel_space_description: ${options.description ?? `${relativePath} description`}`,
    ...(options.organisationName !== undefined ? [`organisation_name: ${options.organisationName}`] : []),
    `space_type: ${options.spaceType ?? 'team'}`,
    `sharing: ${options.sharing ?? 'restricted'}`,
    '---',
    '',
    `# ${path.basename(relativePath)}`,
    '',
  ];
  await fs.writeFile(path.join(fullPath, 'README.md'), lines.join('\n'), 'utf8');
};

describe('buildSpaceSummaries organisation grouping', () => {
  let workspaceDir: string | null = null;

  afterEach(async () => {
    if (!workspaceDir) return;
    await fs.rm(workspaceDir, { recursive: true, force: true });
    workspaceDir = null;
  });

  it('returns the expected organisation shape for three Mindstone spaces', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-grouping-'));
    await writeSpaceReadme(workspaceDir, 'work/Mindstone/Exec', { organisationName: 'Mindstone' });
    await writeSpaceReadme(workspaceDir, 'work/Mindstone/General', { organisationName: 'Mindstone' });
    await writeSpaceReadme(workspaceDir, 'work/Mindstone/Coaches', { organisationName: 'Mindstone' });

    const summaries = await buildSpaceSummaries({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [
        makeSpaceConfig({ name: 'Mindstone Exec', path: 'work/Mindstone/Exec' }),
        makeSpaceConfig({ name: 'Mindstone General', path: 'work/Mindstone/General' }),
        makeSpaceConfig({ name: 'Mindstone Coaches', path: 'work/Mindstone/Coaches' }),
      ],
    });

    expect(summaries.organisations).toEqual([
      {
        key: canonicalOrganisationKey('Mindstone'),
        displayName: 'Mindstone',
        spaces: expect.arrayContaining([
          expect.objectContaining({ name: 'Mindstone Exec', organisationName: 'Mindstone' }),
          expect.objectContaining({ name: 'Mindstone General', organisationName: 'Mindstone' }),
          expect.objectContaining({ name: 'Mindstone Coaches', organisationName: 'Mindstone' }),
        ]),
      },
    ]);
    expect(summaries.organisations[0].spaces.map(space => space.name)).toEqual([
      'Mindstone Exec',
      'Mindstone General',
      'Mindstone Coaches',
    ]);
  });

  it('buckets casing collisions by canonical organisation key while preserving first display casing', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-grouping-'));
    await writeSpaceReadme(workspaceDir, 'work/Mindstone/Exec', { organisationName: 'Mindstone' });
    await writeSpaceReadme(workspaceDir, 'work/Mindstone/General', { organisationName: 'mindstone' });
    await writeSpaceReadme(workspaceDir, 'work/MindstoneInc/Coaches', { organisationName: 'Mindstone Inc' });

    const summaries = await buildSpaceSummaries({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [
        makeSpaceConfig({ name: 'Exec', path: 'work/Mindstone/Exec' }),
        makeSpaceConfig({ name: 'General', path: 'work/Mindstone/General' }),
        makeSpaceConfig({ name: 'Coaches', path: 'work/MindstoneInc/Coaches' }),
      ],
    });

    expect(summaries.organisations.map(org => ({
      key: org.key,
      displayName: org.displayName,
      spaces: org.spaces.map(space => space.name),
    }))).toEqual([
      { key: 'mindstone', displayName: 'Mindstone', spaces: ['Exec', 'General'] },
      { key: 'mindstone inc', displayName: 'Mindstone Inc', spaces: ['Coaches'] },
    ]);
  });

  it('populates unorganisedSpaces when organisation source is none', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-grouping-'));
    await writeSpaceReadme(workspaceDir, 'Personal Research', {
      description: 'Personal research notes',
      spaceType: 'personal',
      sharing: 'private',
    });

    const summaries = await buildSpaceSummaries({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [
        makeSpaceConfig({ name: 'Personal Research', path: 'Personal Research', type: 'personal' }),
      ],
    });

    expect(summaries.organisations).toEqual([]);
    expect(summaries.unorganisedSpaces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Personal Research',
        path: 'Personal Research/',
      }),
    ]));
  });

  it('sorts organisations alphabetically by display name and preserves member order', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-grouping-'));
    await writeSpaceReadme(workspaceDir, 'work/Mindstone/General', { organisationName: 'Mindstone' });
    await writeSpaceReadme(workspaceDir, 'work/Acme/Sales', { organisationName: 'Acme' });
    await writeSpaceReadme(workspaceDir, 'work/Mindstone/Exec', { organisationName: 'Mindstone' });

    const summaries = await buildSpaceSummaries({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [
        makeSpaceConfig({ name: 'Mindstone General', path: 'work/Mindstone/General' }),
        makeSpaceConfig({ name: 'Acme Sales', path: 'work/Acme/Sales' }),
        makeSpaceConfig({ name: 'Mindstone Exec', path: 'work/Mindstone/Exec' }),
      ],
    });

    expect(summaries.organisations.map(org => org.displayName)).toEqual(['Acme', 'Mindstone']);
    expect(summaries.organisations.find(org => org.displayName === 'Mindstone')?.spaces.map(space => space.name)).toEqual([
      'Mindstone General',
      'Mindstone Exec',
    ]);
  });

  it('keeps Chief-of-Staff at the top of the flat list and includes it in its organisation group', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-grouping-'));
    await writeSpaceReadme(workspaceDir, 'work/Mindstone/General', { organisationName: 'Mindstone' });
    await writeSpaceReadme(workspaceDir, 'Chief-of-Staff', {
      organisationName: 'Mindstone',
      description: 'Router and cross-space context',
      spaceType: 'chief-of-staff',
      sharing: 'private',
    });

    const summaries = await buildSpaceSummaries({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [
        makeSpaceConfig({ name: 'Mindstone General', path: 'work/Mindstone/General' }),
        makeSpaceConfig({ name: 'Chief-of-Staff', path: 'Chief-of-Staff', type: 'chief-of-staff' }),
      ],
    });

    expect(summaries.spaces[0]).toEqual(expect.objectContaining({
      name: 'Chief-of-Staff',
      organisationName: 'Mindstone',
    }));
    expect(summaries.organisations).toHaveLength(1);
    expect(summaries.organisations[0].spaces.map(space => space.name)).toEqual([
      'Chief-of-Staff',
      'Mindstone General',
    ]);
  });
});
