import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { setErrorReporter, type ErrorReporter } from '@core/errorReporter';
import {
  appendDiagnosticEvent,
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerWriter,
  setDiagnosticEventsSurface,
} from '@core/services/diagnosticEventsLedger';
import type { DiagnosticEventEntry } from '@core/services/diagnostics/manifest';
import { setStoreFactory, type StoreFactory } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { getSessionTombstoneStore, resetSessionTombstoneStoreForTests } from '@core/services/continuity/sessionTombstoneStore';
import { resetServerClockForTests, setServerNowForTests, stampCloudUpdatedAt } from '@core/services/continuity/serverClock';
import { getOutboxStallMonitor, resetOutboxStallMonitorForTests } from '@core/services/continuity/outboxStallMonitor';
import {
  getSessionMutex,
  resetSessionMutexForTests,
  SessionMutexDeadlockError,
} from '@core/services/sessionMutex';
import { processSessionPut, type CloudSessionEffectSink, type CloudSessionMergeDeps } from '@core/services/cloudSessionMergeService';
import { CloudOutbox } from '@main/services/cloud/cloudOutbox';
import { CloudRouter } from '@main/services/cloud/cloudRouter';
import { CloudWorkspaceSync, type WorkspaceManifest } from '@main/services/cloud/cloudWorkspaceSync';

type Breadcrumb = Parameters<ErrorReporter['addBreadcrumb']>[0];

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

const noopReporter: ErrorReporter = {
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
};

let breadcrumbs: Breadcrumb[] = [];
let diagnosticEvents: DiagnosticEventEntry[] = [];

beforeEach(() => {
  breadcrumbs = [];
  diagnosticEvents = [];
  setErrorReporter({
    captureException: () => {},
    captureMessage: () => {},
    addBreadcrumb: (breadcrumb) => {
      breadcrumbs.push(breadcrumb);
    },
  });
  resetDiagnosticEventsLedgerForTests();
  setDiagnosticEventsSurface('desktop');
  setDiagnosticEventsLedgerWriter({
    append: (entry) => {
      diagnosticEvents.push(entry);
    },
  });
  installMemoryStoreFactory();
});

afterEach(() => {
  resetSessionMutexForTests();
  resetServerClockForTests();
  resetOutboxStallMonitorForTests();
  resetSessionTombstoneStoreForTests();
  resetDiagnosticEventsLedgerForTests();
  setErrorReporter(noopReporter);
});

