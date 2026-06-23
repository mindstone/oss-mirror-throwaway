#!/usr/bin/env npx tsx
/**
 * Ratchet guard — no NEW raw `ipcRenderer.invoke(...)` sites in the preload layer.
 *
 * Kill-by-construction guard (260609 IPC in-process contract harness follow-up).
 * `src/preload/index.ts` hand-wires ~132 raw `ipcRenderer.invoke('channel', payload)`
 * call sites that bypass the typed `makeDomainApi` / `DomainApi<T>` bridge surface
 * (`src/preload/ipcBridge.ts` / `ipcBridgeBuilder.ts`). At a raw site the request
 * arg is `any` (Electron's `invoke(channel: string, ...args: any[])`), so a
 * request-shape drift against the channel contract (`src/shared/ipc/channels/*`)
 * is NOT a compile error AND is NOT covered by the round-trip harness (which
 * drives requests through `makeDomainApi` using contract-derived samples — it
 * never executes the raw `index.ts` literals). See the investigation:
 *   docs/plans/260609_ipc-inprocess-contract-harness/subagent_reports/260609_213705_raw-invoke-callsite-risk.md
 *
 * This guard counts raw `ipcRenderer.invoke(` call sites in `src/preload/**`
 * that live OUTSIDE the sanctioned typed bridge files, and FAILS when the count
 * EXCEEDS the baseline (a new untyped site was added). It does NOT force the
 * 132-site big-bang migration; it freezes the surface at the diff boundary and
 * gives a downward ratchet for opportunistic migration.
 *
 * Metric: raw `ipcRenderer.invoke(` occurrences (comment-stripped) in
 * `src/preload/**`, excluding the typed-bridge files
 * (`ipcBridge.ts`, `ipcBridgeBuilder.ts`) where forwarding via `invoke` is the
 * sanctioned mechanism. Today every raw site lives in `src/preload/index.ts`.
 *
 * Route NEW IPC calls through the typed `window.api` / `makeDomainApi` surface
 * instead of raw `ipcRenderer.invoke`. As raw sites migrate to the typed bridge,
 * LOWER the baseline. Only RAISE it with an explicit justification.
 *
 * Run:    npx tsx scripts/check-no-raw-ipc-invoke.ts
 * Wired:  npm run validate:fast (scripts/run-validate-fast.ts)
 *
 * @see src/preload/AGENTS.md ("don't add ad-hoc untyped IPC calls outside the contract system")
 * @see docs/plans/260609_ipc-inprocess-contract-harness/PLAN.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripComments } from './lib/source-text';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Baseline — the EXACT current count of raw `ipcRenderer.invoke(` sites in the
// preload layer outside the typed bridge. LOWER this as sites migrate to
// `makeDomainApi`; only RAISE with explicit justification (a new raw site is
// almost always a request-shape drift hazard — prefer the typed bridge).
//
// 132 → 134 (260611, fsevents-shutdown-crash Stage 3/4): two raw sites added to
// the REBEL_E2E_TEST_MODE-only e2e bridge in src/preload/index.ts —
//   `getFseventsLeakGuardDiagnostics` → invoke('e2e:fsevents-leak-guard-diagnostics')
//   `injectFseventsLeak`              → invoke('e2e:fsevents-inject-leak')
// Justification: the e2e bridge is raw-and-baselined BY CONVENTION (all 9
// pre-existing `e2e:*` invokes are inside this baseline; zero e2e channels
// exist in the shared ipcContract). Routing test-only channels through the
// typed window.api/makeDomainApi surface would put them on the PRODUCTION
// contract surface — exactly what the test-mode gating forbids (PLAN
// 260611_fsevents-shutdown-crash Stage 3a: "no production exposure") — and a
// local ad-hoc makeDomainApi shim would pass this ratchet without gaining the
// round-trip-harness coverage the typed surface exists for. Both channels are
// void-request, so the request-shape-drift hazard this guard targets is nil.
// ---------------------------------------------------------------------------
export const RAW_IPC_INVOKE_BASELINE = 134;

/** Preload roots to scan for raw invoke sites. */
const SCAN_ROOT = path.join('src', 'preload');

/**
 * Typed-bridge files where forwarding requests via `ipcRenderer.invoke` is the
 * SANCTIONED mechanism (the generated/typed `DomainApi` surface). Raw invoke
 * sites here are NOT counted. Compared by basename so the set is location-stable.
 */
const SANCTIONED_BRIDGE_BASENAMES = new Set(['ipcBridge.ts', 'ipcBridgeBuilder.ts']);

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;

