#!/usr/bin/env npx tsx
/**
 * CI Validation: Session hydration boundary
 *
 * Every on-disk session load must coerce the optional-in-practice array fields
 * (`messages`, `eventsByTurn`) before any reader touches them. A raw
 * `JSON.parse(content) as AgentSession` trusts the persisted shape and bypasses
 * Zod defaults, so a malformed/partial-write file can carry a non-array field; a
 * downstream `messages.filter(...)` (e.g. `countUserMessages` inside
 * `createSummary`) then throws — the 2026-06-16 index-collapse class
 * (docs-private/postmortems/260616_session_index_collapse_unguarded_messages_filter).
 *
 * The fix routes session loads through one boundary in
 * `src/core/services/incrementalSessionStore.ts`:
 *   - `hydrateSession(content)`            — parse + full normalizeSessionTurnState
 *   - `hydrateSessionArraysOnly(content)`  — parse + array coercion only
 *
 * This guard makes that impossible-by-construction for future code: any raw
 * `JSON.parse(...) as AgentSession` (outside tests) must carry an explicit
 * `hydration-exempt:` annotation on the same line or within the few lines above,
 * justifying a deliberate raw parse (e.g. an id/tombstone check that must run
 * before normalize's side-effects). Unannotated occurrences fail the build,
 * steering authors to the hydrate helpers.
 *
 * Run: npx tsx scripts/check-session-hydration-boundary.ts
 * Wired into: npm run validate:fast
 *
 * @see docs/plans/260616_hydrate-session-generalization/PLAN.md
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..');

// Directories that load persisted sessions across surfaces. Tests are excluded
// (they legitimately construct AgentSession fixtures).
const SCAN_DIRS = [
  path.join(REPO_ROOT, 'src'),
  path.join(REPO_ROOT, 'cloud-service', 'src'),
  path.join(REPO_ROOT, 'cloud-client', 'src'),
  path.join(REPO_ROOT, 'packages'),
];

// Matches a raw session parse in either cast syntax:
//   - `JSON.parse(<anything, incl. nested calls>) as AgentSession`
//   - `<AgentSession>JSON.parse(...)` (angle-bracket assertion)
// The inner group is greedy (`.*`) on purpose so a NESTED call —
// `JSON.parse(await fs.readFile(...)) as AgentSession` — is caught too (a `[^)]*`
// inner group would stop at the first `)` and miss it). Requiring `AgentSession`
// immediately after `as ` excludes narrowed casts like `as Pick<AgentSession, ...>`.
// KNOWN LIMITATION (line-by-line scan): a parse whose `JSON.parse(` and `as
// AgentSession` are split across lines is not caught. The codebase writes these
// on one line; if that changes, switch this to an AST scan.
const RAW_PARSE_RE = /JSON\.parse\(.*\)\s*as\s+AgentSession\b|<\s*AgentSession\s*>\s*JSON\.parse\(/;
// The exemption must be a real comment annotation with a reason (`// hydration-exempt:`
// or block-comment `* hydration-exempt:`), not just the bare substring appearing
// in a string/identifier — so it can't be tripped accidentally.
const EXEMPT_RE = /(?:\/\/|\*)\s*hydration-exempt:/;
// How many lines above the match may carry the annotation.
const ANNOTATION_LOOKBACK = 6;

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(full);
      } else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.spec.ts')
      ) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

/**
 * Pure scan of one file's source. Returns sanctioned (annotated) raw-parse count
 * and the unannotated violations. Exported for unit testing (non-vacuous proof).
 */
export function scanContent(content: string): {
  sanctioned: number;
  violations: Array<{ line: number; text: string }>;
} {
  const lines = content.split('\n');
  let sanctioned = 0;
  const violations: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!RAW_PARSE_RE.test(line)) continue;
    // Skip lines that are part of a doc/block comment narrative.
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;

    const window = lines.slice(Math.max(0, i - ANNOTATION_LOOKBACK), i + 1).join('\n');
    if (EXEMPT_RE.test(window)) {
      sanctioned++;
    } else {
      violations.push({ line: i + 1, text: trimmed });
    }
  }
  return { sanctioned, violations };
}

function main(): void {
  const violations: Violation[] = [];
  let sanctioned = 0;

  for (const dir of SCAN_DIRS) {
    for (const file of listTsFiles(dir)) {
      const result = scanContent(fs.readFileSync(file, 'utf8'));
      sanctioned += result.sanctioned;
      for (const v of result.violations) {
        violations.push({ file: path.relative(REPO_ROOT, file), line: v.line, text: v.text });
      }
    }
  }

  if (violations.length > 0) {
    console.error('❌ Session hydration boundary violated.\n');
    console.error(
      'Raw `JSON.parse(...) as AgentSession` bypasses array coercion and can reopen the\n' +
        '2026-06-16 index-collapse class (a reader hitting a non-array messages/eventsByTurn).\n',
    );
    console.error('Route the load through the hydration boundary in incrementalSessionStore.ts:');
    console.error('  - hydrateSession(content)           — parse + full normalize (load for use)');
    console.error('  - hydrateSessionArraysOnly(content) — parse + array coercion only\n');
    console.error(
      'If a raw parse is genuinely required (e.g. an id/tombstone check that must precede\n' +
        "normalize's side-effects), add a `// hydration-exempt: <reason>` annotation on or\n" +
        'just above the line.\n',
    );
    console.error('Unannotated occurrences:');
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.text}`);
    }
    process.exit(1);
  }

  console.log(
    `✅ Session hydration boundary intact (${sanctioned} sanctioned raw parse${sanctioned === 1 ? '' : 's'}, 0 unannotated).`,
  );
}

if (require.main === module) {
  main();
}
