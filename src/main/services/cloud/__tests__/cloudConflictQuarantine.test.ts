import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Stub the logger so we can assert observable corruption handling without
// depending on the real pino sink. The store calls createScopedLogger() at
// module load, so the mock must return a stable object whose methods we spy on.
const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    warn: warnSpy,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// getDataPath() is only used when no persist-path override is set; we always set
// the override in tests, but stub it so module load never touches Electron.
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-conflict-quarantine-unused',
}));

import {
  _resetQuarantinedWorkspaceConflictsForTesting,
  isPathWithinQuarantineRoot,
  listQuarantinedWorkspaceConflicts,
  quarantineWorkspaceCloudConflict,
  removeQuarantinedWorkspaceConflict,
} from '../cloudConflictQuarantine';

let tmpRoot: string;
let indexPath: string;
const WORKSPACE = '/some/workspace';

beforeEach(() => {
  warnSpy.mockClear();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-test-'));
  // The store derives the quarantine root from path.dirname(indexPath).
  indexPath = path.join(tmpRoot, 'cloud-workspace-conflicts', 'index.json');
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  _resetQuarantinedWorkspaceConflictsForTesting(indexPath);
});

afterEach(() => {
  _resetQuarantinedWorkspaceConflictsForTesting(null);
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('cloudConflictQuarantine — atomic persist', () => {
  it('persists the index atomically and leaves no temp file behind', () => {
    quarantineWorkspaceCloudConflict({
      coreDirectory: WORKSPACE,
      relativePath: 'notes/a.md',
      localPath: path.join(WORKSPACE, 'notes/a.md'),
      content: 'cloud bytes',
    });

    expect(fs.existsSync(indexPath)).toBe(true);
    const dirEntries = fs.readdirSync(path.dirname(indexPath));
    // No `.rebel-cloud-pull.tmp` residue from the atomic write.
    expect(dirEntries.some((name) => name.includes('.rebel-cloud-pull.tmp'))).toBe(false);

    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as unknown[];
    expect(parsed).toHaveLength(1);
  });

  it('round-trips a quarantined conflict across a simulated restart', () => {
    quarantineWorkspaceCloudConflict({
      coreDirectory: WORKSPACE,
      relativePath: 'notes/a.md',
      localPath: path.join(WORKSPACE, 'notes/a.md'),
      content: 'cloud bytes',
    });

    // Simulate restart: drop in-memory state, keep the persisted index.
    _resetQuarantinedWorkspaceConflictsForTesting(indexPath);

    const listed = listQuarantinedWorkspaceConflicts(WORKSPACE);
    expect(listed).toHaveLength(1);
    expect(listed[0].relativePath).toBe('notes/a.md');
    expect(fs.readFileSync(listed[0].cloudCopyPath, 'utf8')).toBe('cloud bytes');
  });
});

describe('cloudConflictQuarantine — corrupt-index resilience', () => {
  it('preserves a corrupt index aside (does not silently drop recovery) and logs it', () => {
    // Quarantine a real conflict so the BYTES exist on disk.
    const entry = quarantineWorkspaceCloudConflict({
      coreDirectory: WORKSPACE,
      relativePath: 'notes/a.md',
      localPath: path.join(WORKSPACE, 'notes/a.md'),
      content: 'cloud bytes',
    });
    expect(fs.existsSync(entry.cloudCopyPath)).toBe(true);

    // Corrupt the index on disk, then simulate restart.
    fs.writeFileSync(indexPath, '{ this is not valid json', 'utf8');
    _resetQuarantinedWorkspaceConflictsForTesting(indexPath);

    // Loading triggers the corrupt-index path.
    const listed = listQuarantinedWorkspaceConflicts(WORKSPACE);
    // The map is cleared (we can't trust the corrupt index) ...
    expect(listed).toHaveLength(0);

    // ... but the corrupt index is PRESERVED aside, not deleted ...
    const preserved = fs
      .readdirSync(path.dirname(indexPath))
      .filter((name) => name.startsWith('index.json.corrupt-'));
    expect(preserved).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(indexPath), preserved[0]), 'utf8')).toBe(
      '{ this is not valid json',
    );

    // ... and the quarantined BYTES are still on disk (recoverable) ...
    expect(fs.existsSync(entry.cloudCopyPath)).toBe(true);

    // ... and the corruption was observable (logged).
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ storePath: indexPath }),
      expect.stringContaining('Quarantine index corrupt'),
    );
  });

  it('clears the map when the index is valid JSON but not an array, preserving + logging', () => {
    quarantineWorkspaceCloudConflict({
      coreDirectory: WORKSPACE,
      relativePath: 'notes/a.md',
      localPath: path.join(WORKSPACE, 'notes/a.md'),
      content: 'cloud bytes',
    });

    fs.writeFileSync(indexPath, JSON.stringify({ not: 'an array' }), 'utf8');
    _resetQuarantinedWorkspaceConflictsForTesting(indexPath);

    expect(listQuarantinedWorkspaceConflicts(WORKSPACE)).toHaveLength(0);
    const preserved = fs
      .readdirSync(path.dirname(indexPath))
      .filter((name) => name.startsWith('index.json.corrupt-'));
    expect(preserved).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('cloudConflictQuarantine — path-safety on read/remove', () => {
  it('isPathWithinQuarantineRoot rejects paths outside the quarantine root', () => {
    const root = path.dirname(indexPath);
    expect(isPathWithinQuarantineRoot(path.join(root, 'abc123', 'a.conflict-cloud.md'))).toBe(true);
    expect(isPathWithinQuarantineRoot('/etc/passwd')).toBe(false);
    expect(isPathWithinQuarantineRoot(path.join(root, '..', 'escape.md'))).toBe(false);
  });

  it('does not unlink a cloudCopyPath that escaped the quarantine root', () => {
    // A sentinel file OUTSIDE the quarantine root must never be removed.
    const sentinel = path.join(tmpRoot, 'sentinel-outside.md');
    fs.writeFileSync(sentinel, 'precious', 'utf8');

    // Hand-write a tampered index pointing cloudCopyPath at the sentinel.
    const tampered = [
      {
        coreDirectory: path.resolve(WORKSPACE),
        localPath: path.join(WORKSPACE, 'notes/a.md'),
        cloudCopyPath: sentinel,
        relativePath: 'notes/a.md',
        createdAt: Date.now(),
      },
    ];
    fs.writeFileSync(indexPath, JSON.stringify(tampered), 'utf8');
    _resetQuarantinedWorkspaceConflictsForTesting(indexPath);

    // list() drops the unsafe entry (and logs) ...
    expect(listQuarantinedWorkspaceConflicts(WORKSPACE)).toHaveLength(0);

    // remove() must NOT delete the sentinel even if the entry survived listing.
    _resetQuarantinedWorkspaceConflictsForTesting(indexPath);
    removeQuarantinedWorkspaceConflict(WORKSPACE, 'notes/a.md');
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('precious');
  });

  it('removes a legitimate quarantined copy under the quarantine root', () => {
    const entry = quarantineWorkspaceCloudConflict({
      coreDirectory: WORKSPACE,
      relativePath: 'notes/a.md',
      localPath: path.join(WORKSPACE, 'notes/a.md'),
      content: 'cloud bytes',
    });
    expect(fs.existsSync(entry.cloudCopyPath)).toBe(true);

    expect(removeQuarantinedWorkspaceConflict(WORKSPACE, 'notes/a.md')).toBe(true);
    expect(fs.existsSync(entry.cloudCopyPath)).toBe(false);
    expect(listQuarantinedWorkspaceConflicts(WORKSPACE)).toHaveLength(0);
  });
});
