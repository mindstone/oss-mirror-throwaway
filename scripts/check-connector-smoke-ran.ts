#!/usr/bin/env npx tsx
/**
 * Explicit-run guard for the connector-smoke tier: fail loud when an *operator* asked for
 * connector-smoke tests but zero cells actually ran.
 *
 * Why this exists
 * ---------------
 * The connector-smoke harness (`src/test-utils/connectorSmokeHarness.ts`) skips — never
 * fails — a cell whose connector isn't connected on this machine (no token file, no key env).
 * That "credless = green" invariant is load-bearing for *automation*: a cron/CI run with no
 * stored creds is a clean no-op, by construction. But on an *explicit* run
 * (`npm run test:connectors:smoke`), a green no-op is the wrong outcome — if you asked for
 * connector smokes you want to learn nothing ran, not see a silent pass. Skip-vs-fail is an
 * *entrypoint policy*, not something the per-cell harness should decide (which is why this
 * lives here, mirroring `scripts/check-live-api-ran.ts`).
 *
 * What it checks
 * --------------
 * Reads a Vitest JSON result file and counts NON-PENDING tests (passed + failed). If zero
 * ran, it exits 1. It deliberately does NOT require every connector to be connected: a
 * single connected connector (e.g. only Slack tokens present) still runs that cell, so
 * `ran > 0` and the guard passes — the unconnected connectors skip legitimately, exactly as
 * they would in CI.
 *
 * Wired into: the `test:connectors:smoke` npm script (runs after vitest writes its JSON).
 */
import fs from 'node:fs';

/** The subset of the Vitest JSON reporter shape this guard reads. */
export interface VitestJsonResult {
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
}

export interface ConnectorSmokeRunVerdict {
  ran: number;
  skipped: number;
  ok: boolean;
  message: string;
}

/**
 * Pure evaluation: did at least one connector-smoke cell actually run? `ran` counts
 * non-pending (passed|failed) tests; `skipped` is pending (describe.skip cells).
 */
export function evaluateConnectorSmokeRun(result: VitestJsonResult): ConnectorSmokeRunVerdict {
  const passed = result.numPassedTests ?? 0;
  const failed = result.numFailedTests ?? 0;
  const skipped = result.numPendingTests ?? 0;
  const ran = passed + failed;
  if (ran === 0) {
    return {
      ran,
      skipped,
      ok: false,
      message:
        `Connector-smoke run produced 0 cells that actually ran. You invoked the connector-smoke ` +
        `tier explicitly (npm run test:connectors:smoke) but every cell skipped — almost certainly ` +
        `because no connector is connected on this machine (no stored token file / key env var ` +
        `present). Connect at least one connector in the desktop app (Slack/Google etc.), then ` +
        `re-run. Failing loud so an explicit run is never a silent credless green. (In ` +
        `automation/CI the credless skip is intentionally green; this guard is only on the ` +
        `explicit operator entrypoint.)`,
    };
  }
  return {
    ran,
    skipped,
    ok: true,
    message: `Connector-smoke run: ${ran} cell(s) ran, ${skipped} skipped.`,
  };
}

function main(): void {
  const resultPath = process.argv[2];
  if (!resultPath) {
    console.error('[check-connector-smoke-ran] usage: check-connector-smoke-ran.ts <vitest-json-result-file>');
    process.exit(2);
  }
  if (!fs.existsSync(resultPath)) {
    console.error(
      `[check-connector-smoke-ran] result file not found: ${resultPath}. The vitest run did not ` +
        `produce a JSON report — treat as a run failure.`,
    );
    process.exit(1);
  }
  let parsed: VitestJsonResult;
  try {
    parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as VitestJsonResult;
  } catch (error) {
    console.error(
      `[check-connector-smoke-ran] could not parse ${resultPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  const verdict = evaluateConnectorSmokeRun(parsed);
  if (!verdict.ok) {
    console.error(`[check-connector-smoke-ran] ${verdict.message}`);
    process.exit(1);
  }
  console.log(`[check-connector-smoke-ran] ${verdict.message}`);
}

// Run only as a CLI, not when imported by the unit test.
if (process.argv[1] && process.argv[1].endsWith('check-connector-smoke-ran.ts')) {
  main();
}
