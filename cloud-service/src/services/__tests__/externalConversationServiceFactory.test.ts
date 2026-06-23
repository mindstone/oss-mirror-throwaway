import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KeyValueStore } from '@core/store';
import type { StoreFactoryOptions } from '@core/storeFactory';

describe('externalConversationServiceFactory', () => {
  const originalEnv = process.env;
  let tempDir: string;

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function setupPlatform(): Promise<void> {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-conversation-factory-'));
    const { setPlatformConfig } = await import('@core/platform');
    setPlatformConfig({
      userDataPath: tempDir,
      appPath: tempDir,
      tempPath: tempDir,
      logsPath: tempDir,
      homePath: tempDir,
      documentsPath: tempDir,
      desktopPath: tempDir,
      appDataPath: tempDir,
      version: 'test',
      isPackaged: false,
      platform: process.platform,
      totalMemoryBytes: 8 * 1024 * 1024 * 1024,
      arch: process.arch,
      surface: 'cloud',
      isOss: false,
    });
    const { setStoreFactory } = await import('@core/storeFactory');
    const { TestMemoryStore } = await import('@core/__tests__/TestMemoryStore');
    setStoreFactory(<T extends Record<string, unknown>>(opts: StoreFactoryOptions<T>) => {
      class PathBackedTestStore extends TestMemoryStore<T> {
        override get path(): string {
          return path.join(tempDir, `${opts.name}.json`);
        }
      }
      return new PathBackedTestStore(opts) as unknown as KeyValueStore<T>;
    });
  }

  it('constructs the Slack adapter when SLACK_SIGNING_SECRET is empty for BYOK-only deploys', async () => {
    vi.resetModules();
    process.env = { ...originalEnv, SLACK_SIGNING_SECRET: '' };
    await setupPlatform();
    const factory = await import('../externalConversationServiceFactory');

    expect(() => factory.initExternalConversationService()).not.toThrow();
    expect(factory.slackThreadAdapterInstance).not.toBeNull();
  });

  it('constructs the Slack adapter when managed env secret is present and BYOK store is empty', async () => {
    vi.resetModules();
    process.env = { ...originalEnv, SLACK_SIGNING_SECRET: 'managed-secret' };
    await setupPlatform();
    const factory = await import('../externalConversationServiceFactory');

    expect(() => factory.initExternalConversationService()).not.toThrow();
    expect(factory.slackThreadAdapterInstance).not.toBeNull();
  });
});
