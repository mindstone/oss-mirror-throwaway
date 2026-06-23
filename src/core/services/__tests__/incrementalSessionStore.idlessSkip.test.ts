/**
 * Regression for the 260617 `classifySessionKind(undefined)` crash, defense
 * layer C: the single session-read chokepoint must SKIP a file that hydrates
 * without a valid string `id` (a non-session sidecar that slipped the name-based
 * denylist, or a corrupt/partial write) — observably — instead of letting an
 * `id`-less "session" into the index, where its `id: undefined` summary later
 * crashed sessions:list / time-saved / every agent turn.
 *
 * This is independent of the (drift-prone) NON_SESSION_FILES name denylist: the
 * fixture file below is NOT denylisted, so it passes `isSessionFile()` and only
 * the content guard stops it. A handful of skipped files must NOT trip the
 * mass-loss circuit breaker (those are genuinely not sessions).
 *
 * See docs-private/investigations/260617_classifysessionkind_undefined_crash_handoff.md.
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
  fs.writeFileSync(
    path.join(sessionsDirPath(), `${session.id}.json`),
    JSON.stringify(session),
    'utf8',
  );
}

/** Write a `.json` file in sessions/ whose content has NO `id` (sidecar-shaped). */
function writeIdlessFile(basename: string, content: Record<string, unknown>): void {
  fs.mkdirSync(sessionsDirPath(), { recursive: true });
  fs.writeFileSync(path.join(sessionsDirPath(), basename), JSON.stringify(content), 'utf8');
}

async function createStore() {
  vi.resetModules();
  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => stubLogger,
    logger: stubLogger,
  }));
  await initTestPlatformConfig({ userDataPath: testDir });
  const mod = await import('../incrementalSessionStore');
  return { store: new mod.IncrementalSessionStore() };
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-idless-skip-'));
  Object.values(stubLogger).forEach((fn) => fn.mockClear());
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe('rebuild-from-files skips id-less (non-session) files observably', () => {
  it('a .json file that hydrates without an id is skipped; valid sessions survive; no breaker trip', async () => {
    const { store } = await createStore();

    // Three real sessions + one sidecar-shaped file that is NOT in the name
    // denylist (so it passes isSessionFile) but parses to an id-less object.
    for (let i = 0; i < 3; i++) writeSessionFile(makeSession({ id: `good-${i}` }));
    writeIdlessFile('not-a-session.json', { title: 'sidecar', messages: [], eventsByTurn: {} });

    // No index → rebuild-from-files (sync) path.
    const sessions = store.loadSync();

    const ids = sessions.map((s) => s.id).sort();
    expect(ids).toEqual(['good-0', 'good-1', 'good-2']);
    // Every surviving session has a real id — nothing id-less leaked through.
    expect(sessions.every((s) => typeof s.id === 'string' && s.id.length > 0)).toBe(true);
    // One skipped non-session file must NOT trip the mass-loss breaker.
    expect(store.isReadOnly()).toBe(false);

    // The skip is observable, never silent (CODING_PRINCIPLES "silent failure is a bug").
    const skipWarn = stubLogger.warn.mock.calls.find(
      ([, msg]) => typeof msg === 'string' && msg.includes('without a valid id'),
    );
    expect(skipWarn).toBeDefined();
    expect(skipWarn?.[0]).toMatchObject({ reason: 'no-valid-id' });
  });

  it('does not crash classifying summaries after a rebuild that saw an id-less file', async () => {
    const { store } = await createStore();
    writeSessionFile(makeSession({ id: 'good-0' }));
    writeIdlessFile('not-a-session.json', { title: 'sidecar', messages: [], eventsByTurn: {} });

    // The historical crash was downstream: listing summaries then classifying
    // each id. With the id-less file skipped, this must complete cleanly.
    expect(() => store.loadSync()).not.toThrow();
    const summaries = store.listSessions();
    expect(summaries.every((s) => typeof s.id === 'string' && s.id.length > 0)).toBe(true);
  });
});
