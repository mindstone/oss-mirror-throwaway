import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setErrorReporter } from '@core/errorReporter';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';
import * as atomicFileWrite from '@core/utils/atomicFileWrite';

vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-outbox',
}));

// Mock incrementalSessionStore used by drain() in cloudOutbox.ts
// Path is resolved from cloudOutbox.ts: '../incrementalSessionStore' = src/main/services/incrementalSessionStore
const mockGetSession = vi.fn();
vi.mock('../../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({ getSession: mockGetSession }),
}));

import { CloudOutbox } from '../cloudOutbox';

const OUTBOX_PATH = path.join('/tmp/test-cloud-outbox', 'sessions', 'cloud-outbox.json');
const capturedBreadcrumbs: Array<{ category: string; message: string; data?: Record<string, unknown> }> = [];
const capturedMessages: Array<{ message: string; context?: Record<string, unknown> }> = [];

function makeClient(opts?: { putFails?: boolean; deleteFails?: boolean }) {
  return {
    put: vi.fn().mockImplementation(() =>
      opts?.putFails ? Promise.reject(new Error('network error')) : Promise.resolve({}),
    ),
    delete: vi.fn().mockImplementation(() =>
      opts?.deleteFails ? Promise.reject(new Error('network error')) : Promise.resolve({}),
    ),
  };
}

