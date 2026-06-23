/**
 * Stage-5 cloud hang-proofing for buildSymlinkMap (GPT-F6 boot-hang vector).
 *
 * `buildSymlinkMap` runs SYNCHRONOUSLY at index init. The original code did
 * `realpathSync(entryPath)` on every symlink — and `realpathSync` into a dead cloud
 * FUSE mount blocks the boot thread with no try/catch rescue. The fix classifies
 * the symlink chain READLINK-ONLY first and SKIPS any symlink whose chain reaches a
 * cloud mount (never `realpathSync` into it); only NON-cloud symlinks are mapped.
 *
 * These tests use the real filesystem against a temp dir. A symlink whose TARGET
 * string matches the cloud pattern (`~/Library/CloudStorage/…`) is classified cloud
 * by the pure-string `detectCloudStorage` — so we can prove the skip WITHOUT a real
 * Drive (the target need not even exist; we never deref it, which is the point).
 */
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { buildSymlinkMap } from '../symlinkMap';

describe('buildSymlinkMap — Stage 5 cloud symlink skip', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rebel-symlinkmap-cloud-')));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('SKIPS a symlink whose target is a cloud mount (never realpathSync into it)', () => {
    const ws = path.join(tmpRoot, 'ws');
    mkdirSync(ws);
    // Target string matches the cloud pattern — and deliberately does NOT exist:
    // a correct readlink-only classification never dereferences it, so a missing
    // (dead-mount stand-in) target must NOT throw or hang, it must be SKIPPED.
    const cloudTarget = path.join(
      os.homedir(),
      'Library',
      'CloudStorage',
      'GoogleDrive-test@example.com',
      'Shared drives',
      'Company Memories',
    );
    symlinkSync(cloudTarget, path.join(ws, 'CompanyMemories'));

    const map = buildSymlinkMap(ws);
    // The cloud symlink is excluded from the map entirely.
    expect(map.find((m) => m.workspacePath === 'CompanyMemories')).toBeUndefined();
    expect(map).toHaveLength(0);
  });

  it('still maps a NON-cloud outside-workspace symlink (rebel-system → /Applications/… shape)', () => {
    const ws = path.join(tmpRoot, 'ws');
    mkdirSync(ws);
    // A real local target outside the workspace (the rebel-system carve-out shape).
    const localTarget = path.join(tmpRoot, 'outside-local');
    mkdirSync(localTarget);
    symlinkSync(localTarget, path.join(ws, 'rebel-system'));

    const map = buildSymlinkMap(ws);
    const mapped = map.find((m) => m.workspacePath === 'rebel-system');
    expect(mapped).toBeDefined();
    expect(mapped!.realPath).toBe(realpathSync(localTarget));
  });

  it('does NOT readdir a cloud-classified workspace ROOT (returns empty, no hang/throw)', () => {
    // A root string under CloudStorage classifies as cloud → the root guard returns
    // before readdirSync. The path need not exist (we never touch it).
    const cloudRoot = path.join(
      os.homedir(),
      'Library',
      'CloudStorage',
      'GoogleDrive-test@example.com',
      'dead-root',
    );
    const map = buildSymlinkMap(cloudRoot);
    expect(map).toHaveLength(0);
  });
});
