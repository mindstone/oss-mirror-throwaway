#!/usr/bin/env npx tsx
/**
 * CI Validation: LanceDB Predicate Safety
 *
 * Prevents reintroducing hand-rolled LanceDB/DataFusion SQL predicate bugs by scanning
 * for double-quoted camelCase identifiers near .where()/.delete()/update({ where: ... })
 * and for local escape helper drift in service files.
 *
 * Run: npx tsx scripts/check-lancedb-predicates.ts
 * Wired into: npm run validate:fast
 *
 * @see docs/plans/260403_lancedb_predicate_safety_hardening.md
 */

import * as fs from 'fs';
import * as path from 'path';

export interface Violation {
  file: string;
  line: number;
  text: string;
  rule: string;
}

const TARGET_DIRS = [
  path.join(__dirname, '..', 'src', 'main', 'services'),
  path.join(__dirname, '..', 'src', 'main', 'workers'),
  path.join(__dirname, '..', 'src', 'core'),
  path.join(__dirname, '..', 'evals', 'benchmarks'),
];

const EXCLUDED_FILES = new Set([
  path.join(__dirname, '..', 'src', 'main', 'utils', 'lancedbPredicates.ts'),
]);

const DOUBLE_QUOTED_CAMEL_CASE = /"[a-z][a-zA-Z]+"/g;
const PREDICATE_TRIGGERS = [/.where\s*\(/, /\.delete\s*\(/, /update\s*\(\s*\{/];
const LOCAL_ESCAPE_FUNCTION = /\bfunction\s+(escapeLanceDBString|escapeValue)\s*\(/;
const PREDICATE_CONTEXT_LINES = 5;

// LanceDB 0.22.x lowercases FTS column names internally, so camelCase columns
// silently fail index creation. Detect camelCase strings in FTS-related API calls.
const FTS_API_TRIGGERS = [/\.createIndex\s*\(/, /MultiMatchQuery\s*\(/, /\.fullTextSearch\s*\(/];
const SINGLE_QUOTED_CAMEL_CASE = /'([a-z][a-zA-Z]+)'/g;
const FTS_CONTEXT_LINES = 3;

export function findLanceDbPredicateViolations(source: string, filePath: string): Violation[] {
  const violations: Violation[] = [];
  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (!PREDICATE_TRIGGERS.some((pattern) => pattern.test(lines[i]))) {
      continue;
    }

    const window = lines.slice(i, i + PREDICATE_CONTEXT_LINES + 1);
    for (let j = 0; j < window.length; j++) {
      const line = window[j];
      const matches = line.match(DOUBLE_QUOTED_CAMEL_CASE);
      if (!matches) continue;

      for (const match of matches) {
        violations.push({
          file: filePath,
          line: i + j + 1,
          text: line.trim(),
          rule: `double-quoted-camelcase-predicate (${match})`,
        });
      }
    }
  }

  // Rule: camelCase column names in FTS API calls (LanceDB lowercases internally)
  for (let i = 0; i < lines.length; i++) {
    if (!FTS_API_TRIGGERS.some((pattern) => pattern.test(lines[i]))) {
      continue;
    }

    const window = lines.slice(i, i + FTS_CONTEXT_LINES + 1);
    for (let j = 0; j < window.length; j++) {
      const line = window[j];
      // Check both single-quoted and double-quoted camelCase strings
      for (const regex of [SINGLE_QUOTED_CAMEL_CASE, DOUBLE_QUOTED_CAMEL_CASE]) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line)) !== null) {
          const value = match[1] || match[0].slice(1, -1);
          // Only flag if it has an uppercase letter (true camelCase)
          if (/[A-Z]/.test(value)) {
            violations.push({
              file: filePath,
              line: i + j + 1,
              text: line.trim(),
              rule: `fts-camelcase-column ("${value}" — LanceDB FTS lowercases column names; use snake_case)`,
            });
          }
        }
      }
    }
  }

  if (filePath.startsWith(path.join('src', 'main', 'services'))) {
    for (let i = 0; i < lines.length; i++) {
      if (!LOCAL_ESCAPE_FUNCTION.test(lines[i])) continue;

      violations.push({
        file: filePath,
        line: i + 1,
        text: lines[i].trim(),
        rule: 'local-escape-helper',
      });
    }
  }

  return violations;
}

function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const results: string[] = [];

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(fullPath);
        continue;
      }

      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) {
        continue;
      }
      if (entry.name.includes('.test.')) {
        continue;
      }
      if (EXCLUDED_FILES.has(fullPath)) {
        continue;
      }

      results.push(fullPath);
    }
  }

  walk(dir);
  return results;
}

if (!process.env.VITEST) {
  const repoRoot = path.join(__dirname, '..');
  const files = TARGET_DIRS.flatMap((dir) => collectSourceFiles(dir));
  const violations: Violation[] = [];

  console.log('Checking LanceDB predicate safety...\n');
  for (const dir of TARGET_DIRS) {
    console.log(`Scanning: ${path.relative(repoRoot, dir)}/`);
  }
  console.log('');

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const relativePath = path.relative(repoRoot, file);
    violations.push(...findLanceDbPredicateViolations(source, relativePath));
  }

  if (violations.length > 0) {
    console.error(`✗ Found ${violations.length} LanceDB predicate violation(s):\n`);
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line} [${violation.rule}]`);
      console.error(`    ${violation.text}\n`);
    }
    console.error(
      'Use shared helpers from src/main/utils/lancedbPredicates.ts for camelCase predicates,\n' +
        'and do not define local LanceDB string escape helpers in services.\n' +
        'See: docs/plans/260403_lancedb_predicate_safety_hardening.md',
    );
    process.exit(1);
  }

  console.log(`✓ ${files.length} files scanned — no LanceDB predicate safety violations found`);
}
