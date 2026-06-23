import { describe, expect, it, vi } from 'vitest';
import { postOssLeadCapture, type LeadCaptureLogger } from '../leadCapture';

type MockLog = {
  warn: ReturnType<typeof vi.fn<(obj: Record<string, unknown>, msg: string) => void>>;
  error: ReturnType<typeof vi.fn<(obj: Record<string, unknown>, msg: string) => void>>;
};

function makeLog(): MockLog {
  return { warn: vi.fn(), error: vi.fn() };
}

/** Adapt the typed mock to the logger interface the helper expects. */
const asLog = (m: MockLog): LeadCaptureLogger => m;

const BASE_INPUT = {
  firstName: 'Alex',
  email: 'alex@example.com',
  appVersion: '1.2.3',
  platform: 'darwin',
} as const;

describe('postOssLeadCapture', () => {
  it('POSTs to /api/oss/lead with the correct unauthenticated body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const log = makeLog();

    await postOssLeadCapture(BASE_INPUT, { apiUrl: 'https://api.test', log: asLog(log), fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.test/api/oss/lead');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    // No Authorization header — unauthenticated by design.
    expect(JSON.stringify(init.headers)).not.toContain('Authorization');
    expect(JSON.parse(init.body)).toEqual({
      firstName: 'Alex',
      email: 'alex@example.com',
      source: 'oss-onboarding',
      appVersion: '1.2.3',
      platform: 'darwin',
    });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('does not POST and does not throw when email is empty (name-only)', async () => {
    const fetchImpl = vi.fn();
    const log = makeLog();

    await expect(
      postOssLeadCapture({ ...BASE_INPUT, email: '' }, { apiUrl: 'https://api.test', log: asLog(log), fetchImpl }),
    ).resolves.toBeUndefined();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws on a network rejection and logs a structured warning without PII', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('network down'));
    const log = makeLog();

    await expect(
      postOssLeadCapture(BASE_INPUT, { apiUrl: 'https://api.test', log: asLog(log), fetchImpl }),
    ).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [obj] = log.warn.mock.calls[0];
    // No raw PII in logs.
    expect(JSON.stringify(obj)).not.toContain('alex@example.com');
    expect(JSON.stringify(obj)).not.toContain('Alex');
  });

  it('never throws on a non-2xx response and logs status (no PII)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    const log = makeLog();

    await postOssLeadCapture(BASE_INPUT, { apiUrl: 'https://api.test', log: asLog(log), fetchImpl });

    expect(log.warn).toHaveBeenCalledTimes(1);
    const [obj] = log.warn.mock.calls[0];
    expect(obj).toMatchObject({ status: 429 });
    expect(JSON.stringify(obj)).not.toContain('alex@example.com');
  });

  it('aborts via timeout and resolves to void when the request hangs', async () => {
    vi.useFakeTimers();
    const log = makeLog();
    // A fetch that rejects when its signal aborts (mimics real fetch abort).
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );

    const promise = postOssLeadCapture(BASE_INPUT, {
      apiUrl: 'https://api.test',
      log: asLog(log),
      fetchImpl,
      timeoutMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
