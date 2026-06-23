#!/usr/bin/env npx tsx
/**
 * CI Validation (RS-F5): the readlink-only cloud-liveness helpers must NEVER issue
 * a blocking, target-DEREFERENCING `node:fs` call on a (possibly-dead) cloud mount
 * (PLAN.md docs/plans/260619_cloud-symlink-indexing — RS-F5; Stage 5).
 *
 * Background: a symlink into a dead/unresponsive cloud FUSE mount makes
 * `stat`/`readdir`/`realpath`/`access`/`lstat` block in the kernel with no timeout,
 * parking a libuv-threadpool worker and (when several pile up) exhausting the
 * shared pool (fs AND DNS) → the 0.4.48→0.4.49 turn-hang class. The defence is
 * READLINK-ONLY: `readlinkSync` reads the link's OWN inode (which lives in the
 * LOCAL parent directory) and returns instantly even when the chain points into a
 * dead mount — it NEVER dereferences the target. A small set of core helpers
 * (`readlinkChain`, `cloudLivenessProbe.types`, `cloudSpaceContainment`) are
 * clean-by-construction: their ONLY filesystem touch is `readlinkSync`. This gate
 * makes "someone adds a `realpathSync`/`statSync`/`fs.stat`/… into one of these
 * readlink-only helpers" impossible by construction — exactly the regression that
 * re-parks the pool.
 *
 * SCOPE — deliberately narrow (PLAN: "scope it tightly; catch a planted violation,
 * don't false-positive on unrelated local fs"):
 *   - GUARDED_FILES is the small allowlist of files whose CONTRACT is readlink-only.
 *     We do NOT scan the whole tree — `safeWalkDirectory`/`symlinkMap`/`libraryHandlers`
 *     legitimately call `fs.realpath`/`readdir` on LOCAL paths (and on cloud paths
 *     only when BOUNDED by `runWithTimeout`), so a blanket ban there would
 *     false-positive on the intended bounded/local fast paths.
 *   - FORBIDDEN are the target-dereferencing primitives only. `readlinkSync` is
 *     ALLOWED (it is the safe primitive these files are built on). `existsSync` is
 *     ALLOWED (it does not park on a dead mount the way `stat`/`readdir` do, and the
 *     prober uses it on its own LOCAL bundled worker path).
 *
 * A planted violation (a new `realpathSync(...)` / `await fs.stat(...)` in any
 * guarded file) is caught — see scripts/__tests__/check-cloud-readlink-only.test.ts.
 *
 * Run:    npx tsx scripts/check-cloud-readlink-only.ts
 * Wired:  npm run validate:fast (scripts/run-validate-fast.ts)
 *
 * @see docs/plans/260619_cloud-symlink-indexing/PLAN.md (Stage 5, RS-F5)
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Pure, unit-testable detection.
// ---------------------------------------------------------------------------

export interface ReadlinkViolation {
  file: string;
  line: number;
  symbol: string;
  text: string;
}

/**
 * Files whose CONTRACT is "readlink-only — never dereference a cloud target".
 * POSIX, repo-relative. Adding a file here asserts it must remain readlink-only.
 */
export const GUARDED_FILES: ReadonlySet<string> = new Set([
  'src/core/utils/readlinkChain.ts',
  'src/core/services/cloudLivenessProbe.types.ts',
  'src/core/services/cloudSpaceContainment.ts',
]);

/**
 * The target-DEREFERENCING fs primitives banned in the guarded files. Matched as a
 * CALL (`name(`). `readlinkSync` (the safe primitive) and `existsSync` (does not
 * park on a dead mount) are deliberately NOT here.
 */
export const FORBIDDEN_SYNC_PRIMITIVES = [
  'statSync',
  'lstatSync',
  'realpathSync',
  'readdirSync',
  'accessSync',
  'readFileSync',
  'opendirSync',
] as const;

/**
 * The async `fs.<name>(` forms (e.g. `await fs.stat(p)`) — same dereference hazard
 * (they still schedule a libuv-pool op that parks on a dead mount). Matched as
 * `.name(` so a qualified `fs.stat(` / `fsp.realpath(` is caught while a bare
 * identifier that merely ends in the name is not.
 */
export const FORBIDDEN_ASYNC_METHODS = [
  'stat',
  'lstat',
  'realpath',
  'readdir',
  'access',
  'readFile',
  'opendir',
] as const;

/**
 * A reference is a VIOLATION only when it is an actual CALL of a forbidden
 * primitive — not an import, a type, a comment, or a doc reference. We strip
 * comments first, then match call forms.
 */
