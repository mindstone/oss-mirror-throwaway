#!/usr/bin/env tsx
/**
 * Diff-scoped "no new warnings" CI gate.
 *
 * Compares ESLint warnings per changed file between current HEAD and the
 * pull-request base SHA. Fails when HEAD introduces any warning signature not
 * present in the baseline.
 *
 * Warning signatures are matched by (ruleId, message), intentionally excluding
 * both line and column. This avoids false positives when merges/rebases shift
 * warning line numbers without introducing new warning semantics.
 *
 * BASE_SHA resolution (D3 — docs/plans/260612_silent-swallow-gate/PLAN.md):
 * - --base=<ref> arg -> resolve via `git rev-parse <ref>` and use it.
 * - BASE_SHA env set to a real SHA -> use it directly.
 * - BASE_SHA all-zeros -> fallback to `git merge-base origin/dev HEAD`.
 * - BASE_SHA empty/unset -> fallback chain: `git merge-base @{upstream} HEAD`,
 *   then `git merge-base origin/dev HEAD`. This closes the pre-push local case
 *   (CI sets BASE_SHA; a local `validate:fast` run usually does not), so a new
 *   swallow fails BEFORE landing on dev rather than only after.
 * - none of the above resolve -> LOUD skip (stderr), exit 0 (non-fatal).
 *
 * Enforcement contract (D3): a resolved base + a genuinely NEW warning in a
 * changed file FAILS (exit 1, blocking). Only base-prep / infrastructure
 * failures (git/ESLint command errors, unresolvable base) degrade to a LOUD
 * non-fatal skip — mirroring scripts/lib/knip-diff-guard.ts so flaky git/ESLint
 * cannot block the whole team's pushes. The `npm run lint --max-warnings` total
 * cap is the always-on backstop for the skip window.
 *
 * Designed to be unit-testable via dependency injection.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ESLINT_AUDIT_ARGS,
  createDefaultEslintRunner,
  parseEslintJson,
  type EslintAuditResult,
  type EslintRunner,
} from "./lib/eslint-warning-audit";

const ALL_ZERO_SHA = "0000000000000000000000000000000000000000";
const ESLINT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const ESLINT_LINT_ROOTS = [
  "src/",
  "private/mindstone/src/",
  "cloud-service/src/",
  "cloud-client/src/",
  "mobile/src/",
  "mobile/app/",
  "evals/",
];

/**
 * Merge-base refs the ESLint gate opts into for the BASE_SHA-unset case (D3),
 * so a local/pre-push run derives a base (`@{upstream}` then `origin/dev`)
 * instead of skipping. This is OPT-IN per call: the shared `resolveBaseSha`
 * defaults to skip-when-unset, and `knip-diff-guard.ts` must keep that default
 * (it must not start resolving bases locally). See PLAN.md Decision Log.
 */
const ESLINT_GATE_MERGE_BASE_FALLBACK_REFS: readonly string[] = [
  "@{upstream}",
  "origin/dev",
];

export interface EnvReader {
  get(name: string): string | undefined;
}

export interface GitRunner {
  revParse(ref: string): Promise<string>;
  mergeBase(refA: string, refB: string): Promise<string>;
  changedFiles(base: string, head: string): Promise<ChangedFileRecord[]>;
  fileAtRev(rev: string, path: string): Promise<string | null>;
}

export interface BaseShaResult {
  kind: "usable" | "skip";
  sha?: string;
  reason?: string;
}

export interface RegressionRecord {
  filePath: string;
  baselineCount: number;
  currentCount: number;
  newWarnings: Array<{
    ruleId: string | null;
    line: number;
    column: number;
    message: string;
  }>;
}

export interface ChangedFileRecord {
  status: "A" | "M" | "R";
  path: string;
  basePath: string | null;
}

export interface DiffScopedCheckResult {
  failed: boolean;
  status: "ok" | "regressions" | "skipped";
  regressions: RegressionRecord[];
  skippedReason?: string;
}

function normalizeGitPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function isEslintRelevantFile(filePath: string): boolean {
  const normalizedPath = normalizeGitPath(filePath);
  const extension = normalizedPath.includes(".")
    ? normalizedPath.slice(normalizedPath.lastIndexOf("."))
    : "";

  if (!ESLINT_EXTENSIONS.has(extension)) {
    return false;
  }

  return ESLINT_LINT_ROOTS.some((prefix) => normalizedPath.startsWith(prefix));
}

