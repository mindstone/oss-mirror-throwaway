#!/usr/bin/env npx tsx
/**
 * Escape-hatch ratchet — prevents new type-safety escape hatches from accumulating.
 *
 * Counts `as any`, `@ts-ignore`/`@ts-expect-error`, and `eslint-disable` directives
 * in production source code (excluding test files). Each category has an independent
 * baseline; exceeding any baseline fails the script.
 *
 * Uses Node.js file walking (no shell dependencies) for cross-platform reliability.
 * Counts actual occurrences, not lines (a line with two `as any` counts as 2).
 *
 * When you remove escape hatches, lower the baselines!
 *
 * Usage: npx tsx scripts/check-escape-hatches.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isProductionSourcePath, stripComments } from './lib/source-text';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Baselines — lower these as escape hatches are removed
// ---------------------------------------------------------------------------
export const AS_ANY_BASELINE = 69;
export const TS_COMMENT_BASELINE = 5; // @ts-ignore + @ts-expect-error
// Bumped 2026-05-22 (204 → 232) to acknowledge legitimate drift since last
// sweep, BUT this is a high baseline with mixed quality — periodic resweeps
// should hunt it back down.
//
// 2026-05-22 audit (covers all 232 directives in production source, ~269
// total line-occurrences because some lines disable multiple rules):
//   - Top rules: react-hooks/exhaustive-deps (~65, ~28% — by far the most
//     common; pervasive `useEffect`-with-narrowed-deps pattern), no-console
//     (~39), no-explicit-any (~36), naming-convention (~33),
//     no-restricted-syntax (~30), no-non-null-assertion (~15),
//     no-restricted-properties (~13), prefer-const (~11), plus a long tail
//     of project-specific rules (rebel-provider-defaults, bts-flow-shape).
//   - Rationale quality: 260523 follow-up sweep cleared the two largest
//     bare clusters (react-hooks/exhaustive-deps 39 → 0, no-console 13 → 0
//     of which 2 became structured logger calls).
//   - Counting note: this comment's per-rule numbers come from a
//     path-aware re-count after the 260523 sweep (rg of src/ excluding
//     __tests__/, *.test.*, *.spec.*, *.stories.*, __lint_fixtures__/,
//     lines without ' -- '). The legacy content-only grep recipe in
//     prior planning docs counted ~41 lines because `grep -h` strips
//     filenames so path filters silently fail (counts ~15 test-file
//     directives + ambient comment text). 24 is the production reality.
//
// Stage 8 of the 260523 sweep cleared the remaining 24 bare disables in
// production code (no-explicit-any 17, naming-convention 3,
// no-unused-vars 2, no-non-null-assertion 1, no-restricted-syntax 1) by
// adding inline ` -- <reason>` rationales — see
// docs/plans/260523_260523-code-health-followup/PLAN.md Stage 8 for the
// per-rule rationale catalog. Future agents adding new eslint-disable
// directives should follow the established patterns.
//
// Next-sweep targets, in priority order:
//   1. no-explicit-any cluster: most are forwarded-callback signatures
//      that could be typed with generics. The Stage-8 rationales document
//      WHY each currently uses `any`; the next sweep can pick low-hanging
//      fruit (e.g. structurally-typed ref bags) for actual elimination.
// Lowered 2026-05-25 (230 → 228) by closer-fix-round-2 Stage 4:
// tightened the pattern to require `//` or `/*` comment markers
// immediately before `eslint-disable`, excluding 2 narrative mentions
// of the literal string in `useGlobalHotkey.ts` and a lint-fixture file
// — see scripts/lib/source-text.ts for the comment-stripping helper.
//
// Branch 260522_compile-time-reliability Stage 0 also touched this area:
// added inline ` -- <reason>` rationales to 7 previously-naked disables in
// MessageMarkdown.tsx (5x renderer late-settle observability),
// emitFallbackTelemetry.ts (1x renderer-safe structured-log seam), and
// userQuestionResponseHandler.ts (1x test-seam naming-convention escape).
// No directives added or removed; rationale quality only — count unchanged.
//
// Lowered 2026-05-25 (228 → 225) post-merge with origin/dev: combined tree
// scan landed at 225 (origin's tighter comment-marker pattern + this branch's
// no-net-change Stage 0 sweep).
// Raised 2026-05-25 (225 → 226): native-binding ESM import guard F12 adds
// one renderer-context exemption in src/main/gpu-worker/renderer.ts — the
// gpu-worker runs in a Chromium BrowserWindow (unpacked from asar by
// forge.config.cjs:545-554), so the main-process asar-resolution bug class
// the rule defends against doesn't apply there. The disable is justified by
// design: this is the single legitimate carve-out for the new rule.
// Lowered 2026-05-25 (226 → 222): loadNativeModule-completion sweep
// (Stages 1+2) migrated 5 services (conversationIndexService,
// toolIndexService, indexHealthService, localSttService,
// moonshineTranscriber) from inline createRequire-with-resourcesPath
// blocks to the shared loadNativeModule<T>() helper. Each migrated file
// removed 1 no-non-null-assertion disable (5 × -1), and the centralised
// helper retained 1 disable, for a net delta of -4 (226 → 222).
// Lowered 2026-05-27 (224 → 222): observed actual count == 222 during
// routine code-health sweep; tighten the ratchet to the current floor.
// Raised 2026-05-31 (222 → 238): post-merge re-measure after consolidating five
// worktree branches + the full origin/dev onto dev. The +16 is the cumulative
// UNION of eslint-disable directives each branch (and origin/dev) added in
// different files — no single source. Re-tighten this floor on the next sweep.
// Raised 2026-06-02 (238 → 244): +6 sanctioned `no-restricted-syntax` overrides
// on the existing task-routing-metadata / execution-state write sites in
// rebelCoreQuery.ts — the per-line escape valve for the NEW
// `routingStateWriterGuardSelectors` guard added this run (Stage 7,
// PM 260601_routing_switch_application_state_drift). These are the standard
// sanctioned-override pattern the repo's other ~8 PM-driven no-restricted-syntax
// guards already use; the net effect is MORE guarding, not less. The guard
// statically enforces the parent-route/display keying discipline that produced
// 3 of that run's bugs. Re-tighten on the next sweep if the metadata-writer
// refactor (the deferred Item-1 follow-up) later removes these sites.
// +7 (244 → 251) for DI-22 (260603, switch-exhaustiveness-check → error on
// src/main + src/core + cloud-service). Promoting the rule to `error` requires
// explicit `eslint-disable` on the handful of switches whose discriminant is
// genuinely OPEN at runtime (AgentEvent / RebelCoreEvent arriving over IPC /
// stream / CLI; the `switch(true)` dispatch idiom; out-of-union runtime types) —
// there an exhaustive assertNever would THROW on valid unknown/future values
// (a regression Codex initially introduced; see docs/plans/260602_di22-...). Each
// disable carries an inline justification. Net effect is MORE guarding (the rule
// now blocks everywhere else), not less. Re-tighten if those switches are removed.
// Raised 2026-06-05 (251 → 252): branch 260527_bts-tier-aware-default-resolver
// Stage 10 (tier-aware last-resort) adds a single justified
// no-restricted-properties disable in src/shared/utils/btsModelResolver.ts.
// The Mindstone-managed-mode last-resort branch reads settings.models.model
// directly because importing modelSettingsResolver (or settingsAccessorsPure
// which re-exports it) from btsModelResolver would form a circular
// dependency: getDefaultModelForProvider.ts → btsModelResolver.ts and
// modelSettingsResolver.ts → getDefaultModelForProvider.ts. The inline
// rationale on the disable directive documents this constraint; raising
// the baseline is the agreed exemption rather than refactoring the
// resolver graph as part of this stage.
// Raised 2026-06-07 (252 → 253): 260604 models-namespace cutover C2a adds one
// justified no-restricted-properties disable in src/core/services/settingsStore/index.ts
// (applyCodexRepairMigration). The Codex repair clears stale thinking fields only in
// `models`; the migration now also clears the legacy `claude` mirror so the
// models-namespace per-field merge can't resurrect the cleared value. Reading the raw
// legacy `claude` namespace is exactly what the sibling migrateClaudeToModelsNamespace
// disables in this same file already do (they are in the 252 baseline). settingsStore is
// not in the .claude.* allowlist, so the read needs a per-line disable.
// Raised 2026-06-07 (253 → 257): di22 Roadmap #4 promoted
// rebel-switch-exhaustiveness/no-bare-default-bypass from warn → error repo-wide
// (docs/plans/260607_protections-burndown). Promotion required suppressing the rule on
// switches over genuinely-OPEN values where a tolerant bare default is correct and
// assertNever would risk a runtime crash: open AgentEvent streams
// (conversationStreamCoordinator.ts, runCli.ts), unbounded DOM event.key
// (useSessionSearch.ts, useSearchWithNavigation.ts), and normalized open-string input
// (reasoningEffortResolver.ts). Each disable carries a per-line justification. The one
// CLOSED-union violation the promotion surfaced (FoldersView 'plugins') was fixed with an
// explicit case, not a disable. Net trade: a permanently-enforced exhaustiveness gate on
// src/renderer + src/shared (which had none) for these documented open-switch exemptions.
// Raised 2026-06-08 (257 → 258): the canonical cloudInstance full-wipe const
// (CLOUD_INSTANCE_CLEARED_CLOUD_INSTANCE in src/main/ipc/cloudHandlers.ts) is the sole
// sanctioned writer of a mode:'local' record; it sets cloudUrl/cloudToken to undefined but
// still pairs the mode:'local' + cloudUrl keys structurally, so it carries a per-line
// override for the new no-restricted-syntax drift guard added in PM 260608
// (cloud_instance_multiwriter_drift family). The guard forbids any OTHER literal pairing
// mode:'local' with a live cloudUrl/cloudToken.
// Raised 2026-06-09 (258 → 260): the IPC contract-parse seam (260609 harness)
// adds Electron-IPC-boundary handler types that require `any` for parameter
// BIVARIANCE — `(event: any, ...args: any[])` so a precisely-typed handler
// `(event, payload: Foo) => …` stays assignable to the registry boundary type.
// `unknown` would break assignability at every registerHandler call site. The
// casts are absorbed at this single seam so callers remain precisely typed:
// `src/main/ipc/utils/registerHandler.ts` (ElectronIpcHandler) +
// `src/main/ipc/utils/registerContractHandler.ts` (SeamHandler + the wrapper).
// Raised 2026-06-10 (260 → 261) [merge: migration branch]: src/main/startup/
// ensureMigrationImport.ts is a boot-time migration-adoption side-effect module
// that runs BEFORE the structured logger is constructed (same window as
// ensureAppIdentity/ensureDemoModeUserData). It logs the adopt outcome via console
// for remote debuggability, carrying the same file-level
// `/* eslint-disable no-console -- startup: runs before structured logger */` those
// sibling boot modules use. Established pattern, not new debt.
// Raised 2026-06-10 (261 → 303) [260610_recs-round3-recent Stage 3]: the new
// rendererWindowTargetGetAllWindowsSelectors lint bans BrowserWindow.getAllWindows()
// in src/main/** + private/mindstone/src/**; its design is an EXPLICIT audited
// allowlist — every pre-existing use carries a per-line
// `eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: <reason>`
// classifying it (genuine all-window broadcast / focused-window menu fallback /
// named migration debt). These 42 disables are the lint's visible, shrinkable
// allowlist (see 260610_notification_click_conversation_navigation postmortem),
// not new ad-hoc debt; the count should only go DOWN as sites migrate to the
// injected main-window getter / BroadcastService.
// Raised 2026-06-11 (303 → 304) [merge: recs-round3 × image-input]: the
// OpenRouter image-input 404 check (260610 image-input postmortem) must
// pre-empt the new structured-first classifier phase, using the classifier
// guard's own documented override convention
// (`provider-error-fallback-justified`). Deliberate, single, documented.
// Raised 2026-06-11 (304 → 305) [FOX-2771 Stage 2 approval-execution guard]:
// sessionApprovals.ts gained the test-only reset hook
// `_testing_resetSingleUseApprovals` (consumed by the real-boot helper's
// cleanup + the guard/store unit tests), carrying the SAME per-line
// `eslint-disable-next-line @typescript-eslint/naming-convention -- _testing_
// prefix is the convention for test-only public hooks` that the established
// `_testing_*` seams use (userQuestionResponseHandler.ts ×3). Established
// pattern, single line, documented — not new ad-hoc debt.
// 305 → 301 (260612 weekly code-health): drift-down reconcile to live count.
// 301 → 304 (260612 recs-agentevent-session, recs #12-7/#12-6): the new no-restricted-syntax
// rule banning raw agent:event broadcasts requires 3 documented allowlist disables — the two
// typed chokepoint helpers (broadcastSequencedAgentEvent + the dispatcher-targeted variant in
// agentEventBroadcast.ts) and the intentionally-unsequenced dispatchRendererOnlyAgentEvent in
// agentEventDispatcher.ts. These are the sanctioned exemptions the guard itself defines, each
// with an inline reason — not ad-hoc debt.
// 304 → 307 (260617 dns-threadpool-decouple guard): the new no-restricted-syntax
// rule banning undici dispatchers that don't route DNS off the libuv threadpool
// (260617 DNS-starvation postmortem) requires 3 documented allowlist disables —
// the canonical global installer's `setGlobalDispatcher` + `new Agent` in
// dnsThreadpoolDecouple.ts, and the per-call MCP `new UndiciAgent` in
// mcpClient.ts. All three construct dispatchers with connect.lookup =
// getDecoupledLookup(); they are the guard's own sanctioned carve-outs, each
// with an inline `dns-decouple-justified:` reason — not ad-hoc debt.
// 307 → 309 (260617 dns-guard GPT-review F1 follow-up): closed the guard's
// alias/namespace false-negative by also flagging the `Agent`/`setGlobalDispatcher`
// IMPORT from undici (catches `import { Agent as Foo }`). That flags the undici
// import line in the two canonical modules (dnsThreadpoolDecouple.ts +
// mcpClient.ts), each carved out with one more `dns-decouple-justified:` disable.
// 309 → 311 (260617 SSRF connect-to-validated-IP fix): ssrfProtection.ts now
// constructs a per-request undici `Agent` (buildPinnedDispatcher) whose
// connect.lookup is a constant-returning *pinned* lookup — off the libuv
// threadpool by construction, so it satisfies the dns-decouple guard's intent
// without getDecoupledLookup(). That requires 2 `dns-decouple-justified:`
// disables: the `import { Agent } from 'undici'` line and the `new Agent` in
// buildPinnedDispatcher. Sanctioned carve-outs (the SSRF fix closes the
// pre-existing DNS-rebinding TOCTOU), each with an inline reason — not ad-hoc debt.
// 311 → 315 (260618 automation-origin drift guard Stage 1): the new
// no-restricted-syntax guard banning automation classification via origin needs
// four documented carve-outs for the remaining legitimate origin-value uses:
// persisted legacy migration, preload payload enum validation, current-session
// running indicator, and active busy automation view restoration. Each carries
// `origin-classification-justified:`; the guard blocks reintroduction elsewhere.
// 315 → 316 (260619 turn-hang fix, Stage 4b): applyThreadpoolSize.ts carries a
// file-level `/* eslint-disable no-console */` because it is the FIRST bootstrap
// import (it sets UV_THREADPOOL_SIZE before any async pool op) and therefore runs
// before the structured pino logger exists — so its breadcrumb must use `console`,
// the same constraint installGracefulFs and bootstrap.ts already satisfy. Necessary,
// not debt.
// 316 → 318 (260620 recs-drain Stage 2, PM 260618_quit_save_sync_lock_contention rec 2):
// the new busy-wait persistence guard (no-restricted-syntax, eslint.config.mjs) bans
// acquire*Sync / Atomics.wait / sleepSync in lockedSessionPersistence.ts. Its TWO sanctioned
// sync-acquire call-sites (acquirePerSessionSync / acquireGlobalIndexSync) carry
// `sync-acquire-after-holder-check-justified:` disables — they are reached ONLY after the
// deferral branch above drains same-process holders, so they are genuinely cross-process-only
// (the exact escape hatch the rec sanctions: "or carry an eslint-disable with rationale").
// Necessary, not debt. See docs/plans/260620_recs-drain-prevention-gates.
// 318 → 321 (two concurrent additive bumps merged; +2 and +1):
// +2 (260623 mobile-record-recreated-session L3, managed-key relay): the
// Mindstone managed OpenRouter key now flows to the cloud surface, so two
// production cloud-service modules import the `@main` key-storage seam across the
// cross-surface boundary and carry a per-line
// `eslint-disable-next-line @typescript-eslint/no-restricted-imports -- allowlisted
// in scripts/check-cross-surface-imports.ts` — the cloud route
// (cloud-service/src/routes/openRouterManagedKey.ts) and the bootstrap wiring seam
// (cloud-service/src/bootstrap.ts). Both are allowlisted in
// scripts/check-cross-surface-imports.ts (the openRouterTokenStorage carve-out there
// covers these 2 production modules plus their 4 test-file siblings; the cross-surface
// expected-count is bumped to 12 in the same changeset). See docs/plans/260622_mobile-record-recreated-session/PLAN.md.
// +1 (260623 fsevents-interception-regression Stage 8): initNodePath.ts
// carries a file-level `/* eslint-disable no-console */` for the same reason as its
// sibling applyThreadpoolSize.ts — the bootstrap NODE_PATH shim runs before the
// structured pino logger is initialised, so its outcome breadcrumb must use `console`.
// +1 (260623 refactor-index-startup-extract Stage 3): createWindow moved
// from src/main/index.ts into src/main/startup/mainWindowFactory.ts. Its win32
// update-download close dialog is `dialog.showMessageBox(<live BrowserWindow>, …)` —
// WINDOW-PARENTED (a window sheet, not the parent-less app-modal [NSAlert runModal]
// that the rebel-startup-dialog/no-raw-startup-dialog rule kills), and fires only on a
// real win32 user-initiated close (never the automated/headless boot path). Moving the
// code into src/main/startup/** newly triggers the dir-scoped syntactic rule; routing
// through showStartupMessageBox would drop the parent + add a headless no-op = a
// behaviour change, so the behaviour-preserving fix is an eslint-disable with rationale.
// All sanctioned carve-outs, not ad-hoc debt.
export const ESLINT_DISABLE_BASELINE = 322;

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------
const DEFAULT_SOURCE_DIRS = ['src', 'cloud-service/src', 'cloud-client/src'];
const EXTENSIONS = new Set(['.ts', '.tsx']);
const TEST_PATH_SEGMENTS = ['__tests__', '.test.', '.spec.'];

