import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings } from '@shared/types';
import {
  DEFAULT_VOICE_ACTIVATION_HOTKEY,
  DEFAULT_VOICE_ACTIVATION_VOICE_MODE,
} from '@shared/types';
import {
  buildSpaceSummaries,
  resolveOrganisationName,
  resolveSystemPrompt,
} from '../mcpService';
import { resolveEffectiveAssociatedAccounts } from '@core/services/space/associatedAccounts';
import { getOnboardingCoachPrompt } from '../onboardingCoachPrompt';
import { invalidateOperatorRegistry } from '@core/services/operatorRegistry';

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

describe('resolveOrganisationName', () => {
  it('prefers frontmatter organisation over settings companyName', () => {
    expect(resolveOrganisationName({ organisation_name: 'Mindstone' }, { companyName: 'Acme' })).toEqual({
      source: 'frontmatter',
      value: 'Mindstone',
    });
  });

  it('falls back to settings companyName when frontmatter has no organisation', () => {
    expect(resolveOrganisationName({}, { companyName: 'Acme' })).toEqual({
      source: 'settings',
      value: 'Acme',
    });
  });

  it('returns none when neither frontmatter nor settings define organisation', () => {
    expect(resolveOrganisationName({}, {})).toEqual({
      source: 'none',
      value: undefined,
    });
  });

  it('structurally does not accept a filesystem path argument', () => {
    // @ts-expect-error — structural guardrail: resolver has no path argument.
    expect(resolveOrganisationName({}, {}, 'work/Mindstone/Exec')).toEqual({
      source: 'none',
      value: undefined,
    });
  });
});

describe('buildSpaceSummaries organisation guardrail', () => {
  let workspaceDir: string | null = null;

  afterEach(async () => {
    invalidateOperatorRegistry();
    if (!workspaceDir) return;
    await fs.rm(workspaceDir, { recursive: true, force: true });
    workspaceDir = null;
  });

  it('does not infer organisation from the path for a path-created space', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-space-summary-'));
    await fs.mkdir(path.join(workspaceDir, 'work', 'Mindstone', 'Chief-of-Staff'), { recursive: true });

    const { spaces } = await buildSpaceSummaries({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [
        {
          name: 'Chief-of-Staff',
          path: 'work/Mindstone/Chief-of-Staff',
          type: 'chief-of-staff',
          isSymlink: false,
          createdAt: 1234567890,
        },
      ],
    });

    expect(spaces).toHaveLength(1);
    expect(spaces[0].path).toBe('work/Mindstone/Chief-of-Staff/');
    expect(Object.prototype.hasOwnProperty.call(spaces[0], 'organisationName')).toBe(false);
  });

  it('emits organisationName for every settings space with a frontmatter or settings source', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-space-summary-'));
    await fs.mkdir(path.join(workspaceDir, 'Chief-of-Staff'), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, 'work', 'Mindstone', 'General'), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, 'work', 'Acme', 'Sales'), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, 'work', 'Mindstone', 'PathOnly'), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, 'work', 'Mindstone', 'General', 'README.md'),
      [
        '---',
        'rebel_space_description: General notes',
        'organisation_name: Mindstone',
        '---',
        '',
      ].join('\n'),
      'utf8',
    );

    const { spaces } = await buildSpaceSummaries({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [
        {
          name: 'Chief-of-Staff',
          path: 'Chief-of-Staff',
          type: 'chief-of-staff',
          isSymlink: false,
          createdAt: 1234567890,
        },
        {
          name: 'General',
          path: 'work/Mindstone/General',
          type: 'company',
          isSymlink: false,
          createdAt: 1234567891,
        },
        {
          name: 'Sales',
          path: 'work/Acme/Sales',
          type: 'company',
          isSymlink: false,
          companyName: 'Acme',
          createdAt: 1234567892,
        },
        {
          name: 'PathOnly',
          path: 'work/Mindstone/PathOnly',
          type: 'company',
          isSymlink: false,
          createdAt: 1234567893,
        },
      ],
    });

    expect(spaces.find(space => space.name === 'General')?.organisationName).toBe('Mindstone');
    expect(spaces.find(space => space.name === 'Sales')?.organisationName).toBe('Acme');
    const pathOnly = spaces.find(space => space.name === 'PathOnly');
    expect(pathOnly).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(pathOnly, 'organisationName')).toBe(false);
  });

  it('emits organisationName for legacy googleDriveLinks via the same resolver', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-space-summary-'));
    await fs.mkdir(path.join(workspaceDir, 'work', 'Legacy', 'Frontmatter'), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, 'work', 'Legacy', 'Settings'), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, 'work', 'Legacy', 'Frontmatter', 'README.md'),
      [
        '---',
        'rebel_space_description: Frontmatter-backed legacy space',
        'organisation_name: Frontmatter Org',
        '---',
        '',
      ].join('\n'),
      'utf8',
    );

    const { spaces } = await buildSpaceSummaries({
      ...baseSettings,
      coreDirectory: workspaceDir,
      companyName: 'Settings Org',
      spaces: undefined,
      googleDriveLinks: [
        {
          driveName: 'Frontmatter',
          sourcePath: '/Volumes/Frontmatter',
          symlinkPath: 'work/Legacy/Frontmatter',
          createdAt: 1234567891,
        },
        {
          driveName: 'Settings',
          sourcePath: '/Volumes/Settings',
          symlinkPath: 'work/Legacy/Settings',
          createdAt: 1234567892,
        },
      ],
    });

    expect(spaces.find(space => space.name === 'Frontmatter')?.organisationName).toBe('Frontmatter Org');
    expect(spaces.find(space => space.name === 'Settings')?.organisationName).toBe('Settings Org');
  });
});

