#!/usr/bin/env tsx
/**
 * Knip enforcement — gates on zero unused files, zero unused
 * (dev)dependencies, and ratcheted unused export counts.
 *
 * Runs Knip in JSON mode and checks:
 *   1. No unused files are reported (top-level `report.files`).
 *   2. No unused dependencies or devDependencies are reported. Knip nests these
 *      per-file under `report.issues[].dependencies` / `report.issues[].devDependencies`
 *      (NOT a top-level array), so we aggregate across every `issues[]` entry.
 *   3. Unused export and duplicate-export counts do not exceed their baselines.
 *
 * Unused types are reported as telemetry only. They are intentionally not
 * gated yet because the current baseline is noisy and needs a separate tuning
 * pass before it can be made actionable.
 * KEEPs documented in knip.json `ignoreDependencies` are already excluded by Knip.
 *
 * A second `knip --production` leg detects exports/files whose only consumers
 * are tests (invisible to the default leg, which counts test imports as
 * usage). ENFORCING: ratcheted baselines below, plus a production diff-guard
 * leg (scripts/lib/knip-diff-guard.ts) that fails on NEW production findings
 * in changed files even when counts stay under baseline.
 *
 * Usage: npx tsx scripts/check-knip-health.ts
 */
import { execSync } from "child_process";
import { fileURLToPath } from "node:url";
import {
  KNIP_PROD_ESCAPE_HATCH_TEXT,
  KNIP_PROD_SEAM_NAME_PATTERN,
  KNIP_PROD_TEST_PATH_PATTERN,
  KNIP_PRODUCTION_CMD,
  runKnipDiffGuard,
} from "./lib/knip-diff-guard";

export interface KnipDepFinding {
  name: string;
  line?: number;
  col?: number;
}

export interface KnipSymbolFinding {
  name: string;
  line?: number;
  col?: number;
  pos?: number;
}

export interface KnipIssue {
  file?: string;
  dependencies?: KnipDepFinding[];
  devDependencies?: KnipDepFinding[];
  exports?: KnipSymbolFinding[];
  types?: KnipSymbolFinding[];
  duplicates?: KnipSymbolFinding[][];
}

export interface KnipReport {
  files?: string[];
  issues?: KnipIssue[];
}

export interface KnipBaselines {
  exportBaseline: number;
  duplicateBaseline: number;
}

export interface KnipHealthLine {
  stream: "log" | "warn" | "error";
  text: string;
}

export interface KnipHealthEvaluation {
  failed: boolean;
  lines: KnipHealthLine[];
  counts: {
    files: number;
    dependencies: number;
    exports: number;
    duplicates: number;
    types: number;
  };
}

// KNIP-RATCHET: Measured legacy floor of TRULY-unreferenced symbols (knip.json
// sets `ignoreExportsUsedInFile`, so over-exported-but-locally-used symbols are
// not counted — that dropped exports 1353→380 and types 2451→397 on 2026-06-07).
// Exports and duplicate-export GROUPS are gated so they cannot grow silently;
// lower the relevant baseline whenever cleanup reduces the count. Types are
// report-only telemetry until their false-positive profile is tuned enough to gate.
// 213 → 225 (260607 B3 carve-out S10): the carve-out added public boundary-seam
// modules (contributionRelayExtension, contributionPrMetadata, mindstoneApiUrl,
// authHealthCheckRegistry, useIsOssBuild) and relocated the contribution-relay
// service private — leaving its PUBLIC schema's contract types (RelayAttributionMode,
// RelayValidationIssue, RelayErrorBody, RelaySubmitSuccessData, RelayPRStatus, … in
// src/shared/schemas/contributionRelay.ts, kept public per Q5) consumed only by the
// now-private relay service, which knip (real mode) cannot fully trace. These are
// legitimate public-contract / alias-consumed exports, not dead code. Bumped, not
// removed. (Both private bootstrap files are knip entries; see knip.json.)
// 225 → 218 (260610 weekly code-health): removed dead exports left behind by the
// OSS Stage-5 strategic cut + migration/oauth leftovers (contributionGitHubAuthService
// connect/disconnect/status + test seams + orphaned cancel, migrationClassification
// rel-path map/getters, writeMigrationSupportLogSync, discourseCredentialSource).
// 218 → 217 (260612 calendar-followups Stage 4): re-measure at landing said
// lower (per the below-baseline warn); unrelated to the production leg — the
// bang-suffixed knip.json globs were verified count-identical in default mode.
// 217 → 215 (260619 knip-health-clear): re-measure said lower (the check's own
// below-baseline warn) — net default-leg cleanup landed on dev since the last
// ratchet; this change makes no default-leg removals, it just ratchets the floor
// down to the live count so the saved headroom can't silently refill.
export const KNIP_EXPORT_BASELINE = 215;
export const KNIP_DUPLICATE_EXPORT_BASELINE = 39;
export const KNIP_TYPE_TELEMETRY_BASELINE = 397;

