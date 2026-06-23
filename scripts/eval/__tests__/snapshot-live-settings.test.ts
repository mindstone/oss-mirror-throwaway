import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadHermeticEvalConfig } from '../../../evals/configs/loader';
import { snapshotLiveSettings } from '../snapshot-live-settings';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'snapshot-live-settings-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRepoRoot(): string {
  return makeTempDir('snapshot-live-settings-repo-');
}

function snapshotPath(repoRoot: string): string {
  return path.join(repoRoot, 'evals', 'configs', '.local', 'default.json');
}

function writeAppSettings(settings: Record<string, unknown>): string {
  const dir = makeTempDir('snapshot-live-settings-app-settings-');
  const filePath = path.join(dir, 'app-settings.json');
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf8');
  return filePath;
}

function makeLogger(): {
  logs: string[];
  errors: string[];
  logger: { log: (message: string) => void; error: (message: string) => void };
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    logger: {
      log: (message: string) => {
        logs.push(message);
      },
      error: (message: string) => {
        errors.push(message);
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('snapshot-live-settings', () => {
  it('round-trips synthetic app settings into a hermetic eval config', () => {
    const repoRoot = makeRepoRoot();
    const appSettingsPath = writeAppSettings({
      activeProvider: 'codex',
      claude: {
        model: 'profile:working-model',
        thinkingModel: 'profile:thinking-model',
        permissionMode: 'plan',
        longContextFallbackModel: 'claude-haiku-4-5',
        longContextFallbackProfileId: 'profile:long-context',
        thinkingFallback: 'profile:thinking-fallback',
        workingFallback: 'profile:working-fallback',
        apiKey: 'should-not-leak',
      },
      providerKeys: {
        openai: 'should-not-leak',
      },
      localModel: {
        profiles: [
          {
            id: 'profile:working-model',
            name: 'Working profile',
            providerType: 'other',
            serverUrl: 'https://example.com/v1',
            model: 'model-1',
            apiKey: 'should-not-leak',
            customProviderId: 'custom-provider-1',
            reasoningEffort: 'xhigh',
            createdAt: 1700000000000,
          },
        ],
      },
      customProviders: [
        {
          id: 'custom-provider-1',
          name: 'Custom Gateway',
          serverUrl: 'https://gateway.example/v1',
          apiKey: 'should-not-leak',
          createdAt: 1700000000001,
        },
      ],
      openRouter: {
        enabled: true,
        oauthToken: 'should-not-leak',
        selectedModel: 'openai/gpt-5.4',
        baseUrl: 'https://openrouter.example.internal/v1',
      },
      spaces: [
        {
          name: 'Chief-of-Staff',
          path: 'Chief-of-Staff',
          type: 'chief-of-staff',
          isSymlink: false,
          createdAt: 1700000000002,
        },
      ],
      coreDirectory: '/tmp/eval-core',
      mcpConfigFile: '/tmp/mcp.json',
      companyName: 'Eval Corp',
      backgroundFallback: 'model:claude-haiku-4-5',
      localInferenceCloudFallback: 'profile:working-model',
      behindTheScenesModel: 'profile:bts-model',
      behindTheScenesOverrides: {
        safety: 'profile:bts-model',
      },
      toolSafetyLevel: 'balanced',
      trustedTools: [
        {
          toolId: 'Read',
          displayName: 'Read file',
          addedAt: 1700000000003,
        },
      ],
      experimental: {
        localInferenceEnabled: true,
      },
      enforceSoftwareEngineerEvidence: true,
    });
    const { logger, logs } = makeLogger();

    const result = snapshotLiveSettings({
      apply: true,
      appSettingsPath,
      repoRoot,
      logger,
    });

    const config = loadHermeticEvalConfig(result.outputPath);

    expect(result.wroteFile).toBe(true);
    expect(config.bundle).toEqual({
      thinking: 'profile:thinking-model',
      working: 'profile:working-model',
      background: null,
    });
    expect(config.activeProvider).toBe('codex');
    expect(config.cliProvider).toBe('auto');
    expect(config.useCodex).toBe(true);
    expect(config.profiles).toEqual([
      {
        id: 'profile:working-model',
        name: 'Working profile',
        providerType: 'other',
        serverUrl: 'https://example.com/v1',
        model: 'model-1',
        customProviderId: 'custom-provider-1',
        reasoningEffort: 'xhigh',
        createdAt: 1700000000000,
      },
    ]);
    expect(config.customProviders).toEqual([
      {
        id: 'custom-provider-1',
        name: 'Custom Gateway',
        serverUrl: 'https://gateway.example/v1',
      },
    ]);
    expect(config.openRouter).toEqual({
      enabled: true,
      selectedModel: 'openai/gpt-5.4',
      baseUrl: 'https://openrouter.example.internal/v1',
    });
    expect(config.workspace).toEqual({
      companyName: 'Eval Corp',
      indexSourceCoreDirectory: '/tmp/eval-core',
      mcpConfigFile: '/tmp/mcp.json',
      spaces: [
        {
          name: 'Chief-of-Staff',
          path: 'Chief-of-Staff',
          type: 'chief-of-staff',
          isSymlink: false,
          createdAt: 1700000000002,
        },
      ],
    });
    expect(config.defaults).toEqual({
      backgroundFallback: 'model:claude-haiku-4-5',
      localInferenceCloudFallback: 'profile:working-model',
      behindTheScenesModel: 'profile:bts-model',
      behindTheScenesOverrides: { safety: 'profile:bts-model' },
      permissionMode: 'plan',
      longContextFallbackModel: 'claude-haiku-4-5',
      longContextFallbackProfileId: 'profile:long-context',
      thinkingFallback: 'profile:thinking-fallback',
      workingFallback: 'profile:working-fallback',
    });
    expect(config.toolSafety).toEqual({
      level: 'balanced',
      trustedTools: [
        {
          toolId: 'Read',
          displayName: 'Read file',
          addedAt: 1700000000003,
        },
      ],
    });
    expect(config.experimental).toEqual({ localInferenceEnabled: true, adaptiveRoutingEnabled: false });
    expect(config.enforceSoftwareEngineerEvidence).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('cliProvider'),
      expect.stringContaining('bundle.background'),
    ]));
    expect(logs.some((line) => line.includes('Snapshotted live settings'))).toBe(true);

    const rawConfig = fs.readFileSync(snapshotPath(repoRoot), 'utf8');
    expect(rawConfig).not.toContain('"apiKey"');
    expect(rawConfig).not.toContain('"providerKeys"');
    expect(rawConfig).not.toContain('"oauthToken"');
  });

  it('dry-run does not write and emits warning output', () => {
    const repoRoot = makeRepoRoot();
    const appSettingsPath = writeAppSettings({
      claude: { model: 'claude-sonnet-4-6' },
    });
    const { logger, logs } = makeLogger();

    const result = snapshotLiveSettings({ appSettingsPath, repoRoot, logger });

    expect(result.wroteFile).toBe(false);
    expect(fs.existsSync(snapshotPath(repoRoot))).toBe(false);
    expect(logs.some((line) => line.includes('Dry-run preview'))).toBe(true);
    expect(logs.some((line) => line.includes('Warnings:'))).toBe(true);
    expect(logs.some((line) => line.includes('bundle.background'))).toBe(true);
    expect(logs.some((line) => line.includes('Dry run only.'))).toBe(true);
    expect(logs.some((line) => line.includes('Snapshotted live settings'))).toBe(false);
  });

  it('--apply writes default.json with 0644 permissions', () => {
    const repoRoot = makeRepoRoot();
    const appSettingsPath = writeAppSettings({
      claude: { model: 'claude-sonnet-4-6' },
    });
    const { logger } = makeLogger();

    snapshotLiveSettings({ apply: true, appSettingsPath, repoRoot, logger });

    const fileMode = fs.statSync(snapshotPath(repoRoot)).mode & 0o777;
    expect(fileMode).toBe(0o644);
  });

  it('refuses overwrite without --force when content differs', () => {
    const repoRoot = makeRepoRoot();
    const appSettingsPath = writeAppSettings({
      claude: { model: 'claude-sonnet-4-6' },
    });
    const { logger } = makeLogger();

    snapshotLiveSettings({ apply: true, appSettingsPath, repoRoot, logger });
    const firstContents = fs.readFileSync(snapshotPath(repoRoot), 'utf8');

    fs.writeFileSync(
      appSettingsPath,
      JSON.stringify({ claude: { model: 'claude-opus-4-7' } }, null, 2),
      'utf8',
    );

    expect(() => snapshotLiveSettings({ apply: true, appSettingsPath, repoRoot, logger })).toThrow(
      /Refusing to overwrite .*--force/,
    );
    expect(fs.readFileSync(snapshotPath(repoRoot), 'utf8')).toBe(firstContents);

    snapshotLiveSettings({ apply: true, force: true, appSettingsPath, repoRoot, logger });
    const updatedConfig = loadHermeticEvalConfig(snapshotPath(repoRoot));
    expect(updatedConfig.bundle.working).toBe('claude-opus-4-7');
  });

  it('is idempotent when run twice with identical input', () => {
    const repoRoot = makeRepoRoot();
    const appSettingsPath = writeAppSettings({
      claude: { model: 'claude-sonnet-4-6' },
    });
    const { logger } = makeLogger();

    const firstRun = snapshotLiveSettings({ apply: true, appSettingsPath, repoRoot, logger });
    const firstBytes = fs.readFileSync(snapshotPath(repoRoot));
    const secondRun = snapshotLiveSettings({ apply: true, appSettingsPath, repoRoot, logger });
    const secondBytes = fs.readFileSync(snapshotPath(repoRoot));

    expect(firstRun.wroteFile).toBe(true);
    expect(secondRun.wroteFile).toBe(false);
    expect(secondBytes.equals(firstBytes)).toBe(true);
  });
});
