import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  findBoundaryViolations,
  findSetupEagerBoundaryImports,
  resolveSetupImportSpecifier,
  SETUP_FORBIDDEN_EAGER_FILES,
  BOUNDARY_LOCAL_EXEMPT_MARKER,
  BOUNDARY_BOUNDED_EXEMPT_MARKER,
  BOUNDARY_GOVERNED_FILES,
  FORBIDDEN_SYNC_PRIMITIVES,
  FORBIDDEN_ASYNC_METHODS,
  FS_RECEIVER_ALIASES,
} from '../check-workspace-fs-boundary';

const GOVERNED = 'src/main/services/mcpService.ts';

describe('check-workspace-fs-boundary (SYNTHESIS S1/S3 boundary gate)', () => {
  it('catches a planted async fs.stat / fsp.readdir / fs.promises.realpath call', () => {
    const src = [
      'const a = await fs.stat(p);',
      'const b = await fsp.readdir(dir);',
      'const c = await fs.promises.realpath(p);',
    ].join('\n');
    const violations = findBoundaryViolations(src, GOVERNED);
    const symbols = violations.map((v) => v.symbol).sort();
    expect(symbols).toEqual(['fs.readdir', 'fs.realpath', 'fs.stat']);
  });

  it('catches a planted bare statSync and a qualified fs.readFileSync', () => {
    const src = ['const s = statSync(target);', 'const r = fs.readFileSync(p, "utf8");'].join('\n');
    const violations = findBoundaryViolations(src, GOVERNED);
    const symbols = violations.map((v) => v.symbol).sort();
    expect(symbols).toEqual(['readFileSync', 'statSync']);
  });

  it('catches a destructured forbidden import from an fs module (enables a bare call)', () => {
    const src = "import { stat, readdir } from 'node:fs/promises';";
    const violations = findBoundaryViolations(src, GOVERNED);
    const symbols = violations.map((v) => v.symbol).sort();
    expect(symbols).toEqual([
      "import { readdir } from 'node:fs/promises'",
      "import { stat } from 'node:fs/promises'",
    ]);
  });

  it('handles an aliased destructured forbidden import (`stat as fsStat`)', () => {
    const src = "import { stat as fsStat } from 'fs/promises';";
    const violations = findBoundaryViolations(src, GOVERNED);
    expect(violations).toHaveLength(1);
    expect(violations[0].symbol).toBe("import { stat } from 'fs/promises'");
  });

  it('catches a namespace-import alias used via .promises (DA-F2 bypass)', () => {
    const src = [
      "import * as nodefs from 'node:fs';",
      'const a = await nodefs.promises.stat(p);',
    ].join('\n');
    const violations = findBoundaryViolations(src, GOVERNED);
    expect(violations.map((v) => v.symbol)).toEqual(['fs.stat']);
  });

  it('catches a default-import alias used via .promises (DA-F2 bypass)', () => {
    const src = ["import nfs from 'node:fs';", 'const a = await nfs.promises.readdir(d);'].join('\n');
    const violations = findBoundaryViolations(src, GOVERNED);
    expect(violations.map((v) => v.symbol)).toEqual(['fs.readdir']);
  });

  it('catches a require-bound alias call (DA-F2 bypass)', () => {
    const src = ["const nfs = require('node:fs/promises');", 'const a = await nfs.stat(p);'].join('\n');
    const violations = findBoundaryViolations(src, GOVERNED);
    expect(violations.map((v) => v.symbol)).toEqual(['fs.stat']);
  });

  it('catches a require-destructure (DA-F2 bypass)', () => {
    const src = "const { stat } = require('node:fs/promises');";
    const violations = findBoundaryViolations(src, GOVERNED);
    expect(violations.map((v) => v.symbol)).toEqual(['destructured stat from fs']);
  });

  it('catches a destructure from fs.promises', () => {
    const src = 'const { readdir, realpath } = fs.promises;';
    const violations = findBoundaryViolations(src, GOVERNED);
    expect(violations.map((v) => v.symbol).sort()).toEqual([
      'destructured readdir from fs',
      'destructured realpath from fs',
    ]);
  });

  it('catches bracket-access on an fs receiver (fs["stat"](…))', () => {
    const src = "const a = await fs['stat'](p); const b = await fsp[\"readdir\"](d);";
    const violations = findBoundaryViolations(src, GOVERNED);
    expect(violations.map((v) => v.symbol).sort()).toEqual(['fs.readdir', 'fs.stat']);
  });

  it('does NOT flag a boundary call — workspaceFs.stat/readdir/realpath (the key guard)', () => {
    const src = [
      "import { workspaceFs } from '@core/services/boundedWorkspaceFs';",
      'const a = await workspaceFs.stat(p);',
      'const b = await workspaceFs.readdir(dir);',
      'const c = await workspaceFs.realpath(p);',
      'const d = await workspaceFs.readFile(p);',
    ].join('\n');
    expect(findBoundaryViolations(src, GOVERNED)).toHaveLength(0);
  });

  it('does NOT flag a non-fs receiver whose name ends in Fs', () => {
    // `someFs.stat(` / `myFs.readdir(` are app objects, not the node fs module.
    const src = ['const a = await someFs.stat(p);', 'const b = await myFs.readdir(d);'].join('\n');
    expect(findBoundaryViolations(src, GOVERNED)).toHaveLength(0);
  });

  it('ALLOWS existsSync (existence probe) but FORBIDS readlink/readlinkSync (S3 review F1)', () => {
    const src = [
      "import { readlinkSync, existsSync } from 'node:fs';",
      "import { readlink } from 'node:fs/promises';",
      'const t = readlinkSync(linkPath);',
      'if (existsSync(p)) return;',
      'const q = fs.existsSync(p);',
      'const u = await fs.readlink(p);',
    ].join('\n');
    const symbols = findBoundaryViolations(src, GOVERNED).map((v) => v.symbol);
    // existsSync (both forms) stays allowed — it does not park on a dead mount the
    // way a symlink-inode read does.
    expect(symbols.some((s) => s.includes('existsSync'))).toBe(false);
    // readlinkSync call + readlink import + fs.readlink call are all flagged now.
    expect(symbols).toContain('readlinkSync');
    expect(symbols.some((s) => s.includes('import { readlink }'))).toBe(true);
    expect(symbols).toContain('fs.readlink');
  });

  it('does NOT flag references inside comments', () => {
    const src = [
      '// historically this did fs.stat(p) and statSync(p)',
      '/* a fs.realpath(p) note, and import { stat } from "node:fs" */',
      'const x = 1;',
    ].join('\n');
    expect(findBoundaryViolations(src, GOVERNED)).toHaveLength(0);
  });

  it('HONORS the workspace-fs-allow-local exemption on the SAME line', () => {
    const src = `const data = await fs.readFile(p, 'utf-8'); // ${BOUNDARY_LOCAL_EXEMPT_MARKER} app-data, never workspace`;
    expect(findBoundaryViolations(src, GOVERNED)).toHaveLength(0);
  });

  it('HONORS the workspace-fs-allow-local exemption on the PRECEDING line', () => {
    const src = [
      `      // ${BOUNDARY_LOCAL_EXEMPT_MARKER} the index dir is app-data, never a cloud mount`,
      '      await fs.access(lanceDBDir);',
    ].join('\n');
    expect(findBoundaryViolations(src, GOVERNED)).toHaveLength(0);
  });

  it('STILL flags a raw read that does NOT carry the exemption marker (control)', () => {
    const src = "const s = await fs.stat(workspacePath);";
    expect(findBoundaryViolations(src, GOVERNED).map((v) => v.symbol)).toEqual(['fs.stat']);
  });

  it('HONORS workspace-fs-allow-bounded ONLY when the read is genuinely withTimeout(…, FS_TIMEOUT_CLOUD_MS, …) wrapped (S4.1f F1)', () => {
    // Positive — marker SAME line as a genuinely-bounded read.
    const same = `const e = await withTimeout(fs.readdir('/Volumes'), FS_TIMEOUT_CLOUD_MS, []); // ${BOUNDARY_BOUNDED_EXEMPT_MARKER} mount-parent, bounded`;
    expect(findBoundaryViolations(same, GOVERNED)).toHaveLength(0);
    // Positive — marker on the PRECEDING line; the read line itself carries the bound.
    const preceding = [
      `      // ${BOUNDARY_BOUNDED_EXEMPT_MARKER} ~/Library/CloudStorage mount-parent — bounded, not workspace-fs-routed`,
      '      const entries = await withTimeout(fs.readdir(cloudStoragePath), FS_TIMEOUT_CLOUD_MS, []);',
    ].join('\n');
    expect(findBoundaryViolations(preceding, GOVERNED)).toHaveLength(0);
  });

  it('REJECTS workspace-fs-allow-bounded on an UN-bounded raw read (F1 — the marker is not a free escape hatch)', () => {
    // Marker present but NO withTimeout(…, FS_TIMEOUT_CLOUD_MS, …) wrapping → still a violation.
    const sameLineUnbounded = `const e = await fs.readdir('/Volumes'); // ${BOUNDARY_BOUNDED_EXEMPT_MARKER} claims bounded but isn't`;
    expect(findBoundaryViolations(sameLineUnbounded, GOVERNED).map((v) => v.symbol)).toEqual(['fs.readdir']);
    const precedingUnbounded = [
      `      // ${BOUNDARY_BOUNDED_EXEMPT_MARKER} claims bounded but the read line below has no timeout`,
      "      const entries = await fs.readdir(cloudStoragePath);",
    ].join('\n');
    expect(findBoundaryViolations(precedingUnbounded, GOVERNED).map((v) => v.symbol)).toEqual(['fs.readdir']);
    // Marker present + withTimeout but WITHOUT FS_TIMEOUT_CLOUD_MS (e.g. a bare ms literal) → still flagged.
    const wrongBudget = `const e = await withTimeout(fs.readdir('/Volumes'), 5000, []); // ${BOUNDARY_BOUNDED_EXEMPT_MARKER} wrong budget`;
    expect(findBoundaryViolations(wrongBudget, GOVERNED).map((v) => v.symbol)).toEqual(['fs.readdir']);
    // F1-followup: the bound tokens appearing ONLY inside the comment must NOT spoof the bound.
    // The CODE portion has a bare un-bounded read; the comment merely *describes* a withTimeout(…, FS_TIMEOUT_CLOUD_MS) wrap.
    const commentSpoofSameLine = `const e = await fs.readdir('/Volumes'); // ${BOUNDARY_BOUNDED_EXEMPT_MARKER} claims withTimeout(fs.readdir(...), FS_TIMEOUT_CLOUD_MS, []) but the code is unbounded`;
    expect(findBoundaryViolations(commentSpoofSameLine, GOVERNED).map((v) => v.symbol)).toEqual(['fs.readdir']);
    const commentSpoofPreceding = [
      `      // ${BOUNDARY_BOUNDED_EXEMPT_MARKER} would-be withTimeout(fs.readdir(...), FS_TIMEOUT_CLOUD_MS, []) — but only in this comment`,
      "      const entries = await fs.readdir(cloudStoragePath);",
    ].join('\n');
    expect(findBoundaryViolations(commentSpoofPreceding, GOVERNED).map((v) => v.symbol)).toEqual(['fs.readdir']);
  });

  it('the exemption marker does NOT leak across an intervening line', () => {
    // Marker two lines above (not the line itself nor directly above) → still flagged.
    const src = [
      `// ${BOUNDARY_LOCAL_EXEMPT_MARKER} unrelated note`,
      'const unrelated = 1;',
      'const s = await fs.stat(p);',
    ].join('\n');
    expect(findBoundaryViolations(src, GOVERNED).map((v) => v.symbol)).toEqual(['fs.stat']);
  });

  it('the exemption marker in CODE/STRING (not a // comment) is NOT honored (F2 hardening)', () => {
    // The token appears in a string literal, not a comment → must STILL flag the read.
    const src = `const tag = '${BOUNDARY_LOCAL_EXEMPT_MARKER}'; const s = await fs.stat(p);`;
    expect(findBoundaryViolations(src, GOVERNED).map((v) => v.symbol)).toEqual(['fs.stat']);
  });

  it('does NOT flag an IMPORT of readlinkSync (only the call is forbidden) or a non-fs-module import', () => {
    const src = [
      "import { readlinkSync } from 'node:fs';",
      "import { stat } from './my-local-stat-helper';",
    ].join('\n');
    expect(findBoundaryViolations(src, GOVERNED)).toHaveLength(0);
  });

  it('does NOT flag an identifier that merely ends in a sync primitive name', () => {
    const src = 'const myStatSync = makeStatSync(); customReadFileSyncHelper(p);';
    expect(findBoundaryViolations(src, GOVERNED)).toHaveLength(0);
  });

  it('every governed file exists and is clean (vacuous until S3 populates the set)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const repoRoot = path.resolve(__dirname, '..', '..');
    for (const rel of BOUNDARY_GOVERNED_FILES) {
      const abs = path.join(repoRoot, rel);
      expect(fs.existsSync(abs), `governed file should exist: ${rel}`).toBe(true);
      const src = fs.readFileSync(abs, 'utf8');
      expect(findBoundaryViolations(src, rel), `${rel} must route fs through the boundary`).toHaveLength(0);
    }
  });

  it('forbids the dereferencing primitives incl. readlink but not exists; receiver aliases are fs-only', () => {
    expect([...FORBIDDEN_SYNC_PRIMITIVES]).toContain('statSync');
    expect([...FORBIDDEN_SYNC_PRIMITIVES]).toContain('readlinkSync');
    expect([...FORBIDDEN_SYNC_PRIMITIVES]).not.toContain('existsSync');
    expect([...FORBIDDEN_ASYNC_METHODS]).toContain('realpath');
    expect([...FORBIDDEN_ASYNC_METHODS]).toContain('readlink');
    expect([...FS_RECEIVER_ALIASES]).toContain('fs');
    expect([...FS_RECEIVER_ALIASES]).not.toContain('workspaceFs');
  });
});