// --- Production leg (tested-only export detection) -------------------------
// `knip --production` excludes test files (and the vitest plugin's test
// entries) and only honours the `!`-suffixed entry/project globs in knip.json,
// so it sees the PRODUCTION import graph only: an export whose sole consumers
// are tests IS flagged here, while the default leg above counts the test
// import as usage (the `clearForSlug` class — see
// docs-private/postmortems/260611_calendar_cache_attention_every_launch_toast_postmortem.md
// and docs/project/DEAD_CODE_DETECTION_AND_REMOVAL.md).
//
// KNIP-PROD-ENFORCEMENT: flipped to `true` on 2026-06-12 (Stage 5 of
// docs/plans/260611_calendar-followups) after the Stage 4 WARN-mode push's CI
// (ubuntu, dev run 27381690518) reported production counts byte-identical to
// local macOS (453 exports / 35 files) — no OS drift, safe to enforce.
// Flipping this back to `false` returns the production leg to WARN mode
// (counts printed, never failing) — do that only with a documented reason.
export const KNIP_PROD_ENFORCEMENT_ENABLED = true;

// KNIP-PROD-RATCHET: CI-confirmed baselines (dev run 27381690518, ubuntu —
// identical to local macOS measurement on 2026-06-12). Same semantics as
// KNIP_EXPORT_BASELINE above: counts above fail, counts below warn you to
// lower the constant. The seam-name/test-path exemption filters below are
// applied BEFORE counting.
// 260614 (export 453→452): weekly ratchet sweep — a tested-only export was wired
// up or removed, dropping the count one below baseline (the check's own warn).
// 260618 (files 35→34): knip-health-beta fix — the OSS-mirror relocation's 6 standalone
// CLI checkers were modeled as knip entries and the shipped-ahead source-capture prefilter
// kernel (src/core/sourceCapture/**) was knip-ignored (both in knip.json), dropping the
// production unused-file floor from 43 (regressed) to 34. Export baseline holds at 452:
// the same fix tagged the 4 drifted tested-only exports `@internal` (RENDERER_*_BYTES,
// MODEL_ROLES, isSamplingParamsForbiddenCatalogModel) so the production leg ignores them.
// 260619 (export 452→451): knip-health-clear — `dev` had drifted +3 over baseline (4 new
// tested-only/shipped-ahead exports landed). Tagged the 3 genuine test seams `@internal`
// (hasActiveAsyncLockedWriter — narrow twin of the production hasPendingLocalSessionDrain;
// computeHealthWorkspaceWorstCaseMs — budget-math test assertion; isConcreteActivitySource —
// activity-source classification test). Tagged getEnabledProviders `@public` (genuinely-public
// multiprovider Stage-3 API shipped ahead of consumer — NOT a seam). Net 455→451, so the
// ratchet floor moves to the live count. Files stay 34: the rudderstack OSS alias-target
// stub that regressed it (+1) is now a reason-commented knip.json `ignore`.
export const KNIP_PROD_EXPORT_BASELINE = 451;
// 34 → 33 (260621 WS2a): deleted the production-orphan read-model
// src/core/rebelCore/resolvedModelCapabilities.ts (0 non-test callers) — it was a counted
// prod-unused file, so the floor ratchets down to the live count (improvement).
export const KNIP_PROD_UNUSED_FILE_BASELINE = 33;

// The seam-name / test-path exemption patterns and the production knip command
// live in scripts/lib/knip-diff-guard.ts so the ratchet (here) and the
// production diff-guard (there) apply IDENTICAL filters by construction.
// Escape hatches and removal process: docs/project/DEAD_CODE_DETECTION_AND_REMOVAL.md.

