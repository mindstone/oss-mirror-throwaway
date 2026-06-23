#!/usr/bin/env npx tsx
/**
 * CI Validation: Core Layer Import Discipline
 *
 * Ensures src/core/ never imports from src/main/ or 'electron' at runtime.
 * Core business logic must only depend on:
 *   - Other @core/ modules
 *   - @shared/ modules
 *   - node: built-ins
 *   - npm packages
 *
 * Type-only imports from 'electron' are allowed (no runtime dependency).
 *
 * Run: npx tsx scripts/check-core-imports.ts
 * Wired into: npm run validate:fast
 *
 * @see docs/plans/260330_strengthen_de_electronification.md
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Exported helpers (unit-testable)
// ---------------------------------------------------------------------------

export interface Violation {
  file: string;
  line: number;
  text: string;
  rule: string;
}

/**
 * Pure detection function: scans TypeScript source for core→main / electron violations.
 *
 * Rules enforced:
 *   no-import-main           — `from '@main/...'`
 *   no-relative-main         — `from '../../main/...'` (any depth)
 *   no-import-electron       — `from 'electron'` (type-only allowed)
 *   no-dynamic-import-electron — `import('electron')` (typeof query allowed)
 *   no-dynamic-import-main   — `import('@main/...')`
 *   no-require-electron      — `require('electron')`
 *   no-require-main          — `require('@main/...')`
 *   no-export-main           — `export ... from '@main/...'` or `'electron'`
 */
