import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockLoggerMethods, mockFetch } = vi.hoisted(() => ({
  mockLoggerMethods: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  mockFetch: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => mockLoggerMethods),
}));

vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Import under test (must come AFTER mocks)
// ---------------------------------------------------------------------------

import { diagnoseTimeout, isMachineOffline } from '../timeoutDiagnosticsService';
import type { TimeoutDiagnosticResult } from '../timeoutDiagnosticsService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_URL = 'https://status.anthropic.com/api/v2/status.json';
const API_URL = 'https://api.anthropic.com/';

// isMachineOffline corroboration hosts (must mirror OFFLINE_PROBE_HOSTS in
// timeoutDiagnosticsService.ts). The connectivity config below applies to ALL of
// these unless a per-host override is supplied.
const OPENROUTER_URL = 'https://openrouter.ai/';
const CLOUDFLARE_URL = 'https://cloudflare.com/';
const REACHABILITY_HOSTS = [API_URL, OPENROUTER_URL, CLOUDFLARE_URL];

/** Build a mock Anthropic status response body. */
function anthropicStatusBody(indicator: string, description: string) {
  return { status: { indicator, description } };
}

/**
 * Configure mockFetch to return different responses based on URL.
 * - `status` configures the Anthropic status endpoint (diagnoseTimeout only).
 * - `connectivity` configures the DEFAULT reachability outcome applied to every
 *   `isMachineOffline` corroboration host (and the diagnoseTimeout API probe).
 * - `perHost` overrides the connectivity outcome for specific hosts (F1 fix:
 *   one host reachable, others failing).
 */
function configureFetch(opts: {
  status?: {
    ok?: boolean;
    json?: unknown;
    throw?: Error;
  };
  connectivity?: {
    ok?: boolean;
    throw?: Error;
  };
  perHost?: Record<string, { ok?: boolean; throw?: Error }>;
}) {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    // Check abort before responding
    if (init?.signal?.aborted) {
      throw new DOMException('This operation was aborted', 'AbortError');
    }

    if (url === STATUS_URL) {
      if (opts.status?.throw) throw opts.status.throw;
      return {
        ok: opts.status?.ok ?? true,
        status: opts.status?.ok === false ? 500 : 200,
        json: async () => opts.status?.json ?? anthropicStatusBody('none', 'All Systems Operational'),
      };
    }

    if (REACHABILITY_HOSTS.includes(url)) {
      const hostCfg = opts.perHost?.[url] ?? opts.connectivity;
      if (hostCfg?.throw) throw hostCfg.throw;
      return {
        ok: hostCfg?.ok ?? true,
        status: hostCfg?.ok === false ? 500 : 200,
      };
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('diagnoseTimeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns transient_stall when both probes are healthy', async () => {
    configureFetch({
      status: { json: anthropicStatusBody('none', 'All Systems Operational') },
      connectivity: { ok: true },
    });

    const promise = diagnoseTimeout();
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toEqual<TimeoutDiagnosticResult>({ kind: 'transient_stall' });
    expect(mockLoggerMethods.info).toHaveBeenCalledWith(
      expect.stringContaining('transient_stall'),
    );
  });

  it('returns anthropic_issue with indicator and description when status is major', async () => {
    configureFetch({
      status: { json: anthropicStatusBody('major', 'Degraded Performance') },
      connectivity: { ok: true },
    });

    const promise = diagnoseTimeout();
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toEqual<TimeoutDiagnosticResult>({
      kind: 'anthropic_issue',
      indicator: 'major',
      description: 'Degraded Performance',
    });
  });

  it('returns anthropic_issue when status is minor', async () => {
    configureFetch({
      status: { json: anthropicStatusBody('minor', 'Minor Issue') },
      connectivity: { ok: true },
    });

    const promise = diagnoseTimeout();
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toEqual<TimeoutDiagnosticResult>({
      kind: 'anthropic_issue',
      indicator: 'minor',
      description: 'Minor Issue',
    });
  });

  it('returns internet_unreachable when connectivity probe fails', async () => {
    configureFetch({
      status: { json: anthropicStatusBody('none', 'All Systems Operational') },
      connectivity: { throw: new TypeError('fetch failed') },
    });

    const promise = diagnoseTimeout();
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toEqual<TimeoutDiagnosticResult>({ kind: 'internet_unreachable' });
    expect(mockLoggerMethods.warn).toHaveBeenCalledWith(
      expect.stringContaining('internet_unreachable'),
    );
  });

  it('returns internet_unreachable when both probes fail (total connectivity loss)', async () => {
    const networkError = new TypeError('fetch failed');
    configureFetch({
      status: { throw: networkError },
      connectivity: { throw: networkError },
    });

    const promise = diagnoseTimeout();
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    // If we can't reach anything, connectivity is the issue
    expect(result).toEqual<TimeoutDiagnosticResult>({ kind: 'internet_unreachable' });
  });

  it('returns transient_stall when anthropic probe times out but internet works', async () => {
    // Status endpoint hangs (never resolves within probe timeout),
    // connectivity works fine
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException('This operation was aborted', 'AbortError');
      }

      if (url === STATUS_URL) {
        // Simulate a hang — wait for abort signal
        return new Promise((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              reject(new DOMException('This operation was aborted', 'AbortError'));
            });
          }
        });
      }

      if (url === API_URL) {
        return { ok: true, status: 200 };
      }

      throw new Error(`Unexpected fetch URL in test: ${url}`);
    });

    const promise = diagnoseTimeout();
    // Advance past TOTAL_BUDGET_MS to trigger the abort
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await promise;

    // Status probe was aborted (rejected), connectivity was fine →
    // anthropicResult is rejected so anthropicIssue is null,
    // connectivityResult is fulfilled with true → transient_stall
    expect(result).toEqual<TimeoutDiagnosticResult>({ kind: 'transient_stall' });
  });

  it('returns transient_stall when anthropic response is malformed JSON', async () => {
    configureFetch({
      // Missing the expected `status.indicator` structure
      status: { json: { unexpected: 'format' } },
      connectivity: { ok: true },
    });

    const promise = diagnoseTimeout();
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toEqual<TimeoutDiagnosticResult>({ kind: 'transient_stall' });
    expect(mockLoggerMethods.warn).toHaveBeenCalledWith(
      expect.objectContaining({ body: { unexpected: 'format' } }),
      expect.stringContaining('Malformed'),
    );
  });

  it('cancels probes when external abort signal fires', async () => {
    const externalController = new AbortController();

    // Both endpoints hang until aborted
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException('This operation was aborted', 'AbortError');
      }
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('This operation was aborted', 'AbortError'));
          });
        }
      });
    });

    const promise = diagnoseTimeout(externalController.signal);

    // Fire external abort before the internal budget expires
    externalController.abort();
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;

    // Both probes rejected (aborted) — connectivity failed → internet_unreachable
    expect(result).toEqual<TimeoutDiagnosticResult>({ kind: 'internet_unreachable' });
  });

  it('prioritizes internet_unreachable over anthropic_issue when both fail', async () => {
    // Anthropic status reports an issue, but connectivity also fails
    // This means we can't actually trust the status result — connectivity is the primary concern
    configureFetch({
      status: { json: anthropicStatusBody('major', 'Major Outage') },
      connectivity: { throw: new TypeError('fetch failed') },
    });

    const promise = diagnoseTimeout();
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    // internet_unreachable takes priority
    expect(result).toEqual<TimeoutDiagnosticResult>({ kind: 'internet_unreachable' });
  });
});

