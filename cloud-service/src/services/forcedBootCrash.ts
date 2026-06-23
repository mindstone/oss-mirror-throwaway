/**
 * Forced Boot Crash (Regression Fixture)
 *
 * Test-only mechanism that simulates the exact failure mode that bricked
 * dev-37738d9 in production: a cloud-service boot reaches `server.listen`,
 * prints the listen log, then dies before the 30s boot-success grace
 * expires, leaving `bootPending=true` on disk for the NEXT boot's
 * pre-bootstrap watchdog to detect.
 *
 * Gated by BOTH `REBEL_FORCE_BOOT_CRASH=1` AND `IS_CI_SMOKE_TEST=1` so it
 * cannot accidentally fire in production. The CI smoke-and-rollback test
 * (Stage A2 of docs/plans/260510_cloud_image_rollback_defense_in_depth.md)
 * runs two containers back-to-back against the same volume mount:
 *   1) first run with these envs set → bootstrap finishes, listen log
 *      fires, crash happens 100ms later.
 *   2) second run without REBEL_FORCE_BOOT_CRASH → watchdog detects the
 *      stuck bootPending and rolls back via mocked Fly API.
 *
 * 100ms is chosen so the listen log is reliably visible (per the
 * 222189772 fix — `console.error` writes synchronously to stderr, captured
 * by Fly logs) while staying well inside the 30s grace.
 *
 * Stage C3 of docs/plans/260510_cloud_image_rollback_defense_in_depth.md.
 */

export const FORCED_BOOT_CRASH_DELAY_MS = 100;
export const FORCED_BOOT_CRASH_MESSAGE =
  '[fatal] REBEL_FORCE_BOOT_CRASH triggered (regression-fixture)';

export interface ForcedBootCrashDeps {
  env?: NodeJS.ProcessEnv;
  schedule?: (cb: () => void, ms: number) => unknown;
  errorOutput?: (line: string) => void;
  exit?: (code: number) => never;
}

/**
 * Returns `true` if the forced-crash branch was armed (envs match), `false`
 * otherwise. Callers in production code should ignore the return value;
 * tests use it to assert the gating logic.
 */
export function maybeInstallForcedBootCrash(deps: ForcedBootCrashDeps = {}): boolean {
  const env = deps.env ?? process.env;
  if (env.REBEL_FORCE_BOOT_CRASH !== '1' || env.IS_CI_SMOKE_TEST !== '1') {
    return false;
  }
  const schedule = deps.schedule ?? setTimeout;
  const errorOutput = deps.errorOutput ?? ((line: string) => console.error(line));
  const exitImpl = deps.exit ?? ((code: number) => process.exit(code));

  schedule(() => {
    errorOutput(FORCED_BOOT_CRASH_MESSAGE);
    exitImpl(1);
  }, FORCED_BOOT_CRASH_DELAY_MS);

  return true;
}
