import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setErrorReporter } from '@core/errorReporter';
import type { AgentEvent, AgentSession } from '@shared/types';
import {
  CATCH_UP_CONTINUATION_TOKEN_VERSION,
  CATCH_UP_HISTORY_MAX_ENTRIES,
  CATCH_UP_MAX_TOTAL_LIMIT,
  GC_GRACE_WINDOW_MS,
  _resetContinuityCatchUpHistoryForTests,
  decodeContinuationToken,
  encodeContinuationToken,
  getCatchUpHistoryForDevice,
  getStateFilePath,
  markSessionAsCloudActive,
  mergePreservingCloudActive,
  parseLimit,
  parseSessionIdsParam,
  parseSinceSeqParam,
  processCatchUp,
  processStateMapPut,
  readContinuityStateMap,
  recordCatchUpHistory,
  resetCloudContinuityStateServiceForTests,
  runStateMapGC,
  sanitizeContinuityStateMapInput,
  type CloudContinuityStateEffectSink,
} from '../cloudContinuityStateService';

const TEST_DATA_DIR = '/tmp/test-cloud-continuity-state-service';
const ALT_TEST_DATA_DIR = '/tmp/test-cloud-continuity-state-service-alt';
const breadcrumbs: Array<{ category: string; message: string; data?: Record<string, unknown> }> = [];

function stateFile(dir = TEST_DATA_DIR): string {
  return path.join(dir, 'cloud-continuity-state.json');
}

function makeSink(calls: string[] = []): CloudContinuityStateEffectSink {
  return {
    emit(event) {
      calls.push(`emit:${event.payload.sessionId}:${event.payload.action}`);
    },
  };
}

function makeStatusEvent(seq: number): AgentEvent {
  return {
    type: 'status',
    message: `event-${seq}`,
    timestamp: seq * 10,
    seq,
  };
}

function makeSession(id: string, turnEvents: Record<string, number[]>): AgentSession {
  const eventsByTurn: Record<string, AgentEvent[]> = {};
  let maxSeq = 0;

  for (const [turnId, seqs] of Object.entries(turnEvents)) {
    eventsByTurn[turnId] = seqs.map(makeStatusEvent);
    maxSeq = Math.max(maxSeq, Math.max(...seqs, 0));
  }

  return {
    id,
    title: `Session ${id}`,
    createdAt: 1,
    updatedAt: 1,
    cloudUpdatedAt: 1,
    messages: [],
    eventsByTurn,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    maxSeq,
  } as unknown as AgentSession;
}

beforeEach(async () => {
  process.env.REBEL_USER_DATA = TEST_DATA_DIR;
  breadcrumbs.length = 0;
  setErrorReporter({
    captureException: () => {},
    captureMessage: () => {},
    addBreadcrumb: (breadcrumb) => {
      breadcrumbs.push({
        category: breadcrumb.category,
        message: breadcrumb.message,
        data: breadcrumb.data,
      });
    },
  });
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  await fs.rm(ALT_TEST_DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_DATA_DIR, { recursive: true });
  resetCloudContinuityStateServiceForTests();
});

afterEach(async () => {
  setErrorReporter({
    captureException: () => {},
    captureMessage: () => {},
    addBreadcrumb: () => {},
  });
  vi.restoreAllMocks();
  resetCloudContinuityStateServiceForTests();
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  await fs.rm(ALT_TEST_DATA_DIR, { recursive: true, force: true });
  delete process.env.REBEL_USER_DATA;
});