// ---------------------------------------------------------------------------
// isMachineOffline — fail-fast-offline gate (Stage 2)
// ---------------------------------------------------------------------------

describe('isMachineOffline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true ONLY when EVERY corroboration host non-abort-fails (confirmed offline)', async () => {
    // All hosts fail to connect (genuine offline, e.g. a fully-offline user).
    configureFetch({ connectivity: { throw: new TypeError('fetch failed') } });

    const promise = isMachineOffline();
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe(true);
    // Corroboration probed all hosts.
    const probedUrls = mockFetch.mock.calls.map((c) => c[0]);
    expect(probedUrls).toEqual(expect.arrayContaining(REACHABILITY_HOSTS));
  });

  it('returns false (treat as online) when all HEAD probes succeed', async () => {
    configureFetch({ connectivity: { ok: true } });

    const promise = isMachineOffline();
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe(false);
  });

  it('F1 regression: api.anthropic.com fails but another host is reachable ⇒ NOT offline', async () => {
    // Managed/corporate network: Anthropic domain-blocked, but the actual
    // provider (OpenRouter) is reachable → a recoverable transient must still retry.
    configureFetch({
      connectivity: { throw: new TypeError('fetch failed') }, // anthropic + cloudflare fail
      perHost: { [OPENROUTER_URL]: { ok: true } }, // openrouter reachable
    });

    const promise = isMachineOffline();
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe(false);
  });

  it('a single reachable host (any) corroborates online — only ALL-down is offline', async () => {
    configureFetch({
      connectivity: { throw: new TypeError('fetch failed') },
      perHost: { [CLOUDFLARE_URL]: { ok: true } },
    });

    const promise = isMachineOffline();
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe(false);
  });

  it('NEVER hits the Anthropic status endpoint (reachability-only, provider-agnostic)', async () => {
    configureFetch({
      // An Anthropic incident must NOT mark a (non-Anthropic) turn offline.
      status: { json: anthropicStatusBody('major', 'Major Outage') },
      connectivity: { ok: true },
    });

    const promise = isMachineOffline();
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe(false);
    const probedUrls = mockFetch.mock.calls.map((c) => c[0]);
    expect(probedUrls).toContain(API_URL);
    expect(probedUrls).not.toContain(STATUS_URL);
  });

  it('fails OPEN (returns false) when the probes time out / hang', async () => {
    // Every host hangs until aborted by the internal budget timer → inconclusive.
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException('This operation was aborted', 'AbortError');
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    });

    const promise = isMachineOffline(undefined, 1_500);
    await vi.advanceTimersByTimeAsync(1_600);

    // Budget-timer abort yields per-host 'inconclusive' → fail-open (NOT offline).
    await expect(promise).resolves.toBe(false);
  });

  it('one unreachable + one inconclusive (timeout) ⇒ fail-open (inconclusive blocks offline)', async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException('This operation was aborted', 'AbortError');
      }
      if (url === API_URL) throw new TypeError('fetch failed'); // unreachable
      // Other hosts hang until the budget timer aborts → inconclusive.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    });

    const promise = isMachineOffline(undefined, 1_500);
    await vi.advanceTimersByTimeAsync(1_600);

    // Not every host non-abort-failed (some were inconclusive) → online.
    await expect(promise).resolves.toBe(false);
  });

  it('returns false (fail-open) when already aborted, without probing', async () => {
    const controller = new AbortController();
    controller.abort();
    configureFetch({ connectivity: { ok: true } });

    const promise = isMachineOffline(controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('honors an external abort signal that fires mid-probe (fail-open)', async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException('This operation was aborted', 'AbortError');
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    });

    const promise = isMachineOffline(controller.signal);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    // Aborted probe -> fetch rejects -> swallowed -> false (treat as online).
    await expect(promise).resolves.toBe(false);
  });
});
