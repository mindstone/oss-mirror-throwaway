import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CloudE2eSeedOps, CloudServiceDeps } from '../../bootstrap';
import type { AgentSession, AgentSessionSummary } from '@shared/types';
import type { IncrementalSessionStore } from '@core/services/incrementalSessionStore';
import {
  assertE2eAuthorized,
  handleE2eFixtures,
  isE2eTestModeEnabled,
} from '../e2eFixtures';
import { markSessionAsCloudActive } from '@core/services/cloudContinuityStateService';
import { cloudEventBroadcaster } from '../../cloudEventBroadcaster';

vi.mock('@core/services/cloudContinuityStateService', () => ({
  markSessionAsCloudActive: vi.fn(async () => undefined),
}));

vi.mock('../../cloudEventBroadcaster', () => ({
  cloudEventBroadcaster: {
    broadcast: vi.fn(),
  },
}));

interface MockRes {
  _status: number;
  _body: string;
  _headers: Record<string, string>;
  statusCode: number;
  setHeader(key: string, value: string): void;
  getHeader(key: string): string | undefined;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

const ENV_KEYS = [
  'REBEL_E2E_TEST_MODE',
  'REBEL_E2E_TOKEN',
  'REBEL_CLOUD_TOKEN',
  'NODE_ENV',
  'FLY_APP_NAME',
  'FLY_MACHINE_ID',
  'FLY_IMAGE_REF',
  'REBEL_USER_DATA',
] as const;

function createMockReq(
  options: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = options.method ?? 'GET';
  req.url = options.url ?? '/__e2e/health';
  req.headers = {
    host: 'cloud.local',
    ...options.headers,
  };

  if (options.body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify(options.body), 'utf-8'));
      req.emit('end');
    });
  }

  return req;
}

function createMockRes(): http.ServerResponse & MockRes {
  const res: MockRes = {
    _status: 0,
    _body: '',
    _headers: {},
    statusCode: 0,
    setHeader(key: string, value: string) {
      this._headers[key] = value;
    },
    getHeader(key: string) {
      return this._headers[key];
    },
    writeHead(status: number, headers?: Record<string, string>) {
      this._status = status;
      this.statusCode = status;
      if (headers) Object.assign(this._headers, headers);
    },
    end(body?: string) {
      if (body) this._body = body;
    },
  };
  return res as unknown as http.ServerResponse & MockRes;
}

function createSeedOps(overrides: Partial<CloudE2eSeedOps> = {}): CloudE2eSeedOps {
  return {
    seedToolApproval: vi.fn(async () => ({ toolUseID: 'e2e-tool-approval-1', sessionId: 'e2e-session' })),
    seedStagedFileConflict: vi.fn(async () => ({
      sessionId: 'e2e-staged-conflict-session',
      destinationPath: 'E2E/staged-conflict.md',
    })),
    resetSafetyFixtures: vi.fn(async () => ({
      clearedToolApprovals: 0,
      clearedMemoryApprovals: 0,
      clearedStagedFiles: 0,
    })),
    ...overrides,
  };
}

function createDeps(sessions: AgentSessionSummary[] = [], e2eSeed?: CloudE2eSeedOps): CloudServiceDeps {
  return {
    listSessions: vi.fn(() => sessions),
    deleteSession: vi.fn(async () => undefined),
    upsertSession: vi.fn(async () => undefined),
    getSession: vi.fn(async () => null),
    // Stage 3 test-reset seam (see resetSessions): clears the store's
    // hard-delete ledger so reseeding previously-deleted ids is not dropped.
    clearHardDeleteLedgerForTestReset: vi.fn(),
    ...(e2eSeed ? { e2eSeed } : {}),
  } as unknown as CloudServiceDeps;
}

