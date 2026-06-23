#!/usr/bin/env npx tsx
/**
 * CI Validation: the Removal Coordinator is the ONLY door for cloud-relevant
 * index removals (PLAN.md "Purge-Gating & Removal Design" DA-suggestion; Stage 4a).
 *
 * Background: a workspace file's "index presence" spans three stores
 * (sourceMetadataStore, entityMetadataStore, the LanceDB vector index). Stage 4a
 * funnels every cross-store removal through
 * `src/main/services/indexRemovalCoordinator.ts` so a slow/dead cloud mount can
 * never half-purge the "last-known index", and so Stage 4b can add retain-when-
 * degraded gating in ONE place. This guard makes "a new direct LanceDB delete of a
 * workspace path bypasses the coordinator" impossible by construction: any NEW
 * call to the public LanceDB removers (`removeFileFromIndex` / `removeFilesFromIndex`)
 * outside the small, explicit allowlist FAILS the build.
 *
 * SCOPE — deliberately narrow (PLAN: "scoped to the cloud-relevant delete fns so
 * it doesn't false-positive on unrelated deletes"):
 *   - Only the two PUBLIC LanceDB removers are guarded. The `*Internal` (lock-free)
 *     variants are NOT guarded — they are the legitimate `replacement` re-index
 *     deletes that run under the write lock inside fileIndexService and must never
 *     route back out through the public (lock-taking) door.
 *   - The metadata-store removers (`removeSource`/`removeEntity`) are NOT guarded
 *     here: they are single-store, lower-risk, and a core-side self-prune
 *     (`filterExistingSources`) cannot reach the main-side coordinator by boundary
 *     rules (that is a Stage-4b R2 concern). Guarding them would false-positive.
 *
 * ALLOWLIST (the only files/sites permitted to reference the public removers):
 *   - the coordinator itself (it IS the door — its injected removers call them);
 *   - the desktop wiring in `src/main/index.ts` (injects the real removers);
 *   - `fileIndexService/index.ts` (DEFINES the removers + internal callers).
 *
 * Note (Stage 4a touch-up): `pluginIndexService.deindexPluginReadme` was previously
 * allowlisted as a "separate plugin-readme index". That was inaccurate — a plugin
 * README lives at `<spacePath>/plugins/<id>/README.md` UNDER the workspace
 * `coreDirectory`, and a Space (or `coreDirectory` itself) can be a cloud-backed
 * symlink, so it IS a cloud-relevant workspace-path removal. It now routes through
 * the coordinator (`removeVectorIndexEntry`, vector-only, reason `hygiene`), so the
 * allowlist no longer needs it and the "only door" claim is now literally true.
 *
 * A planted violation (a new `removeFilesFromIndex(...)` in any other source file)
 * is caught — see scripts/__tests__/check-index-removal-coordinator.test.ts.
 *
 * Run:    npx tsx scripts/check-index-removal-coordinator.ts
 * Wired:  npm run validate:fast (scripts/run-validate-fast.ts)
 *
 * @see docs/plans/260619_cloud-symlink-indexing/PLAN.md (Stage 4a)
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Pure, unit-testable detection.
// ---------------------------------------------------------------------------

export interface CoordinatorViolation {
  file: string;
  line: number;
  symbol: string;
  text: string;
}

/** The guarded public LanceDB removers (cloud-relevant cross-store deletes). */
export const GUARDED_REMOVERS = ['removeFileFromIndex', 'removeFilesFromIndex'] as const;

/**
 * Files allowed to reference the guarded removers (POSIX, repo-relative). Each is
 * the SSOT door, the definer, the wiring site, or a deliberately-separate index.
 */
export const ALLOWLISTED_FILES: ReadonlySet<string> = new Set([
  'src/main/services/indexRemovalCoordinator.ts',
  'src/main/index.ts',
  'src/main/services/fileIndexService/index.ts',
]);

/**
 * Returns true when `posixPath` is exempt: a test file, the coordinator/definer/
 * wiring allowlist, or a non-`.ts` file.
 */
