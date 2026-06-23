import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDefaultGitRunner,
  createProcessEnvReader,
  parseBaseArg,
  resolveBaseSha,
  type ChangedFileRecord,
  type EnvReader,
  type GitRunner,
} from "../check-eslint-new-warnings";
import type { KnipReport, KnipSymbolFinding } from "../check-knip-health";

const KNIP_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const KNIP_HEAP_OPTION = "--max-old-space-size=8192";

// Production leg: types stay OUT entirely (their delta over the default leg's
// already-untuned telemetry is noise); duplicates ride along as telemetry only.
// Shared between the HEAD run (check-knip-health.ts) and the base run below so
// the diff comparison is command-symmetric by construction.
export const KNIP_PRODUCTION_CMD =
  "npx knip --production --include exports,duplicates,files --no-progress --reporter json";

// Exports that declare themselves test-only by NAME are exempt from the
// production leg: they are intentional test seams, not dead production API
// (`*ForTesting`/`*ForTests`/`*ForTest` suffixes; `_reset*`/`__reset*`,
// `_testing*`/`_testOnly`/`__test*` prefixes). The long-term idiom is a
// `/** @internal */` JSDoc tag (knip ignores it in production mode only,
// while the default leg keeps tracking it); the name filter avoids a
// ~160-export tagging sweep upfront — migrate gradually. Note this exempts
// self-declared seams while still flagging innocently-named production API,
// which is exactly the clearForSlug shape.
export const KNIP_PROD_SEAM_NAME_PATTERN =
  /(?:ForTesting|ForTests|ForTest)$|^_{1,2}(?:reset|test)/u;

// Production mode reports test-harness/fixture FILES as unused by
// construction (their consumers are excluded from the analysis); exempt them
// by path segment. What remains is production-path files with zero production
// consumers — the clearForSlug class at file granularity.
export const KNIP_PROD_TEST_PATH_PATTERN =
  /(?:^|\/)(?:__tests__|__mocks__|test-utils|__test_helpers__|__fixtures__|fixtures|[^/]*_harness)(?:\/|$)/u;

export const KNIP_PROD_ESCAPE_HATCH_TEXT =
  "  Escape hatches: tag intentional test seams `/** @internal */` (knip ignores them in production mode only; the default leg keeps tracking them), tag genuinely-public API consumed outside the project glob `/** @public */` (always ignored), or add a reason-commented path to knip.json `ignore`. See docs/project/DEAD_CODE_DETECTION_AND_REMOVAL.md#production-leg-escape-hatches-deliberately-not-production-consumed-exports";

export type KnipDiffFindingKind =
  | "export"
  | "duplicate"
  | "prod-export"
  | "prod-file";

export interface KnipDiffFinding {
  kind: KnipDiffFindingKind;
  file: string;
  name: string;
  line?: number;
  col?: number;
}

export interface ComputeNewFindingsInput {
  headFindings: KnipDiffFinding[];
  baseFindings: KnipDiffFinding[];
  changedFiles: ChangedFileRecord[];
}

export interface BaseKnipReports {
  defaultReport: KnipReport;
  productionReport: KnipReport;
}

export interface BaseKnipRunner {
  run(baseSha: string): Promise<BaseKnipReports>;
}

