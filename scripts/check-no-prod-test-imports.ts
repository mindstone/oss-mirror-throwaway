#!/usr/bin/env npx tsx
/**
 * CI Validation: Production code must not import from `__tests__/`
 *
 * Kill-by-construction guard (PLAN Stage 10). At Stage 2 of the IPC in-process
 * contract harness run, the production `registerHandler.ts` imported the
 * contract decorator from `__tests__/harness/`. `tsc` did NOT catch it (the
 * import resolved fine), but the Vite production build would have bundled test
 * code into the shipping app. This guard makes that class of defect impossible
 * by failing CI on ANY non-test source file under `src/**` that imports a module
 * specifier containing `/__tests__/` (relative, aliased, dynamic, or re-export).
 *
 * Scope: `src/**` only (desktop main/renderer/shared/preload/core). Cloud-service
 * and mobile live in sibling trees with their own build pipelines; keep this
 * file-scoped per repo memory [[project_chokepoint_enforcement_ci_guard]] (a
 * blunt repo-wide ESLint rule spikes false-positives). Extending the SCAN_ROOTS
 * list below is the trivial way to widen scope if ever needed.
 *
 * A "non-test file" excludes:
 *   - anything under a `__tests__` directory (any depth)
 *   - anything under a `test-utils` directory (any depth) — test-only scaffolding
 *     (e.g. `src/test-utils/**`, `src/renderer/test-utils/**`), the same set
 *     vitest.config.ts excludes from coverage and never bundled into the app
 *   - `*.test.*` / `*.spec.*` files
 * Those files are ALLOWED to import from `__tests__/` (test harness sharing).
 *
 * Run:    npx tsx scripts/check-no-prod-test-imports.ts
 * Wired:  npm run validate:fast (scripts/run-validate-fast.ts)
 *
 * @see docs/plans/260609_ipc-inprocess-contract-harness/PLAN.md (Stage 10)
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Exported helpers (unit-testable; the CLI runner below is skipped under Vitest)
// ---------------------------------------------------------------------------

export interface TestImportViolation {
  file: string;
  line: number;
  specifier: string;
  text: string;
}

/**
 * Returns true when `filePath` is itself a test file (and therefore ALLOWED to
 * import from `__tests__/`). Matches `__tests__` directories (any depth) and
 * `*.test.*` / `*.spec.*` filenames. Path is compared in POSIX form.
 */
export function isTestFile(filePath: string): boolean {
  const posix = filePath.replace(/\\/g, '/');
  if (/(^|\/)__tests__\//.test(posix)) return true;
  if (/(^|\/)test-utils\//.test(posix)) return true;
  const base = posix.split('/').pop() ?? posix;
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(base);
}

/**
 * Extracts the module specifier from a single source line for the three import
 * forms that create a runtime dependency:
 *   - `import ... from '<spec>'`
 *   - `export ... from '<spec>'`   (re-export — also a runtime dep)
 *   - `import('<spec>')` / `require('<spec>')`  (dynamic)
 *
 * Comments are stripped by the caller. Returns all specifiers found on the line
 * (a single line can contain at most a few, but we collect defensively).
 */
function extractSpecifiers(line: string): string[] {
  const specs: string[] = [];

  // `import ... from '<spec>'` and `export ... from '<spec>'`
  // (covers `import x`, `import type x`, `import {a}`, `import * as x`, bare side-effect `import '<spec>'`)
  const fromRe = /\b(?:import|export)\b[^'"]*\bfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(line)) !== null) specs.push(m[1]);

  // Bare side-effect import: `import '<spec>'` (no `from`)
  const bareImportRe = /\bimport\s*['"]([^'"]+)['"]/g;
  while ((m = bareImportRe.exec(line)) !== null) specs.push(m[1]);

  // Dynamic `import('<spec>')` and `require('<spec>')`
  const dynRe = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(line)) !== null) specs.push(m[1]);

  return specs;
}

/**
 * Pure detection: scans source text for imports whose module specifier contains
 * `/__tests__/` (relative `../__tests__/`, aliased `@.../__tests__/...`, etc.).
 * Strips line and block comments first so commented-out code is ignored.
 */
export function findTestImportViolations(source: string, filePath: string): TestImportViolation[] {
  const violations: TestImportViolation[] = [];
  const lines = source.split('\n');
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const originalLine = lines[i];
    let line = originalLine;
    const lineNum = i + 1;

    // ---- Strip comments so we don't flag commented-out code ----
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

    for (const spec of extractSpecifiers(line)) {
      if (spec.includes('/__tests__/')) {
        violations.push({ file: filePath, line: lineNum, specifier: spec, text: originalLine.trim() });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

const REPO_ROOT = path.join(__dirname, '..');

/** Source roots to scan (desktop surfaces only — see file header for scope). */
const SCAN_ROOTS = ['src'];

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Collects production source files under `dir`: every `.ts/.tsx/.js/.jsx`
 * (incl. `.cts/.mts/...`) that is NOT a test file. Skips `__tests__` and
 * `node_modules` directories entirely.
 */
export function collectProdFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(currentDir: string): void {
    if (!fs.existsSync(currentDir)) return;
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(fullPath);
        continue;
      }
      if (!SOURCE_EXT.test(entry.name)) continue;
      const relativePath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, '/');
      if (isTestFile(relativePath)) continue;
      results.push(fullPath);
    }
  }

  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// CLI runner — skipped when imported for testing (Vitest sets VITEST env var)
// ---------------------------------------------------------------------------

if (!process.env.VITEST) {
  console.log('Checking that production code does not import from __tests__/...\n');

  const allViolations: TestImportViolation[] = [];
  let scanned = 0;

  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root);
    console.log(`Scanning: ${root}/`);
    const files = collectProdFiles(absRoot);
    scanned += files.length;
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const relativePath = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      allViolations.push(...findTestImportViolations(source, relativePath));
    }
  }

  if (allViolations.length > 0) {
    console.error(`\n✗ Found ${allViolations.length} production→__tests__ import(s):\n`);
    for (const v of allViolations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    -> '${v.specifier}'`);
      console.error(`    ${v.text}\n`);
    }
    console.error(
      'Production source files must NOT import from `__tests__/`.\n' +
        'Test code imported into production is bundled into the shipping app by\n' +
        'the Vite build (tsc does not catch it). Move the shared code OUT of\n' +
        '`__tests__/` into a non-test module, or keep the importer test-only.\n' +
        'See: docs/plans/260609_ipc-inprocess-contract-harness/PLAN.md (Stage 10)',
    );
    process.exit(1);
  } else {
    console.log(`\n✓ ${scanned} production files scanned — no imports from __tests__/`);
  }
}