describe('cloudContinuityStateService pure helpers', () => {
  it('computes the state-file path from REBEL_USER_DATA on every call', () => {
    process.env.REBEL_USER_DATA = TEST_DATA_DIR;
    expect(getStateFilePath()).toBe(stateFile(TEST_DATA_DIR));

    process.env.REBEL_USER_DATA = ALT_TEST_DATA_DIR;
    expect(getStateFilePath()).toBe(stateFile(ALT_TEST_DATA_DIR));
  });

  it('parses limits with default, max clamp, and invalid guards', () => {
    expect(parseLimit(null)).toBe(5_000);
    expect(parseLimit('10')).toBe(10);
    expect(parseLimit(String(CATCH_UP_MAX_TOTAL_LIMIT + 100))).toBe(CATCH_UP_MAX_TOTAL_LIMIT);
    expect(parseLimit('0')).toBeNull();
    expect(parseLimit('1.2')).toBeNull();
    expect(parseLimit('nope')).toBeNull();
  });

  it('parses numeric sinceSeq values', () => {
    expect(parseSinceSeqParam(null)).toEqual({ defaultSinceSeq: 0, perSession: {} });
    expect(parseSinceSeqParam('12')).toEqual({ defaultSinceSeq: 12, perSession: {} });
  });

  it('parses JSON sinceSeq maps', () => {
    expect(parseSinceSeqParam('{"s1":1,"s2":0}')).toEqual({
      defaultSinceSeq: 0,
      perSession: { s1: 1, s2: 0 },
    });
  });

  it('rejects invalid sinceSeq values', () => {
    expect(parseSinceSeqParam('-1')).toBeNull();
    expect(parseSinceSeqParam('1.5')).toBeNull();
    expect(parseSinceSeqParam('nope')).toBeNull();
    expect(parseSinceSeqParam('{"s1":-1}')).toBeNull();
  });

  it('parses sessionIds as a trimmed deduplicated list', () => {
    expect(parseSessionIdsParam(null)).toEqual([]);
    expect(parseSessionIdsParam(' s1, s2,s1,, ')).toEqual(['s1', 's2']);
  });

  it('encodes and decodes continuation tokens', () => {
    const payload = {
      v: CATCH_UP_CONTINUATION_TOKEN_VERSION,
      sessionIds: ['s1', 's2'],
      cursors: { s1: 10, s2: 0 },
    };

    expect(decodeContinuationToken(encodeContinuationToken(payload))).toEqual(payload);
  });

  it('rejects malformed or unsupported continuation tokens', () => {
    expect(decodeContinuationToken('not-base64')).toBeNull();
    const wrongVersion = Buffer.from(JSON.stringify({
      v: 99,
      sessionIds: ['s1'],
      cursors: { s1: 1 },
    }), 'utf8').toString('base64url');
    expect(decodeContinuationToken(wrongVersion)).toBeNull();
  });

  it('sanitizes continuity state-map input without retaining unsupported fields', () => {
    expect(sanitizeContinuityStateMapInput({
      'session-a': {
        state: 'cloud_active',
        lastCloudActivityAt: 123,
        cloudPinnedAt: 456,
        updatedAt: 9_999,
      },
      'session-b': {
        state: 'local_only',
        cloudRemovalIntent: {
          requestedAt: 789,
          requestedBy: 'user',
          source: 'desktop',
        },
      },
      'session-c': { state: 'bogus' },
      'session-d': null,
    })).toEqual({
      'session-a': { state: 'cloud_active', lastCloudActivityAt: 123, cloudPinnedAt: 456 },
      'session-b': {
        state: 'local_only',
        cloudRemovalIntent: {
          requestedAt: 789,
          requestedBy: 'user',
          source: 'desktop',
        },
      },
    });
  });

  it('drops malformed cloudRemovalIntent fields while preserving valid entry state', () => {
    expect(sanitizeContinuityStateMapInput({
      'bad-requested-at': {
        state: 'local_only',
        cloudRemovalIntent: { requestedAt: 'soon', requestedBy: 'user' },
      },
      'bad-requested-by': {
        state: 'local_only',
        cloudRemovalIntent: { requestedAt: 100, requestedBy: 'system' },
      },
      'bad-source-only': {
        state: 'local_only',
        cloudRemovalIntent: { requestedAt: 200, requestedBy: 'retention-policy', source: 'desktop-app' },
      },
      'coherence-guard': {
        state: 'cloud_active',
        cloudRemovalIntent: { requestedAt: 300, requestedBy: 'user' },
      },
    } as unknown as Record<string, unknown>)).toEqual({
      'bad-requested-at': { state: 'local_only' },
      'bad-requested-by': { state: 'local_only' },
      'bad-source-only': {
        state: 'local_only',
        cloudRemovalIntent: { requestedAt: 200, requestedBy: 'retention-policy' },
      },
      'coherence-guard': { state: 'cloud_active' },
    });
    expect(
      breadcrumbs.some((breadcrumb) => (
        breadcrumb.category === 'continuity.sanitizer'
        && breadcrumb.data?.reason === 'cloud-active-with-removal-intent'
      )),
    ).toBe(true);
  });

  it('preserves cloud_active entries missing from the incoming desktop map', () => {
    const existing = {
      'mobile-session-1': { state: 'cloud_active' as const },
      'mobile-session-2': { state: 'cloud_active' as const },
    };
    const desktopMap = {
      'desktop-session-1': { state: 'cloud_active' as const },
      'desktop-session-2': { state: 'local_only' as const },
    };

    const { merged, preserved, refused } = mergePreservingCloudActive(desktopMap, existing);

    expect(merged['mobile-session-1']?.state).toBe('cloud_active');
    expect(merged['mobile-session-2']?.state).toBe('cloud_active');
    expect(merged['desktop-session-1']?.state).toBe('cloud_active');
    expect(merged['desktop-session-2']?.state).toBe('local_only');
    expect(preserved).toBe(2);
    expect(refused).toBe(0);
  });

  it('does not preserve local_only entries from the existing map', () => {
    const existing = {
      'old-local': { state: 'local_only' as const },
      'old-active': { state: 'cloud_active' as const },
    };

    const { merged, preserved, refused } = mergePreservingCloudActive({ 'desktop-1': { state: 'cloud_active' as const } }, existing);

    expect(merged['old-active']?.state).toBe('cloud_active');
    expect(merged['old-local']).toBeUndefined();
    expect(merged['desktop-1']?.state).toBe('cloud_active');
    expect(preserved).toBe(1);
    expect(refused).toBe(0);
  });

  it('refuses incoming local_only demotion of an existing cloud_active when no user removal intent is present', () => {
    const { merged, preserved, refused } = mergePreservingCloudActive(
      { 'shared-session': { state: 'local_only' as const } },
      { 'shared-session': { state: 'cloud_active' as const, lastCloudActivityAt: 1000 } },
    );

    expect(merged['shared-session']?.state).toBe('cloud_active');
    expect(preserved).toBe(0);
    expect(refused).toBe(1);
    expect(
      breadcrumbs.some((breadcrumb) => (
        breadcrumb.category === 'continuity.merge-guard'
        && breadcrumb.data?.refusal === 'no-intent'
      )),
    ).toBe(true);
  });

  it('accepts cloud_active demotion when incoming entry carries user removal intent', () => {
    const { merged, refused } = mergePreservingCloudActive(
      {
        'shared-session': {
          state: 'local_only',
          cloudRemovalIntent: {
            requestedAt: 1_000,
            requestedBy: 'user',
          },
        },
      },
      { 'shared-session': { state: 'cloud_active', lastCloudActivityAt: 1000 } },
    );

    expect(merged['shared-session']?.state).toBe('local_only');
    expect(merged['shared-session']?.cloudRemovalIntent?.requestedBy).toBe('user');
    expect(refused).toBe(0);
  });

  it('accepts cloud_active demotion when incoming entry carries retention-policy intent', () => {
    const { merged, refused } = mergePreservingCloudActive(
      {
        'shared-session': {
          state: 'local_only',
          cloudRemovalIntent: {
            requestedAt: 1_000,
            requestedBy: 'retention-policy',
          },
        },
      },
      { 'shared-session': { state: 'cloud_active', lastCloudActivityAt: 1000 } },
    );

    expect(merged['shared-session']?.state).toBe('local_only');
    expect(merged['shared-session']?.cloudRemovalIntent?.requestedBy).toBe('retention-policy');
    expect(refused).toBe(0);
  });

  it('preserves existing cloudRemovalIntent for local_only -> local_only merges when incoming omits intent', () => {
    const { merged, refused } = mergePreservingCloudActive(
      {
        session: {
          state: 'local_only',
        },
      },
      {
        session: {
          state: 'local_only',
          cloudRemovalIntent: {
            requestedAt: 1_000,
            requestedBy: 'user',
          },
        },
      },
    );

    expect(merged['session']).toEqual({
      state: 'local_only',
      cloudRemovalIntent: {
        requestedAt: 1_000,
        requestedBy: 'user',
      },
    });
    expect(refused).toBe(0);
  });
});