function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('e2e fixture route gates', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.REBEL_USER_DATA = path.join(os.tmpdir(), 'rebel-e2e-fixtures-test-data');
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('keeps e2e test mode disabled when the flag is unset', () => {
    expect(isE2eTestModeEnabled()).toBe(false);
  });

  it('keeps e2e test mode disabled in production', () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    process.env.NODE_ENV = 'production';

    expect(isE2eTestModeEnabled()).toBe(false);
  });

  it('keeps e2e test mode disabled when Fly markers are present', () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    process.env.FLY_APP_NAME = 'rebel-cloud';

    expect(isE2eTestModeEnabled()).toBe(false);
  });

  it('authorizes the correct explicit e2e bearer token in dev', () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    process.env.REBEL_E2E_TOKEN = 'fixture-token';

    const req = createMockReq({ headers: authHeader('fixture-token') });

    expect(assertE2eAuthorized(req)).toBe(true);
  });

  it('rejects missing or wrong bearer tokens', () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    process.env.REBEL_E2E_TOKEN = 'fixture-token';

    expect(assertE2eAuthorized(createMockReq())).toBe(false);
    expect(assertE2eAuthorized(createMockReq({ headers: authHeader('wrong-token') }))).toBe(false);
  });

  it('fails closed when no e2e or cloud token is configured', () => {
    process.env.REBEL_E2E_TEST_MODE = '1';

    expect(assertE2eAuthorized(createMockReq({ headers: authHeader('anything') }))).toBe(false);
  });

  it('falls back to REBEL_CLOUD_TOKEN when REBEL_E2E_TOKEN is unset', () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    process.env.REBEL_CLOUD_TOKEN = 'cloud-token';

    expect(assertE2eAuthorized(createMockReq({ headers: authHeader('cloud-token') }))).toBe(true);
  });

  it('handler fails closed (404, no mutation) when test mode is disabled — defense in depth', async () => {
    // Flag unset: even a correct token + valid route must not mutate. Guards
    // against a future caller mounting the handler without the server.ts precheck.
    process.env.REBEL_CLOUD_TOKEN = 'cloud-token';
    const req = createMockReq({ method: 'POST', headers: authHeader('cloud-token') });
    const res = createMockRes();
    const deps = createDeps([{ id: 's1' } as never]);

    await handleE2eFixtures(req, res, ['__e2e', 'reset'], deps);

    expect(res._status).toBe(404);
    expect(deps.deleteSession).not.toHaveBeenCalled();
  });

  it('handler fails closed before mutation when test mode points at an unsafe data root', async () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    process.env.REBEL_E2E_TOKEN = 'fixture-token';
    process.env.REBEL_USER_DATA = '/data';
    const req = createMockReq({ method: 'POST', headers: authHeader('fixture-token') });
    const res = createMockRes();
    const deps = createDeps([{ id: 's1' } as never]);

    await expect(handleE2eFixtures(req, res, ['__e2e', 'reset'], deps)).rejects.toThrow(
      /e2e fixture REBEL_USER_DATA is unsafe/,
    );

    expect(deps.deleteSession).not.toHaveBeenCalled();
  });

  it('returns health with the run id', async () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    process.env.REBEL_E2E_TOKEN = 'fixture-token';
    const req = createMockReq({
      headers: {
        ...authHeader('fixture-token'),
        'x-rebel-e2e-run-id': 'run-123',
      },
    });
    const res = createMockRes();

    await handleE2eFixtures(req, res, ['__e2e', 'health'], createDeps());

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ ok: true, testMode: true, runId: 'run-123' });
  });

  it('includes the run id in fixture error responses', async () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    process.env.REBEL_E2E_TOKEN = 'fixture-token';
    const req = createMockReq({
      url: '/__e2e/missing',
      headers: {
        ...authHeader('fixture-token'),
        'x-rebel-e2e-run-id': 'run-err',
      },
    });
    const res = createMockRes();

    await handleE2eFixtures(req, res, ['__e2e', 'missing'], createDeps());

    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toEqual({
      error: { code: 'NOT_FOUND', message: 'Not found' },
      runId: 'run-err',
    });
  });

  it('resets sessions through deps and reports the cleared count', async () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    process.env.REBEL_E2E_TOKEN = 'fixture-token';
    const deps = createDeps([
      { id: 's1', title: 'One', createdAt: 1, updatedAt: 1 } as AgentSessionSummary,
      { id: 's2', title: 'Two', createdAt: 2, updatedAt: 2 } as AgentSessionSummary,
    ], createSeedOps({
      resetSafetyFixtures: vi.fn(async () => ({
        clearedToolApprovals: 1,
        clearedMemoryApprovals: 2,
        clearedStagedFiles: 3,
      })),
    }));
    const req = createMockReq({ method: 'POST', url: '/__e2e/reset', headers: authHeader('fixture-token') });
    const res = createMockRes();

    await handleE2eFixtures(req, res, ['__e2e', 'reset'], deps);

    expect(deps.deleteSession).toHaveBeenCalledWith('s1', { intent: 'user-delete' });
    expect(deps.deleteSession).toHaveBeenCalledWith('s2', { intent: 'user-delete' });
    // Stage 3: a reset must clear the hard-delete ledger (factory-reset
    // semantics) so reseeds of previously-deleted ids are not dropped.
    expect(deps.clearHardDeleteLedgerForTestReset).toHaveBeenCalledOnce();
    expect(deps.e2eSeed?.resetSafetyFixtures).toHaveBeenCalledOnce();
    expect(cloudEventBroadcaster.broadcast).toHaveBeenCalledWith('cloud:session-changed', { sessionId: 's1', action: 'deleted' });
    expect(JSON.parse(res._body)).toEqual({
      ok: true,
      cleared: 2,
      clearedToolApprovals: 1,
      clearedMemoryApprovals: 2,
      clearedStagedFiles: 3,
      runId: null,
    });
  });

  it('fails loudly when reset needs seed deps but bootstrap did not configure them', async () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    process.env.REBEL_E2E_TOKEN = 'fixture-token';
    const req = createMockReq({ method: 'POST', url: '/__e2e/reset', headers: authHeader('fixture-token') });
    const res = createMockRes();

    await handleE2eFixtures(req, res, ['__e2e', 'reset'], createDeps());

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body)).toEqual({
      error: {
        code: 'FIXTURE_MISCONFIGURATION',
        message: 'E2E seed operations are not configured for this cloud service',
      },
      runId: null,
    });
  });

  it('seeds a deterministic conversation through deps', async () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    process.env.REBEL_E2E_TOKEN = 'fixture-token';
    const deps = createDeps();
    const req = createMockReq({
      method: 'POST',
      url: '/__e2e/seed/conversation',
      headers: authHeader('fixture-token'),
      body: {
        id: 'seeded',
        title: 'Seeded title',
        messages: [{ role: 'user', text: 'Hello fixture' }],
      },
    });
    const res = createMockRes();

    await handleE2eFixtures(req, res, ['__e2e', 'seed', 'conversation'], deps);

    expect(deps.upsertSession).toHaveBeenCalledWith(expect.objectContaining({
      id: 'seeded',
      title: 'Seeded title',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
      doneAt: null,
      messages: [expect.objectContaining({
        id: 'seeded-msg-1',
        turnId: 'seeded-turn-1',
        role: 'user',
        text: 'Hello fixture',
        createdAt: 1_700_000_000_000,
      })],
    }));
    expect(markSessionAsCloudActive).toHaveBeenCalledWith('seeded');
    expect(cloudEventBroadcaster.broadcast).toHaveBeenCalledWith('cloud:session-changed', { sessionId: 'seeded', action: 'upserted' });
    expect(JSON.parse(res._body)).toEqual({ ok: true, id: 'seeded', runId: null });
  });

  it('seeds a tool approval through the test-only seed dependency', async () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    process.env.REBEL_E2E_TOKEN = 'fixture-token';
    const seedOps = createSeedOps({
      seedToolApproval: vi.fn(async () => ({ toolUseID: 'tool-123', sessionId: 'session-123' })),
    });
    const req = createMockReq({
      method: 'POST',
      url: '/__e2e/seed/tool-approval',
      headers: authHeader('fixture-token'),
      body: { sessionId: 'session-123', toolUseID: 'tool-123' },
    });
    const res = createMockRes();

    await handleE2eFixtures(req, res, ['__e2e', 'seed', 'tool-approval'], createDeps([], seedOps));

    expect(seedOps.seedToolApproval).toHaveBeenCalledWith({ sessionId: 'session-123', toolUseID: 'tool-123' });
    expect(JSON.parse(res._body)).toEqual({
      ok: true,
      toolUseID: 'tool-123',
      sessionId: 'session-123',
      runId: null,
    });
  });

  it('seeds a staged-file conflict through the test-only seed dependency', async () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    process.env.REBEL_E2E_TOKEN = 'fixture-token';
    const seedOps = createSeedOps({
      seedStagedFileConflict: vi.fn(async () => ({
        sessionId: 'conflict-session',
        destinationPath: 'E2E/conflict.md',
      })),
    });
    const req = createMockReq({
      method: 'POST',
      url: '/__e2e/seed/staged-file-conflict',
      headers: authHeader('fixture-token'),
      body: { sessionId: 'conflict-session', destinationPath: 'E2E/conflict.md' },
    });
    const res = createMockRes();

    await handleE2eFixtures(req, res, ['__e2e', 'seed', 'staged-file-conflict'], createDeps([], seedOps));

    expect(seedOps.seedStagedFileConflict).toHaveBeenCalledWith({
      sessionId: 'conflict-session',
      destinationPath: 'E2E/conflict.md',
    });
    expect(JSON.parse(res._body)).toEqual({
      ok: true,
      sessionId: 'conflict-session',
      destinationPath: 'E2E/conflict.md',
      runId: null,
    });
  });
});

