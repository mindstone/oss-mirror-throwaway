import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setErrorReporter } from '@core/errorReporter';
import { resetSessionMutexForTests } from '@core/services/sessionMutex';
import { resetSessionSeqIndexForTests } from '@core/services/sessionSeqIndex';
import type { AgentSession, AppSettings } from '@shared/types';

 
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-router-drift',
}));

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
 
vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => loggerMock),
  logger: loggerMock,
}));

let currentSession: AgentSession | null = null;
const mockGetSession = vi.fn(async () => currentSession);
const mockUpsertSession = vi.fn(async (session: AgentSession) => {
  currentSession = session;
});
 
vi.mock('../../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    getSession: mockGetSession,
    upsertSession: mockUpsertSession,
    listSessions: vi.fn(() => []),
    deleteSession: vi.fn(),
  }),
}));

const mockMarkCloudActive = vi.fn();
const mockTouchCloudActivity = vi.fn();
 
vi.mock('../cloudContinuityMetadata', () => ({
  getContinuityEntry: vi.fn(() => null),
  markCloudActive: (...args: unknown[]) => mockMarkCloudActive(...args),
  touchCloudActivity: (...args: unknown[]) => mockTouchCloudActivity(...args),
  restoreContinuityEntrySnapshot: vi.fn(),
  flushContinuityMetadata: vi.fn(async () => ({ success: true })),
}));

const mockMarkCloudSynced = vi.fn();
 
vi.mock('../cloudSyncMetadata', () => ({
  markCloudSynced: (...args: unknown[]) => mockMarkCloudSynced(...args),
}));

const mockOnSessionsSaved = vi.fn(async (_sessions: unknown) => undefined);
 
vi.mock('../../conversationIndexService', () => ({
  onSessionsSaved: (sessions: unknown) => mockOnSessionsSaved(sessions),
}));

import { CloudRouter } from '../cloudRouter';
import { cloudOutbox } from '../cloudOutbox';

const OUTBOX_DIR = path.join('/tmp/test-cloud-router-drift', 'sessions');

function settings(): AppSettings {
  return {
    coreDirectory: '/tmp/core',
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: {} as AppSettings['voice'],
    claude: {} as AppSettings['claude'],
    diagnostics: {} as AppSettings['diagnostics'],
    cloudInstance: {
      mode: 'cloud',
      cloudUrl: 'https://rebel-test.fly.dev',
      cloudToken: 'placeholder',
    },
  } as AppSettings;
}

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1',
    title: 'Test',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    eventsByTurn: {},
    maxSeq: 0,
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

function statusEvent(seq: number) {
  return { type: 'status' as const, message: `event-${seq}`, timestamp: seq, seq };
}

function routerWithClient(get: ReturnType<typeof vi.fn>): CloudRouter {
  const router = new CloudRouter();
  router.init({ getSettings: settings });
  (router as unknown as { httpClient: { get: typeof get; disconnect: () => void } }).httpClient = {
    get,
    disconnect: vi.fn(),
  };
  return router;
}

describe('CloudRouter pull drift detection', () => {
  const breadcrumbs: Array<{ message?: string; data?: Record<string, unknown> }> = [];

  beforeEach(() => {
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
    cloudOutbox._resetForTesting();
    resetSessionSeqIndexForTests();
    currentSession = null;
    mockGetSession.mockClear();
    mockUpsertSession.mockClear();
    loggerMock.warn.mockClear();
    breadcrumbs.length = 0;
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: (breadcrumb) => { breadcrumbs.push({ message: breadcrumb.message, data: breadcrumb.data }); },
    });
  });

  afterEach(() => {
    cloudOutbox._resetForTesting();
    resetSessionMutexForTests();
    resetSessionSeqIndexForTests();
    setErrorReporter({ captureException: () => {}, captureMessage: () => {}, addBreadcrumb: () => {} });
    fs.rmSync(OUTBOX_DIR, { recursive: true, force: true });
  });

  it('resets the pull cursor and emits a breadcrumb when cloud maxSeq is behind the tracked cursor', async () => {
    currentSession = session({ maxSeq: 9, eventsByTurn: { t1: [statusEvent(9)] } });
    cloudOutbox.recordLastPushedSeq('session-1', 9);
    const pulled = session({ updatedAt: 10, maxSeq: 5, eventsByTurn: { t2: [statusEvent(5)] }, cloudUpdatedAt: 50 });
    const get = vi.fn().mockResolvedValue(pulled);
    const router = routerWithClient(get);

    await router.syncSessionFromCloud('session-1');

    expect(cloudOutbox.getLastPushedSeq('session-1')).toBe(5);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pulledMaxSeq: 5, trackedLastPushedSeq: 9 }),
      'session-delta-push:drift-detected',
    );
    expect(breadcrumbs.some((breadcrumb) => breadcrumb.message === 'session-delta-push:drift-detected')).toBe(true);
  });

  it('does not emit drift detection when the tracked cursor is behind the pulled session', async () => {
    currentSession = session({ maxSeq: 4, eventsByTurn: { t1: [statusEvent(4)] } });
    cloudOutbox.recordLastPushedSeq('session-1', 4);
    const pulled = session({ updatedAt: 10, maxSeq: 9, eventsByTurn: { t2: [statusEvent(9)] }, cloudUpdatedAt: 90 });
    const get = vi.fn().mockResolvedValue(pulled);
    const router = routerWithClient(get);

    await router.syncSessionFromCloud('session-1');

    expect(cloudOutbox.getLastPushedSeq('session-1')).toBe(9);
    expect(loggerMock.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'session-delta-push:drift-detected',
    );
    expect(breadcrumbs.some((breadcrumb) => breadcrumb.message === 'session-delta-push:drift-detected')).toBe(false);
  });
});