function chunkToString(chunk: Buffer | string): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

function ensureUsableSha(sha: string, messagePrefix: string): string {
  const trimmed = sha.trim();
  if (trimmed.length === 0) {
    throw new Error(`${messagePrefix}: empty SHA`);
  }
  return trimmed;
}

export function parseBaseArg(args: string[]): string | undefined {
  const baseArg = args.find((arg) => arg.startsWith("--base="));
  const unsupportedArg = args.find((arg) => !arg.startsWith("--base="));
  if (unsupportedArg) {
    throw new Error(`Unsupported argument: ${unsupportedArg}`);
  }
  if (!baseArg) {
    return undefined;
  }

  const rawBase = baseArg.slice("--base=".length).trim();
  if (rawBase.length === 0) {
    throw new Error("Invalid --base value: expected non-empty git ref");
  }
  return rawBase;
}

function parseAuditFromResult(params: {
  stdout: string;
  stderr: string;
  exitCode: number;
  context: string;
}): EslintAuditResult {
  const { stdout, stderr, exitCode, context } = params;

  try {
    return parseEslintJson(stdout);
  } catch (error) {
    if (exitCode !== 0) {
      const stderrPreview = stderr.trim().slice(0, 500);
      throw new Error(
        `${context}: ESLint exited with code ${exitCode} and emitted invalid JSON${stderrPreview.length > 0 ? `: ${stderrPreview}` : ""}`,
      );
    }
    throw error;
  }
}

