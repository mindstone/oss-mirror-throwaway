import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@core/logger';
import { hashAccountSlug } from '@core/services/diagnostics/eventHashing';
import { NULL_TOKEN_SYNC_TRANSPORT, type TokenSyncTransport } from '@core/setTokenSyncTransport';
import type { CrossProcessLease } from '@core/setCrossProcessLease';
import { mintLeaseOwnerIdentity } from '@core/setCrossProcessLease';
import { TokenSyncCoordinator } from '../TokenSyncCoordinator';

const BASE_NOW = 1_700_000_000_000;

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function makeLease(overrides: Partial<CrossProcessLease> = {}): CrossProcessLease {
  return {
    acquire: vi.fn(async (scope: string, ttlMs: number) => ({
      scope,
      acquiredAtMs: BASE_NOW,
      ttlMs,
      owner: mintLeaseOwnerIdentity({ pid: 3030, epochMs: BASE_NOW, nonce: 'sync-lease' }),
    })),
    release: vi.fn(async () => undefined),
    whoHolds: vi.fn(async () => null),
    ...overrides,
  };
}

async function withTempRoot<T>(run: (rootPath: string) => Promise<T>): Promise<T> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'token-sync-coordinator-'));
  try {
    return await run(rootPath);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
}

async function writeTokenFile(rootPath: string, relativePath: string, expiryEpochMs: number): Promise<void> {
  const absolutePath = path.join(rootPath, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, JSON.stringify({
    access_token: 'token',
    expiry_date: expiryEpochMs,
    surfaceWrote: 'desktop',
  }, null, 2), 'utf8');
}

