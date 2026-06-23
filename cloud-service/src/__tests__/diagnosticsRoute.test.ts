import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { AgentSessionSummary } from '@shared/ipc/schemas/sessions';
import {
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerReader,
} from '@core/services/diagnosticEventsLedger';
import type { DiagnosticEventEntry } from '@core/services/diagnostics/manifest';

const runAllCloudChecksMock = vi.fn();
const getRecentLogsMock = vi.fn();
const listTombstonesMock = vi.fn();
const getOutboxSnapshotMock = vi.fn();
const readContinuityStateMapMock = vi.fn();
const getCatchUpHistoryMock = vi.fn();

vi.mock('../health/checks', () => ({
  runAllCloudChecks: (...args: unknown[]) => runAllCloudChecksMock(...args),
}));

vi.mock('@core/logBuffer', () => ({
  getRecentLogs: (...args: unknown[]) => getRecentLogsMock(...args),
}));

vi.mock('@core/services/continuity/sessionTombstoneStore', () => ({
  getSessionTombstoneStore: () => ({
    listTombstones: (...args: unknown[]) => listTombstonesMock(...args),
  }),
}));

vi.mock('@core/services/continuity/outboxStallMonitor', () => ({
  getOutboxStallMonitor: () => ({
    getSnapshot: (...args: unknown[]) => getOutboxSnapshotMock(...args),
  }),
}));

vi.mock('@core/services/cloudContinuityStateService', () => ({
  readContinuityStateMap: (...args: unknown[]) => readContinuityStateMapMock(...args),
  getCatchUpHistoryForDevice: (...args: unknown[]) => getCatchUpHistoryMock(...args),
}));

import { handleDiagnostics, handleDiagnosticsSelf, _resetDiagnosticsRouteStateForTests } from '../routes/diagnostics';

function createMockReq(
  headers: Record<string, string> = {},
  method = 'GET',
): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.headers = headers;
  req.url = '/api/diagnostics/self';
  return req;
}

type MockDiagnosticsRes = http.ServerResponse & {
  _status: number;
  _body: string;
  _headers: Record<string, string>;
};

function createMockRes(): MockDiagnosticsRes {
  const res: Pick<MockDiagnosticsRes, '_status' | '_body' | '_headers'> & {
    setHeader(key: string, value: string): void;
    writeHead(status: number, headers?: Record<string, string>): void;
    end(body: string): void;
  } = {
    _status: 0,
    _body: '',
    _headers: {},
    setHeader(key, value) {
      this._headers[key] = value;
    },
    writeHead(status, headers) {
      this._status = status;
      this._headers = { ...this._headers, ...(headers ?? {}) };
    },
    end(body) {
      this._body = body;
    },
  };
  return res as unknown as MockDiagnosticsRes;
}

