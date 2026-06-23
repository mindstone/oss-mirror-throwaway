import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings } from '@shared/types';
import {
  DEFAULT_VOICE_ACTIVATION_HOTKEY,
  DEFAULT_VOICE_ACTIVATION_VOICE_MODE,
} from '@shared/types';

const {
  mockLogInfo,
  mockLogWarn,
  mockLogError,
  mockLogDebug,
} = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
  mockLogDebug: vi.fn(),
}));

 
vi.mock('@core/logger', () => ({
  logger: {
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    debug: mockLogDebug,
  },
  createScopedLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    debug: mockLogDebug,
  }),
}));

const { generateEnvContext } = await import('../mcpService');

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

describe('generateEnvContext organisation empty-state logging', () => {
  let workspaceDir: string | null = null;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = null;
    }
    vi.clearAllMocks();
  });

  it('emits a structured prompt-summary log for an unorganised space', async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-env-context-'));
    await fs.mkdir(path.join(workspaceDir, 'Personal Research'), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, 'Personal Research', 'README.md'),
      [
        '---',
        'rebel_space_description: Personal research notes',
        'space_type: personal',
        'sharing: private',
        '---',
        '',
      ].join('\n'),
      'utf8',
    );

    await generateEnvContext({
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [
        {
          name: 'Personal Research',
          path: 'Personal Research',
          type: 'personal',
          isSymlink: false,
          createdAt: 1234567890,
        },
      ],
    });

    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceCount: 2,
        organisationCount: 0,
        unorganisedSpaceCount: 2,
        spaces: expect.arrayContaining([
          expect.objectContaining({
            name: 'Personal Research',
            path: 'Personal Research/',
          }),
        ]),
      }),
      'Built space summaries for system prompt',
    );
  });
});