describe('cloudContinuityStateService state-map file operations', () => {
  it('returns null when the state file does not exist', async () => {
    expect(await readContinuityStateMap()).toBeNull();
  });

  it('returns a parsed state map when the file exists', async () => {
    const stateMap = {
      's1': { state: 'cloud_active', lastCloudActivityAt: 1000 },
      's2': { state: 'local_only' },
    };
    await fs.writeFile(stateFile(), JSON.stringify(stateMap), 'utf-8');

    expect(await readContinuityStateMap()).toEqual(stateMap);
  });

  it('returns null on invalid JSON', async () => {
    await fs.writeFile(stateFile(), 'not-json', 'utf-8');

    expect(await readContinuityStateMap()).toBeNull();
  });

  it('marks a session as cloud_active', async () => {
    await markSessionAsCloudActive('mobile-session-1');

    expect(await readContinuityStateMap()).toMatchObject({
      'mobile-session-1': { state: 'cloud_active' },
    });
  });

  it('does not rewrite a session that is already cloud_active', async () => {
    await fs.writeFile(stateFile(), JSON.stringify({
      'mobile-session-1': { state: 'cloud_active', lastCloudActivityAt: 123 },
    }), 'utf-8');

    await markSessionAsCloudActive('mobile-session-1');

    expect(await readContinuityStateMap()).toEqual({
      'mobile-session-1': { state: 'cloud_active', lastCloudActivityAt: 123 },
    });
  });
});

