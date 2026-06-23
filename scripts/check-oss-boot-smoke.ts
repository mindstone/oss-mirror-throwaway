#!/usr/bin/env -S npx tsx
/**
 * OSS boot smoke — LAUNCH-based startup-crash gate.
 *
 * WHY THIS EXISTS
 * ---------------
 * The static OSS gate (`scripts/check-oss-build-smoke.ts` / `npm run validate:oss-smoke`)
 * SCANS the built bundle for leaked private markers — it never LAUNCHES the app, so it
 * cannot catch a runtime boot crash. A whole class of startup crashes is invisible to a
 * static scan: a module that reads a boundary singleton (e.g. `getPlatformConfig()`) at
 * MODULE-LOAD time, before `src/main/bootstrap.ts` initialises it, throws
 * `PlatformConfig not initialized` and the app dies with `App threw an error during load`
 * before any window appears. This exact class shipped in the OSS build (toolIndexService
 * + bundledHttpMcpManager read platform config at import time) and was only found by
 * manually launching the built app. See docs/plans/260622_fix-oss-toolindex-boot-crash/.
 *
 * This script closes that gap: it LAUNCHES the built main bundle with an isolated user-data
 * dir and asserts the main process boots PAST bootstrap (reaches `app.whenReady`) without a
 * load-time boundary crash.
 *
 * WHAT IT LAUNCHES
 * ----------------
 * The Forge / electron-vite main bundle (`.vite/build/bootstrap.js` by default — what the
 * shipped app runs). Do NOT point this at `out/main/index.js` (the `build:legacy` output):
 * legacy uses electron-vite lib mode which INLINES the lazily-imported `./index` module, so
 * it over-reports offenders that never crash in the real Forge build. `build:legacy` is
 * scan-only (it feeds the static gate); this launch gate targets the faithful bundle.
 *
 * The caller is responsible for producing the bundle (OSS-stub build = `private/` detached;
 * see docs/project/OSS_BUILD_SMOKE_RUNBOOK.md). This script only launches + observes.
 *
 * SUCCESS / FAILURE
 * -----------------
 *  FAIL  — Electron prints "App threw an error during load" (its FATAL main-entry-load
 *            signal), OR the process exits with a NON-ZERO code at ANY point (before OR after
 *            "--- app start"), OR the process is KILLED BY A SIGNAL (SIGSEGV/SIGABRT/etc. — a
 *            crash that reports exit code===null) at ANY point, OR the process exits CLEANLY
 *            (code 0) after "--- app start" but before an explicit PAST_INDEX marker. Exit-based
 *            failures are classified only AFTER stdout/stderr fully drain (the 'close' event), so
 *            a PASS marker still buffered when the process exits is never lost to a premature FAIL.
 *            The bug-specific text "PlatformConfig not initialized" is reported as the cause when
 *            present.
 *            Why a clean post-app-start exit fails: a real boot stays ALIVE in whenReady /
 *            attempting a window — it does not exit on its own. An app that reaches bootstrap
 *            then exits 0 before confirming it got PAST `./index` is NOT a confirmed boot, and
 *            this gate is false-PASS-sensitive (the instance-#3 lesson), so we fail closed.
 *            (The single-instance-lock path can exit 0 BEFORE "--- app start"; that benign edge
 *            is handled by the no-app-start timeout, not here.)
 *            NB: a bare "...not initialized. Call setX()" line is NOT a failure on its own —
 *            several boundaries log that as a GRACEFULLY-HANDLED deferred-binding warning at
 *            module load (e.g. providerReachabilitySnapshot ↔ SettingsStoreAdapter). Only a
 *            real crash produces "App threw an error during load" + a non-zero exit.
 *  PASS  — bootstrap reached "--- app start" AND the process logged a post-`./index` marker
 *          (it got into index.ts's whenReady handler — e.g. the explicit boot-smoke marker, or
 *          a window/renderer load attempt) WHILE STILL ALIVE, OR stayed alive `minAliveMs` past
 *          "app start" with no crash signature AND still running (exitCode === null).
 *          A renderer "ERR_CONNECTION_REFUSED" / "Failed to load URL" is EXPECTED and fine
 *          when launched without a renderer dev server — it proves main reached createWindow,
 *          which is far past the boot-crash window. We assert MAIN boots, not the renderer.
 *
 * USAGE
 *   npx tsx scripts/check-oss-boot-smoke.ts [--main <path>] [--timeout-ms N] [--min-alive-ms N]
 *   npm run validate:oss-boot-smoke            # after building the OSS bundle
 *
 * Exit 0 = booted past bootstrap; exit 1 = boot crash / failed to confirm boot.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface Options {
  mainEntry: string;
  timeoutMs: number;
  minAliveMs: number;
  help: boolean;
}

// The ONLY reliable fatal signal: Electron prints this when the main entry throws during
// module load (the exact failure mode of the boot-crash class). Benign deferred-binding
// warnings ("X not initialized. Call setX()") never produce it — so this is false-positive
// free, unlike matching the error text directly.
const FATAL_LOAD_SIGNATURE = /App threw an error during load/;
// Bug-specific cause, used only to ENRICH the failure reason once a fatal crash is confirmed.
const PLATFORM_CONFIG_CAUSE = /PlatformConfig not initialized/;

// Markers proving the main process executed index.ts's whenReady handler — i.e. it got
// PAST `await import('./index')`, which is where the boot-crash class strikes. A renderer
// load failure (no dev server) is one such marker and is acceptable.
// The first marker is a DETERMINISTIC stdout line emitted at the very top of index.ts's
// whenReady handler (`[boot-smoke] whenReady reached`) — it gives a reliable PASS that does
// not depend on renderer noise or the min-alive timer. The rest are best-effort backups.
const PAST_INDEX_MARKERS: readonly RegExp[] = [
  /\[boot-smoke\] whenReady reached/,
  /Failed to load URL/i,
  /app\.whenReady handler/i,
  /ERR_CONNECTION_REFUSED/i,
  /ready-to-show|did-finish-load/i,
];

const BOOTSTRAP_START_MARKER = '--- app start';

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    mainEntry: path.resolve(process.cwd(), '.vite/build/bootstrap.js'),
    timeoutMs: 60_000,
    minAliveMs: 15_000,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--main') opts.mainEntry = path.resolve(process.cwd(), argv[++i]);
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(argv[++i]);
    else if (arg === '--min-alive-ms') opts.minAliveMs = Number(argv[++i]);
    else {
      console.error(`Unknown argument: ${arg}`);
      opts.help = true;
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(
    [
      'OSS boot smoke — launch-based startup-crash gate',
      '',
      'Usage: npx tsx scripts/check-oss-boot-smoke.ts [options]',
      '  --main <path>        Main bundle to launch (default .vite/build/bootstrap.js).',
      '                       Build it OSS-stub first (private/ detached) — see',
      '                       docs/project/OSS_BUILD_SMOKE_RUNBOOK.md. Do NOT use out/main',
      '                       (build:legacy) — it inlines ./index and over-reports.',
      '  --timeout-ms <n>     Hard cap on the whole probe (default 60000).',
      '  --min-alive-ms <n>   Survival past "app start" with no crash = PASS (default 15000).',
      '  -h, --help           Show this help.',
    ].join('\n'),
  );
}

function resolveElectronBinary(): string {
  // The `electron` npm package exports the binary path as its default export.
  // Resolve it the same way the E2E harness does (it launches out/main via the same binary).
  const local = path.resolve(process.cwd(), 'node_modules/.bin/electron');
  if (existsSync(local)) return local;
  return 'electron';
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  if (!existsSync(opts.mainEntry)) {
    console.error(
      `[oss-boot-smoke] FAIL: main bundle not found at ${opts.mainEntry}\n` +
        `Build the OSS bundle first (see docs/project/OSS_BUILD_SMOKE_RUNBOOK.md), or pass --main <path>.`,
    );
    process.exit(1);
  }

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'rebel-oss-boot-smoke-'));
  const electron = resolveElectronBinary();
  let output = '';
  let settled = false;
  // exitCode/exitSignal: Node sets `code` for a normal exit and `signal` for a signal death
  // (SIGSEGV/SIGABRT/SIGKILL → code===null). `hasExited` is the unambiguous "process is gone"
  // flag — DO NOT use `exitCode === null` as a proxy for "still alive", since a signal death
  // also reports code===null and would otherwise sneak through the min-alive/timeout PASS.
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let hasExited = false;
  // streamsClosed: the 'close' event fires AFTER stdout/stderr reach EOF, i.e. all buffered
  // output is now in combined(). We DEFER exit-based FAIL classification until this is true so a
  // PASS marker still buffered when 'exit' fired isn't lost to a premature FAIL (false-FAIL race).
  let streamsClosed = false;

  console.log(`[oss-boot-smoke] launching ${path.relative(process.cwd(), opts.mainEntry)}`);
  console.log(`[oss-boot-smoke] isolated userData: ${userDataDir}`);

  // Isolate via REBEL_TEST_USER_DATA_DIR, NOT REBEL_USER_DATA. This is the crux of the
  // un-masking fix: getDataPath() (src/core/utils/dataPaths.ts) is
  // `process.env.REBEL_USER_DATA || getPlatformConfig().userDataPath` — so setting
  // REBEL_USER_DATA SHORT-CIRCUITS before getPlatformConfig() is ever reached, hiding the
  // entire "boundary read at module load" crash class this gate exists to catch.
  // REBEL_TEST_USER_DATA_DIR routes through ensureTestUserData.ts → app.setPath('userData')
  // and does NOT set REBEL_USER_DATA, so getDataPath() falls through to getPlatformConfig() —
  // exactly the path that throws when a module reads it before bootstrap initialises it.
  // (This is also how the bug reproduces by hand: REBEL_TEST_USER_DATA_DIR=auto npm run start.)
  // The dir is under os.tmpdir() (mkdtempSync above), satisfying ensureTestUserData's
  // temp-containment guard. We deliberately do NOT also set REBEL_USER_DATA — ensureTestUserData
  // cross-checks they match, and we want getDataPath() to hit getPlatformConfig().
  // --enable-source-maps makes any crash stack point at source. --no-sandbox + --disable-gpu
  // keep headless CI happy (matches the proven linux-smoke.yml xvfb harness flags).
  // REBEL_BOOT_SMOKE_MARKER opts the launched main into emitting the deterministic
  // "[boot-smoke] whenReady reached" line at the top of index.ts's whenReady handler. Gated so
  // normal production boots stay silent (zero behavioural effect outside this smoke).
  const child = spawn(electron, [opts.mainEntry, '--no-sandbox', '--disable-gpu'], {
    env: {
      ...process.env,
      REBEL_TEST_USER_DATA_DIR: userDataDir,
      REBEL_BOOT_SMOKE_MARKER: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --enable-source-maps`.trim(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const onData = (buf: Buffer): void => {
    output += buf.toString();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('exit', (code, signal) => {
    exitCode = code;
    exitSignal = signal;
    hasExited = true;
  });
  // 'close' fires after stdout+stderr have fully drained (EOF) — the point at which it is safe to
  // classify an exit-based FAIL without racing a still-buffered PASS marker.
  child.on('close', () => {
    streamsClosed = true;
  });

  const diagPath = path.join(userDataDir, 'logs', 'bootstrap-diagnostics.log');
  const readDiag = (): string => {
    try {
      return readFileSync(diagPath, 'utf-8');
    } catch {
      return '';
    }
  };
  const combined = (): string => output + '\n' + readDiag();

  const startedAt = Date.now();
  let appStartSeenAt: number | null = null;

  const finish = (pass: boolean, reason: string): void => {
    if (settled) return;
    settled = true;
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (pass) {
      console.log(`[oss-boot-smoke] PASS: ${reason}`);
      process.exit(0);
    } else {
      console.error(`[oss-boot-smoke] FAIL: ${reason}`);
      const tail = combined().split('\n').slice(-25).join('\n');
      console.error('--- output tail ---\n' + tail);
      process.exit(1);
    }
  };

  // Poll loop: cheap and robust against process/stream timing.
  const tick = (): void => {
    if (settled) return;
    const text = combined();

    if (FATAL_LOAD_SIGNATURE.test(text)) {
      const cause = PLATFORM_CONFIG_CAUSE.test(text)
        ? 'PlatformConfig read at module load before bootstrap initialised it'
        : 'main entry threw during module load';
      finish(false, `boot crash — "App threw an error during load" (${cause})`);
      return;
    }

    if (appStartSeenAt === null && text.includes(BOOTSTRAP_START_MARKER)) {
      appStartSeenAt = Date.now();
    }

    const pastIndex = PAST_INDEX_MARKERS.some((re) => re.test(text));

    // A confirmed PAST_INDEX marker is the strongest PASS signal: main got into index.ts's
    // whenReady handler, far past the boot-crash window. Accept it regardless of exit state
    // (the process may have been killed by `finish` on a prior tick, or be shutting down).
    if (appStartSeenAt !== null && pastIndex) {
      finish(true, 'main reached app.whenReady (booted past bootstrap and ./index)');
      return;
    }

    // Exit-based FAIL classification is DEFERRED until streams have fully drained (streamsClosed),
    // so a PASS marker still buffered when the process exited isn't lost to a premature FAIL.
    // (The PAST_INDEX check above runs every tick regardless, so a real marker always wins.)
    if (hasExited && streamsClosed) {
      const cause = PLATFORM_CONFIG_CAUSE.test(text)
        ? ' (PlatformConfig read at module load before bootstrap initialised it)'
        : '';
      const phase = appStartSeenAt === null ? 'before reaching bootstrap "app start"' : 'after "app start"';

      // Signal death (SIGSEGV/SIGABRT/etc.) reports code===null — it is a crash, not a clean exit.
      // Must FAIL at any point, or a post-"app start" segfault would false-PASS via the timer.
      if (exitSignal !== null) {
        finish(false, `process killed by signal ${exitSignal} ${phase}${cause}`);
        return;
      }

      // Any non-zero exit at ANY point is a crash — FAIL (the original false-PASS-hole fix:
      // previously only a pre-app-start non-zero exit failed, so a crash AFTER bootstrap slipped).
      if (exitCode !== null && exitCode !== 0) {
        finish(false, `process exited with code ${exitCode} ${phase}${cause}`);
        return;
      }

      // A CLEAN exit (code 0) after "app start" but with no PAST_INDEX marker is NOT a confirmed
      // boot: a real boot stays alive in whenReady / attempting a window, it doesn't exit on its
      // own. Fail closed (the instance-#3 lesson). The benign single-instance-lock clean exit
      // happens BEFORE "app start" and is caught by the no-app-start timeout, not here.
      if (exitCode === 0 && appStartSeenAt !== null) {
        finish(false, 'process exited cleanly (code 0) after "app start" without confirming it reached app.whenReady');
        return;
      }
      // exitCode===0 with no "app start": benign pre-bootstrap exit (e.g. single-instance lock).
      // Fall through to the no-app-start timeout, which fails it as "never reached app start".
    }

    if (appStartSeenAt !== null) {
      // Min-alive PASS requires the process to be GENUINELY STILL RUNNING (!hasExited). Using
      // hasExited (not exitCode===null) is the signal-death fix: a segfault sets code===null but
      // hasExited===true, so it can no longer pass on the timer.
      if (!hasExited && Date.now() - appStartSeenAt >= opts.minAliveMs) {
        finish(true, `survived ${opts.minAliveMs}ms past "app start", still alive, with no boot-crash signature`);
        return;
      }
    }

    if (Date.now() - startedAt >= opts.timeoutMs) {
      if (appStartSeenAt !== null && !hasExited) {
        // Reached bootstrap, still alive, never crashed — treat as pass (slow machine).
        // (Any exit — clean, non-zero, or signal — would have settled above once streams drained,
        // so reaching here with a live process means it booted and is running, exactly what we
        // assert. The timeout still bounds the wait if 'close' never fires.)
        finish(true, 'reached "app start", still alive, and never hit a crash signature within timeout');
      } else if (appStartSeenAt === null) {
        finish(false, `timed out after ${opts.timeoutMs}ms without reaching bootstrap "app start"`);
      } else {
        // appStartSeenAt set but the process already exited and streams hadn't drained in time to
        // classify above. Fail closed — an exited process is not a confirmed boot.
        const how = exitSignal !== null ? `signal ${exitSignal}` : `code ${exitCode}`;
        finish(false, `timed out after ${opts.timeoutMs}ms; process exited (${how}) without confirming boot`);
      }
      return;
    }

    setTimeout(tick, 500);
  };

  setTimeout(tick, 500);
}

void main();
