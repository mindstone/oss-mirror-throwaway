#!/usr/bin/env npx tsx
/**
 * Explicit-run guard for the live-API tier: fail loud when an *operator* asked
 * for live tests but zero cells actually ran.
 *
 * Why this exists
 * ---------------
 * The live-API harness (`src/test-utils/liveApiHarness.ts`) skips — never fails —
 * a cell whose key is missing. That "keyless = green" invariant is load-bearing
 * for *automation*: a cron/CI run with no secrets configured is a clean no-op, by
 * construction. But on an *explicit* run (`npm run test:live`), a green no-op is
 * the wrong outcome — if you asked for live tests you want to learn your keys are
 * missing, not see a silent pass. Skip-vs-fail is therefore an *entrypoint policy*,
 * not something the per-cell harness should decide (which is why this lives here
 * and not in the harness).
 *
 * What it checks
 * --------------
 * Reads a Vitest JSON result file and counts NON-PENDING tests (passed + failed).
 * If zero ran, it exits 1 — the operator-facing equivalent of `live-eval.yml`'s
 * aggregate anti-rot backstop. It deliberately does NOT require every provider's
 * key: a single-provider-key run (only `TEST_ANTHROPIC_API_KEY` set, say) still
 * runs the anthropic cells, so `ran > 0` and the guard passes — the absent
 * providers skip legitimately, exactly as in CI.
 *
 * Wired into: the `test:live` npm script (runs after vitest writes its JSON file).
 */
import fs from 'node:fs';

/** The subset of the Vitest JSON reporter shape this guard reads. */
export interface VitestJsonResult {
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
}

export interface LiveApiRunVerdict {
  ran: number;
  skipped: number;
  ok: boolean;
  message: string;
}

/**
 * Pure evaluation: did at least one live cell actually run? `ran` counts
 * non-pending (passed|failed) tests; `skipped` is pending (describe.skip cells).
 */
export function evaluateLiveApiRun(result: VitestJsonResult): LiveApiRunVerdict {
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
        `Live-API run produced 0 cells that actually ran. You invoked the live tier explicitly ` +
        `(npm run test:live) but every cell skipped — almost certainly because no TEST_*_API_KEY ` +
        `is set. Capture keys with \`npm run capture-live-api-keys -- --apply\` (merges into the gitignored ` +
        `.env.test; hand-maintained lines survive; providers with no API key in app settings — e.g. ` +
        `OAuth-auth Anthropic — fall back to evals/configs/.local/keys.env automatically), then re-run. ` +
        `Failing loud so an explicit run is never a silent keyless green. ` +
        `(In automation/CI the keyless skip is intentionally green; this guard is only on the ` +
        `explicit operator entrypoint.)`,
    };
  }
  return {
    ran,
    skipped,
    ok: true,
    message: `Live-API run: ${ran} cell(s) ran, ${skipped} skipped.`,
  };
}

function main(): void {
  const resultPath = process.argv[2];
  if (!resultPath) {
    console.error('[check-live-api-ran] usage: check-live-api-ran.ts <vitest-json-result-file>');
    process.exit(2);
  }
  if (!fs.existsSync(resultPath)) {
    console.error(
      `[check-live-api-ran] result file not found: ${resultPath}. The vitest run did not ` +
        `produce a JSON report — treat as a run failure.`,
    );
    process.exit(1);
  }
  let parsed: VitestJsonResult;
  try {
    parsed = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as VitestJsonResult;
  } catch (error) {
    console.error(
      `[check-live-api-ran] could not parse ${resultPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  const verdict = evaluateLiveApiRun(parsed);
  if (!verdict.ok) {
    console.error(`[check-live-api-ran] ${verdict.message}`);
    process.exit(1);
  }
  console.log(`[check-live-api-ran] ${verdict.message}`);
}

// Run only as a CLI, not when imported by the unit test.
if (process.argv[1] && process.argv[1].endsWith('check-live-api-ran.ts')) {
  main();
}
