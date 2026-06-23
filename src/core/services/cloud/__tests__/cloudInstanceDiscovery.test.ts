import { describe, expect, it, vi, afterEach } from 'vitest';
import { discoverCloudInstances } from '../cloudInstanceDiscovery';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('discoverCloudInstances', () => {
  it('skips the managed status probe when includeManaged is false and still checks BYOK', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const result = await discoverCloudInstances({
      apiUrl: 'https://test.rebel.mindstone.com',
      accessToken: 'managed-token',
      includeManaged: false,
      cloudInstance: {
        mode: 'cloud',
        cloudUrl: 'https://byok-app.fly.dev',
        cloudToken: 'byok-token',
        providerId: 'fly',
        provisionMode: 'byok',
      },
    });

    expect(result).toMatchObject({
      managed: { exists: false },
      byok: {
        exists: true,
        healthy: true,
        cloudUrl: 'https://byok-app.fly.dev',
        providerId: 'fly',
        provisionMode: 'byok',
      },
      conflict: false,
      activeInSettings: 'byok',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://byok-app.fly.dev/api/health',
      expect.any(Object),
    );
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes('/api/cloud/managed/status'))).toBe(false);
  });

  it('reports a "could not check" error (not a clean exists:false) when there is no access token', async () => {
    // C-F1 edge: an unauthenticated managed probe must NOT read as authoritative
    // "confirmed gone" — consumers (the orphan-destroy billing-honesty banner)
    // gate on a CLEAN exists:false. A null token means we never queried the
    // backend, so it must carry an error so it's treated as "could not check".
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const result = await discoverCloudInstances({
      apiUrl: 'https://test.rebel.mindstone.com',
      accessToken: null,
      cloudInstance: { mode: 'local' },
    });

    expect(result.managed.exists).toBe(false);
    expect(result.managed.error).toBeTruthy();
    // The managed status endpoint must not have been probed (no token).
    expect(mockFetch.mock.calls.some(([url]) => String(url).includes('/api/cloud/managed/status'))).toBe(false);
  });

  it('keeps the managed status probe enabled by default for enterprise builds', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          exists: true,
          status: 'active',
          cloudUrl: 'https://managed.fly.dev',
          cloudToken: 'managed-cloud-token',
        }),
      })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const result = await discoverCloudInstances({
      apiUrl: 'https://test.rebel.mindstone.com',
      accessToken: 'managed-token',
      cloudInstance: {
        mode: 'cloud',
        cloudUrl: 'https://byok-app.fly.dev',
        cloudToken: 'byok-token',
        providerId: 'fly',
        provisionMode: 'byok',
      },
    });

    expect(result.managed).toMatchObject({
      exists: true,
      status: 'active',
      cloudUrl: 'https://managed.fly.dev',
      cloudToken: 'managed-cloud-token',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.rebel.mindstone.com/api/cloud/managed/status',
      expect.objectContaining({
        headers: { Authorization: 'Bearer managed-token' },
      }),
    );
  });
});
