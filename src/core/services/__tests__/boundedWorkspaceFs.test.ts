import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  workspaceFs,
  classifyWorkspacePath,
  cloudLaneOptionForPath,
  setWorkspaceFsExecutor,
  __resetWorkspaceFsExecutorForTesting,
  type WorkspaceFsExecutor,
  type WorkspaceFsExecResult,
} from '@core/services/boundedWorkspaceFs';
import {
  configureCloudSpaceContainment,
  __resetCloudSpaceContainmentForTests,
} from '@core/services/cloudSpaceContainment';
import { FS_TIMEOUT_CLOUD_MS } from '@core/utils/cloudStorageUtils';
import type { SpaceConfig } from '@shared/types/settings';

/** Build a stub executor whose every op resolves to the same result. */
function stubExecutor<T>(result: WorkspaceFsExecResult<T>): WorkspaceFsExecutor {
  const op = () => Promise.resolve(result as WorkspaceFsExecResult<never>);
  return {
    stat: op,
    lstat: op,
    realpath: op,
    readlink: op,
    readdir: op,
    readdirWithFileTypes: op,
    readFile: op,
    readFileBytes: op,
    access: op,
  } as unknown as WorkspaceFsExecutor;
}

const CLOUD_TARGET = '/private/var/CloudStorageTest/Library/CloudStorage/GoogleDrive-test@example.com/MySpace';

