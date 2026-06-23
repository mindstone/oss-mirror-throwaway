import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  probeProviderReachability,
  getProviderReachabilitySnapshot,
  refreshProviderReachabilityCache,
  detectAllProvidersUnreachable,
} from '../providerReachabilitySnapshot';
import type { AppSettings } from '@shared/types';
import type {
  ProbeResult,
  ProviderId,
  ProviderReachabilitySnapshot,
} from '@shared/diagnostics/providerReachabilitySnapshot';

// Mock settingsStore
vi.mock('../../settingsStore', () => {
  let settingsCallback: ((settings: AppSettings) => void) | null = null;
  return {
    getSettings: vi.fn(() => ({ cloudInstance: { cloudUrl: 'https://test.rebel.mindstone.com' } })),
    onSettingsChange: vi.fn((cb) => {
      settingsCallback = cb;
      return () => { settingsCallback = null; };
    }),
    __triggerSettingsChange: (settings: AppSettings) => {
      if (settingsCallback) settingsCallback(settings);
    }
  };
});

import * as settingsStore from '../../settingsStore';

const triggerSettingsChange = (settingsStore as unknown as {
  __triggerSettingsChange: (settings: AppSettings) => void;
}).__triggerSettingsChange;

describe('providerReachabilitySnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Reset module-level cache
    triggerSettingsChange({} as AppSettings);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('probeProviderReachability', () => {
    it('returns reachable status on 200 OK', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      const result = await probeProviderReachability('anthropic');
      expect(result.status).toBe('reachable');
      expect(result.errorCode).toBeUndefined();
    });

    it('returns reachable status on 401 Unauthorized (expected for HEAD)', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
      const result = await probeProviderReachability('anthropic');
      expect(result.status).toBe('reachable');
    });

    it('returns unreachable status on 500 error', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      const result = await probeProviderReachability('anthropic');
      expect(result.status).toBe('unreachable');
      expect(result.errorCode).toBe('http_5xx');
    });

    it('returns unreachable on fetch error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
      const result = await probeProviderReachability('anthropic');
      expect(result.status).toBe('unreachable');
      expect(result.errorCode).toBe('dns');
    });
  });

  describe('getProviderReachabilitySnapshot', () => {
    it('reads the cache without probing providers', () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      const snap = getProviderReachabilitySnapshot();

      expect(snap.snapshotPresent).toBe(false);
      expect(snap.providers).toEqual({});
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns probe-populated cache entries without re-probing', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      await probeProviderReachability('anthropic');
      const snap1 = getProviderReachabilitySnapshot();
      expect(snap1.snapshotPresent).toBe(true);
      expect(snap1.providers?.anthropic?.status).toBe('reachable');
      
      // Fast forward 10 seconds (cache still valid)
      vi.advanceTimersByTime(10000);
      
      const snap2 = getProviderReachabilitySnapshot();
      expect(snap2.providers?.anthropic?.checkedAt).toBe(snap1.providers?.anthropic?.checkedAt);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('refreshProviderReachabilityCache refreshes stale entries only', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      await refreshProviderReachabilityCache(['anthropic']);
      await refreshProviderReachabilityCache(['anthropic']);
      expect(global.fetch).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(31_000);
      await refreshProviderReachabilityCache(['anthropic']);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
    
    it('invalidates cache on settings change', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      await refreshProviderReachabilityCache(['anthropic']);
      
      // Simulate settings change using our mock helper
      triggerSettingsChange({} as AppSettings);
      
      const snap = getProviderReachabilitySnapshot();
      expect(snap.snapshotPresent).toBe(false);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});

describe('detectAllProvidersUnreachable', () => {
  const mk = (
    status: ProbeResult['status'],
    opts: { stale?: boolean; errorCode?: ProbeResult['errorCode'] } = {},
  ): ProbeResult => ({
    status,
    ...(opts.errorCode ? { errorCode: opts.errorCode } : {}),
    checkedAt: 1_000,
    cachedAt: 1_000,
    expiresAt: 31_000,
    stale: opts.stale ?? false,
  });

  const snap = (
    providers: Partial<Record<ProviderId, ProbeResult>>,
    over: Partial<ProviderReachabilitySnapshot> = {},
  ): ProviderReachabilitySnapshot => ({
    snapshotPresent: Object.keys(providers).length > 0,
    lastRefreshAt: 1_000,
    providers,
    ...over,
  });

  it('all fresh providers unreachable → all_unreachable (with per-provider error codes)', () => {
    const r = detectAllProvidersUnreachable(
      snap({
        anthropic: mk('unreachable', { errorCode: 'timeout' }),
        openai: mk('unreachable', { errorCode: 'dns' }),
      }),
    );
    expect(r.verdict).toBe('all_unreachable');
    expect(r.unreachableProviders.sort()).toEqual(['anthropic', 'openai']);
    expect(r.errorCodes).toEqual({ anthropic: 'timeout', openai: 'dns' });
    expect(r.lastRefreshAt).toBe(1_000);
  });

  it('mixed fresh statuses → partially_unreachable', () => {
    const r = detectAllProvidersUnreachable(
      snap({ anthropic: mk('reachable'), openai: mk('unreachable', { errorCode: 'http_5xx' }) }),
    );
    expect(r.verdict).toBe('partially_unreachable');
    expect(r.unreachableProviders).toEqual(['openai']);
  });

  it('a fresh reachable provider and no unreachable → none_unreachable', () => {
    const r = detectAllProvidersUnreachable(snap({ anthropic: mk('reachable') }));
    expect(r.verdict).toBe('none_unreachable');
    expect(r.unreachableProviders).toEqual([]);
  });

  it('empty / absent snapshot → inconclusive (never a confident "all down")', () => {
    expect(detectAllProvidersUnreachable(snap({})).verdict).toBe('inconclusive');
    expect(
      detectAllProvidersUnreachable({ snapshotPresent: false, lastRefreshAt: null, providers: {} })
        .verdict,
    ).toBe('inconclusive');
  });

  it('F7: stale data is NOT counted as unreachable → inconclusive', () => {
    // All entries stale → no fresh evidence → must not read as "all down".
    const r = detectAllProvidersUnreachable(
      snap({
        anthropic: mk('unreachable', { stale: true, errorCode: 'timeout' }),
        openai: mk('unreachable', { stale: true }),
      }),
    );
    expect(r.verdict).toBe('inconclusive');
    expect(r.consideredProviders).toEqual([]);
  });

  it('F7: a fresh stale-unreachable is ignored; a fresh reachable wins → none_unreachable', () => {
    const r = detectAllProvidersUnreachable(
      snap({ anthropic: mk('reachable'), openai: mk('unreachable', { stale: true }) }),
    );
    expect(r.verdict).toBe('none_unreachable');
  });

  it("F7: 'unknown'-status probes are not evidence → inconclusive", () => {
    const r = detectAllProvidersUnreachable(snap({ anthropic: mk('unknown') }));
    expect(r.verdict).toBe('inconclusive');
    expect(r.consideredProviders).toEqual([]);
  });

  it('a single fresh-unreachable provider → all_unreachable (consideredProviders is the coverage guardrail)', () => {
    const r = detectAllProvidersUnreachable(snap({ anthropic: mk('unreachable', { errorCode: 'timeout' }) }));
    expect(r.verdict).toBe('all_unreachable');
    expect(r.consideredProviders).toEqual(['anthropic']);
    expect(r.unreachableProviders).toEqual(['anthropic']);
  });

  it('providers map undefined → inconclusive (no throw)', () => {
    const r = detectAllProvidersUnreachable({
      snapshotPresent: false,
      lastRefreshAt: null,
      providers: undefined,
    });
    expect(r.verdict).toBe('inconclusive');
    expect(r.consideredProviders).toEqual([]);
    expect(r.unreachableProviders).toEqual([]);
  });

  it('snapshotPresent:false short-circuits to inconclusive even with non-empty providers', () => {
    // A malformed/transitional snapshot (present flag false but rows linger) must
    // not be read as a confident verdict.
    const r = detectAllProvidersUnreachable(
      snap({ anthropic: mk('unreachable'), openai: mk('unreachable') }, { snapshotPresent: false }),
    );
    expect(r.verdict).toBe('inconclusive');
  });
});
