#!/usr/bin/env npx tsx
/**
 * CI guard: renderer `agent:turn` dispatch must pass through the explicit
 * supersede-decision chokepoint (`dispatchAgentTurn`).
 *
 * Why (postmortem 260610_queue_drain_cancels_turn, rec 10d93cdce18d854b):
 * `AgentTurnRequest.supersedePolicy` is optional on the wire, and an omitted
 * policy means legacy supersede-on-busy — "cancel the target session's active
 * turn". A new renderer dispatch site that calls `window.agentApi.turn(...)`
 * directly and forgets the field silently inherits interrupt semantics and
 * can destroy a running turn (incident f6b3e9b0). The chokepoint module
 * `src/renderer/features/agent-session/utils/dispatchAgentTurn.ts` makes the
 * decision required at the type level; this guard makes bypassing the module
 * a CI failure.
 *
 * SCOPE / KNOWN LIMITATION (Stage 3 review F3): this is LIGHTWEIGHT TEXTUAL
 * enforcement (regex on comment-stripped source), NOT full AST
 * kill-by-construction. It catches `window.agentApi.turn(` and bare
 * `agentApi.turn(` receivers, but deliberately does not follow alias or
 * destructuring indirection — e.g. `const api = window.agentApi;
 * api.turn(...)` or `const { turn } = window.agentApi; turn(...)` evade it
 * (same trade-off as the sibling check-no-raw-ipc-invoke guard; pinned as a
 * documented known-limitation test in
 * scripts/__tests__/check-agent-turn-dispatch-chokepoint.test.ts). Reviewers
 * should treat aliased dispatch as a review smell; the TYPE seam
 * (dispatchAgentTurn's required decision parameter) is the primary
 * kill-by-construction layer — this guard only blocks the easy/likely bypass.
 *
 * Mechanism: counts raw `agentApi.turn(` call sites (comment-stripped) in
 * `src/renderer/**` production source. Every file with a non-zero count must
 * be in the count-pinned ALLOWLIST with EXACTLY the expected count:
 * - count above the pin  → a new bypass site was added (fail);
 * - count below the pin  → stale allowlist entry (fail — tighten the pin);
 * - allowlisted file missing → stale allowlist entry (fail — remove it).
 * The exact-count pin is the anti-rot mechanism: an entry that no longer
 * matches reality fails loudly instead of silently widening the escape hatch.
 *
 * Run:    npx tsx scripts/check-agent-turn-dispatch-chokepoint.ts
 * Wired:  npm run validate:fast (scripts/run-validate-fast.ts)
 *
 * @see src/renderer/features/agent-session/utils/dispatchAgentTurn.ts
 * @see docs/plans/260611_recs-round4/PLAN.md Stage 3
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from './lib/source-text';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/** Renderer root to scan for raw dispatch sites. */
const SCAN_ROOT = path.join('src', 'renderer');

/** The raw call pattern this guard bans outside the allowlist. */
const RAW_TURN_DISPATCH_PATTERN = /\bagentApi\s*\.\s*turn\s*\(/g;

/**
 * Count-pinned allowlist of intentional raw `agentApi.turn(` call sites.
 * Counts are EXACT: raising requires justification here; lowering is
 * mandatory when a site migrates (the guard fails on a stale pin).
 */
export const RAW_TURN_DISPATCH_ALLOWLIST: ReadonlyArray<{
  file: string;
  expectedCount: number;
  why: string;
}> = [
  {
    file: 'src/renderer/features/agent-session/utils/dispatchAgentTurn.ts',
    expectedCount: 1,
    why: 'The chokepoint itself — the single sanctioned wire call.',
  },
  {
    file: 'src/renderer/features/agent-session/hooks/useAgentSessionEngine.ts',
    expectedCount: 3,
    why:
      'Engine internals predating the seam: shared optimistic-lifecycle starter, ' +
      'compaction continue, and edited-message rerun. Their legacy omission semantics ' +
      'are pinned by useAgentSessionEngine.supersedePolicy.test.ts — route NEW engine ' +
      'dispatches through dispatchAgentTurn instead of raising this pin.',
  },
];

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;

function isTestPath(posixPath: string): boolean {
  if (/(^|\/)__tests__\//.test(posixPath)) return true;
  const base = posixPath.split('/').pop() ?? posixPath;
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(base);
}

/** True for files the guard scans (renderer prod source, not tests). */
export function isCountedRendererFile(relativePosixPath: string): boolean {
  if (isTestPath(relativePosixPath)) return false;
  const base = relativePosixPath.split('/').pop() ?? relativePosixPath;
  return SOURCE_EXT.test(base);
}

export interface RawTurnDispatchCount {
  count: number;
  locations: string[]; // file:line entries
}

/**
 * Pure counter: counts raw `agentApi.turn(` occurrences in `source`
 * (comment-stripped, so narrative mentions in `//` or block comments don't
 * count). Matches both `window.agentApi.turn(` and bare `agentApi.turn(`.
 */
export function countRawTurnDispatches(
  source: string,
  relativePosixPath: string,
): RawTurnDispatchCount {
  const stripped = stripComments(source);
  const lines = stripped.split('\n');
  let count = 0;
  const locations: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    RAW_TURN_DISPATCH_PATTERN.lastIndex = 0;
    const matches = lines[i].match(RAW_TURN_DISPATCH_PATTERN);
    if (matches) {
      count += matches.length;
      locations.push(`${relativePosixPath}:${i + 1}`);
    }
  }

  return { count, locations };
}

/** Recursively collect counted renderer files under `dir`. */
export function collectRendererFiles(dir: string, repoRoot: string): string[] {
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
      const relativePosix = path.relative(repoRoot, fullPath).replace(/\\/g, '/');
      if (isCountedRendererFile(relativePosix)) results.push(fullPath);
    }
  }

  walk(dir);
  return results;
}

