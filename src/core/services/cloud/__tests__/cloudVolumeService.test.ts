import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudVolumeConfig } from '../cloudVolumeService';
import { __resetFlyOperationLocksForTesting, acquireFlyOperationLock } from '../flyOperationLock';

const mockFlyExtendVolume = vi.fn();
const mockFlyFetch = vi.fn();
const mockGetFlyVolume = vi.fn();
const mockPollCloudHealth = vi.fn();

 
vi.mock('../../flyApiClient', () => ({
  flyExtendVolume: (...args: unknown[]) => mockFlyExtendVolume(...args),
  flyFetch: (...args: unknown[]) => mockFlyFetch(...args),
  getFlyVolume: (...args: unknown[]) => mockGetFlyVolume(...args),
}));

 
vi.mock('../../cloudUpdateService', () => ({
  pollCloudHealth: (...args: unknown[]) => mockPollCloudHealth(...args),
}));

import { getVolumeStatus, resizeVolume } from '../cloudVolumeService';

const FLY_TOKEN = 'fly-token';
const cloudInstance: CloudVolumeConfig = {
  mode: 'cloud',
  cloudUrl: 'https://byok.fly.dev',
  cloudToken: 'cloud-token',
  providerId: 'fly',
  provisionMode: 'byok',
  flyAppName: 'byok-app',
  flyMachineId: 'machine-1',
  flyVolumeId: 'volume-1',
  flyVolumeSizeGb: 10,
};

function storageResponse(totalGb = 10, usedGb = 4): Response {
  const totalBytes = totalGb * 1024 ** 3;
  const usedBytes = usedGb * 1024 ** 3;
  return new Response(JSON.stringify({
    totalBytes,
    usedBytes,
    availableBytes: totalBytes - usedBytes,
    dataPath: '/data',
    generatedAt: 123,
  }), { status: 200 });
}

describe('cloudVolumeService.getVolumeStatus', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetFlyOperationLocksForTesting();
    mockFlyExtendVolume.mockReset();
    mockFlyFetch.mockReset();
    mockGetFlyVolume.mockReset();
    mockPollCloudHealth.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(storageResponse()));
  });

  it('returns ok with cached Fly size and inside-VM usage without calling Fly on the poll hot path', async () => {
    const result = await getVolumeStatus({ cloudInstance, flyApiToken: FLY_TOKEN });

    expect(result).toMatchObject({
      kind: 'ok',
      sizeGb: 10,
      usedBytes: 4 * 1024 ** 3,
      availableBytes: 6 * 1024 ** 3,
    });
    expect(fetch).toHaveBeenCalledWith('https://byok.fly.dev/api/storage/usage', expect.objectContaining({
      headers: { Authorization: 'Bearer cloud-token' },
    }));
    expect(mockGetFlyVolume).not.toHaveBeenCalled();
  });

  it('fetches Fly size on successful poll only when the cache is missing', async () => {
    mockGetFlyVolume.mockResolvedValue({ success: true, volume: { id: 'volume-1', sizeGb: 12 } });

    const result = await getVolumeStatus({
      cloudInstance: { ...cloudInstance, flyVolumeSizeGb: undefined },
      flyApiToken: FLY_TOKEN,
    });

    expect(result).toMatchObject({ kind: 'ok', sizeGb: 12 });
    expect(mockGetFlyVolume).toHaveBeenCalledWith(FLY_TOKEN, 'byok-app', 'volume-1');
  });

  it('returns cloud_unreachable with Fly/cache size fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));
    mockGetFlyVolume.mockResolvedValue({ success: true, volume: { id: 'volume-1', sizeGb: 15 } });

    const result = await getVolumeStatus({ cloudInstance, flyApiToken: FLY_TOKEN });

    expect(result).toMatchObject({ kind: 'cloud_unreachable', sizeGb: 15 });
  });

  it('returns fly_token_missing without hitting the network', async () => {
    const result = await getVolumeStatus({ cloudInstance, flyApiToken: null });

    expect(result).toEqual({ kind: 'fly_token_missing' });
    expect(fetch).not.toHaveBeenCalled();
    expect(mockGetFlyVolume).not.toHaveBeenCalled();
  });

  it('returns not_applicable variants', async () => {
    await expect(getVolumeStatus({ cloudInstance: undefined, flyApiToken: FLY_TOKEN }))
      .resolves.toEqual({ kind: 'not_applicable', reason: 'not_connected' });
    await expect(getVolumeStatus({ cloudInstance: { ...cloudInstance, providerId: 'digitalocean' }, flyApiToken: FLY_TOKEN }))
      .resolves.toEqual({ kind: 'not_applicable', reason: 'non_fly' });
    await expect(getVolumeStatus({ cloudInstance: { ...cloudInstance, provisionMode: 'manual' }, flyApiToken: FLY_TOKEN }))
      .resolves.toEqual({ kind: 'not_applicable', reason: 'not_byok' });
  });

  it('returns ok for managed instances using cloud-service usage and derived size, without touching Fly', async () => {
    const managedInstance: CloudVolumeConfig = {
      mode: 'cloud',
      cloudUrl: 'https://managed.fly.dev',
      cloudToken: 'managed-cloud-token',
      providerId: 'mindstone',
      provisionMode: 'managed',
    };

    const result = await getVolumeStatus({ cloudInstance: managedInstance, flyApiToken: null });

    expect(result).toMatchObject({
      kind: 'ok',
      sizeGb: 10,
      usedBytes: 4 * 1024 ** 3,
      availableBytes: 6 * 1024 ** 3,
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://managed.fly.dev/api/storage/usage',
      expect.objectContaining({ headers: { Authorization: 'Bearer managed-cloud-token' } }),
    );
    expect(mockGetFlyVolume).not.toHaveBeenCalled();
  });

  it('returns cloud_unreachable for managed when the storage endpoint is unreachable, without Fly fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 503 })));
    const managedInstance: CloudVolumeConfig = {
      mode: 'cloud',
      cloudUrl: 'https://managed.fly.dev',
      cloudToken: 'managed-cloud-token',
      providerId: 'mindstone',
      provisionMode: 'managed',
    };

    const result = await getVolumeStatus({ cloudInstance: managedInstance, flyApiToken: null });

    expect(result).toMatchObject({ kind: 'cloud_unreachable', reason: 'network' });
    expect(mockGetFlyVolume).not.toHaveBeenCalled();
  });

  it('uses cached size when Fly fallback fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    mockGetFlyVolume.mockResolvedValue({ success: false, error: 'fly down' });

    const result = await getVolumeStatus({ cloudInstance, flyApiToken: FLY_TOKEN });

    expect(result).toMatchObject({ kind: 'cloud_unreachable', reason: 'network', sizeGb: 10 });
  });

  it('marks a 404 storage endpoint as endpoint_missing instead of a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing', { status: 404 })));
    mockGetFlyVolume.mockResolvedValue({ success: true, volume: { id: 'volume-1', sizeGb: 10 } });

    const result = await getVolumeStatus({ cloudInstance, flyApiToken: FLY_TOKEN });

    expect(result).toMatchObject({
      kind: 'cloud_unreachable',
      reason: 'endpoint_missing',
      sizeGb: 10,
      error: 'CLOUD_STORAGE_ENDPOINT_NOT_FOUND',
    });
  });
});