export interface KnipDiffGuardResult {
  failed: boolean;
  status: "ok" | "new-findings" | "skipped" | "error";
  newFindings: KnipDiffFinding[];
  skippedReason?: string;
  /** Set when ONLY the production diff leg was skipped (base-config sentinel). */
  productionSkippedReason?: string;
  errorMessage?: string;
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function semanticKey(finding: KnipDiffFinding): string {
  return `${finding.kind}\u0000${normalizePath(finding.file)}\u0000${finding.name}`;
}

function sortFindings(findings: KnipDiffFinding[]): KnipDiffFinding[] {
  return [...findings].sort((a, b) => {
    const fileCompare = normalizePath(a.file).localeCompare(
      normalizePath(b.file),
    );
    if (fileCompare !== 0) {
      return fileCompare;
    }
    const nameCompare = a.name.localeCompare(b.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }
    return a.kind.localeCompare(b.kind);
  });
}

export function computeNewFindings(
  input: ComputeNewFindingsInput,
): KnipDiffFinding[] {
  const renameMap = new Map<string, string>();
  const changedHeadPaths = new Set<string>();

  for (const changedFile of input.changedFiles) {
    const headPath = normalizePath(changedFile.path);
    changedHeadPaths.add(headPath);
    if (changedFile.basePath !== null) {
      const basePath = normalizePath(changedFile.basePath);
      if (basePath !== headPath) {
        renameMap.set(basePath, headPath);
      }
    }
  }

  const baseCounts = new Map<string, number>();
  for (const finding of input.baseFindings) {
    const normalizedFile = normalizePath(finding.file);
    const remappedFinding = {
      ...finding,
      file: renameMap.get(normalizedFile) ?? normalizedFile,
    };
    const key = semanticKey(remappedFinding);
    baseCounts.set(key, (baseCounts.get(key) ?? 0) + 1);
  }

  const newFindings: KnipDiffFinding[] = [];
  for (const finding of input.headFindings) {
    const normalizedFile = normalizePath(finding.file);
    if (!changedHeadPaths.has(normalizedFile)) {
      continue;
    }

    const normalizedFinding = { ...finding, file: normalizedFile };
    const key = semanticKey(normalizedFinding);
    const remainingBaseCount = baseCounts.get(key) ?? 0;
    if (remainingBaseCount > 0) {
      baseCounts.set(key, remainingBaseCount - 1);
    } else {
      newFindings.push(normalizedFinding);
    }
  }

  return sortFindings(newFindings);
}

function sortedDuplicateGroupName(group: KnipSymbolFinding[]): string {
  return group
    .map((finding) => finding.name)
    .sort()
    .join("|");
}

export function collectExportAndDuplicateFindings(
  report: KnipReport,
): KnipDiffFinding[] {
  const findings: KnipDiffFinding[] = [];

  for (const issue of report.issues ?? []) {
    const file = normalizePath(issue.file ?? "(unknown)");
    for (const exportFinding of issue.exports ?? []) {
      findings.push({
        kind: "export",
        file,
        name: exportFinding.name,
        line: exportFinding.line,
        col: exportFinding.col,
      });
    }
    for (const duplicateGroup of issue.duplicates ?? []) {
      const firstMember = duplicateGroup[0];
      findings.push({
        kind: "duplicate",
        file,
        name: sortedDuplicateGroupName(duplicateGroup),
        line: firstMember?.line,
        col: firstMember?.col,
      });
    }
  }

  return findings;
}

/**
 * Production-mode findings for the diff comparison: unused exports (seam-name
 * exemption applied) + production-path unused files (test-path exemption
 * applied). The SAME filters run on head and base reports, so an exemption
 * can never manufacture a "new" finding asymmetrically. Duplicates are
 * deliberately excluded — they are telemetry-only in the production leg.
 */
export function collectProductionFindings(
  report: KnipReport,
): KnipDiffFinding[] {
  const findings: KnipDiffFinding[] = [];

  for (const issue of report.issues ?? []) {
    const file = normalizePath(issue.file ?? "(unknown)");
    for (const exportFinding of issue.exports ?? []) {
      if (KNIP_PROD_SEAM_NAME_PATTERN.test(exportFinding.name)) {
        continue;
      }
      findings.push({
        kind: "prod-export",
        file,
        name: exportFinding.name,
        line: exportFinding.line,
        col: exportFinding.col,
      });
    }
  }

  for (const file of report.files ?? []) {
    const normalizedFile = normalizePath(file);
    if (KNIP_PROD_TEST_PATH_PATTERN.test(normalizedFile)) {
      continue;
    }
    findings.push({
      kind: "prod-file",
      file: normalizedFile,
      name: "(unused production file)",
    });
  }

  return findings;
}

/**
 * A production report with zero issues AND zero files is the signature of a
 * knip.json whose entry/project globs lost their `!` production suffixes
 * (production mode then analyzes nothing — empty-by-construction, NOT a clean
 * tree). On the BASE side this is expected exactly once: the first CI run
 * whose merge-base predates the bang-suffixed config.
 */
function isEmptyByConstruction(report: KnipReport): boolean {
  return (
    (report.issues ?? []).length === 0 && (report.files ?? []).length === 0
  );
}

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

function parseKnipJson(output: string, context: string): KnipReport {
  try {
    return JSON.parse(output) as KnipReport;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`${context}: Knip emitted non-JSON output: ${details}`);
  }
}

function runKnipCommand(cmd: string, cwd: string): KnipReport {
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      env: {
        ...process.env,
        NODE_OPTIONS: buildKnipNodeOptions(process.env.NODE_OPTIONS),
      },
      maxBuffer: KNIP_MAX_BUFFER_BYTES,
    });
    return parseKnipJson(output, `Knip base run in ${cwd}`);
  } catch (error: unknown) {
    const execError = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (execError.stdout) {
      return parseKnipJson(execError.stdout, `Knip base run in ${cwd}`);
    }
    const stderr = execError.stderr?.trim();
    const message = execError.message ?? String(error);
    throw new Error(
      `Knip base run in ${cwd} failed${stderr && stderr.length > 0 ? `: ${stderr}` : `: ${message}`}`,
    );
  }
}

