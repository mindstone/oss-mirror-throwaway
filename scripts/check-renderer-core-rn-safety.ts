#!/usr/bin/env npx tsx
/**
 * CI Validation: Renderer-reachable Node-only "poison" reachability boundary.
 *
 * Kills the `renderer_node_core_import_leak` class on the RENDERER (Electron
 * browser) surface BY CONSTRUCTION — the sibling of
 * `scripts/check-mobile-core-rn-safety.ts` for the renderer entry graph.
 *
 * WHY A GRAPH SCRIPT, NOT ESLINT: the renderer has an ESLint `no-restricted-imports`
 * rule intended to ban `@core/**`, but it is SILENTLY CLOBBERED by a later
 * same-glob `no-restricted-imports` override (an unrelated `librarySearch` ban).
 * Verify: `npx eslint --print-config src/renderer/features/agent-session/store/sessionStore.ts`
 * — the effective rule restricts only `@shared/utils/settingsUtils`, NOT `@core`.
 * So any renderer file could transitively import `@core/logger` → `node:fs` with
 * `validate:fast` GREEN — exactly the REBEL-6C0 Stage 2 hazard
 * (renderer → sessionMergeUtils → @core/logger). ESLint sees one import
 * statement, not a graph, and a same-glob override REPLACES (not merges) the
 * rule, so it is the wrong tool. A transitive-reachability graph check is immune
 * to override-replacement.
 *
 * The invariant is NOT "renderer must not import @core" — the renderer is
 * core-first by design and legitimately value-imports many RN/browser-safe
 * `@core` modules (`@core/services/conversationState/**`, `sessionIngestGuard.ts`,
 * `@core/constants`, …). The true invariant is narrower:
 *
 *   No module reachable from the RENDERER bundle may pull in NODE-ONLY APIs
 *   (`node:*` / bare Node builtins, or `pino`).
 *
 * SURFACE DIFFERENCE FROM MOBILE — `import.meta` / `createRequire` are NOT poison
 * here. The mobile check treats them as poison because Hermes parse-fatals on
 * `import.meta`. The Electron renderer runs in Chromium ESM under Vite, where
 * `import.meta.env` / `import.meta.hot` are first-class and pervasive (200+
 * legitimate renderer uses). So the renderer's poison set is the strict subset
 * that genuinely breaks the BROWSER bundle: Node built-ins (`node:*` + bare
 * `fs`/`path`/`os`/…) and `pino` (a Node logger). We reuse the mobile engine's
 * detection unchanged and FILTER OUT the `import.meta` / `createRequire` reasons
 * for this surface (RENDERER_POISON_REASON_PREFIXES) — a parameterization, not
 * new analysis.
 *
 * REUSE: this is a thin runner over the mobile check's exported, surface-agnostic
 * graph engine (`buildAliasRules` / `resolveSpecifier` / `analyzeSource` /
 * `walkReachability` / `filterAllowlisted`). Only the entry-collection
 * (`src/renderer/**`), the alias source (`tsconfig.renderer.json` paths, resolved
 * against the REPO ROOT — renderer tsconfig paths are repo-relative, no baseUrl),
 * the entry/frontier predicate, and the renderer poison-reason subset differ.
 * AST traversal + allowlist/ratchet semantics are identical (tested in the mobile suite).
 *
 * Run: npx tsx scripts/check-renderer-core-rn-safety.ts
 * Wired into: npm run validate:fast (validate:renderer-core-rn-safety)
 *
 * @see scripts/check-mobile-core-rn-safety.ts (the shared graph engine + design)
 * @see docs/plans/260622_fix-message-render-drop/PLAN.md Stage 4
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import {
  buildAliasRules,
  walkReachability,
  filterAllowlisted,
  type AliasRule,
  type MobileCoreRnSafetyAllowlistEntry,
  type Violation,
} from './check-mobile-core-rn-safety';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const RENDERER_ROOT = path.join(REPO_ROOT, 'src', 'renderer');

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '__tests__', '__mocks__']);

// ---------------------------------------------------------------------------
// Allowlist + ratchet (same shape/semantics as the mobile check). Reuse the
// mobile entry type — an exemption is an exact (entry, poison, reason) tuple.
// ---------------------------------------------------------------------------

/**
 * EMPTY at ship — after the Stage 2 extraction (the pure guard moved to
 * `sessionIngestGuard.ts`), the renderer graph reaches ZERO Node-only poison
 * modules. Each future entry must encode a justified, audited browser-safe
 * exception and bump `--expected-count` in lockstep. Default-deny: do NOT narrow
 * the poison set to silence a false positive — add a commented allowlist entry.
 */
