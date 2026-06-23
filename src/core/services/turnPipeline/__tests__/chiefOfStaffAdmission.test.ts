/**
 * Stage 3 (260622 render-preview-cloud-hang) — the Chief-of-Staff admission VERDICT
 * mapping, exercised against the REAL killable {@link readSpaceReadmeBounded} reader
 * (cloud lane driven via the wired executor double; local lane via fs mock).
 *
 * Covers the outcome→verdict branch table (PLAN Stage 3), including the load-bearing
 * invariant that `reconnecting` STRICTLY outranks the onboarding gate (a live-but-
 * unreachable CoS is never classified `missing-after-setup`), and the never-hang
 * guarantee (an unwired cloud executor resolves to `reconnecting` within budget).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { AppSettings } from '@shared/types';

const CLOUD_TARGET =
  '/Users/test/Library/CloudStorage/GoogleDrive-user@example.com/Shared drives/Chief-of-Staff';
const LOCAL_CORE = path.resolve('/workspace');

function makeEnoent(): NodeJS.ErrnoException {
  const err = new Error('ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}
function makeEacces(): NodeJS.ErrnoException {
  const err = new Error('EACCES') as NodeJS.ErrnoException;
  err.code = 'EACCES';
  return err;
}

const mockReadFile = vi.fn();
const mockReaddir = vi.fn();
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const readFile = (...args: unknown[]) => mockReadFile(...args);
  const readdir = (...args: unknown[]) => mockReaddir(...args);
  return { ...actual, default: { ...actual, readFile, readdir }, readFile, readdir };
});

/** A `fs.Dirent`-shaped entry for the local-lane `readdirWithFileTypes` boundary. */
function dirent(name: string, kind: 'dir' | 'symlink' | 'file' = 'dir') {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'symlink',
    isFile: () => kind === 'file',
  } as unknown as import('node:fs').Dirent;
}

vi.mock('@core/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createScopedLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { evaluateChiefOfStaffAdmission, resolveChiefOfStaffDir } = await import(
  '../chiefOfStaffAdmission'
);
const { setWorkspaceFsExecutor, __resetWorkspaceFsExecutorForTesting } = await import(
  '@core/services/boundedWorkspaceFs'
);
const { realFsExecutorWith } = await import('@core/services/__tests__/workspaceFsExecutorDoubles');

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    coreDirectory: LOCAL_CORE,
    spaces: [
      { name: 'Chief-of-Staff', path: 'Chief-of-Staff', type: 'chief-of-staff', isSymlink: false, createdAt: 1 },
    ],
    onboardingFirstCompletedAt: null,
    ...overrides,
  } as unknown as AppSettings;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceFsExecutorForTesting();
  // Default: the workspace-root scan (bounded resolver, no settings entry) finds
  // no `chief-of-staff` dir → resolver falls back to the canonical join. Tests
  // that exercise the lowercased-on-disk case override this.
  mockReaddir.mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  __resetWorkspaceFsExecutorForTesting();
});

describe('resolveChiefOfStaffDir', () => {
  it('derives the dir from settings.spaces (on-disk name)', () => {
    expect(resolveChiefOfStaffDir(settings())).toBe(path.join(LOCAL_CORE, 'Chief-of-Staff'));
  });
  it('falls back to the canonical Chief-of-Staff join when no CoS space is configured', () => {
    expect(resolveChiefOfStaffDir(settings({ spaces: [] }))).toBe(
      path.join(LOCAL_CORE, 'Chief-of-Staff'),
    );
  });
  it('returns null without a core directory', () => {
    expect(resolveChiefOfStaffDir(settings({ coreDirectory: null }))).toBeNull();
  });
});

