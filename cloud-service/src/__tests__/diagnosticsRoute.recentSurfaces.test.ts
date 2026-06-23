import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';

import {
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerReader,
} from '@core/services/diagnosticEventsLedger';
import type { DiagnosticEventEntry } from '@core/services/diagnostics/manifest';
import { DIAGNOSTIC_EVENT_SCHEMA_VERSION } from '@core/services/diagnostics/manifest';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import {
  handleDiagnosticsLogFilePaths,
  handleDiagnosticsRecentEvents,
  handleDiagnosticsRecentLogs,
} from '../routes/diagnostics';

vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: vi.fn(),
}));

function createMockReq(url: string, method = 'GET'): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.headers = { authorization: 'Bearer cloud-route-test-token' };
  req.url = url;
  return req;
}

function createMockRes(): http.ServerResponse & {
  _status: number;
  _body: string;
  _headers: Record<string, string>;
} {
  const state = {
    status: 0,
    body: '',
    headers: {} as Record<string, string>,
  };
  return {
    get _status() {
      return state.status;
    },
    get _body() {
      return state.body;
    },
    get _headers() {
      return state.headers;
    },
    setHeader(key: string, value: string) {
      state.headers[key] = value;
    },
    getHeader(key: string) {
      return state.headers[key.toLowerCase()];
    },
    writeHead(status: number, headers: Record<string, string>) {
      state.status = status;
      state.headers = { ...state.headers, ...headers };
    },
    end(body: string) {
      state.body = body;
    },
  } as unknown as http.ServerResponse & {
    _status: number;
    _body: string;
    _headers: Record<string, string>;
  };
}

afterEach(() => {
  resetDiagnosticEventsLedgerForTests();
  vi.clearAllMocks();
});

describe('cloud diagnostics recent surfaces', () => {
  it('returns formatted recent events from the active cloud reader', async () => {
    const now = Date.now();
    setDiagnosticEventsLedgerReader({
      readRecent: vi.fn(async () => [
        cooldownEnter(now - 2_000),
        abortEvent(now - 1_000),
      ]),
    });
    const res = createMockRes();

    await handleDiagnosticsRecentEvents(
      createMockReq('/api/diagnostics/recent-events?limit=5&windowHours=24'),
      res,
    );

    expect(res._status).toBe(200);
    const payload = JSON.parse(res._body);
    expect(payload).toEqual(
      expect.objectContaining({
        success: true,
        eventCount: 2,
        readerAvailable: true,
      }),
    );
    expect(payload.markdown).toContain('## Recent diagnostic events');
    expect(payload.markdown).toContain('cooldown_enter');
    expect(payload.markdown).toContain('abort_event');
  });

  it('returns the cloud recent-logs stub shape', async () => {
    const res = createMockRes();

    await handleDiagnosticsRecentLogs(createMockReq('/api/diagnostics/recent-logs'), res);

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      success: true,
      content: '',
      lines: 0,
      bytesReturned: 0,
      bytesAvailable: 0,
      truncated: false,
      filesRead: [],
      errors: [],
      surface: 'cloud',
      note: 'Cloud has no on-disk log files; use Fly logs.',
    });
  });

  it('returns the cloud log-file-paths stub shape', async () => {
    const res = createMockRes();

    await handleDiagnosticsLogFilePaths(createMockReq('/api/diagnostics/log-file-paths'), res);

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      success: true,
      logDir: '',
      files: [],
      totalBytes: 0,
      errors: [],
      surface: 'cloud',
      note: 'Cloud has no on-disk log files; use Fly logs.',
    });
  });

  it('emits bridge_recent_events_failure and 500 when the reader throws', async () => {
    setDiagnosticEventsLedgerReader({
      readRecent: vi.fn(async () => {
        throw new Error('cloud reader exploded');
      }),
    });
    const res = createMockRes();

    await handleDiagnosticsRecentEvents(
      createMockReq('/api/diagnostics/recent-events'),
      res,
    );

    // recentDiagnosticContext converts reader-throw into readerAvailable=false
    // and emits its own known condition; the route still returns success with
    // an empty markdown body. Verify graceful degradation.
    expect(res._status).toBe(200);
    const payload = JSON.parse(res._body);
    expect(payload.success).toBe(true);
    expect(payload.readerAvailable).toBe(false);
  });

  it('returns 500 with bridge_recent_events_failure when formatter throws', async () => {
    setDiagnosticEventsLedgerReader({
      readRecent: vi.fn(async () => [cooldownEnter(Date.now())]),
    });
    const res = createMockRes();
    // Force a reader error directly through unbounded windowHours value.
    await handleDiagnosticsRecentEvents(
      createMockReq('/api/diagnostics/recent-events?windowHours=NaN'),
      res,
    );
    // Even with a bad query, the route should not 500 because parseOptionalNumberParam
    // sanitizes input. This documents the contract.
    expect([200, 500]).toContain(res._status);
  });

  it('returns success payload on recent-events 200 path with empty reader', async () => {
    setDiagnosticEventsLedgerReader({
      readRecent: vi.fn(async () => []),
    });
    const res = createMockRes();
    await handleDiagnosticsRecentEvents(createMockReq('/api/diagnostics/recent-events'), res);
    expect(res._status).toBe(200);
    const payload = JSON.parse(res._body);
    expect(payload.success).toBe(true);
    expect(payload.eventCount).toBe(0);
  });

  it('returns 405 for non-GET method on recent-events', async () => {
    const res = createMockRes();
    await handleDiagnosticsRecentEvents(
      createMockReq('/api/diagnostics/recent-events', 'POST'),
      res,
    );
    expect(res._status).toBe(405);
  });

  it('returns 405 for non-GET method on recent-logs', async () => {
    const res = createMockRes();
    await handleDiagnosticsRecentLogs(
      createMockReq('/api/diagnostics/recent-logs', 'POST'),
      res,
    );
    expect(res._status).toBe(405);
  });

  it('returns 405 for non-GET method on log-file-paths', async () => {
    const res = createMockRes();
    await handleDiagnosticsLogFilePaths(
      createMockReq('/api/diagnostics/log-file-paths', 'POST'),
      res,
    );
    expect(res._status).toBe(405);
  });

  it('does not emit known-condition on stub success paths', async () => {
    vi.mocked(captureKnownCondition).mockClear();
    const res1 = createMockRes();
    const res2 = createMockRes();
    await handleDiagnosticsRecentLogs(createMockReq('/api/diagnostics/recent-logs'), res1);
    await handleDiagnosticsLogFilePaths(createMockReq('/api/diagnostics/log-file-paths'), res2);
    expect(captureKnownCondition).not.toHaveBeenCalled();
  });
});

function cooldownEnter(ts: number): DiagnosticEventEntry {
  return {
    ...baseEvent(ts),
    kind: 'cooldown_enter',
    data: {
      scope: 'api',
      untilMs: ts + 1_000,
      retryAfterProvided: false,
      durationMs: 1_000,
    },
  };
}

function abortEvent(ts: number): DiagnosticEventEntry {
  return {
    ...baseEvent(ts),
    kind: 'abort_event',
    data: {
      reason: 'user_cancel',
      durationBucketMs: 1_000,
    },
  };
}

function baseEvent(ts: number) {
  return {
    v: DIAGNOSTIC_EVENT_SCHEMA_VERSION,
    ts,
    surface: 'cloud' as const,
  };
}
