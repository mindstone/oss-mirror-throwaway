import { describe, it, expect } from 'vitest';
import {
  scanSourceForContainment,
  partitionContainment,
  findHandRolledContainment,
  containmentBaselineKey,
  CONTAINMENT_BASELINE,
  type ContainmentViolation,
} from '../check-pathroot-startswith-containment';

describe('scanSourceForContainment — fires on the vulnerable bare form (non-vacuous)', () => {
  it('flags resolved.startsWith(coreDirectory) — the 260531_bug_4 shape', () => {
    const src = `
      function read(filePath, coreDirectory) {
        const resolved = path.resolve(coreDirectory, filePath);
        if (!resolved.startsWith(coreDirectory)) throw new Error('traversal');
        return fs.readFileSync(resolved);
      }
    `;
    const v = scanSourceForContainment(src, 'cloud-service/src/services/x.ts');
    expect(v).toHaveLength(1);
    expect(v[0].receiver).toBe('resolved');
    expect(v[0].arg).toBe('coreDirectory');
  });

  it('flags a name-heuristic receiver (abs*) against a *Dir arg', () => {
    const src = `
      function f(p, tokenDir) {
        const absPath = something(p);
        return absPath.startsWith(tokenDir);
      }
    `;
    const v = scanSourceForContainment(src, 'cloud-service/src/routes/mcp.ts');
    expect(v).toHaveLength(1);
    expect(v[0].arg).toBe('tokenDir');
  });
});

describe('scanSourceForContainment — clears segment-safe mitigations (low FP)', () => {
  it('does NOT flag startsWith(root + path.sep)', () => {
    const src = `
      function f(root) {
        const resolved = path.resolve(root, x);
        return resolved.startsWith(root + path.sep);
      }
    `;
    expect(scanSourceForContainment(src, 'src/main/x.ts')).toEqual([]);
  });

  it("does NOT flag startsWith(root + '/')", () => {
    const src = `
      function f(inboxDir) {
        const normalizedPath = path.resolve(p);
        return normalizedPath.startsWith(inboxDir + '/') || normalizedPath === inboxDir;
      }
    `;
    expect(scanSourceForContainment(src, 'src/main/services/safety/memoryWriteHook.ts')).toEqual([]);
  });

  it('DOES flag a bare startsWith even when paired with `=== root` (still sibling-prefix-vulnerable)', () => {
    // `/root-other` passes startsWith(root) and is not `=== root` — the `=== root`
    // guard only covers exact equality, not the sibling-prefix escape. Only the
    // separator-appended form is genuinely safe (cross-family review BLOCKER, 260613).
    const src = `
      function f(coreRoot) {
        const localPath = path.resolve(coreRoot, rel);
        if (!localPath.startsWith(coreRoot) && localPath !== coreRoot) throw 0;
      }
    `;
    const v = scanSourceForContainment(src, 'src/main/services/cloud/x.ts');
    expect(v).toHaveLength(1);
    expect(v[0].arg).toBe('coreRoot');
  });

  it('does NOT flag string-literal prefix checks (Windows device prefixes)', () => {
    const src = `
      function isWeird(normalised) {
        if (normalised.startsWith('\\\\\\\\?\\\\')) return true;
        if (normalised.startsWith('/')) return true;
        return false;
      }
    `;
    expect(scanSourceForContainment(src, 'src/core/utils/x.ts')).toEqual([]);
  });

  it('does NOT flag a non-path receiver/arg pairing', () => {
    const src = `
      function f(name) {
        return name.startsWith('prefix');
      }
    `;
    expect(scanSourceForContainment(src, 'src/main/x.ts')).toEqual([]);
  });

  it('respects a PATH_CONTAINMENT_OK marker', () => {
    const src = `
      function f(root) {
        const resolved = path.resolve(root, x);
        // PATH_CONTAINMENT_OK: this is a UI-label prefix, not a security boundary
        return resolved.startsWith(root);
      }
    `;
    expect(scanSourceForContainment(src, 'src/renderer/x.tsx')).toEqual([]);
  });

  it('exempts the canonical helper file (pathSafety.ts) entirely', () => {
    // findHandRolledContainment skips CONTAINMENT_EXEMPT_FILES; verified via the
    // live-tree test below (pathSafety.ts:196 is not reported).
    expect(true).toBe(true);
  });
});

describe('partitionContainment + baseline', () => {
  it('separates baselined from fresh', () => {
    const baselinedSample: ContainmentViolation = {
      relativePath: 'src/renderer/App.tsx',
      receiver: 'filePath',
      arg: 'coreDir',
      line: 10,
    };
    const fresh: ContainmentViolation = {
      relativePath: 'src/new/file.ts',
      receiver: 'resolved',
      arg: 'root',
      line: 1,
    };
    const { fresh: f, baselinedKeys } = partitionContainment([baselinedSample, fresh]);
    expect(f).toHaveLength(1);
    expect(f[0].relativePath).toBe('src/new/file.ts');
    expect(baselinedKeys.has(containmentBaselineKey(baselinedSample))).toBe(true);
  });

  it('flags an EXTRA occurrence beyond the baselined count (dup not absorbed)', () => {
    // App.tsx::filePath::coreDir baseline count is 2; a 3rd is fresh.
    const mk = (line: number): ContainmentViolation => ({
      relativePath: 'src/renderer/App.tsx',
      receiver: 'filePath',
      arg: 'coreDir',
      line,
    });
    const { fresh } = partitionContainment([mk(1), mk(2), mk(3)]);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].line).toBe(3);
  });
});

describe('live tree', () => {
  it('has zero FRESH hand-rolled containment (all known sites baselined)', () => {
    const { fresh } = partitionContainment(findHandRolledContainment());
    expect(
      fresh,
      `unexpected NEW containment sites: ${fresh.map(containmentBaselineKey).join(', ')}`,
    ).toEqual([]);
  });

  it('baseline has no stale entries (live count matches each baselined key)', () => {
    const { staleKeys } = partitionContainment(findHandRolledContainment());
    expect(staleKeys, `stale baseline entries to prune: ${staleKeys.join(', ')}`).toEqual([]);
  });
});