const KNIP_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
// Heap ceiling for the knip subprocess. This is a CEILING, not a reservation:
// knip's peak RSS (~3.8GB on this repo, dominated by building the whole-repo TS
// import graph) is set by the work, not this limit, so raising it does not raise
// RAM. It is kept generous specifically to protect LOW-RAM machines: node's
// default old-space (~25% of physical RAM) would OOM knip on an 8GB box, so we
// let old-space grow. The fast pre-push leg uses the SAME ceiling — a lower cap
// was measured NOT to reduce peak RAM (graph-dominated) and only risks OOM, so
// RAM-safety for the concurrent pre-push leg comes from the SLOT (it overlaps the
// light vitest phase, not the tsc-heavy validate:fast phase — see .husky/pre-push).
const KNIP_HEAP_OPTION = "--max-old-space-size=8192";

function buildKnipNodeOptions(rawNodeOptions: string | undefined): string {
  const nodeOptions = rawNodeOptions?.trim() ?? "";
  if (/\bmax-old-space-size\b/u.test(nodeOptions)) {
    return nodeOptions;
  }
  if (nodeOptions.length === 0) {
    return KNIP_HEAP_OPTION;
  }
  return `${nodeOptions} ${KNIP_HEAP_OPTION}`;
}

// Combined run: one Knip invocation for every category the default leg reports.
const KNIP_DEFAULT_CMD =
  "npx knip --include files,dependencies,exports,types,duplicates --no-progress --reporter json";
// KNIP_PRODUCTION_CMD is imported from lib/knip-diff-guard so the head run
// here and the base run inside the diff-guard are command-symmetric.

function runKnip(cmd: string): KnipReport {
  try {
    const output = execSync(cmd, {
      encoding: "utf-8",
      env: {
        ...process.env,
        NODE_OPTIONS: buildKnipNodeOptions(process.env.NODE_OPTIONS),
      },
      maxBuffer: KNIP_MAX_BUFFER_BYTES,
    });
    return JSON.parse(output) as KnipReport;
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    if (execErr.stdout) {
      try {
        return JSON.parse(execErr.stdout) as KnipReport;
      } catch {
        console.error("Knip produced non-JSON output:");
        console.error(execErr.stdout);
        if (execErr.stderr) console.error(execErr.stderr);
        process.exit(1);
      }
    }
    throw err;
  }
}

interface DepFinding {
  kind: "dependency" | "devDependency";
  name: string;
  file: string;
  line?: number;
}

function collectUnusedDeps(report: KnipReport): DepFinding[] {
  const unusedDeps: DepFinding[] = [];
  for (const issue of report.issues ?? []) {
    const file = issue.file ?? "(unknown)";
    for (const dep of issue.dependencies ?? []) {
      unusedDeps.push({
        kind: "dependency",
        name: dep.name,
        file,
        line: dep.line,
      });
    }
    for (const dep of issue.devDependencies ?? []) {
      unusedDeps.push({
        kind: "devDependency",
        name: dep.name,
        file,
        line: dep.line,
      });
    }
  }
  return unusedDeps;
}

function countKnipSymbols(report: KnipReport): {
  exports: number;
  duplicates: number;
  types: number;
  typesByFile: Array<{ file: string; count: number }>;
} {
  let exportCount = 0;
  let duplicateGroupCount = 0;
  let typeCount = 0;
  const typesByFile: Array<{ file: string; count: number }> = [];

  for (const issue of report.issues ?? []) {
    exportCount += issue.exports?.length ?? 0;
    duplicateGroupCount += issue.duplicates?.length ?? 0;

    const issueTypeCount = issue.types?.length ?? 0;
    typeCount += issueTypeCount;
    if (issueTypeCount > 0) {
      typesByFile.push({
        file: issue.file ?? "(unknown)",
        count: issueTypeCount,
      });
    }
  }

  typesByFile.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return a.file.localeCompare(b.file);
  });

  return {
    exports: exportCount,
    duplicates: duplicateGroupCount,
    types: typeCount,
    typesByFile,
  };
}

