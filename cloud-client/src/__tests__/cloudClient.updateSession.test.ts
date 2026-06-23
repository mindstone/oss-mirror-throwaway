import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionNeedsReconcileError,
  SessionTombstonedError,
  clearConfig,
  configure,
  updateSession,
} from '../cloudClient';

const TEST_URL = 'https://test.example.com';
const TEST_TOKEN = 'test-token';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

function healthResponse(capabilities: string[]): Response {
  return jsonResponse({
    status: 'ok',
    version: 'test',
    capabilities,
  });
}

function sessionBaseline(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'session-1',
    title: 'Original',
    maxSeq: 7,
    cloudUpdatedAt: 1_111,
    messages: [],
    ...overrides,
  };
}

function methodsOf(mockFetch: ReturnType<typeof vi.fn>): string[] {
  return mockFetch.mock.calls.map((call) => (call[1] as RequestInit).method ?? 'GET');
}

function bodyForMethod(mockFetch: ReturnType<typeof vi.fn>, method: string): Record<string, unknown> {
  const call = mockFetch.mock.calls.find((entry) => (entry[1] as RequestInit).method === method);
  expect(call).toBeDefined();
  return JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;
}

async function expectCapabilityPatch(
  patch: Record<string, unknown>,
  expectedPatch: Record<string, unknown>,
): Promise<void> {
  const mockFetch = vi.fn()
    .mockResolvedValueOnce(healthResponse(['session-metadata-patch']))
    .mockResolvedValueOnce(jsonResponse(sessionBaseline()))
    .mockResolvedValueOnce(jsonResponse({ success: true, cloudUpdatedAt: 2_222 }));
  vi.stubGlobal('fetch', mockFetch);

  await updateSession('session-1', patch);

  expect(methodsOf(mockFetch)).toEqual(['GET', 'GET', 'PATCH']);
  expect(methodsOf(mockFetch)).not.toContain('PUT');
  expect(bodyForMethod(mockFetch, 'PATCH')).toEqual({
    baseSeq: 7,
    clientCloudUpdatedAt: 1_111,
    patch: expectedPatch,
  });
}

describe('updateSession', () => {
  beforeEach(() => {
    clearConfig();
    configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearConfig();
  });

  it.each([
    ['title', { title: 'Renamed' }, { title: 'Renamed' }],
    ['doneAt', { doneAt: 1_700_000_000_000 }, { doneAt: 1_700_000_000_000 }],
    ['resolvedAt', { resolvedAt: 1_700_000_000_000 }, { resolvedAt: 1_700_000_000_000 }],
  ])('uses PATCH for %s patches when metadata capability is advertised', async (_field, patch, expectedPatch) => {
    await expectCapabilityPatch(patch, expectedPatch);
  });

  it('falls back to GET+PUT when metadata capability is absent', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(healthResponse([]))
      .mockResolvedValueOnce(jsonResponse(sessionBaseline({ id: 'session-1', title: 'Original' })))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', mockFetch);

    await updateSession('session-1', { title: 'Renamed' });

    expect(methodsOf(mockFetch)).toEqual(['GET', 'GET', 'PUT']);
    expect(bodyForMethod(mockFetch, 'PUT')).toMatchObject({
      id: 'session-1',
      title: 'Renamed',
      maxSeq: 7,
      cloudUpdatedAt: 1_111,
      messages: [],
    });
  });

  it.each([
    ['updatedAt', { title: 'Renamed', updatedAt: 9_999 }, { title: 'Renamed' }],
    ['lastError', { doneAt: 1_700_000_000_000, lastError: 'server owns this' }, { doneAt: 1_700_000_000_000 }],
  ])('drops %s from caller payloads before sending PATCH', async (_field, patch, expectedPatch) => {
    await expectCapabilityPatch(patch, expectedPatch);
  });

  it('falls back to GET+PUT when PATCH reports capability missing', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(healthResponse(['session-metadata-patch']))
      .mockResolvedValueOnce(jsonResponse(sessionBaseline()))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(sessionBaseline({ title: 'Original' })))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', mockFetch);

    await updateSession('session-1', { title: 'Renamed' });

    expect(methodsOf(mockFetch)).toEqual(['GET', 'GET', 'PATCH', 'GET', 'PUT']);
    expect(bodyForMethod(mockFetch, 'PUT')).toMatchObject({
      id: 'session-1',
      title: 'Renamed',
      maxSeq: 7,
      cloudUpdatedAt: 1_111,
      messages: [],
    });
  });

  it('propagates PATCH 409 NEEDS_RECONCILE without falling back to PUT', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(healthResponse(['session-metadata-patch']))
      .mockResolvedValueOnce(jsonResponse(sessionBaseline()))
      .mockResolvedValueOnce(jsonResponse({
        error: 'NEEDS_RECONCILE',
        serverSeq: 12,
        cloudUpdatedAt: 2_222,
      }, { status: 409 }));
    vi.stubGlobal('fetch', mockFetch);

    await expect(updateSession('session-1', { title: 'Renamed' }))
      .rejects.toMatchObject({
        name: 'SessionNeedsReconcileError',
        details: { sessionId: 'session-1', serverSeq: 12, cloudUpdatedAt: 2_222 },
      } satisfies Partial<SessionNeedsReconcileError>);
    expect(methodsOf(mockFetch)).toEqual(['GET', 'GET', 'PATCH']);
    expect(methodsOf(mockFetch)).not.toContain('PUT');
  });

  it('propagates PATCH 410 tombstoned without falling back to PUT', async () => {
    const tombstone = {
      sessionId: 'session-1',
      deletedAt: 1,
      deletedBy: 'mobile' as const,
      ttlExpiresAt: 2,
    };
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(healthResponse(['session-metadata-patch']))
      .mockResolvedValueOnce(jsonResponse(sessionBaseline()))
      .mockResolvedValueOnce(jsonResponse({
        error: 'session-tombstoned',
        tombstone,
      }, { status: 410 }));
    vi.stubGlobal('fetch', mockFetch);

    await expect(updateSession('session-1', { title: 'Renamed' }))
      .rejects.toMatchObject({
        name: 'SessionTombstonedError',
        tombstone,
      } satisfies Partial<SessionTombstonedError>);
    expect(methodsOf(mockFetch)).toEqual(['GET', 'GET', 'PATCH']);
    expect(methodsOf(mockFetch)).not.toContain('PUT');
  });
});