export function findReadlinkViolations(source: string, filePath: string): ReadlinkViolation[] {
  const violations: ReadlinkViolation[] = [];
  const lines = source.split('\n');
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const originalLine = lines[i];
    let line = originalLine;
    const lineNum = i + 1;

    // ---- Strip comments ----
    if (inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx !== -1) {
        inBlockComment = false;
        line = line.slice(endIdx + 2);
      } else {
        continue;
      }
    }
    while (line.includes('/*')) {
      const startIdx = line.indexOf('/*');
      const endIdx = line.indexOf('*/', startIdx + 2);
      if (endIdx !== -1) {
        line = line.slice(0, startIdx) + line.slice(endIdx + 2);
      } else {
        line = line.slice(0, startIdx);
        inBlockComment = true;
        break;
      }
    }
    const commentIdx = line.indexOf('//');
    if (commentIdx !== -1) line = line.slice(0, commentIdx);
    if (!line.trim()) continue;

    // Skip import / export-from lines (importing a name is fine; calling it isn't —
    // and the guarded files only import `readlinkSync` anyway).
    if (/^\s*import\b/.test(line) || /^\s*export\b[^=]*\bfrom\b/.test(line)) continue;

    // Sync primitives: a CALL `name(` not preceded by another identifier char (so a
    // longer identifier ending in the name is not matched). A leading `.`/`await `
    // (qualified call) IS a violation.
    for (const symbol of FORBIDDEN_SYNC_PRIMITIVES) {
      const callRe = new RegExp(`(?<!\\w)${symbol}\\s*\\(`, 'g');
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(line)) !== null) {
        // Definition site (`function <symbol>(`) — never a deref of a mount.
        const before = line.slice(0, m.index);
        if (/\bfunction\s+$/.test(before)) continue;
        violations.push({ file: filePath, line: lineNum, symbol, text: originalLine.trim() });
      }
    }

    // Async methods: a QUALIFIED call `.name(` (e.g. `fs.stat(`, `await fsp.readdir(`).
    // Requires the leading `.` so a bare top-level `stat(` local helper isn't matched
    // here (it'd be caught by the sync list only if it were a sync primitive name).
    for (const method of FORBIDDEN_ASYNC_METHODS) {
      const callRe = new RegExp(`\\.${method}\\s*\\(`, 'g');
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(line)) !== null) {
        violations.push({ file: filePath, line: lineNum, symbol: `fs.${method}`, text: originalLine.trim() });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// CLI runner — skipped under Vitest (imported for unit tests instead).
// ---------------------------------------------------------------------------

const REPO_ROOT = path.join(__dirname, '..');

if (!process.env.VITEST) {
  console.log('Checking that the readlink-only cloud-liveness helpers never dereference a cloud mount...\n');

  const allViolations: ReadlinkViolation[] = [];
  let scanned = 0;

  for (const relativePath of GUARDED_FILES) {
    const abs = path.join(REPO_ROOT, relativePath);
    if (!fs.existsSync(abs)) {
      console.error(`\n✗ Guarded file not found: ${relativePath}`);
      console.error('  Update GUARDED_FILES in scripts/check-cloud-readlink-only.ts if it was renamed/moved.');
      process.exit(1);
    }
    scanned += 1;
    const src = fs.readFileSync(abs, 'utf8');
    allViolations.push(...findReadlinkViolations(src, relativePath));
  }

  if (allViolations.length > 0) {
    console.error(`\n✗ Found ${allViolations.length} dereferencing fs call(s) in readlink-only cloud helpers:\n`);
    for (const v of allViolations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    -> ${v.symbol}(...)`);
      console.error(`    ${v.text}\n`);
    }
    console.error(
      'These files MUST be readlink-only: their only filesystem touch may be\n' +
        '`readlinkSync` (reads the link inode in the LOCAL parent dir; never derefs).\n' +
        'A `realpathSync`/`statSync`/`readdirSync`/`fs.stat`/`fs.realpath`/… here\n' +
        'dereferences the symlink TARGET — and if that target is a dead cloud FUSE\n' +
        'mount, the call blocks in the kernel with no timeout, parking a libuv\n' +
        'worker and re-opening the 0.4.48→0.4.49 turn-hang class.\n' +
        'If you genuinely need a dereferencing op, route it OFF-THREAD through the\n' +
        'cloud-liveness child process (cloudLivenessProbeService) or BOUND it with\n' +
        'runWithTimeout in a non-guarded file — do not add it here.\n' +
        'See: docs/plans/260619_cloud-symlink-indexing/PLAN.md (Stage 5, RS-F5)',
    );
    process.exit(1);
  } else {
    console.log(`\n✓ ${scanned} readlink-only cloud helper(s) scanned — none dereference a cloud mount`);
  }
}
