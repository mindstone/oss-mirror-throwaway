import { describe, expect, it, vi } from "vitest";
import {
  collectExportAndDuplicateFindings,
  collectProductionFindings,
  computeNewFindings,
  runKnipDiffGuard,
  type BaseKnipReports,
  type BaseKnipRunner,
  type KnipDiffFinding,
} from "../lib/knip-diff-guard";
import type {
  ChangedFileRecord,
  EnvReader,
  GitRunner,
} from "../check-eslint-new-warnings";
import type { KnipReport } from "../check-knip-health";

function createEnv(values: Record<string, string | undefined>): EnvReader {
  return {
    get(name: string) {
      return values[name];
    },
  };
}

function createLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function modified(path: string): ChangedFileRecord {
  return {
    status: "M",
    path,
    basePath: path,
  };
}

function renamed(basePath: string, path: string): ChangedFileRecord {
  return {
    status: "R",
    path,
    basePath,
  };
}

function exportFinding(file: string, name: string): KnipDiffFinding {
  return {
    kind: "export",
    file,
    name,
  };
}

function duplicateFinding(file: string, names: string[]): KnipDiffFinding {
  return {
    kind: "duplicate",
    file,
    name: [...names].sort().join("|"),
  };
}

function reportWithExport(file: string, name: string): KnipReport {
  return {
    issues: [
      {
        file,
        exports: [{ name, line: 7, col: 3 }],
      },
    ],
  };
}

function emptyReport(): KnipReport {
  return { files: [], issues: [] };
}

// A non-empty production report in an UNCHANGED file: keeps the base-config
// sentinel quiet without contributing matchable findings to the diff.
function productionAnchorReport(): KnipReport {
  return reportWithExport("src/base-anchor.ts", "baseAnchorExport");
}

function createBaseRunner(
  reports: Partial<BaseKnipReports> = {},
): BaseKnipRunner & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(
    async (): Promise<BaseKnipReports> => ({
      defaultReport: reports.defaultReport ?? emptyReport(),
      productionReport: reports.productionReport ?? productionAnchorReport(),
    }),
  );
  return { run };
}

function added(path: string): ChangedFileRecord {
  return {
    status: "A",
    path,
    basePath: null,
  };
}

function createGitRunner(
  params: {
    changedFiles?: ChangedFileRecord[];
  } = {},
): GitRunner & {
  changedFiles: ReturnType<typeof vi.fn>;
} {
  const changedFiles = vi.fn(async () => params.changedFiles ?? []);
  return {
    revParse: vi.fn(async () => "resolved-base"),
    mergeBase: vi.fn(async () => "merge-base"),
    changedFiles,
    fileAtRev: vi.fn(async () => null),
  };
}

