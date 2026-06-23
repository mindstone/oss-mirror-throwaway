/**
 * Headless-CLI launch detection (platform-agnostic).
 *
 * "Running as the headless CLI" — true when either:
 *  - the standalone `rebel` binary set `REBEL_HEADLESS_CLI=1`
 *    (see `scripts/rebel-cli/platformInit.ts`), or
 *  - the packaged `.app` binary was invoked with the bare `--headless-cli` flag
 *    (see `src/core/cli/runCli.ts`).
 *
 * This is pure `process.env` / `process.argv` logic with no platform dependencies,
 * so it lives in core and is the SINGLE definition shared across desktop, cloud, and
 * CLI surfaces. Main-side callers import it via `src/main/utils/testIsolation.ts`
 * (which re-exports it); core callers import it from here directly.
 *
 * The former Electron `app.commandLine.hasSwitch('headless-cli')` "belt" was retired:
 * env+argv covers every real launch path, and the only input it differed on
 * (`--headless-cli=value`) never actually enters CLI mode (see `runCli.ts`), so the
 * belt only preserved an inconsistent half-state. The `no-raw-headless-check` ESLint
 * rule keeps this the only definition — re-inline a raw check and CI fails.
 */
export function isHeadlessCli(): boolean {
  return process.env.REBEL_HEADLESS_CLI === '1' || process.argv.includes('--headless-cli');
}
