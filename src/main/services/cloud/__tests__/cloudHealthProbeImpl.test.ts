import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopCloudHealthProbe } from '../cloudHealthProbeImpl';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe('desktopCloudHealthProbe', () => {
  it('returns healthy only when /api/health reports status ok', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: 'ok' }));
    globalThis.fetch = fetchMock;

    const result = await desktopCloudHealthProbe.probe({
      cloudUrl: 'https://cloud.test',
      timeoutMs: 10_000,
    });

    expect(fetchMock).toHaveBeenCalledWith('https://cloud.test/api/health', expect.any(Object));
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it('returns unhealthy with raw body when /api/health responds 2xx but status is not ok', async () => {
    const body = { status: 'degraded' };
    globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));

    await expect(
      desktopCloudHealthProbe.probe({
        cloudUrl: 'https://cloud.test',
        timeoutMs: 10_000,
      }),
    ).resolves.toEqual({ ok: false, status: 200, raw: body });
  });
});
