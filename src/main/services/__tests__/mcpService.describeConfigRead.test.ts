import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import { buildSettings } from '@core/__tests__/builders';
import { categorizeSafeModeError } from '@shared/safeModeErrorClassifier';
import type { AppSettings } from '@shared/types';

const makeErrnoError = (code: string): NodeJS.ErrnoException => {
  const error = new Error(`${code}: too many open files, open '/private/user/super-mcp-router.json'`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

describe('describeMcpConfiguration config read EMFILE handling', () => {
  let tempDir: string;
  let describeMcpConfiguration: typeof import('../mcpService').describeMcpConfiguration;
  let readFileSpy: ReturnType<typeof vi.spyOn> | undefined;
  let realReadFile: typeof fs.readFile;

  const configPath = (): string => path.join(tempDir, 'super-mcp-router.json');
  const settingsFor = (filePath: string): AppSettings => buildSettings({
    mcpConfigFile: filePath,
    diagnostics: {
      ...buildSettings().diagnostics,
      forceDirectMcp: true,
    },
  });

  const writeConfig = async (config: unknown): Promise<void> => {
    await fs.writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  };

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-describe-config-'));
    await initTestPlatformConfig({ userDataPath: tempDir });

    vi.doMock('@core/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      createScopedLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    }));

    vi.doMock('../superMcpHttpManager', () => ({
      superMcpHttpManager: {
        getState: vi.fn(() => ({ isRunning: false, url: null, port: null })),
        getHttpConfig: vi.fn(() => null),
        isConfigured: vi.fn(() => false),
        startWithRetries: vi.fn(),
      },
      CircuitBreakerError: class CircuitBreakerError extends Error {},
      findAvailablePort: vi.fn(),
    }));

    const mod = await import('../mcpService');
    describeMcpConfiguration = mod.describeMcpConfiguration;
    realReadFile = fs.readFile.bind(fs);
  });

  afterEach(async () => {
    readFileSpy?.mockRestore();
    vi.restoreAllMocks();
    vi.resetModules();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('retries transient EMFILE and returns the real config without recreating defaults', async () => {
    const originalConfig = {
      mcpServers: {
        LocalTool: {
          command: 'node',
          args: ['server.js'],
        },
      },
    };
    await writeConfig(originalConfig);
    const before = await fs.readFile(configPath(), 'utf8');
    let calls = 0;
    readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      calls += 1;
      if (calls <= 2) {
        throw makeErrnoError('EMFILE');
      }
      return realReadFile(...args);
    });

    const summary = await describeMcpConfiguration(settingsFor(configPath()), true);

    expect(summary.status).toBe('ready');
    expect(summary.mode).toBe('direct');
    expect(summary.upstreamCount).toBe(1);
    expect(summary.editableServers?.map((server) => server.name)).toContain('LocalTool');
    expect(readFileSpy).toHaveBeenCalledTimes(4);
    await expect(fs.readFile(configPath(), 'utf8')).resolves.toBe(before);
    await expect(fs.readdir(tempDir)).resolves.not.toContainEqual(expect.stringContaining('.corrupt-'));
  });

  it('returns a fs-exhaustion error for persistent EMFILE without recreating or touching the config', async () => {
    const originalConfig = {
      mcpServers: {
        HealthyUserConfig: {
          command: 'node',
          args: ['healthy.js'],
        },
      },
    };
    await writeConfig(originalConfig);
    const before = await fs.readFile(configPath(), 'utf8');
    readFileSpy = vi.spyOn(fs, 'readFile').mockRejectedValue(makeErrnoError('EMFILE'));

    const summary = await describeMcpConfiguration(settingsFor(configPath()), true);

    expect(summary.status).toBe('error');
    expect(summary.error).toBe('too many open files — close other apps or restart your machine');
    expect(categorizeSafeModeError(summary.error)).toBe('fs_exhaustion');
    expect(readFileSpy).toHaveBeenCalledTimes(3);

    readFileSpy.mockRestore();
    await expect(fs.readFile(configPath(), 'utf8')).resolves.toBe(before);
    await expect(fs.readdir(tempDir)).resolves.not.toContainEqual(expect.stringContaining('.corrupt-'));
  });

  it('backs up and recreates defaults when the config read succeeds but JSON is corrupt', async () => {
    await fs.writeFile(configPath(), '{not json', 'utf8');
    const corruptContent = await fs.readFile(configPath(), 'utf8');
    readFileSpy = vi.spyOn(fs, 'readFile');

    const summary = await describeMcpConfiguration(settingsFor(configPath()), true);

    expect(summary.status).toBe('ready');
    expect(summary.mode).toBe('none');
    await expect(fs.readFile(configPath(), 'utf8')).resolves.toContain('"mcpServers": {}');
    const entries = await fs.readdir(tempDir);
    const backupName = entries.find((entry) => entry.startsWith('super-mcp-router.json.corrupt-'));
    expect(backupName).toBeDefined();
    await expect(fs.readFile(path.join(tempDir, backupName!), 'utf8')).resolves.toBe(corruptContent);
  });

  it('preserves the existing ENOENT behavior by recreating defaults for a missing config', async () => {
    readFileSpy = vi.spyOn(fs, 'readFile');

    const summary = await describeMcpConfiguration(settingsFor(configPath()), true);

    expect(summary.status).toBe('ready');
    expect(summary.mode).toBe('none');
    await expect(fs.readFile(configPath(), 'utf8')).resolves.toContain('"mcpServers": {}');
    await expect(fs.readdir(tempDir)).resolves.not.toContainEqual(expect.stringContaining('.corrupt-'));
  });
});
