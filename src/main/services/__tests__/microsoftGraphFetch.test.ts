import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => '/mock/user-data',
  isPackaged: () => false,
}));

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { fetchMicrosoftGraph } from '../microsoftGraphFetch';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _FIVE_MIN_MS = 5 * 60 * 1000;

function makeToken(overrides: Partial<{
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope: string;
}> = {}) {
  return JSON.stringify({
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_at: Date.now() + 60 * 60 * 1000, // 1 hour from now
    token_type: 'Bearer',
    scope: 'https://graph.microsoft.com/.default',
    ...overrides,
  });
}

function makeResponse(status: number, body = '{}'): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchMicrosoftGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('MICROSOFT_CLIENT_ID', 'mock-client-id');
    mockWriteFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // -------------------------------------------------------------------------
  // Successful fetch (no retry)
  // -------------------------------------------------------------------------
  it('returns response on successful fetch (no retry)', async () => {
    mockReadFile.mockResolvedValueOnce(makeToken());
    mockFetch.mockResolvedValueOnce(makeResponse(200, '{"value":[]}'));

    const response = await fetchMicrosoftGraph(
      'https://graph.microsoft.com/v1.0/me/calendarview',
      'user@example.com',
    );

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify Authorization header was set
    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-access-token');
  });

  // -------------------------------------------------------------------------
  // 401 → refresh → retry succeeds
  // -------------------------------------------------------------------------
  it('retries with refreshed token on 401', async () => {
    // Initial token read (valid, not near expiry)
    mockReadFile.mockResolvedValueOnce(makeToken());

    // First fetch returns 401
    mockFetch.mockResolvedValueOnce(makeResponse(401));

    // Disk re-read returns stale token (triggering refresh)
    mockReadFile.mockResolvedValueOnce(makeToken({ expires_at: Date.now() - 1000 }));

    // Refresh endpoint returns new token
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: 'refreshed-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      }), { status: 200 }),
    );

    // Retry fetch succeeds
    mockFetch.mockResolvedValueOnce(makeResponse(200, '{"value":[]}'));

    const response = await fetchMicrosoftGraph(
      'https://graph.microsoft.com/v1.0/me/calendarview',
      'user@example.com',
    );

    expect(response.status).toBe(200);
    // 3 fetch calls: initial request, refresh endpoint, retry request
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify retry used the refreshed token
    const retryArgs = mockFetch.mock.calls[2];
    const retryHeaders = retryArgs[1].headers as Headers;
    expect(retryHeaders.get('Authorization')).toBe('Bearer refreshed-token');

    // Verify token was written to disk
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 401 → disk re-read finds fresh token → retry succeeds (no refresh)
  // -------------------------------------------------------------------------
  it('uses fresh disk token on 401 without calling refresh endpoint', async () => {
    // Initial token read (valid)
    mockReadFile.mockResolvedValueOnce(makeToken());

    // First fetch returns 401
    mockFetch.mockResolvedValueOnce(makeResponse(401));

    // Disk re-read finds a fresh token (another process refreshed it)
    mockReadFile.mockResolvedValueOnce(
      makeToken({ access_token: 'fresh-from-other-process', expires_at: Date.now() + 60 * 60 * 1000 }),
    );

    // Retry fetch succeeds
    mockFetch.mockResolvedValueOnce(makeResponse(200, '{"value":[]}'));

    const response = await fetchMicrosoftGraph(
      'https://graph.microsoft.com/v1.0/me/calendarview',
      'user@example.com',
    );

    expect(response.status).toBe(200);
    // Only 2 fetch calls: initial request + retry (NO refresh endpoint call)
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify retry used the fresh disk token
    const retryArgs = mockFetch.mock.calls[1];
    const retryHeaders = retryArgs[1].headers as Headers;
    expect(retryHeaders.get('Authorization')).toBe('Bearer fresh-from-other-process');

    // No token written to disk (no refresh happened)
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 401 → disk re-read finds same token (still fresh) → force refresh anyway
  // -------------------------------------------------------------------------
  it('force-refreshes when disk token is fresh but same as the failed one', async () => {
    // Initial token read (valid, 1 hour from now)
    mockReadFile.mockResolvedValueOnce(makeToken());

    // First fetch returns 401 (server-side revocation)
    mockFetch.mockResolvedValueOnce(makeResponse(401));

    // Disk re-read finds the SAME token (no other process refreshed)
    mockReadFile.mockResolvedValueOnce(makeToken()); // same access_token: 'test-access-token'

    // Force refresh endpoint returns new token
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: 'force-refreshed-token',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }), { status: 200 }),
    );

    // Retry fetch succeeds
    mockFetch.mockResolvedValueOnce(makeResponse(200, '{"value":[]}'));

    const response = await fetchMicrosoftGraph(
      'https://graph.microsoft.com/v1.0/me/calendarview',
      'user@example.com',
    );

    expect(response.status).toBe(200);
    // 3 fetch calls: initial request, refresh endpoint, retry request
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify retry used the force-refreshed token
    const retryArgs = mockFetch.mock.calls[2];
    const retryHeaders = retryArgs[1].headers as Headers;
    expect(retryHeaders.get('Authorization')).toBe('Bearer force-refreshed-token');

    // Token was written to disk (refresh happened)
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 401 → refresh → retry still 401 (returns second response, no loop)
  // -------------------------------------------------------------------------
  it('returns second 401 without infinite loop', async () => {
    // Initial token read
    mockReadFile.mockResolvedValueOnce(makeToken());

    // First fetch returns 401
    mockFetch.mockResolvedValueOnce(makeResponse(401, '{"error":"first_401"}'));

    // Disk re-read returns stale token
    mockReadFile.mockResolvedValueOnce(makeToken({ expires_at: Date.now() - 1000 }));

    // Refresh endpoint succeeds
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: 'refreshed-token',
        expires_in: 3600,
      }), { status: 200 }),
    );

    // Retry also returns 401
    mockFetch.mockResolvedValueOnce(makeResponse(401, '{"error":"second_401"}'));

    const response = await fetchMicrosoftGraph(
      'https://graph.microsoft.com/v1.0/me/calendarview',
      'user@example.com',
    );

    // Returns the second 401 response (no infinite retry)
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('second_401');

    // 3 fetch calls total: initial, refresh, retry
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // 401 → refresh endpoint fails (propagates error)
  // -------------------------------------------------------------------------
  it('propagates refresh endpoint failure', async () => {
    // Initial token read
    mockReadFile.mockResolvedValueOnce(makeToken());

    // First fetch returns 401
    mockFetch.mockResolvedValueOnce(makeResponse(401));

    // Disk re-read returns stale token
    mockReadFile.mockResolvedValueOnce(makeToken({ expires_at: Date.now() - 1000 }));

    // Refresh endpoint fails
    mockFetch.mockResolvedValueOnce(
      new Response('invalid_grant', { status: 400 }),
    );

    await expect(
      fetchMicrosoftGraph(
        'https://graph.microsoft.com/v1.0/me/calendarview',
        'user@example.com',
      ),
    ).rejects.toThrow('Failed to refresh Microsoft token: invalid_grant');
  });

  // -------------------------------------------------------------------------
  // Non-401 error passes through unchanged
  // -------------------------------------------------------------------------
  it('passes through non-401 error responses without retry', async () => {
    mockReadFile.mockResolvedValueOnce(makeToken());
    mockFetch.mockResolvedValueOnce(makeResponse(403, '{"error":"forbidden"}'));

    const response = await fetchMicrosoftGraph(
      'https://graph.microsoft.com/v1.0/me/calendarview',
      'user@example.com',
    );

    expect(response.status).toBe(403);
    // Only 1 fetch call (no retry)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('passes through 500 error responses without retry', async () => {
    mockReadFile.mockResolvedValueOnce(makeToken());
    mockFetch.mockResolvedValueOnce(makeResponse(500, '{"error":"internal"}'));

    const response = await fetchMicrosoftGraph(
      'https://graph.microsoft.com/v1.0/me/calendarview',
      'user@example.com',
    );

    expect(response.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // No token file throws clear error
  // -------------------------------------------------------------------------
  it('throws clear error when no token file exists', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'));

    await expect(
      fetchMicrosoftGraph(
        'https://graph.microsoft.com/v1.0/me/calendarview',
        'user@example.com',
      ),
    ).rejects.toThrow('No Microsoft token found for user@example.com');
  });

  // -------------------------------------------------------------------------
  // fetch throws network error (propagates unchanged)
  // -------------------------------------------------------------------------
  it('propagates network errors from fetch unchanged', async () => {
    mockReadFile.mockResolvedValueOnce(makeToken());
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(
      fetchMicrosoftGraph(
        'https://graph.microsoft.com/v1.0/me/calendarview',
        'user@example.com',
      ),
    ).rejects.toThrow('fetch failed');
  });

  // -------------------------------------------------------------------------
  // Canonical email sanitization
  // -------------------------------------------------------------------------
  it('uses canonical email sanitization for token file path', async () => {
    mockReadFile.mockResolvedValueOnce(makeToken());
    mockFetch.mockResolvedValueOnce(makeResponse(200));

    await fetchMicrosoftGraph(
      'https://graph.microsoft.com/v1.0/me',
      'user+tag@example.com',
    );

    // Canonical: replace all non-alphanumeric chars with '-'
    // 'user+tag@example.com' → 'user-tag-example-com'
    const expectedPath = '/mock/user-data/microsoft-mcp/credentials/user-tag-example-com.token.json';
    expect(mockReadFile).toHaveBeenCalledWith(expectedPath, 'utf-8');
  });

  // -------------------------------------------------------------------------
  // Header merging
  // -------------------------------------------------------------------------
  it('merges caller headers with Authorization header', async () => {
    mockReadFile.mockResolvedValueOnce(makeToken());
    mockFetch.mockResolvedValueOnce(makeResponse(200));

    await fetchMicrosoftGraph(
      'https://graph.microsoft.com/v1.0/me',
      'user@example.com',
      { headers: { 'Content-Type': 'application/json', 'X-Custom': 'value' } },
    );

    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-access-token');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-Custom')).toBe('value');
  });

  it('handles Headers instance as input headers', async () => {
    mockReadFile.mockResolvedValueOnce(makeToken());
    mockFetch.mockResolvedValueOnce(makeResponse(200));

    const inputHeaders = new Headers({ 'Accept': 'application/json' });
    await fetchMicrosoftGraph(
      'https://graph.microsoft.com/v1.0/me',
      'user@example.com',
      { headers: inputHeaders },
    );

    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-access-token');
    expect(headers.get('Accept')).toBe('application/json');
  });

  // -------------------------------------------------------------------------
  // Pre-emptive refresh
  // -------------------------------------------------------------------------
  it('pre-emptively refreshes token near expiry before making request', async () => {
    // Token expiring in 2 minutes (within 5-minute buffer)
    mockReadFile.mockResolvedValueOnce(
      makeToken({ expires_at: Date.now() + 2 * 60 * 1000 }),
    );

    // Refresh endpoint
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: 'pre-emptively-refreshed',
        expires_in: 3600,
      }), { status: 200 }),
    );

    // Actual graph request
    mockFetch.mockResolvedValueOnce(makeResponse(200));

    const response = await fetchMicrosoftGraph(
      'https://graph.microsoft.com/v1.0/me',
      'user@example.com',
    );

    expect(response.status).toBe(200);

    // Verify the pre-emptively refreshed token was used
    const graphCallArgs = mockFetch.mock.calls[1];
    const headers = graphCallArgs[1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer pre-emptively-refreshed');
  });

  // -------------------------------------------------------------------------
  // RequestInit passthrough
  // -------------------------------------------------------------------------
  it('passes through RequestInit properties like method and body', async () => {
    mockReadFile.mockResolvedValueOnce(makeToken());
    mockFetch.mockResolvedValueOnce(makeResponse(200));

    await fetchMicrosoftGraph(
      'https://graph.microsoft.com/v1.0/me/sendMail',
      'user@example.com',
      {
        method: 'POST',
        body: JSON.stringify({ message: {} }),
        headers: { 'Content-Type': 'application/json' },
      },
    );

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].method).toBe('POST');
    expect(callArgs[1].body).toBe(JSON.stringify({ message: {} }));
  });
});