export const ALLOWLIST: ReadonlyArray<MobileCoreRnSafetyAllowlistEntry> = [];

// ---------------------------------------------------------------------------
// Renderer poison-reason subset
// ---------------------------------------------------------------------------

/**
 * The renderer-relevant poison reasons. `analyzeSource` (shared with the mobile
 * check) emits four reason shapes: `imports Node builtin '...'`, `imports 'pino'`,
 * `uses import.meta`, `uses createRequire`. The first two genuinely break the
 * BROWSER bundle (Node built-ins / a Node logger). `import.meta` and
 * `createRequire` are Hermes-fatal on mobile but FINE in the Chromium/Vite
 * renderer — so they are NOT poison on this surface. We keep only the
 * Node-built-in / pino reasons. (Substring match: the mobile emitter's exact
 * strings all begin with "imports ".)
 */
const RENDERER_POISON_REASON_PREFIXES = ['imports Node builtin', "imports 'pino'"] as const;

function isRendererPoisonReason(reason: string): boolean {
  return RENDERER_POISON_REASON_PREFIXES.some((p) => reason.startsWith(p));
}

/**
 * Narrow each violation's reasons to the renderer-relevant (Node-only) subset.
 * A violation survives only if it has at least one such reason; otherwise it was
 * a browser-safe `import.meta`/`createRequire` use and is dropped.
 */
export function filterRendererPoison(violations: readonly Violation[]): Violation[] {
  const result: Violation[] = [];
  for (const v of violations) {
    const reasons = v.reasons.filter(isRendererPoisonReason);
    if (reasons.length > 0) {
      result.push({ ...v, reasons });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Renderer alias resolution: tsconfig.renderer.json paths, resolved against the
// REPO ROOT (renderer tsconfig has no baseUrl → paths are repo-relative, e.g.
// "@core/*" → "./src/core/*").
// ---------------------------------------------------------------------------

function readRendererAliasRules(): AliasRule[] {
  const configPath = path.join(REPO_ROOT, 'tsconfig.renderer.json');
  const raw = readFileSync(configPath, 'utf-8');
  // Use TypeScript's own JSONC parser — robust to // and /* */ comments and
  // trailing commas, and (unlike a naive regex) it does NOT mistake the `/*` in
  // a path glob like "@/*" for a block comment.
  const { config, error } = ts.parseConfigFileTextToJson(configPath, raw);
  if (error || !config) {
    throw new Error(
      `Failed to parse tsconfig.renderer.json: ${
        error ? ts.flattenDiagnosticMessageText(error.messageText, '\n') : 'unknown'
      }`,
    );
  }
  const paths = (config.compilerOptions?.paths ?? {}) as Record<string, string[]>;
  // baseDir = REPO_ROOT because renderer tsconfig paths are repo-relative (no baseUrl).
  return buildAliasRules(paths, REPO_ROOT);
}

// ---------------------------------------------------------------------------
// Renderer entry collection: all renderer source under src/renderer/** (the
// `main.tsx` bundle root and everything it can reach), excluding tests/specs.
//
// SCOPE: this guard covers ONLY the browser-renderer graph under `src/renderer/**`.
// The PRELOAD bundle (`src/preload/`) is intentionally OUT OF SCOPE — it is a
// separate, privileged Electron surface (context-isolation bridge) that runs in a
// Node-enabled context and legitimately imports `electron` and Node-only APIs.
// Applying the renderer poison set to preload would false-positive on its
// by-design Node usage. (Preload's own safety boundary — never leaking raw
// `electron`/`ipcRenderer` to the renderer — is enforced separately; see
// src/preload/AGENTS.md.)
// ---------------------------------------------------------------------------

function collectRendererEntryFiles(): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const n = entry.name;
        if (
          n.endsWith('.test.ts') ||
          n.endsWith('.test.tsx') ||
          n.endsWith('.spec.ts') ||
          n.endsWith('.spec.tsx') ||
          n.endsWith('.stories.tsx')
        ) {
          continue;
        }
        if (SOURCE_EXTS.includes(path.extname(n))) results.push(path.join(dir, n));
      }
    }
  }
  walk(RENDERER_ROOT);
  return results;
}

// ---------------------------------------------------------------------------
// CLI runner (mirrors the mobile runner's flag parsing + ratchet)
// ---------------------------------------------------------------------------

