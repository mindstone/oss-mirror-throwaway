import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings } from '@shared/types';
import {
  DEFAULT_VOICE_ACTIVATION_HOTKEY,
  DEFAULT_VOICE_ACTIVATION_VOICE_MODE,
} from '@shared/types';
import { resolveSystemPrompt } from '../mcpService';
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

describe('resolveSystemPrompt systemPromptPrefix integration', () => {
  let workspaceDir: string | null = null;

  afterEach(async () => {
    invalidateOperatorRegistry();
    if (!workspaceDir) return;
    await fs.rm(workspaceDir, { recursive: true, force: true });
    workspaceDir = null;
  });

  async function makeSettings(): Promise<AppSettings> {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-system-prompt-prefix-'));
    await fs.mkdir(path.join(workspaceDir, 'Chief-of-Staff'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'Chief-of-Staff', 'README.md'), '# Chief of Staff\n', 'utf8');
    return {
      ...baseSettings,
      coreDirectory: workspaceDir,
      spaces: [{ name: 'Chief-of-Staff', path: 'Chief-of-Staff', type: 'chief-of-staff', isSymlink: false, createdAt: 1 }],
    };
  }

  it('prepends a non-empty systemPromptPrefix to the rendered composite prompt', async () => {
    const settings = await makeSettings();

    const prompt = await resolveSystemPrompt(settings, {
      systemPromptPrefix: 'TEST_PREFIX_MARKER personalisation context goes here',
    });

    expect(typeof prompt).toBe('string');
    if (typeof prompt !== 'string') return;
    expect(prompt).toContain('TEST_PREFIX_MARKER personalisation context goes here');
    const prefixIndex = prompt.indexOf('TEST_PREFIX_MARKER');
    const compositeIndex = prompt.indexOf('Chief-of-Staff');
    expect(prefixIndex).toBeGreaterThanOrEqual(0);
    expect(compositeIndex).toBeGreaterThan(prefixIndex);
  });

  it('omits the prefix when systemPromptPrefix is undefined', async () => {
    const settings = await makeSettings();

    const promptWithoutPrefix = await resolveSystemPrompt(settings, {});
    const promptWithPrefix = await resolveSystemPrompt(settings, {
      systemPromptPrefix: 'TEST_PREFIX_MARKER',
    });

    expect(typeof promptWithoutPrefix).toBe('string');
    if (typeof promptWithoutPrefix !== 'string') return;
    expect(promptWithoutPrefix).not.toContain('TEST_PREFIX_MARKER');

    expect(typeof promptWithPrefix).toBe('string');
    if (typeof promptWithPrefix !== 'string') return;
    expect(promptWithPrefix).toContain('TEST_PREFIX_MARKER');
  });

  it('treats whitespace-only systemPromptPrefix as absent', async () => {
    const settings = await makeSettings();

    const prompt = await resolveSystemPrompt(settings, {
      systemPromptPrefix: '   \n\t   ',
    });

    expect(typeof prompt).toBe('string');
    if (typeof prompt !== 'string') return;
    const baseline = await resolveSystemPrompt(settings, {});
    expect(prompt).toEqual(baseline);
  });
});