describe("computeNewFindings", () => {
  it("treats a new export in a changed file as new", () => {
    const result = computeNewFindings({
      headFindings: [exportFinding("src/example.ts", "newDeadExport")],
      baseFindings: [],
      changedFiles: [modified("src/example.ts")],
    });

    expect(result).toEqual([exportFinding("src/example.ts", "newDeadExport")]);
  });

  it("does not treat the same pre-existing dead export in a changed file as new", () => {
    const result = computeNewFindings({
      headFindings: [exportFinding("src/example.ts", "legacyDeadExport")],
      baseFindings: [exportFinding("src/example.ts", "legacyDeadExport")],
      changedFiles: [modified("src/example.ts")],
    });

    expect(result).toEqual([]);
  });

  it("ignores dead exports in unchanged files even when absent at base", () => {
    const result = computeNewFindings({
      headFindings: [exportFinding("src/unchanged.ts", "newButOutOfScope")],
      baseFindings: [],
      changedFiles: [modified("src/changed.ts")],
    });

    expect(result).toEqual([]);
  });

  it("maps base-path findings to head paths for renames", () => {
    const result = computeNewFindings({
      headFindings: [exportFinding("src/new-name.ts", "movedDeadExport")],
      baseFindings: [exportFinding("src/old-name.ts", "movedDeadExport")],
      changedFiles: [renamed("src/old-name.ts", "src/new-name.ts")],
    });

    expect(result).toEqual([]);
  });

  it("keys duplicate groups by sorted member names", () => {
    const headFindings = collectExportAndDuplicateFindings({
      issues: [
        {
          file: "src/example.ts",
          duplicates: [[{ name: "zeta" }, { name: "alpha" }]],
        },
      ],
    });
    const baseFindings = collectExportAndDuplicateFindings({
      issues: [
        {
          file: "src/example.ts",
          duplicates: [[{ name: "alpha" }, { name: "zeta" }]],
        },
      ],
    });

    const result = computeNewFindings({
      headFindings,
      baseFindings,
      changedFiles: [modified("src/example.ts")],
    });

    expect(headFindings).toEqual([
      duplicateFinding("src/example.ts", ["alpha", "zeta"]),
    ]);
    expect(result).toEqual([]);
  });

  it("uses multiset semantics when HEAD has more matching findings than base", () => {
    const result = computeNewFindings({
      headFindings: [
        exportFinding("src/example.ts", "repeatedDeadExport"),
        exportFinding("src/example.ts", "repeatedDeadExport"),
      ],
      baseFindings: [exportFinding("src/example.ts", "repeatedDeadExport")],
      changedFiles: [modified("src/example.ts")],
    });

    expect(result).toEqual([
      exportFinding("src/example.ts", "repeatedDeadExport"),
    ]);
  });
});

describe("runKnipDiffGuard", () => {
  it("skips when BASE_SHA is unset", async () => {
    const git = createGitRunner();
    const baseKnipRunner = createBaseRunner();
    const logger = createLogger();

    const result = await runKnipDiffGuard({
      headReport: { issues: [] },
      headProductionReport: emptyReport(),
      env: createEnv({}),
      git,
      baseKnipRunner,
      logger,
      args: [],
    });

    expect(result).toEqual({
      failed: false,
      status: "skipped",
      newFindings: [],
      skippedReason: "BASE_SHA env not set",
    });
    expect(git.changedFiles).not.toHaveBeenCalled();
    expect(baseKnipRunner.run).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "knip-diff-guard",
        status: "skipped",
        reason: "BASE_SHA env not set",
      }),
    );
  });

  it("degrades to a loud non-fatal skip when base prep fails in CI mode", async () => {
    // Operational choice (see PLAN.md Decision Log + knip-diff-guard.ts catch
    // block): infra failures (base worktree prep / base knip crash) must NOT
    // hard-fail shared CI — they degrade to a loud skip so a flaky base-prep
    // step can't block the whole team's PRs. The Stage 1a count ratchet is the
    // always-on floor. Real new-finding detection still fails hard (other tests).
    const logger = createLogger();
    const result = await runKnipDiffGuard({
      headReport: reportWithExport("src/example.ts", "newDeadExport"),
      headProductionReport: emptyReport(),
      env: createEnv({ BASE_SHA: "base-sha", GITHUB_ACTIONS: "true" }),
      git: createGitRunner({ changedFiles: [modified("src/example.ts")] }),
      baseKnipRunner: {
        run: vi.fn(async () => {
          throw new Error("base worktree failed");
        }),
      },
      logger,
      args: [],
    });

    expect(result.failed).toBe(false);
    expect(result.status).toBe("skipped");
    expect(result.skippedReason).toBe("base-prep-failed: base worktree failed");
    // Loud skip: structured warn line + a GitHub Actions ::warning:: annotation.
    expect(logger.warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: "knip-diff-guard",
        status: "skipped",
        baseSha: "base-sha",
        reason: "base-prep-failed: base worktree failed",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("::warning::knip-diff-guard skipped"),
    );
  });
});