async function lintContentAtPath(params: {
  eslint: EslintRunner;
  content: string;
  filePath: string;
}): Promise<EslintAuditResult> {
  const { eslint, content, filePath } = params;
  if (!eslint.runOnStdin) {
    throw new Error(
      "EslintRunner.runOnStdin is required for diff-scoped check",
    );
  }

  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await eslint.runOnStdin({
      content,
      filename: filePath,
      extraArgs: [...ESLINT_AUDIT_ARGS],
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed ESLint stdin audit for ${filePath}: ${details}`);
  }

  const maybeExitCode = (result as { exitCode: unknown }).exitCode;
  if (typeof maybeExitCode !== "number" || !Number.isFinite(maybeExitCode)) {
    throw new Error(
      `Failed ESLint stdin audit for ${filePath}: invalid exit code ${String(maybeExitCode)}`,
    );
  }

  return parseAuditFromResult({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: maybeExitCode,
    context: `Failed ESLint stdin audit for ${filePath}`,
  });
}

function toAnnotationSafe(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function createSkipLogLine(reason: string): string {
  return JSON.stringify({
    event: "eslint-new-warnings",
    status: "skipped",
    reason,
  });
}

/**
 * Emit a LOUD non-fatal skip (D3): the structured JSON line PLUS a clearly
 * visible human-readable banner on stderr, and (in CI) a `::warning::`
 * annotation. The old buried `logger.log(JSON)` was invisible in long
 * validate:fast output — this makes a skipped enforcement run stand out so it
 * can never masquerade as a passing one. Still exits 0; the `npm run lint`
 * total-warnings cap is the always-on backstop for the skip window.
 */
function emitLoudSkip(
  logger: Pick<Console, "log" | "warn" | "error">,
  env: EnvReader,
  reason: string,
): void {
  logger.log(createSkipLogLine(reason));
  logger.warn(
    `[eslint-new-warnings] SKIPPED (no enforcement this run): ${reason}. ` +
      `The diff-scoped new-warning gate did not run; the lint --max-warnings cap is the backstop.`,
  );
  if (env.get("GITHUB_ACTIONS") === "true") {
    logger.warn(
      `::warning::eslint-new-warnings skipped — ${toAnnotationSafe(reason)}`,
    );
  }
}

function createSummaryLogLine(params: {
  status: "ok" | "regressions";
  baseSha: string;
  checkedFiles: number;
  regressions: number;
}): string {
  return JSON.stringify({
    event: "eslint-new-warnings",
    status: params.status,
    baseSha: params.baseSha,
    checkedFiles: params.checkedFiles,
    regressions: params.regressions,
  });
}

function warningSignature(warning: {
  ruleId: string | null;
  message: string;
}): string {
  return `${warning.ruleId ?? "<null>"}\u0000${warning.message}`;
}

function findNewWarnings(params: {
  currentWarnings: EslintAuditResult["warnings"];
  baselineWarnings: EslintAuditResult["warnings"];
}): RegressionRecord["newWarnings"] {
  // Multiset semantics: each baseline occurrence absorbs at most one current
  // occurrence with the same signature. This prevents under-reporting when
  // HEAD has more occurrences of a signature than BASE.
  const baselineCounts = new Map<string, number>();
  for (const warning of params.baselineWarnings) {
    const signature = warningSignature(warning);
    baselineCounts.set(signature, (baselineCounts.get(signature) ?? 0) + 1);
  }

  const newWarnings: EslintAuditResult["warnings"] = [];
  for (const warning of params.currentWarnings) {
    const signature = warningSignature(warning);
    const remaining = baselineCounts.get(signature) ?? 0;
    if (remaining > 0) {
      baselineCounts.set(signature, remaining - 1);
    } else {
      newWarnings.push(warning);
    }
  }

  return newWarnings
    .sort((a, b) => {
      if (a.line !== b.line) {
        return a.line - b.line;
      }
      if (a.column !== b.column) {
        return a.column - b.column;
      }
      if ((a.ruleId ?? "") !== (b.ruleId ?? "")) {
        return (a.ruleId ?? "").localeCompare(b.ruleId ?? "");
      }
      return a.message.localeCompare(b.message);
    })
    .map((warning) => ({
      ruleId: warning.ruleId,
      line: warning.line,
      column: warning.column,
      message: warning.message,
    }));
}

export async function resolveBaseSha(
  env: EnvReader,
  git: GitRunner,
  options: {
    baseRef?: string;
    logger?: Pick<Console, "log" | "warn" | "error">;
    /**
     * OPT-IN merge-base fallback for the BASE_SHA-unset case (D3). When empty
     * or omitted (the DEFAULT), behavior is exactly the original: an unset
     * BASE_SHA returns `{ kind: "skip", reason: "BASE_SHA env not set" }`.
     *
     * This is a SHARED function — `scripts/lib/knip-diff-guard.ts` also calls
     * it and MUST keep its CI-only skip-when-unset contract (knip must not
     * start resolving bases locally). Only the ESLint gate's own call site
     * opts in (passing `["@{upstream}", "origin/dev"]`) so its local/pre-push
     * tight enforcement works. Do NOT make this fallback the default — it
     * would re-leak into knip-diff-guard. See PLAN.md Decision Log.
     */
    mergeBaseFallbackRefs?: readonly string[];
  } = {},
): Promise<BaseShaResult> {
  const baseRef = options.baseRef?.trim();
  const logger = options.logger;
  const mergeBaseFallbackRefs = options.mergeBaseFallbackRefs ?? [];
  const rawBaseSha = env.get("BASE_SHA")?.trim() ?? "";

  if (baseRef && baseRef.length > 0) {
    if (rawBaseSha.length > 0) {
      logger?.log(
        `[eslint-new-warnings] --base=${baseRef} provided; overriding BASE_SHA env value.`,
      );
    }
    const resolvedSha = await git.revParse(baseRef);
    return {
      kind: "usable",
      sha: ensureUsableSha(
        resolvedSha,
        `Failed to resolve --base reference via git rev-parse ${baseRef}`,
      ),
    };
  }

  if (rawBaseSha.length === 0) {
    // DEFAULT (no opt-in): preserve the original skip-when-unset contract that
    // every non-opted-in caller (esp. knip-diff-guard) relies on.
    if (mergeBaseFallbackRefs.length === 0) {
      return {
        kind: "skip",
        reason: "BASE_SHA env not set",
      };
    }

    // OPT-IN (D3): walk the caller-supplied fallback refs (`@{upstream}` then
    // `origin/dev` for the ESLint gate). Each rung can legitimately fail (no
    // upstream configured, no origin/dev ref); a failed rung falls through to
    // the next, and exhausting the chain produces a LOUD skip (the caller
    // surfaces it on stderr).
    const failures: string[] = [];
    for (const ref of mergeBaseFallbackRefs) {
      const label = `git merge-base ${ref} HEAD`;
      try {
        const mergeBaseSha = ensureUsableSha(
          await git.mergeBase(ref, "HEAD"),
          `Failed to resolve base via ${label}`,
        );
        return { kind: "usable", sha: mergeBaseSha };
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        failures.push(`${label}: ${details}`);
      }
    }
    return {
      kind: "skip",
      reason: `BASE_SHA env not set and no fallback base resolved (${failures.join("; ")})`,
    };
  }

  if (rawBaseSha === ALL_ZERO_SHA) {
    const mergeBaseSha = await git.mergeBase("origin/dev", "HEAD");
    return {
      kind: "usable",
      sha: ensureUsableSha(
        mergeBaseSha,
        "Failed to resolve BASE_SHA fallback via git merge-base origin/dev HEAD",
      ),
    };
  }

  return {
    kind: "usable",
    sha: rawBaseSha,
  };
}

/**
 * Tags a thrown error as a base-prep / infrastructure failure (git or ESLint
 * I/O) so the per-file catch can degrade it to a LOUD non-fatal skip (D3).
 * Anything NOT wrapped in this class — notably a comparator/detection bug in
 * findNewWarnings() — propagates uncaught and FAILS CLOSED (exit 1). This is
 * the GPT-F1 fix: only KNOWN infra failures may skip; an unexpected throw must
 * never be normalized into success.
 */
class InfraError extends Error {
  constructor(
    public readonly stage: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "InfraError";
  }
}

export async function runDiffScopedCheck(deps: {
  env: EnvReader;
  git: GitRunner;
  eslint: EslintRunner;
  logger: Pick<Console, "log" | "warn" | "error">;
  args?: string[];
  /**
   * Comparator override — DI seam for tests to assert a detection/comparator
   * throw FAILS CLOSED (not skip). Defaults to the real findNewWarnings.
   */
  detectNewWarnings?: typeof findNewWarnings;
}): Promise<DiffScopedCheckResult> {
  const { env, git, eslint, logger, args = [] } = deps;
  const detectNewWarnings = deps.detectNewWarnings ?? findNewWarnings;

  // Parse CLI args BEFORE the skip-ifying try (GPT-F2): a malformed invocation
  // (`--bad-arg`, a miswired CI/package script) is a USAGE/config error, NOT a
  // D3 infra failure. It must fail HARD (propagate → exit 1), never normalize
  // into a loud skip that silently disables enforcement.
  const baseRef = parseBaseArg(args);

  // Base RESOLUTION (incl. its merge-base infra calls) can fail on flaky git.
  // Treat both an explicit "skip" result AND a thrown base-prep error as a LOUD
  // non-fatal skip (D3) — never a hard exit 1, and never a silent pass.
  let baseShaResult: BaseShaResult;
  try {
    baseShaResult = await resolveBaseSha(env, git, {
      baseRef,
      logger,
      // OPT-IN to the BASE_SHA-unset merge-base fallback (D3) — ESLint gate
      // ONLY. knip-diff-guard's call deliberately omits this and keeps its
      // CI-only skip-when-unset contract.
      mergeBaseFallbackRefs: ESLINT_GATE_MERGE_BASE_FALLBACK_REFS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = `base-prep-failed (base resolution): ${message}`;
    emitLoudSkip(logger, env, reason);
    return {
      failed: false,
      status: "skipped",
      regressions: [],
      skippedReason: reason,
    };
  }
  if (baseShaResult.kind === "skip") {
    const reason = baseShaResult.reason ?? "Unknown reason";
    emitLoudSkip(logger, env, reason);
    return {
      failed: false,
      status: "skipped",
      regressions: [],
      skippedReason: reason,
    };
  }

  const baseSha = ensureUsableSha(
    baseShaResult.sha ?? "",
    "Failed to resolve BASE_SHA",
  );

  // INFRA boundary (D3 / GPT-r2-F1): git diff (`changedFiles`), base-content
  // reads (`git show`), and ESLint-stdin spawns are all base-prep / infra ops.
  // A failure in ANY of them degrades to a LOUD non-fatal skip (mirroring
  // knip-diff-guard.ts) rather than bubbling to exit 1 — flaky git/ESLint must
  // not block the team. IMPORTANT: this catch covers ONLY base-prep/infra; the
  // comparator (findNewWarnings) is deliberately reached through processFile
  // here too, but a genuine NEW warning produces a `regression` FileResult, not
  // a thrown error, so it is reported and FAILS the gate as intended — the
  // skip path is exclusively for thrown infra errors, never for real findings.
  let candidateFiles: ChangedFileRecord[];
  try {
    const changedFiles = await git.changedFiles(baseSha, "HEAD");
    candidateFiles = changedFiles.filter((entry) =>
      isEslintRelevantFile(entry.path),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = `base-prep-failed (git diff): ${message}`;
    emitLoudSkip(logger, env, reason);
    return {
      failed: false,
      status: "skipped",
      regressions: [],
      skippedReason: reason,
    };
  }

  // Per-file: 2 git cat-file reads + up to 2 ESLint spawns. Sequential
  // processing previously timed out the 10-min CI gate when changed-file
  // counts crossed ~25 files. Cap concurrency to keep CPU/memory headroom
  // on the standard 2-core ubuntu-latest runner while still cutting
  // wall-clock time roughly proportionally to the limit.
  const LINT_CONCURRENCY = 4;

  type FileResult =
    | { kind: "skipped"; filePath: string; reason: string }
    | { kind: "regression"; record: RegressionRecord }
    | { kind: "ok" };

  async function processFile(entry: ChangedFileRecord): Promise<FileResult> {
    const filePath = entry.path;

    // INFRA-ONLY scope (GPT-F1): only the git/ESLint I/O is wrapped as infra.
    // A failure here (flaky `git show`, ESLint-stdin spawn error) becomes an
    // InfraError → loud non-fatal skip. The comparator/detection logic
    // (findNewWarnings + regression construction) runs OUTSIDE this try, so a
    // bug there throws a plain Error and FAILS CLOSED rather than skipping.
    let io: {
      currentContent: string;
      baselineAudit: EslintAuditResult;
      currentAudit: EslintAuditResult;
    } | null;
    try {
      const currentContent = await git.fileAtRev("HEAD", filePath);
      if (currentContent === null) {
        io = null;
      } else {
        // D5 (docs/plans/260612_silent-swallow-gate/PLAN.md) — coverage-surface
        // -changing rename limitation. We lint the BASE content read from the
        // OLD path (`entry.basePath`) but under the NEW path (`filePath`) config.
        // When a file moves from a path where a path-scoped rule is EXEMPT
        // (e.g. `evals/` for rebel-silent-swallow) into a COVERED path (e.g.
        // `src/`), the swallows already in that file appear in both the baseline
        // and HEAD lints, so they cancel and are treated as pre-existing rather
        // than new — the gate does not catch them on the rename commit. This is
        // an INTENTIONAL, documented limitation: making it baseline-zero would
        // require teaching this generic per-rule gate each rule's surface-
        // coverage model, a disproportionate coupling. Residual exposure is
        // narrow (the `--max-warnings 3000` cap still applies, and the next edit
        // re-lints the file under its covered path). Behaviour is pinned by the
        // "PINS the coverage-surface-changing rename limitation (D5)" test in
        // scripts/__tests__/check-eslint-new-warnings.test.ts so it can't change
        // silently.
        const baselineContent =
          entry.basePath === null
            ? null
            : await git.fileAtRev(baseSha, entry.basePath);
        const currentAudit = await lintContentAtPath({
          eslint,
          content: currentContent,
          filePath,
        });
        const baselineAudit =
          baselineContent === null
            ? ({
                totalWarnings: 0,
                perRuleCounts: new Map(),
                warnings: [],
              } satisfies EslintAuditResult)
            : await lintContentAtPath({
                eslint,
                content: baselineContent,
                filePath,
              });
        io = { currentContent, baselineAudit, currentAudit };
      }
    } catch (error) {
      throw new InfraError(`per-file lint/read (${filePath})`, error);
    }

    if (io === null) {
      return {
        kind: "skipped",
        filePath,
        reason: "file is not present at HEAD",
      };
    }

    // Comparator + regression construction: deliberately OUTSIDE the infra try.
    // A throw here is a real bug and must NOT be skip-normalized — it propagates
    // and fails closed (exit 1).
    const newWarnings = detectNewWarnings({
      currentWarnings: io.currentAudit.warnings,
      baselineWarnings: io.baselineAudit.warnings,
    });

    if (newWarnings.length === 0) {
      return { kind: "ok" };
    }

    return {
      kind: "regression",
      record: {
        filePath,
        baselineCount: io.baselineAudit.totalWarnings,
        currentCount: io.currentAudit.totalWarnings,
        newWarnings,
      },
    };
  }

  // Stable-order regressions: collect by candidate-list index so the
  // annotation output matches the prior sequential order regardless of
  // which parallel worker finishes first.
  const indexedResults: Array<{ index: number; result: FileResult }> = [];
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= candidateFiles.length) {
        return;
      }
      const result = await processFile(candidateFiles[i]);
      indexedResults.push({ index: i, result });
    }
  }
  // Only a tagged InfraError (git show / ESLint-stdin I/O) degrades to a LOUD
  // non-fatal skip (D3) so flaky git/ESLint can't block the team. ANY other
  // throw — a comparator/detection bug in findNewWarnings, an unexpected error
  // — is re-thrown and FAILS CLOSED (→ outer main().catch → exit 1). A real new
  // warning is a returned `regression` FileResult, not a throw, so it is always
  // reported and fails the gate as intended (GPT-F1: only known infra skips).
  try {
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            LINT_CONCURRENCY,
            Math.max(candidateFiles.length, 1),
          ),
        },
        () => worker(),
      ),
    );
  } catch (error) {
    if (!(error instanceof InfraError)) {
      // Fail closed: a non-infra throw (e.g. a comparator bug) must NOT be
      // normalized into a skip — re-throw so enforcement can't silently vanish.
      throw error;
    }
    const reason = `base-prep-failed (${error.stage}): ${error.message}`;
    emitLoudSkip(logger, env, reason);
    return {
      failed: false,
      status: "skipped",
      regressions: [],
      skippedReason: reason,
    };
  }
  indexedResults.sort((a, b) => a.index - b.index);

  const regressions: RegressionRecord[] = [];
  for (const { result } of indexedResults) {
    if (result.kind === "skipped") {
      logger.warn(
        `[eslint-new-warnings] Skipping ${result.filePath} because ${result.reason}.`,
      );
    } else if (result.kind === "regression") {
      regressions.push(result.record);
    }
  }

  if (regressions.length === 0) {
    logger.log(
      createSummaryLogLine({
        status: "ok",
        baseSha,
        checkedFiles: candidateFiles.length,
        regressions: 0,
      }),
    );
    return {
      failed: false,
      status: "ok",
      regressions: [],
    };
  }

  if (env.get("GITHUB_ACTIONS") === "true") {
    for (const regression of regressions) {
      for (const warning of regression.newWarnings) {
        const line = warning.line > 0 ? warning.line : 1;
        const column = warning.column > 0 ? warning.column : 1;
        const ruleId = warning.ruleId ?? "unknown-rule";
        const annotationMessage = toAnnotationSafe(
          `ESLint warning regression: ${ruleId} ${warning.message} (baseline: ${regression.baselineCount}, current: ${regression.currentCount})`,
        );
        logger.warn(
          `::warning file=${toAnnotationSafe(regression.filePath)},line=${line},col=${column}::${annotationMessage}`,
        );
      }
    }
  }

  logger.error(
    createSummaryLogLine({
      status: "regressions",
      baseSha,
      checkedFiles: candidateFiles.length,
      regressions: regressions.length,
    }),
  );

  return {
    failed: true,
    status: "regressions",
    regressions,
  };
}

export function createProcessEnvReader(): EnvReader {
  return {
    get(name: string) {
      return process.env[name];
    },
  };
}

async function runGitCommand(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      const child = spawn("git", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (!child.stdout || !child.stderr) {
        reject(new Error("Unable to capture git output streams"));
        return;
      }

      let stdout = "";
      let stderr = "";
      let alreadyRejected = false;

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunkToString(chunk);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunkToString(chunk);
      });
      child.on("error", (error: Error) => {
        alreadyRejected = true;
        reject(new Error(`Failed to spawn git: ${error.message}`));
      });
      child.on(
        "close",
        (code: number | null, signal: NodeJS.Signals | null) => {
          if (alreadyRejected) {
            return;
          }
          if (code === null) {
            reject(
              new Error(
                `git process terminated by signal ${signal ?? "unknown"}`,
              ),
            );
            return;
          }
          resolve({ stdout, stderr, exitCode: code });
        },
      );
    },
  );
}

export function createDefaultGitRunner(): GitRunner {
  function parseChangedFileRecords(stdout: string): ChangedFileRecord[] {
    const records: ChangedFileRecord[] = [];
    const lines = stdout.split(/\r?\n/u);

    for (const rawLine of lines) {
      if (rawLine.trim().length === 0) {
        continue;
      }

      const fields = rawLine.split("\t");
      const statusToken = fields[0]?.trim() ?? "";

      if (statusToken.length === 0) {
        throw new Error(
          `git diff --name-status emitted a malformed line: ${rawLine}`,
        );
      }

      const statusCode = statusToken.charAt(0);
      if (statusCode === "A" || statusCode === "M") {
        const filePath = fields[1];
        if (!filePath || filePath.length === 0) {
          throw new Error(
            `git diff --name-status emitted a malformed ${statusCode} line: ${rawLine}`,
          );
        }
        records.push({
          status: statusCode,
          path: normalizeGitPath(filePath),
          basePath: statusCode === "A" ? null : normalizeGitPath(filePath),
        });
        continue;
      }

      if (statusCode === "R") {
        const oldPath = fields[1];
        const newPath = fields[2];
        if (!oldPath || !newPath) {
          throw new Error(
            `git diff --name-status emitted a malformed rename line: ${rawLine}`,
          );
        }
        records.push({
          status: "R",
          path: normalizeGitPath(newPath),
          basePath: normalizeGitPath(oldPath),
        });
        continue;
      }

      throw new Error(
        `git diff --name-status emitted unsupported status "${statusToken}"`,
      );
    }

    return records;
  }

  return {
    async revParse(ref) {
      const result = await runGitCommand(["rev-parse", ref]);
      if (result.exitCode !== 0) {
        const stderr = result.stderr.trim();
        throw new Error(
          `git rev-parse ${ref} failed with code ${result.exitCode}${stderr.length > 0 ? `: ${stderr}` : ""}`,
        );
      }
      return result.stdout.trim();
    },

    async mergeBase(refA, refB) {
      const result = await runGitCommand(["merge-base", refA, refB]);
      if (result.exitCode !== 0) {
        const stderr = result.stderr.trim();
        throw new Error(
          `git merge-base ${refA} ${refB} failed with code ${result.exitCode}${stderr.length > 0 ? `: ${stderr}` : ""}`,
        );
      }
      return result.stdout.trim();
    },

    async changedFiles(base, head) {
      const result = await runGitCommand([
        "diff",
        "--name-status",
        "--diff-filter=AMR",
        "-M",
        `${base}..${head}`,
      ]);
      if (result.exitCode !== 0) {
        const stderr = result.stderr.trim();
        throw new Error(
          `git diff failed with code ${result.exitCode}${stderr.length > 0 ? `: ${stderr}` : ""}`,
        );
      }
      return parseChangedFileRecords(result.stdout);
    },

    async fileAtRev(rev, filePath) {
      const result = await runGitCommand(["show", `${rev}:${filePath}`]);
      if (result.exitCode === 0) {
        return result.stdout;
      }

      const stderr = result.stderr.trim();
      if (
        stderr.includes("does not exist in") ||
        stderr.includes("exists on disk, but not in") ||
        (stderr.includes("fatal: path") && stderr.includes("exists"))
      ) {
        return null;
      }

      throw new Error(
        `git show ${rev}:${filePath} failed with code ${result.exitCode}${stderr.length > 0 ? `: ${stderr}` : ""}`,
      );
    },
  };
}

export async function main(
  options: {
    env?: EnvReader;
    git?: GitRunner;
    eslint?: EslintRunner;
    logger?: Pick<Console, "log" | "warn" | "error">;
    args?: string[];
  } = {},
): Promise<void> {
  const logger = options.logger ?? console;
  const result = await runDiffScopedCheck({
    env: options.env ?? createProcessEnvReader(),
    git: options.git ?? createDefaultGitRunner(),
    eslint: options.eslint ?? createDefaultEslintRunner(),
    logger,
    args: options.args ?? process.argv.slice(2),
  });

  if (result.status === "regressions") {
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error("Unexpected error in check-eslint-new-warnings:", error);
    process.exit(1);
  });
}