function parseExpectedCount(args: readonly string[]): number | null {
  const inline = args.find((arg) => arg.startsWith('--expected-count='));
  const splitIndex = args.indexOf('--expected-count');
  const raw = inline
    ? inline.slice('--expected-count='.length)
    : splitIndex >= 0
      ? args[splitIndex + 1]
      : undefined;
  if (raw === undefined) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid --expected-count value: ${raw}`);
  }
  return parsed;
}

export function isDirectInvocation(): boolean {
  if (process.env.VITEST) return false;
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1] !== undefined && process.argv[1].endsWith('check-renderer-core-rn-safety.ts');
  }
}

const FAILURE_GUIDANCE =
  'A module reachable from the RENDERER (Electron browser) bundle pulls in a\n' +
  'Node-only API (node:* / bare Node builtin, import.meta, createRequire, or pino)\n' +
  'that the renderer cannot run — this is the renderer_node_core_import_leak class\n' +
  '(cf. REBEL-6C0 Stage 2: renderer → @core/services/sessionMergeUtils → @core/logger\n' +
  '→ node:fs). tsc and the (clobbered) ESLint @core ban do NOT catch this; the\n' +
  'renderer BUILD does, and so does this graph check.\n\n' +
  'NOTE: a node:* import is perfectly LEGAL for the desktop/cloud core — the problem\n' +
  'is only that this core module is ALSO renderer-reachable. The fix is NOT to remove\n' +
  'the Node mechanics from core; it is to move the pure, renderer-needed logic into a\n' +
  'renderer-safe module that imports no Node-only code (precedent: the Stage 2\n' +
  'extraction of guardActiveIngestRegression into\n' +
  '  src/core/services/sessionIngestGuard.ts,\n' +
  'which imports only types + @shared/utils/eventIdentity). Inject a logger/seam\n' +
  'rather than importing @core/logger into a renderer-reachable module.\n\n' +
  'See docs/plans/260622_fix-message-render-drop/PLAN.md Stage 4. A genuinely\n' +
  'browser-safe exception can be grandfathered via the commented ALLOWLIST in\n' +
  'scripts/check-renderer-core-rn-safety.ts (bump --expected-count in lockstep) —\n' +
  'never narrow the poison set to force green.';

function main(): void {
  let expectedCount: number | null = null;
  try {
    expectedCount = parseExpectedCount(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  if (expectedCount !== null && expectedCount !== ALLOWLIST.length) {
    console.error(
      `✗ Allowlist count mismatch: expected ${expectedCount}, actual ${ALLOWLIST.length}.\n` +
        'Update ALLOWLIST and --expected-count together.',
    );
    process.exitCode = 1;
    return;
  }

  const rules = readRendererAliasRules();
  const entryFiles = collectRendererEntryFiles();
  const isRendererEntry = (p: string): boolean => p.startsWith(RENDERER_ROOT);

  console.log('Checking renderer-reachable Node-only RN-safety boundary...\n');
  console.log(`Allowlist: ${ALLOWLIST.length} entries`);

  const result = walkReachability(entryFiles, rules, {
    repoRoot: REPO_ROOT,
    isEntry: isRendererEntry,
  });
  // Narrow to the renderer poison subset (drop browser-safe import.meta /
  // createRequire), then apply the audited allowlist.
  const rendererViolations = filterRendererPoison(result.violations);
  const violations = filterAllowlisted(rendererViolations, ALLOWLIST);

  console.log(`Renderer entry files: ${result.entryCount}`);
  console.log(`Total files visited (entry + frontier): ${result.visitedCount}`);
  console.log(`In-repo alias frontier files reached: ${result.frontierCount}\n`);

  if (violations.length === 0) {
    console.log('✓ ZERO Node-only poison modules reachable from the renderer bundle.');
    return;
  }

  console.error(`✗ ${violations.length} Node-only poison module(s) reachable from the renderer:\n`);
  for (const v of violations) {
    console.error(`  POISON: ${v.poison}`);
    console.error(`    reasons: ${v.reasons.join('; ')}`);
    console.error(`    chain:   ${v.chain.join('\n             → ')}`);
    console.error('');
  }
  console.error(FAILURE_GUIDANCE);
  process.exitCode = 1;
}

if (isDirectInvocation()) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to check renderer core RN-safety: ${message}`);
    process.exitCode = 1;
  }
}

// Exported for tests.
export { readRendererAliasRules, collectRendererEntryFiles };
