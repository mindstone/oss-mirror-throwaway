import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * Stage 4a — watcher cloud-symlink exclusion against the REAL `detectCloudStorage`
 * FileProvider path shapes (GPT review 260619_102941 F3).
 *
 * The primary watcher suite (workspaceWatcherService.test.ts) MOCKS the whole
 * `cloudStorageUtils` module, so it proves the matcher's control flow but NOT
 * that the production detector actually recognises the path shapes the matcher
 * feeds it. A regression in how the matcher hands targets to the detector (raw
 * vs resolved, slash flavour, case) — or in the detector's own regexes — would
 * pass the mocked suite while re-following a dead cloud mount in the field.
 *
 * This suite mocks ONLY `node:fs` (readlink/readdir/stat) + `chokidar`, and lets
 * `workspaceWatcherService` import the REAL `detectCloudStorage` /
 * `detectInPlaceCloudDocuments`. It drives the matcher end-to-end through
 * `anymatch` (the real chokidar round-trip) for the two FileProvider shapes the
 * incident is about:
 *   - Google Drive `~/Library/CloudStorage/GoogleDrive-…` (Mindstone-employee shape).
 *   - Dropbox at `~/Dropbox` (the provider the 4b review flagged as covered only
 *     by string detection, not the iCloud xattr path).
 *
 * The workspace ROOT is a plain `/fake/...` path (NOT under ~/Documents), so the
 * real `detectInPlaceCloudDocuments` is inert (darwin-only + ~/Documents-scoped)
 * and `start()` takes the cheap local sync path — keeping the test deterministic
 * across platforms while still exercising the real cloud-symlink classifier.
 */

class FakeWatcher extends EventEmitter {
  public closed = false;
  public getWatched(): Record<string, string[]> {
    return {};
  }
  public async close(): Promise<void> {
    this.closed = true;
  }
}
let currentWatcher: FakeWatcher | null = null;
vi.mock('chokidar', () => ({
  watch: vi.fn(() => {
    currentWatcher = new FakeWatcher();
    return currentWatcher;
  }),
}));

function makeEinval(): NodeJS.ErrnoException {
  const err = new Error('EINVAL: invalid argument, readlink') as NodeJS.ErrnoException;
  err.code = 'EINVAL';
  return err;
}

const { readdirSyncMock, readlinkSyncMock, statSyncMock } = vi.hoisted(() => ({
  readdirSyncMock: vi.fn<(p: string, opts?: unknown) => Array<{ name: string; isSymbolicLink: () => boolean }>>(
    () => [],
  ),
  readlinkSyncMock: vi.fn<(p: string) => string>(() => {
    throw makeEinval();
  }),
  // Healthy local directory (the `/fake` root takes the cheap sync path).
  statSyncMock: vi.fn<(p: string) => { isDirectory: () => boolean }>(() => ({ isDirectory: () => true })),
}));
// Mock ONLY node:fs (the SUT's sync probes). NOTE: cloudStorageUtils is the REAL
// module here — that is the whole point of this suite.
vi.mock('node:fs', () => ({
  statSync: (p: string) => statSyncMock(p),
  readdirSync: (p: string, opts?: unknown) => readdirSyncMock(p, opts),
  readlinkSync: (p: string) => readlinkSyncMock(p),
}));
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(async () => ({ isDirectory: () => true })),
}));
vi.mock('@core/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  // boundedWorkspaceFs (transitively loaded via safeWalkDirectory — S4.1a) needs this.
  createScopedLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
const { addBreadcrumbMock } = vi.hoisted(() => ({ addBreadcrumbMock: vi.fn() }));
vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({ captureException: vi.fn(), addBreadcrumb: addBreadcrumbMock }),
  setErrorReporter: vi.fn(),
}));

const { workspaceWatcherService } = await import('../workspaceWatcherService');
const { watch } = await import('chokidar');

type IgnorePatternMatcher = string | RegExp | ((path: string, stats?: unknown) => boolean);
const anymatch = require('anymatch') as (
  matchers: IgnorePatternMatcher[] | IgnorePatternMatcher,
  testPath: string | [string, unknown],
) => boolean;

function getIgnoredMatchers(): IgnorePatternMatcher[] {
  const watchMock = watch as unknown as { mock: { calls: Array<[string, Record<string, unknown>]> } };
  const ignored = watchMock.mock.calls.at(-1)?.[1]?.ignored as
    | IgnorePatternMatcher[]
    | IgnorePatternMatcher
    | undefined;
  if (!ignored) throw new Error('Expected chokidar.watch() to receive ignored matchers');
  return Array.isArray(ignored) ? ignored : [ignored];
}

