#!/usr/bin/env npx tsx
/**
 * CI Validation: E2E Test ID Cross-Reference
 *
 * Scans E2E test files for `data-testid` selectors and cross-references them
 * against definitions in renderer (+ preload, shared) source files.
 *
 * Catches stale test ID references that break E2E tests silently when UI
 * components are refactored (e.g. the PendingReviewBar → ApprovalPointerBar
 * migration that broke 12 E2E tests for weeks).
 *
 * Run: npx tsx scripts/check-e2e-testids.ts
 * Wired into: npm run validate:fast (via validate:e2e-testids)
 *
 * @see docs/plans/260325_e2e_test_robustness_improvements.md
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT_DIR = path.join(__dirname, '..');
const E2E_DIR = path.join(ROOT_DIR, 'tests', 'e2e');

// Source directories to scan for test ID definitions
const SOURCE_DIRS = [
  path.join(ROOT_DIR, 'src', 'renderer'),
  path.join(ROOT_DIR, 'src', 'preload'),
  path.join(ROOT_DIR, 'src', 'shared'),
];

// E2E files to skip (screenshots.spec.ts has intentional fallback selectors)
const SKIP_E2E_FILES = ['screenshots.spec.ts'];

// Known exceptions: test IDs that are valid but won't match a static definition.
// These are genuinely stale references that pre-date this script; they should be
// cleaned up over time. Add new entries only with a comment explaining why.
const ALLOWLIST: string[] = [
  // Stale sidebar section IDs — removed during sidebar refactor, E2E tests not yet updated
  'trash-section',
  'active-section',
  'active-session-list',
  'trash-session-list',
  // Stale IDs from component renames — E2E tests reference old component test IDs
  'session-history-entry',
  'composer-textarea',
  'message-item',
  'usecases-panel-empty',
  // Runtime IDs defined in inline plugin source inside tests/e2e/plugins.spec.ts (not in src/)
  'e2e-plugin-content',
  'e2e-plugin-counter',
  // Runtime IDs defined in inline plugin source inside tests/e2e/plugin-conversation-api.spec.ts
  'plugin-ready',
  'conv-count',
  'active-session-id',
  'captured-session-id',
];

interface TestIdRef {
  id: string;
  file: string;
  line: number;
  isPrefix: boolean;   // true for [data-testid^="..."] selectors
  isDynamic: boolean;  // true for template literal patterns containing ${...}
}

interface TestIdDef {
  id: string;
  file: string;
  line: number;
  isDynamic: boolean;
}

// ---------------------------------------------------------------------------
// E2E scanning: extract test IDs used in locators/selectors
// ---------------------------------------------------------------------------

function scanE2EFiles(): TestIdRef[] {
  const results: TestIdRef[] = [];
  const seen = new Set<string>();

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.spec.ts') || entry.name === 'test-utils.ts') {
        if (SKIP_E2E_FILES.includes(entry.name)) continue;
        scanE2EFile(fullPath, results, seen);
      }
    }
  }

  walk(E2E_DIR);
  return results;
}

function scanE2EFile(
  filePath: string,
  results: TestIdRef[],
  seen: Set<string>,
): void {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const relativePath = path.relative(ROOT_DIR, filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Pattern 1: [data-testid="exact-value"]
    // Note: inside template literals, `${var}` appears as literal text in the source file,
    // so this regex captures them too — we detect and flag them as dynamic below.
    const exactMatches = line.matchAll(/\[data-testid="([^"]+)"\]/g);
    for (const match of exactMatches) {
      const isDynamic = match[1].includes('${');
      addRef(match[1], relativePath, i + 1, false, isDynamic, results, seen);
    }

    // Pattern 2: [data-testid^="prefix-value"] (starts-with selector)
    const prefixMatches = line.matchAll(/\[data-testid\^="([^"]+)"\]/g);
    for (const match of prefixMatches) {
      addRef(match[1], relativePath, i + 1, true, false, results, seen);
    }

    // Pattern 3: getByTestId('value') or getByTestId("value")
    const getByMatches = line.matchAll(/getByTestId\(['"]([^'"]+)['"]\)/g);
    for (const match of getByMatches) {
      addRef(match[1], relativePath, i + 1, false, false, results, seen);
    }

    // Pattern 4: template literals with data-testid — e.g. `[data-testid="settings-tab-${tab}"]`
    const templateMatches = line.matchAll(/`[^`]*\[data-testid="([^`"]*\$\{[^`"]*)"?\][^`]*`/g);
    for (const match of templateMatches) {
      addRef(match[1], relativePath, i + 1, false, true, results, seen);
    }

    // Pattern 5: template literals with getByTestId — e.g. getByTestId(`something-${var}`)
    const templateGetByMatches = line.matchAll(/getByTestId\(`([^`]*\$\{[^`]*)`\)/g);
    for (const match of templateGetByMatches) {
      addRef(match[1], relativePath, i + 1, false, true, results, seen);
    }
  }
}

function addRef(
  id: string,
  file: string,
  line: number,
  isPrefix: boolean,
  isDynamic: boolean,
  results: TestIdRef[],
  seen: Set<string>,
): void {
  const key = `${id}::${isPrefix}`;
  if (!seen.has(key)) {
    seen.add(key);
    results.push({ id, file, line, isPrefix, isDynamic });
  }
}

// ---------------------------------------------------------------------------
// Source scanning: extract test ID definitions from renderer/preload/shared
// ---------------------------------------------------------------------------

function scanSourceFiles(): TestIdDef[] {
  const results: TestIdDef[] = [];

  for (const dir of SOURCE_DIRS) {
    if (!fs.existsSync(dir)) continue;
    walkSource(dir, results);
  }

  return results;
}

function walkSource(dir: string, results: TestIdDef[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      walkSource(fullPath, results);
    } else if (
      entry.name.endsWith('.tsx') ||
      entry.name.endsWith('.ts')
    ) {
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
      if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.spec.tsx')) continue;
      scanSourceFile(fullPath, results);
    }
  }
}

function scanSourceFile(filePath: string, results: TestIdDef[]): void {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const relativePath = path.relative(ROOT_DIR, filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Pattern 1: data-testid="value" (JSX attribute with string literal)
    const stringMatches = line.matchAll(/data-testid="([^"]+)"/g);
    for (const match of stringMatches) {
      results.push({ id: match[1], file: relativePath, line: i + 1, isDynamic: false });
    }

    // Pattern 2: data-testid={'value'} or data-testid={"value"} (JSX expression with string)
    const exprStringMatches = line.matchAll(/data-testid=\{['"]([^'"]+)['"]\}/g);
    for (const match of exprStringMatches) {
      results.push({ id: match[1], file: relativePath, line: i + 1, isDynamic: false });
    }

    // Pattern 3: data-testid={`value-${...}`} (JSX expression with template literal)
    const templateMatches = line.matchAll(/data-testid=\{`([^`]+)`\}/g);
    for (const match of templateMatches) {
      const value = match[1];
      const isDynamic = value.includes('${');
      results.push({ id: value, file: relativePath, line: i + 1, isDynamic });
    }

    // Pattern 4: 'data-testid': 'value' (object literal style, used in some components)
    const objectMatches = line.matchAll(/['"]data-testid['"]\s*:\s*['"]([^'"]+)['"]/g);
    for (const match of objectMatches) {
      results.push({ id: match[1], file: relativePath, line: i + 1, isDynamic: false });
    }

    // Pattern 5: 'data-testid': `value-${...}` (object literal with template)
    const objectTemplateMatches = line.matchAll(/['"]data-testid['"]\s*:\s*`([^`]+)`/g);
    for (const match of objectTemplateMatches) {
      const value = match[1];
      const isDynamic = value.includes('${');
      results.push({ id: value, file: relativePath, line: i + 1, isDynamic });
    }

    // Pattern 6: data-testid={condition ? 'a' : 'b'} (ternary expressions)
    // Extracts both branches of the ternary
    const ternaryMatches = line.matchAll(/data-testid=\{[^}]*\?\s*['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]\s*\}/g);
    for (const match of ternaryMatches) {
      results.push({ id: match[1], file: relativePath, line: i + 1, isDynamic: false });
      results.push({ id: match[2], file: relativePath, line: i + 1, isDynamic: false });
    }

    // Pattern 7: testId: 'value' or testId: "value" (object property that renders as data-testid)
    // Covers patterns like { testId: 'settings-tab-connectors' } used in SettingsSurface
    const testIdPropMatches = line.matchAll(/\btestId:\s*['"]([^'"]+)['"]/g);
    for (const match of testIdPropMatches) {
      results.push({ id: match[1], file: relativePath, line: i + 1, isDynamic: false });
    }

    // Pattern 8: testId='value' or testId="value" or submitTestId="value" (JSX prop)
    // Covers patterns like submitTestId="automations-create-button-hero"
    const testIdJsxMatches = line.matchAll(/\b(?:submit)?[Tt]estId=["']([^"']+)["']/g);
    for (const match of testIdJsxMatches) {
      results.push({ id: match[1], file: relativePath, line: i + 1, isDynamic: false });
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-reference: check every E2E test ID has a source definition
// ---------------------------------------------------------------------------

function crossReference(
  e2eRefs: TestIdRef[],
  sourceDefs: TestIdDef[],
): { errors: string[]; infos: string[] } {
  const errors: string[] = [];
  const infos: string[] = [];

  // Build sets of static source IDs and dynamic source patterns
  const staticIds = new Set<string>();
  const dynamicPrefixes: string[] = [];

  for (const def of sourceDefs) {
    if (def.isDynamic) {
      // Extract the static prefix before the first ${
      const prefix = def.id.split('${')[0];
      if (prefix) dynamicPrefixes.push(prefix);
    } else {
      staticIds.add(def.id);
    }
  }

  for (const ref of e2eRefs) {
    // Skip allowlisted IDs
    if (ALLOWLIST.includes(ref.id)) continue;

    // Dynamic E2E refs (template literals) are informational only
    if (ref.isDynamic) {
      infos.push(
        `  INFO: Dynamic test ID "${ref.id}" at ${ref.file}:${ref.line} — cannot validate statically`,
      );
      continue;
    }

    if (ref.isPrefix) {
      // Prefix selectors: check if any static ID or dynamic prefix starts with this value
      const hasStaticMatch = [...staticIds].some((id) => id.startsWith(ref.id));
      const hasDynamicMatch = dynamicPrefixes.some(
        (p) => p.startsWith(ref.id) || ref.id.startsWith(p),
      );
      if (!hasStaticMatch && !hasDynamicMatch) {
        errors.push(
          `  STALE: Prefix selector [data-testid^="${ref.id}"] at ${ref.file}:${ref.line} — no source definition starts with "${ref.id}"`,
        );
      }
      continue;
    }

    // Exact match: check static IDs first
    if (staticIds.has(ref.id)) continue;

    // Check against dynamic source patterns (e.g., `settings-tab-${tab}` matches "settings-tab-system")
    const matchesDynamic = dynamicPrefixes.some((prefix) => ref.id.startsWith(prefix));
    if (matchesDynamic) continue;

    errors.push(
      `  STALE: Test ID "${ref.id}" at ${ref.file}:${ref.line} — not found in source definitions`,
    );
  }

  return { errors, infos };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('Checking E2E test ID cross-references...\n');

const e2eRefs = scanE2EFiles();
const sourceDefs = scanSourceFiles();
const { errors, infos } = crossReference(e2eRefs, sourceDefs);

// Summary
const staticRefs = e2eRefs.filter((r) => !r.isDynamic && !r.isPrefix);
const prefixRefs = e2eRefs.filter((r) => r.isPrefix);
const dynamicRefs = e2eRefs.filter((r) => r.isDynamic);
const uniqueSourceIds = new Set(sourceDefs.filter((d) => !d.isDynamic).map((d) => d.id));

console.log(`E2E test IDs found: ${e2eRefs.length} (${staticRefs.length} exact, ${prefixRefs.length} prefix, ${dynamicRefs.length} dynamic)`);
console.log(`Source definitions found: ${sourceDefs.length} (${uniqueSourceIds.size} unique static)`);

if (infos.length > 0) {
  console.log(`\nDynamic test IDs (informational):`);
  for (const info of infos) {
    console.log(info);
  }
}

if (errors.length > 0) {
  console.log('');
  for (const error of errors) {
    console.error(error);
  }
  console.error(`\nFAILED: ${errors.length} stale E2E test ID reference(s) found.`);
  console.error('Fix: Update E2E tests to use current test IDs, or add to ALLOWLIST if intentional.');
  process.exit(1);
} else {
  console.log('\nPASSED: All E2E test IDs have matching source definitions.');
}
