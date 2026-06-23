import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetPath = vi.fn<(name: string) => string>();
const mockOpenExternal = vi.fn().mockResolvedValue(undefined);

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => mockGetPath(name),
  },
  shell: {
    openExternal: (url: string) => mockOpenExternal(url),
  },
}));

import {
  _testOnly,
  getStoredScopeTier,
  HubSpotAuthError,
  removeHubSpotAccount,
  type HubSpotAccount,
} from '../hubspotAuthService';
import { withAccountsAndEmailLock } from '../hubspotCredentialLock';
import { _testOnly as telemetryTestOnly } from '../hubspotTelemetry';

const TEST_TELEMETRY_SALT = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('hubspotAuthService Stage 0 hardening', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hubspot-auth-service-'));
    mockGetPath.mockReturnValue(tempDir);
    mockOpenExternal.mockClear();
    telemetryTestOnly.configureSaltForTests(TEST_TELEMETRY_SALT);
    delete process.env.HUBSPOT_SCOPE_TIER;
  });

  afterEach(async () => {
    delete process.env.HUBSPOT_SCOPE_TIER;
    vi.restoreAllMocks();
    telemetryTestOnly.configureSaltForTests(null);
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('backdates 0o644 accounts.json to 0o600 after saveAccounts', async () => {
    const accountsPath = _testOnly.getAccountsPath();
    await fsp.mkdir(path.dirname(accountsPath), { recursive: true });
    await fsp.writeFile(accountsPath, JSON.stringify({ accounts: [] }, null, 2), 'utf8');

    if (process.platform !== 'win32') {
      await fsp.chmod(accountsPath, 0o644);
    }

    await _testOnly.saveAccounts({
      accounts: [{ email: 'owner@example.com', hubId: 42, scopeTier: 'readonly' }],
    });

    if (process.platform !== 'win32') {
      const mode = (await fsp.stat(accountsPath)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('surfaces rename failures, preserves original file, and leaves no temp files', async () => {
    const accountsPath = _testOnly.getAccountsPath();
    await fsp.mkdir(path.dirname(accountsPath), { recursive: true });

    const originalBody = JSON.stringify({
      accounts: [{ email: 'before@example.com', hubId: 7 }],
    }, null, 2);
    await fsp.writeFile(accountsPath, originalBody, 'utf8');

    const renameSpy = vi.spyOn(fs, 'renameSync');
    const originalRename = fs.renameSync.bind(fs);
    renameSpy.mockImplementation((oldPath, newPath) => {
      if (String(newPath) === accountsPath) {
        const err = new Error('disk full') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      }
      return originalRename(oldPath, newPath);
    });

    await expect(
      _testOnly.saveAccounts({
        accounts: [{ email: 'after@example.com', hubId: 8 }],
      }),
    ).rejects.toMatchObject({ code: 'ENOSPC' });

    const persisted = await fsp.readFile(accountsPath, 'utf8');
    expect(persisted).toBe(originalBody);

    const leftovers = await fsp.readdir(path.dirname(accountsPath));
    expect(leftovers.filter((entry) => entry.includes('.tmp.'))).toEqual([]);
  });

  it('sweeps stale temp files on saveAccounts', async () => {
    const accountsPath = _testOnly.getAccountsPath();
    const configDir = path.dirname(accountsPath);
    await fsp.mkdir(configDir, { recursive: true });

    const staleTempPath = `${accountsPath}.tmp.${process.pid}.stale`;
    await fsp.writeFile(staleTempPath, 'stale-body', 'utf8');
    const oldDate = new Date(Date.now() - 10 * 60 * 1000);
    await fsp.utimes(staleTempPath, oldDate, oldDate);

    await _testOnly.saveAccounts({
      accounts: [{ email: 'stale-cleanup@example.com', hubId: 99 }],
    });

    await expect(fsp.access(staleTempPath)).rejects.toThrow();
  });

  it('migrates missing token schemaVersion to 1 and persists on next save', async () => {
    const email = 'schema@example.com';
    const tokenPath = _testOnly.getTokenPath(email);
    await fsp.mkdir(path.dirname(tokenPath), { recursive: true });

    const legacyToken = {
      access_token: 'legacy-access',
      refresh_token: 'legacy-refresh',
      expires_in: 3600,
      expires_at: Date.now() + 3600_000,
      token_type: 'bearer',
      user: email,
      hub_id: 123,
    };

    await fsp.writeFile(tokenPath, JSON.stringify(legacyToken, null, 2), 'utf8');

    const loaded = await _testOnly.loadToken(email);
    expect(loaded?.schemaVersion).toBe(1);

    expect(loaded).toBeTruthy();
    await _testOnly.saveToken(email, loaded!);

    const persisted = JSON.parse(await fsp.readFile(tokenPath, 'utf8')) as { schemaVersion?: number };
    expect(persisted.schemaVersion).toBe(1);
  });

  it('fails loud when token schemaVersion is newer than supported', async () => {
    const email = 'future-schema@example.com';
    const tokenPath = _testOnly.getTokenPath(email);
    await fsp.mkdir(path.dirname(tokenPath), { recursive: true });

    await fsp.writeFile(
      tokenPath,
      JSON.stringify(
        {
          schemaVersion: 99,
          access_token: 'future-access',
          refresh_token: 'future-refresh',
          expires_in: 3600,
          expires_at: Date.now() + 3600_000,
          token_type: 'bearer',
          user: email,
          hub_id: 123,
        },
        null,
        2,
      ),
      'utf8',
    );

    await expect(_testOnly.loadToken(email)).rejects.toThrow('Unsupported HubSpot token schema version: 99');
  });

  it('does not silently swallow loadAccounts EACCES failures', async () => {
    const err = new Error('permission denied') as NodeJS.ErrnoException;
    err.code = 'EACCES';
    const readSpy = vi.spyOn(fsp, 'readFile').mockRejectedValueOnce(err);

    await expect(_testOnly.loadAccounts()).rejects.toMatchObject({ code: 'EACCES' });

    readSpy.mockRestore();
  });

  it('does not silently swallow deleteToken EACCES failures', async () => {
    const err = new Error('permission denied') as NodeJS.ErrnoException;
    err.code = 'EACCES';
    const unlinkSpy = vi.spyOn(fsp, 'unlink').mockRejectedValueOnce(err);

    await expect(_testOnly.deleteToken('blocked@example.com')).rejects.toMatchObject({ code: 'EACCES' });

    unlinkSpy.mockRestore();
  });

  it('does not silently swallow loadToken EACCES failures', async () => {
    const err = new Error('permission denied') as NodeJS.ErrnoException;
    err.code = 'EACCES';
    const readSpy = vi.spyOn(fsp, 'readFile').mockRejectedValueOnce(err);

    await expect(_testOnly.loadToken('blocked@example.com')).rejects.toMatchObject({ code: 'EACCES' });

    readSpy.mockRestore();
  });

  it('does not silently swallow loadToken corrupt-JSON failures', async () => {
    const email = 'corrupt@example.com';
    await fsp.mkdir(path.dirname(_testOnly.getTokenPath(email)), { recursive: true });
    await fsp.writeFile(_testOnly.getTokenPath(email), '{ this is not json', 'utf8');

    await expect(_testOnly.loadToken(email)).rejects.toThrow();
  });

  it('returns env override scope tier when HUBSPOT_SCOPE_TIER is set', async () => {
    process.env.HUBSPOT_SCOPE_TIER = 'readonly';
    await _testOnly.saveAccounts({
      accounts: [{ email: 'env@example.com', hubId: 1, scopeTier: 'full' }],
    });

    await expect(getStoredScopeTier('env@example.com')).resolves.toBe('readonly');
  });

  it('returns first account scope tier when email is empty', async () => {
    const accounts: HubSpotAccount[] = [
      { email: 'first@example.com', hubId: 1, scopeTier: 'readonly' },
      { email: 'second@example.com', hubId: 2, scopeTier: 'full' },
    ];
    await _testOnly.saveAccounts({ accounts });

    await expect(getStoredScopeTier(undefined)).resolves.toBe('readonly');
  });

  it('returns matched account scope tier', async () => {
    const accounts: HubSpotAccount[] = [
      { email: 'first@example.com', hubId: 1, scopeTier: 'readonly' },
      { email: 'second@example.com', hubId: 2, scopeTier: 'full' },
    ];
    await _testOnly.saveAccounts({ accounts });

    await expect(getStoredScopeTier('second@example.com')).resolves.toBe('full');
  });

  it('throws HubSpotAuthError ACCOUNT_NOT_FOUND for unmatched email', async () => {
    await _testOnly.saveAccounts({
      accounts: [{ email: 'existing@example.com', hubId: 1, scopeTier: 'readonly' }],
    });

    await expect(getStoredScopeTier('missing@example.com')).rejects.toBeInstanceOf(HubSpotAuthError);
    await expect(getStoredScopeTier('missing@example.com')).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
    await expect(getStoredScopeTier('missing@example.com')).rejects.toMatchObject({
      email_hash: crypto
        .createHmac('sha256', Buffer.from(TEST_TELEMETRY_SALT, 'hex'))
        .update('missing@example.com')
        .digest('hex'),
    });
  });

  it('does not regress to plain SHA256 hashing in hubspotAuthService', async () => {
    const source = await fsp.readFile(
      path.join(process.cwd(), 'src', 'main', 'services', 'hubspotAuthService.ts'),
      'utf8',
    );
    expect(source).not.toContain("createHash('sha256')");
  });

  it('serializes concurrent saveToken calls behind the shared accounts→email lock', async () => {
    const email = 'race-token@example.com';
    let releaseFirst!: () => void;
    let signalAcquired!: () => void;
    let saveResolved = false;

    // Deterministic: `acquired` resolves the instant the lock callback runs (= lock held),
    // so the contender below is guaranteed to start AFTER the first holder owns the lock.
    // The prior `setTimeout(10)` only HOPED acquisition had happened — too short under CI
    // load, letting the contender acquire first and resolve, which red the shard (~1/run).
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const firstLock = withAccountsAndEmailLock(email, async () => {
      signalAcquired();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    await acquired;

    const save = _testOnly.saveToken(email, {
      schemaVersion: 1,
      access_token: 'second-access',
      refresh_token: 'second-refresh',
      expires_in: 3600,
      expires_at: Date.now() + 3600_000,
      token_type: 'bearer',
    }).then(() => {
      saveResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(saveResolved).toBe(false);
    releaseFirst();
    await firstLock;
    await save;
    expect(saveResolved).toBe(true);
  });

  it('serializes concurrent saveAccounts calls with token locks for every account', async () => {
    const email = 'race-accounts@example.com';
    let releaseFirst!: () => void;
    let signalAcquired!: () => void;
    let saveResolved = false;

    // Deterministic acquisition signal (see the saveToken race test above for the rationale):
    // wait for the lock to be genuinely held, not a hoped-for `setTimeout(10)` window.
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const firstLock = withAccountsAndEmailLock(email, async () => {
      signalAcquired();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    await acquired;

    const save = _testOnly.saveAccounts({
      accounts: [{ email, hubId: 123, scopeTier: 'readonly' }],
    }).then(() => {
      saveResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(saveResolved).toBe(false);
    releaseFirst();
    await firstLock;
    await save;
    expect(saveResolved).toBe(true);
  });

  it('serializes removeHubSpotAccount against a concurrent saveToken for the same email', async () => {
    const email = 'remove-race@example.com';
    await _testOnly.saveAccounts({ accounts: [{ email, hubId: 321, scopeTier: 'full' }] });
    let releaseFirst!: () => void;
    let removeResolved = false;

    const firstLock = withAccountsAndEmailLock(email, async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const remove = removeHubSpotAccount(email).then(() => {
      removeResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(removeResolved).toBe(false);
    releaseFirst();
    await firstLock;
    await remove;
    expect(removeResolved).toBe(true);
  });

  it('runs saveToken account mutation inside the same accounts→email lock cycle', async () => {
    const email = 'merged-lock@example.com';
    const lockGate = await (async () => {
      let lockPromise!: Promise<void>;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        lockPromise = withAccountsAndEmailLock(email, async () => {
          resolve();
          await new Promise<void>((innerResolve) => {
            release = innerResolve;
          });
        });
      });
      await entered;
      return { release, lockPromise };
    })();

    let mutationRan = false;
    const savePromise = _testOnly.saveToken(
      email,
      {
        schemaVersion: 1,
        access_token: 'merged-lock-access',
        refresh_token: 'merged-lock-refresh',
        expires_in: 3600,
        expires_at: Date.now() + 3600_000,
        token_type: 'bearer',
      },
      {
        mutateAccounts: async (config) => {
          mutationRan = true;
          config.accounts.push({ email, hubId: 444, scopeTier: 'readonly' });
          return config;
        },
      },
    );

    expect(mutationRan).toBe(false);
    lockGate.release();
    await lockGate.lockPromise;
    await savePromise;

    expect(mutationRan).toBe(true);
    const accounts = await _testOnly.loadAccounts();
    expect(accounts.accounts).toContainEqual({
      email,
      hubId: 444,
      scopeTier: 'readonly',
    });
    const token = await _testOnly.loadToken(email);
    expect(token?.access_token).toBe('merged-lock-access');
  });
});