describe('handleDiagnosticsSelf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDiagnosticEventsLedgerForTests();
    _resetDiagnosticsRouteStateForTests();

    runAllCloudChecksMock.mockResolvedValue([
      { id: 'auth', status: 'pass' },
      { id: 'disk', status: 'warn' },
    ]);
    getRecentLogsMock.mockReturnValue([{ level: 30, msg: 'ok' }]);
    listTombstonesMock.mockReturnValue([]);
    getOutboxSnapshotMock.mockReturnValue(null);
    readContinuityStateMapMock.mockReturnValue({});
    getCatchUpHistoryMock.mockReturnValue([]);
  });

  it('returns structured self diagnostics payload with continuity metadata', async () => {
    readContinuityStateMapMock.mockReturnValue({
      'session-1': { state: 'local_only', lastCloudActivityAt: 1_000, cloudPinnedAt: 2_000 },
    });
    listTombstonesMock.mockReturnValue([
      { sessionId: 'session-1', deletedAt: 1_700_000_000_000, deletedBy: 'user' },
    ]);
    getOutboxSnapshotMock.mockReturnValue({
      depth: 2,
      lastDrainAt: 1_700_000_000_000,
      lastSeenAt: 1_700_000_000_500,
      lastEscalatedAt: 0,
      ageMs: 500,
      isStalled: false,
    });
    getCatchUpHistoryMock.mockReturnValue([
      {
        requestedAt: 1_700_000_000_000,
        durationMs: 120,
        sessionCount: 1,
        returnedEventCount: 5,
        limit: 1000,
        usedContinuationToken: false,
        hasMore: false,
      },
    ]);

    const req = createMockReq({
      authorization: 'Bearer token-a',
      'x-rebel-surface': 'mobile',
      'x-rebel-client-id': 'client-1',
    });
    const res = createMockRes();

    await handleDiagnosticsSelf(req, res, {
      listSessions: () => [
        // Diagnostics handler reads only id/updatedAt/cloudUpdatedAt/maxSeq via
        // normalizeCloudSessionSummaries (typed `raw: unknown`), so a minimal shape
        // is contractually safe here. See src/core/services/diagnostics/sessionIndexTypes.ts:86.
        { id: 'session-1', updatedAt: 1_700_000_000_000, cloudUpdatedAt: 1_700_000_000_100, maxSeq: 42 } as unknown as AgentSessionSummary,
      ],
    });

    expect(res._status).toBe(200);
    const payload = JSON.parse(res._body);
    expect(payload.manifest.source).toBe('cloud');
    expect(payload.sessionsIndex.count).toBe(1);
    expect(payload.sessionsIndex.sessions[0]).toEqual(
      expect.objectContaining({
        continuityState: 'local_only',
        hasTombstone: true,
      }),
    );
    expect(payload.sessionsIndex.sessions[0].sessionIdHash).toMatch(/^[a-f0-9]{8}$/);
    expect(payload.queueSnapshot).toEqual(expect.objectContaining({ depth: 2 }));
    expect(payload.catchUpHistory).toHaveLength(1);
    expect(payload.continuityState.tombstoneCount).toBe(1);
  });

  it('rate-limits the legacy diagnostics endpoint globally to one request per minute', async () => {
    const firstRes = createMockRes();
    await handleDiagnostics(createMockReq({}, 'GET'), firstRes, { listSessions: () => [] });
    expect(firstRes._status).toBe(200);

    const secondRes = createMockRes();
    await handleDiagnostics(createMockReq({}, 'GET'), secondRes, { listSessions: () => [] });
    expect(secondRes._status).toBe(429);
    expect(JSON.parse(secondRes._body).error.code).toBe('RATE_LIMITED');
  });

  it('rate-limits to one request per minute per device scope', async () => {
    const headers = {
      authorization: 'Bearer token-b',
      'x-rebel-surface': 'mobile',
      'x-rebel-client-id': 'client-2',
    };

    const firstRes = createMockRes();
    await handleDiagnosticsSelf(createMockReq(headers), firstRes, {
      listSessions: () => [],
    });
    expect(firstRes._status).toBe(200);

    const secondRes = createMockRes();
    await handleDiagnosticsSelf(createMockReq(headers), secondRes, {
      listSessions: () => [],
    });
    expect(secondRes._status).toBe(429);
    expect(JSON.parse(secondRes._body).error.code).toBe('RATE_LIMITED');
  });

  it('caps response size and marks payload as truncated when logs are oversized', async () => {
    getRecentLogsMock.mockReturnValue(
      Array.from({ length: 7000 }, (_, index) => ({
        level: 30,
        msg: `entry-${index}-${'x'.repeat(900)}`,
      })),
    );

    const req = createMockReq({
      authorization: 'Bearer token-c',
      'x-rebel-surface': 'mobile',
      'x-rebel-client-id': 'client-3',
    });
    const res = createMockRes();

    await handleDiagnosticsSelf(req, res, {
      listSessions: () => [],
    });

    expect(res._status).toBe(200);
    expect(Buffer.byteLength(res._body, 'utf8')).toBeLessThanOrEqual(5 * 1024 * 1024);
    const payload = JSON.parse(res._body);
    expect(payload.manifest.truncated).toBeDefined();
    expect(payload.logs.truncated).toBe(true);
  });

  it('parses include query into closed diagnostic section toggles', async () => {
    const recentEvents: DiagnosticEventEntry[] = [
      {
        v: 1,
        ts: 1_700_000_000_000,
        surface: 'cloud',
        kind: 'provider_reachability_change',
        data: { provider: 'anthropic', status: 'reachable' },
      },
      {
        v: 1,
        ts: 1_700_000_000_001,
        surface: 'cloud',
        kind: 'health_check_timing',
        data: { checkIdHash: 'abc123', status: 'warn', durationBucketMs: 1000 },
      },
      {
        v: 1,
        ts: 1_700_000_000_002,
        surface: 'cloud',
        kind: 'settings_drift_observation',
        data: {
          field: 'active_provider',
          surfaceA: 'cloud',
          surfaceB: 'desktop',
          diffKind: 'a_b_differ_enum',
        },
      },
    ];
    setDiagnosticEventsLedgerReader({
      readRecent: vi.fn(async () => recentEvents),
    });
    const req = createMockReq({
      authorization: 'Bearer token-include',
      'x-rebel-surface': 'mobile',
      'x-rebel-client-id': 'client-include',
    });
    req.url = '/api/diagnostics/self?include=provider_reachability,health_timing,not_real';
    const res = createMockRes();

    await handleDiagnosticsSelf(req, res, {
      listSessions: () => [],
    });

    expect(res._status).toBe(200);
    const payload = JSON.parse(res._body);
    expect(payload.manifest.sections.provider_reachability).toBe('unavailable');
    expect(payload.manifest.sections.health_timing).toBe('included');
    expect(payload.manifest.sections.settings_drift).toBe('omitted_by_user_toggle');
    expect(payload.manifest.sections.pre_turn_worker).toBe('omitted_by_user_toggle');
    expect(payload.recentEvents).toHaveLength(1);
    expect(payload.recentEvents[0].kind).toBe('health_check_timing');
  });
});
