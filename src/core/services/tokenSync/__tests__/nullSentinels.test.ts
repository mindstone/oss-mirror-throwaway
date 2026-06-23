import { beforeEach, describe, expect, it, vi } from 'vitest';

let getTokenSyncCoordinator: typeof import('@core/setTokenSyncCoordinator').getTokenSyncCoordinator;
let getTokenSyncTransport: typeof import('@core/setTokenSyncTransport').getTokenSyncTransport;
let getCrossProcessLease: typeof import('@core/setCrossProcessLease').getCrossProcessLease;
let getOAuthToolResolver: typeof import('@core/setOAuthToolResolver').getOAuthToolResolver;

describe('token sync boundary null sentinels', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ getTokenSyncCoordinator } = await import('@core/setTokenSyncCoordinator'));
    ({ getTokenSyncTransport } = await import('@core/setTokenSyncTransport'));
    ({ getCrossProcessLease } = await import('@core/setCrossProcessLease'));
    ({ getOAuthToolResolver } = await import('@core/setOAuthToolResolver'));
  });

  it('returns unwired from token sync coordinator ensureFreshish', async () => {
    const result = await getTokenSyncCoordinator().ensureFreshish({
      provider: 'google',
      accountKey: 'account',
      deadlineMs: Date.now() + 1000,
    });

    expect(result).toEqual({ ok: true, source: 'unwired' });
  });

  it('returns unwired from token sync transport pullMetadata and pullToken', async () => {
    const metadataResult = await getTokenSyncTransport().pullMetadata({
      provider: 'google',
      accountKey: 'account',
    });
    const tokenResult = await getTokenSyncTransport().pullToken({
      provider: 'google',
      relativePath: 'tokens.json',
    });

    expect(metadataResult).toEqual({ ok: false, error: 'unwired' });
    expect(tokenResult).toEqual({ ok: false, error: 'unwired' });
  });

  it('acquires an in-process lease and warns once across multiple calls', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const lease = getCrossProcessLease();
      const first = await lease.acquire('test', 1000);
      const second = await lease.acquire('test-second', 1000);

      expect(first).toMatchObject({ scope: 'test', ttlMs: 1000 });
      expect(typeof first?.acquiredAtMs).toBe('number');
      expect(second).toMatchObject({ scope: 'test-second', ttlMs: 1000 });
      expect(typeof second?.acquiredAtMs).toBe('number');
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns null from oauth tool resolver when unwired', () => {
    expect(getOAuthToolResolver().resolve('any-tool')).toBeNull();
  });
});