export function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return TEST_PATH_SEGMENTS.some(seg => normalized.includes(seg));
}

export function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      results.push(...walkDir(fullPath));
    } else if (EXTENSIONS.has(path.extname(entry.name)) && !isTestFile(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

function collectSourceFiles(root: string, sourceDirs: string[]): string[] {
  const files: string[] = [];
  for (const dir of sourceDirs) {
    files.push(...walkDir(path.join(root, dir)));
  }
  return files;
}

// ---------------------------------------------------------------------------
// Pattern counting
// ---------------------------------------------------------------------------
export interface HatchCheck {
  name: string;
  pattern: RegExp;
  baseline: number;
  /**
   * When true (default), the pattern is matched against the
   * comment-stripped source so narrative mentions in `//` or block
   * comments don't count. Set false for patterns that should match
   * directive comments themselves (e.g. `eslint-disable`).
   */
  useStripped?: boolean;
}

// `as any` uses stripped (comment-free) source so narrative mentions like
// `// use as any here` don't count. `@ts-ignore` / `@ts-expect-error` and
// `eslint-disable` are the opposite — the directives ARE in comments, so
// they use raw source. The eslint-disable pattern is additionally tightened
// to require the line to actually START a `//` or `/*` comment with
// `eslint-disable` (excluding narrative mentions like
// `// see also \`eslint-disable\` in this file`).
export const DEFAULT_CHECKS: HatchCheck[] = [
  // \bas\s+any\b — word-boundary anchored. Counted against stripComments output.
  { name: 'as any', pattern: /\bas\s+any\b/g, baseline: AS_ANY_BASELINE },
  // ts-directives — counted against raw source because these directives only
  // take effect when they ARE in a comment (stripping would remove all hits).
  { name: '@ts-ignore / @ts-expect-error', pattern: /@ts-ignore|@ts-expect-error/g, baseline: TS_COMMENT_BASELINE, useStripped: false },
  // eslint-disable — counted against raw source with a tightened pattern.
  // Matches `//` or `/*` comment markers immediately followed by
  // `eslint-disable[-next-line|-line]`. Excludes narrative mentions like
  // `// where \`eslint-disable\` is used` (Opus F1, closer-fix-round-2).
  {
    name: 'eslint-disable',
    pattern: /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b/g,
    baseline: ESLINT_DISABLE_BASELINE,
    useStripped: false,
  },
];

const ESLINT_DISABLE_RULE_PATTERN =
  /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\s+([@\w/-]+(?:\s*,\s*[@\w/-]+)*)/g;

export interface CountResult {
  count: number;
  locations: string[]; // file:line entries for failure reporting
}

export function countOccurrences(
  files: string[],
  pattern: RegExp,
  relativeRoot: string,
  options: { useStripped?: boolean } = {},
): CountResult {
  const useStripped = options.useStripped ?? true;
  let count = 0;
  const locations: string[] = [];

  for (const filePath of files) {
    const rawContent = fs.readFileSync(filePath, 'utf8');
    const content = useStripped ? stripComments(rawContent) : rawContent;
    const lines = content.split('\n');
    const relPath = path.relative(relativeRoot, filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Reset regex lastIndex for global patterns
      pattern.lastIndex = 0;
      const matches = line.match(pattern);
      if (matches) {
        count += matches.length;
        if (locations.length < 20) {
          locations.push(`${relPath}:${i + 1}`);
        }
      }
    }
  }

  return { count, locations };
}

/**
 * Walk source files and return per-rule counts of bare `eslint-disable`
 * directives — those without a trailing ` -- <rationale>` clause. Used by
 * the informational reporter (not the ratchet) so future sweeps can read
 * a path-aware breakdown directly from this script instead of running
 * brittle shell pipelines.
 *
 * Origin: 260523 sweep closer-fix-round-2. Three reviewers (Opus, Gemini,
 * Completeness) independently flagged that the legacy
 * `grep -rh ... | grep -v ' -- '` recipe loses filenames so path-based
 * excludes silently fail and test-file directives leak into "production"
 * counts. This is the structural prevention.
 */
export interface BareDisableReport {
  totalBare: number;
  byRule: Record<string, number>;
  locations: string[]; // file:line: rule entries
}

export function reportBareDisables(files: string[], relativeRoot: string): BareDisableReport {
  let totalBare = 0;
  const byRule: Record<string, number> = {};
  const locations: string[] = [];

  for (const filePath of files) {
    if (!isProductionSourcePath(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const relPath = path.relative(relativeRoot, filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      ESLINT_DISABLE_RULE_PATTERN.lastIndex = 0;
      const match = ESLINT_DISABLE_RULE_PATTERN.exec(line);
      if (!match) continue;
      if (line.includes(' -- ')) continue; // has rationale clause

      const rulesField = match[1];
      const rules = rulesField.split(',').map(s => s.trim()).filter(Boolean);
      for (const rule of rules) {
        totalBare += 1;
        byRule[rule] = (byRule[rule] ?? 0) + 1;
      }
      if (locations.length < 50) {
        locations.push(`${relPath}:${i + 1}: ${rulesField}`);
      }
    }
  }

  return { totalBare, byRule, locations };
}

// ---------------------------------------------------------------------------
// Exported analysis function (for testing)
// ---------------------------------------------------------------------------
export interface EscapeHatchCheckResult {
  name: string;
  count: number;
  baseline: number;
  exceeded: boolean;
  locations: string[];
}

export interface FindEscapeHatchViolationsOptions {
  repoRoot?: string;
  sourceDirs?: string[];
  checks?: HatchCheck[];
}

export interface FindEscapeHatchViolationsResult {
  fileCount: number;
  results: EscapeHatchCheckResult[];
  failed: boolean;
}

export function findEscapeHatchViolations(
  options: FindEscapeHatchViolationsOptions = {},
): FindEscapeHatchViolationsResult {
  const root = options.repoRoot ?? ROOT;
  const sourceDirs = options.sourceDirs ?? DEFAULT_SOURCE_DIRS;
  const hatchChecks = options.checks ?? DEFAULT_CHECKS;

  const files = collectSourceFiles(root, sourceDirs);
  const results: EscapeHatchCheckResult[] = [];

  for (const check of hatchChecks) {
    const result = countOccurrences(files, check.pattern, root, {
      useStripped: check.useStripped ?? true,
    });
    results.push({
      name: check.name,
      count: result.count,
      baseline: check.baseline,
      exceeded: result.count > check.baseline,
      locations: result.locations,
    });
  }

  return {
    fileCount: files.length,
    results,
    failed: results.some(r => r.exceeded),
  };
}

/**
 * Diagnostic helper exposed for the main entrypoint and external tooling.
 * Runs the bare-disable reporter against the same source set as
 * `findEscapeHatchViolations`.
 */
export function findBareDisablesInSources(
  options: FindEscapeHatchViolationsOptions = {},
): BareDisableReport & { fileCount: number } {
  const root = options.repoRoot ?? ROOT;
  const sourceDirs = options.sourceDirs ?? DEFAULT_SOURCE_DIRS;
  const files = collectSourceFiles(root, sourceDirs);
  const report = reportBareDisables(files, root);
  return { ...report, fileCount: files.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export function main(): void {
  console.log('🔍 Escape-hatch ratchet');
  console.log('========================\n');

  const { fileCount, results, failed } = findEscapeHatchViolations();
  console.log(`  Scanning ${fileCount} source files...\n`);

  for (const result of results) {
    if (result.exceeded) {
      console.error(`  ✘ ${result.name}: ${result.count} occurrences (baseline: ${result.baseline}) — new escape hatches introduced`);
      for (const loc of result.locations) {
        console.error(`    ${loc}`);
      }
    } else {
      console.log(`  ✔ ${result.name}: ${result.count}/${result.baseline} (within baseline)`);
      if (result.count < result.baseline) {
        console.warn(`  ⚠ ${result.name}: ${result.count} is below baseline ${result.baseline}; lower the baseline.`);
      }
    }
  }

  console.log('');

  // Informational: print per-rule bare-disable counts (no rationale clause)
  // for production code. Not ratcheted — this lets future sweeps reference
  // a path-aware breakdown directly from this script instead of running
  // brittle shell pipelines.
  const bare = findBareDisablesInSources();
  if (bare.totalBare > 0) {
    console.log(`  ⓘ Bare eslint-disable directives in production code: ${bare.totalBare}`);
    const ruleEntries = Object.entries(bare.byRule).sort((a, b) => b[1] - a[1]);
    for (const [rule, count] of ruleEntries) {
      console.log(`      ${rule}: ${count}`);
    }
    console.log('');
  }

  if (failed) {
    console.error('❌ Escape-hatch ratchet failed — new escape hatches detected.\n');
    console.error('Fix: Remove the escape hatch. If genuinely necessary, raise the baseline in');
    console.error('     scripts/check-escape-hatches.ts with a comment explaining why.\n');
    process.exit(1);
  } else {
    console.log('✅ Escape-hatch ratchet passed\n');
  }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