describe('evaluateChiefOfStaffAdmission — outcome → verdict', () => {
  it('LOCAL README present → admit + content threaded forward (F2)', async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).endsWith('README.md')) return '# CoS body';
      throw makeEnoent();
    });
    const verdict = await evaluateChiefOfStaffAdmission(settings());
    expect(verdict).toEqual({ decision: 'admit', content: '# CoS body', outcome: 'ok' });
  });

  it('LOCAL unreadable (EACCES) → block unreadable', async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).endsWith('README.md')) throw makeEacces();
      throw makeEnoent();
    });
    const verdict = await evaluateChiefOfStaffAdmission(settings());
    expect(verdict).toEqual({ decision: 'block', reason: 'unreadable' });
  });

  it('LOCAL absent + onboarded → block missing-after-setup', async () => {
    mockReadFile.mockImplementation(async () => {
      throw makeEnoent();
    });
    const verdict = await evaluateChiefOfStaffAdmission(
      settings({ onboardingFirstCompletedAt: 1_700_000_000_000 }),
    );
    expect(verdict).toEqual({ decision: 'block', reason: 'missing-after-setup' });
  });

  it('rd3 F1 (RED→GREEN): GENUINELY-missing post-onboarding CoS (NO settings entry AND nothing on disk) → BLOCK missing-after-setup', async () => {
    // rd2 admitted this case (short-circuit on no-spaces-entry) → silently
    // templated a real user turn. The bounded resolver now scans the workspace
    // root (finds nothing — default empty readdir), falls back to the canonical
    // join, reads `absent`, and BLOCKS because the user is onboarded.
    mockReadFile.mockImplementation(async () => {
      throw makeEnoent();
    });
    const verdict = await evaluateChiefOfStaffAdmission(
      settings({ onboardingFirstCompletedAt: 1_700_000_000_000, spaces: [] }),
    );
    expect(verdict).toEqual({ decision: 'block', reason: 'missing-after-setup' });
  });

  it('rd3 F1: lowercased on-disk CoS dir NOT in settings.spaces → bounded scan RESOLVES it + reads (no false block)', async () => {
    // The folded case-sensitive-FS concern (native-F2): a lowercased
    // `chief-of-staff/` dropped out of `settings.spaces` (e.g. a dead-mount
    // reconcile). The bounded disk scan finds it → the README read succeeds → admit.
    mockReaddir.mockResolvedValue([dirent('chief-of-staff', 'dir')]);
    mockReadFile.mockImplementation(async (p: unknown) => {
      // README under the scan-resolved lowercased dir.
      if (String(p).endsWith(path.join('chief-of-staff', 'README.md'))) return '# CoS body';
      throw makeEnoent();
    });
    const verdict = await evaluateChiefOfStaffAdmission(
      settings({ onboardingFirstCompletedAt: 1_700_000_000_000, spaces: [] }),
    );
    expect(verdict).toEqual({ decision: 'admit', content: '# CoS body', outcome: 'ok' });
    // The resolver scanned the workspace root (no settings entry).
    expect(mockReaddir).toHaveBeenCalled();
  });

  it('rd4 F1 (RED→GREEN): scan-discovered chief-of-staff SYMLINK (NOT in settings.spaces) to a DEAD cloud mount → block reconnecting, NEVER bare fs.readFile', async () => {
    // The real dead-Drive case: a dead mount drops the CoS entry from
    // `settings.spaces`, leaving only a lowercased `chief-of-staff` SYMLINK on disk.
    // Containment is built from `settings.spaces` (empty here) so it doesn't know
    // about the symlink, and the workspace path `/workspace/chief-of-staff` is
    // pattern-LOCAL. BEFORE the fix the README read took the LOCAL bare-fs lane and
    // HUNG on the dead cloud target. The resolver now carries the scan-discovered-
    // symlink evidence forward (`forceCloud`) so the read is FORCED through the
    // killable cloud lane → `reconnecting` → block, and NEVER touches bare fs.
    mockReaddir.mockResolvedValue([dirent('chief-of-staff', 'symlink')]);
    // Dead-mount cloud executor: every cloud read times out → reconnecting.
    const cloudReads: string[] = [];
    setWorkspaceFsExecutor(
      realFsExecutorWith({
        readFile: async (p) => {
          cloudReads.push(p);
          return { ok: false, reason: 'timeout' };
        },
      }),
    );
    // If the read ever took the LOCAL lane it would call this; the README read must
    // NOT (the dir scan's readdir is the only legit local-lane call here).
    mockReadFile.mockImplementation(async (p: unknown) => {
      throw new Error(`bare fs.readFile MUST NOT be called on the dead symlink target: ${String(p)}`);
    });

    const verdict = await evaluateChiefOfStaffAdmission(
      settings({ onboardingFirstCompletedAt: 1_700_000_000_000, spaces: [] }),
    );

    expect(verdict).toEqual({ decision: 'block', reason: 'reconnecting' });
    // The README read went through the killable cloud lane (executor), not bare fs.
    expect(cloudReads).toEqual([path.join(LOCAL_CORE, 'chief-of-staff', 'README.md')]);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('LOCAL absent + NOT onboarded → admit (legit first-run)', async () => {
    mockReadFile.mockImplementation(async () => {
      throw makeEnoent();
    });
    const verdict = await evaluateChiefOfStaffAdmission(
      settings({ onboardingFirstCompletedAt: null }),
    );
    expect(verdict).toEqual({ decision: 'admit', outcome: 'absent' });
  });

  it('CLOUD reconnecting STRICTLY outranks the onboarding gate (onboarded → still reconnecting, NOT missing-after-setup)', async () => {
    setWorkspaceFsExecutor(
      realFsExecutorWith({ readFile: async () => ({ ok: false, reason: 'timeout' }) }),
    );
    const verdict = await evaluateChiefOfStaffAdmission(
      settings({
        coreDirectory: path.dirname(CLOUD_TARGET),
        spaces: [
          { name: 'Chief-of-Staff', path: 'Chief-of-Staff', type: 'chief-of-staff', isSymlink: true, createdAt: 1 },
        ],
        onboardingFirstCompletedAt: 1_700_000_000_000,
      }),
    );
    expect(verdict).toEqual({ decision: 'block', reason: 'reconnecting' });
  });

  it('CLOUD-classified CoS with NO executor wired takes the LOCAL lane (NO spurious reconnecting/block) — cross-surface (S4.1e final-review F1)', async () => {
    // dev's S4.1e final-review F1 (boundedWorkspaceFs commit 7346625139): with NO executor
    // wired — the cloud/mobile shape AND the desktop pre-bootstrap window — a cloud-classified
    // path reads LOCALLY (nothing to bound WITH, no FUSE mount to bound AGAINST), never a
    // spurious `reconnecting`. So the admission gate does NOT block here; it reads the local
    // lane and admits per the local outcome (here: README absent, not onboarded → legit
    // first-run admit). No hang — a local read can't park on a FUSE mount on these surfaces.
    // (This test previously asserted block/reconnecting; that encoded the cross-surface bug
    // dev fixed. The DESKTOP dead-mount → block/reconnecting guarantee is covered by the
    // wired-executor "reconnecting STRICTLY outranks the onboarding gate" test above.)
    mockReadFile.mockImplementation(async () => {
      throw makeEnoent();
    });
    const verdict = await evaluateChiefOfStaffAdmission(
      settings({
        coreDirectory: path.dirname(CLOUD_TARGET),
        spaces: [
          { name: 'Chief-of-Staff', path: 'Chief-of-Staff', type: 'chief-of-staff', isSymlink: true, createdAt: 1 },
        ],
        onboardingFirstCompletedAt: null,
      }),
    );
    expect(verdict).toEqual({ decision: 'admit', outcome: 'absent' });
  });

  it('no core directory → admit (missing-core-directory sibling gate owns that terminal)', async () => {
    const verdict = await evaluateChiefOfStaffAdmission(settings({ coreDirectory: null }));
    expect(verdict).toEqual({ decision: 'admit', outcome: 'absent' });
  });
});
