/**
 * Stage 1 (260622 render-preview-cloud-hang) — the operator-scanner per-file
 * `OPERATOR.md` read is on the LIVE turn path (`resolveSystemPrompt` →
 * `buildOperatorPromptMetadata` → scanOperators → parseOperatorFile). For a
 * cloud-backed space whose FUSE mount is dead, the raw unbounded `fs.readFile` used
 * to block the turn (MA1 hang class). The read is now routed through the killable
 * `workspaceFs` boundary: a dead cloud mount surfaces `reconnecting` → a DISTINCT,
 * calm per-file scan failure (errorCode `reconnecting`), the scan CONTINUES, and the
 * turn is never blocked.
 *
 * The directory WALK (`safeWalkDirectory`) is bounded separately and already governed,
 * so we drive it with a real local temp `operators/` tree that points at cloud-classified
 * operator FILE paths via a symlink — but simpler and deterministic here is to wire the
 * executor seam + a cloud-classified operator path and assert the failure shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('@core/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createScopedLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { scanOperators } = await import('../operatorScanner');
const { setWorkspaceFsExecutor, __resetWorkspaceFsExecutorForTesting } = await import(
  '../boundedWorkspaceFs'
);
const { realFsExecutorWith, deadMountExecutor } = await import('./workspaceFsExecutorDoubles');

const VALID_FRONTMATTER = [
  '---',
  'name: Synced Operator',
  'description: A fully synced operator with enough body content',
  'consult_when: Whenever',
  'kind: operator',
  '---',
  'This Operator has enough markdown body content to be treated as a fully synced file.',
  '',
].join('\n');

describe('operatorScanner — per-file OPERATOR.md read is hang-bounded', () => {
  let tempRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetWorkspaceFsExecutorForTesting();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-cloud-bound-'));
  });
  afterEach(async () => {
    __resetWorkspaceFsExecutorForTesting();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('a healthy LOCAL operator file is read and parsed (fast path, byte-content preserved)', async () => {
    const spacePath = path.join(tempRoot, 'Acme');
    const opDir = path.join(spacePath, 'operators', 'synced-op');
    await fs.mkdir(opDir, { recursive: true });
    await fs.writeFile(path.join(opDir, 'OPERATOR.md'), VALID_FRONTMATTER, 'utf-8');

    const result = await scanOperators([spacePath]);
    expect(result.failures).toEqual([]);
    expect(result.operators).toHaveLength(1);
    expect(result.operators[0].name).toBe('Synced Operator');
  });

  it('an OPERATOR.md on a DEAD cloud mount → distinct calm scan failure (reconnecting), scan continues, NO hang', async () => {
    // Build a real local operators/ tree (so the bounded WALK finds the file), but the
    // FILE itself lives at a cloud-classified path. We achieve a deterministic
    // cloud-classified operator file path by making the space root a ~/Library/CloudStorage
    // path that detectCloudStorage flags — the per-file read then forces the cloud lane.
    //
    // The walk needs the file to exist on disk, so we put a real local tree AND wire the
    // cloud-lane executor to time out for the operator file. We model the dead mount by
    // wiring an executor that times out on readFile; the read forces the cloud lane only
    // for cloud-classified paths, so we host the space under a CloudStorage-shaped dir.
    const cloudSpace = path.join(
      tempRoot,
      'Library',
      'CloudStorage',
      'GoogleDrive-user@example.com',
      'My Drive',
      'Chief-of-Staff',
    );
    const opDir = path.join(cloudSpace, 'operators', 'cloud-op');
    await fs.mkdir(opDir, { recursive: true });
    // The file exists on disk (so the local WALK admits it) but its CONTENT read takes
    // the cloud lane (cloud-classified path) → wired-dead executor → reconnecting.
    await fs.writeFile(path.join(opDir, 'OPERATOR.md'), VALID_FRONTMATTER, 'utf-8');

    setWorkspaceFsExecutor(
      realFsExecutorWith({
        readFile: async () => ({ ok: false, reason: 'timeout' }),
      }),
    );

    const result = await scanOperators([cloudSpace]);

    // No operator parsed (its read reconnected), but the scan returned a DISTINCT,
    // calm failure rather than hanging or silently dropping it.
    expect(result.operators).toHaveLength(0);
    const failure = result.failures.find((f) => f.errorCode === 'reconnecting');
    expect(failure).toBeDefined();
    expect(failure?.operatorSlug).toBe('cloud-op');
    // Calm copy, no raw path/email leaked.
    expect(failure?.message).toMatch(/reconnecting/i);
    expect(failure?.message).not.toContain('user@example.com');
  });

  // Phase-7 F1 (rd4-analogous): the directory-WALK ROOT realpath, not just the per-file
  // read. A scan-discovered Chief-of-Staff SYMLINK absent from `settings.spaces` resolves
  // to a pattern-LOCAL workspace path that containment never learned — so the walk root
  // realpath would take the bare-fs LOCAL lane and HANG on the dead cloud target. The
  // caller threads `forceCloudRoots` (the resolved space root) so the walk root realpath
  // takes the killable cloud lane → `cloud-timeout` → a calm `scan-truncated` failure.
  describe('walk-root realpath is hang-bounded via forceCloudRoots (F1)', () => {
    it('a pattern-LOCAL space root in forceCloudRoots → cloud-lane realpath → scan-truncated, NO hang', async () => {
      // A pattern-local space root (no cloud segment in the string). In production this is
      // a `Chief-of-Staff` symlink to a dead mount; here the dead executor models that the
      // root realpath wedges, and forceCloudRoots routes it to the killable cloud lane.
      const spacePath = path.join(tempRoot, 'workspace', 'chief-of-staff');
      const resolvedSpace = path.resolve(spacePath);

      setWorkspaceFsExecutor(deadMountExecutor);

      const result = await scanOperators([spacePath], new Set([resolvedSpace]));

      // The walk root realpath went through the cloud lane → cloud-timeout → the scan
      // surfaced a calm `scan-truncated` failure, not a hang or a silent drop.
      expect(result.operators).toHaveLength(0);
      const truncated = result.failures.find((f) => f.errorCode === 'scan-truncated');
      expect(truncated).toBeDefined();
      expect(truncated?.message).toMatch(/cloud-timeout/);
    });

    it('RED guard: WITHOUT forceCloudRoots the same pattern-local root takes the LOCAL lane (no cloud-timeout)', async () => {
      // Same root, NOT in forceCloudRoots: the walk root realpath takes the bare-fs LOCAL
      // lane (the unbounded-hang vector in production). Here the path simply doesn't exist
      // → real ENOENT → "missing root is empty" → no failures. Proves the default does NOT
      // route the walk root through the cloud lane, so the fix is load-bearing.
      const spacePath = path.join(tempRoot, 'workspace', 'chief-of-staff');
      setWorkspaceFsExecutor(deadMountExecutor);

      const result = await scanOperators([spacePath]);

      expect(result.operators).toHaveLength(0);
      expect(result.failures.find((f) => f.errorCode === 'scan-truncated')).toBeUndefined();
    });
  });

  // Phase-8 rd4 (the LAST fs op): the walk root realpath + readdir + per-entry stat all
  // SUCCEED (the operators/ tree exists on the real local disk), but the per-file CONTENT
  // read of OPERATOR.md times out. The space root is pattern-LOCAL (no cloud segment in the
  // string) and in `forceCloudRoots`. Before this fix the per-file content read keyed only
  // off `cloudLaneOptionForPath(file)` (the path STRING via `detectCloudStorage`), which is
  // `undefined` for a pattern-local path → the read took the bare-fs LOCAL lane and would
  // HANG on the dead cloud target even though the WALK was forced to the cloud lane. The
  // fix ORs `forceCloud: true` into the per-file read options when the space root is forced.
  describe('per-file OPERATOR.md content read is hang-bounded via forceCloudRoots (rd4 residual)', () => {
    it('forced pattern-local root: walk LISTS the file but the content read times out → cloud lane → reconnecting, NEVER bare local fs', async () => {
      // A pattern-local space root (no cloud segment in the string) with a REAL local
      // operators/ tree, so the forced walk's realpath/readdir/stat all succeed against
      // real fs (via realFsExecutorWith delegating to fs). Only the content readFile times
      // out — modelling a mount that lists fine but wedges on hydrating file content.
      const spacePath = path.join(tempRoot, 'workspace', 'chief-of-staff');
      const resolvedSpace = path.resolve(spacePath);
      const opDir = path.join(spacePath, 'operators', 'cos-op');
      await fs.mkdir(opDir, { recursive: true });
      await fs.writeFile(path.join(opDir, 'OPERATOR.md'), VALID_FRONTMATTER, 'utf-8');

      const readFileSpy = vi.fn(async () => ({ ok: false as const, reason: 'timeout' as const }));
      setWorkspaceFsExecutor(
        // Healthy walk ops (delegate to real fs so the tree is listed), wedged content read.
        realFsExecutorWith({ readFile: readFileSpy }),
      );

      const result = await scanOperators([spacePath], new Set([resolvedSpace]));

      // The per-file content read went through the CLOUD executor (the spy fired) and
      // timed out → a DISTINCT calm `reconnecting` scan failure; no operator parsed.
      expect(readFileSpy).toHaveBeenCalled();
      expect(result.operators).toHaveLength(0);
      const failure = result.failures.find((f) => f.errorCode === 'reconnecting');
      expect(failure).toBeDefined();
      expect(failure?.operatorSlug).toBe('cos-op');
      expect(failure?.message).toMatch(/reconnecting/i);
    });
  });
});