describe('setup-file eager-import guard (S4.1b blocker prevention)', () => {
  it('flags a static import of the concrete ElectronWorkspaceFileSystem in setup', () => {
    const src =
      "import { ElectronWorkspaceFileSystem } from './src/main/services/workspaceFileSystem/electronWorkspaceFileSystem';";
    const v = findSetupEagerBoundaryImports(src);
    expect(v).toHaveLength(1);
    expect(v[0].resolved).toBe('src/main/services/workspaceFileSystem/electronWorkspaceFileSystem.ts');
  });

  it('flags a static import of boundedWorkspaceFs itself (via @core alias)', () => {
    const src = "import { workspaceFs } from '@core/services/boundedWorkspaceFs';";
    const v = findSetupEagerBoundaryImports(src);
    expect(v).toHaveLength(1);
    expect(v[0].resolved).toBe('src/core/services/boundedWorkspaceFs.ts');
  });

  it('flags a bare side-effect import of a forbidden module', () => {
    const src = "import './src/core/services/boundedWorkspaceFs';";
    const v = findSetupEagerBoundaryImports(src);
    expect(v).toHaveLength(1);
    expect(v[0].resolved).toBe('src/core/services/boundedWorkspaceFs.ts');
  });

  it('flags a TOP-LEVEL require-binding of a forbidden module', () => {
    const src = "const { workspaceFs } = require('@core/services/boundedWorkspaceFs');";
    const v = findSetupEagerBoundaryImports(src);
    expect(v).toHaveLength(1);
    expect(v[0].resolved).toBe('src/core/services/boundedWorkspaceFs.ts');
  });

  it('is REGISTRY-DRIVEN — flags an eager import of every forbidden file (auto-covers S4.1c/d)', () => {
    for (const rel of SETUP_FORBIDDEN_EAGER_FILES) {
      const specifier = `./${rel.replace(/\.ts$/, '')}`;
      const v = findSetupEagerBoundaryImports(`import { X } from '${specifier}';`);
      expect(v, `should flag eager import of ${rel}`).toHaveLength(1);
      expect(v[0].resolved).toBe(rel);
    }
    // The forbidden set IS the boundary module + the governed registry, so any file
    // added to BOUNDARY_GOVERNED_FILES in S4.1c/d is covered with no further edits.
    expect(SETUP_FORBIDDEN_EAGER_FILES.has('src/core/services/boundedWorkspaceFs.ts')).toBe(true);
    for (const rel of BOUNDARY_GOVERNED_FILES) {
      expect(SETUP_FORBIDDEN_EAGER_FILES.has(rel)).toBe(true);
    }
  });

  it('does NOT flag the core interface import setWorkspaceFileSystemFactory (must stay static)', () => {
    const src = "import { setWorkspaceFileSystemFactory } from './src/core/workspaceFileSystem';";
    expect(findSetupEagerBoundaryImports(src)).toHaveLength(0);
  });

  it('does NOT flag the lazy in-thunk require (the shipped fix shape)', () => {
    const src = [
      'setWorkspaceFileSystemFactory(() => {',
      '  const {',
      '    ElectronWorkspaceFileSystem,',
      "  }: typeof import('./src/main/services/workspaceFileSystem/electronWorkspaceFileSystem') = require(",
      "    './src/main/services/workspaceFileSystem/electronWorkspaceFileSystem',",
      '  );',
      '  return new ElectronWorkspaceFileSystem();',
      '});',
    ].join('\n');
    expect(findSetupEagerBoundaryImports(src)).toHaveLength(0);
  });

  it('does NOT flag an `import type … from` of a forbidden module (type-only; no runtime eval)', () => {
    const src = "import type { WorkspaceFsOutcome } from '@core/services/boundedWorkspaceFs';";
    expect(findSetupEagerBoundaryImports(src)).toHaveLength(0);
  });

  it('does NOT flag a commented-out static import', () => {
    const src = [
      "// import { ElectronWorkspaceFileSystem } from './src/main/services/workspaceFileSystem/electronWorkspaceFileSystem';",
      "/* import { workspaceFs } from '@core/services/boundedWorkspaceFs'; */",
      'const x = 1;',
    ].join('\n');
    expect(findSetupEagerBoundaryImports(src)).toHaveLength(0);
  });

  it('does NOT flag imports of non-forbidden / bare modules', () => {
    const src = [
      "import { describe } from 'vitest';",
      "import path from 'node:path';",
      "import { TestMemoryStore } from './src/core/__tests__/TestMemoryStore';",
    ].join('\n');
    expect(findSetupEagerBoundaryImports(src)).toHaveLength(0);
  });

  it('resolveSetupImportSpecifier maps aliases/relative/bare specifiers correctly', () => {
    expect(resolveSetupImportSpecifier('@core/services/boundedWorkspaceFs')).toBe(
      'src/core/services/boundedWorkspaceFs.ts',
    );
    expect(resolveSetupImportSpecifier('./src/main/x/y')).toBe('src/main/x/y.ts');
    expect(resolveSetupImportSpecifier('src/core/foo')).toBe('src/core/foo.ts');
    expect(resolveSetupImportSpecifier('@main/services/foo.ts')).toBe('src/main/services/foo.ts');
    expect(resolveSetupImportSpecifier('vitest')).toBeNull();
    expect(resolveSetupImportSpecifier('node:fs/promises')).toBeNull();
  });

  it('the REAL vitest.setup.ts passes the guard (lazy-loads boundary consumers)', () => {
    const repoRoot = resolve(__dirname, '..', '..');
    const setupSrc = readFileSync(resolve(repoRoot, 'vitest.setup.ts'), 'utf8');
    expect(findSetupEagerBoundaryImports(setupSrc)).toEqual([]);
  });
});