export function findCoreImportViolations(source: string, filePath: string): Violation[] {
  const violations: Violation[] = [];
  const lines = source.split('\n');
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const originalLine = lines[i];
    let line = originalLine;
    const lineNum = i + 1;

    // ---- Strip comments so we don't flag commented-out code ----

    // Continue / exit block comment
    if (inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx !== -1) {
        inBlockComment = false;
        line = line.slice(endIdx + 2);
      } else {
        continue; // entire line inside block comment
      }
    }

    // Strip inline block comments (/* ... */ on one line)
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

    // Strip line comments
    const commentIdx = line.indexOf('//');
    if (commentIdx !== -1) {
      line = line.slice(0, commentIdx);
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    // ---- Check rules ----

    // Rule 1: Static import from @main/ (not export — Rule 8 handles exports)
    if (/\bimport\s+/.test(line) && /from\s+['"]@main\//.test(line)) {
      violations.push({ file: filePath, line: lineNum, text: originalLine.trim(), rule: 'no-import-main' });
    }

    // Rule 2: Relative import reaching into ../main/ (any depth of ../)
    if (/\bimport\s+/.test(line) && /from\s+['"](?:\.\.\/)+main(?:\/|['"])/.test(line)) {
      violations.push({ file: filePath, line: lineNum, text: originalLine.trim(), rule: 'no-relative-main' });
    }

    // Rule 3: Static import from 'electron' — allow `import type`
    if (/\bimport\s+/.test(line) && /from\s+['"]electron['"]/.test(line) && !/import\s+type\b/.test(line)) {
      violations.push({ file: filePath, line: lineNum, text: originalLine.trim(), rule: 'no-import-electron' });
    }

    // Rule 4: Dynamic import('electron') — allow `typeof import('electron')` (type query)
    if (/import\(\s*['"]electron['"]\s*\)/.test(line) && !/typeof\s+import\(\s*['"]electron['"]\s*\)/.test(line)) {
      violations.push({ file: filePath, line: lineNum, text: originalLine.trim(), rule: 'no-dynamic-import-electron' });
    }

    // Rule 5: Dynamic import('@main/...')
    if (/import\(\s*['"]@main\//.test(line)) {
      violations.push({ file: filePath, line: lineNum, text: originalLine.trim(), rule: 'no-dynamic-import-main' });
    }

    // Rule 6: require('electron')
    if (/require\(\s*['"]electron['"]\s*\)/.test(line)) {
      violations.push({ file: filePath, line: lineNum, text: originalLine.trim(), rule: 'no-require-electron' });
    }

    // Rule 7: require('@main/...')
    if (/require\(\s*['"]@main\//.test(line)) {
      violations.push({ file: filePath, line: lineNum, text: originalLine.trim(), rule: 'no-require-main' });
    }

    // Rule 8: export ... from '@main/...' or 'electron' (re-exports create runtime deps)
    if (/export\s+.*from\s+['"]@main\//.test(line)) {
      violations.push({ file: filePath, line: lineNum, text: originalLine.trim(), rule: 'no-export-main' });
    }
    if (/export\s+.*from\s+['"]electron['"]/.test(line) && !/export\s+type\b/.test(line)) {
      violations.push({ file: filePath, line: lineNum, text: originalLine.trim(), rule: 'no-export-electron' });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

/**
 * lazyElectron.ts is intentionally exempted: it provides the sanctioned
 * runtime bridge between core and Electron, using a computed require() to
 * avoid static bundler resolution. headlessRuntime.ts is the explicit
 * Stage 4 shared bootstrap boundary registered as `headless-runtime-options`.
 * `toolSafetyService.ts` is temporarily exempt during Stage 2.C while helper
 * services are drained from `@main/*` in follow-up centralization stages.
 * `core/services/turnPipeline/*` exemptions are the Stage 2.F transitional
 * move target while remaining helper imports are still being boundary-extracted.
 * `core/services/inbox/inboxBridgeStateMachine.ts` is the Stage 3.C split
 * landing zone; route-level dependencies are still main-owned and drained in
 * follow-up inbox boundary extraction stages.
 * All other core code must use boundary interfaces (@core/platform,
 * @core/storeFactory, etc.) instead.
 *
 * @see src/core/lazyElectron.ts
 * @see docs/plans/260330_strengthen_de_electronification.md
 */
const REPO_ROOT = path.join(__dirname, '..');
const EXEMPT_FILES = new Set([
  'src/core/lazyElectron.ts',
  'src/core/services/headlessRuntime.ts',
  'src/core/services/safety/toolSafetyService.ts',
  'src/core/services/turnPipeline/agentTurnExecute.ts',
  'src/core/services/turnPipeline/turnAdmission.ts',
  'src/core/services/turnPipeline/turnCompletion.ts',
  'src/core/services/turnPipeline/types.ts',
  'src/core/services/inbox/inboxBridgeStateMachine.ts',
]);

function collectCoreFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(fullPath);
      } else if (
        (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
        !entry.name.includes('.test.')
      ) {
        const relativePath = path.relative(REPO_ROOT, fullPath).replace(/\\/g, '/');
        if (EXEMPT_FILES.has(relativePath)) continue;
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// CLI runner — skipped when imported for testing (Vitest sets VITEST env var)
// ---------------------------------------------------------------------------

if (!process.env.VITEST) {
  const CORE_DIR = path.join(REPO_ROOT, 'src', 'core');

  console.log('Checking core layer import discipline...\n');
  console.log(`Scanning: ${path.relative(process.cwd(), CORE_DIR)}/`);
  console.log(`Exempt:   ${[...EXEMPT_FILES].join(', ')}\n`);

  const files = collectCoreFiles(CORE_DIR);
  const allViolations: Violation[] = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const relativePath = path.relative(path.join(__dirname, '..'), file);
    const violations = findCoreImportViolations(source, relativePath);
    allViolations.push(...violations);
  }

  if (allViolations.length > 0) {
    console.error(`✗ Found ${allViolations.length} core layer violation(s):\n`);
    for (const v of allViolations) {
      console.error(`  ${v.file}:${v.line} [${v.rule}]`);
      console.error(`    ${v.text}\n`);
    }
    console.error(
      'Core business logic (src/core/) must not import from src/main/ or electron.\n' +
        'Use boundary interfaces (@core/platform, @core/storeFactory, etc.) instead.\n' +
        'See: docs/plans/260330_strengthen_de_electronification.md',
    );
    process.exit(1);
  } else {
    console.log(`✓ ${files.length} core files scanned — no import discipline violations found`);
  }
}
