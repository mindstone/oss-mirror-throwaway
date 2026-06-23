import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
const getRecentDiagnosticContextMock = vi.hoisted(() => vi.fn());
const getProviderReachabilitySnapshotMock = vi.hoisted(() => vi.fn());
const refreshProviderReachabilityCacheMock = vi.hoisted(() => vi.fn());
const captureKnownConditionMock = vi.hoisted(() => vi.fn());

 
vi.mock('../utils/registerHandler', () => ({
  registerHandler: (channel: string, fn: (...args: any[]) => any) => {
    handlers.set(channel, fn);
  },
}));

 
vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: captureKnownConditionMock,
}));

 
vi.mock('@core/services/diagnostics/recentDiagnosticContext', async () => {
  const actual = await vi.importActual<typeof import('@core/services/diagnostics/recentDiagnosticContext')>(
    '@core/services/diagnostics/recentDiagnosticContext',
  );
  return {
    ...actual,
    getRecentDiagnosticContext: getRecentDiagnosticContextMock,
  };
});

 
vi.mock('@core/services/diagnostics/providerReachabilitySnapshot', () => ({
  getProviderReachabilitySnapshot: getProviderReachabilitySnapshotMock,
  refreshProviderReachabilityCache: refreshProviderReachabilityCacheMock,
}));

import { registerDiagnosticsHandlers } from '../diagnosticsHandlers';

describe('diagnosticsHandlers', () => {
  beforeEach(() => {
    handlers.clear();
    getRecentDiagnosticContextMock.mockReset();
    getProviderReachabilitySnapshotMock.mockReset();
    refreshProviderReachabilityCacheMock.mockReset();
    captureKnownConditionMock.mockReset();
    registerDiagnosticsHandlers();
  });

  it('registers diagnostics:get-recent-context channel', () => {
    expect(handlers.has('diagnostics:get-recent-context')).toBe(true);
  });

  it('registers provider reachability channels', () => {
    expect(handlers.has('diagnostics:get-provider-reachability-snapshot')).toBe(true);
    expect(handlers.has('diagnostics:refresh-provider-reachability-cache')).toBe(true);
  });

  it('forwards parsed request to getRecentDiagnosticContext', async () => {
    const expected = {
      windowHours: 24,
      limit: 5,
      nowMs: 1_700_000_000_000,
      counts: null,
      lastTimes: null,
      entriesByKind: {},
      totalEvents: 0,
      readerAvailable: true,
    };
    getRecentDiagnosticContextMock.mockResolvedValue(expected);

    const handler = handlers.get('diagnostics:get-recent-context')!;
    const result = await handler(null, { limit: 5, windowHours: 24 });

    expect(result).toBe(expected);
    expect(getRecentDiagnosticContextMock).toHaveBeenCalledWith({ limit: 5, windowHours: 24 });
  });

  it('parses an empty/undefined request via .default({})', async () => {
    getRecentDiagnosticContextMock.mockResolvedValue({
      windowHours: 24,
      limit: 5,
      nowMs: 0,
      counts: null,
      lastTimes: null,
      entriesByKind: {},
      totalEvents: 0,
      readerAvailable: false,
    });

    const handler = handlers.get('diagnostics:get-recent-context')!;
    await handler(null, undefined);

    expect(getRecentDiagnosticContextMock).toHaveBeenCalledWith({});
  });

  it('returns empty shape with readerAvailable=false on defensive catch and emits known-condition', async () => {
    getRecentDiagnosticContextMock.mockRejectedValue(new Error('contract violated'));

    const handler = handlers.get('diagnostics:get-recent-context')!;
    const result = await handler(null, { limit: 7, windowHours: 12 });

    expect(result).toMatchObject({
      windowHours: 12,
      limit: 7,
      counts: null,
      lastTimes: null,
      entriesByKind: {},
      totalEvents: 0,
      readerAvailable: false,
    });
    expect(captureKnownConditionMock).toHaveBeenCalledWith(
      'bridge_recent_events_failure',
      { phase: 'ipc_handler_catch' },
      expect.any(Error),
    );
  });

  it('returns empty shape (never throws) when request is malformed and emits known-condition', async () => {
    const handler = handlers.get('diagnostics:get-recent-context')!;
    const result = await handler(null, { limit: 999 });

    expect(result).toMatchObject({
      windowHours: 24,
      limit: 5,
      counts: null,
      lastTimes: null,
      entriesByKind: {},
      totalEvents: 0,
      readerAvailable: false,
    });
    expect(captureKnownConditionMock).toHaveBeenCalledWith(
      'bridge_recent_events_failure',
      { phase: 'ipc_request_parse' },
      expect.any(Error),
    );
    expect(getRecentDiagnosticContextMock).not.toHaveBeenCalled();
  });

  it('returns empty shape (never throws) when request is wholly invalid (string instead of object)', async () => {
    const handler = handlers.get('diagnostics:get-recent-context')!;
    const result = await handler(null, 'not-an-object');

    expect(result).toMatchObject({
      readerAvailable: false,
      totalEvents: 0,
    });
    expect(captureKnownConditionMock).toHaveBeenCalledTimes(1);
  });

  it('reads provider reachability snapshot without refreshing', async () => {
    const snapshot = { snapshotPresent: false, lastRefreshAt: null, providers: {} };
    getProviderReachabilitySnapshotMock.mockReturnValue(snapshot);

    const handler = handlers.get('diagnostics:get-provider-reachability-snapshot')!;
    const result = await handler(null, undefined);

    expect(result).toBe(snapshot);
    expect(getProviderReachabilitySnapshotMock).toHaveBeenCalledTimes(1);
    expect(refreshProviderReachabilityCacheMock).not.toHaveBeenCalled();
  });

  it('refreshes provider reachability on explicit refresh channel', async () => {
    const snapshot = { snapshotPresent: true, lastRefreshAt: 1, providers: {} };
    refreshProviderReachabilityCacheMock.mockResolvedValue(snapshot);

    const handler = handlers.get('diagnostics:refresh-provider-reachability-cache')!;
    const result = await handler(null, undefined);

    expect(result).toBe(snapshot);
    expect(refreshProviderReachabilityCacheMock).toHaveBeenCalledTimes(1);
  });

});