export type ChokepointViolation = {
  readonly kind: 'new_bypass' | 'stale_allowlist';
  readonly file: string;
  readonly message: string;
};

export interface ScanOptions {
  repoRoot?: string;
  scanRoot?: string;
  allowlist?: ReadonlyArray<{ file: string; expectedCount: number; why: string }>;
}

export interface ChokepointScanResult {
  violations: ChokepointViolation[];
  fileCount: number;
  totalRawSites: number;
}

/**
 * Scan the renderer tree and validate every raw `agentApi.turn(` site against
 * the count-pinned allowlist. Pure given an injected allowlist/scan root, so
 * tests can drive synthetic trees.
 */
export function scanAgentTurnDispatchChokepoint(
  options: ScanOptions = {},
): ChokepointScanResult {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const scanRoot = options.scanRoot ?? path.join(repoRoot, SCAN_ROOT);
  const allowlist = options.allowlist ?? RAW_TURN_DISPATCH_ALLOWLIST;

  const files = collectRendererFiles(scanRoot, repoRoot);
  const countsByFile = new Map<string, RawTurnDispatchCount>();
  let totalRawSites = 0;

  for (const file of files) {
    const relativePosix = path.relative(repoRoot, file).replace(/\\/g, '/');
    const result = countRawTurnDispatches(fs.readFileSync(file, 'utf8'), relativePosix);
    if (result.count > 0) {
      countsByFile.set(relativePosix, result);
      totalRawSites += result.count;
    }
  }

  const violations: ChokepointViolation[] = [];
  const allowlistedFiles = new Set(allowlist.map((entry) => entry.file));

  for (const entry of allowlist) {
    const actual = countsByFile.get(entry.file);
    if (!actual) {
      violations.push({
        kind: 'stale_allowlist',
        file: entry.file,
        message:
          `${entry.file}: allowlisted with expectedCount ${entry.expectedCount} but has 0 raw ` +
          'agentApi.turn( sites (or no longer exists). Remove or tighten the allowlist entry.',
      });
      continue;
    }
    if (actual.count > entry.expectedCount) {
      violations.push({
        kind: 'new_bypass',
        file: entry.file,
        message:
          `${entry.file}: ${actual.count} raw agentApi.turn( sites exceed the allowlist pin of ` +
          `${entry.expectedCount} — a NEW direct dispatch site was added. Route it through ` +
          `dispatchAgentTurn (explicit supersede decision) instead.\n` +
          actual.locations.map((loc) => `    ${loc}`).join('\n'),
      });
    } else if (actual.count < entry.expectedCount) {
      violations.push({
        kind: 'stale_allowlist',
        file: entry.file,
        message:
          `${entry.file}: ${actual.count} raw agentApi.turn( sites is BELOW the allowlist pin of ` +
          `${entry.expectedCount} — a site migrated to the chokepoint. Lower expectedCount to ` +
          `${actual.count} to keep the ratchet honest.`,
      });
    }
  }

  for (const [file, result] of countsByFile) {
    if (allowlistedFiles.has(file)) continue;
    violations.push({
      kind: 'new_bypass',
      file,
      message:
        `${file}: ${result.count} raw agentApi.turn( site(s) outside the chokepoint. A direct ` +
        'dispatch silently inherits legacy supersede-on-busy semantics (cancels the target ' +
        "session's active turn). Route it through dispatchAgentTurn " +
        '(src/renderer/features/agent-session/utils/dispatchAgentTurn.ts) and pick an explicit ' +
        'supersede decision.\n' +
        result.locations.map((loc) => `    ${loc}`).join('\n'),
    });
  }

  violations.sort((a, b) => a.file.localeCompare(b.file));
  return { violations, fileCount: files.length, totalRawSites };
}

// ---------------------------------------------------------------------------
// CLI runner — skipped when imported for testing (Vitest sets VITEST env var)
// ---------------------------------------------------------------------------
export function main(): void {
  console.log('🔍 Renderer agent:turn dispatch chokepoint (explicit supersede decision)');
  console.log('=========================================================================\n');

  const result = scanAgentTurnDispatchChokepoint();
  console.log(`  Scanned ${result.fileCount} renderer file(s) under ${SCAN_ROOT}/`);
  console.log(
    `  Raw agentApi.turn( sites: ${result.totalRawSites} across ` +
      `${RAW_TURN_DISPATCH_ALLOWLIST.length} allowlisted file(s)\n`,
  );

  if (result.violations.length > 0) {
    console.error(`  ✘ ${result.violations.length} violation(s):\n`);
    for (const violation of result.violations) {
      console.error(`  [${violation.kind}] ${violation.message}\n`);
    }
    console.error(
      'See scripts/check-agent-turn-dispatch-chokepoint.ts (allowlist + rationale) and\n' +
        'docs-private/postmortems/260610_queue_drain_cancels_turn_postmortem.md.',
    );
    process.exit(1);
  }

  console.log('  ✔ OK — every renderer agent:turn dispatch goes through dispatchAgentTurn\n');
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly && !process.env.VITEST) {
  main();
}