export function evaluateKnipReport(
  report: KnipReport,
  baselines: KnipBaselines = {
    exportBaseline: KNIP_EXPORT_BASELINE,
    duplicateBaseline: KNIP_DUPLICATE_EXPORT_BASELINE,
  },
): KnipHealthEvaluation {
  const lines: KnipHealthLine[] = [];
  let failed = false;

  // --- Pass 1: unused files (unchanged behavior) ---
  const unusedFiles = report.files ?? [];

  // --- Pass 2: unused dependencies + devDependencies (nested under issues[]) ---
  const unusedDeps = collectUnusedDeps(report);

  const symbolCounts = countKnipSymbols(report);

  if (unusedFiles.length > 0) {
    failed = true;
    lines.push({
      stream: "error",
      text: `✘ Found ${unusedFiles.length} unused file(s):`,
    });
    for (const file of unusedFiles) {
      lines.push({ stream: "error", text: `  ${file}` });
    }
  } else {
    lines.push({ stream: "log", text: "✔ No unused files detected" });
  }

  if (unusedDeps.length > 0) {
    failed = true;
    lines.push({
      stream: "error",
      text: `✘ Found ${unusedDeps.length} unused dependenc(y/ies):`,
    });
    for (const dep of unusedDeps) {
      const loc = dep.line != null ? `${dep.file}:${dep.line}` : dep.file;
      lines.push({
        stream: "error",
        text: `  ${dep.name} (${dep.kind}) — ${loc}`,
      });
    }
  } else {
    lines.push({ stream: "log", text: "✔ No unused dependencies detected" });
  }

  if (symbolCounts.exports > baselines.exportBaseline) {
    failed = true;
    lines.push({
      stream: "error",
      text: `✘ unused exports regressed: ${symbolCounts.exports} (baseline ${baselines.exportBaseline}, +${symbolCounts.exports - baselines.exportBaseline})`,
    });
  } else {
    lines.push({
      stream: "log",
      text: `✔ unused exports: ${symbolCounts.exports}/${baselines.exportBaseline} (within baseline)`,
    });
    if (symbolCounts.exports < baselines.exportBaseline) {
      lines.push({
        stream: "warn",
        text: `⚠ unused exports below baseline: lower KNIP_EXPORT_BASELINE to ${symbolCounts.exports} in scripts/check-knip-health.ts`,
      });
    }
  }

  if (symbolCounts.duplicates > baselines.duplicateBaseline) {
    failed = true;
    lines.push({
      stream: "error",
      text: `✘ duplicate export groups regressed: ${symbolCounts.duplicates} (baseline ${baselines.duplicateBaseline}, +${symbolCounts.duplicates - baselines.duplicateBaseline})`,
    });
  } else {
    lines.push({
      stream: "log",
      text: `✔ duplicate export groups: ${symbolCounts.duplicates}/${baselines.duplicateBaseline} (within baseline)`,
    });
    if (symbolCounts.duplicates < baselines.duplicateBaseline) {
      lines.push({
        stream: "warn",
        text: `⚠ duplicate export groups below baseline: lower KNIP_DUPLICATE_EXPORT_BASELINE to ${symbolCounts.duplicates} in scripts/check-knip-health.ts`,
      });
    }
  }

  lines.push({
    stream: "log",
    text: `unused types: ${symbolCounts.types} (baseline ${KNIP_TYPE_TELEMETRY_BASELINE}, report-only — not gated)`,
  });
  if (symbolCounts.typesByFile.length > 0) {
    lines.push({ stream: "log", text: "Top unused type files:" });
    for (const entry of symbolCounts.typesByFile.slice(0, 5)) {
      lines.push({ stream: "log", text: `  ${entry.file}: ${entry.count}` });
    }
  }

  return {
    failed,
    lines,
    counts: {
      files: unusedFiles.length,
      dependencies: unusedDeps.length,
      exports: symbolCounts.exports,
      duplicates: symbolCounts.duplicates,
      types: symbolCounts.types,
    },
  };
}

export interface KnipProductionBaselines {
  exportBaseline: number;
  fileBaseline: number;
}

export interface KnipProductionEvaluation {
  failed: boolean;
  lines: KnipHealthLine[];
  counts: {
    exports: number;
    seamExemptExports: number;
    files: number;
    testPathExemptFiles: number;
    duplicates: number;
  };
}

