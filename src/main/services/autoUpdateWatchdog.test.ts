import { spawn as childSpawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWatchdogScript } from './autoUpdateService';

const STABLE_EXE = '/Applications/Mindstone Rebel.app/Contents/MacOS/Mindstone Rebel';
const STABLE_BUNDLE = '/Applications/Mindstone Rebel.app';
const BETA_EXE = '/Applications/Mindstone Rebel Beta.app/Contents/MacOS/Mindstone Rebel Beta';
const BETA_BUNDLE = '/Applications/Mindstone Rebel Beta.app';
const TELEMETRY = '/tmp/auto-update-watchdog-telemetry.json';
const EXPECTED_VERSION = '0.4.33';

describe('buildWatchdogScript', () => {
  it('waits for the old PID to exit before doing anything else', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    expect(script).toContain('kill -0 12345');
    expect(script).toContain('WAITED=0');
    expect(script).toContain('WAITED=$((WAITED + 1))');
  });

  it('caps the old-PID wait at 120 seconds', () => {
    const script = buildWatchdogScript(99999, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    expect(script).toMatch(/\$WAITED -ge 120/);
    expect(script).toMatch(/break/);
  });

  it('waits for the ShipIt daemon to exit (polls pgrep -x ShipIt, capped at 90s)', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    // ShipIt is a short, stable process name so pgrep -x is safe.
    expect(script).toContain('pgrep -x ShipIt');
    expect(script).toContain('SHIPIT_WAITED=0');
    expect(script).toMatch(/\$SHIPIT_WAITED -ge 90/);
  });

  it('includes a small settling buffer after ShipIt exits (LaunchServices registration)', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    const shipItDoneIdx = script.indexOf('pgrep -x ShipIt');
    expect(shipItDoneIdx).toBeGreaterThan(-1);
    const settleIdx = script.indexOf('sleep 3', shipItDoneIdx);
    expect(settleIdx).toBeGreaterThan(shipItDoneIdx);
  });

  it('matches the running app by full exe path (not truncated pgrep -x) and filters self', () => {
    const script = buildWatchdogScript(12345, BETA_EXE, BETA_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    // pgrep -f against the full Contents/MacOS exe path avoids the Darwin p_comm
    // 16-char truncation that broke `pgrep -x 'Mindstone Rebel Beta'` (20 chars).
    expect(script).toContain(`pgrep -f '${BETA_EXE}'`);
    // Watchdog shell's own argv contains the pattern too, so self-exclude via $$.
    expect(script).toMatch(/grep -v "\^\$\$\\\$"/);
  });

  it('always fires open regardless of on-disk version comparison (C1 critique)', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    // open runs only inside the `if [ $ALREADY_RUNNING -eq 0 ]` branch — there
    // must be exactly ONE such branch and it must contain `open`. The Phase 4.5
    // version-check must NOT gate Phase 5 (the C1 fix).
    expect(script).toContain('if [ $ALREADY_RUNNING -eq 0 ]');
    expect(script).toContain(`open '${STABLE_BUNDLE}'`);
    // Defensive: there is no INSTALL_FAILED_BUNDLE_VERSION_UNCHANGED gate around
    // the open call.
    const openLineIdx = script.indexOf(`open '${STABLE_BUNDLE}'`);
    const phaseFourFiveIdx = script.indexOf('INSTALL_FAILED_BUNDLE_VERSION_UNCHANGED');
    expect(phaseFourFiveIdx).toBeLessThan(openLineIdx);
    // The open invocation is gated only by ALREADY_RUNNING, not by the
    // version-check flag. Search backwards from the open line to the nearest
    // `if [` and confirm it gates on ALREADY_RUNNING.
    const openContextStart = script.lastIndexOf('if [', openLineIdx);
    const openContext = script.substring(openContextStart, openLineIdx);
    expect(openContext).toContain('ALREADY_RUNNING');
    expect(openContext).not.toContain('INSTALL_FAILED_BUNDLE_VERSION_UNCHANGED');
  });

  it('does NOT contain the old broken pgrep -x <appName> pattern', () => {
    const script = buildWatchdogScript(12345, BETA_EXE, BETA_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    // Old implementation used bare `pgrep -x 'Mindstone Rebel Beta'` which never
    // matched due to Darwin p_comm truncation.
    expect(script).not.toMatch(/pgrep -x '.*Mindstone.*'/);
  });

  it('does NOT contain fixed sleep 15 (old broken pattern)', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    expect(script).not.toMatch(/\bsleep 15\b/);
    // We should also not be using the previous fixed 5s ShipIt grace.
    expect(script).not.toMatch(/^sleep 5\b/);
  });

  it('writes an atomic telemetry JSON file (tmp + mv) to the provided path', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    // printf builds JSON from the collected flags, writes to .tmp, then atomically
    // renames into place so a crash mid-write can't leave a half-written file.
    expect(script).toContain(`'${TELEMETRY}.tmp'`);
    expect(script).toContain(`mv '${TELEMETRY}.tmp' '${TELEMETRY}'`);
    // All expected telemetry keys must be present in the printf format string.
    expect(script).toContain('"ranAt":%s');
    expect(script).toContain('"oldPid":%s');
    expect(script).toContain('"oldPidWaitSec":%s');
    expect(script).toContain('"shipItWaitSec":%s');
    expect(script).toContain('"appAlreadyRunning":%s');
    expect(script).toContain('"openFired":%s');
    expect(script).toContain('"externalForceKillSignal":"%s"');
    expect(script).toContain('"externalForceKillGuardOutcome":"%s"');
  });

  it('passes pre-escaped strings through without re-escaping', () => {
    // spawnRelaunchWatchdog is responsible for shell-escaping single quotes before
    // calling buildWatchdogScript. Verify escaped input survives verbatim.
    const escExe = `/Applications/App'\\''Name.app/Contents/MacOS/App'\\''Name`;
    const escBundle = `/Applications/App'\\''Name.app`;
    const escTelemetry = `/tmp/App'\\''Name-telemetry.json`;
    const script = buildWatchdogScript(12345, escExe, escBundle, escTelemetry, EXPECTED_VERSION);

    expect(script).toContain(`pgrep -f '${escExe}'`);
    expect(script).toContain(`open '${escBundle}'`);
    expect(script).toContain(`'${escTelemetry}'`);
  });

  it('produces valid POSIX shell syntax (sh -n)', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    // `sh -n` does syntax-only parsing; no side effects, so this is safe to run in tests.
    const result = spawnSync('/bin/sh', ['-n', '-c', script], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('handles both stable and beta app paths', () => {
    const stable = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);
    const beta = buildWatchdogScript(12345, BETA_EXE, BETA_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    expect(stable).toContain(`pgrep -f '${STABLE_EXE}'`);
    expect(stable).toContain(`open '${STABLE_BUNDLE}'`);
    expect(beta).toContain(`pgrep -f '${BETA_EXE}'`);
    expect(beta).toContain(`open '${BETA_BUNDLE}'`);
  });
});

