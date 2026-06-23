import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_SESSION_METADATA_PATCH_KEYS,
  type AgentSession,
  type AgentSessionMetadataPatch,
} from '@shared/types';
import type { CloudServiceDeps } from '../bootstrap';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { handleSessions, _resetSessionsRouteTombstoneStateForTests } from '../routes/sessions';
import { resetServerClockForTests } from '@core/services/continuity/serverClock';
import { resetSessionSeqIndexForTests } from '@core/services/continuity/sessionSeqIndex';
import { getSessionTombstoneStore, resetSessionTombstoneStoreForTests } from '@core/services/continuity/sessionTombstoneStore';

function createReq(body: unknown): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = 'PATCH';
  req.url = '/api/sessions/session-1';
  req.headers = { host: 'localhost', 'x-rebel-surface': 'mobile' };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function createRes(): { res: http.ServerResponse; statusCode: () => number; body: <T = unknown>() => T } {
  let status = 200;
  let text = '';
  const res = {
    writeHead: vi.fn((nextStatus: number) => { status = nextStatus; }),
    end: vi.fn((body?: string) => { text = body ?? ''; }),
  } as unknown as http.ServerResponse;
  return { res, statusCode: () => status, body: <T = unknown>() => JSON.parse(text) as T };
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1',
    title: 'Original',
    createdAt: 1,
    updatedAt: 1,
    cloudUpdatedAt: 1_000,
    messages: [],
    eventsByTurn: {},
    maxSeq: 0,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  } as AgentSession;
}

function makeDeps(initial: AgentSession | null): CloudServiceDeps & { current: () => AgentSession | null } {
  let current = initial;
  return {
    getSession: vi.fn(async () => current),
    upsertSession: vi.fn(async (session: AgentSession) => { current = session; }),
    deleteSession: vi.fn(async () => {}),
    getActiveTurnController: vi.fn(() => undefined),
    listSessions: vi.fn(() => current ? [current] : []),
    loadSessions: vi.fn(async () => current ? [current] : []),
    current: () => current,
  } as unknown as CloudServiceDeps & { current: () => AgentSession | null };
}

async function patchSession(deps: CloudServiceDeps, body: unknown) {
  const response = createRes();
  await handleSessions(createReq(body), response.res, ['api', 'sessions', 'session-1'], deps);
  return response;
}

const broadcastSpy = vi.spyOn(cloudEventBroadcaster, 'broadcast');

beforeEach(() => {
  broadcastSpy.mockClear();
  resetServerClockForTests();
  resetSessionSeqIndexForTests();
  resetSessionTombstoneStoreForTests();
  _resetSessionsRouteTombstoneStateForTests();
});

afterEach(() => {
  resetServerClockForTests();
  resetSessionSeqIndexForTests();
  resetSessionTombstoneStoreForTests();
  _resetSessionsRouteTombstoneStateForTests();
});