describe('buildSpaceSummaries associated account precedence', () => {
  let workspaceDir: string | null = null;

  afterEach(async () => {
    if (!workspaceDir) return;
    await fs.rm(workspaceDir, { recursive: true, force: true });
    workspaceDir = null;
  });

  async function createSpaceReadme(relativePath: string, emails: string[]): Promise<void> {
    if (!workspaceDir) throw new Error('workspaceDir not initialized');
    const spaceDir = path.join(workspaceDir, relativePath);
    await fs.mkdir(spaceDir, { recursive: true });
    await fs.writeFile(
      path.join(spaceDir, 'README.md'),
      [
        '---',
        'rebel_space_description: Shared Acme Corp space',
        'space_type: company',
        'emails:',
        ...emails.map(email => `  - ${email}`),
        '---',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  it('keeps legacy README emails when local associated accounts are undefined', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-space-summary-'));
    await createSpaceReadme('work/AcmeCorp/Shared', ['[external-email]', 'acmecorp.com']);

    const { spaces } = await buildSpaceSummaries({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [{
        name: 'Shared',
        path: 'work/AcmeCorp/Shared',
        type: 'company',
        isSymlink: false,
        createdAt: 1234567890,
      }],
    });

    expect(spaces.find(space => space.name === 'Shared')?.emails).toEqual([
      '[external-email]',
      'acmecorp.com',
    ]);
  });

  it('uses local associated accounts plus README bare-domain hints when local accounts are defined', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-space-summary-'));
    await createSpaceReadme('work/AcmeCorp/Shared', ['[external-email]', 'acmecorp.com']);

    const { spaces } = await buildSpaceSummaries({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [{
        name: 'Shared',
        path: 'work/AcmeCorp/Shared',
        type: 'company',
        isSymlink: false,
        createdAt: 1234567890,
        associatedAccounts: ['[external-email]'],
      }],
    });

    expect(spaces.find(space => space.name === 'Shared')?.emails).toEqual([
      '[external-email]',
      'acmecorp.com',
    ]);
  });

  it('preserves explicit local none while retaining README bare-domain hints only', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-space-summary-'));
    await createSpaceReadme('work/AcmeCorp/Shared', ['[external-email]', 'acmecorp.com']);

    const { spaces } = await buildSpaceSummaries({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [{
        name: 'Shared',
        path: 'work/AcmeCorp/Shared',
        type: 'company',
        isSymlink: false,
        createdAt: 1234567890,
        associatedAccounts: [],
      }],
    });

    expect(spaces.find(space => space.name === 'Shared')?.emails).toEqual(['acmecorp.com']);
  });

  it('normalizes legacy README wildcard syntax before merging domains', () => {
    expect(resolveEffectiveAssociatedAccounts(['[external-email]'], ['*@acmecorp.com', '@acmecorp.com'])).toEqual([
      '[external-email]',
      'acmecorp.com',
    ]);
  });
});