// ============================================================================
// Out-of-process force-kill escalation (260622) — pure-function assertions
// ============================================================================

describe('buildWatchdogScript — Phase-1 force-kill escalation (260622)', () => {
  it('escalates to SIGTERM then SIGKILL of the wedged old PID inside the wait loop', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    expect(script).toContain('kill -TERM 12345');
    expect(script).toContain('kill -KILL 12345');
    // The kill lives inside the existing Phase-1 wait loop (it must run BEFORE
    // the 120s cap so Phase 5 `open` still fires afterwards).
    const loopStart = script.indexOf('while kill -0 12345');
    const loopEnd = script.indexOf('\ndone', loopStart);
    const termIdx = script.indexOf('kill -TERM 12345');
    const killIdx = script.indexOf('kill -KILL 12345');
    expect(loopStart).toBeGreaterThan(-1);
    expect(termIdx).toBeGreaterThan(loopStart);
    expect(termIdx).toBeLessThan(loopEnd);
    expect(killIdx).toBeGreaterThan(loopStart);
    expect(killIdx).toBeLessThan(loopEnd);
  });

  it('uses the default SIGTERM @30s / SIGKILL @60s budget, inside the 120s cap', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    expect(script).toMatch(/\$WAITED -ge 30 \] && \[ "\$EXTERNAL_FORCE_KILL_SIGNAL" = none/);
    expect(script).toMatch(/\$WAITED -ge 60 \] && \[ "\$EXTERNAL_FORCE_KILL_SIGNAL" = TERM/);
    expect(script).toContain('if [ $WAITED -ge 120 ]; then break; fi');
  });

  it('accepts injectable SIGTERM/SIGKILL budgets (for fast tests)', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION, 1, 2);

    expect(script).toMatch(/\$WAITED -ge 1 \] && \[ "\$EXTERNAL_FORCE_KILL_SIGNAL" = none/);
    expect(script).toMatch(/\$WAITED -ge 2 \] && \[ "\$EXTERNAL_FORCE_KILL_SIGNAL" = TERM/);
  });

  it('guards against PID reuse via `ps -p ... -o command=` + a PREFIX match (NOT comm=, NOT substring)', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    expect(script).toContain('ps -p 12345 -o command=');
    // PREFIX match via POSIX `case`: the single-quoted exe path matches
    // literally (glob metachars disabled) and is anchored to the START of the
    // argv by an unquoted trailing `*`. A bare substring `grep -F` would have
    // wrongly matched a recycled PID whose argv merely CONTAINS the exe path.
    expect(script).toContain(`case "$KILL_TARGET_CMD" in`);
    expect(script).toContain(`'${STABLE_EXE}'*)`);
    expect(script).not.toContain(`grep -F '${STABLE_EXE}'`);
    // Darwin's truncated `comm` field must NOT be used as the identity basis.
    expect(script).not.toContain('-o comm=');
    // The guard is re-checked before BOTH signals (TOCTOU): two `ps` reads,
    // each followed by its own `case` block.
    const psMatches = script.match(/ps -p 12345 -o command=/g) ?? [];
    expect(psMatches.length).toBe(2);
    const caseMatches = script.match(/case "\$KILL_TARGET_CMD" in/g) ?? [];
    expect(caseMatches.length).toBe(2);
  });

  it('carries EXTERNAL_FORCE_KILL_SIGNAL and a guard-outcome state var out of the loop', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    expect(script).toContain('EXTERNAL_FORCE_KILL_SIGNAL=none');
    expect(script).toContain('EXTERNAL_FORCE_KILL_SIGNAL=TERM');
    expect(script).toContain('EXTERNAL_FORCE_KILL_SIGNAL=KILL');
    expect(script).toContain('EXTERNAL_FORCE_KILL_GUARD=na');
    expect(script).toContain('EXTERNAL_FORCE_KILL_GUARD=identityMatched');
    expect(script).toContain('EXTERNAL_FORCE_KILL_GUARD=identityMismatch');
  });

  it('emits the force-kill telemetry fields in BOTH printf branches (Stage 2 + legacy)', () => {
    const stage2 = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);
    expect(stage2).toContain('"externalForceKillSignal":"%s"');
    expect(stage2).toContain('"externalForceKillGuardOutcome":"%s"');

    vi.stubEnv('REBEL_DISABLE_WATCHDOG_VERSION_CHECK', '1');
    try {
      const legacy = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);
      // Legacy branch omits the Phase 4.5 fields but the kill lives in shared
      // Phase 1, so the force-kill fields MUST still be present.
      expect(legacy).not.toContain('"installFailedBundleVersionUnchanged":');
      expect(legacy).toContain('"externalForceKillSignal":"%s"');
      expect(legacy).toContain('"externalForceKillGuardOutcome":"%s"');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('produces valid POSIX shell syntax with the kill escalation (sh -n)', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION, 1, 2);
    const result = spawnSync('/bin/sh', ['-n', '-c', script], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

// ============================================================================
// Stage 2 (install completion contract) — Phase 4.5 version-check tests
// ============================================================================

describe('buildWatchdogScript — Phase 4.5 (Stage 2) version-check', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads on-disk version via plutil with trailing-newline stripping (C6)', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    // plutil -extract … raw -o - emits a trailing newline; without `tr -d '\n'`
    // the equality test below silently always fails on the success path.
    expect(script).toContain('plutil -extract CFBundleShortVersionString raw -o -');
    expect(script).toContain(`'${STABLE_BUNDLE}/Contents/Info.plist'`);
    expect(script).toContain("| tr -d '\\n'");
  });

  it('captures plutil into ON_DISK_VERSION and compares against the expected from-version', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    expect(script).toContain('ON_DISK_VERSION=$(');
    expect(script).toContain(`if [ "$ON_DISK_VERSION" = '${EXPECTED_VERSION}' ]; then`);
    expect(script).toContain('INSTALL_FAILED_BUNDLE_VERSION_UNCHANGED=1');
  });

  it('falls back to ON_DISK_VERSION="unknown" when plutil produced no output', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    expect(script).toContain('ON_DISK_VERSION_KNOWN=0');
    expect(script).toContain('ON_DISK_VERSION="unknown"');
  });

  it('emits the new telemetry fields in the printf format string', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    expect(script).toContain('"installFailedBundleVersionUnchanged":%s');
    expect(script).toContain('"onDiskVersion":"%s"');
    expect(script).toContain('INSTALL_FAILED_BUNDLE_VERSION_UNCHANGED_JSON=false');
    expect(script).toContain('INSTALL_FAILED_BUNDLE_VERSION_UNCHANGED_JSON=true');
  });

  it('shell-escapes the expected from-version into single-quoted comparison', () => {
    // Contrived value with a single quote (paranoid case — versions don't
    // contain quotes in practice, but the call site shell-escapes anyway).
    const escapedTrickyVersion = `0.4.33'\\''b1`;
    const script = buildWatchdogScript(
      12345,
      STABLE_EXE,
      STABLE_BUNDLE,
      TELEMETRY,
      escapedTrickyVersion,
    );

    expect(script).toContain(`if [ "$ON_DISK_VERSION" = '${escapedTrickyVersion}' ]; then`);

    // Most importantly: the script still parses cleanly under sh -n.
    const result = spawnSync('/bin/sh', ['-n', '-c', script], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('handles a bundle path with spaces (sh -n passes)', () => {
    const script = buildWatchdogScript(12345, BETA_EXE, BETA_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    // BETA_BUNDLE is "/Applications/Mindstone Rebel Beta.app" which contains
    // spaces — the single-quoted embedding in plutil and open invocations must
    // produce a script that passes sh -n.
    expect(script).toContain(`'${BETA_BUNDLE}/Contents/Info.plist'`);
    expect(script).toContain(`open '${BETA_BUNDLE}'`);

    const result = spawnSync('/bin/sh', ['-n', '-c', script], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('Phase 4.5 still parses cleanly under sh -n', () => {
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    const result = spawnSync('/bin/sh', ['-n', '-c', script], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('honours REBEL_DISABLE_WATCHDOG_VERSION_CHECK kill-switch (I17)', () => {
    vi.stubEnv('REBEL_DISABLE_WATCHDOG_VERSION_CHECK', '1');
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    // With the kill-switch set, Phase 4.5 must be omitted entirely and the
    // legacy 6-field telemetry payload generated.
    expect(script).not.toContain('plutil');
    expect(script).not.toContain('ON_DISK_VERSION');
    expect(script).not.toContain('INSTALL_FAILED_BUNDLE_VERSION_UNCHANGED');
    expect(script).not.toContain('"installFailedBundleVersionUnchanged":');
    expect(script).not.toContain('"onDiskVersion":');

    // Legacy script still passes sh -n.
    const result = spawnSync('/bin/sh', ['-n', '-c', script], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    // Open must still fire (this never changed).
    expect(script).toContain(`open '${STABLE_BUNDLE}'`);
  });
});

// ============================================================================
// Shell-contract test — execute the generated script with fake shims
// ============================================================================

interface ShimSpec {
  /** plutil exit code (0 = success, non-zero = failure-on-extract). */
  plutilExit: number;
  /** plutil stdout (pre-tr; the script applies `tr -d '\n'` itself). */
  plutilStdout: string;
}

interface ShellContractRun {
  exitCode: number | null;
  stderr: string;
  telemetryRaw: string;
  telemetryParsed: Record<string, unknown>;
  openCallCount: number;
}

/**
 * Run buildWatchdogScript()'s output against a sandbox of fake shims so we can
 * assert end-to-end that:
 *   - the right telemetry JSON is written for each branch,
 *   - `open` is called exactly once on every code path (the C1 invariant), and
 *   - the script exits cleanly.
 *
 * We use a deliberately non-existent oldPid so the Phase 1 wait loop's
 * `kill -0` returns non-zero on first iteration and the loop exits immediately.
 * `kill` is a /bin/sh builtin so it can't be PATH-shimmed; relying on
 * "PID doesn't exist" is the standard way to skip the wait loop in tests.
 */
function runWatchdogScript(spec: ShimSpec, expectedFromVersion: string): ShellContractRun {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-shim-'));
  try {
    const binDir = path.join(tempDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    const openLog = path.join(tempDir, 'open.log');
    const telemetry = path.join(tempDir, 'telemetry.json');

    // pgrep — both invocations must succeed-with-no-match so the script
    // proceeds to Phase 5 and `open` fires.
    //   1. `pgrep -x ShipIt > /dev/null 2>&1` — ShipIt not running → exit 1
    //   2. `pgrep -f <exe> 2>/dev/null` — app not running → exit 1
    fs.writeFileSync(path.join(binDir, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    // plutil — write the configured stdout/exit code. Mimic real plutil's
    // trailing newline behaviour: print stdout WITH a newline so the script's
    // `tr -d '\n'` is exercised.
    const plutilScript = [
      '#!/bin/sh',
      `printf '%s\\n' '${spec.plutilStdout.replace(/'/g, `'\\''`)}'`,
      `exit ${spec.plutilExit}`,
    ].join('\n');
    fs.writeFileSync(path.join(binDir, 'plutil'), plutilScript, { mode: 0o755 });

    // open — record each invocation to a log file so we can count calls.
    const openScript = [
      '#!/bin/sh',
      `printf 'open %s\\n' "$@" >> '${openLog}'`,
      'exit 0',
    ].join('\n');
    fs.writeFileSync(path.join(binDir, 'open'), openScript, { mode: 0o755 });

    // sleep — make it a no-op so tests don't actually sleep 3s + ShipIt poll.
    fs.writeFileSync(path.join(binDir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    // Build the script. Use a non-existent PID so `kill -0` exits non-zero
    // immediately and the Phase 1 wait loop exits on first iteration.
    const NON_EXISTENT_PID = 99_999_999;
    const escapeShellSingleQuote = (s: string) => s.replace(/'/g, "'\\''");
    const script = buildWatchdogScript(
      NON_EXISTENT_PID,
      escapeShellSingleQuote(STABLE_EXE),
      escapeShellSingleQuote(STABLE_BUNDLE),
      escapeShellSingleQuote(telemetry),
      escapeShellSingleQuote(expectedFromVersion),
    );

    const result = spawnSync('/bin/sh', ['-c', script], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });

    const telemetryRaw = fs.existsSync(telemetry) ? fs.readFileSync(telemetry, 'utf8') : '';
    const telemetryParsed = telemetryRaw ? JSON.parse(telemetryRaw) : {};

    const openLogContent = fs.existsSync(openLog) ? fs.readFileSync(openLog, 'utf8') : '';
    const openCallCount = openLogContent
      ? openLogContent.split('\n').filter((line) => line.startsWith('open ')).length
      : 0;

    return {
      exitCode: result.status,
      stderr: result.stderr ?? '',
      telemetryRaw,
      telemetryParsed: telemetryParsed as Record<string, unknown>,
      openCallCount,
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

describe('buildWatchdogScript — shell-contract (executes the generated script)', () => {
  it('matched on-disk version: telemetry records installFailedBundleVersionUnchanged=true and STILL fires open (C1)', () => {
    const run = runWatchdogScript(
      { plutilExit: 0, plutilStdout: EXPECTED_VERSION },
      EXPECTED_VERSION,
    );

    expect(run.exitCode).toBe(0);
    expect(run.telemetryParsed.installFailedBundleVersionUnchanged).toBe(true);
    expect(run.telemetryParsed.onDiskVersion).toBe(EXPECTED_VERSION);
    expect(run.telemetryParsed.openFired).toBe(true);
    expect(run.openCallCount).toBe(1);
  });

  it('mismatched on-disk version: telemetry records installFailedBundleVersionUnchanged=false and fires open', () => {
    const run = runWatchdogScript(
      { plutilExit: 0, plutilStdout: '0.4.34' },
      EXPECTED_VERSION,
    );

    expect(run.exitCode).toBe(0);
    expect(run.telemetryParsed.installFailedBundleVersionUnchanged).toBe(false);
    expect(run.telemetryParsed.onDiskVersion).toBe('0.4.34');
    expect(run.telemetryParsed.openFired).toBe(true);
    expect(run.openCallCount).toBe(1);
  });

  it('plutil non-zero exit: telemetry records onDiskVersion="unknown" and fires open', () => {
    const run = runWatchdogScript(
      { plutilExit: 1, plutilStdout: '' },
      EXPECTED_VERSION,
    );

    expect(run.exitCode).toBe(0);
    expect(run.telemetryParsed.installFailedBundleVersionUnchanged).toBe(false);
    expect(run.telemetryParsed.onDiskVersion).toBe('unknown');
    expect(run.telemetryParsed.openFired).toBe(true);
    expect(run.openCallCount).toBe(1);
  });

  it('plutil empty output (exit 0): treated as unknown and fires open', () => {
    const run = runWatchdogScript(
      { plutilExit: 0, plutilStdout: '' },
      EXPECTED_VERSION,
    );

    expect(run.exitCode).toBe(0);
    expect(run.telemetryParsed.installFailedBundleVersionUnchanged).toBe(false);
    expect(run.telemetryParsed.onDiskVersion).toBe('unknown');
    expect(run.telemetryParsed.openFired).toBe(true);
    expect(run.openCallCount).toBe(1);
  });

  it("trailing-newline correctness: plutil's mandatory '\\n' is stripped before comparison (C6)", () => {
    // The plutil shim ALREADY appends a newline (mimicking real plutil). If the
    // script's `tr -d '\n'` is missing, the comparison "0.4.33\n" = "0.4.33"
    // evaluates false and installFailedBundleVersionUnchanged stays 0.
    // This test will catch that regression because the matched-version test
    // above relies on the comparison succeeding.
    const run = runWatchdogScript(
      { plutilExit: 0, plutilStdout: EXPECTED_VERSION },
      EXPECTED_VERSION,
    );

    expect(run.telemetryParsed.installFailedBundleVersionUnchanged).toBe(true);
  });
});

// ============================================================================
// Out-of-process force-kill escalation (260622) — behavioral harness
// ============================================================================

interface KillContractRun {
  exitCode: number | null;
  stderr: string;
  telemetryParsed: Record<string, unknown>;
  /** Whether the spawned target child was still alive after the script ran. */
  targetAlive: boolean;
}

/**
 * Run buildWatchdogScript() against a REAL long-lived child process so we can
 * assert the Phase-1 force-kill escalation actually terminates a wedged PID
 * (and refuses to, when the PID-identity guard fails).
 *
 * Unlike `runWatchdogScript`, this:
 *   - spawns a real `sleep 600` child and points the watchdog at its PID,
 *   - uses a TINY injected budget (SIGTERM @1s, SIGKILL @2s) so the test is
 *     fast and bounded,
 *   - shims `ps` (the identity guard) to report either the matching exe path
 *     or a non-matching one,
 *   - does NOT shim `sleep` (the loop must really iterate ~1s/tick),
 *   - shims `pgrep`/`open`/`plutil` exactly like the no-op harness.
 *
 * `psReportsExe` controls the identity guard: when the matching exe path, the
 * guard passes and the kill fires; otherwise the guard refuses and the child
 * survives.
 */
function runKillEscalationScript(opts: {
  psReportsExe: string;
}): KillContractRun {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-kill-'));
  const child = childSpawn('sleep', ['600'], { stdio: 'ignore' });
  const targetPid = child.pid;
  if (targetPid == null) throw new Error('failed to spawn target child');
  try {
    const binDir = path.join(tempDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    const telemetry = path.join(tempDir, 'telemetry.json');
    const openLog = path.join(tempDir, 'open.log');

    // pgrep — both invocations succeed-with-no-match so the script proceeds.
    fs.writeFileSync(path.join(binDir, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    // plutil — version mismatch (so installFailedBundleVersionUnchanged=false),
    // irrelevant to the kill path but keeps the script well-formed.
    fs.writeFileSync(
      path.join(binDir, 'plutil'),
      "#!/bin/sh\nprintf '%s\\n' '9.9.9'\nexit 0\n",
      { mode: 0o755 },
    );

    // open — no-op (relaunch is irrelevant; the target child is the focus).
    fs.writeFileSync(
      path.join(binDir, 'open'),
      `#!/bin/sh\nprintf 'open %s\\n' "$@" >> '${openLog}'\nexit 0\n`,
      { mode: 0o755 },
    );

    // ps — the identity guard. Echo the configured exe path (matching or not)
    // for `ps -p <pid> -o command=`. The script greps -F the real exe path
    // against this output.
    const psScript = [
      '#!/bin/sh',
      `printf '%s\\n' '${opts.psReportsExe.replace(/'/g, `'\\''`)}'`,
      'exit 0',
    ].join('\n');
    fs.writeFileSync(path.join(binDir, 'ps'), psScript, { mode: 0o755 });

    const escapeShellSingleQuote = (s: string) => s.replace(/'/g, "'\\''");
    // Tiny budget: SIGTERM @1s, SIGKILL @2s. The 120s ShipIt cap etc. are
    // skipped because pgrep returns immediately; only the Phase-1 loop runs
    // against the live target.
    const script = buildWatchdogScript(
      targetPid,
      escapeShellSingleQuote(STABLE_EXE),
      escapeShellSingleQuote(STABLE_BUNDLE),
      escapeShellSingleQuote(telemetry),
      escapeShellSingleQuote(EXPECTED_VERSION),
      1,
      2,
      // Tiny safety cap so the identity-MISMATCH case (immortal child never
      // dies) breaks out of the loop in ~4s instead of 120s.
      4,
    );

    const result = spawnSync('/bin/sh', ['-c', script], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
      timeout: 30_000,
    });

    // Is the target still alive?
    //
    // We deliberately do NOT use `kill -0 <pid>`. In this test the target is a
    // direct child of the Node/vitest process, and Node does not reap it
    // synchronously after the watchdog kills it — so it lingers as a ZOMBIE
    // (defunct) until Node's SIGCHLD handler runs. `kill -0 <zombie-pid>` still
    // returns success (status 0), because the PID is allocated to a reaped-able
    // entry; that would fool us into reporting the child as "alive" even though
    // the kill succeeded.
    //
    // In PRODUCTION this distinction never bites: the old app is a child of
    // launchd, which reaps it instantly on death, so `kill -0` correctly fails
    // and the watchdog's own loop sees it gone. The zombie only exists here
    // because vitest is the reaper and hasn't run yet.
    //
    // So we ask `ps` for the process STATE instead and treat a missing process
    // OR a state beginning with `Z` (zombie/defunct) as dead. We invoke ps via
    // an absolute path so the shimmed `ps` on the watchdog's PATH (the identity
    // guard) cannot intercept this probe.
    //   NOTE: do not "simplify" this back to `kill -0` — see above.
    const psBin = fs.existsSync('/bin/ps') ? '/bin/ps' : 'ps';
    const probe = spawnSync(psBin, ['-p', String(targetPid), '-o', 'state='], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin' },
    });
    const state = (probe.stdout ?? '').trim();
    const targetAlive = state.length > 0 && !state.startsWith('Z');

    const telemetryRaw = fs.existsSync(telemetry) ? fs.readFileSync(telemetry, 'utf8') : '';
    const telemetryParsed = telemetryRaw ? JSON.parse(telemetryRaw) : {};

    return {
      exitCode: result.status,
      stderr: result.stderr ?? '',
      telemetryParsed: telemetryParsed as Record<string, unknown>,
      targetAlive,
    };
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

describe('buildWatchdogScript — force-kill escalation behavioral (260622)', () => {
  it('KILLS a live matching child within budget and records the signal', () => {
    // ps reports the matching exe path → identity guard passes → kill fires.
    const run = runKillEscalationScript({ psReportsExe: STABLE_EXE });

    expect(run.targetAlive).toBe(false);
    // The strongest signal reached: TERM at 1s, escalating to KILL at 2s (a
    // bare `sleep` ignores SIGTERM-via-this-path only if it survives; in
    // practice TERM kills `sleep`, so accept either TERM or KILL).
    expect(['TERM', 'KILL']).toContain(run.telemetryParsed.externalForceKillSignal);
    expect(run.telemetryParsed.externalForceKillGuardOutcome).toBe('identityMatched');
  });

  it('does NOT kill a child whose PID identity does not match (PID-reuse safety)', () => {
    // ps reports a DIFFERENT path → identity guard refuses → child survives.
    const run = runKillEscalationScript({
      psReportsExe: '/usr/bin/some-other-unrelated-process',
    });

    expect(run.targetAlive).toBe(true);
    expect(run.telemetryParsed.externalForceKillSignal).toBe('none');
    expect(run.telemetryParsed.externalForceKillGuardOutcome).toBe('identityMismatch');
  });

  it('does NOT kill when the exe path is a NON-prefix substring of the argv (F1 prefix-hardening)', () => {
    // A recycled PID running e.g. a wrapper that takes our exe path as an
    // ARGUMENT: the argv CONTAINS the exe path but does not START with it. The
    // old `grep -F` substring guard would have wrongly matched and killed it;
    // the `case` prefix guard must refuse.
    const run = runKillEscalationScript({
      psReportsExe: `/usr/bin/wrapper ${STABLE_EXE}`,
    });

    expect(run.targetAlive).toBe(true);
    expect(run.telemetryParsed.externalForceKillSignal).toBe('none');
    expect(run.telemetryParsed.externalForceKillGuardOutcome).toBe('identityMismatch');
  });

  it('re-checks identity independently before KILL (mixed TERM-matched → KILL-mismatch withholds KILL)', () => {
    // The behavioral `ps` shim returns a fixed value per run, so it cannot flip
    // mid-run. Instead assert structurally that the SIGTERM and SIGKILL guards
    // are TWO independent `ps` reads each followed by its own `case` block — so
    // an identity that matches at TERM time but mismatches at KILL time would
    // leave SIGNAL=TERM and the outcome flips to identityMismatch (KILL
    // withheld, NOT "TERM despite mismatch").
    const script = buildWatchdogScript(12345, STABLE_EXE, STABLE_BUNDLE, TELEMETRY, EXPECTED_VERSION);

    const termGuardIdx = script.indexOf('"$EXTERNAL_FORCE_KILL_SIGNAL" = none');
    const killGuardIdx = script.indexOf('"$EXTERNAL_FORCE_KILL_SIGNAL" = TERM');
    expect(termGuardIdx).toBeGreaterThan(-1);
    expect(killGuardIdx).toBeGreaterThan(termGuardIdx);

    // Each guard block owns its own `ps` read + `case` (independent re-check).
    const termBlock = script.slice(termGuardIdx, killGuardIdx);
    const killBlock = script.slice(killGuardIdx);
    expect(termBlock).toContain('ps -p 12345 -o command=');
    expect(termBlock).toContain('case "$KILL_TARGET_CMD" in');
    expect(killBlock).toContain('ps -p 12345 -o command=');
    expect(killBlock).toContain('case "$KILL_TARGET_CMD" in');
    // The KILL block is gated on SIGNAL having reached TERM, and a mismatch in
    // its own `case` sets identityMismatch without sending KILL.
    expect(killBlock).toContain('EXTERNAL_FORCE_KILL_GUARD=identityMismatch');
    expect(killBlock).toContain('kill -KILL 12345');
  });

  it('does not fire the killer when the target exits on its own (no-op, open still fires)', () => {
    // Reuse the no-op harness (non-existent PID): loop exits on first kill -0
    // failure before reaching the budget.
    const run = runWatchdogScript({ plutilExit: 0, plutilStdout: '0.4.34' }, EXPECTED_VERSION);

    expect(run.exitCode).toBe(0);
    expect(run.telemetryParsed.externalForceKillSignal).toBe('none');
    expect(run.telemetryParsed.externalForceKillGuardOutcome).toBe('na');
    expect(run.telemetryParsed.openFired).toBe(true);
    expect(run.openCallCount).toBe(1);
  });
});
