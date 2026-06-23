import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloudClientError,
  clearConfig,
  configure,
  reconcileSession,
} from '../cloudClient';

const TEST_URL = 'https://test.example.com';
const TEST_TOKEN = 'test-token';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200 });
}

describe('reconcileSession', () => {
  beforeEach(() => {
    clearConfig();
    configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearConfig();
  });

  it('returns validated reconcile payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      serverSeq: 12,
      turnChecksums: [
        { turnId: 'turn-a', eventCount: 2, contentChecksum: 'abc' },
      ],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reconcileSession('session-1', 10)).resolves.toEqual({
      serverSeq: 12,
      turnChecksums: [{ turnId: 'turn-a', eventCount: 2, contentChecksum: 'abc' }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_URL}/api/sessions/session-1/reconcile?clientSeq=10`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('throws CloudClientError when response shape is invalid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      serverSeq: 'wrong',
      turnChecksums: [{ nope: true }],
    })));

    await expect(reconcileSession('session-1', 10)).rejects.toMatchObject({
      name: 'CloudClientError',
      message: 'reconcile-handshake-invalid-response',
      code: 'reconcile-handshake-invalid-response',
    } satisfies Partial<CloudClientError>);
  });
});