function evaluateProductionExceeded(params: {
  lines: KnipHealthLine[];
  enforce: boolean;
  label: string;
  baselineName: string;
  count: number;
  baseline: number;
}): boolean {
  const { lines, enforce, label, baselineName, count, baseline } = params;
  if (count > baseline) {
    lines.push({
      stream: enforce ? "error" : "warn",
      text: `${enforce ? "✘" : "⚠"} production ${label} regressed: ${count} (baseline ${baseline}, +${count - baseline})${enforce ? "" : " — WARN only; KNIP_PROD_ENFORCEMENT_ENABLED is off"}`,
    });
    lines.push({
      stream: enforce ? "error" : "warn",
      text: KNIP_PROD_ESCAPE_HATCH_TEXT,
    });
    return enforce;
  }
  lines.push({
    stream: "log",
    text: `✔ production ${label}: ${count}/${baseline} (within baseline)`,
  });
  if (count < baseline) {
    lines.push({
      stream: "warn",
      text: `⚠ production ${label} below baseline: lower ${baselineName} to ${count} in scripts/check-knip-health.ts`,
    });
  }
  return false;
}

export function evaluateProductionKnipReport(
  report: KnipReport,
  options: {
    baselines?: KnipProductionBaselines;
    enforce?: boolean;
  } = {},
): KnipProductionEvaluation {
  const baselines = options.baselines ?? {
    exportBaseline: KNIP_PROD_EXPORT_BASELINE,
    fileBaseline: KNIP_PROD_UNUSED_FILE_BASELINE,
  };
  const enforce = options.enforce ?? KNIP_PROD_ENFORCEMENT_ENABLED;
  const lines: KnipHealthLine[] = [];
  let failed = false;

  lines.push({
    stream: "log",
    text: enforce
      ? "Production leg (tested-only export detection, ENFORCING):"
      : "Production leg (tested-only export detection, WARN mode — KNIP_PROD_ENFORCEMENT_ENABLED is off, findings never fail the gate):",
  });

  // --- Exports: seam-name exemption applied BEFORE counting ---
  let seamExemptExports = 0;
  let exportCount = 0;
  let duplicateGroupCount = 0;
  const exportsByFile = new Map<string, number>();
  for (const issue of report.issues ?? []) {
    duplicateGroupCount += issue.duplicates?.length ?? 0;
    for (const exportFinding of issue.exports ?? []) {
      if (KNIP_PROD_SEAM_NAME_PATTERN.test(exportFinding.name)) {
        seamExemptExports += 1;
        continue;
      }
      exportCount += 1;
      const file = issue.file ?? "(unknown)";
      exportsByFile.set(file, (exportsByFile.get(file) ?? 0) + 1);
    }
  }

  // --- Files: test-path exemption applied BEFORE counting ---
  const allFiles = report.files ?? [];
  const unusedProductionFiles: string[] = [];
  let testPathExemptFiles = 0;
  for (const file of allFiles) {
    if (KNIP_PROD_TEST_PATH_PATTERN.test(file)) {
      testPathExemptFiles += 1;
    } else {
      unusedProductionFiles.push(file);
    }
  }

  // A production report with zero issues AND zero files is the signature of a
  // knip.json that lost its `!` glob suffixes (production mode then analyzes
  // nothing — empty-by-construction, NOT a clean tree). Warn loudly; the
  // diff-guard's base-config sentinel handles the base-side equivalent.
  if ((report.issues ?? []).length === 0 && allFiles.length === 0) {
    lines.push({
      stream: "warn",
      text: "⚠ production report is EMPTY — knip.json entry/project globs are likely missing their `!` production suffixes; this leg is analyzing nothing",
    });
  }

  if (
    evaluateProductionExceeded({
      lines,
      enforce,
      label: "unused exports",
      baselineName: "KNIP_PROD_EXPORT_BASELINE",
      count: exportCount,
      baseline: baselines.exportBaseline,
    })
  ) {
    failed = true;
  }

  if (
    evaluateProductionExceeded({
      lines,
      enforce,
      label: "unused files",
      baselineName: "KNIP_PROD_UNUSED_FILE_BASELINE",
      count: unusedProductionFiles.length,
      baseline: baselines.fileBaseline,
    })
  ) {
    failed = true;
  }

  lines.push({
    stream: "log",
    text: `production telemetry: ${seamExemptExports} seam-named export(s) exempt (KNIP_PROD_SEAM_NAME_PATTERN), ${testPathExemptFiles} test-path file(s) exempt (KNIP_PROD_TEST_PATH_PATTERN), ${duplicateGroupCount} duplicate export group(s) (report-only)`,
  });

  const topExportFiles = [...exportsByFile.entries()]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) =>
      b.count !== a.count ? b.count - a.count : a.file.localeCompare(b.file),
    )
    .slice(0, 5);
  if (topExportFiles.length > 0) {
    lines.push({ stream: "log", text: "Top production unused-export files:" });
    for (const entry of topExportFiles) {
      lines.push({ stream: "log", text: `  ${entry.file}: ${entry.count}` });
    }
  }

  if (unusedProductionFiles.length > 0) {
    const shown = unusedProductionFiles.slice(0, 10);
    lines.push({
      stream: "log",
      text: `Production-path unused files (${unusedProductionFiles.length} total${unusedProductionFiles.length > shown.length ? `, first ${shown.length}` : ""}):`,
    });
    for (const file of shown) {
      lines.push({ stream: "log", text: `  ${file}` });
    }
  }

  return {
    failed,
    lines,
    counts: {
      exports: exportCount,
      seamExemptExports,
      files: unusedProductionFiles.length,
      testPathExemptFiles,
      duplicates: duplicateGroupCount,
    },
  };
}

