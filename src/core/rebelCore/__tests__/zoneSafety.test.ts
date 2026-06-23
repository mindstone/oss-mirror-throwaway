import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalizeZoneRoot,
  verifyNoSymlinkEscape,
} from '../tools/zoneSafety';
import {
  setWorkspaceFsExecutor,
  __resetWorkspaceFsExecutorForTesting,
  type WorkspaceFsExecutor,
  type WorkspaceFsExecResult,
} from '@core/services/boundedWorkspaceFs';
import {
  configureCloudSpaceContainment,
  __resetCloudSpaceContainmentForTests,
} from '@core/services/cloudSpaceContainment';
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

describe('zoneSafety', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'zone-safety-')));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('canonicalizeZoneRoot', () => {
    it('returns the realpath for an existing path', async () => {
      const result = await canonicalizeZoneRoot(tmpDir);
      expect(result).toBe(tmpDir);
    });

    it('returns a resolved path when the tail does not exist yet', async () => {
      const phantom = path.join(tmpDir, 'does', 'not', 'exist');
      const result = await canonicalizeZoneRoot(phantom);
      expect(result.startsWith(tmpDir)).toBe(true);
      expect(result.endsWith(path.join('does', 'not', 'exist'))).toBe(true);
    });
  });

  describe('verifyNoSymlinkEscape', () => {
    it('accepts a path that resolves inside the workspace', async () => {
      const inside = path.join(tmpDir, 'file.txt');
      await fs.writeFile(inside, 'hello');
      await expect(verifyNoSymlinkEscape(inside, { cwd: tmpDir })).resolves.toBeUndefined();
    });

    it('rejects a symlink that escapes the workspace', async () => {
      const escapeTarget = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'zone-escape-')),
      );
      try {
        const linkPath = path.join(tmpDir, 'escape');
        await fs.symlink(escapeTarget, linkPath);
        await expect(
          verifyNoSymlinkEscape(linkPath, { cwd: tmpDir }),
        ).rejects.toThrow(/symbolic link|outside allowed zones/i);
      } finally {
        await fs.rm(escapeTarget, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('accepts a symlink whose target is in allowedSymlinkTargets', async () => {
      const allowed = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'zone-allowed-')),
      );
      try {
        const linkPath = path.join(tmpDir, 'allowed-link');
        await fs.symlink(allowed, linkPath);
        await expect(
          verifyNoSymlinkEscape(linkPath, {
            cwd: tmpDir,
            allowedSymlinkTargets: [allowed],
          }),
        ).resolves.toBeUndefined();
      } finally {
        await fs.rm(allowed, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('accepts a path under ~/mcp-servers when homePath is provided', async () => {
      const home = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'zone-home-')),
      );
      try {
        const mcpProject = path.join(home, 'mcp-servers', 'foo-mcp');
        await fs.mkdir(mcpProject, { recursive: true });
        const file = path.join(mcpProject, 'package.json');
        await fs.writeFile(file, '{}');
        await expect(
          verifyNoSymlinkEscape(file, { cwd: tmpDir, homePath: home }),
        ).resolves.toBeUndefined();
      } finally {
        await fs.rm(home, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('accepts a missing-tail path inside the workspace', async () => {
      const phantom = path.join(tmpDir, 'phantom', 'child.txt');
      await expect(verifyNoSymlinkEscape(phantom, { cwd: tmpDir })).resolves.toBeUndefined();
    });
  });

  // S3: the realpath checks route through the bounded workspace-fs boundary so a
  // dead cloud mount can never hang this turn-path security guard. A `reconnecting`
  // outcome MUST fail closed (deny) — we never authorise a path whose physical
  // identity we cannot verify.
  describe('cloud lane — bounded + fail-closed on reconnecting', () => {
    let cloudLink: string;

    beforeEach(() => {
      // A workspace symlink into a (dangling, never-touched) cloud path. The
      // readlink-only containment classifies it cloud without dereferencing.
      cloudLink = path.join(tmpDir, 'CloudSpace');
      symlinkSync(CLOUD_TARGET, cloudLink);
      configureCloudSpaceContainment(tmpDir, [
        { path: 'CloudSpace', isSymlink: true } as unknown as SpaceConfig,
      ]);
    });

    afterEach(() => {
      __resetWorkspaceFsExecutorForTesting();
      __resetCloudSpaceContainmentForTests();
    });

    it('verifyNoSymlinkEscape FAILS CLOSED (throws) when a cloud candidate is reconnecting', async () => {
      setWorkspaceFsExecutor(stubExecutor({ ok: false, reason: 'timeout' }));
      await expect(
        verifyNoSymlinkEscape(path.join(cloudLink, 'doc.md'), { cwd: tmpDir }),
      ).rejects.toThrow(/cannot verify filesystem identity.*reconnecting/i);
    });

    it('canonicalizeZoneRoot FAILS CLOSED (throws) when a cloud root is reconnecting', async () => {
      setWorkspaceFsExecutor(stubExecutor({ ok: false, reason: 'timeout' }));
      await expect(
        canonicalizeZoneRoot(path.join(cloudLink, 'sub')),
      ).rejects.toThrow(/cannot canonicalize zone root.*reconnecting/i);
    });

    it('verifyNoSymlinkEscape FAILS CLOSED on a non-ENOENT cloud fs error (preserved)', async () => {
      const error = Object.assign(new Error('permission denied'), { code: 'EACCES' }) as NodeJS.ErrnoException;
      setWorkspaceFsExecutor(stubExecutor({ ok: false, reason: 'error', error }));
      await expect(
        verifyNoSymlinkEscape(path.join(cloudLink, 'doc.md'), { cwd: tmpDir }),
      ).rejects.toThrow(/cannot verify filesystem identity/i);
    });

    it('ENOENT on the cloud lane walks up to the local zone and accepts (preserved walk-up)', async () => {
      // Executor returns ENOENT for every cloud op; the ascent crosses out of the
      // cloud space into the real (local) workspace root, which exists → accept.
      const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
      setWorkspaceFsExecutor(stubExecutor({ ok: false, reason: 'error', error: enoent }));
      await expect(
        verifyNoSymlinkEscape(path.join(cloudLink, 'missing', 'child.txt'), { cwd: tmpDir }),
      ).resolves.toBeUndefined();
    });

    it('accepts a live cloud path via the allowedSymlinkTargets carve-out (mount alive)', async () => {
      // Simulate symlink resolution: the in-workspace cloud path realpaths to the
      // EXTERNAL trusted target, which is outside the workspace root but explicitly
      // allowed. Proves the carve-out still works through the boundary.
      const aliveCloudExecutor = {
        ...stubExecutor({ ok: true, value: '' as unknown }),
        realpath: (p: string): Promise<WorkspaceFsExecResult<string>> => {
          const rel = path.relative(cloudLink, p);
          if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
            return Promise.resolve({ ok: true, value: path.join(CLOUD_TARGET, rel) });
          }
          return Promise.resolve({ ok: true, value: p }); // root resolves to itself
        },
      } as unknown as WorkspaceFsExecutor;
      setWorkspaceFsExecutor(aliveCloudExecutor);
      await expect(
        verifyNoSymlinkEscape(path.join(cloudLink, 'doc.md'), {
          cwd: tmpDir,
          allowedSymlinkTargets: [CLOUD_TARGET],
        }),
      ).resolves.toBeUndefined();
    });

    it('REJECTS a live cloud path that escapes to a target NOT in allowedSymlinkTargets (S3 review F-NIT)', async () => {
      // The mount is alive (realpath returns ok) but the path resolves OUTSIDE every
      // zone and every trusted target → the symlink-escape guard must still reject
      // through the boundary. This exercises the cloud-lane REJECT arm directly.
      setWorkspaceFsExecutor({
        ...stubExecutor({ ok: true, value: '' as unknown }),
        realpath: (p: string): Promise<WorkspaceFsExecResult<string>> => {
          const rel = path.relative(cloudLink, p);
          if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
            return Promise.resolve({ ok: true, value: path.join('/etc/evil', rel) });
          }
          return Promise.resolve({ ok: true, value: p });
        },
      } as unknown as WorkspaceFsExecutor);
      await expect(
        verifyNoSymlinkEscape(path.join(cloudLink, 'passwd'), {
          cwd: tmpDir,
          allowedSymlinkTargets: [CLOUD_TARGET], // does NOT contain /etc/evil
        }),
      ).rejects.toThrow(/outside allowed zones|symbolic link/i);
    });

    it('accepts via a HEALTHY trusted target even when a SIBLING target is reconnecting (S3 review SHOULD-1)', async () => {
      // Per-target guard: a reconnecting trusted target earlier in the list must be
      // SKIPPED (not abort the whole check) so a path belonging to a healthy target
      // still verifies.
      const RECONNECTING_SUB = path.join(CLOUD_TARGET, 'reconnecting-sub');
      setWorkspaceFsExecutor({
        ...stubExecutor({ ok: true, value: '' as unknown }),
        realpath: (p: string): Promise<WorkspaceFsExecResult<string>> => {
          if (p === RECONNECTING_SUB) {
            return Promise.resolve({ ok: false, reason: 'timeout' } as WorkspaceFsExecResult<string>);
          }
          const rel = path.relative(cloudLink, p);
          if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
            return Promise.resolve({ ok: true, value: path.join(CLOUD_TARGET, rel) });
          }
          return Promise.resolve({ ok: true, value: p }); // CLOUD_TARGET → identity
        },
      } as unknown as WorkspaceFsExecutor);
      await expect(
        verifyNoSymlinkEscape(path.join(cloudLink, 'doc.md'), {
          cwd: tmpDir,
          allowedSymlinkTargets: [RECONNECTING_SUB, CLOUD_TARGET],
        }),
      ).resolves.toBeUndefined();
    });
  });
});
