import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@shared/types';
import type { CloudServiceDeps } from '../bootstrap';
import {
  processSessionPut,
  resetCloudSessionMergeServiceForTests,
  type CloudSessionMergeDeps,
} from '@core/services/cloudSessionMergeService';
import { clearServerClockSession } from '@core/services/continuity/serverClock';
import { handleSessions } from '../routes/sessions';

const FIXED_NOW = 1_700_000_000_000;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeSession(): AgentSession {
  return {
    id: 'session-1',
    title: 'CLI title',
    createdAt: FIXED_NOW - 1_000,
    updatedAt: FIXED_NOW - 500,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    origin: 'manual',
  };
}

function createInMemoryDeps() {
  let persisted: AgentSession | null = null;

  const mergeDeps: CloudSessionMergeDeps = {
    getSession: vi.fn(async () => (persisted ? clone(persisted) : null)),
    upsertSession: vi.fn(async (session: AgentSession) => {
      persisted = clone(session);
    }),
    deleteSession: vi.fn(async () => {
      persisted = null;
    }),
    listSessions: vi.fn(() => (persisted ? [clone(persisted)] : [])),
    readContinuityStateMap: vi.fn(async () => null),
  };

  const routeDeps: CloudServiceDeps = {
    ...mergeDeps,
    loadSessions: vi.fn(async () => (persisted ? [clone(persisted)] : [])),
  } as unknown as CloudServiceDeps;

  return {
    mergeDeps,
    routeDeps,
    getPersisted: () => (persisted ? clone(persisted) : null),
  };
}

function createPutReq(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = 'PUT';
  req.url = url;
  req.headers = { host: 'localhost', ...headers };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function createRes(): { res: http.ServerResponse; statusCode: () => number } {
  let status = 200;
  const res = {
    writeHead: vi.fn((nextStatus: number) => { status = nextStatus; }),
    end: vi.fn(),
  } as unknown as http.ServerResponse;

  return {
    res,
    statusCode: () => status,
  };
}

describe('cli surface direct merge equivalence', () => {
  beforeEach(() => {
    resetCloudSessionMergeServiceForTests();
    clearServerClockSession('session-1');
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });

  it('produces byte-identical persisted state for direct merge and HTTPS route writes', async () => {
    const incoming = makeSession();

    const direct = createInMemoryDeps();
    await processSessionPut(direct.mergeDeps, {
      sessionId: incoming.id,
      incomingRaw: incoming as unknown as Record<string, unknown>,
      source: 'cli',
      surface: 'cli',
      sink: {
        emit: () => {},
        breadcrumb: () => {},
      },
    });
    const directPersisted = direct.getPersisted();

    resetCloudSessionMergeServiceForTests();
    clearServerClockSession('session-1');
    const routed = createInMemoryDeps();
    const req = createPutReq(
      '/api/sessions/session-1',
      incoming,
      { 'x-rebel-surface': 'cli' },
    );
    const { res, statusCode } = createRes();
    await handleSessions(req, res, ['api', 'sessions', 'session-1'], routed.routeDeps);

    expect(statusCode()).toBe(200);
    expect(routed.getPersisted()).toEqual(directPersisted);
  });
});
