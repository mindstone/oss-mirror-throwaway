import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreFactory } from '@core/storeFactory';
import {
  createSlackByokCredentialsStore,
  SlackByokCredentialsStorePermissionError,
  type SlackByokCredentials,
} from '../slackByokCredentialsStore';
import type { Logger } from '@core/logger';

describe('slackByokCredentialsStore', () => {
  let tempDir: string;
  let credentialsPath: string;
  let storeFactory: StoreFactory;
  let log: Logger;
  const originalPlatform = process.platform;

  const creds: SlackByokCredentials = {
    clientId: '123.456',
    clientSecret: 'client-secret',
    signingSecret: 'signing-secret',
    installedAt: '2026-05-03T00:00:00.000Z',
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-byok-'));
    credentialsPath = path.join(tempDir, 'cloud', 'slack-byok-credentials.json');
    storeFactory = ((opts) => ({
      path: path.join(tempDir, `${opts.name}.json`),
      get: () => undefined,
      set: () => undefined,
      has: () => false,
      delete: () => undefined,
      clear: () => undefined,
      store: {},
    })) as StoreFactory;
    log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  function writeCredentialsFile(mode = 0o600): void {
    fs.mkdirSync(path.dirname(credentialsPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(credentialsPath, `${JSON.stringify(creds, null, 2)}\n`, { encoding: 'utf8', mode });
    fs.chmodSync(credentialsPath, mode);
  }

  it('set and get round-trip BYOK credentials', async () => {
    const store = createSlackByokCredentialsStore({ storeFactory, log });
    await store.set(creds);
    await expect(store.get()).resolves.toEqual(creds);
  });

  it('read with permissive file mode fails closed', async () => {
    setPlatform('linux');
    writeCredentialsFile(0o644);
    const store = createSlackByokCredentialsStore({ storeFactory, log });

    await expect(store.get()).rejects.toBeInstanceOf(SlackByokCredentialsStorePermissionError);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ targetPath: credentialsPath, mode: '644', expectedMode: '600', kind: 'file' }),
      'Slack BYOK credentials store permissions are too broad; refusing to read secrets',
    );
  });

  it('set persists with 0600 permissions on POSIX', async () => {
    setPlatform('linux');
    const store = createSlackByokCredentialsStore({ storeFactory, log });
    await store.set(creds);
    expect(fs.statSync(credentialsPath).mode & 0o777).toBe(0o600);
  });

  it('creates the tmp file with 0600 permissions before rename on POSIX', async () => {
    setPlatform('linux');
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (oldPath, newPath) => {
      expect(String(oldPath)).toBe(`${credentialsPath}.tmp`);
      expect(fs.statSync(String(oldPath)).mode & 0o777).toBe(0o600);
      await fs.promises.copyFile(oldPath, newPath);
      await fs.promises.unlink(oldPath);
    });
    const store = createSlackByokCredentialsStore({ storeFactory, log });

    await store.set(creds);

    expect(renameSpy).toHaveBeenCalledWith(`${credentialsPath}.tmp`, credentialsPath);
    expect(fs.statSync(credentialsPath).mode & 0o777).toBe(0o600);
  });

  it('set fails cleanly instead of overwriting an existing permissive credentials file', async () => {
    setPlatform('linux');
    writeCredentialsFile(0o644);
    const store = createSlackByokCredentialsStore({ storeFactory, log });

    await expect(store.set({ ...creds, clientId: '999.888' })).rejects.toBeInstanceOf(SlackByokCredentialsStorePermissionError);

    const persisted = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as SlackByokCredentials;
    expect(persisted.clientId).toBe(creds.clientId);
  });

  it('clear removes the credentials file and tmp file', async () => {
    const store = createSlackByokCredentialsStore({ storeFactory, log });
    await store.set(creds);
    fs.writeFileSync(`${credentialsPath}.tmp`, JSON.stringify(creds), 'utf8');

    await store.clear();

    expect(fs.existsSync(credentialsPath)).toBe(false);
    expect(fs.existsSync(`${credentialsPath}.tmp`)).toBe(false);
  });

  it('concurrent get/set does not corrupt the persisted JSON', async () => {
    const store = createSlackByokCredentialsStore({ storeFactory, log });
    await Promise.all([
      store.set(creds),
      store.get().catch((err: unknown) => {
        if (err instanceof Error && err.message.includes('ENOENT')) return null;
        throw err;
      }),
    ]);

    const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as SlackByokCredentials;
    expect(parsed).toEqual(creds);
    await expect(store.get()).resolves.toEqual(creds);
  });
});