describe('CloudOutbox', () => {
  let outbox: CloudOutbox;

  beforeEach(() => {
    outbox = new CloudOutbox();
    mockGetSession.mockReset();
    capturedBreadcrumbs.length = 0;
    capturedMessages.length = 0;
    setErrorReporter({
      captureException: () => {},
      captureMessage: (message, context) => {
        capturedMessages.push({ message, context });
      },
      addBreadcrumb: (breadcrumb) => {
        capturedBreadcrumbs.push({
          category: breadcrumb.category,
          message: breadcrumb.message,
          data: breadcrumb.data,
        });
      },
    });
    try { fs.rmSync(path.dirname(OUTBOX_PATH), { recursive: true, force: true }); } catch { /* ok */ }
  });

  afterEach(() => {
    outbox._resetForTesting();
    resetSessionMutexForTests();
    vi.useRealTimers();
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });
    try { fs.rmSync(path.dirname(OUTBOX_PATH), { recursive: true, force: true }); } catch { /* ok */ }
  });

  // ---------------------------------------------------------------------------
  // enqueue
  // ---------------------------------------------------------------------------

  it('enqueues an upsert entry', () => {
    outbox.enqueue('session-1', 'upsert');
    expect(outbox.getStatus()).toEqual({ pending: 1, failed: 0 });
    expect(outbox.getAll()[0]).toMatchObject({ sessionId: 'session-1', op: 'upsert', status: 'pending', attempts: 0 });
  });

  it('enqueues a delete entry', () => {
    outbox.enqueue('session-1', 'delete');
    expect(outbox.getAll()[0]).toMatchObject({ op: 'delete', status: 'pending' });
  });

  it('deduplicates same-op pending upserts (resets retry timer)', () => {
    outbox.enqueue('session-1', 'upsert');
    const firstEntry = outbox.getAll()[0];
    const firstId = firstEntry.id;

    // Simulate backoff delay
    firstEntry.nextRetryAt = Date.now() + 60_000;

    outbox.enqueue('session-1', 'upsert');
    const entries = outbox.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(firstId);
    expect(entries[0].attempts).toBe(0);
    expect(entries[0].nextRetryAt).toBeLessThanOrEqual(Date.now() + 100);
  });

  it('delete replaces pending upsert for same session', () => {
    outbox.enqueue('session-1', 'upsert');
    outbox.enqueue('session-1', 'delete');
    const entries = outbox.getAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].op).toBe('delete');
  });

  it('durable enqueue writes to disk synchronously', () => {
    outbox.onConnectionChanged('https://test.example.com');
    const writeSpy = vi.spyOn(outbox as unknown as { writeToDisk: () => void }, 'writeToDisk');

    outbox.enqueue('session-durable', 'delete', { durable: true });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8')) as Record<string, unknown>;
    expect(persisted['session-durable']).toMatchObject({
      sessionId: 'session-durable',
      op: 'delete',
      status: 'pending',
    });
  });

  it('durable enqueue survives crash simulation before debounce window', () => {
    outbox.onConnectionChanged('https://test.example.com');
    outbox.enqueue('session-crash-safe', 'delete', { durable: true });

    // Simulate abrupt process death: in-memory state is gone, disk persists.
    outbox._resetForTesting();

    const fresh = new CloudOutbox();
    fresh.load();
    expect(fresh.getAll()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'session-crash-safe',
          op: 'delete',
          status: 'pending',
        }),
      ]),
    );
    fresh._resetForTesting();
  });

  it('throws on non-durable durable enqueue writes and succeeds after retry', () => {
    outbox.onConnectionChanged('https://test.example.com');
    const writeSpy = vi.spyOn(atomicFileWrite, 'atomicWriteFileSync').mockReturnValueOnce({
      durable: false,
      error: 'disk full',
      errorCode: 'ENOSPC',
    });

    expect(() => outbox.enqueue('session-durable-failure', 'delete', { durable: true })).toThrow(
      'Cloud outbox write not durable: disk full (code: ENOSPC)',
    );
    expect(fs.existsSync(OUTBOX_PATH)).toBe(false);

    writeSpy.mockRestore();
    expect(() => outbox.flush()).not.toThrow();

    const persisted = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8')) as Record<string, unknown>;
    expect(persisted['session-durable-failure']).toMatchObject({
      sessionId: 'session-durable-failure',
      op: 'delete',
      status: 'pending',
    });
  });

  // ---------------------------------------------------------------------------
  // drain — upsert success
  // ---------------------------------------------------------------------------

  it('suppresses only tombstoned pending upserts', () => {
    outbox.enqueue('session-upsert-a', 'upsert');
    outbox.enqueue('session-delete', 'delete');
    outbox.enqueue('session-upsert-b', 'upsert');

    const suppressed = outbox.suppressTombstonedUpserts((sessionId) => sessionId === 'session-upsert-a' || sessionId === 'session-delete');

    expect(suppressed).toEqual(['session-upsert-a']);
    const remaining = outbox.getAll().map((entry) => `${entry.sessionId}:${entry.op}`).sort();
    expect(remaining).toEqual(['session-delete:delete', 'session-upsert-b:upsert']);
  });

  it('returns empty list when no tombstoned upserts are pending', () => {
    outbox.enqueue('session-delete', 'delete');

    const suppressed = outbox.suppressTombstonedUpserts(() => true);

    expect(suppressed).toEqual([]);
    expect(outbox.getAll()).toHaveLength(1);
    expect(outbox.getAll()[0].op).toBe('delete');
  });

  it('delivers a pending upsert and removes it on success', async () => {
    const session = { id: 'session-1', title: 'Test', events: [] };
    mockGetSession.mockResolvedValue(session);

    outbox.enqueue('session-1', 'upsert');
    const client = makeClient();
    const result = await outbox.drain(client);

    expect(result.ok).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.authFailures).toBe(0);
    expect(client.put).toHaveBeenCalledWith('/api/sessions/session-1', session);
    expect(outbox.getStatus()).toEqual({ pending: 0, failed: 0 });
  });

  it('injects tracked cloudUpdatedAt into session before push', async () => {
    const session = { id: 'session-1', title: 'Test', events: [], cloudUpdatedAt: 1_000 };
    mockGetSession.mockResolvedValue(session);

    // Simulate: outbox knows cloud stamped cloudUpdatedAt=5000 on last push
    outbox.recordCloudUpdatedAt('session-1', 5_000);

    outbox.enqueue('session-1', 'upsert');
    const client = makeClient();
    await outbox.drain(client);

    // Should inject the tracked value, not the stale session value
    expect(client.put).toHaveBeenCalledWith(
      '/api/sessions/session-1',
      expect.objectContaining({ cloudUpdatedAt: 5_000 }),
    );
  });

  it('records cloudUpdatedAt from PUT response for subsequent pushes', async () => {
    const session = { id: 'session-1', title: 'Test', events: [], cloudUpdatedAt: 1_000 };
    mockGetSession.mockResolvedValue(session);

    const client = {
      put: vi.fn().mockResolvedValue({ success: true, cloudUpdatedAt: 8_000 }),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    outbox.enqueue('session-1', 'upsert');
    await outbox.drain(client);

    // Enqueue and drain again — second push should use the recorded value
    const session2 = { ...session, title: 'Updated' };
    mockGetSession.mockResolvedValue(session2);
    outbox.enqueue('session-1', 'upsert');
    await outbox.drain(client);

    expect(client.put).toHaveBeenLastCalledWith(
      '/api/sessions/session-1',
      expect.objectContaining({ cloudUpdatedAt: 8_000, title: 'Updated' }),
    );
  });

  it('does not inject tracked value when session cloudUpdatedAt is already newer', async () => {
    const session = { id: 'session-1', title: 'Test', events: [], cloudUpdatedAt: 10_000 };
    mockGetSession.mockResolvedValue(session);

    outbox.recordCloudUpdatedAt('session-1', 5_000);

    outbox.enqueue('session-1', 'upsert');
    const client = makeClient();
    await outbox.drain(client);

    // Session's own cloudUpdatedAt (10_000) is newer — use it as-is
    expect(client.put).toHaveBeenCalledWith(
      '/api/sessions/session-1',
      expect.objectContaining({ cloudUpdatedAt: 10_000 }),
    );
  });

  it('skips upsert when session no longer exists locally', async () => {
    mockGetSession.mockResolvedValue(null);

    outbox.enqueue('session-1', 'upsert');
    const client = makeClient();
    const result = await outbox.drain(client);

    expect(result.ok).toBe(1);
    expect(client.put).not.toHaveBeenCalled();
    expect(outbox.getStatus()).toEqual({ pending: 0, failed: 0 });
  });

  // ---------------------------------------------------------------------------
  // drain — delete success
  // ---------------------------------------------------------------------------

  it('delivers a pending delete and removes it on success', async () => {
    outbox.enqueue('session-1', 'delete');
    const client = makeClient();
    await outbox.drain(client);

    expect(client.delete).toHaveBeenCalledWith('/api/sessions/session-1');
    expect(outbox.getStatus()).toEqual({ pending: 0, failed: 0 });
  });

  // ---------------------------------------------------------------------------
  // drain — failure and backoff
  // ---------------------------------------------------------------------------

  it('increments attempts and schedules retry on failure', async () => {
    const session = { id: 'session-1', events: [] };
    mockGetSession.mockResolvedValue(session);

    outbox.enqueue('session-1', 'upsert');
    const client = makeClient({ putFails: true });
    await outbox.drain(client);

    const entry = outbox.getAll()[0];
    expect(entry.attempts).toBe(1);
    expect(entry.status).toBe('pending');
    expect(entry.nextRetryAt).toBeGreaterThan(Date.now());
    expect(outbox.getStatus()).toEqual({ pending: 1, failed: 0 });
  });

  it('retries indefinitely with backoff capped at 30 min', async () => {
    const session = { id: 'session-1', events: [] };
    mockGetSession.mockResolvedValue(session);

    outbox.enqueue('session-1', 'upsert');
    const client = makeClient({ putFails: true });

    for (let i = 0; i < 15; i++) {
      const entry = outbox.getAll()[0];
      if (entry) entry.nextRetryAt = 0; // force due
      await outbox.drain(client);
    }

    // Still pending after 15 attempts (no permanent failure)
    expect(outbox.getStatus()).toEqual({ pending: 1, failed: 0 });
    expect(outbox.getAll()[0].status).toBe('pending');
    expect(outbox.getAll()[0].attempts).toBe(15);
  });

  // REBEL-1G8: drain() must surface failure metadata so the cloud router
  // can correctly trip the failure cooldown. Previously drain() returned
  // only a delivered count and resolved successfully even when 100% of
  // entries failed — leaving the cooldown closed and stale credentials
  // retrying forever.
  it('drain returns failedCount and 0 delivered when every entry fails', async () => {
    mockGetSession.mockResolvedValue({ id: 'session-1', events: [] });
    outbox.enqueue('session-1', 'upsert');

    const client = makeClient({ putFails: true });
    const result = await outbox.drain(client);

    expect(result.ok).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.authFailures).toBe(0);
    expect(result.sampleError).toContain('network error');
  });

  it('drain reports authFailures when error indicates 401', async () => {
    mockGetSession.mockResolvedValue({ id: 'session-1', events: [] });
    outbox.enqueue('session-1', 'upsert');

    const client = {
      put: vi.fn().mockRejectedValue(new Error('Cloud bridge: HTTP 401 Unauthorized')),
      delete: vi.fn().mockResolvedValue({}),
    };
    const result = await outbox.drain(client);

    expect(result.ok).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.authFailures).toBe(1);
  });

  it('drain reports authFailures when error indicates 403 forbidden', async () => {
    mockGetSession.mockResolvedValue({ id: 'session-1', events: [] });
    outbox.enqueue('session-1', 'upsert');

    const client = {
      put: vi.fn().mockRejectedValue(new Error('Cloud bridge: HTTP 403 Forbidden')),
      delete: vi.fn().mockResolvedValue({}),
    };
    const result = await outbox.drain(client);

    expect(result.authFailures).toBe(1);
  });

  it('drain detects auth failure from structured statusCode property', async () => {
    mockGetSession.mockResolvedValue({ id: 'session-1', events: [] });
    outbox.enqueue('session-1', 'upsert');

    const authError = Object.assign(new Error('request failed'), { statusCode: 401 });
    const client = {
      put: vi.fn().mockRejectedValue(authError),
      delete: vi.fn().mockResolvedValue({}),
    };
    const result = await outbox.drain(client);

    expect(result.authFailures).toBe(1);
  });

  // Regression: bare "401"/"403" embedded in unrelated context (session IDs,
  // correlation tokens, ports, hashes) must NOT trip the auth detector.
  // Otherwise the cloud cooldown gets falsely escalated to "auth-failure"
  // treatment for unrelated network errors.
  it('drain does not classify unrelated 401/403 substrings as auth failures', async () => {
    mockGetSession.mockResolvedValue({ id: 'session-401abc', events: [] });
    outbox.enqueue('session-401abc', 'upsert');

    const client = {
      put: vi.fn().mockRejectedValue(
        new Error('connect ECONNREFUSED 127.0.0.1:401-corrId-7403xyz timed out'),
      ),
      delete: vi.fn().mockResolvedValue({}),
    };
    const result = await outbox.drain(client);

    expect(result.failed).toBe(1);
    expect(result.authFailures).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // drain — permanent failure (413 BODY_TOO_LARGE)
  // ---------------------------------------------------------------------------

  it('classifies 413 statusCode as permanent failure and stops retrying', async () => {
    mockGetSession.mockResolvedValue({ id: 'session-1', events: [] });
    outbox.enqueue('session-1', 'upsert');

    const oversizedError = Object.assign(new Error('Cloud request failed: 413 Payload Too Large'), {
      statusCode: 413,
      code: 'BODY_TOO_LARGE',
      name: 'CloudServiceError',
    });
    const client = {
      put: vi.fn().mockRejectedValue(oversizedError),
      delete: vi.fn().mockResolvedValue({}),
    };

    const result = await outbox.drain(client);
    expect(result.ok).toBe(0);
    expect(result.failed).toBe(1);

    const entry = outbox.getAll()[0];
    expect(entry.status).toBe('permanent_failure');
    expect(entry.attempts).toBe(1);
    expect(entry.lastError).toContain('413');

    // Permanent failures are not counted as pending and not retried.
    expect(outbox.getStatus()).toEqual({ pending: 0, failed: 0 });

    const secondResult = await outbox.drain(client);
    expect(secondResult.ok).toBe(0);
    expect(secondResult.failed).toBe(0);
    expect(client.put).toHaveBeenCalledTimes(1);
    expect(outbox.getAll()[0].status).toBe('permanent_failure');
    expect(outbox.getAll()[0].attempts).toBe(1);
  });

  it('classifies BODY_TOO_LARGE error code as permanent failure', async () => {
    mockGetSession.mockResolvedValue({ id: 'session-1', events: [] });
    outbox.enqueue('session-1', 'upsert');

    const oversizedError = Object.assign(new Error('Request body too large'), {
      code: 'BODY_TOO_LARGE',
      name: 'CloudServiceError',
    });
    const client = {
      put: vi.fn().mockRejectedValue(oversizedError),
      delete: vi.fn().mockResolvedValue({}),
    };

    await outbox.drain(client);

    expect(outbox.getAll()[0].status).toBe('permanent_failure');
  });

  it('permanent failure entries persist across reload', () => {
    outbox.onConnectionChanged('https://test.example.com');
    outbox.enqueue('session-1', 'upsert');
    outbox.markPermanentlyFailed('session-1', 'Cloud request failed: 413 Payload Too Large');
    outbox.flush();

    const fresh = new CloudOutbox();
    fresh.load();
    const entry = fresh.getAll()[0];
    expect(entry).toBeDefined();
    expect(entry.status).toBe('permanent_failure');
    expect(entry.lastError).toContain('413');
    fresh._resetForTesting();
  });

  it('non-permanent failures still retry indefinitely (regression guard)', async () => {
    const session = { id: 'session-1', events: [] };
    mockGetSession.mockResolvedValue(session);

    outbox.enqueue('session-1', 'upsert');
    const client = {
      put: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:443')),
      delete: vi.fn().mockResolvedValue({}),
    };
    await outbox.drain(client);

    expect(outbox.getAll()[0].status).toBe('pending');
  });

  // ---------------------------------------------------------------------------
  // drain — toolDetailArchive stripping (desktop-only field)
  // ---------------------------------------------------------------------------

  it('strips toolDetailArchive from session before cloud push', async () => {
    const session = {
      id: 'session-1',
      title: 'Test',
      events: [],
      cloudUpdatedAt: 1_000,
      toolDetailArchive: {
        'tool-call-1': { detail: 'large desktop-only diagnostics blob' },
      },
    };
    mockGetSession.mockResolvedValue(session);

    outbox.enqueue('session-1', 'upsert');
    const client = makeClient();
    await outbox.drain(client);

    expect(client.put).toHaveBeenCalledTimes(1);
    const sentBody = client.put.mock.calls[0][1] as Record<string, unknown>;
    expect(sentBody).not.toHaveProperty('toolDetailArchive');
    expect(sentBody.id).toBe('session-1');
    expect(sentBody.title).toBe('Test');
    expect(sentBody.cloudUpdatedAt).toBe(1_000);
  });

  it('re-enqueueing a permanent_failure session creates a fresh pending entry', () => {
    outbox.enqueue('session-1', 'upsert');
    outbox.markPermanentlyFailed('session-1', 'Cloud request failed: 413 Payload Too Large');
    expect(outbox.getAll()[0].status).toBe('permanent_failure');

    outbox.enqueue('session-1', 'upsert');
    expect(outbox.getAll()[0].status).toBe('pending');
    expect(outbox.getAll()[0].attempts).toBe(0);
    expect(outbox.getStatus().pending).toBe(1);
  });

  it('stripping toolDetailArchive does not mutate the source session in store', async () => {
    const session = {
      id: 'session-1',
      events: [],
      toolDetailArchive: { 'tool-1': { detail: 'kept locally' } },
    };
    mockGetSession.mockResolvedValue(session);

    outbox.enqueue('session-1', 'upsert');
    const client = makeClient();
    await outbox.drain(client);

    expect(session.toolDetailArchive).toEqual({ 'tool-1': { detail: 'kept locally' } });
  });

  it('drain reports both delivered and failed counts in mixed-success drain', async () => {
    mockGetSession.mockImplementation(async (id: string) => ({ id, events: [] }));
    outbox.enqueue('session-ok', 'upsert');
    outbox.enqueue('session-bad', 'upsert');

    const client = {
      put: vi.fn().mockImplementation((path: string) =>
        path.includes('session-bad')
          ? Promise.reject(new Error('network error'))
          : Promise.resolve({}),
      ),
      delete: vi.fn().mockResolvedValue({}),
    };
    const result = await outbox.drain(client);

    expect(result.ok).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.authFailures).toBe(0);
  });

  it('drain returns zeroes when no entries are due', async () => {
    const client = makeClient();
    const result = await outbox.drain(client);

    expect(result).toEqual({ ok: 0, failed: 0, authFailures: 0 });
  });

  it('emits stuck-outbox breadcrumbs/messages when pending entries do not drain for 10 minutes', () => {
    vi.useFakeTimers();
    const baseTime = new Date('2026-01-01T00:00:00.000Z').getTime();
    vi.setSystemTime(baseTime);

    outbox.enqueue('session-stuck', 'upsert');
    vi.setSystemTime(baseTime + (10 * 60 * 1_000) + 1);
    outbox._checkForStuckOutboxForTesting();

    expect(capturedBreadcrumbs).toHaveLength(1);
    expect(capturedBreadcrumbs[0]).toMatchObject({
      category: 'continuity.continuity-state',
      message: 'stuck-outbox',
    });
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0].message).toContain('stuck');

    outbox._checkForStuckOutboxForTesting();
    expect(capturedMessages).toHaveLength(1);

    vi.setSystemTime(baseTime + (70 * 60 * 1_000) + 1);
    outbox._checkForStuckOutboxForTesting();
    expect(capturedMessages).toHaveLength(2);
  });

  it('does not emit stuck-outbox when pending item drains successfully', async () => {
    vi.useFakeTimers();
    const baseTime = new Date('2026-01-01T00:00:00.000Z').getTime();
    vi.setSystemTime(baseTime);

    mockGetSession.mockResolvedValue({ id: 'session-ok', title: 'ok' });
    outbox.enqueue('session-ok', 'upsert');
    const client = makeClient();
    await outbox.drain(client);

    vi.setSystemTime(baseTime + (20 * 60 * 1_000));
    outbox._checkForStuckOutboxForTesting();
    const stuckBreadcrumbs = capturedBreadcrumbs.filter((b) => b.message === 'stuck-outbox');
    const stuckMessages = capturedMessages.filter((m) => m.message.includes('stuck'));
    expect(stuckBreadcrumbs).toHaveLength(0);
    expect(stuckMessages).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // drain — concurrent guard
  // ---------------------------------------------------------------------------

  it('awaits a concurrent drain call instead of skipping', async () => {
    const session = { id: 'session-1', events: [] };
    mockGetSession.mockResolvedValue(session);

    let resolvePut!: () => void;
    const client = {
      put: vi.fn().mockReturnValue(new Promise<void>((r) => { resolvePut = r; })),
      delete: vi.fn(),
    };
    outbox.enqueue('session-1', 'upsert');

    // Start first drain (runs synchronously until first internal await, setting drainPromise)
    const first = outbox.drain(client);
    // Second concurrent call awaits the first and returns 0 (didn't do the work itself)
    const secondPromise = outbox.drain(client);

    // Let the first drain complete
    resolvePut();
    const [firstResult, secondResult] = await Promise.all([first, secondPromise]);

    expect(firstResult.ok).toBe(1);
    expect(secondResult.ok).toBe(0);
    expect(client.put).toHaveBeenCalledTimes(1);
    expect(capturedBreadcrumbs.some((b) =>
      b.category === 'continuity.continuity-state'
      && b.message === 'state-transition'
      && b.data?.reason === 'session-mutex-contention'
      && b.data?.label === 'cloudOutbox.drain'
    )).toBe(true);
  });

  it('serialises concurrent drains across outbox instances for the same device key', async () => {
    const secondOutbox = new CloudOutbox();
    mockGetSession.mockResolvedValue({ id: 'session-1', events: [] });

    outbox.onConnectionChanged('https://cloud.example.test');
    secondOutbox.onConnectionChanged('https://cloud.example.test');
    outbox.enqueue('session-1', 'upsert');
    secondOutbox.enqueue('session-2', 'upsert');

    let currentConcurrent = 0;
    let maxConcurrent = 0;
    const resolvers: Array<() => void> = [];
    const client = {
      put: vi.fn().mockImplementation(() => {
        currentConcurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        return new Promise<void>((resolve) => {
          resolvers.push(() => {
            currentConcurrent -= 1;
            resolve();
          });
        });
      }),
      delete: vi.fn(),
    };

    const firstPromise = outbox.drain(client);
    await new Promise((r) => setTimeout(r, 20));
    const secondPromise = secondOutbox.drain(client);
    await new Promise((r) => setTimeout(r, 20));

    expect(maxConcurrent).toBe(1);

    while (resolvers.length > 0) {
      resolvers.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }

    await Promise.all([firstPromise, secondPromise]);
    expect(maxConcurrent).toBe(1);
    secondOutbox._resetForTesting();
  });

  // ---------------------------------------------------------------------------
  // onStatusChange callback
  // ---------------------------------------------------------------------------

  it('calls onStatusChange after each delivery', async () => {
    const session = { id: 'session-1', events: [] };
    mockGetSession.mockResolvedValue(session);

    outbox.enqueue('session-1', 'upsert');
    const client = makeClient();
    const statusChanges: Array<{ pending: number; failed: number }> = [];
    await outbox.drain(client, (s) => statusChanges.push(s));

    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0]).toEqual({ pending: 0, failed: 0 });
  });

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  it('persists to disk on flush and reloads', () => {
    // Set a cloud URL so entries have provenance (avoids legacy-cleanup on reload)
    outbox.onConnectionChanged('https://test.example.com');
    outbox.enqueue('session-a', 'upsert');
    outbox.enqueue('session-b', 'delete');
    outbox.flush();

    expect(fs.existsSync(OUTBOX_PATH)).toBe(true);

    const fresh = new CloudOutbox();
    fresh.load();
    const entries = fresh.getAll();
    const ids = entries.map((e) => e.sessionId).sort();
    expect(ids).toEqual(['session-a', 'session-b']);
    fresh._resetForTesting();
  });

  it('handles missing outbox file gracefully', () => {
    outbox.load();
    expect(outbox.getStatus()).toEqual({ pending: 0, failed: 0 });
  });

  it('handles corrupt outbox file gracefully', () => {
    fs.mkdirSync(path.dirname(OUTBOX_PATH), { recursive: true });
    fs.writeFileSync(OUTBOX_PATH, 'not-json', 'utf8');

    outbox.load();
    expect(outbox.getStatus()).toEqual({ pending: 0, failed: 0 });
    expect(fs.existsSync(OUTBOX_PATH)).toBe(false);

    const files = fs.readdirSync(path.dirname(OUTBOX_PATH));
    const corruptFiles = files.filter(
      (name) => name.startsWith('cloud-outbox.corrupt.') && name.endsWith('.json')
    );
    expect(corruptFiles).toHaveLength(1);
  });

  it('reports load failure observability when outbox file is corrupt', () => {
    fs.mkdirSync(path.dirname(OUTBOX_PATH), { recursive: true });
    fs.writeFileSync(OUTBOX_PATH, '{invalid-json}', 'utf8');

    outbox.load();

    const sentryEvent = capturedMessages.find(
      (event) => event.message === 'cloud-outbox-load-failed-starting-fresh',
    );
    expect(sentryEvent).toBeDefined();
    expect(sentryEvent?.context).toMatchObject({
      level: 'warning',
      extra: {
        errorMessage: expect.any(String),
      },
    });
  });

  it('filters out invalid entries on load', () => {
    fs.mkdirSync(path.dirname(OUTBOX_PATH), { recursive: true });
    fs.writeFileSync(
      OUTBOX_PATH,
      JSON.stringify({
        _cloudUrl: 'https://test.example.com',
        'session-a': { id: 'session-a:upsert:1', sessionId: 'session-a', op: 'upsert', enqueuedAt: 0, attempts: 0, nextRetryAt: 0, status: 'pending' },
        'session-b': { id: 'bad', sessionId: 42 }, // invalid — no string sessionId
      }),
      'utf8',
    );

    outbox.load();
    expect(outbox.getAll()).toHaveLength(1);
    expect(outbox.getAll()[0].sessionId).toBe('session-a');
  });

  it('clears legacy entries without URL provenance', () => {
    fs.mkdirSync(path.dirname(OUTBOX_PATH), { recursive: true });
    // Legacy file: entries but no _cloudUrl
    fs.writeFileSync(
      OUTBOX_PATH,
      JSON.stringify({
        'session-a': { id: 'session-a:upsert:1', sessionId: 'session-a', op: 'upsert', enqueuedAt: 0, attempts: 0, nextRetryAt: 0, status: 'pending' },
      }),
      'utf8',
    );

    outbox.load();
    // Legacy entries should be cleared for safety
    expect(outbox.getAll()).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Instance scoping — onConnectionChanged
  // ---------------------------------------------------------------------------

  it('onConnectionChanged with different URL clears entries', () => {
    outbox.enqueue('session-1', 'upsert');
    outbox.enqueue('session-2', 'delete');
    expect(outbox.getAll()).toHaveLength(2);

    // First connection — sets currentCloudUrl, no clear
    outbox.onConnectionChanged('https://cloud-a.example.com');
    expect(outbox.getAll()).toHaveLength(2);

    // Different URL — clears all entries
    outbox.onConnectionChanged('https://cloud-b.example.com');
    expect(outbox.getAll()).toHaveLength(0);
    expect(outbox.getStatus()).toEqual({ pending: 0, failed: 0 });
  });

  it('onConnectionChanged with same URL does not clear entries', () => {
    outbox.onConnectionChanged('https://cloud-a.example.com');
    outbox.enqueue('session-1', 'upsert');
    expect(outbox.getAll()).toHaveLength(1);

    // Same URL — entries preserved
    outbox.onConnectionChanged('https://cloud-a.example.com');
    expect(outbox.getAll()).toHaveLength(1);
  });

  it('onConnectionChanged with first URL (no previous) does not clear entries', () => {
    outbox.enqueue('session-1', 'upsert');
    expect(outbox.getAll()).toHaveLength(1);

    // First connection — no previous URL, should not clear
    outbox.onConnectionChanged('https://cloud-a.example.com');
    expect(outbox.getAll()).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Instance scoping — clearAll
  // ---------------------------------------------------------------------------

  it('clearAll removes all entries and writes to disk immediately', () => {
    outbox.enqueue('session-1', 'upsert');
    outbox.enqueue('session-2', 'delete');
    outbox.flush(); // ensure entries are on disk first

    expect(outbox.getAll()).toHaveLength(2);
    expect(fs.existsSync(OUTBOX_PATH)).toBe(true);

    outbox.clearAll();

    expect(outbox.getAll()).toHaveLength(0);
    expect(outbox.getStatus()).toEqual({ pending: 0, failed: 0 });

    // Verify empty state was written to disk immediately
    const raw = fs.readFileSync(OUTBOX_PATH, 'utf8');
    expect(JSON.parse(raw)).toEqual({});
  });

  it('clearAll on empty outbox is a no-op', () => {
    outbox.clearAll();
    expect(outbox.getAll()).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Stage 2 refinement-5: durable enqueue without onConnectionChanged loses
  // intent on reload (regression guard — proves the priming fix in main/index
  // is necessary)
  // ---------------------------------------------------------------------------

  it('durable enqueue persisted WITHOUT onConnectionChanged primed is cleared as legacy on reload', () => {
    // Simulate the Stage 2 race: cleanupLeakedSessions runs before
    // cloudRouter.updateConnection() / cloudOutbox.onConnectionChanged().
    // Durable enqueue persists to disk WITHOUT _cloudUrl provenance.
    outbox.enqueue('leaked-session-1', 'delete', { durable: true });
    expect(outbox.getAll()).toHaveLength(1);

    // Verify the on-disk file lacks _cloudUrl
    const raw = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8'));
    expect(raw._cloudUrl).toBeUndefined();
    expect(raw['leaked-session-1']).toBeDefined();

    // Simulate restart with a fresh outbox instance
    const fresh = new CloudOutbox();
    fresh.load();

    // Without _cloudUrl provenance, entries are cleared as "legacy unknown
    // instance" — this is the exact failure mode that the priming fix in
    // src/main/index.ts before cleanupLeakedSessions() prevents.
    expect(fresh.getAll()).toHaveLength(0);
  });

  it('durable enqueue persisted AFTER onConnectionChanged primed survives reload', () => {
    // Stage 2 refinement-5 fix: prime cloudOutbox.onConnectionChanged BEFORE
    // cleanupLeakedSessions runs. Durable enqueue then persists with _cloudUrl
    // provenance and survives a crash/reload.
    outbox.onConnectionChanged('https://cloud.example.com');
    outbox.enqueue('leaked-session-1', 'delete', { durable: true });

    // Verify the on-disk file now has _cloudUrl
    const raw = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8'));
    expect(raw._cloudUrl).toBe('https://cloud.example.com');
    expect(raw['leaked-session-1']).toBeDefined();

    // Simulate restart and verify entry survives
    const fresh = new CloudOutbox();
    fresh.load();
    expect(fresh.getAll()).toHaveLength(1);
    expect(fresh.hasPendingDelete('leaked-session-1')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // cloudUpdatedAtTracker persistence
  // ---------------------------------------------------------------------------

  it('persists cloudUpdatedAtTracker across restart', async () => {
    outbox.onConnectionChanged('https://test.example.com');
    outbox.recordCloudUpdatedAt('session-1', 5_000);
    outbox.recordCloudUpdatedAt('session-2', 8_000);
    outbox.flush();

    const raw = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8'));
    expect(raw._cloudUpdatedAtTracker).toEqual({ 'session-1': 5_000, 'session-2': 8_000 });

    const fresh = new CloudOutbox();
    fresh.load();

    // Verify the tracker was restored by checking it injects the value during drain
    const session = { id: 'session-1', title: 'Test', events: [], cloudUpdatedAt: 1_000 };
    mockGetSession.mockResolvedValue(session);
    fresh.enqueue('session-1', 'upsert');
    const client = makeClient();
    await fresh.drain(client);
    expect(client.put).toHaveBeenCalledWith(
      '/api/sessions/session-1',
      expect.objectContaining({ cloudUpdatedAt: 5_000 }),
    );
    fresh._resetForTesting();
  });

  it('handles missing _cloudUpdatedAtTracker key gracefully (backwards compat)', async () => {
    fs.mkdirSync(path.dirname(OUTBOX_PATH), { recursive: true });
    fs.writeFileSync(
      OUTBOX_PATH,
      JSON.stringify({ _cloudUrl: 'https://test.example.com' }),
      'utf8',
    );

    outbox.load();
    // Tracker should be empty — no crash, no errors
    const session = { id: 'session-1', title: 'Test', events: [], cloudUpdatedAt: 1_000 };
    mockGetSession.mockResolvedValue(session);
    outbox.enqueue('session-1', 'upsert');
    const client = makeClient();
    await outbox.drain(client);
    // No tracked value → session's own cloudUpdatedAt used as-is
    expect(client.put).toHaveBeenCalledWith(
      '/api/sessions/session-1',
      expect.objectContaining({ cloudUpdatedAt: 1_000 }),
    );
  });

  it('handles corrupt _cloudUpdatedAtTracker entries gracefully', async () => {
    fs.mkdirSync(path.dirname(OUTBOX_PATH), { recursive: true });
    fs.writeFileSync(
      OUTBOX_PATH,
      JSON.stringify({
        _cloudUrl: 'https://test.example.com',
        _cloudUpdatedAtTracker: {
          'session-ok': 5_000,
          'session-bad-value': 'not-a-number',
          '': 1_000,
          'session-nan': NaN,
          'session-infinity': Infinity,
        },
      }),
      'utf8',
    );

    outbox.load();
    // Only session-ok should be loaded (valid key + finite number)
    outbox.enqueue('session-ok', 'upsert');
    const session = { id: 'session-ok', title: 'Test', events: [], cloudUpdatedAt: 1_000 };
    mockGetSession.mockResolvedValue(session);
    const client = makeClient();
    await outbox.drain(client);
    expect(client.put).toHaveBeenCalledWith(
      '/api/sessions/session-ok',
      expect.objectContaining({ cloudUpdatedAt: 5_000 }),
    );
  });

  it('clearAll persists empty tracker to disk', () => {
    outbox.onConnectionChanged('https://test.example.com');
    outbox.recordCloudUpdatedAt('session-1', 5_000);
    outbox.flush();

    const rawBefore = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8'));
    expect(rawBefore._cloudUpdatedAtTracker).toEqual({ 'session-1': 5_000 });

    outbox.clearAll();

    const rawAfter = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8'));
    expect(rawAfter._cloudUpdatedAtTracker).toBeUndefined();
  });
});
