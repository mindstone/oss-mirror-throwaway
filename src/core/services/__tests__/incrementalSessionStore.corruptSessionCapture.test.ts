/**
 * H2 (docs/plans/260621_monitoring-capture-surface, Stage 6): a corrupt /
 * unparseable session file used to be swallowed to a SILENT null by the lenient
 * loadSessionFile / loadSessionFileSync — the session vanished from the visible
 * corpus with no fleet signal (the class that needed the user's .zip). It must
 * now be observable: a warn + a `corrupt_session_file_skipped` known-condition
 * capture, while a legitimately-absent (ENOENT) file stays silent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AgentSession } from '@shared/types';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

const captureKnownConditionMock = vi.fn();

let testDir: string;

function sessionsDirPath(): string {
  return path.join(testDir, 'sessions');
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-default',
    title: 'Test Session',
    createdAt: 1000,
    updatedAt: 2000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

function writeSessionFile(session: AgentSession): void {
  fs.mkdirSync(sessionsDirPath(), { recursive: true });
  fs.writeFileSync(path.join(sessionsDirPath(), `${session.id}.json`), JSON.stringify(session), 'utf8');
}

/** Write a session-named .json whose content is NOT valid JSON (hydrate throws). */
function writeCorruptSessionFile(id: string): void {
  fs.mkdirSync(sessionsDirPath(), { recursive: true });
  fs.writeFileSync(path.join(sessionsDirPath(), `${id}.json`), '{ this is : not valid json,,, ', 'utf8');
}

async function createStore() {
  vi.resetModules();
  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => stubLogger,
    logger: stubLogger,
  }));
  vi.doMock('@core/sentry/captureKnownCondition', () => ({
    captureKnownCondition: captureKnownConditionMock,
  }));
  await initTestPlatformConfig({ userDataPath: testDir });
  const mod = await import('../incrementalSessionStore');
  return { store: new mod.IncrementalSessionStore() };
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-corrupt-session-'));
  Object.values(stubLogger).forEach((fn) => fn.mockClear());
  captureKnownConditionMock.mockClear();
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('corrupt session file → observable capture (H2)', () => {
  it('captures corrupt_session_file_skipped (sync) and keeps valid sessions; no silent null', async () => {
    const { store } = await createStore();
    writeSessionFile(makeSession({ id: 'good-0' }));
    writeSessionFile(makeSession({ id: 'good-1' }));
    writeCorruptSessionFile('corrupt-1');

    const sessions = store.loadSync();

    // Valid sessions survive; the corrupt one is skipped (not crashed, not leaked).
    expect(sessions.map((s) => s.id).sort()).toEqual(['good-0', 'good-1']);

    // RED before the fix: the corrupt file was swallowed to null with NO capture.
    const corruptCalls = captureKnownConditionMock.mock.calls.filter(
      ([condition]) => condition === 'corrupt_session_file_skipped',
    );
    expect(corruptCalls.length).toBeGreaterThanOrEqual(1);
    // PII-safe: extra carries operation only (+ optional errorCode), never id/path/content.
    const [, ctx] = corruptCalls[0];
    expect(ctx?.extra?.operation).toBe('loadSessionFileSync');
    expect(Object.keys(ctx?.extra ?? {}).sort()).toEqual(
      expect.arrayContaining(['operation']),
    );
    expect(JSON.stringify(ctx?.extra ?? {})).not.toContain('corrupt-1');
  });

  it('does NOT capture for a legitimately-absent (ENOENT) session file', async () => {
    const { store } = await createStore();
    // Load an index that references a session whose file does not exist, via the
    // public path: no files on disk at all → rebuild sees nothing, no capture.
    store.loadSync();
    const corruptCalls = captureKnownConditionMock.mock.calls.filter(
      ([condition]) => condition === 'corrupt_session_file_skipped',
    );
    expect(corruptCalls.length).toBe(0);
  });
});