describe('resolveSystemPrompt operator discovery surface gate', () => {
  let workspaceDir: string | null = null;

  afterEach(async () => {
    invalidateOperatorRegistry();
    if (!workspaceDir) return;
    await fs.rm(workspaceDir, { recursive: true, force: true });
    workspaceDir = null;
  });

  async function writeOperator(
    spaceRelativePath: string,
    slug: string,
    name: string,
    options: { displayName?: string } = {},
  ): Promise<void> {
    if (!workspaceDir) throw new Error('workspaceDir not initialized');
    const operatorDir = path.join(workspaceDir, spaceRelativePath, 'operators', slug);
    await fs.mkdir(operatorDir, { recursive: true });
    await fs.writeFile(
      path.join(operatorDir, 'OPERATOR.md'),
      [
        '---',
        `name: ${name}`,
        ...(options.displayName ? [`display_name: ${options.displayName}`] : []),
        `description: ${name} description.`,
        `consult_when: Ask ${name} when its perspective is relevant.`,
        'kind: operator',
        '---',
        '',
        '## Who you are',
        `${name} helps Rebel think better.`,
      ].join('\n'),
      'utf8',
    );
  }

  it('does not render operators_available on cloud surfaces', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-operator-prompt-'));
    const operatorDir = path.join(workspaceDir, 'Chief-of-Staff', 'operators', 'brand-critic');
    await fs.mkdir(operatorDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, 'Chief-of-Staff', 'README.md'),
      '# Chief of Staff\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(operatorDir, 'OPERATOR.md'),
      [
        '---',
        'name: Brand Critic',
        'description: Checks whether messaging sounds like Rebel.',
        'consult_when: When copy or positioning might be off-brand.',
        'kind: operator',
        '---',
        '',
        '## Who you are',
        'You protect the brand.',
      ].join('\n'),
      'utf8',
    );

    const prompt = await resolveSystemPrompt({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [{
        name: 'Chief-of-Staff',
        path: 'Chief-of-Staff',
        type: 'chief-of-staff',
        isSymlink: false,
        createdAt: 1234567890,
      }],
    }, { surfaceCapability: 'cloud' });

    expect(prompt).not.toContain('<operators_available>');
  });

  it('renders active-Space Operators plus Chief-of-Staff Operators when activeSpacePath is provided', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-operator-prompt-'));
    await fs.mkdir(path.join(workspaceDir, 'Chief-of-Staff'), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, 'work', 'Acme', 'Launch'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'Chief-of-Staff', 'README.md'), '# Chief of Staff\n', 'utf8');
    await writeOperator('Chief-of-Staff', 'platform-critic', 'Platform Critic');
    await writeOperator('work/Acme/Launch', 'launch-critic', 'Launch Critic');
    await writeOperator('work/Acme/Other', 'other-space-critic', 'Other Space Critic');

    const prompt = await resolveSystemPrompt({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [
        { name: 'Chief-of-Staff', path: 'Chief-of-Staff', type: 'chief-of-staff', isSymlink: false, createdAt: 1 },
        { name: 'Launch', path: 'work/Acme/Launch', type: 'company', isSymlink: false, createdAt: 2 },
        { name: 'Other', path: 'work/Acme/Other', type: 'company', isSymlink: false, createdAt: 3 },
      ],
    }, { surfaceCapability: 'desktop', activeSpacePath: 'work/Acme/Launch' });

    expect(prompt).toContain('<operators_available>');
    expect(prompt).toContain('Platform Critic');
    expect(prompt).toContain('Launch Critic');
    expect(prompt).not.toContain('Other Space Critic');
  });

  it('renders only Chief-of-Staff Operators when activeSpacePath is omitted', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-operator-prompt-'));
    await fs.mkdir(path.join(workspaceDir, 'Chief-of-Staff'), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, 'work', 'Acme', 'Launch'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'Chief-of-Staff', 'README.md'), '# Chief of Staff\n', 'utf8');
    await writeOperator('Chief-of-Staff', 'platform-critic', 'Platform Critic');
    await writeOperator('work/Acme/Launch', 'launch-critic', 'Launch Critic');

    const prompt = await resolveSystemPrompt({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [
        { name: 'Chief-of-Staff', path: 'Chief-of-Staff', type: 'chief-of-staff', isSymlink: false, createdAt: 1 },
        { name: 'Launch', path: 'work/Acme/Launch', type: 'company', isSymlink: false, createdAt: 2 },
      ],
    }, { surfaceCapability: 'desktop' });

    expect(prompt).toContain('<operators_available>');
    expect(prompt).toContain('Platform Critic');
    expect(prompt).not.toContain('Launch Critic');
  });

  it('does not include bundled rebel-system Operators until activated in a user Space', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-operator-prompt-'));
    await fs.mkdir(path.join(workspaceDir, 'Chief-of-Staff'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'Chief-of-Staff', 'README.md'), '# Chief of Staff\n', 'utf8');
    await writeOperator('rebel-system', 'brand-critic', 'Brand Critic');

    const prompt = await resolveSystemPrompt({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [
        { name: 'Chief-of-Staff', path: 'Chief-of-Staff', type: 'chief-of-staff', isSymlink: false, createdAt: 1 },
      ],
    }, { surfaceCapability: 'desktop' });

    expect(prompt).not.toContain('<operators_available>');
    expect(prompt).not.toContain('Brand Critic');
  });

  it('includes a bundled Operator after it has been activated into a scoped user Space', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-operator-prompt-'));
    await fs.mkdir(path.join(workspaceDir, 'Chief-of-Staff'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'Chief-of-Staff', 'README.md'), '# Chief of Staff\n', 'utf8');
    await writeOperator('rebel-system', 'brand-critic', 'Brand Critic');
    await writeOperator('Chief-of-Staff', 'brand-critic', 'Brand Critic');

    const prompt = await resolveSystemPrompt({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [
        { name: 'Chief-of-Staff', path: 'Chief-of-Staff', type: 'chief-of-staff', isSymlink: false, createdAt: 1 },
      ],
    }, { surfaceCapability: 'desktop' });

    expect(prompt).toContain('<operators_available>');
    expect(prompt).toContain('Brand Critic');
  });

  it('renders operator display_name in operators_available when present', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-operator-prompt-'));
    await fs.mkdir(path.join(workspaceDir, 'Chief-of-Staff'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'Chief-of-Staff', 'README.md'), '# Chief of Staff\n', 'utf8');
    await writeOperator('Chief-of-Staff', 'customer-voice', 'Customer Voice', {
      displayName: 'Customer Voice ACME',
    });
    await writeOperator('Chief-of-Staff', 'platform-critic', 'Platform Critic');

    const prompt = await resolveSystemPrompt({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [{ name: 'Chief-of-Staff', path: 'Chief-of-Staff', type: 'chief-of-staff', isSymlink: false, createdAt: 1 }],
    }, { surfaceCapability: 'desktop' });
    const block = String(prompt).match(/<operators_available>[\s\S]*?<\/operators_available>/u)?.[0] ?? '';

    expect(block).toContain('name: "Customer Voice ACME"');
    expect(block).not.toContain('name: "Customer Voice"');
    expect(block).toContain('name: "Platform Critic"');
  });

  it('caps operators_available rendering at 10 Operators', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-operator-prompt-'));
    await fs.mkdir(path.join(workspaceDir, 'Chief-of-Staff'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'Chief-of-Staff', 'README.md'), '# Chief of Staff\n', 'utf8');
    for (let index = 1; index <= 11; index += 1) {
      await writeOperator('Chief-of-Staff', `operator-${String(index).padStart(2, '0')}`, `Operator ${index}`);
    }

    const prompt = await resolveSystemPrompt({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [{ name: 'Chief-of-Staff', path: 'Chief-of-Staff', type: 'chief-of-staff', isSymlink: false, createdAt: 1 }],
    }, { surfaceCapability: 'desktop' });
    const block = String(prompt).match(/<operators_available>[\s\S]*?<\/operators_available>/u)?.[0] ?? '';

    expect(block.match(/name: "Operator /gu)).toHaveLength(10);
    expect(block).toContain('Operator 1');
    expect(block).not.toContain('Operator 11');
  });
});