export function createDefaultBaseKnipRunner(
  options: {
    repoRoot?: string;
  } = {},
): BaseKnipRunner {
  const repoRoot = options.repoRoot ?? process.cwd();

  return {
    async run(baseSha: string): Promise<BaseKnipReports> {
      const tempRoot = mkdtempSync(path.join(tmpdir(), "rebel-knip-base-"));
      let worktreeAdded = false;

      try {
        // git-exec-allow: git worktree add is a bounded side-effect mutation, output unused
        execFileSync(
          "git",
          ["worktree", "add", "--detach", tempRoot, baseSha],
          {
            cwd: repoRoot,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        worktreeAdded = true;

        const sourceNodeModules = path.join(repoRoot, "node_modules");
        const targetNodeModules = path.join(tempRoot, "node_modules");
        if (!existsSync(sourceNodeModules)) {
          throw new Error(`node_modules not found at ${sourceNodeModules}`);
        }
        symlinkSync(
          sourceNodeModules,
          targetNodeModules,
          process.platform === "win32" ? "junction" : "dir",
        );

        // ONE worktree, BOTH modes (add-once, run-twice, remove-once): the
        // default-leg exports/duplicates run plus the production-leg run the
        // production diff comparison needs.
        return {
          defaultReport: runKnipCommand(
            "npx knip --include exports,duplicates --no-progress --reporter json",
            tempRoot,
          ),
          productionReport: runKnipCommand(KNIP_PRODUCTION_CMD, tempRoot),
        };
      } finally {
        if (worktreeAdded) {
          try {
            // git-exec-allow: git worktree remove is a bounded side-effect mutation, output unused
            execFileSync("git", ["worktree", "remove", "--force", tempRoot], {
              cwd: repoRoot,
              encoding: "utf-8",
              stdio: ["ignore", "pipe", "pipe"],
            });
          } catch (error) {
            rmSync(tempRoot, { recursive: true, force: true });
            const details =
              error instanceof Error ? error.message : String(error);
            throw new Error(
              `Failed to remove temporary knip base worktree ${tempRoot}: ${details}`,
            );
          }
        } else {
          rmSync(tempRoot, { recursive: true, force: true });
        }
      }
    },
  };
}

function toAnnotationSafe(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function findingLabel(finding: KnipDiffFinding): string {
  switch (finding.kind) {
    case "export":
      return `unused export ${finding.name}`;
    case "duplicate":
      return `duplicate export group ${finding.name}`;
    case "prod-export":
      return `production unused export ${finding.name} (no production consumers — tested-only?)`;
    case "prod-file":
      return "production-path unused file (no production consumers)";
  }
}

function createSkipLogLine(reason: string): string {
  return JSON.stringify({
    event: "knip-diff-guard",
    status: "skipped",
    reason,
  });
}

function createSummaryLogLine(params: {
  status: "ok" | "new-findings";
  baseSha: string;
  changedFiles: number;
  newFindings: number;
}): string {
  return JSON.stringify({
    event: "knip-diff-guard",
    status: params.status,
    baseSha: params.baseSha,
    changedFiles: params.changedFiles,
    newFindings: params.newFindings,
  });
}

export async function runKnipDiffGuard(deps: {
  headReport: KnipReport;
  /**
   * The HEAD `knip --production` report (KNIP_PRODUCTION_CMD). Required so the
   * production diff leg cannot be silently un-wired — check-knip-health.ts
   * already has this report parsed (no extra knip run).
   */
  headProductionReport: KnipReport;
  env?: EnvReader;
  git?: GitRunner;
  baseKnipRunner?: BaseKnipRunner;
  logger?: Pick<Console, "log" | "warn" | "error">;
  args?: string[];
}): Promise<KnipDiffGuardResult> {
  const env = deps.env ?? createProcessEnvReader();
  const git = deps.git ?? createDefaultGitRunner();
  const baseKnipRunner = deps.baseKnipRunner ?? createDefaultBaseKnipRunner();
  const logger = deps.logger ?? console;
  const args = deps.args ?? process.argv.slice(2);

  const baseShaResult = await resolveBaseSha(env, git, {
    baseRef: parseBaseArg(args),
    logger,
  });
  if (baseShaResult.kind === "skip") {
    const reason = baseShaResult.reason ?? "Unknown reason";
    logger.log(createSkipLogLine(reason));
    return {
      failed: false,
      status: "skipped",
      newFindings: [],
      skippedReason: reason,
    };
  }

  const baseSha = baseShaResult.sha ?? "";

  // Only the INFRA ops (git diff + base-knip-at-base, incl. its worktree/symlink
  // prep) degrade to a loud non-fatal skip. Rationale: this gate is being
  // introduced into shared multi-agent CI, and a flaky base-prep step that
  // hard-fails would block the whole team's PRs; the Stage 1a count ratchet
  // (always-on, no base needed) remains the floor. Deliberate operational
  // deviation from the arbitrated "fail-closed on base-prep" — see PLAN.md
  // Decision Log. The comparator + reporting below are deliberately OUTSIDE this
  // catch: a bug there must fail hard, not hide as an infra skip.
  let changedFiles: ChangedFileRecord[];
  let baseReports: BaseKnipReports;
  try {
    changedFiles = await git.changedFiles(baseSha, "HEAD");
    baseReports = await baseKnipRunner.run(baseSha);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      JSON.stringify({
        event: "knip-diff-guard",
        status: "skipped",
        baseSha,
        reason: `base-prep-failed: ${message}`,
      }),
    );
    if (env.get("GITHUB_ACTIONS") === "true") {
      logger.warn(
        `::warning::knip-diff-guard skipped — could not establish base ${baseSha}: ${toAnnotationSafe(message)}`,
      );
    }
    return {
      failed: false,
      status: "skipped",
      newFindings: [],
      skippedReason: `base-prep-failed: ${message}`,
      errorMessage: message,
    };
  }

  // Base-config sentinel (production leg only): an empty-by-construction base
  // production report means the base commit's knip.json lacks the `!` glob
  // suffixes — diffing against it would mark EVERY head production finding in
  // changed files as "new". Degrade that one leg to a loud non-fatal skip
  // (one-merge transition window); the default-mode diff comparison still runs.
  let productionSkippedReason: string | undefined;
  let headProductionFindings: KnipDiffFinding[] = [];
  let baseProductionFindings: KnipDiffFinding[] = [];
  if (isEmptyByConstruction(baseReports.productionReport)) {
    productionSkippedReason =
      "base production report is empty-by-construction (base knip.json entry/project globs lack `!` production suffixes)";
    logger.warn(
      JSON.stringify({
        event: "knip-diff-guard",
        status: "production-leg-skipped",
        baseSha,
        reason: productionSkippedReason,
      }),
    );
    if (env.get("GITHUB_ACTIONS") === "true") {
      logger.warn(
        `::warning::knip-diff-guard production leg skipped — ${toAnnotationSafe(productionSkippedReason)}`,
      );
    }
  } else {
    headProductionFindings = collectProductionFindings(
      deps.headProductionReport,
    );
    baseProductionFindings = collectProductionFindings(
      baseReports.productionReport,
    );
  }

  // Default-mode and production-mode findings never cross-cancel: the kind is
  // part of the semantic key, so a base default-leg finding cannot absorb a
  // new production-leg finding for the same symbol (and vice versa).
  const newFindings = computeNewFindings({
    headFindings: [
      ...collectExportAndDuplicateFindings(deps.headReport),
      ...headProductionFindings,
    ],
    baseFindings: [
      ...collectExportAndDuplicateFindings(baseReports.defaultReport),
      ...baseProductionFindings,
    ],
    changedFiles,
  });

  if (newFindings.length === 0) {
    logger.log(
      createSummaryLogLine({
        status: "ok",
        baseSha,
        changedFiles: changedFiles.length,
        newFindings: 0,
      }),
    );
    return {
      failed: false,
      status: "ok",
      newFindings: [],
      ...(productionSkippedReason !== undefined && { productionSkippedReason }),
    };
  }

  if (env.get("GITHUB_ACTIONS") === "true") {
    for (const finding of newFindings) {
      const line = finding.line && finding.line > 0 ? finding.line : 1;
      const column = finding.col && finding.col > 0 ? finding.col : 1;
      logger.warn(
        `::warning file=${toAnnotationSafe(finding.file)},line=${line},col=${column}::${toAnnotationSafe(`Knip new finding: ${findingLabel(finding)}`)}`,
      );
    }
  }

  logger.error(
    createSummaryLogLine({
      status: "new-findings",
      baseSha,
      changedFiles: changedFiles.length,
      newFindings: newFindings.length,
    }),
  );
  logger.error("New Knip findings in changed files:");
  for (const finding of newFindings) {
    logger.error(`  ${finding.file}: ${findingLabel(finding)}`);
  }
  if (
    newFindings.some(
      (finding) =>
        finding.kind === "prod-export" || finding.kind === "prod-file",
    )
  ) {
    logger.error(
      "Production-leg findings above have no production consumers (test-only usage does not count).",
    );
    logger.error(KNIP_PROD_ESCAPE_HATCH_TEXT);
  }

  return {
    failed: true,
    status: "new-findings",
    newFindings,
    ...(productionSkippedReason !== undefined && { productionSkippedReason }),
  };
}