describe('continuity breadcrumb dual-write emitters', () => {
  it('cloudOutbox emits Sentry breadcrumbs and F2 events for drain contention and stuck outbox', async () => {
    const outbox = new CloudOutbox();
    const mutableOutbox = outbox as unknown as {
      drainPromise: Promise<unknown> | null;
      entries: Map<string, unknown>;
      currentCloudUrl: string | null;
      lastSuccessfulDrainAt: number;
      lastStallEscalatedAt: number;
      checkForStalledOutbox(): void;
    };

    mutableOutbox.drainPromise = Promise.resolve({ delivered: 1, failedCount: 0, authFailureCount: 0 });
    await outbox.drain({ put: vi.fn(), delete: vi.fn() });
    expectDualWrite({ family: 'outbox', message: 'state-transition', reason: 'session-mutex-contention' });

    breadcrumbs = [];
    diagnosticEvents = [];
    mutableOutbox.entries = new Map([['session-1', { op: 'upsert', status: 'pending' }]]);
    mutableOutbox.currentCloudUrl = 'https://cloud.example';
    mutableOutbox.lastSuccessfulDrainAt = Date.now() - 11 * 60 * 1000;
    mutableOutbox.lastStallEscalatedAt = 0;
    mutableOutbox.checkForStalledOutbox();
    expectDualWrite({ family: 'outbox', message: 'stuck-outbox', reason: 'stuck-outbox' });
  });

  it('cloudWorkspaceSync emits Sentry breadcrumb and F2 event on workspace TOCTOU retry', async () => {
    const sync = new CloudWorkspaceSync();
    const mutableSync = sync as unknown as {
      load(): void;
      fetchCloudManifest(): Promise<unknown>;
      buildLocalManifest(): Promise<{ manifest: WorkspaceManifest; complete: boolean; reasons: [] }>;
      pushChangedFiles(): Promise<{ pushed: number; skipped: number; failed: number }>;
      pullChangedFiles(): Promise<{ pulled: number; skipped: number; conflicts: number; conflictPaths: string[]; newFiles: number; deferred: number }>;
      getDeletedFiles(): string[];
      getCloudMissingFiles(): string[];
      executeSyncCore(client: { post: (path: string, body: unknown) => Promise<unknown> }, coreDirectory: string, source: string): Promise<unknown>;
    };
    const firstManifest = manifestWith('a', 1);
    const changedManifest = manifestWith('b', 2);

    mutableSync.load = vi.fn();
    mutableSync.fetchCloudManifest = vi.fn(async () => ({ complete: true, reasons: [], entries: {} }));
    mutableSync.buildLocalManifest = vi.fn()
      .mockResolvedValueOnce({ manifest: firstManifest, complete: true, reasons: [] })
      .mockResolvedValueOnce({ manifest: changedManifest, complete: true, reasons: [] })
      .mockResolvedValue({ manifest: changedManifest, complete: true, reasons: [] });
    mutableSync.pushChangedFiles = vi.fn(async () => ({ pushed: 1, skipped: 0, failed: 0 }));
    mutableSync.pullChangedFiles = vi.fn(async () => ({
      pulled: 0,
      skipped: 0,
      conflicts: 0,
      conflictPaths: [],
      newFiles: 0,
      deferred: 0,
    }));
    mutableSync.getDeletedFiles = vi.fn(() => []);
    mutableSync.getCloudMissingFiles = vi.fn(() => []);

    await mutableSync.executeSyncCore({ post: vi.fn() }, '/tmp/rebel-workspace', 'unit-test');

    expectDualWrite({ family: 'workspace_sync', message: 'state-transition', reason: 'workspace-toctou-retry' });
  });

  it('cloudRouter emits Sentry breadcrumb and F2 event for tombstone continuity', () => {
    const router = new CloudRouter() as unknown as {
      recordTombstoneContinuityBreadcrumb(args: {
        sessionId: string;
        reason: 'tombstone-applied';
        direction: string;
      }): void;
    };

    router.recordTombstoneContinuityBreadcrumb({
      sessionId: 'router-session',
      reason: 'tombstone-applied',
      direction: 'desktop-pull',
    });

    expectDualWrite({ family: 'router', message: 'tombstone-applied', reason: 'tombstone-applied' });
  });

  it('serverClock emits Sentry breadcrumb and F2 event when server time moves backwards', () => {
    setServerNowForTests(() => 1_000);

    stampCloudUpdatedAt({ id: 'clock-session', cloudUpdatedAt: 2_000 });

    expectDualWrite({ family: 'server_clock', message: 'server-clock-backwards', reason: 'server-clock-backwards' });
  });

  it('outboxStallMonitor emits Sentry breadcrumb and F2 event when a device outbox stalls', () => {
    const monitor = getOutboxStallMonitor();
    monitor.setNowProviderForTests(() => 0);
    monitor.recordDrainStarted('device-1');
    monitor.setNowProviderForTests(() => 11 * 60 * 1000);

    monitor.checkForStalls();

    expectDualWrite({ family: 'outbox_stall', message: 'stuck-outbox', reason: 'stuck-outbox' });
  });

  it('sessionMutex emits Sentry breadcrumbs and F2 events for contention and deadlock', async () => {
    const mutex = getSessionMutex();
    let releaseContentionLock: (() => void) | undefined;
    const heldLock = mutex.withLock(
      'contention-session',
      () => new Promise<void>((resolve) => {
        releaseContentionLock = resolve;
      }),
      { deadlockTimeoutMs: 0 },
    );
    await Promise.resolve();

    const contendedLock = mutex.withLock(
      'contention-session',
      async () => {},
      { contentionBreadcrumbMs: -1, deadlockTimeoutMs: 0, label: 'unit-test-contention' },
    );
    await Promise.resolve();
    releaseContentionLock?.();
    await Promise.all([heldLock, contendedLock]);
    expectDualWrite({ family: 'session_mutex', message: 'session-mutex-contention', reason: 'session-mutex-contention' });

    breadcrumbs = [];
    diagnosticEvents = [];
    let releaseDeadlockLock: (() => void) | undefined;
    const deadlockHeldLock = mutex.withLock(
      'deadlock-session',
      () => new Promise<void>((resolve) => {
        releaseDeadlockLock = resolve;
      }),
      { deadlockTimeoutMs: 0 },
    );
    await Promise.resolve();
    await expect(mutex.withLock(
      'deadlock-session',
      async () => {},
      { deadlockTimeoutMs: 1, label: 'unit-test-deadlock' },
    )).rejects.toBeInstanceOf(SessionMutexDeadlockError);
    releaseDeadlockLock?.();
    await deadlockHeldLock;
    expectDualWrite({ family: 'session_mutex', message: 'session-mutex-deadlock', reason: 'session-mutex-deadlock' });
  });

  it('cloudSessionMergeService sink hook emits F2 events for tombstone breadcrumbs', async () => {
    getSessionTombstoneStore().addTombstone('merge-session', 'cloud', Date.now());
    const sink: CloudSessionEffectSink = {
      emit: vi.fn(),
      breadcrumb: (breadcrumb) => {
        breadcrumbs.push(breadcrumb);
      },
      appendDiagnosticEvent,
    };
    const deps: CloudSessionMergeDeps = {
      getSession: vi.fn(async () => null),
      upsertSession: vi.fn(async () => {}),
      deleteSession: vi.fn(async () => {}),
      listSessions: vi.fn(() => []),
      readContinuityStateMap: vi.fn(async () => null),
    };

    await processSessionPut(deps, {
      sessionId: 'merge-session',
      incomingRaw: { id: 'merge-session', title: 'Ignored tombstoned session' },
      source: 'unit-test',
      surface: 'desktop',
      sink,
    });

    expectDualWrite({ family: 'merge', message: 'tombstone-applied', reason: 'tombstone-applied' });
    expectDualWrite({ family: 'merge', message: 'tombstone-race-detected', reason: 'tombstone-race-detected' });
  });
});