export function isAllowlisted(posixPath: string): boolean {
  if (/(^|\/)__tests__\//.test(posixPath)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(posixPath)) return true;
  return ALLOWLISTED_FILES.has(posixPath);
}

/**
 * A reference is a VIOLATION only when it is an actual CALL of a guarded remover
 * (`name(` — possibly after `.`/`await`), not an import, a type, a comment, or a
 * property key in an interface. We strip comments, then match a call form while
 * excluding the import/property/definition forms.
 */
export function findCoordinatorViolations(source: string, filePath: string): CoordinatorViolation[] {
  const violations: CoordinatorViolation[] = [];
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

    // Skip import / export-from lines (referencing the symbol is fine; calling it isn't).
    if (/^\s*import\b/.test(line) || /^\s*export\b[^=]*\bfrom\b/.test(line)) continue;

    for (const symbol of GUARDED_REMOVERS) {
      // A CALL: `name(` (possibly qualified `x.name(` or awaited). The `(?<!\w)`
      // lookbehind allows a preceding `.` (qualified call IS a violation) while
      // excluding a longer identifier ending in the name (e.g. `fooRemoveFile…`).
      // The trailing `\s*\(` excludes the `*Internal` variants (no `(` directly
      // after the guarded name) and property-key declarations (`name:`, no `(`).
      const callRe = new RegExp(`(?<!\\w)${symbol}\\s*\\(`, 'g');
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(line)) !== null) {
        // Definition site: `function <symbol>(` or `async function <symbol>(`.
        const before = line.slice(0, m.index);
        if (/\bfunction\s+$/.test(before)) continue;
        violations.push({ file: filePath, line: lineNum, symbol, text: originalLine.trim() });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// File collection (mirrors scripts/check-no-prod-test-imports.ts).
// ---------------------------------------------------------------------------

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_ROOTS = ['src'];
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;

export function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(currentDir: string): void {
    if (!fs.existsSync(currentDir)) return;
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(fullPath);
        continue;
      }
      if (!SOURCE_EXT.test(entry.name)) continue;
      results.push(fullPath);
    }
  }
  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// CLI runner — skipped under Vitest (imported for unit tests instead).
// ---------------------------------------------------------------------------

if (!process.env.VITEST) {
  console.log('Checking that cloud index removals route through the Removal Coordinator...\n');

  const allViolations: CoordinatorViolation[] = [];
  let scanned = 0;

  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root);
    const files = collectSourceFiles(absRoot);
    for (const file of files) {
      const relativePath = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      if (isAllowlisted(relativePath)) continue;
      scanned += 1;
      const src = fs.readFileSync(file, 'utf8');
      allViolations.push(...findCoordinatorViolations(src, relativePath));
    }
  }

  if (allViolations.length > 0) {
    console.error(`\n✗ Found ${allViolations.length} direct LanceDB-remover call(s) outside the Removal Coordinator:\n`);
    for (const v of allViolations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    -> ${v.symbol}(...)`);
      console.error(`    ${v.text}\n`);
    }
    console.error(
      'Cloud index removals MUST go through src/main/services/indexRemovalCoordinator.ts\n' +
        '(removeMetadataStoresEntry / removeVectorIndexEntry / removeVectorIndexEntries /\n' +
        'removeIndexedEntry / removeIndexedEntries) with a typed RemovalReason — it is the\n' +
        'single place that applies a removal across all three index stores and where\n' +
        'Stage 4b adds retain-when-degraded gating. A direct removeFile(s)FromIndex call\n' +
        'can half-purge or wipe the last-known index on a transient cloud outage.\n' +
        'If this is a deliberate non-workspace index (like pluginIndexService), add the\n' +
        'file to ALLOWLISTED_FILES in scripts/check-index-removal-coordinator.ts with a\n' +
        'one-line rationale.\n' +
        'See: docs/plans/260619_cloud-symlink-indexing/PLAN.md (Stage 4a)',
    );
    process.exit(1);
  } else {
    console.log(`\n✓ ${scanned} files scanned — all cloud index removals route through the Removal Coordinator`);
  }
}
