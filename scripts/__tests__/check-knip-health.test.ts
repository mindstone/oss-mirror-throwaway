import { describe, expect, it } from "vitest";
import {
  evaluateKnipReport,
  evaluateProductionKnipReport,
  KNIP_PROD_ENFORCEMENT_ENABLED,
  type KnipHealthLine,
  type KnipReport,
  type KnipSymbolFinding,
} from "../check-knip-health";

function symbol(name: string): KnipSymbolFinding {
  return { name };
}

function texts(lines: KnipHealthLine[]): string[] {
  return lines.map((line) => line.text);
}

function baseReport(overrides: KnipReport = {}): KnipReport {
  return {
    files: [],
    issues: [],
    ...overrides,
  };
}

describe("evaluateKnipReport", () => {
  it("fails when unused files are present", () => {
    const result = evaluateKnipReport(
      baseReport({ files: ["src/unused.ts"] }),
      { exportBaseline: 0, duplicateBaseline: 0 },
    );

    expect(result.failed).toBe(true);
    expect(result.counts.files).toBe(1);
    expect(texts(result.lines)).toContain("✘ Found 1 unused file(s):");
    expect(texts(result.lines)).toContain("  src/unused.ts");
  });

  it("fails when unused dependencies and devDependencies are present", () => {
    const result = evaluateKnipReport(
      baseReport({
        issues: [
          {
            file: "package.json",
            dependencies: [{ name: "left-pad", line: 12 }],
            devDependencies: [{ name: "unused-dev", line: 24 }],
          },
        ],
      }),
      { exportBaseline: 0, duplicateBaseline: 0 },
    );

    expect(result.failed).toBe(true);
    expect(result.counts.dependencies).toBe(2);
    expect(texts(result.lines)).toContain("✘ Found 2 unused dependenc(y/ies):");
    expect(texts(result.lines)).toContain(
      "  left-pad (dependency) — package.json:12",
    );
    expect(texts(result.lines)).toContain(
      "  unused-dev (devDependency) — package.json:24",
    );
  });

  it("passes when unused exports exactly match the baseline", () => {
    const result = evaluateKnipReport(
      baseReport({
        issues: [
          { file: "src/example.ts", exports: [symbol("a"), symbol("b")] },
        ],
      }),
      { exportBaseline: 2, duplicateBaseline: 0 },
    );

    expect(result.failed).toBe(false);
    expect(result.counts.exports).toBe(2);
    expect(texts(result.lines)).toContain(
      "✔ unused exports: 2/2 (within baseline)",
    );
  });

  it("fails when unused exports exceed the baseline", () => {
    const result = evaluateKnipReport(
      baseReport({
        issues: [
          { file: "src/example.ts", exports: [symbol("a"), symbol("b")] },
        ],
      }),
      { exportBaseline: 1, duplicateBaseline: 0 },
    );

    expect(result.failed).toBe(true);
    expect(result.counts.exports).toBe(2);
    expect(texts(result.lines)).toContain(
      "✘ unused exports regressed: 2 (baseline 1, +1)",
    );
  });

  it("fails when duplicate export groups exceed the baseline", () => {
    const result = evaluateKnipReport(
      baseReport({
        issues: [
          {
            file: "src/example.ts",
            duplicates: [
              [symbol("a"), symbol("b")],
              [symbol("c"), symbol("d")],
            ],
          },
        ],
      }),
      { exportBaseline: 0, duplicateBaseline: 1 },
    );

    expect(result.failed).toBe(true);
    expect(result.counts.duplicates).toBe(2);
    expect(texts(result.lines)).toContain(
      "✘ duplicate export groups regressed: 2 (baseline 1, +1)",
    );
  });

  it("passes and warns when counts are below their baselines", () => {
    const result = evaluateKnipReport(
      baseReport({
        issues: [{ file: "src/example.ts", exports: [symbol("a")] }],
      }),
      { exportBaseline: 2, duplicateBaseline: 1 },
    );

    expect(result.failed).toBe(false);
    expect(result.lines).toContainEqual({
      stream: "warn",
      text: "⚠ unused exports below baseline: lower KNIP_EXPORT_BASELINE to 1 in scripts/check-knip-health.ts",
    });
    expect(result.lines).toContainEqual({
      stream: "warn",
      text: "⚠ duplicate export groups below baseline: lower KNIP_DUPLICATE_EXPORT_BASELINE to 0 in scripts/check-knip-health.ts",
    });
  });

  it("counts duplicate exports as groups, not group members", () => {
    const result = evaluateKnipReport(
      baseReport({
        issues: [
          {
            file: "src/example.ts",
            duplicates: [
              [symbol("a"), symbol("b"), symbol("c")],
              [symbol("d"), symbol("e")],
            ],
          },
        ],
      }),
      { exportBaseline: 0, duplicateBaseline: 2 },
    );

    expect(result.failed).toBe(false);
    expect(result.counts.duplicates).toBe(2);
    expect(texts(result.lines)).toContain(
      "✔ duplicate export groups: 2/2 (within baseline)",
    );
  });

  it("never fails because of unused types", () => {
    const result = evaluateKnipReport(
      baseReport({
        issues: [
          {
            file: "src/types-heavy.ts",
            types: Array.from({ length: 3000 }, (_unused, index) =>
              symbol(`Type${index}`),
            ),
          },
        ],
      }),
      { exportBaseline: 0, duplicateBaseline: 0 },
    );

    expect(result.failed).toBe(false);
    expect(result.counts.types).toBe(3000);
    expect(texts(result.lines)).toContain(
      "unused types: 3000 (baseline 397, report-only — not gated)",
    );
    expect(texts(result.lines)).toContain("Top unused type files:");
    expect(texts(result.lines)).toContain("  src/types-heavy.ts: 3000");
  });
});

