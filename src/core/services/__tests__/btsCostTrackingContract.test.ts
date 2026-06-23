import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, extname, basename } from 'node:path';

/**
 * Contract test — verifies that all production call sites of BTS client functions
 * pass a tracking parameter ({ category: '...' }).
 *
 * This is a heuristic (regex-based, not AST) test that catches the common case
 * of forgetting to add cost tracking to new BTS callers. It reads source files
 * and checks that call sites include tracking arguments.
 *
 * Self-managed callers (those that batch cost tracking manually) are allow-listed.
 *
 * @see src/core/services/behindTheScenesClient.ts — the BTS client
 * @see docs/plans/260406_cost_tracking_audit_and_hardening.md — Stage 3
 */

const SRC_ROOT = resolve(__dirname, '../../..');

/** Files that intentionally skip tracking and self-manage cost recording */
const SELF_MANAGED_ALLOWLIST = new Set([
  'enhancementService.ts',
  // fileIndexService's self-managed BTS caller (_generateChunkContext, batched via
  // accumulateFileIndexCost) was extracted from fileIndexService.ts into the
  // fileIndexService/contextualRetrieval.ts module in the Stage B3 decomposition.
  // index.ts and the other extracted modules contain no BTS call sites.
  'contextualRetrieval.ts',
  // useCaseClient merges `category` into a shared tracking object before calling
  // BTS clients; this regex contract only detects inline `category:` call args.
  'useCaseClient.ts',
]);

/** BTS function names to check */
const BTS_FUNCTIONS = [
  'callBehindTheScenesWithAuth',
  'callWithModelAuthAware',
  'callBehindTheScenes',
  'callWithModel',
];

/**
 * Build a regex that matches invocations of BTS functions.
 * Matches lines like: `const response = await callBehindTheScenesWithAuth(`
 */
const CALL_PATTERN = new RegExp(
  `(?:${BTS_FUNCTIONS.map((f) => `\\b${f}\\s*\\(`).join('|')})`,
);

/**
 * Check if a file region (starting from the call site) contains a tracking argument.
 * Looks for `category:` within the top-level call expression.
 *
 * The heuristic: scan forward from the call site, tracking parenthesis depth.
 * The call expression may span many lines (large options objects with inline prompts).
 * We scan until the outermost call parens close, looking for `category:` which
 * indicates a TrackingOptions argument. Cap at 100 lines to avoid runaway scans.
 */
function hasTrackingArgument(lines: string[], callLineIndex: number): boolean {
  const windowEnd = Math.min(callLineIndex + 100, lines.length);
  let parenDepth = 0;
  let foundCategory = false;
  let started = false;

  for (let i = callLineIndex; i < windowEnd; i++) {
    const line = lines[i];

    if (/\bcategory\s*:/.test(line)) foundCategory = true;

    // Track parens character by character (skip string contents heuristically)
    for (const ch of line) {
      if (ch === '(') { parenDepth++; started = true; }
      if (ch === ')') parenDepth--;
    }

    // Once we've opened and closed the outermost call parens, stop
    if (started && parenDepth <= 0) break;
  }

  return foundCategory;
}

describe('BTS call-site cost tracking contract', () => {
  it('every production call site passes a tracking argument (or is allow-listed)', () => {
    // Find all .ts files under src/, excluding tests and node_modules
    const allEntries = readdirSync(SRC_ROOT, { recursive: true, encoding: 'utf-8' });
    const allFiles = allEntries
      .filter((entry): entry is string => {
        if (extname(entry) !== '.ts') return false;
        if (entry.includes('__tests__')) return false;
        if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) return false;
        if (entry.includes('node_modules')) return false;
        if (basename(entry) === 'behindTheScenesClient.ts') return false;
        return true;
      })
      .map((entry) => resolve(SRC_ROOT, entry));

    const violations: string[] = [];

    for (const filePath of allFiles) {
      const fileName = basename(filePath);

      // Skip allow-listed self-managed callers
      if (SELF_MANAGED_ALLOWLIST.has(fileName)) continue;

      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip import statements (they reference function names but aren't calls)
        if (/^\s*import\s/.test(line)) continue;
        // Skip comments
        if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;
        // Skip type annotations and type imports
        if (/ReturnType<typeof/.test(line)) continue;

        if (CALL_PATTERN.test(line)) {
          if (!hasTrackingArgument(lines, i)) {
            const relPath = relative(SRC_ROOT, filePath);
            violations.push(`${relPath}:${i + 1} — call without tracking argument`);
          }
        }
      }
    }

    if (violations.length > 0) {
      const message = [
        'BTS call sites missing cost tracking:',
        ...violations.map((v) => `  • ${v}`),
        '',
        'Every call to callBehindTheScenesWithAuth / callWithModelAuthAware / callBehindTheScenes / callWithModel',
        'should pass a { category: "..." } tracking argument.',
        'If this caller self-manages cost tracking, add its filename to SELF_MANAGED_ALLOWLIST.',
      ].join('\n');
      expect.fail(message);
    }
  });
});
