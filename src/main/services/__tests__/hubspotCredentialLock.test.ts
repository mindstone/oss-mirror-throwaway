import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import properLockfile from 'proper-lockfile';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  withHubSpotCredentialLock,
  withAccountsAndEmailLock,
  withAccountsAndEmailLocks,
  RefreshLockFailedError,
  LockReleaseFailedError,
  _testOnly,
} from '../hubspotCredentialLock';

describe('hubspotCredentialLock', () => {
  let tempUserDataDir: string;

  beforeEach(async () => {
    tempUserDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hubspot-lock-'));
    _testOnly.configureUserDataDirForTests(tempUserDataDir);
    delete process.env.HUBSPOT_REFRESH_LOCK_STALE_MS;
  });

  afterEach(async () => {
    _testOnly.configureUserDataDirForTests(null);
    delete process.env.HUBSPOT_REFRESH_LOCK_STALE_MS;
    await fs.rm(tempUserDataDir, { recursive: true, force: true });
  });

  it('acquires and releases a credential lock', async () => {
    const lockPath = path.join(tempUserDataDir, 'mcp', 'hubspot', 'accounts.json');
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    const value = await withHubSpotCredentialLock(lockPath, async (assertLockHealthy) => {
      assertLockHealthy();
      return 'ok';
    });

    expect(value).toBe('ok');
  });

  it('fails loud when lock directory disappears during the critical section', async () => {
    const lockPath = path.join(tempUserDataDir, 'mcp', 'hubspot', 'accounts.json');
    await fs.mkdir(path.dirname(lockPath), { recursive: true });

    await expect(
      withHubSpotCredentialLock(lockPath, async (assertLockHealthy) => {
        const lockDirPath = `${lockPath}.lock`;
        await fs.rm(lockDirPath, { recursive: true, force: true });
        assertLockHealthy();
      }),
    ).rejects.toBeInstanceOf(RefreshLockFailedError);
  });

  it('locks accounts then token file for withAccountsAndEmailLock', async () => {
    const email = 'sales@example.com';
    const accountsPath = _testOnly.getAccountsPath();
    const tokenPath = _testOnly.getTokenPath(email);

    await withAccountsAndEmailLock(email, async () => {
      expect(await fs.stat(`${accountsPath}.lock`)).toBeDefined();
      expect(await fs.stat(`${tokenPath}.lock`)).toBeDefined();
    });
  });

  it('locks accounts then token files in deterministic order for multi-account writes', async () => {
    const firstTokenPath = _testOnly.getTokenPath('a@example.com');
    const secondTokenPath = _testOnly.getTokenPath('b@example.com');
    const accountsPath = _testOnly.getAccountsPath();

    await withAccountsAndEmailLocks(['b@example.com', 'a@example.com'], async () => {
      expect(await fs.stat(`${accountsPath}.lock`)).toBeDefined();
      expect(await fs.stat(`${firstTokenPath}.lock`)).toBeDefined();
      expect(await fs.stat(`${secondTokenPath}.lock`)).toBeDefined();
    });
  });

  it('acquires accounts then token locks and releases in reverse order', async () => {
    const lockOrder: string[] = [];
    const releaseOrder: string[] = [];
    const lockSpy = vi.spyOn(properLockfile, 'lock').mockImplementation(async (targetPath) => {
      const stringPath = String(targetPath);
      lockOrder.push(path.basename(stringPath));
      await fs.mkdir(`${stringPath}.lock`, { recursive: true });
      return async () => {
        releaseOrder.push(path.basename(stringPath));
        await fs.rm(`${stringPath}.lock`, { recursive: true, force: true });
      };
    });

    try {
      await withAccountsAndEmailLocks(['b@example.com', 'a@example.com'], async () => undefined);
    } finally {
      lockSpy.mockRestore();
    }

    expect(lockOrder).toEqual([
      'accounts.json',
      'a-example-com.token.json',
      'b-example-com.token.json',
    ]);
    expect(releaseOrder).toEqual([
      'b-example-com.token.json',
      'a-example-com.token.json',
      'accounts.json',
    ]);
  });

  it('locks only accounts file when email is not provided', async () => {
    const accountsPath = _testOnly.getAccountsPath();
    const tokenPath = _testOnly.getTokenPath('unused@example.com');

    await withAccountsAndEmailLock(undefined, async () => {
      expect(await fs.stat(`${accountsPath}.lock`)).toBeDefined();
      await expect(fs.stat(`${tokenPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('resolves stale lock timeout from env with safe fallback', () => {
    process.env.HUBSPOT_REFRESH_LOCK_STALE_MS = '120000';
    expect(_testOnly.resolveStaleMs()).toBe(120000);

    process.env.HUBSPOT_REFRESH_LOCK_STALE_MS = 'not-a-number';
    expect(_testOnly.resolveStaleMs()).toBe(90000);

    process.env.HUBSPOT_REFRESH_LOCK_STALE_MS = '-10';
    expect(_testOnly.resolveStaleMs()).toBe(90000);
  });

  it('surfaces lock-release failures as LockReleaseFailedError', async () => {
    const lockPath = path.join(tempUserDataDir, 'mcp', 'hubspot', 'accounts.json');
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const lockSpy = vi.spyOn(properLockfile, 'lock').mockImplementationOnce(async (targetPath) => {
      await fs.mkdir(`${targetPath}.lock`, { recursive: true });
      return async () => {
        await fs.rm(`${targetPath}.lock`, { recursive: true, force: true });
        throw new Error('release failed');
      };
    });

    await expect(withHubSpotCredentialLock(lockPath, async () => 'ok'))
      .rejects.toBeInstanceOf(LockReleaseFailedError);

    lockSpy.mockRestore();
  });

  it('enforces mutual exclusion across two concurrent callers using identical lock paths', async () => {
    const lockPath = path.join(tempUserDataDir, 'mcp', 'hubspot', 'accounts.json');
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    let releaseFirst!: () => void;
    let first: Promise<void>;
    const firstEntered = new Promise<void>((resolve) => {
      first = withHubSpotCredentialLock(lockPath, async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseFirst = release;
        });
      });
    });
    await firstEntered;

    await expect(
      withHubSpotCredentialLock(
        lockPath,
        async () => 'second',
        { retries: 0, realpath: false },
      ),
    ).rejects.toBeInstanceOf(RefreshLockFailedError);

    releaseFirst();
    await expect(first!).resolves.toBeUndefined();
    await expect(
      withHubSpotCredentialLock(
        lockPath,
        async () => 'second',
        { retries: 0, realpath: false },
      ),
    ).resolves.toBe('second');
  });

  it('enforces cross-process mutual exclusion with identical accounts lock path', async () => {
    const email = 'cross-process@example.com';
    const childScriptPath = path.join(tempUserDataDir, 'hubspot-lock-child.ts');
    const lockModulePath = path.join(process.cwd(), 'src/main/services/hubspotCredentialLock.ts');

    await fs.writeFile(
      childScriptPath,
      `
import { withAccountsAndEmailLocks, _testOnly } from ${JSON.stringify(lockModulePath)};

async function main(): Promise<void> {
  const userDataDir = process.env.HUBSPOT_LOCK_TEST_USER_DATA_DIR;
  const email = process.env.HUBSPOT_LOCK_TEST_EMAIL;

  if (!userDataDir || !email) {
    throw new Error('Missing lock test env');
  }

  _testOnly.configureUserDataDirForTests(userDataDir);
  let release: (() => void) | null = null;

  process.on('message', (message) => {
    if (message === 'release' && release) {
      const releaseFn = release;
      release = null;
      releaseFn();
    }
  });

  await withAccountsAndEmailLocks([email], async () => {
    process.send?.({ type: 'lock-acquired' });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });

  process.send?.({ type: 'released' });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`,
      'utf8',
    );

    const child = fork(childScriptPath, [], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HUBSPOT_LOCK_TEST_USER_DATA_DIR: tempUserDataDir,
        HUBSPOT_LOCK_TEST_EMAIL: email,
      },
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    const awaitChildMessage = (expectedType: string): Promise<void> => new Promise((resolve, reject) => {
      let cleanup: () => void = () => {};
      const onMessage = (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          (message as { type?: string }).type === expectedType
        ) {
          cleanup();
          resolve();
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`Lock child exited before "${expectedType}" (code=${code ?? 'null'} signal=${signal ?? 'null'})`));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      cleanup = () => {
        child.off('message', onMessage);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      child.on('message', onMessage);
      child.on('exit', onExit);
      child.on('error', onError);
    });

    try {
      await awaitChildMessage('lock-acquired');

      await expect(
        withHubSpotCredentialLock(
          _testOnly.getAccountsPath(),
          async () => 'parent-acquired',
          { retries: 0, realpath: false },
        ),
      ).rejects.toBeInstanceOf(RefreshLockFailedError);

      child.send('release');
      await awaitChildMessage('released');

      await expect(
        withHubSpotCredentialLock(
          _testOnly.getAccountsPath(),
          async () => 'parent-acquired',
          { retries: 0, realpath: false },
        ),
      ).resolves.toBe('parent-acquired');
    } finally {
      child.kill();
    }
  });
});