describe('resolveSystemPrompt onboarding-coach prompt injection', () => {
  let workspaceDir: string | null = null;

  afterEach(async () => {
    invalidateOperatorRegistry();
    if (!workspaceDir) return;
    await fs.rm(workspaceDir, { recursive: true, force: true });
    workspaceDir = null;
  });

  it('preserves onboarding-coach prompt prefix detection when promptSessionMode override is interactive', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-onboarding-coach-'));
    await fs.mkdir(path.join(workspaceDir, 'Chief-of-Staff'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'Chief-of-Staff', 'README.md'), '# Chief of Staff\n', 'utf8');

    const settings: AppSettings = {
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [{ name: 'Chief-of-Staff', path: 'Chief-of-Staff', type: 'chief-of-staff', isSymlink: false, createdAt: 1 }],
    };

    const baselinePrompt = await resolveSystemPrompt(settings, {
      sessionType: 'interactive',
      promptSessionMode: 'interactive',
    });
    const onboardingPrompt = await resolveSystemPrompt(settings, {
      sessionType: 'onboarding-coach',
      promptSessionMode: 'interactive',
    });

    const onboardingCoachPrompt = getOnboardingCoachPrompt();
    expect(baselinePrompt).not.toContain(onboardingCoachPrompt);
    expect(onboardingPrompt).toContain(onboardingCoachPrompt);
  });
});