describe("collectProductionFindings", () => {
  it("collects production exports and files, applying seam-name and test-path filters", () => {
    const findings = collectProductionFindings({
      files: [
        "src/main/services/deadService.ts",
        "src/core/__tests__/helpers.ts",
        "src/test-utils/liveApiHarness.ts",
      ],
      issues: [
        {
          file: "src/example.ts",
          exports: [
            { name: "clearForSlug", line: 7, col: 3 },
            { name: "setClockForTesting", line: 9, col: 3 },
            { name: "_resetSingleton", line: 11, col: 3 },
          ],
          // Duplicates are telemetry-only in the production leg — never diffed.
          duplicates: [[{ name: "a" }, { name: "b" }]],
        },
      ],
    });

    expect(findings).toEqual([
      {
        kind: "prod-export",
        file: "src/example.ts",
        name: "clearForSlug",
        line: 7,
        col: 3,
      },
      {
        kind: "prod-file",
        file: "src/main/services/deadService.ts",
        name: "(unused production file)",
      },
    ]);
  });
});

describe("runKnipDiffGuard production leg", () => {
  it("fails on a NEW production-only finding in a changed file (the clearForSlug class)", async () => {
    const logger = createLogger();
    const result = await runKnipDiffGuard({
      headReport: emptyReport(),
      headProductionReport: reportWithExport("src/example.ts", "clearForSlug"),
      env: createEnv({ BASE_SHA: "base-sha" }),
      git: createGitRunner({ changedFiles: [modified("src/example.ts")] }),
      baseKnipRunner: createBaseRunner(),
      logger,
      args: [],
    });

    expect(result.failed).toBe(true);
    expect(result.status).toBe("new-findings");
    expect(result.newFindings).toEqual([
      {
        kind: "prod-export",
        file: "src/example.ts",
        name: "clearForSlug",
        line: 7,
        col: 3,
      },
    ]);
    // The failure text carries the production semantics + escape hatches +
    // a pointer to the SSOT escape-hatch doc (Phase 7, GPT-F1).
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("production unused export clearForSlug"),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("/** @internal */"),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "docs/project/DEAD_CODE_DETECTION_AND_REMOVAL.md#production-leg-escape-hatches",
      ),
    );
  });

  it("passes when the production finding already existed at base", async () => {
    const logger = createLogger();
    const result = await runKnipDiffGuard({
      headReport: emptyReport(),
      headProductionReport: reportWithExport("src/example.ts", "clearForSlug"),
      env: createEnv({ BASE_SHA: "base-sha" }),
      git: createGitRunner({ changedFiles: [modified("src/example.ts")] }),
      baseKnipRunner: createBaseRunner({
        productionReport: reportWithExport("src/example.ts", "clearForSlug"),
      }),
      logger,
      args: [],
    });

    expect(result.failed).toBe(false);
    expect(result.status).toBe("ok");
  });

  it("fails on a NEW production-path unused file among changed files", async () => {
    const logger = createLogger();
    const result = await runKnipDiffGuard({
      headReport: emptyReport(),
      headProductionReport: {
        files: ["src/main/services/deadService.ts"],
        issues: [],
      },
      env: createEnv({ BASE_SHA: "base-sha" }),
      git: createGitRunner({
        changedFiles: [added("src/main/services/deadService.ts")],
      }),
      baseKnipRunner: createBaseRunner(),
      logger,
      args: [],
    });

    expect(result.failed).toBe(true);
    expect(result.newFindings).toEqual([
      {
        kind: "prod-file",
        file: "src/main/services/deadService.ts",
        name: "(unused production file)",
      },
    ]);
  });

  it("applies the seam-name and test-path filters symmetrically (exempt findings never fail)", async () => {
    const logger = createLogger();
    const result = await runKnipDiffGuard({
      headReport: emptyReport(),
      headProductionReport: {
        files: ["src/core/__tests__/newHelper.ts"],
        issues: [
          {
            file: "src/example.ts",
            exports: [{ name: "setClockForTesting", line: 3, col: 1 }],
          },
        ],
      },
      env: createEnv({ BASE_SHA: "base-sha" }),
      git: createGitRunner({
        changedFiles: [
          modified("src/example.ts"),
          added("src/core/__tests__/newHelper.ts"),
        ],
      }),
      baseKnipRunner: createBaseRunner(),
      logger,
      args: [],
    });

    expect(result.failed).toBe(false);
    expect(result.status).toBe("ok");
  });

  it("does not let a base default-leg finding absorb a new production-leg finding", async () => {
    // Same file+symbol present at base in DEFAULT mode only (e.g. it had a
    // production caller then; the head change deleted it, leaving tests as the
    // only consumers). The kinds differ, so the production finding is NEW.
    const logger = createLogger();
    const result = await runKnipDiffGuard({
      headReport: emptyReport(),
      headProductionReport: reportWithExport("src/example.ts", "clearForSlug"),
      env: createEnv({ BASE_SHA: "base-sha" }),
      git: createGitRunner({ changedFiles: [modified("src/example.ts")] }),
      baseKnipRunner: createBaseRunner({
        defaultReport: reportWithExport("src/example.ts", "clearForSlug"),
      }),
      logger,
      args: [],
    });

    expect(result.failed).toBe(true);
    expect(result.newFindings).toEqual([
      {
        kind: "prod-export",
        file: "src/example.ts",
        name: "clearForSlug",
        line: 7,
        col: 3,
      },
    ]);
  });

  it("sentinel: loudly skips ONLY the production leg when the base production report is empty-by-construction", async () => {
    // Base knip.json without `!` glob suffixes yields an empty production
    // report — diffing against it would mark every head production finding as
    // new. One-merge transition window: skip the production comparison loudly,
    // keep the default-mode comparison gating.
    const logger = createLogger();
    const result = await runKnipDiffGuard({
      headReport: reportWithExport("src/changed.ts", "newDeadExport"),
      headProductionReport: reportWithExport("src/example.ts", "clearForSlug"),
      env: createEnv({ BASE_SHA: "base-sha", GITHUB_ACTIONS: "true" }),
      git: createGitRunner({
        changedFiles: [modified("src/example.ts"), modified("src/changed.ts")],
      }),
      baseKnipRunner: createBaseRunner({ productionReport: emptyReport() }),
      logger,
      args: [],
    });

    // Default leg still fails on its own new finding; the production finding
    // is excluded from the comparison (no prod-export entries).
    expect(result.failed).toBe(true);
    expect(result.newFindings).toEqual([
      {
        kind: "export",
        file: "src/changed.ts",
        name: "newDeadExport",
        line: 7,
        col: 3,
      },
    ]);
    expect(result.productionSkippedReason).toContain("empty-by-construction");
    expect(logger.warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: "knip-diff-guard",
        status: "production-leg-skipped",
        baseSha: "base-sha",
        reason:
          "base production report is empty-by-construction (base knip.json entry/project globs lack `!` production suffixes)",
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "::warning::knip-diff-guard production leg skipped",
      ),
    );
  });

  it("sentinel skip with a clean default leg stays green and reports the skip reason", async () => {
    const logger = createLogger();
    const result = await runKnipDiffGuard({
      headReport: emptyReport(),
      headProductionReport: reportWithExport("src/example.ts", "clearForSlug"),
      env: createEnv({ BASE_SHA: "base-sha" }),
      git: createGitRunner({ changedFiles: [modified("src/example.ts")] }),
      baseKnipRunner: createBaseRunner({ productionReport: emptyReport() }),
      logger,
      args: [],
    });

    expect(result.failed).toBe(false);
    expect(result.status).toBe("ok");
    expect(result.productionSkippedReason).toContain("empty-by-construction");
  });
});
