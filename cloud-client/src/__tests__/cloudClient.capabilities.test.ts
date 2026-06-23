import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearConfig,
  configure,
  getServerCapabilities,
  getSession,
  getSessions,
  uploadAsset,
  computeCapabilityFingerprint,
} from '../cloudClient';

const TEST_URL = 'https://test.example.com';
const TEST_TOKEN = 'test-token';

function jsonResponse(body: unknown, capabilities?: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: capabilities === undefined ? undefined : { 'X-Rebel-Capabilities': capabilities },
  });
}

describe('cloudClient capabilities', () => {
  beforeEach(() => {
    clearConfig();
    configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearConfig();
  });

  it('replaces the cached capability list from each successful response', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse([], 'session-event-delta-push,session-metadata-patch'))
      .mockResolvedValueOnce(jsonResponse({ id: 's1' }, 'session-metadata-patch')));

    await getSessions();
    expect(await getServerCapabilities()).toEqual({
      supportsDeltaPush: true,
      supportsMetadataPatch: true,
      supportsContentRefs: false,
      supportsReconcileHandshake: false,
      supportsResourcePressure: false,
      raw: ['session-event-delta-push', 'session-metadata-patch'],
    });

    await getSession('s1');
    expect(await getServerCapabilities()).toEqual({
      supportsDeltaPush: false,
      supportsMetadataPatch: true,
      supportsContentRefs: false,
      supportsReconcileHandshake: false,
      supportsResourcePressure: false,
      raw: ['session-metadata-patch'],
    });
  });

  it('treats an empty capabilities header as empty caps', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([], '')));

    await getSessions();

    expect(await getServerCapabilities()).toEqual({
      supportsDeltaPush: false,
      supportsMetadataPatch: false,
      supportsContentRefs: false,
      supportsReconcileHandshake: false,
      supportsResourcePressure: false,
      raw: [],
    });
  });

  it('probes /api/health when no successful response has populated the cache', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'ok',
      version: 'test',
      capabilities: ['session-event-delta-push'],
    }), { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    await expect(getServerCapabilities()).resolves.toEqual({
      supportsDeltaPush: true,
      supportsMetadataPatch: false,
      supportsContentRefs: false,
      supportsReconcileHandshake: false,
      supportsResourcePressure: false,
      raw: ['session-event-delta-push'],
    });
    expect(mockFetch).toHaveBeenCalledWith(`${TEST_URL}/api/health`, expect.any(Object));
  });

  it('clears the cache when configure changes cloudUrl', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse([], 'session-event-delta-push'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'ok',
        version: 'test',
        capabilities: ['session-metadata-patch'],
      }), { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    await getSessions();
    configure({ cloudUrl: 'https://other.example.com', token: TEST_TOKEN });

    await expect(getServerCapabilities()).resolves.toEqual({
      supportsDeltaPush: false,
      supportsMetadataPatch: true,
      supportsContentRefs: false,
      supportsReconcileHandshake: false,
      supportsResourcePressure: false,
      raw: ['session-metadata-patch'],
    });
    expect(mockFetch.mock.calls[1][0]).toBe('https://other.example.com/api/health');
  });

  it('reflects rollback on the second consecutive response within one round trip', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse([], 'session-event-delta-push,session-metadata-patch'))
      .mockResolvedValueOnce(jsonResponse([], undefined)));

    await getSessions();
    await getSessions();

    expect(await getServerCapabilities()).toEqual({
      supportsDeltaPush: false,
      supportsMetadataPatch: false,
      supportsContentRefs: false,
      supportsReconcileHandshake: false,
      supportsResourcePressure: false,
      raw: [],
    });
  });

  it('sends the capability fingerprint header even before capabilities are cached', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }, ''));
    vi.stubGlobal('fetch', mockFetch);

    await getSessions();

    const [, init] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['X-Rebel-Capability-Fingerprint']).toBe(computeCapabilityFingerprint([]));
  });

  it('adds the capability fingerprint header to binary asset uploads', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('', {
      status: 200,
      headers: { 'X-Rebel-Capabilities': 'session-content-refs' },
    }));
    vi.stubGlobal('fetch', mockFetch);

    await uploadAsset('sess-1', 'asset-1', new Uint8Array([1, 2, 3]), 'image/png');

    const [, init] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['X-Rebel-Capability-Fingerprint']).toBe(computeCapabilityFingerprint([]));
  });
});