describe("evaluateProductionKnipReport", () => {
  const baselines = { exportBaseline: 0, fileBaseline: 0 };

  it("exempts seam-named exports before counting", () => {
    const result = evaluateProductionKnipReport(
      baseReport({
        issues: [
          {
            file: "src/example.ts",
            exports: [
              symbol("setClockForTesting"),
              symbol("flushQueueForTests"),
              symbol("primeCacheForTest"),
              symbol("_resetSingleton"),
              symbol("__resetPerfStats"),
              symbol("_testing_resetBatches"),
              symbol("_testOnly"),
              symbol("__test"),
              symbol("clearForSlug"),
            ],
          },
        ],
      }),
      { baselines: { exportBaseline: 1, fileBaseline: 0 }, enforce: true },
    );

    expect(result.failed).toBe(false);
    expect(result.counts.exports).toBe(1);
    expect(result.counts.seamExemptExports).toBe(8);
    expect(texts(result.lines)).toContain(
      "✔ production unused exports: 1/1 (within baseline)",
    );
  });

  it("exempts test-harness/fixture files by path before counting", () => {
    const result = evaluateProductionKnipReport(
      baseReport({
        files: [
          "src/core/__tests__/testHelpers.ts",
          "src/test-utils/liveApiHarness.ts",
          "cloud-service/src/__test_helpers__/uploadHarness.ts",
          "src/renderer/__mocks__/electron.ts",
          "src/plugins/__fixtures__/sample.ts",
          "src/plugins/fixtures/sample.ts",
          "cloud-service/src/meeting_harness/boot.ts",
          "src/main/services/toolAliasCache.ts",
        ],
        issues: [{ file: "src/anchor.ts", exports: [symbol("anchor")] }],
      }),
      { baselines: { exportBaseline: 1, fileBaseline: 1 }, enforce: true },
    );

    expect(result.failed).toBe(false);
    expect(result.counts.files).toBe(1);
    expect(result.counts.testPathExemptFiles).toBe(7);
    expect(texts(result.lines)).toContain(
      "✔ production unused files: 1/1 (within baseline)",
    );
    expect(texts(result.lines)).toContain(
      "  src/main/services/toolAliasCache.ts",
    );
  });

  it("warns without failing when over baseline in WARN mode", () => {
    const result = evaluateProductionKnipReport(
      baseReport({
        files: ["src/dead.ts"],
        issues: [
          { file: "src/example.ts", exports: [symbol("a"), symbol("b")] },
        ],
      }),
      { baselines, enforce: false },
    );

    expect(result.failed).toBe(false);
    expect(result.counts.exports).toBe(2);
    expect(result.counts.files).toBe(1);
    const warnTexts = result.lines
      .filter((line) => line.stream === "warn")
      .map((line) => line.text);
    expect(warnTexts).toContain(
      "⚠ production unused exports regressed: 2 (baseline 0, +2) — WARN only; KNIP_PROD_ENFORCEMENT_ENABLED is off",
    );
    expect(warnTexts).toContain(
      "⚠ production unused files regressed: 1 (baseline 0, +1) — WARN only; KNIP_PROD_ENFORCEMENT_ENABLED is off",
    );
    expect(result.lines.some((line) => line.stream === "error")).toBe(false);
  });

  it("fails on over-baseline exports when enforcing", () => {
    const result = evaluateProductionKnipReport(
      baseReport({
        issues: [{ file: "src/example.ts", exports: [symbol("a")] }],
      }),
      { baselines, enforce: true },
    );

    expect(result.failed).toBe(true);
    expect(texts(result.lines)).toContain(
      "✘ production unused exports regressed: 1 (baseline 0, +1)",
    );
  });

  it("fails on over-baseline production files when enforcing", () => {
    const result = evaluateProductionKnipReport(
      baseReport({
        files: ["src/dead.ts"],
        issues: [{ file: "src/anchor.ts", exports: [symbol("anchor")] }],
      }),
      { baselines: { exportBaseline: 1, fileBaseline: 0 }, enforce: true },
    );

    expect(result.failed).toBe(true);
    expect(texts(result.lines)).toContain(
      "✘ production unused files regressed: 1 (baseline 0, +1)",
    );
  });

  it("documents the @public/@internal escape hatches on regression", () => {
    const result = evaluateProductionKnipReport(
      baseReport({
        issues: [{ file: "src/example.ts", exports: [symbol("a")] }],
      }),
      { baselines, enforce: false },
    );

    const escapeHatchLines = result.lines.filter(
      (line) =>
        line.text.includes("/** @internal */") &&
        line.text.includes("/** @public */") &&
        // The failure must make the SSOT escape-hatch doc discoverable
        // from the error itself (Phase 7, GPT-F1).
        line.text.includes(
          "docs/project/DEAD_CODE_DETECTION_AND_REMOVAL.md#production-leg-escape-hatches",
        ),
    );
    expect(escapeHatchLines.length).toBeGreaterThan(0);
  });

  it("warns to lower the baseline when below it", () => {
    const result = evaluateProductionKnipReport(
      baseReport({
        issues: [{ file: "src/anchor.ts", exports: [symbol("anchor")] }],
      }),
      { baselines: { exportBaseline: 5, fileBaseline: 3 }, enforce: true },
    );

    expect(result.failed).toBe(false);
    expect(result.lines).toContainEqual({
      stream: "warn",
      text: "⚠ production unused exports below baseline: lower KNIP_PROD_EXPORT_BASELINE to 1 in scripts/check-knip-health.ts",
    });
    expect(result.lines).toContainEqual({
      stream: "warn",
      text: "⚠ production unused files below baseline: lower KNIP_PROD_UNUSED_FILE_BASELINE to 0 in scripts/check-knip-health.ts",
    });
  });

  it("flags an empty-by-construction report (missing `!` globs)", () => {
    const result = evaluateProductionKnipReport(baseReport(), {
      baselines: { exportBaseline: 5, fileBaseline: 5 },
      enforce: true,
    });

    expect(result.failed).toBe(false);
    expect(
      texts(result.lines).some((text) =>
        text.includes("production report is EMPTY"),
      ),
    ).toBe(true);
  });

  it("reports duplicates as telemetry only, never gating", () => {
    const result = evaluateProductionKnipReport(
      baseReport({
        issues: [
          {
            file: "src/example.ts",
            duplicates: [[symbol("a"), symbol("b")]],
          },
        ],
      }),
      { baselines, enforce: true },
    );

    expect(result.failed).toBe(false);
    expect(result.counts.duplicates).toBe(1);
    expect(
      texts(result.lines).some((text) =>
        text.includes("1 duplicate export group(s) (report-only)"),
      ),
    ).toBe(true);
  });

  it("lists top offenders for exports and production files", () => {
    const result = evaluateProductionKnipReport(
      baseReport({
        files: ["src/deadA.ts", "src/deadB.ts"],
        issues: [
          {
            file: "src/busy.ts",
            exports: [symbol("a"), symbol("b"), symbol("c")],
          },
          { file: "src/quiet.ts", exports: [symbol("d")] },
        ],
      }),
      { baselines: { exportBaseline: 10, fileBaseline: 10 }, enforce: true },
    );

    const lineTexts = texts(result.lines);
    expect(lineTexts).toContain("Top production unused-export files:");
    expect(lineTexts).toContain("  src/busy.ts: 3");
    expect(lineTexts).toContain("  src/quiet.ts: 1");
    expect(lineTexts).toContain("Production-path unused files (2 total):");
    expect(lineTexts).toContain("  src/deadA.ts");
  });

  // Stage 5 (260612) flipped enforcement on after the Stage 4 WARN-mode push's
  // CI run confirmed the 453/35 baselines (ubuntu identical to local macOS).
  // This pin makes any future flip-back a deliberate, test-visible act.
  it("ships with enforcement ENABLED (S5 flip from the CI baseline read)", () => {
    expect(KNIP_PROD_ENFORCEMENT_ENABLED).toBe(true);

    const overBaseline = evaluateProductionKnipReport(
      baseReport({
        issues: [{ file: "src/example.ts", exports: [symbol("a")] }],
      }),
      { baselines },
    );
    expect(overBaseline.failed).toBe(true);
  });
});
