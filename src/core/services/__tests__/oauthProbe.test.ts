import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { probeMcpUrlForOAuth } from '../oauthProbe';

type FetchMock = ReturnType<typeof vi.fn>;

const originalFetch = globalThis.fetch;

function mockFetch(impl: FetchMock): void {
  globalThis.fetch = impl as unknown as typeof fetch;
}

function makeResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe('probeMcpUrlForOAuth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('classifies 401 as oauth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(401));
    mockFetch(fetchMock);

    const result = await probeMcpUrlForOAuth('https://example.com/mcp');
    expect(result).toEqual({ classification: 'oauth', statusCode: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies 200 as open', async () => {
    mockFetch(vi.fn().mockResolvedValue(makeResponse(200)));

    const result = await probeMcpUrlForOAuth('https://example.com/mcp');
    expect(result).toEqual({ classification: 'open', statusCode: 200 });
  });

  it('classifies 202 as open', async () => {
    mockFetch(vi.fn().mockResolvedValue(makeResponse(202)));

    const result = await probeMcpUrlForOAuth('https://example.com/mcp');
    expect(result).toEqual({ classification: 'open', statusCode: 202 });
  });

  it('classifies 403 with OAuth WWW-Authenticate as oauth', async () => {
    mockFetch(vi.fn().mockResolvedValue(makeResponse(403, { 'www-authenticate': 'Bearer realm="mcp"' })));

    const result = await probeMcpUrlForOAuth('https://example.com/mcp');
    expect(result.classification).toBe('oauth');
    expect(result.statusCode).toBe(403);
  });

  it('classifies 403 without OAuth indicator as unknown', async () => {
    mockFetch(vi.fn().mockResolvedValue(makeResponse(403, { 'www-authenticate': 'Basic realm="x"' })));

    const result = await probeMcpUrlForOAuth('https://example.com/mcp');
    expect(result.classification).toBe('unknown');
    expect(result.statusCode).toBe(403);
  });

  it('classifies 500 as unknown (does not speculate)', async () => {
    mockFetch(vi.fn().mockResolvedValue(makeResponse(500)));

    const result = await probeMcpUrlForOAuth('https://example.com/mcp');
    expect(result.classification).toBe('unknown');
    expect(result.statusCode).toBe(500);
  });

  it('classifies network errors as unknown with error message', async () => {
    mockFetch(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await probeMcpUrlForOAuth('https://example.com/mcp');
    expect(result.classification).toBe('unknown');
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('skips non-HTTP URLs', async () => {
    const fetchMock = vi.fn();
    mockFetch(fetchMock);

    const result = await probeMcpUrlForOAuth('file:///tmp/fake');
    expect(result.classification).toBe('unknown');
    expect(result.error).toMatch(/Non-HTTP/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips empty URL', async () => {
    const fetchMock = vi.fn();
    mockFetch(fetchMock);

    const result = await probeMcpUrlForOAuth('');
    expect(result.classification).toBe('unknown');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts on timeout and returns unknown', async () => {
    // fetch that never resolves — rely on the internal AbortController firing.
    mockFetch(
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      }) as FetchMock
    );

    const promise = probeMcpUrlForOAuth('https://example.com/mcp', 50);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;
    expect(result.classification).toBe('unknown');
    expect(result.error).toBeDefined();
  });

  it('sends a JSON-RPC initialize payload with the correct shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(200));
    mockFetch(fetchMock);

    await probeMcpUrlForOAuth('https://example.com/mcp');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/mcp');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toMatch(/application\/json/);
    const body = JSON.parse(init.body as string);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('initialize');
    expect(body.params?.protocolVersion).toBeDefined();
    expect(body.params?.clientInfo?.name).toBe('rebel-oauth-probe');
  });
});