describe('diagnostic events ledger writer bootstrap invariant', () => {
  it('installs F2 writers on desktop and cloud while mobile stays reader-only', () => {
    const desktopBootstrap = fs.readFileSync(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf8');
    const cloudBootstrap = fs.readFileSync(path.join(REPO_ROOT, 'cloud-service/src/bootstrap.ts'), 'utf8');
    const mobileFiles = listSourceFiles(path.join(REPO_ROOT, 'mobile'));

    expect(desktopBootstrap).toContain('setDiagnosticEventsLedgerWriter(desktopDiagnosticEventsLedgerWriter)');
    expect(cloudBootstrap).toContain('setDiagnosticEventsLedgerWriter(cloudDiagnosticEventsLedgerWriter)');
    expect(mobileFiles.filter((filePath) => {
      const content = fs.readFileSync(filePath, 'utf8');
      return content.includes('setDiagnosticEventsLedgerWriter(');
    })).toEqual([]);
  });
});

function expectDualWrite(args: {
  family: string;
  message: string;
  reason?: string;
}): void {
  expect(breadcrumbs).toEqual(expect.arrayContaining([
    expect.objectContaining({
      category: expect.stringMatching(/^continuity\./u),
      message: args.message,
    }),
  ]));
  expect(diagnosticEvents).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'continuity_transition',
      data: expect.objectContaining({
        family: args.family,
        message: args.message,
        ...(args.reason ? { reason: args.reason } : {}),
      }),
    }),
  ]));
}

function manifestWith(hash: string, mtime: number): WorkspaceManifest {
  return new Map([
    ['notes/example.md', { hash, mtime, size: 12 }],
  ]);
}

function installMemoryStoreFactory(): void {
  const factory: StoreFactory = <T extends Record<string, unknown>>(options: { defaults?: T; name: string }) => {
    let store = { ...(options.defaults ?? {}) } as T;
    const keyValueStore: KeyValueStore<T> = {
      get: ((key: keyof T & string, defaultValue?: T[keyof T & string]) => (
        Object.hasOwn(store, key) ? store[key] : defaultValue
      )) as KeyValueStore<T>['get'],
      set: ((keyOrValues: keyof T & string | Partial<T>, value?: T[keyof T & string]) => {
        if (typeof keyOrValues === 'string') {
          store = { ...store, [keyOrValues]: value };
          return;
        }
        store = { ...store, ...keyOrValues };
      }) as KeyValueStore<T>['set'],
      has: (key: string) => Object.hasOwn(store, key),
      delete: (key: string) => {
        const next = { ...store };
        delete next[key as keyof T];
        store = next;
      },
      clear: () => {
        store = {} as T;
      },
      get store() {
        return store;
      },
      set store(value: T) {
        store = value;
      },
      path: `memory://${options.name}`,
    };
    return keyValueStore;
  };
  setStoreFactory(factory);
}

function listSourceFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'dist') continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
      continue;
    }
    if (/\.(?:ts|tsx|js|jsx)$/u.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}