describe('PATCH /api/sessions/:id', () => {
  it('persists allow-listed metadata fields and broadcasts a session change only', async () => {
    const deps = makeDeps(makeSession());
    const response = await patchSession(deps, {
      baseSeq: 0,
      clientCloudUpdatedAt: 1_000,
      patch: { title: 'Renamed', doneAt: 2, starredAt: null, privateMode: true, resolvedAt: null },
    });

    expect(response.statusCode()).toBe(200);
    expect(response.body()).toMatchObject({ success: true, cloudUpdatedAt: expect.any(Number) });
    expect(deps.current()).toMatchObject({ title: 'Renamed', doneAt: 2, starredAt: null, privateMode: true });
    expect(broadcastSpy).toHaveBeenCalledWith('cloud:session-changed', { sessionId: 'session-1', action: 'upserted' });
    expect(broadcastSpy).not.toHaveBeenCalledWith('cloud:session-event', expect.anything());
  });

  it('rejects non-allow-listed patch keys', async () => {
    const deps = makeDeps(makeSession());
    const response = await patchSession(deps, {
      baseSeq: 0,
      clientCloudUpdatedAt: 1_000,
      patch: { lastError: 'nope' },
    });

    expect(response.statusCode()).toBe(400);
    expect(deps.current()?.lastError).toBeNull();
  });

  it('requires baseSeq and clientCloudUpdatedAt', async () => {
    expect((await patchSession(makeDeps(makeSession()), { clientCloudUpdatedAt: 1_000, patch: { title: 'x' } })).statusCode()).toBe(400);
    expect((await patchSession(makeDeps(makeSession()), { baseSeq: 0, patch: { title: 'x' } })).statusCode()).toBe(400);
  });

  it('returns NEEDS_RECONCILE on stale baseSeq', async () => {
    const deps = makeDeps(makeSession({ maxSeq: 3, eventsByTurn: { 'turn-1': [{ type: 'status', message: 'x', timestamp: 1, seq: 3 }] } }));
    const response = await patchSession(deps, { baseSeq: 2, clientCloudUpdatedAt: 1_000, patch: { title: 'Stale' } });

    expect(response.statusCode()).toBe(409);
    expect(response.body()).toMatchObject({ error: 'NEEDS_RECONCILE', serverSeq: 3 });
    expect(deps.current()?.title).toBe('Original');
  });

  it('returns NEEDS_RECONCILE on stale clientCloudUpdatedAt', async () => {
    const deps = makeDeps(makeSession({ cloudUpdatedAt: 2_000 }));
    const response = await patchSession(deps, { baseSeq: 0, clientCloudUpdatedAt: 1_000, patch: { title: 'Stale' } });

    expect(response.statusCode()).toBe(409);
    expect(response.body()).toMatchObject({ error: 'NEEDS_RECONCILE', cloudUpdatedAt: 2_000 });
  });

  it('clears auto-title invariants for non-desktop title patches', async () => {
    const deps = makeDeps(makeSession({ autoTitleGeneratedAt: 10, autoTitleTurnCount: 2 }));
    const response = await patchSession(deps, { baseSeq: 0, clientCloudUpdatedAt: 1_000, patch: { title: 'Manual' } });

    expect(response.statusCode()).toBe(200);
    expect(deps.current()?.autoTitleGeneratedAt).toBeUndefined();
    expect(deps.current()?.autoTitleTurnCount).toBeUndefined();
  });

  it('returns 410 for tombstoned sessions', async () => {
    getSessionTombstoneStore().addTombstone('session-1', 'desktop');
    const response = await patchSession(makeDeps(makeSession()), { baseSeq: 0, clientCloudUpdatedAt: 1_000, patch: { title: 'Nope' } });

    expect(response.statusCode()).toBe(410);
    expect(response.body()).toMatchObject({ error: 'session-tombstoned' });
  });

  it('exhaustively accepts every metadata patch key from the runtime allowlist', async () => {
    for (const key of AGENT_SESSION_METADATA_PATCH_KEYS) {
      const deps = makeDeps(makeSession());
      const valueByKey: Record<keyof AgentSessionMetadataPatch, unknown> = {
        title: 'Allowed title',
        doneAt: 456, // canonical lifecycle field
        starredAt: null,
        deletedAt: null,
        privateMode: true,
        draft: null,
        resolvedAt: null,
        finishLine: 'criterion',
      };
      const response = await patchSession(deps, {
        baseSeq: 0,
        clientCloudUpdatedAt: 1_000,
        patch: { [key]: valueByKey[key] },
      });
      expect(response.statusCode(), key).toBe(200);
    }
  });

  describe('finishLine normalisation', () => {
    it('trims whitespace and persists the normalised value', async () => {
      const deps = makeDeps(makeSession());
      const response = await patchSession(deps, {
        baseSeq: 0,
        clientCloudUpdatedAt: 1_000,
        patch: { finishLine: '   crit with edges   ' },
      });

      expect(response.statusCode()).toBe(200);
      expect(deps.current()?.finishLine).toBe('crit with edges');
    });

    it('clears finishLine when the patch supplies whitespace-only', async () => {
      const deps = makeDeps(makeSession({ finishLine: 'old' }));
      const response = await patchSession(deps, {
        baseSeq: 0,
        clientCloudUpdatedAt: 1_000,
        patch: { finishLine: '   ' },
      });

      expect(response.statusCode()).toBe(200);
      expect(deps.current()?.finishLine).toBeUndefined();
    });

    it('truncates an overlong finishLine at the cap', async () => {
      const deps = makeDeps(makeSession());
      const oversized = 'x'.repeat(600);
      const response = await patchSession(deps, {
        baseSeq: 0,
        clientCloudUpdatedAt: 1_000,
        patch: { finishLine: oversized },
      });

      expect(response.statusCode()).toBe(200);
      expect(deps.current()?.finishLine).toHaveLength(500);
    });
  });

  it.each(['lastError', 'messages', 'eventsByTurn', 'maxSeq', 'id', 'cloudUpdatedAt', 'updatedAt'])(
    'does not allow forbidden key %s',
    async (key) => {
      const response = await patchSession(makeDeps(makeSession()), {
        baseSeq: 0,
        clientCloudUpdatedAt: 1_000,
        patch: { [key]: 'forbidden' },
      });

      expect(response.statusCode()).toBe(400);
    },
  );
});