// ===========================================================================
// Stage 3 (260612 recs-round5): cloud E2E reset poisoning regression.
// resetSessions deletes with 'user-delete' intent (tombstoning), so it MUST
// clear the hard-delete ledger — or reseeding DEFAULT_E2E_SESSION_ID after a
// reset is silently dropped and every later cloud E2E run is poisoned.
// ===========================================================================

describe('cloud reset → reseed poisoning regression (Stage 3)', () => {
  const originalEnv: Record<string, string | undefined> = {};
  let dataDir = '';

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-e2e-cloud-reset-'));
    process.env.REBEL_USER_DATA = dataDir;
    process.env.REBEL_E2E_TEST_MODE = '1';
    process.env.REBEL_E2E_TOKEN = 'fixture-token';
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Deps wired to a REAL IncrementalSessionStore (mirrors bootstrap.ts). */
  async function createRealStoreDeps(): Promise<{ deps: CloudServiceDeps; store: IncrementalSessionStore }> {
    const { initTestPlatformConfig } = await import('@core/__tests__/testHelpers');
    await initTestPlatformConfig({ userDataPath: dataDir });
    const { IncrementalSessionStore } = await import('@core/services/incrementalSessionStore');
    const store = new IncrementalSessionStore();
    const deps = {
      listSessions: () => store.listSessions({ includeInternal: true }),
      getSession: (id: string) => store.getSession(id),
      upsertSession: (session: AgentSession) => store.upsertSession(session),
      deleteSession: (id: string, options: { intent: 'user-delete' | 'hygiene' }) =>
        store.deleteSession(id, options),
      clearHardDeleteLedgerForTestReset: () => store.clearHardDeleteLedgerForTestReset(),
      e2eSeed: createSeedOps(),
    } as unknown as CloudServiceDeps;
    return { deps, store };
  }

  it('reseeding DEFAULT_E2E_SESSION_ID after a reset actually persists (the reset cleared the tombstone)', async () => {
    const { deps, store } = await createRealStoreDeps();
    const { DEFAULT_E2E_SESSION_ID } = await import('../../e2eFixturesShared');

    // Seed the fixture conversation.
    const seedReq = createMockReq({
      method: 'POST',
      url: '/__e2e/seed/conversation',
      headers: authHeader('fixture-token'),
      body: {},
    });
    await handleE2eFixtures(seedReq, createMockRes(), ['__e2e', 'seed', 'conversation'], deps);
    expect(await store.getSession(DEFAULT_E2E_SESSION_ID)).not.toBeNull();

    // Reset (tombstones the id with 'user-delete', then clears the ledger).
    const resetReq = createMockReq({ method: 'POST', url: '/__e2e/reset', headers: authHeader('fixture-token') });
    const resetRes = createMockRes();
    await handleE2eFixtures(resetReq, resetRes, ['__e2e', 'reset'], deps);
    expect(JSON.parse(resetRes._body)).toMatchObject({ ok: true, cleared: 1 });
    expect(await store.getSession(DEFAULT_E2E_SESSION_ID)).toBeNull();

    // Reseed the SAME id — without the ledger clear this write would be
    // silently dropped (poisoned cloud E2E).
    const reseedReq = createMockReq({
      method: 'POST',
      url: '/__e2e/seed/conversation',
      headers: authHeader('fixture-token'),
      body: {},
    });
    const reseedRes = createMockRes();
    await handleE2eFixtures(reseedReq, reseedRes, ['__e2e', 'seed', 'conversation'], deps);
    expect(JSON.parse(reseedRes._body)).toMatchObject({ ok: true, id: DEFAULT_E2E_SESSION_ID });

    const reseeded = await store.getSession(DEFAULT_E2E_SESSION_ID);
    expect(reseeded).not.toBeNull();
    expect(deps.listSessions().map((s: { id: string }) => s.id)).toContain(DEFAULT_E2E_SESSION_ID);
  });

  it('partial-failure path: a mid-loop delete failure still clears the ledger (finally)', async () => {
    const clearSpy = vi.fn();
    const deps = {
      listSessions: vi.fn(() => [
        { id: 's1', title: 'One', createdAt: 1, updatedAt: 1 },
        { id: 's2', title: 'Two', createdAt: 2, updatedAt: 2 },
      ]),
      deleteSession: vi.fn(async (id: string) => {
        if (id === 's2') throw new Error('simulated mid-loop delete failure');
      }),
      upsertSession: vi.fn(async () => undefined),
      getSession: vi.fn(async () => null),
      clearHardDeleteLedgerForTestReset: clearSpy,
      e2eSeed: createSeedOps(),
    } as unknown as CloudServiceDeps;

    const req = createMockReq({ method: 'POST', url: '/__e2e/reset', headers: authHeader('fixture-token') });
    const res = createMockRes();
    await handleE2eFixtures(req, res, ['__e2e', 'reset'], deps);

    expect(res._status).toBe(500); // the failure is surfaced, not swallowed
    expect(clearSpy).toHaveBeenCalledOnce(); // …but the ledger is still cleared
  });

  it('fails fast (500 FIXTURE_MISCONFIGURATION) when the ledger-clear seam is not wired', async () => {
    const deps = createDeps([{ id: 's1', title: 'One', createdAt: 1, updatedAt: 1 } as AgentSessionSummary], createSeedOps());
    delete (deps as { clearHardDeleteLedgerForTestReset?: () => void }).clearHardDeleteLedgerForTestReset;

    const req = createMockReq({ method: 'POST', url: '/__e2e/reset', headers: authHeader('fixture-token') });
    const res = createMockRes();
    await handleE2eFixtures(req, res, ['__e2e', 'reset'], deps);

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body)).toMatchObject({
      error: { code: 'FIXTURE_MISCONFIGURATION' },
    });
    expect(deps.deleteSession).not.toHaveBeenCalled(); // fail fast BEFORE deleting
  });
});