/** The raw call pattern this guard ratchets. */
const RAW_INVOKE_PATTERN = /\bipcRenderer\s*\.\s*invoke\s*\(/g;

function isTestPath(posixPath: string): boolean {
  if (/(^|\/)__tests__\//.test(posixPath)) return true;
  const base = posixPath.split('/').pop() ?? posixPath;
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(base);
}

/** True for files counted by the ratchet (preload prod source, not the bridge, not tests). */
export function isCountedPreloadFile(relativePosixPath: string): boolean {
  if (isTestPath(relativePosixPath)) return false;
  const base = relativePosixPath.split('/').pop() ?? relativePosixPath;
  if (SANCTIONED_BRIDGE_BASENAMES.has(base)) return false;
  return SOURCE_EXT.test(base);
}

export interface RawInvokeCount {
  count: number;
  locations: string[]; // file:line entries (capped for reporting)
}

/**
 * Pure counter: counts raw `ipcRenderer.invoke(` occurrences in `source`
 * (comment-stripped so narrative mentions in `//` or block comments don't
 * count). A line with two raw invokes counts as 2.
 */
export function countRawInvokesInSource(source: string, relativePosixPath: string): RawInvokeCount {
  const stripped = stripComments(source);
  const lines = stripped.split('\n');
  let count = 0;
  const locations: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    RAW_INVOKE_PATTERN.lastIndex = 0;
    const matches = lines[i].match(RAW_INVOKE_PATTERN);
    if (matches) {
      count += matches.length;
      if (locations.length < 20) locations.push(`${relativePosixPath}:${i + 1}`);
    }
  }

  return { count, locations };
}

/** Recursively collect counted preload files under `dir`. */
export function collectPreloadFiles(dir: string): string[] {
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
      const relativePosix = path.relative(REPO_ROOT, fullPath).replace(/\\/g, '/');
      if (isCountedPreloadFile(relativePosix)) results.push(fullPath);
    }
  }

  walk(dir);
  return results;
}

export interface RawInvokeScanResult {
  count: number;
  baseline: number;
  exceeded: boolean;
  fileCount: number;
  locations: string[];
}

export interface ScanOptions {
  repoRoot?: string;
  scanRoot?: string;
  baseline?: number;
}

/** Scan the preload tree and tally raw invoke sites against the baseline. */
export function scanRawIpcInvokes(options: ScanOptions = {}): RawInvokeScanResult {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const scanRoot = options.scanRoot ?? path.join(repoRoot, SCAN_ROOT);
  const baseline = options.baseline ?? RAW_IPC_INVOKE_BASELINE;

  const files = collectPreloadFiles(scanRoot);
  let count = 0;
  const locations: string[] = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const relativePosix = path.relative(repoRoot, file).replace(/\\/g, '/');
    const result = countRawInvokesInSource(source, relativePosix);
    count += result.count;
    for (const loc of result.locations) {
      if (locations.length < 20) locations.push(loc);
    }
  }

  return { count, baseline, exceeded: count > baseline, fileCount: files.length, locations };
}

// ---------------------------------------------------------------------------
// CLI runner — skipped when imported for testing (Vitest sets VITEST env var)
// ---------------------------------------------------------------------------
export function main(): void {
  console.log('🔍 Raw ipcRenderer.invoke ratchet (preload typed-contract bypass guard)');
  console.log('========================================================================\n');

  const result = scanRawIpcInvokes();
  console.log(`  Scanned ${result.fileCount} preload file(s) under ${SCAN_ROOT}/ (excluding the typed bridge)`);
  console.log(`  Raw ipcRenderer.invoke( sites: ${result.count} (baseline: ${result.baseline})\n`);

  if (result.exceeded) {
    console.error(
      `  ✘ ${result.count} raw ipcRenderer.invoke( sites exceed baseline ${result.baseline} — a NEW untyped IPC call site was added.`,
    );
    for (const loc of result.locations) console.error(`    ${loc}`);
    console.error(
      '\nRaw ipcRenderer.invoke sites bypass the typed makeDomainApi / DomainApi<T>\n' +
        'contract surface: the request arg is `any`, so a request-shape drift against\n' +
        'the channel contract is NOT a compile error and is NOT covered by the IPC\n' +
        'round-trip harness. Route the new IPC call through the typed window.api /\n' +
        'makeDomainApi surface instead. If a raw call is genuinely unavoidable, RAISE\n' +
        'RAW_IPC_INVOKE_BASELINE in scripts/check-no-raw-ipc-invoke.ts with a comment\n' +
        'explaining why.\n' +
        'See: docs/plans/260609_ipc-inprocess-contract-harness/subagent_reports/260609_213705_raw-invoke-callsite-risk.md',
    );
    process.exit(1);
  }

  if (result.count < result.baseline) {
    console.warn(
      `  ⚠ ${result.count} is below baseline ${result.baseline} — sites migrated to the typed bridge.\n` +
        `    Lower RAW_IPC_INVOKE_BASELINE to ${result.count} to tighten the ratchet.`,
    );
  }
  console.log(`  ✔ OK — ${result.count}/${result.baseline} raw ipcRenderer.invoke sites (within baseline)\n`);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly && !process.env.VITEST) {
  main();
}