function writeLine(line: KnipHealthLine): void {
  console[line.stream](line.text);
}

export async function main(): Promise<void> {
  // Fast pre-push leg: run ONLY the two HEAD absolute-ratchet legs and skip the
  // diff-guard (whose base git-worktree spawn + two extra knip runs cost minutes
  // — that stays in CI dev-checks). Made explicit via a flag rather than relying
  // on BASE_SHA being unset, so a stray BASE_SHA in the push env can never
  // silently re-enable the expensive guard inside the pre-push hook. The HEAD
  // absolute ratchets are what catch the count regressions that recur on `dev`.
  const skipDiffGuard = process.argv.slice(2).includes("--no-diff-guard");

  console.log(
    skipDiffGuard
      ? "Checking unused files/deps with Knip (fast pre-push leg — absolute ratchets only, diff-guard skipped)..."
      : "Checking for unused files and dependencies with Knip...",
  );
  const report = runKnip(KNIP_DEFAULT_CMD);
  const result = evaluateKnipReport(report);
  for (const line of result.lines) {
    writeLine(line);
  }

  // Production leg (260612): `--production` sees the production import graph
  // only, catching exports/files whose sole consumers are tests (the
  // clearForSlug class). ENFORCING since Stage 5 (baselines CI-confirmed).
  // Measured cheaper than the default run (~6s / 1.8GB peak), fits the same
  // heap plumbing.
  console.log("Running Knip production leg (tested-only export detection)...");
  const productionReport = runKnip(KNIP_PRODUCTION_CMD);
  const productionResult = evaluateProductionKnipReport(productionReport);
  for (const line of productionResult.lines) {
    writeLine(line);
  }

  // Diff-scoped guard: when a base SHA is available (CI / --base), fail on
  // NEW findings in changed files — default-mode unused exports/duplicates
  // AND production-mode unused exports/files (the leg that catches the next
  // clearForSlug even when counts stay under baseline) — deriving the legacy
  // floor from the base commit. Skips when no base is resolvable; base-prep
  // infra failures degrade to a loud non-fatal skip (see
  // scripts/lib/knip-diff-guard.ts). Reuses both already-parsed HEAD reports —
  // no extra HEAD knip runs. Skipped entirely in the fast pre-push leg.
  let guardFailed = false;
  if (!skipDiffGuard) {
    const guardResult = await runKnipDiffGuard({
      headReport: report,
      headProductionReport: productionReport,
    });
    guardFailed = guardResult.failed;
  }

  if (result.failed || guardFailed || productionResult.failed) {
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error("Unexpected error in check-knip-health:", error);
    process.exit(1);
  });
}