describe('cloudContinuityStateService catch-up history', () => {
  it('caps catch-up history at the configured maximum', () => {
    for (let i = 0; i < CATCH_UP_HISTORY_MAX_ENTRIES + 2; i++) {
      recordCatchUpHistory('device', {
        requestedAt: i,
        durationMs: 1,
        sessionCount: 1,
        returnedEventCount: 1,
        limit: 10,
        usedContinuationToken: false,
        hasMore: false,
      });
    }

    const history = getCatchUpHistoryForDevice('device');
    expect(history).toHaveLength(CATCH_UP_HISTORY_MAX_ENTRIES);
    expect(history[0]?.requestedAt).toBe(2);
  });

  it('returns cloned catch-up history entries', () => {
    recordCatchUpHistory('device', {
      requestedAt: 1,
      durationMs: 1,
      sessionCount: 1,
      returnedEventCount: 1,
      limit: 10,
      usedContinuationToken: false,
      hasMore: false,
    });

    const history = getCatchUpHistoryForDevice('device');
    history[0]!.limit = 999;

    expect(getCatchUpHistoryForDevice('device')[0]?.limit).toBe(10);
  });
});

describe('cloudContinuityStateService processStateMapPut', () => {
  it('persists sanitized state while preserving cloud_active entries from disk', async () => {
    await fs.writeFile(stateFile(), JSON.stringify({
      'mobile-session': { state: 'cloud_active' },
      'old-local': { state: 'local_only' },
    }), 'utf-8');

    const outcome = await processStateMapPut({ listSessions: () => [], deleteSession: async () => {} }, {
      'desktop-session': { state: 'local_only' },
      'invalid-session': { state: 'bogus' },
    });

    expect(outcome.kind).toBe('persisted');
    if (outcome.kind !== 'persisted') throw new Error('unexpected outcome');
    expect(outcome.preserved).toBe(1);
    expect(outcome.refusedDemotions).toBe(0);
    expect(await readContinuityStateMap()).toEqual({
      'desktop-session': { state: 'local_only' },
      'mobile-session': { state: 'cloud_active' },
    });
  });

  it('returns invalid-state when the write fails', async () => {
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('disk full'));

    await expect(processStateMapPut({ listSessions: () => [], deleteSession: async () => {} }, {
      'desktop-session': { state: 'cloud_active' },
    })).resolves.toEqual({
      kind: 'invalid-state',
      reason: 'Failed to write continuity state map',
    });
  });
});