function makeTransport(overrides: Partial<TokenSyncTransport> = {}): TokenSyncTransport {
  return {
    publishSignal: vi.fn(async () => undefined),
    pullMetadata: vi.fn(async () => ({ ok: false, error: 'not_found' } as const)),
    pullToken: vi.fn(async () => ({ ok: false, error: 'not_found' } as const)),
    pushTombstone: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('TokenSyncCoordinator', () => {
  it('returns unwired when token sync transport is NULL', async () => {
    await withTempRoot(async (rootPath) => {
      const coordinator = new TokenSyncCoordinator({
        surface: 'desktop',
        transport: NULL_TOKEN_SYNC_TRANSPORT,
        lease: makeLease(),
        logger: makeLogger(),
        tokenRootResolver: () => rootPath,
        clock: () => BASE_NOW,
      });

      await expect(coordinator.ensureFreshish({
        provider: 'google',
        accountKey: 'GoogleWorkspace-alpha',
        deadlineMs: BASE_NOW + 3_000,
      })).resolves.toEqual({ ok: true, source: 'unwired' });
    });
  });

  it('returns local when peer metadata is missing', async () => {
    await withTempRoot(async (rootPath) => {
      await writeTokenFile(rootPath, 'GoogleWorkspace-alpha/credentials/alpha.token.json', BASE_NOW + 1_000);
      const transport = makeTransport({
        pullMetadata: vi.fn(async () => ({ ok: false, error: 'not_found' } as const)),
      });

      const coordinator = new TokenSyncCoordinator({
        surface: 'desktop',
        transport,
        lease: makeLease(),
        logger: makeLogger(),
        tokenRootResolver: () => rootPath,
        clock: () => BASE_NOW,
      });

      await expect(coordinator.ensureFreshish({
        provider: 'google',
        accountKey: 'GoogleWorkspace-alpha',
        deadlineMs: BASE_NOW + 3_000,
      })).resolves.toEqual({ ok: true, source: 'local' });
    });
  });

  it('syncs from peer when peer token is newer and logs account hash', async () => {
    await withTempRoot(async (rootPath) => {
      const accountKey = 'GoogleWorkspace-bravo';
      const relativePath = `${accountKey}/credentials/bravo.token.json`;
      await writeTokenFile(rootPath, relativePath, BASE_NOW + 1_000);

      const logger = makeLogger();
      const atomicWriter = vi.fn(async (filePath: string, data: string) => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, data, 'utf8');
      });
      const lease = makeLease();
      const transport = makeTransport({
        pullMetadata: vi.fn(async () => ({
          ok: true,
          metadata: {
            provider: 'google',
            accountKey,
            relativePath,
            expiryEpochMs: BASE_NOW + 10_000,
            mtimeMs: BASE_NOW + 500,
            surfaceWrote: 'cloud',
          },
        } as const)),
        pullToken: vi.fn(async () => ({
          ok: true,
          content: Buffer.from(JSON.stringify({
            access_token: 'peer-token',
            expiry_date: BASE_NOW + 10_000,
            surfaceWrote: 'cloud',
          })),
          mtimeMs: BASE_NOW + 500,
          expiryEpochMs: BASE_NOW + 10_000,
          surfaceWrote: 'cloud',
        } as const)),
      });

      const coordinator = new TokenSyncCoordinator({
        surface: 'desktop',
        transport,
        lease,
        logger,
        atomicWriter,
        tokenRootResolver: () => rootPath,
        clock: () => BASE_NOW,
      });

      await expect(coordinator.ensureFreshish({
        provider: 'google',
        accountKey,
        deadlineMs: BASE_NOW + 3_000,
      })).resolves.toEqual({ ok: true, source: 'peer' });

      expect(atomicWriter).toHaveBeenCalledTimes(1);
      expect((lease.acquire as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      expect((lease.release as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

      const infoPayload = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown>;
      expect(infoPayload.accountKeyHash).toBe(hashAccountSlug(accountKey));
      expect(JSON.stringify(infoPayload)).not.toContain(accountKey);
    });
  });

  it('single-flights concurrent pull attempts for the same provider/account', async () => {
    await withTempRoot(async (rootPath) => {
      const accountKey = 'GoogleWorkspace-charlie';
      const relativePath = `${accountKey}/credentials/charlie.token.json`;
      await writeTokenFile(rootPath, relativePath, BASE_NOW + 1_000);

      let releasePull: (() => void) | undefined;
      const pullGate = new Promise<void>((resolve) => {
        releasePull = () => resolve();
      });

      const transport = makeTransport({
        pullMetadata: vi.fn(async () => ({
          ok: true,
          metadata: {
            provider: 'google',
            accountKey,
            relativePath,
            expiryEpochMs: BASE_NOW + 20_000,
            mtimeMs: BASE_NOW + 1_000,
            surfaceWrote: 'cloud',
          },
        } as const)),
        pullToken: vi.fn(async () => {
          await pullGate;
          return {
            ok: true,
            content: Buffer.from(JSON.stringify({
              access_token: 'peer-token',
              expiry_date: BASE_NOW + 20_000,
              surfaceWrote: 'cloud',
            })),
            mtimeMs: BASE_NOW + 1_000,
            expiryEpochMs: BASE_NOW + 20_000,
            surfaceWrote: 'cloud',
          } as const;
        }),
      });

      const coordinator = new TokenSyncCoordinator({
        surface: 'desktop',
        transport,
        lease: makeLease(),
        logger: makeLogger(),
        atomicWriter: vi.fn(async () => undefined),
        tokenRootResolver: () => rootPath,
        clock: () => BASE_NOW,
      });

      const first = coordinator.ensureFreshish({
        provider: 'google',
        accountKey,
        deadlineMs: BASE_NOW + 3_000,
      });
      const second = coordinator.ensureFreshish({
        provider: 'google',
        accountKey,
        deadlineMs: BASE_NOW + 3_000,
      });

      await vi.waitFor(() => {
        expect(transport.pullMetadata).toHaveBeenCalledTimes(1);
        expect(transport.pullToken).toHaveBeenCalledTimes(1);
      });

      releasePull?.();
      await expect(first).resolves.toEqual({ ok: true, source: 'peer' });
      await expect(second).resolves.toEqual({ ok: true, source: 'peer' });
    });
  });

  it('releases lease on atomic-write failure', async () => {
    await withTempRoot(async (rootPath) => {
      const accountKey = 'GoogleWorkspace-delta';
      const relativePath = `${accountKey}/credentials/delta.token.json`;
      await writeTokenFile(rootPath, relativePath, BASE_NOW + 1_000);

      const order: string[] = [];
      const lease = makeLease({
        acquire: vi.fn(async (scope: string, ttlMs: number) => {
          order.push('acquire');
          return {
            scope,
            acquiredAtMs: BASE_NOW,
            ttlMs,
            owner: mintLeaseOwnerIdentity({ pid: 4040, epochMs: BASE_NOW, nonce: 'lease-nonce' }),
          };
        }),
        release: vi.fn(async () => {
          order.push('release');
        }),
      });
      const transport = makeTransport({
        pullMetadata: vi.fn(async () => ({
          ok: true,
          metadata: {
            provider: 'google',
            accountKey,
            relativePath,
            expiryEpochMs: BASE_NOW + 30_000,
            mtimeMs: BASE_NOW + 2_000,
            surfaceWrote: 'cloud',
          },
        } as const)),
        pullToken: vi.fn(async () => ({
          ok: true,
          content: Buffer.from(JSON.stringify({
            access_token: 'peer-token',
            expiry_date: BASE_NOW + 30_000,
            surfaceWrote: 'cloud',
          })),
          mtimeMs: BASE_NOW + 2_000,
          expiryEpochMs: BASE_NOW + 30_000,
          surfaceWrote: 'cloud',
        } as const)),
      });

      const coordinator = new TokenSyncCoordinator({
        surface: 'desktop',
        transport,
        lease,
        logger: makeLogger(),
        atomicWriter: vi.fn(async () => {
          order.push('write');
          throw new Error('disk full');
        }),
        tokenRootResolver: () => rootPath,
        clock: () => BASE_NOW,
      });

      const result = await coordinator.ensureFreshish({
        provider: 'google',
        accountKey,
        deadlineMs: BASE_NOW + 3_000,
      });

      expect(result.ok).toBe(false);
      expect(order).toEqual(['acquire', 'write', 'release']);
    });
  });

  it('debounces rapid local-write signals', async () => {
    vi.useFakeTimers();
    try {
      const transport = makeTransport();
      const coordinator = new TokenSyncCoordinator({
        surface: 'desktop',
        transport,
        lease: makeLease(),
        logger: makeLogger(),
        tokenRootResolver: () => '/tmp',
        clock: () => BASE_NOW,
      });

      await coordinator.onLocalWrite({
        provider: 'google',
        accountKey: 'GoogleWorkspace-echo',
        relativePath: 'GoogleWorkspace-echo/credentials/echo.token.json',
        expiryEpochMs: BASE_NOW + 1_000,
        mtimeMs: BASE_NOW,
      });
      await coordinator.onLocalWrite({
        provider: 'google',
        accountKey: 'GoogleWorkspace-echo',
        relativePath: 'GoogleWorkspace-echo/credentials/echo.token.json',
        expiryEpochMs: BASE_NOW + 2_000,
        mtimeMs: BASE_NOW + 100,
      });

      vi.advanceTimersByTime(500);
      expect(transport.publishSignal).toHaveBeenCalledTimes(1);
      expect(transport.publishSignal).toHaveBeenCalledWith({
        provider: 'google',
        accountKey: 'GoogleWorkspace-echo',
        expiryEpochMs: BASE_NOW + 2_000,
        mtimeMs: BASE_NOW + 100,
        surfaceWrote: 'desktop',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('onPeerSignal triggers ensureFreshish with a 3s budget', async () => {
    const transport = makeTransport();
    const coordinator = new TokenSyncCoordinator({
      surface: 'desktop',
      transport,
      lease: makeLease(),
      logger: makeLogger(),
      tokenRootResolver: () => '/tmp',
      clock: () => BASE_NOW,
    });
    const spy = vi.spyOn(coordinator, 'ensureFreshish').mockResolvedValue({ ok: true, source: 'local' });

    await coordinator.onPeerSignal({
      provider: 'google',
      accountKey: 'GoogleWorkspace-foxtrot',
      expiryEpochMs: BASE_NOW + 10_000,
      mtimeMs: BASE_NOW + 200,
      surfaceWrote: 'cloud',
    });

    expect(spy).toHaveBeenCalledWith({
      provider: 'google',
      accountKey: 'GoogleWorkspace-foxtrot',
      deadlineMs: BASE_NOW + 3_000,
    });
  });

  it('onPeerTombstone unlinks only when local file is older than tombstone', async () => {
    await withTempRoot(async (rootPath) => {
      const accountKey = 'GoogleWorkspace-golf';
      const relativePath = `${accountKey}/credentials/golf.token.json`;
      const absolutePath = path.join(rootPath, relativePath);
      await writeTokenFile(rootPath, relativePath, BASE_NOW + 1_000);

      const olderEpochMs = BASE_NOW - 10_000;
      const newerEpochMs = BASE_NOW + 10_000;
      await fs.utimes(absolutePath, olderEpochMs / 1000, olderEpochMs / 1000);

      const coordinator = new TokenSyncCoordinator({
        surface: 'desktop',
        transport: makeTransport(),
        lease: makeLease(),
        logger: makeLogger(),
        tokenRootResolver: () => rootPath,
        clock: () => BASE_NOW,
      });

      await coordinator.onPeerTombstone({
        provider: 'google',
        accountKey,
        relativePath,
        tombstoneEpochMs: BASE_NOW,
      });
      await expect(fs.stat(absolutePath)).rejects.toMatchObject({ code: 'ENOENT' });

      await writeTokenFile(rootPath, relativePath, BASE_NOW + 1_000);
      await fs.utimes(absolutePath, newerEpochMs / 1000, newerEpochMs / 1000);
      await coordinator.onPeerTombstone({
        provider: 'google',
        accountKey,
        relativePath,
        tombstoneEpochMs: BASE_NOW,
      });
      await expect(fs.stat(absolutePath)).resolves.toBeDefined();
    });
  });
});
