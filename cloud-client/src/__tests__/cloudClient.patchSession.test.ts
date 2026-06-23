import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloudClientError,
  SessionNeedsReconcileError,
  clearConfig,
  configure,
  patchSession,
} from '../cloudClient';

const TEST_URL = 'https://test.example.com';
const TEST_TOKEN = 'test-token';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200 });
}

describe('patchSession', () => {
  beforeEach(() => {
    clearConfig();
    configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearConfig();
  });

  it('PATCHes metadata and returns cloudUpdatedAt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: true, cloudUpdatedAt: 1234 })));

    await expect(patchSession('session-1', {
      baseSeq: 10,
      clientCloudUpdatedAt: 1111,
      patch: { title: 'Renamed' },
    })).resolves.toEqual({ cloudUpdatedAt: 1234 });
  });

  it('includes baseSeq, clientCloudUpdatedAt, and patch in the body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, cloudUpdatedAt: 1234 }));
    vi.stubGlobal('fetch', mockFetch);

    await patchSession('session-1', {
      baseSeq: 10,
      clientCloudUpdatedAt: 1111,
      patch: { doneAt: 2222, privateMode: true },
    });

    expect(mockFetch).toHaveBeenCalledWith(
      `${TEST_URL}/api/sessions/session-1`,
      expect.objectContaining({ method: 'PATCH' }),
    );
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      baseSeq: 10,
      clientCloudUpdatedAt: 1111,
      patch: { doneAt: 2222, privateMode: true },
    });
  });

  it('maps 409 NEEDS_RECONCILE to SessionNeedsReconcileError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: 'NEEDS_RECONCILE',
      serverSeq: 12,
      cloudUpdatedAt: 1234,
    }, { status: 409 })));

    await expect(patchSession('session-1', {
      baseSeq: 10,
      clientCloudUpdatedAt: 1111,
      patch: { title: 'Renamed' },
    })).rejects.toMatchObject({
      name: 'SessionNeedsReconcileError',
      details: { sessionId: 'session-1', serverSeq: 12, cloudUpdatedAt: 1234 },
    } satisfies Partial<SessionNeedsReconcileError>);
  });

  it('surfaces server rejection for non-allowlisted patch fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: { code: 'INVALID_BODY', message: 'patch must be an object containing only supported metadata keys' },
    }, { status: 400 })));

    await expect(patchSession('session-1', {
      baseSeq: 10,
      clientCloudUpdatedAt: 1111,
      patch: { lastError: 'nope' } as never,
    })).rejects.toMatchObject({
      name: 'CloudClientError',
      statusCode: 400,
      code: 'INVALID_BODY',
    } satisfies Partial<CloudClientError>);
  });
});