describe('cloudVolumeService.resizeVolume', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetFlyOperationLocksForTesting();
    mockFlyExtendVolume.mockReset();
    mockFlyFetch.mockReset();
    mockGetFlyVolume.mockReset();
    mockPollCloudHealth.mockReset();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(storageResponse(15, 4)));
    mockGetFlyVolume
      .mockResolvedValueOnce({ success: true, volume: { id: 'volume-1', sizeGb: 10 } })
      .mockResolvedValue({ success: true, volume: { id: 'volume-1', sizeGb: 15 } });
    mockFlyExtendVolume.mockResolvedValue({ success: true, volume: { id: 'volume-1', sizeGb: 15 } });
    mockFlyFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    mockPollCloudHealth.mockResolvedValue({ healthy: true });
  });

  it('extends, restarts, polls health, verifies size, and succeeds', async () => {
    const result = await resizeVolume({ cloudInstance, flyApiToken: FLY_TOKEN, targetSizeGb: 15 });

    expect(mockFlyExtendVolume).toHaveBeenCalledWith(FLY_TOKEN, 'byok-app', 'volume-1', 15);
    expect(mockFlyFetch).toHaveBeenCalledWith(
      FLY_TOKEN,
      '/v1/apps/byok-app/machines/machine-1/restart',
      { method: 'POST' },
    );
    expect(mockPollCloudHealth).toHaveBeenCalledWith('https://byok.fly.dev', 120000);
    expect(result).toMatchObject({
      success: true,
      applied: true,
      healthVerified: true,
      sizeVerified: true,
      sizeGbBefore: 10,
      sizeGbAfter: 15,
    });
  });

  it('reports partial failure when extend succeeds but health fails', async () => {
    mockPollCloudHealth.mockResolvedValue({ healthy: false, error: 'timeout' });

    const result = await resizeVolume({ cloudInstance, flyApiToken: FLY_TOKEN, targetSizeGb: 15 });

    expect(result).toMatchObject({
      success: false,
      applied: true,
      healthVerified: false,
      sizeVerified: false,
    });
    expect(result.error).toContain('timeout');
  });

  it('reports size mismatch when guest storage remains below target', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(storageResponse(10, 4)));

    const result = await resizeVolume({ cloudInstance, flyApiToken: FLY_TOKEN, targetSizeGb: 15 });

    expect(result).toMatchObject({
      success: false,
      applied: true,
      healthVerified: true,
      sizeVerified: false,
    });
    expect(result.error).toContain('guest still reports the old storage size');
  });

  it('rejects concurrent operations for the same machine', async () => {
    const lock = acquireFlyOperationLock({ flyAppName: 'byok-app', flyMachineId: 'machine-1', kind: 'tier-change' });

    const result = await resizeVolume({ cloudInstance, flyApiToken: FLY_TOKEN, targetSizeGb: 15 });

    expect(result).toMatchObject({ success: false, helpKey: 'in_flight_conflict' });
    expect(mockFlyExtendVolume).not.toHaveBeenCalled();
    lock?.release();
  });

  it('rejects active turns before Fly writes', async () => {
    const result = await resizeVolume({
      cloudInstance,
      flyApiToken: FLY_TOKEN,
      targetSizeGb: 15,
      getActiveTurnCount: () => 1,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('conversation is active');
    expect(mockFlyExtendVolume).not.toHaveBeenCalled();
  });
});