describe('cloudContinuityStateService runStateMapGC', () => {
  function userRemovalIntent(requestedAt = Date.now()) {
    return {
      requestedAt,
      requestedBy: 'user' as const,
    };
  }

  function retentionPolicyIntent(requestedAt = Date.now()) {
    return {
      requestedAt,
      requestedBy: 'retention-policy' as const,
    };
  }

  function makeDeps(sessions: Array<{ id: string; updatedAt?: number }>, calls: string[] = []) {
    const deletedIds: string[] = [];
    return {
      deps: {
        listSessions: () => sessions,
        deleteSession: async (id: string) => {
          calls.push(`delete:${id}`);
          deletedIds.push(id);
        },
      },
      deletedIds,
    };
  }

  it('deletes local_only sessions older than the grace window only when requestedBy=user', async () => {
    const oldTimestamp = Date.now() - GC_GRACE_WINDOW_MS - 60_000;
    const { deps, deletedIds } = makeDeps([
      { id: 's1', updatedAt: oldTimestamp },
      { id: 's2', updatedAt: oldTimestamp },
    ]);

    const result = await runStateMapGC({
      's1': { state: 'local_only', cloudRemovalIntent: userRemovalIntent(oldTimestamp) },
      's2': { state: 'cloud_active' },
    }, deps, makeSink());

    expect(result.kind).toBe('completed');
    expect(deletedIds).toEqual(['s1']);
    expect(result.deleted).toEqual(['s1']);
    expect(result.protected).toEqual([]);
    expect(result.gcDeleted).toBe(1);
    expect(result.gcProtectedNoIntent).toBe(0);
    expect(result.gcProtectedRetentionPolicy).toBe(0);
  });

  it('preserves cloud-native sessions with no state-map entry', async () => {
    const oldTimestamp = Date.now() - GC_GRACE_WINDOW_MS - 60_000;
    const { deps, deletedIds } = makeDeps([
      { id: 's1', updatedAt: oldTimestamp },
      { id: 's-cloud-native', updatedAt: oldTimestamp },
    ]);

    const result = await runStateMapGC({
      's1': { state: 'local_only', cloudRemovalIntent: userRemovalIntent(oldTimestamp) },
    }, deps, makeSink());

    expect(deletedIds).toEqual(['s1']);
    expect(result.deleted).toEqual(['s1']);
  });

  it('protects local_only sessions within the grace window', async () => {
    const recentTimestamp = Date.now() - (GC_GRACE_WINDOW_MS / 2);
    const { deps, deletedIds } = makeDeps([{ id: 's-recent', updatedAt: recentTimestamp }]);

    const result = await runStateMapGC({
      's-recent': { state: 'local_only', cloudRemovalIntent: userRemovalIntent(recentTimestamp) },
    }, deps, makeSink());

    expect(deletedIds).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.protected).toEqual([{ sessionId: 's-recent', reason: 'within-grace-window' }]);
  });

  it('preserves cloud_active sessions', async () => {
    const oldTimestamp = Date.now() - GC_GRACE_WINDOW_MS - 60_000;
    const { deps, deletedIds } = makeDeps([
      { id: 's1', updatedAt: oldTimestamp },
      { id: 's2', updatedAt: oldTimestamp },
    ]);

    const result = await runStateMapGC({
      's1': { state: 'cloud_active' },
      's2': { state: 'cloud_active' },
    }, deps, makeSink());

    expect(deletedIds).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.protected).toEqual([]);
  });

  it('handles mixed intent scenarios correctly', async () => {
    const now = Date.now();
    const old = now - GC_GRACE_WINDOW_MS - 60_000;
    const recent = now - 60_000;
    const { deps, deletedIds } = makeDeps([
      { id: 's-active', updatedAt: old },
      { id: 's-old-user', updatedAt: old },
      { id: 's-old-retention', updatedAt: old },
      { id: 's-old-no-intent', updatedAt: old },
      { id: 's-recent-user', updatedAt: recent },
      { id: 's-cloud-native', updatedAt: old },
    ]);

    const result = await runStateMapGC({
      's-active': { state: 'cloud_active' },
      's-old-user': { state: 'local_only', cloudRemovalIntent: userRemovalIntent(old) },
      's-old-retention': { state: 'local_only', cloudRemovalIntent: retentionPolicyIntent(old) },
      's-old-no-intent': { state: 'local_only' },
      's-recent-user': { state: 'local_only', cloudRemovalIntent: userRemovalIntent(recent) },
    }, deps, makeSink());

    expect(deletedIds).toEqual(['s-old-user']);
    expect(result.deleted).toEqual(['s-old-user']);
    expect(result.protected).toEqual(
      expect.arrayContaining([
        { sessionId: 's-old-retention', reason: 'retention-policy-visibility-only' },
        { sessionId: 's-old-no-intent', reason: 'no-removal-intent' },
        { sessionId: 's-recent-user', reason: 'within-grace-window' },
      ]),
    );
    expect(result.gcDeleted).toBe(1);
    expect(result.gcProtectedNoIntent).toBe(1);
    expect(result.gcProtectedRetentionPolicy).toBe(1);
  });

  it('handles empty session lists gracefully', async () => {
    const { deps, deletedIds } = makeDeps([]);

    const result = await runStateMapGC({
      's1': { state: 'local_only', cloudRemovalIntent: userRemovalIntent() },
    }, deps, makeSink());

    expect(deletedIds).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.protected).toEqual([]);
  });

  it('handles empty state maps gracefully', async () => {
    const old = Date.now() - GC_GRACE_WINDOW_MS - 60_000;
    const { deps, deletedIds } = makeDeps([
      { id: 's1', updatedAt: old },
      { id: 's2', updatedAt: old },
    ]);

    const result = await runStateMapGC({}, deps, makeSink());

    expect(deletedIds).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.protected).toEqual([]);
  });

  it('treats sessions with undefined updatedAt as old and eligible for GC', async () => {
    const { deps, deletedIds } = makeDeps([{ id: 's-no-ts' }]);

    const result = await runStateMapGC({
      's-no-ts': { state: 'local_only', cloudRemovalIntent: userRemovalIntent() },
    }, deps, makeSink());

    expect(deletedIds).toEqual(['s-no-ts']);
    expect(result.deleted).toEqual(['s-no-ts']);
  });

  it('continues GC when individual deletions fail', async () => {
    const old = Date.now() - GC_GRACE_WINDOW_MS - 60_000;
    const deletedIds: string[] = [];
    const deps = {
      listSessions: () => [
        { id: 's1', updatedAt: old },
        { id: 's2', updatedAt: old },
        { id: 's3', updatedAt: old },
      ],
      deleteSession: async (id: string) => {
        if (id === 's2') throw new Error('disk full');
        deletedIds.push(id);
      },
    };

    const result = await runStateMapGC({
      's1': { state: 'local_only', cloudRemovalIntent: userRemovalIntent(old) },
      's2': { state: 'local_only', cloudRemovalIntent: userRemovalIntent(old) },
      's3': { state: 'local_only', cloudRemovalIntent: userRemovalIntent(old) },
    }, deps, makeSink());

    expect(deletedIds).toEqual(['s1', 's3']);
    expect(result.deleted).toEqual(['s1', 's3']);
  });

  it('orders deletion before sink emit before appending to the deleted outcome array', async () => {
    const old = Date.now() - GC_GRACE_WINDOW_MS - 60_000;
    const calls: string[] = [];
    const { deps } = makeDeps([{ id: 's1', updatedAt: old }], calls);

    const result = await runStateMapGC({
      's1': { state: 'local_only', cloudRemovalIntent: userRemovalIntent(old) },
    }, deps, makeSink(calls));

    calls.push(`result:${result.deleted.join(',')}`);
    expect(calls).toEqual(['delete:s1', 'emit:s1:deleted', 'result:s1']);
  });

  it('keeps retention-policy demotions visibility-only while preserving the session file', async () => {
    const old = Date.now() - GC_GRACE_WINDOW_MS - 60_000;
    const deleteSession = vi.fn(async () => {});
    const result = await runStateMapGC(
      {
        'retention-only': {
          state: 'local_only',
          cloudRemovalIntent: retentionPolicyIntent(old),
        },
      },
      {
        listSessions: () => [{ id: 'retention-only', updatedAt: old }],
        deleteSession,
      },
      makeSink(),
    );

    expect(deleteSession).not.toHaveBeenCalled();
    expect(result.deleted).toEqual([]);
    expect(result.protected).toEqual([
      { sessionId: 'retention-only', reason: 'retention-policy-visibility-only' },
    ]);
    expect(result.gcProtectedRetentionPolicy).toBe(1);
  });

  it('deletes user-demoted sessions after grace when merge accepted user intent', async () => {
    const old = Date.now() - GC_GRACE_WINDOW_MS - 60_000;
    const mergeResult = mergePreservingCloudActive(
      {
        'explicit-user': {
          state: 'local_only',
          cloudRemovalIntent: userRemovalIntent(old),
        },
      },
      {
        'explicit-user': { state: 'cloud_active', lastCloudActivityAt: old },
      },
    );

    const deleteSession = vi.fn(async () => {});
    const result = await runStateMapGC(
      mergeResult.merged,
      {
        listSessions: () => [{ id: 'explicit-user', updatedAt: old }],
        deleteSession,
      },
      makeSink(),
    );

    expect(mergeResult.refused).toBe(0);
    expect(deleteSession).toHaveBeenCalledWith('explicit-user', { intent: 'hygiene' });
    expect(result.deleted).toEqual(['explicit-user']);
    expect(result.gcDeleted).toBe(1);
  });
});