describe('workspaceWatcherService — REAL detectCloudStorage FileProvider shapes (Stage 4a F3)', () => {
  beforeEach(() => {
    currentWatcher = null;
    vi.clearAllMocks();
    readdirSyncMock.mockReturnValue([]);
    readlinkSyncMock.mockImplementation(() => {
      throw makeEinval();
    });
    statSyncMock.mockReturnValue({ isDirectory: () => true });
    workspaceWatcherService.removeAllListeners();
  });

  afterEach(async () => {
    await workspaceWatcherService.stop();
    workspaceWatcherService.removeAllListeners();
  });

  it('excludes a Google Drive ~/Library/CloudStorage symlink via the REAL detector (Mindstone-employee shape)', () => {
    const workspace = '/fake/workspace';
    // The exact FileProvider shape from the incident logs.
    const gdriveTarget =
      '/Users/test/Library/CloudStorage/GoogleDrive-user@example.com/Shared drives/Company Memories';

    readdirSyncMock.mockReturnValue([{ name: 'Company Memories', isSymbolicLink: () => true }]);
    readlinkSyncMock.mockImplementation((p: string) =>
      p.endsWith('Company Memories') ? gdriveTarget : (() => { throw makeEinval(); })(),
    );

    workspaceWatcherService.start(workspace);
    const ignored = getIgnoredMatchers();

    // The REAL detector recognises the CloudStorage path → excluded with its subtree.
    expect(anymatch(ignored, `${workspace}/Company Memories`)).toBe(true);
    expect(anymatch(ignored, `${workspace}/Company Memories/2026/notes.md`)).toBe(true);
  });

  it('excludes a Dropbox ~/Dropbox symlink via the REAL detector (string-detected, not xattr)', () => {
    const workspace = '/fake/workspace';
    const dropboxTarget = '/Users/test/Dropbox/Team/Shared';

    readdirSyncMock.mockReturnValue([{ name: 'Dropbox Link', isSymbolicLink: () => true }]);
    readlinkSyncMock.mockImplementation((p: string) =>
      p.endsWith('Dropbox Link') ? dropboxTarget : (() => { throw makeEinval(); })(),
    );

    workspaceWatcherService.start(workspace);
    const ignored = getIgnoredMatchers();

    expect(anymatch(ignored, `${workspace}/Dropbox Link`)).toBe(true);
    expect(anymatch(ignored, `${workspace}/Dropbox Link/file.md`)).toBe(true);
  });

  it('emits ONE aggregate cloud-symlink breadcrumb at install with the Tier-1 excluded count (Stage 4)', () => {
    const workspace = '/fake/workspace';
    const gdriveTarget =
      '/Users/test/Library/CloudStorage/GoogleDrive-user@example.com/Shared drives/Company Memories';
    const dropboxTarget = '/Users/test/Dropbox/Team/Shared';
    const localTarget = '/Users/test/Projects/shared-notes';

    // Two top-level CLOUD symlinks + one LOCAL symlink. Only the two cloud ones
    // are excluded at install → the Tier-1 count must be 2.
    readdirSyncMock.mockReturnValue([
      { name: 'Company Memories', isSymbolicLink: () => true },
      { name: 'Dropbox Link', isSymbolicLink: () => true },
      { name: 'Shared Notes', isSymbolicLink: () => true },
    ]);
    readlinkSyncMock.mockImplementation((p: string) => {
      if (p.endsWith('Company Memories')) return gdriveTarget;
      if (p.endsWith('Dropbox Link')) return dropboxTarget;
      if (p.endsWith('Shared Notes')) return localTarget;
      throw makeEinval();
    });

    workspaceWatcherService.start(workspace);

    const installCrumbs = addBreadcrumbMock.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as { message?: string } | undefined)?.message ===
        '[cloud-symlink] excluded N cloud/unclassifiable symlinks at watcher install',
    );
    expect(installCrumbs).toHaveLength(1);
    expect(installCrumbs[0][0]).toMatchObject({
      category: 'workspace-watcher',
      level: 'info',
      data: {
        cloudSymlinkExcludedCountAtInstall: 2,
        topLevelEnumerationFailed: false,
      },
    });
  });

  it('keeps a genuinely LOCAL symlink watched via the REAL detector (no over-exclusion)', () => {
    const workspace = '/fake/workspace';
    // A plain local project dir — the real detector returns isCloud:false, so the
    // carve-out for must-follow local symlinks is preserved.
    const localTarget = '/Users/test/Projects/shared-notes';

    readdirSyncMock.mockReturnValue([{ name: 'Shared Notes', isSymbolicLink: () => true }]);
    readlinkSyncMock.mockImplementation((p: string) =>
      p.endsWith('Shared Notes') ? localTarget : (() => { throw makeEinval(); })(),
    );

    workspaceWatcherService.start(workspace);
    const ignored = getIgnoredMatchers();

    expect(anymatch(ignored, `${workspace}/Shared Notes`)).toBe(false);
    expect(anymatch(ignored, `${workspace}/Shared Notes/today.md`)).toBe(false);
  });
});