describe('boundedWorkspaceFs', () => {
  let tmp: string;
  let cloudLink: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'bounded-ws-fs-'));
    // A workspace symlink into a (dangling, never-touched) cloud path. readlink-only
    // classification matches the cloud pattern without dereferencing the target.
    cloudLink = path.join(tmp, 'CloudSpace');
    symlinkSync(CLOUD_TARGET, cloudLink);
    configureCloudSpaceContainment(tmp, [
      { path: 'CloudSpace', isSymlink: true } as unknown as SpaceConfig,
    ]);
  });

  afterEach(() => {
    __resetWorkspaceFsExecutorForTesting();
    __resetCloudSpaceContainmentForTests();
    vi.useRealTimers();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('classifyWorkspacePath', () => {
    it('classifies a path under a configured cloud space as cloud (workspace-symlink form)', () => {
      expect(classifyWorkspacePath(path.join(cloudLink, 'doc.md'))).toBe('cloud');
    });

    it('classifies the cloud space ROOT itself as cloud (S1 review F1 — exact-root)', () => {
      // The descent reads the space root directly; the trailing-slash prefix +
      // startsWith must not let the root fall through to bare fs.
      expect(classifyWorkspacePath(cloudLink)).toBe('cloud');
      expect(classifyWorkspacePath(CLOUD_TARGET)).toBe('cloud');
    });

    it('classifies a path under the resolved cloud target as cloud', () => {
      expect(classifyWorkspacePath(path.join(CLOUD_TARGET, 'nested', 'doc.md'))).toBe('cloud');
    });

    it('classifies a plain local workspace path as local', () => {
      expect(classifyWorkspacePath(path.join(tmp, 'localdir', 'x.md'))).toBe('local');
    });

    it('classifies everything local when no cloud space is configured', () => {
      __resetCloudSpaceContainmentForTests();
      expect(classifyWorkspacePath(path.join(cloudLink, 'doc.md'))).toBe('local');
    });
  });

  describe('local lane (bare fs fast path)', () => {
    it('stat() returns ok with a serializable WorkspaceStat for a real local file', async () => {
      const file = path.join(tmp, 'local.txt');
      writeFileSync(file, 'hello');
      const out = await workspaceFs.stat(file);
      expect(out.status).toBe('ok');
      if (out.status !== 'ok') throw new Error('unreachable');
      expect(out.lane).toBe('local');
      expect(out.value.isFile).toBe(true);
      expect(out.value.size).toBe(5);
      expect(typeof out.value.mtimeMs).toBe('number');
    });

    it('readFile() returns ok with the content', async () => {
      const file = path.join(tmp, 'local.txt');
      writeFileSync(file, 'contents-here');
      const out = await workspaceFs.readFile(file);
      expect(out).toEqual({ status: 'ok', lane: 'local', value: 'contents-here' });
    });

    it('surfaces a real fs error (ENOENT) as status:error with the code — never a hang', async () => {
      const out = await workspaceFs.stat(path.join(tmp, 'does-not-exist.txt'));
      expect(out.status).toBe('error');
      if (out.status !== 'error') throw new Error('unreachable');
      expect(out.lane).toBe('local');
      expect(out.error.code).toBe('ENOENT');
    });

    it('readdirWithFileTypes() returns serializable dirents', async () => {
      mkdirSync(path.join(tmp, 'sub'));
      writeFileSync(path.join(tmp, 'sub', 'a.txt'), 'a');
      const out = await workspaceFs.readdirWithFileTypes(path.join(tmp, 'sub'));
      expect(out.status).toBe('ok');
      if (out.status !== 'ok') throw new Error('unreachable');
      expect(out.value).toEqual([{ name: 'a.txt', isDirectory: false, isFile: true, isSymbolicLink: false }]);
    });

    it('readlink() returns ok with the stored symlink target for a local link', async () => {
      const target = path.join(tmp, 'target.txt');
      writeFileSync(target, 'x');
      const link = path.join(tmp, 'link.txt');
      symlinkSync(target, link);
      const out = await workspaceFs.readlink(link);
      expect(out.status).toBe('ok');
      if (out.status !== 'ok') throw new Error('unreachable');
      expect(out.lane).toBe('local');
      expect(out.value).toBe(target);
    });
  });

  describe('cloud lane (routed through the executor)', () => {
    it('returns ok with the executor value when the executor succeeds', async () => {
      setWorkspaceFsExecutor(
        stubExecutor({ ok: true, value: { mtimeMs: 1, ctimeMs: 1, size: 9, isDirectory: false, isFile: true, isSymbolicLink: false } }),
      );
      const out = await workspaceFs.stat(path.join(cloudLink, 'doc.md'));
      expect(out.status).toBe('ok');
      if (out.status !== 'ok') throw new Error('unreachable');
      expect(out.lane).toBe('cloud');
      expect(out.value.size).toBe(9);
    });

    it('maps an executor timeout to status:reconnecting (NOT absence/error)', async () => {
      setWorkspaceFsExecutor(stubExecutor({ ok: false, reason: 'timeout' }));
      const out = await workspaceFs.stat(path.join(cloudLink, 'doc.md'));
      expect(out.status).toBe('reconnecting');
      if (out.status !== 'reconnecting') throw new Error('unreachable');
      expect(out.path).toBe(path.join(cloudLink, 'doc.md'));
    });

    it('maps an executor fs error to status:error on the cloud lane', async () => {
      const error = Object.assign(new Error('boom'), { code: 'EACCES' }) as NodeJS.ErrnoException;
      setWorkspaceFsExecutor(stubExecutor({ ok: false, reason: 'error', error }));
      const out = await workspaceFs.realpath(path.join(cloudLink, 'doc.md'));
      expect(out.status).toBe('error');
      if (out.status !== 'error') throw new Error('unreachable');
      expect(out.lane).toBe('cloud');
      expect(out.error.code).toBe('EACCES');
    });

    it('with NO executor wired, a cloud-classified path takes the LOCAL bare-fs lane (NOT reconnecting) — cross-surface byte-identical (S4.1e final-review F1)', async () => {
      // No `setWorkspaceFsExecutor` call → no executor wired (the cloud/mobile shape, and
      // the desktop pre-bootstrap window). With nothing to bound the read WITH — and no
      // FUSE mount to bound AGAINST on those surfaces — the boundary must read via the
      // LOCAL lane (bare fsp), byte-identical, NOT degrade to a spurious `reconnecting`.
      // (Previously this asserted `reconnecting`; that encoded the cross-surface bug the
      // final review flagged — on the Linux cloud server a `…/CloudStorage/…`-shaped path
      // is genuinely local.) Here `cloudLink` is a DANGLING symlink, so the real local
      // read surfaces a hard fs `error` (ENOENT), exactly as bare fs would — proving the
      // local lane (not the cloud executor) handled it.
      const out = await workspaceFs.readFile(path.join(cloudLink, 'doc.md'));
      expect(out.status).toBe('error');
      if (out.status !== 'error') throw new Error('unreachable');
      expect(out.lane).toBe('local');
      expect(out.error.code).toBe('ENOENT');
    });

    it('NEVER hangs the caller: a wedged (never-resolving) executor resolves reconnecting at the backstop', async () => {
      vi.useFakeTimers();
      setWorkspaceFsExecutor({
        stat: () => new Promise(() => {}), // never resolves
      } as unknown as WorkspaceFsExecutor);
      const pending = workspaceFs.stat(path.join(cloudLink, 'doc.md'));
      await vi.advanceTimersByTimeAsync(FS_TIMEOUT_CLOUD_MS + 5_000);
      const out = await pending;
      expect(out.status).toBe('reconnecting');
    });

    it('routes a binary read (readFileBytes) through the executor and returns the buffer', async () => {
      const buf = Buffer.from([1, 2, 3]);
      setWorkspaceFsExecutor(stubExecutor({ ok: true, value: buf }));
      const out = await workspaceFs.readFileBytes(path.join(cloudLink, 'image.png'));
      expect(out.status).toBe('ok');
      if (out.status !== 'ok') throw new Error('unreachable');
      expect(out.value).toEqual(buf);
    });

    it('routes readlink through the executor (S3 review F1 — the link inode is on the mount)', async () => {
      // A cloud symlink's own inode lives ON the mount, so readlink must be bounded.
      setWorkspaceFsExecutor(stubExecutor({ ok: false, reason: 'timeout' }));
      const out = await workspaceFs.readlink(path.join(cloudLink, 'link'));
      expect(out.status).toBe('reconnecting');
    });

    it('returns ok with the executor-resolved symlink target', async () => {
      setWorkspaceFsExecutor(stubExecutor({ ok: true, value: '/some/cloud/target' }));
      const out = await workspaceFs.readlink(path.join(cloudLink, 'link'));
      expect(out).toEqual({ status: 'ok', lane: 'cloud', value: '/some/cloud/target' });
    });

    it('forceCloud routes a LOCAL-classified path through the cloud executor (S4 review R-MUST-2)', async () => {
      setWorkspaceFsExecutor(stubExecutor({ ok: false, reason: 'timeout' }));
      // A path NOT under any configured cloud space → classifies 'local' by default.
      const localPath = path.join(tmp, 'plain-local.txt');
      expect(classifyWorkspacePath(localPath)).toBe('local');
      // Default: local lane → bare fs → ENOENT error (NOT routed to the executor).
      const def = await workspaceFs.stat(localPath);
      expect(def.status).toBe('error');
      // forceCloud: cloud lane → the (reconnecting) executor, proving the override.
      const forced = await workspaceFs.stat(localPath, { forceCloud: true });
      expect(forced.status).toBe('reconnecting');
    });

    it('cross-surface (S4.1e final-review F1): forceCloud is a NO-OP with NO executor — reads LOCAL (ok), but routes cloud once an executor is wired', async () => {
      // A real local file whose path matches the `detectCloudStorage` pattern (a `/Dropbox/`
      // segment) — i.e. what `cloudLaneOptionForPath` would flag forceCloud. On the cloud/
      // mobile shape (no executor) this is a genuinely-local file, so it MUST read via the
      // bare-fs LOCAL lane and return `ok`, NOT a spurious `reconnecting`.
      const dropboxDir = path.join(tmp, 'Dropbox', 'ws');
      mkdirSync(dropboxDir, { recursive: true });
      const file = path.join(dropboxDir, 'note.md');
      writeFileSync(file, 'local content');
      expect(cloudLaneOptionForPath(file)).toEqual({ forceCloud: true });

      // No executor wired (afterEach reset leaves it unwired): LOCAL lane → ok.
      const localOut = await workspaceFs.readFile(file, 'utf8', { forceCloud: true });
      expect(localOut.status).toBe('ok');
      if (localOut.status !== 'ok') throw new Error('unreachable');
      expect(localOut.lane).toBe('local');
      expect(localOut.value).toBe('local content');

      // Desktop shape: once an executor IS wired, forceCloud routes the cloud lane again
      // (so the dead-mount protection remains on desktop).
      setWorkspaceFsExecutor(stubExecutor({ ok: false, reason: 'timeout' }));
      const cloudOut = await workspaceFs.readFile(file, 'utf8', { forceCloud: true });
      expect(cloudOut.status).toBe('reconnecting');
    });

    // DA-F1: the boundary must NEVER throw even when the executor violates its
    // "never rejects" contract — it fails closed to reconnecting (observable).
    it('fails closed to reconnecting when the executor REJECTS (contract violation)', async () => {
      setWorkspaceFsExecutor({
        stat: () => Promise.reject(new Error('child crashed mid-flight')),
      } as unknown as WorkspaceFsExecutor);
      const out = await workspaceFs.stat(path.join(cloudLink, 'doc.md'));
      expect(out.status).toBe('reconnecting');
    });

    it('fails closed to reconnecting when the executor THROWS synchronously', async () => {
      setWorkspaceFsExecutor({
        stat: () => {
          throw new Error('sync boom');
        },
      } as unknown as WorkspaceFsExecutor);
      const out = await workspaceFs.stat(path.join(cloudLink, 'doc.md'));
      expect(out.status).toBe('reconnecting');
    });

    it('fails closed to reconnecting when the executor returns a malformed result', async () => {
      setWorkspaceFsExecutor({
        stat: () => Promise.resolve(undefined),
      } as unknown as WorkspaceFsExecutor);
      const out = await workspaceFs.stat(path.join(cloudLink, 'doc.md'));
      expect(out.status).toBe('reconnecting');
    });

    it('honors a tighter per-call timeoutMs budget (DA-F8) — releases reconnecting early', async () => {
      vi.useFakeTimers();
      setWorkspaceFsExecutor({
        stat: () => new Promise(() => {}), // never resolves
      } as unknown as WorkspaceFsExecutor);
      const pending = workspaceFs.stat(path.join(cloudLink, 'doc.md'), { timeoutMs: 3_000 });
      // Advance only past the tight 3s budget (well under the default ~17s backstop).
      await vi.advanceTimersByTimeAsync(3_100);
      const out = await pending;
      expect(out.status).toBe('reconnecting');
    });
  });
});

describe('cloudLaneOptionForPath (pattern → forced cloud lane bridge)', () => {
  it('returns { forceCloud: true } for a cloud-pattern path (detectCloudStorage)', () => {
    expect(
      cloudLaneOptionForPath('/Users/x/Library/CloudStorage/[external-email]/My/doc.md'),
    ).toEqual({ forceCloud: true });
  });

  it('returns undefined for a plain local path (boundary containment default applies)', () => {
    expect(cloudLaneOptionForPath('/Users/x/Documents/notes/doc.md')).toBeUndefined();
  });
});