describe('cloudContinuityStateService processCatchUp', () => {
  it('paginates across sessions with continuationToken', async () => {
    const sessions = new Map<string, AgentSession>([
      ['session-a', makeSession('session-a', { 'turn-a': [1, 2, 3] })],
      ['session-b', makeSession('session-b', { 'turn-b': [1, 2, 3, 4] })],
    ]);
    const deps = {
      listSessions: () => Array.from(sessions.values()).map((session) => ({ id: session.id })),
      getSession: async (id: string) => sessions.get(id) ?? null,
    };

    const first = await processCatchUp(deps, {
      deviceScopeKey: 'device',
      requestedAt: Date.now(),
      limitParam: '3',
      continuationTokenParam: null,
      sinceSeqParam: JSON.stringify({ 'session-a': 1, 'session-b': 1 }),
      sessionIdsParam: 'session-a,session-b',
    });

    expect(first.kind).toBe('success');
    if (first.kind !== 'success') throw new Error('unexpected outcome');
    expect(first.recordHistory).toBe(true);
    expect(first.response.sessions['session-a']).toMatchObject({
      events: [makeStatusEvent(2), makeStatusEvent(3)].map((e) => expect.objectContaining(e)),
      maxSeq: 3,
    });
    expect(first.response.sessions['session-b']).toMatchObject({
      events: [makeStatusEvent(2)].map((e) => expect.objectContaining(e)),
      maxSeq: 4,
    });
    expect(first.response.continuationToken).toEqual(expect.any(String));

    const second = await processCatchUp(deps, {
      deviceScopeKey: 'device',
      requestedAt: Date.now(),
      limitParam: '3',
      continuationTokenParam: first.response.continuationToken!,
      sinceSeqParam: null,
      sessionIdsParam: null,
    });

    expect(second.kind).toBe('success');
    if (second.kind !== 'success') throw new Error('unexpected outcome');
    expect(second.response.sessions['session-a']).toMatchObject({ events: [], maxSeq: 3 });
    expect(second.response.sessions['session-b']).toMatchObject({
      events: [makeStatusEvent(3), makeStatusEvent(4)].map((e) => expect.objectContaining(e)),
      maxSeq: 4,
    });
    expect(second.response.continuationToken).toBeUndefined();
    expect(getCatchUpHistoryForDevice('device')).toHaveLength(2);
  });

  it('pins the external wire field as maxSeq rather than serverSeq', async () => {
    const session = makeSession('session-a', { turn: [1, 2] });

    const outcome = await processCatchUp({
      listSessions: () => [{ id: 'session-a' }],
      getSession: async () => session,
    }, {
      deviceScopeKey: 'device',
      requestedAt: Date.now(),
      limitParam: '10',
      continuationTokenParam: null,
      sinceSeqParam: '0',
      sessionIdsParam: 'session-a',
    });

    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') throw new Error('unexpected outcome');
    expect(outcome.response.sessions['session-a']).toMatchObject({
      events: [makeStatusEvent(1), makeStatusEvent(2)].map((e) => expect.objectContaining(e)),
      maxSeq: 2,
    });
    expect(outcome.response.sessions['session-a']).not.toHaveProperty('serverSeq');
  });

  it('uses all listed sessions when sessionIds is absent', async () => {
    const sessions = new Map<string, AgentSession>([
      ['session-a', makeSession('session-a', { turn: [1] })],
      ['session-b', makeSession('session-b', { turn: [1] })],
    ]);

    const outcome = await processCatchUp({
      listSessions: () => [{ id: 'session-a' }, { id: 'session-b' }, { id: 'session-a' }],
      getSession: async (id: string) => sessions.get(id) ?? null,
    }, {
      deviceScopeKey: 'device',
      requestedAt: Date.now(),
      limitParam: null,
      continuationTokenParam: null,
      sinceSeqParam: null,
      sessionIdsParam: null,
    });

    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') throw new Error('unexpected outcome');
    expect(Object.keys(outcome.response.sessions)).toEqual(['session-a', 'session-b']);
  });

  it('does not record history for invalid input', async () => {
    const outcome = await processCatchUp({
      listSessions: () => [],
      getSession: async () => null,
    }, {
      deviceScopeKey: 'device',
      requestedAt: Date.now(),
      limitParam: '0',
      continuationTokenParam: null,
      sinceSeqParam: null,
      sessionIdsParam: null,
    });

    expect(outcome).toEqual({
      kind: 'invalid-request',
      message: `limit must be a positive integer (max ${CATCH_UP_MAX_TOTAL_LIMIT})`,
    });
    expect(getCatchUpHistoryForDevice('device')).toEqual([]);
  });

  it('does not record history for the empty-session early return', async () => {
    const outcome = await processCatchUp({
      listSessions: () => [],
      getSession: async () => null,
    }, {
      deviceScopeKey: 'device',
      requestedAt: Date.now(),
      limitParam: null,
      continuationTokenParam: null,
      sinceSeqParam: null,
      sessionIdsParam: null,
    });

    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') throw new Error('unexpected outcome');
    expect(outcome.recordHistory).toBe(false);
    expect(outcome.response.sessions).toEqual({});
    expect(getCatchUpHistoryForDevice('device')).toEqual([]);
  });

  it('records exactly one history entry on the success path', async () => {
    const outcome = await processCatchUp({
      listSessions: () => [{ id: 'session-a' }],
      getSession: async () => makeSession('session-a', { turn: [1] }),
    }, {
      deviceScopeKey: 'device',
      requestedAt: Date.now(),
      limitParam: '10',
      continuationTokenParam: null,
      sinceSeqParam: null,
      sessionIdsParam: 'session-a',
    });

    expect(outcome.kind).toBe('success');
    expect(getCatchUpHistoryForDevice('device')).toHaveLength(1);
    expect(getCatchUpHistoryForDevice('device')[0]).toEqual(expect.objectContaining({
      sessionCount: 1,
      returnedEventCount: 1,
      usedContinuationToken: false,
      hasMore: false,
    }));
  });

  it('rejects invalid continuation tokens without recording history', async () => {
    const outcome = await processCatchUp({
      listSessions: () => [{ id: 'session-a' }],
      getSession: async () => null,
    }, {
      deviceScopeKey: 'device',
      requestedAt: Date.now(),
      limitParam: null,
      continuationTokenParam: 'not-a-token',
      sinceSeqParam: null,
      sessionIdsParam: null,
    });

    expect(outcome).toEqual({ kind: 'invalid-request', message: 'continuationToken is invalid' });
    expect(getCatchUpHistoryForDevice('device')).toEqual([]);
  });
});
