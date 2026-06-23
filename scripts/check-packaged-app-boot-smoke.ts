#!/usr/bin/env tsx
/**
 * Desktop packaged-app BOOT SMOKE (Stage 13 — docs/plans/260604_testing-bug-catching).
 *
 * The single thing every unit/vitest test structurally CANNOT check: does the real,
 * bundled, electron-forge-`package`d desktop app actually boot? ~50 recent HIGH
 * postmortems are "compiles + passes mocked unit tests in dev, crashes only in the
 * packaged runtime" (bundling/minify, files-not-copied, @core/@shared alias not
 * rewritten in the bundle, Node-version diffs, native modules). Examples:
 * 260413_turndown_packaged_app_startup_crash, 260529_build_worker_core_alias_missing.
 *
 * What this does: launch the *already-packaged* binary via Playwright `_electron.launch`
 * (reusing scripts/drive-packaged-app.ts's `launchPackagedApp()` — same launch env,
 * __name shim, and robust close), then poll the test-only e2e readiness bridge
 * (window.e2eApi.getReadiness()) until the app reports `appReady === true`. That bridge
 * is pushed by the renderer (src/renderer/App.tsx), so reaching it proves the main
 * process started, a window opened, the renderer bundle loaded, React mounted, and
 * settings resolved — i.e. the app booted. In REBEL_E2E_TEST_MODE the app auto-seeds
 * minimal settings (src/main/startup/ensureRebelTestMode.ts) and reaches `appReady` in
 * well under a second on a healthy build (measured in the Stage 13 spike).
 *
 * This is NOT a feature/E2E test. It deliberately asserts ONLY "it boots" — no clicks,
 * no seeding, no screenshots, no broad console-error hygiene (that would make it flaky).
 * For the full packaged-app feature suite, see the Playwright E2E project. For an
 * interactive ad-hoc driver, see scripts/drive-packaged-app.ts.
 *
 * WHAT IT PROVES (and what it does NOT) — be honest about the contract:
 *   PROVES: the packaged main process started, a window opened, the renderer bundle
 *   loaded + evaluated, React mounted, and settings resolved to `appReady`. This is
 *   exactly the failure surface of the dominant packaged-boot class — bundling/minify
 *   errors, files-not-copied, @core/@shared alias not rewritten in the bundle, missing
 *   native modules — which crash *before* the app can ever reach `appReady`.
 *   DOES NOT PROVE: a fully clean *real-user* boot. It launches in REBEL_E2E_TEST_MODE,
 *   which (intentionally, for determinism) suppresses or changes some real-user-only
 *   startup paths: single-instance lock, architecture-mismatch dialog, auto-update,
 *   global hotkey, protocol registration. The startup-recovery dialog is likewise
 *   suppressed (startupRecoveryDialogVisible stays false under e2e), so to cover the
 *   most important degraded-boot case we added a test-mode signal: SafeModeOrchestrator
 *   records `superMcpStartupFailed` on the readiness bridge when a Super-MCP startup
 *   failure occurs that WOULD have shown recovery in real-user mode — and
 *   classifyBootReadiness() treats it as a terminal failure. Because that signal fires
 *   only after Super-MCP retries exhaust (seconds in), it is observed only when run with
 *   `--await-tools-ms <n>` (the release CI job sets it; the fast local pre-flight does
 *   not). LIMITATION: this catches Super-MCP failures that surface within that window,
 *   not the other test-mode-suppressed real-user paths above — those remain delegated to
 *   the broader release E2E suite.
 *
 * IMPORTANT — run it against a FRESH package. This script smokes whatever is in `out/`;
 * smoking a stale build is a placebo. The RELEASE_TO_BETA pre-flight wires the wrapper
 * `npm run preflight:desktop-packaged-boot` (= `npm run package && npm run package:boot-smoke`)
 * so it always packages the current HEAD first.
 *
 * FSEVENTS INTERCEPTION GATE (PLAN.md docs/plans/260611_fsevents-shutdown-crash, Stage 3a —
 * GATING, Arbitrator F2): after appReady settles, this smoke additionally proves the one
 * fsevents-leak-guard mechanic that is unprovable from source — that the wrapper's
 * module-cache interception works inside the PACKAGED artifact (asar + NODE_PATH could in
 * principle resolve a second fsevents copy the wrapper never patched). Setup: the smoke
 * profile pre-seeds app-settings.json with a real temp workspace as `coreDirectory`
 * (ensureRebelTestMode only seeds settings when absent, so the pre-written file wins), the
 * app starts workspaceWatcherService over it, and the test-mode-only
 * `e2e:fsevents-leak-guard-diagnostics` IPC (registered only under REBEL_E2E_TEST_MODE)
 * reports guard + watcher state. On darwin: watcher ready ⇒ liveNativeInstanceCount > 0.
 * On non-darwin: the guard must report itself cleanly inert ('inert:non-darwin', 0 live).
 * The two failure modes are deliberately distinguished in output and exit code:
 *   - "watcher never started / never ready" = smoke SETUP failure (exit 2) — fix the seed,
 *     it says nothing about interception;
 *   - "watcher ready but 0 live instances" = INTERCEPTION failure (exit 1) — the D-falls
 *     signal: the leak sweep is tracking nothing in the packaged app → re-arbitrate the
 *     plan direction (A2 front-runner).
 *
 * PDF-RENDER-VIA-PROTOCOL GATE (PLAN.md docs/plans/260620_pdf-media-prevention, Stage 1;
 * PM 260619_pdf_preview_blank_blob_file_origin — GATING): after appReady settles, this smoke
 * additionally proves the one media-preview property that is invisible to every unit test and
 * dev (`http`) E2E — that a PACKAGED renderer (`file://` origin) can obtain a PDF over the
 * privileged `rebel-media://` protocol. The blank-PDF bug shipped because the preview was only
 * ever exercised under dev's `http` origin; the packaged `file://` origin (where a renderer
 * `blob:` URL is origin-scoped) was never tested. Setup: `seedSmokeProfile` writes a real PDF
 * inside the seeded `coreDirectory`; after appReady, the renderer `fetch()`es it over
 * `rebel-media://local/...` (full + a `Range: bytes=0-0` request — PDFium loads PDFs via byte
 * ranges) and the gate asserts 200/206 + `application/pdf` + non-empty/1-byte bodies + a
 * `Content-Range`. WHAT IT PROVES: custom-scheme registration, Chromium URL parsing of the
 * `local/` shape, the `protocol.handle` path, filesystem resolution, `.pdf`→MIME mapping, and
 * streamed/partial body delivery — all in the packaged binary. WHAT IT DOES NOT PROVE:
 * PDFium's internal render (PDF-frame load events are unreliable, which is why the fix removed
 * the onLoad timeout) — this is honestly a protocol-fetch / byte-path gate, not "pixels drawn".
 * Failure-mode split mirrors the fsevents gate: a `fetch()` rejection / wrong status / wrong
 * MIME / empty body / broken range = RENDER failure (exit 1, the class signal); a missing seed
 * fixture / bridge / timeout = SETUP failure (exit 2, not a render verdict).
 *
 * Exit codes (deliberate, for log/CI classification):
 *   0  pass — app reached `appReady` cleanly (and the fsevents + PDF gates passed).
 *   1  boot/assertion failure — never reached `appReady` within the timeout, booted into
 *      safe-mode / startup-recovery, the app/renderer crashed or exited before ready, the
 *      fsevents INTERCEPTION gate failed (watcher ready, zero tracked instances), or the PDF
 *      RENDER gate failed (packaged renderer could not obtain the PDF over rebel-media://).
 *   2  environment/precondition failure — packaged binary missing (run `npm run package`),
 *      unsupported platform, or a gate could not be SET UP (fsevents watcher never started /
 *      diagnostic bridge missing; PDF seed fixture missing — not an assertion verdict).
 *
 * Usage:
 *   npx tsx scripts/check-packaged-app-boot-smoke.ts [--timeout-ms <n>] [--await-tools-ms <n>]
 *     [--fsevents-gate-timeout-ms <n>] [--pdf-gate-timeout-ms <n>] [--verbose]
 *   env overrides: BOOT_SMOKE_TIMEOUT_MS (boot budget), BOOT_SMOKE_AWAIT_TOOLS_MS (post-appReady
 *   Super-MCP-outcome watch; 0 = off, the fast local default; CI sets a window so the
 *   superMcpStartupFailed signal is observed), BOOT_SMOKE_FSEVENTS_GATE_TIMEOUT_MS (fsevents
 *   gate budget after appReady), BOOT_SMOKE_PDF_GATE_TIMEOUT_MS (PDF gate budget after appReady).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchPackagedApp, resolvePackagedBinaryPath } from './drive-packaged-app';
// Use the REAL production URL builder so the PDF-render gate exercises the actual
// `rebel-media://local/...` shape the document-editor preview emits (pure util,
// only depends on `pathe`) — catching URL-shape regressions, not just handler ones.
import { getMediaProtocolUrl } from '../src/renderer/features/document-editor/utils/protocolUrls';

// --- Pure readiness classifier (unit-tested; the anti-rot construction guard) --------

/** Structural subset of RebelE2EReadinessSnapshot (src/preload/index.ts) that we read. */
export interface BootReadiness {
  phase?: string;
  blockingReason?: string;
  appReady?: boolean;
  toolsReady?: boolean;
  safeModeEnabled?: boolean;
  startupRecoveryDialogVisible?: boolean;
  /** Test-mode-only: a real-user-recovery-triggering Super-MCP startup failure was suppressed. */
  superMcpStartupFailed?: boolean;
}

export type BootClassification =
  | { ok: true; reason: string }
  | { ok: false; done: boolean; reason: string };

/**
 * Decide whether a readiness snapshot means "booted". Pure + total so it can be
 * exhaustively unit-tested without launching Electron.
 *
 * - `ok: true`  → booted; stop polling, pass.
 * - `ok: false, done: true`  → a terminal boot failure (safe-mode / startup-recovery);
 *   stop polling, fail. The app "reached a phase" but it's a crash-recovery phase.
 * - `ok: false, done: false` → not ready yet (missing bridge, wrong shape, still
 *   booting); keep polling until timeout.
 *
 * `appReady` is the contract (it already implies `!startupRecoveryDialogVisible` and a
 * resolved phase per App.tsx), but we check safe-mode / recovery explicitly so a build
 * that boots straight into degraded recovery fails fast with a clear reason rather than
 * timing out. We do NOT require `toolsReady` — the MCP router starts slightly after the
 * app is interactive and is env-dependent (would be flaky).
 */
export function classifyBootReadiness(snapshot: unknown): BootClassification {
  if (snapshot === null || snapshot === undefined) {
    return { ok: false, done: false, reason: 'e2e readiness bridge unavailable (window.e2eApi.getReadiness returned nothing)' };
  }
  if (typeof snapshot !== 'object') {
    return { ok: false, done: false, reason: `readiness snapshot has unexpected type: ${typeof snapshot}` };
  }
  const r = snapshot as BootReadiness;
  if (typeof r.appReady !== 'boolean') {
    return { ok: false, done: false, reason: 'readiness snapshot missing boolean `appReady` (shape drift?)' };
  }
  // Terminal degraded-boot states: the app DID come up but into a crash/recovery path.
  if (r.safeModeEnabled === true) {
    return { ok: false, done: true, reason: `booted into SAFE MODE (phase=${r.phase ?? '?'}) — startup crash recovery` };
  }
  if (r.startupRecoveryDialogVisible === true) {
    return { ok: false, done: true, reason: `startup-recovery dialog is visible (phase=${r.phase ?? '?'}) — startup crash recovery` };
  }
  // Test-mode-only signal: real users would have seen the startup-recovery dialog (the
  // dialog itself is suppressed under e2e, so the flag above stays false). Degraded boot.
  if (r.superMcpStartupFailed === true) {
    return { ok: false, done: true, reason: 'Super-MCP startup failed — real users would see the startup-recovery dialog (degraded boot)' };
  }
  if (r.appReady === true) {
    return { ok: true, reason: `appReady (phase=${r.phase ?? '?'})` };
  }
  return {
    ok: false,
    done: false,
    reason: `not ready yet (phase=${r.phase ?? '?'}, blockingReason=${r.blockingReason ?? 'none'})`,
  };
}

// --- Pure fsevents-interception-gate classifier (unit-tested) -------------------------

/**
 * Structural subset of the `e2e:fsevents-leak-guard-diagnostics` snapshot
 * (src/main/index.ts test-mode block → src/main/services/fseventsLeakGuard.ts).
 */
export interface FseventsGateSnapshot {
  platform?: unknown;
  guard?: {
    installState?: string | null;
    quitMode?: boolean;
    liveNativeInstanceCount?: number;
  };
  watcher?: {
    isWatching?: boolean;
    currentDirectory?: string | null;
    readyObserved?: boolean;
  };
}

/**
 * - `ok: true` → gate passed; stop polling.
 * - `ok: false, done: false` → not decidable yet; keep polling. On gate timeout the
 *   orchestrator reports the LAST reason as a SETUP failure (exit 2).
 * - `ok: false, done: true, kind: 'setup'` → terminal setup failure (exit 2) — says
 *   nothing about interception (e.g. the packaged build predates the guard/diagnostic).
 * - `ok: false, done: true, kind: 'interception'` → terminal GATE failure (exit 1) —
 *   the D-falls signal (PLAN.md Stage 3a): the packaged artifact runs fsevents the
 *   wrapper never intercepted (watcher ready with zero tracked instances, or the guard
 *   inert on darwin), so the quit-time leak sweep would track nothing → re-arbitrate.
 */
export type FseventsGateClassification =
  | { ok: true; reason: string }
  | { ok: false; done: boolean; kind: 'setup' | 'interception'; reason: string };

export function classifyFseventsInterception(snapshot: unknown): FseventsGateClassification {
  if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object') {
    return {
      ok: false,
      done: false,
      kind: 'setup',
      reason: 'fsevents diagnostics snapshot unavailable (IPC returned nothing yet)',
    };
  }
  const s = snapshot as FseventsGateSnapshot;
  if (typeof s.platform !== 'string' || typeof s.guard !== 'object' || s.guard === null) {
    return {
      ok: false,
      done: false,
      kind: 'setup',
      reason: 'fsevents diagnostics snapshot has unexpected shape (drift?)',
    };
  }
  const installState = s.guard.installState ?? null;
  const liveCount =
    typeof s.guard.liveNativeInstanceCount === 'number' ? s.guard.liveNativeInstanceCount : 0;

  if (s.platform !== 'darwin') {
    // Non-darwin: fsevents does not exist; the guard must be cleanly inert.
    if (installState === 'inert:non-darwin' && liveCount === 0) {
      return { ok: true, reason: `non-darwin (${s.platform}): guard cleanly inert, 0 live instances` };
    }
    if (installState === null) {
      return {
        ok: false,
        done: true,
        kind: 'setup',
        reason:
          `non-darwin (${s.platform}): guard install never ran (installState=null) — packaged build ` +
          'predates the fsevents leak guard or bootstrap wiring broke',
      };
    }
    return {
      ok: false,
      done: true,
      kind: 'interception',
      reason:
        `non-darwin (${s.platform}): guard NOT cleanly inert (installState=${installState}, ` +
        `live=${liveCount}) — expected 'inert:non-darwin' with 0 live instances`,
    };
  }

  // darwin: the gating leg.
  if (installState === null) {
    return {
      ok: false,
      done: true,
      kind: 'setup',
      reason:
        'darwin: guard install never ran (installState=null) — packaged build predates the fsevents ' +
        'leak guard or bootstrap wiring broke; repackage before trusting this gate',
    };
  }
  if (installState !== 'installed') {
    // 'inert:unloadable' / 'inert:unexpected-shape' / 'inert:install-failed' on a darwin
    // PACKAGED app means the artifact's fsevents never got patched — the sweep tracks
    // nothing. That is the interception-failure class, not a smoke-setup problem.
    return {
      ok: false,
      done: true,
      kind: 'interception',
      reason:
        `darwin: guard reports '${installState}' in the packaged app — fsevents is NOT intercepted ` +
        '(packaged fsevents resolution/patch failed). D falls: the leak sweep tracks nothing.',
    };
  }
  if (liveCount > 0) {
    return {
      ok: true,
      reason: `darwin: interception proven — ${liveCount} live native instance(s) tracked by the guard`,
    };
  }
  if (s.watcher?.isWatching !== true) {
    return {
      ok: false,
      done: false,
      kind: 'setup',
      reason:
        'darwin: workspace watcher not started yet (seeded coreDirectory not picked up?) — 0 tracked ' +
        'instances is NOT an interception verdict before the watcher runs',
    };
  }
  if (s.watcher.readyObserved !== true) {
    return {
      ok: false,
      done: false,
      kind: 'setup',
      reason: `darwin: watcher running over ${s.watcher.currentDirectory ?? '?'} but not ready yet`,
    };
  }
  return {
    ok: false,
    done: true,
    kind: 'interception',
    reason:
      `darwin: watcher READY over ${s.watcher.currentDirectory ?? '?'} but liveNativeInstanceCount === 0 ` +
      '— the packaged artifact created fsevents instances the wrapper never saw. This is the GATING ' +
      'interception failure (PLAN.md 260611_fsevents-shutdown-crash Stage 3a / Arbitrator F2): ' +
      'D falls → re-arbitrate (A2 front-runner).',
  };
}

// --- Pure PDF-render-via-protocol gate classifier (unit-tested) -----------------------

/**
 * Result of the renderer-side probe: from the PACKAGED renderer's `file://` origin,
 * `fetch()` the seeded PDF over `rebel-media://local/...` twice — a full request and a
 * `Range: bytes=0-0` request. This is the load-bearing environmental property the
 * 260619 fix depends on (and that the bug's unpackaged repro could NOT reproduce): can
 * a packaged `file://` renderer obtain a PDF over the privileged protocol? It does NOT
 * drive PDFium's internal render (deliberately — PDF-frame load events are unreliable,
 * which is why the fix removed the onLoad-based timeout); it is honestly a
 * protocol-fetch / byte-path gate, not a "pixels rendered" gate.
 */
export interface RebelMediaPdfProbe {
  /** Full (no-Range) fetch. */
  full?: { status?: number; contentType?: string | null; byteLength?: number };
  /** `Range: bytes=0-0` fetch — PDFium relies on byte-range support. */
  range?: { status?: number; contentType?: string | null; contentRange?: string | null; byteLength?: number };
  /** Set iff `fetch()` itself rejected in the renderer (F1: this IS the class signal). */
  fetchError?: string;
}

export type PdfRenderGateClassification =
  | { ok: true; reason: string }
  | { ok: false; done: boolean; kind: 'setup' | 'render'; reason: string };

const PDF_MIME = 'application/pdf';

/**
 * Decide whether the packaged renderer can obtain the seeded PDF over `rebel-media://`.
 *
 * - `ok: true` → gate passed; stop polling.
 * - `ok: false, done: false` → not decidable yet (probe result incomplete / transient
 *   evaluate race); keep polling. On gate timeout the orchestrator reports a SETUP
 *   failure (exit 2) — a never-completing probe is an orchestration problem, not a verdict.
 * - `ok: false, done: true, kind: 'render'` → terminal GATE failure (exit 1): the renderer
 *   could not fetch the PDF (rejection, wrong status, wrong content-type, empty/short body,
 *   or broken byte-range). This is the `dev_works_packaged_fails` class — the packaged
 *   `file://` origin cannot obtain the PDF the way the document-editor preview needs.
 * - `ok: false, done: true, kind: 'setup'` → terminal SETUP failure (exit 2): the probe
 *   machinery itself is the problem (reserved; the gate orchestration handles the common
 *   one — a missing seeded fixture — before probing).
 *
 * F1 (review): a renderer `fetch()` REJECTION is the class signal (render, exit 1), NOT a
 * setup error — "the packaged renderer cannot obtain the PDF over rebel-media://" is exactly
 * what we are gating. Setup is reserved for probe-orchestration faults (missing seed file —
 * checked up front; missing evaluate bridge — already proven by boot; app crash/close).
 */
export function classifyRebelMediaPdfFetch(snapshot: unknown): PdfRenderGateClassification {
  if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object') {
    // evaluate returned nothing (page nav/eval race) — transient, keep polling.
    return { ok: false, done: false, kind: 'setup', reason: 'pdf probe snapshot unavailable (evaluate returned nothing yet)' };
  }
  const s = snapshot as RebelMediaPdfProbe;

  // F1: fetch rejected in the renderer → the packaged file:// origin cannot obtain the
  // PDF over the privileged protocol. Terminal RENDER failure (exit 1), not setup.
  if (typeof s.fetchError === 'string') {
    return {
      ok: false,
      done: true,
      kind: 'render',
      reason:
        `renderer fetch('rebel-media://...') rejected: ${s.fetchError} — the packaged file:// renderer ` +
        'cannot obtain the PDF over the privileged protocol (the dev_works_packaged_fails class)',
    };
  }

  const full = s.full;
  if (!full || typeof full.status !== 'number') {
    return { ok: false, done: false, kind: 'setup', reason: 'pdf probe incomplete (no full-fetch result yet)' };
  }
  const fullCt = typeof full.contentType === 'string' ? full.contentType : '';
  if (full.status !== 200 && full.status !== 206) {
    return {
      ok: false, done: true, kind: 'render',
      reason: `full fetch returned status ${full.status} (expected 200) — rebel-media handler did not serve the PDF in the packaged app`,
    };
  }
  if (!fullCt.startsWith(PDF_MIME)) {
    return {
      ok: false, done: true, kind: 'render',
      reason: `full fetch content-type '${fullCt || '(none)'}' is not ${PDF_MIME} — the .pdf→MIME mapping is broken in the packaged handler`,
    };
  }
  if (typeof full.byteLength !== 'number' || full.byteLength <= 0) {
    return {
      ok: false, done: true, kind: 'render',
      reason: `full fetch delivered an empty body (byteLength=${String(full.byteLength)}) — no PDF bytes reached the renderer`,
    };
  }

  // F2: range leg — PDFium loads PDFs via byte-range requests, so a 206 over the protocol
  // is materially closer to the real iframe contract than the full fetch alone.
  const range = s.range;
  if (!range || typeof range.status !== 'number') {
    return { ok: false, done: false, kind: 'setup', reason: 'pdf probe incomplete (no range-fetch result yet)' };
  }
  const rangeCt = typeof range.contentType === 'string' ? range.contentType : '';
  if (range.status !== 206) {
    return {
      ok: false, done: true, kind: 'render',
      reason: `range fetch (bytes=0-0) returned status ${range.status} (expected 206) — byte-range support is broken in the packaged handler; PDFium depends on it`,
    };
  }
  if (!rangeCt.startsWith(PDF_MIME)) {
    return { ok: false, done: true, kind: 'render', reason: `range fetch content-type '${rangeCt || '(none)'}' is not ${PDF_MIME}` };
  }
  // F3 (review): assert the exact `bytes 0-0/<size>` shape, not merely a non-empty header —
  // a 206 with a malformed Content-Range is still a broken partial response.
  if (typeof range.contentRange !== 'string' || !/^bytes 0-0\/\d+$/.test(range.contentRange)) {
    return {
      ok: false, done: true, kind: 'render',
      reason: `range fetch (206) Content-Range '${range.contentRange ?? '(none)'}' is not the expected 'bytes 0-0/<size>' shape — malformed partial response`,
    };
  }
  if (range.byteLength !== 1) {
    return {
      ok: false, done: true, kind: 'render',
      reason: `range fetch (bytes=0-0) delivered ${String(range.byteLength)} bytes (expected 1) — partial-content slicing is broken`,
    };
  }

  return {
    ok: true,
    reason: `packaged renderer obtained the PDF over rebel-media:// — full ${full.status} (${full.byteLength}B, ${fullCt}) + range 206 (1B, ${range.contentRange})`,
  };
}

// --- CLI orchestration ----------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 250;
/**
 * After the first `appReady` snapshot, require the app to STAY ready (and not crash) for
 * this long before passing. Guards against a build that flips ready then crashes on a
 * delayed startup task milliseconds later — we observed appReady in ~21ms, so an instant
 * pass would miss a near-immediate post-ready crash.
 */
const SETTLE_MS = 1_500;

function numArg(argv: string[], flag: string, envVar: string, fallback: number): number {
  const env = Number(process.env[envVar]);
  let val = Number.isFinite(env) && env >= 0 ? env : fallback;
  const i = argv.indexOf(flag);
  if (i >= 0) {
    const v = Number(argv[i + 1]);
    if (Number.isFinite(v) && v >= 0) val = v;
  }
  return val;
}

/**
 * Budget for the fsevents interception gate AFTER appReady. The watcher starts in the
 * same whenReady flow that produced appReady and the seeded workspace is tiny (~4 dirs),
 * so ready lands in low seconds; the budget is generous because a timeout is reported as
 * a SETUP failure (exit 2), never as an interception verdict.
 */
const DEFAULT_FSEVENTS_GATE_TIMEOUT_MS = 45_000;

/**
 * Budget for the PDF-render-via-protocol gate AFTER appReady. The protocol handler is
 * registered in the same whenReady flow as appReady and the fetch is local, so a healthy
 * build passes in well under a second; the budget is generous because a timeout is reported
 * as a SETUP failure (exit 2), never as a render verdict.
 */
const DEFAULT_PDF_GATE_TIMEOUT_MS = 30_000;

/**
 * Per-probe fetch deadline inside the renderer (AbortController). A healthy local protocol
 * fetch resolves in <100ms; this bounds a HUNG handler/stream so it surfaces as a fetch
 * rejection (→ RENDER verdict, exit 1) instead of hanging the smoke. Kept well under
 * DEFAULT_PDF_GATE_TIMEOUT_MS so a probe + one bounded recheck both fit in the gate budget.
 */
const PDF_PROBE_FETCH_TIMEOUT_MS = 8_000;

function parseArgs(argv: string[]): {
  timeoutMs: number;
  awaitToolsMs: number;
  fseventsGateTimeoutMs: number;
  pdfGateTimeoutMs: number;
  verbose: boolean;
} {
  const timeoutMs = numArg(argv, '--timeout-ms', 'BOOT_SMOKE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  // After appReady, optionally keep watching this long for the Super-MCP startup outcome.
  // The superMcpStartupFailed test-mode signal fires only after retries exhaust (seconds
  // in), so the default fast pre-flight (0 = appReady-only) never sees it; CI passes a
  // window so the signal is actually observed. We fail ONLY on an explicit failure signal
  // — a slow/never-ready Super-MCP just elapses the window and passes (no flaky false-red).
  const awaitToolsMs = numArg(argv, '--await-tools-ms', 'BOOT_SMOKE_AWAIT_TOOLS_MS', 0);
  const fseventsGateTimeoutMs =
    numArg(argv, '--fsevents-gate-timeout-ms', 'BOOT_SMOKE_FSEVENTS_GATE_TIMEOUT_MS', DEFAULT_FSEVENTS_GATE_TIMEOUT_MS) ||
    DEFAULT_FSEVENTS_GATE_TIMEOUT_MS;
  const pdfGateTimeoutMs =
    numArg(argv, '--pdf-gate-timeout-ms', 'BOOT_SMOKE_PDF_GATE_TIMEOUT_MS', DEFAULT_PDF_GATE_TIMEOUT_MS) ||
    DEFAULT_PDF_GATE_TIMEOUT_MS;
  return { timeoutMs, awaitToolsMs, fseventsGateTimeoutMs, pdfGateTimeoutMs, verbose: argv.includes('--verbose') };
}

function fail(code: 1 | 2, message: string): never {
  console.error(`[boot-smoke] FAIL (exit ${code}): ${message}`);
  process.exit(code);
}

/**
 * Pre-seed the disposable smoke profile (runs before launch, see
 * launchPackagedApp's prepareProfile): a tiny real workspace + app-settings.json
 * whose `coreDirectory` points at it, so the workspace watcher actually starts
 * and the fsevents interception gate has a subject. ensureRebelTestMode seeds
 * settings only when the file is absent, so this pre-written file wins. Lives
 * inside the temp profile so launchPackagedApp's close() removes everything.
 */
/**
 * A minimal, structurally-valid 1-page PDF. The PDF-render gate's content-type
 * assertion comes from the handler's extension→MIME map (not byte-sniffing), so
 * the bytes don't affect the assertion — but a real PDF keeps the fixture useful
 * for any future PDFium-driving check. Kept tiny on purpose; the xref offsets are
 * nominal (a lenient reader rebuilds them) since nothing here drives PDFium.
 */
const MINIMAL_PDF_BYTES =
  '%PDF-1.4\n' +
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n' +
  'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n' +
  'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n190\n%%EOF\n';

/**
 * The seeded PDF fixture's filename. Deliberately contains a space AND a percent
 * sign so the PDF-render gate exercises `encodeURIComponent` round-tripping through
 * Chromium's `rebel-media://local/...` URL parser — the exact URL-shape surface the
 * original blank-PDF bug family lived in (PM 260619 / 260523).
 */
const SMOKE_PDF_FILENAME = 'seed PDF 100%.pdf';

export function seedSmokeProfile(userDataDir: string): { workspaceDir: string; pdfPath: string } {
  const workspaceDir = path.join(userDataDir, 'smoke-workspace');
  mkdirSync(path.join(workspaceDir, 'notes'), { recursive: true });
  mkdirSync(path.join(workspaceDir, 'docs'), { recursive: true });
  writeFileSync(path.join(workspaceDir, 'notes', 'seed.md'), '# boot-smoke seed\n', 'utf8');
  writeFileSync(path.join(workspaceDir, 'docs', 'seed.md'), '# boot-smoke seed\n', 'utf8');
  // PDF fixture lives INSIDE coreDirectory on purpose: it stays a valid subject
  // after the planned rebel-media workspace-containment hardening (the two changes
  // compose — a contained handler still serves files under coreDirectory).
  const pdfPath = path.join(workspaceDir, 'docs', SMOKE_PDF_FILENAME);
  writeFileSync(pdfPath, MINIMAL_PDF_BYTES, 'utf8');
  writeFileSync(
    path.join(userDataDir, 'app-settings.json'),
    JSON.stringify(
      {
        onboardingCompleted: true,
        onboardingFirstCompletedAt: Date.now(),
        coreDirectory: workspaceDir,
      },
      null,
      2,
    ),
    'utf8',
  );
  return { workspaceDir, pdfPath };
}

async function main(): Promise<void> {
  const { timeoutMs, awaitToolsMs, fseventsGateTimeoutMs, pdfGateTimeoutMs, verbose } = parseArgs(process.argv.slice(2));

  // Precondition (exit 2): the packaged binary must exist. Checked up front so a missing
  // build is an unambiguous environment error, not inferred by string-matching a throw.
  const binaryPath = resolvePackagedBinaryPath();
  if (!existsSync(binaryPath)) {
    fail(2, `packaged binary not found at ${binaryPath} — run \`npm run package\` first.`);
  }

  console.log(`[boot-smoke] launching packaged app (timeout ${timeoutMs}ms)…`);

  // Crash sentinels — collected, then evaluated relative to whether we reached ready.
  let crashed: string | null = null;
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  // Captured from prepareProfile (runs before launch) for the post-appReady PDF gate.
  let seededPdfPath: string | null = null;
  let launched: Awaited<ReturnType<typeof launchPackagedApp>>;
  try {
    launched = await launchPackagedApp({
      firstWindowTimeoutMs: timeoutMs,
      prepareProfile: (userDataDir) => {
        const { workspaceDir, pdfPath } = seedSmokeProfile(userDataDir);
        seededPdfPath = pdfPath;
        console.log(`[boot-smoke] seeded smoke workspace at ${workspaceDir} (coreDirectory); PDF fixture at ${pdfPath}`);
      },
    });
  } catch (err) {
    // Binary existence was already verified, so any launch-time throw (firstWindow
    // timeout, spawn failure, crash before window) is a boot failure, not an env error.
    fail(1, `app failed to launch / open a window: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { app, win, close } = launched;
  app.on('close', () => {
    if (!crashed) crashed = 'app process exited before reaching appReady';
  });
  win.on('crash', () => {
    if (!crashed) crashed = 'renderer process crashed (page crash) before reaching appReady';
  });
  win.on('close', () => {
    if (!crashed) crashed = 'window closed before reaching appReady';
  });
  win.on('pageerror', (e) => pageErrors.push(e.message));
  win.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  const readSnapshot = async (): Promise<{ verdict: BootClassification; toolsReady: boolean }> => {
    const snapshot = await win
      .evaluate(() => {
        const e2e = (window as unknown as { e2eApi?: { getReadiness?: () => unknown } }).e2eApi;
        return e2e?.getReadiness ? e2e.getReadiness() : null;
      })
      .catch((e) => {
        // evaluate throws if the page navigated/closed mid-eval — treat as transient
        // unless a crash sentinel already fired.
        if (verbose) console.log(`[boot-smoke] evaluate error (transient): ${String(e)}`);
        return null;
      });
    const toolsReady =
      typeof snapshot === 'object' && snapshot !== null && (snapshot as BootReadiness).toolsReady === true;
    return { verdict: classifyBootReadiness(snapshot), toolsReady };
  };

  const passNow = async (reason: string, extra: string): Promise<never> => {
    const elapsed = Date.now() - started;
    await close().catch(() => {});
    console.log(`[boot-smoke] PASS: ${reason} in ${elapsed}ms (${extra}).`);
    if (pageErrors.length) {
      console.log(`[boot-smoke] (booted OK, but observed ${pageErrors.length} pageerror(s) — diagnostic only): ${pageErrors.slice(0, 3).join(' | ')}`);
    }
    process.exit(0);
  };

  const failIfCrashed = async (where: string): Promise<void> => {
    if (crashed) {
      await close().catch(() => {});
      fail(1, `${crashed} (${where}). Recent pageerrors: ${pageErrors.slice(-3).join(' | ') || 'none'}`);
    }
  };

  // --- fsevents interception gate (PLAN.md 260611_fsevents-shutdown-crash Stage 3a) ---

  /** Marker shape for "the bridge itself is missing" (vs a not-ready-yet snapshot). */
  type FseventsDiagRead = { bridgeMissing: string } | { snapshot: unknown };

  const readFseventsDiagnostics = async (): Promise<FseventsDiagRead> => {
    const result = await win
      .evaluate(async () => {
        const e2e = (window as unknown as {
          e2eApi?: { getFseventsLeakGuardDiagnostics?: () => Promise<unknown> };
        }).e2eApi;
        if (!e2e) return { __bridgeMissing: 'window.e2eApi unavailable' };
        if (typeof e2e.getFseventsLeakGuardDiagnostics !== 'function') {
          return { __bridgeMissing: 'e2eApi.getFseventsLeakGuardDiagnostics not exposed' };
        }
        return { __snapshot: await e2e.getFseventsLeakGuardDiagnostics() };
      })
      .catch((e) => {
        if (verbose) console.log(`[fsevents-gate] evaluate error (transient): ${String(e)}`);
        return null;
      });
    if (result && typeof result === 'object' && '__bridgeMissing' in result) {
      return { bridgeMissing: String((result as { __bridgeMissing: unknown }).__bridgeMissing) };
    }
    if (result && typeof result === 'object' && '__snapshot' in result) {
      return { snapshot: (result as { __snapshot: unknown }).__snapshot };
    }
    return { snapshot: null };
  };

  /**
   * Runs after appReady has settled. Returns a one-line pass summary, or exits:
   *   exit 1 — INTERCEPTION failure (the gate; D-falls signal),
   *   exit 2 — SETUP failure (watcher never started / bridge missing / timeout —
   *            explicitly NOT an interception verdict).
   */
  const runFseventsInterceptionGate = async (): Promise<string> => {
    console.log(`[fsevents-gate] checking packaged fsevents interception (budget ${fseventsGateTimeoutMs}ms)…`);
    const gateStart = Date.now();
    let lastReason = 'no fsevents diagnostics read yet';
    while (Date.now() - gateStart < fseventsGateTimeoutMs) {
      await failIfCrashed('fsevents interception gate');
      const read = await readFseventsDiagnostics();
      if ('bridgeMissing' in read) {
        // The boot already proved e2eApi works (getReadiness), so a missing diagnostic
        // method means the packaged build predates this gate — setup, not interception.
        await close().catch(() => {});
        fail(2, `[fsevents-gate] SETUP FAILURE: ${read.bridgeMissing} — repackage (the build predates the diagnostic).`);
      }
      const verdict = classifyFseventsInterception(read.snapshot);
      lastReason = verdict.reason;
      if (verbose) console.log(`[fsevents-gate] t=${Date.now() - gateStart}ms ${verdict.reason}`);
      if (verdict.ok) {
        console.log(`[boot-smoke] fsevents gate PASS: ${verdict.reason}`);
        return verdict.reason;
      }
      if (verdict.done && verdict.kind === 'interception') {
        // One bounded re-read so a ready-event-vs-instance-registration race can't
        // produce a spurious gate red (instances register synchronously inside
        // fsevents.watch, so one extra second is plenty).
        await win.waitForTimeout(1_000);
        const recheck = await readFseventsDiagnostics();
        const reverdict = 'snapshot' in recheck ? classifyFseventsInterception(recheck.snapshot) : verdict;
        if (reverdict.ok) {
          console.log(`[boot-smoke] fsevents gate PASS (on recheck): ${reverdict.reason}`);
          return reverdict.reason;
        }
        await close().catch(() => {});
        fail(1, `[fsevents-gate] INTERCEPTION FAILURE: ${verdict.reason}`);
      }
      if (verdict.done) {
        await close().catch(() => {});
        fail(2, `[fsevents-gate] SETUP FAILURE: ${verdict.reason}`);
      }
      await win.waitForTimeout(POLL_INTERVAL_MS);
    }
    await close().catch(() => {});
    fail(2, `[fsevents-gate] SETUP FAILURE (timeout after ${fseventsGateTimeoutMs}ms): ${lastReason}`);
  };

  // --- PDF-render-via-protocol gate (PM 260619_pdf_preview_blank_blob_file_origin) -----

  /**
   * Runs after appReady has settled. Drives the PACKAGED renderer (file:// origin) to
   * fetch the seeded PDF over rebel-media:// (a full request and a Range request), then
   * classifies. Returns a one-line pass summary, or exits:
   *   exit 1 — RENDER failure (the gate; the dev_works_packaged_fails class — the packaged
   *            renderer cannot obtain the PDF over the privileged protocol),
   *   exit 2 — SETUP failure (seed fixture missing / evaluate bridge gone / timeout —
   *            explicitly NOT a render verdict).
   * Platform-agnostic (unlike the darwin-only fsevents gate): the protocol fetch is the
   * same on every OS the app ships to.
   */
  const runPdfRenderGate = async (): Promise<string> => {
    const fixture = seededPdfPath;
    if (!fixture || !existsSync(fixture)) {
      await close().catch(() => {});
      fail(2, `[pdf-gate] SETUP FAILURE: seeded PDF fixture missing (${fixture ?? 'null'}) — seedSmokeProfile did not run; not a render verdict.`);
    }
    // The REAL production URL builder — exercises the actual rebel-media://local/... shape
    // the document-editor preview emits (incl. the space + percent in the fixture name).
    const pdfUrl = getMediaProtocolUrl(fixture, path.dirname(fixture));
    console.log(`[pdf-gate] checking packaged rebel-media:// PDF fetch (budget ${pdfGateTimeoutMs}ms)…`);
    if (verbose) console.log(`[pdf-gate] url: ${pdfUrl}`);
    const gateStart = Date.now();
    let lastReason = 'no pdf probe read yet';

    // The probe must always terminate (F1, stage review): a hung protocol response would
    // otherwise wedge the smoke past every documented exit code. Two bounds:
    //  (a) an in-renderer AbortController times out each fetch (a hung body → fetchError →
    //      a RENDER verdict (exit 1), which is the correct "renderer cannot obtain the PDF"
    //      classification — not a silent hang); and
    //  (b) a host-side race bounds the win.evaluate call itself, so a wedged renderer can't
    //      hang the polling loop (returns null → keep polling, bounded by pdfGateTimeoutMs).
    const probe = async (): Promise<unknown> => {
      const evalPromise = win
        .evaluate(
          async ({ url, fetchTimeoutMs }: { url: string; fetchTimeoutMs: number }) => {
            const out: {
              full?: { status: number; contentType: string | null; byteLength: number };
              range?: { status: number; contentType: string | null; contentRange: string | null; byteLength: number };
              fetchError?: string;
            } = {};
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), fetchTimeoutMs);
            try {
              const fullResp = await fetch(url, { signal: ctrl.signal });
              const fullBuf = await fullResp.arrayBuffer();
              out.full = { status: fullResp.status, contentType: fullResp.headers.get('content-type'), byteLength: fullBuf.byteLength };
              const rangeResp = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: ctrl.signal });
              const rangeBuf = await rangeResp.arrayBuffer();
              out.range = {
                status: rangeResp.status,
                contentType: rangeResp.headers.get('content-type'),
                contentRange: rangeResp.headers.get('content-range'),
                byteLength: rangeBuf.byteLength,
              };
            } catch (e) {
              out.fetchError = e instanceof Error ? e.message : String(e);
            } finally {
              clearTimeout(timer);
            }
            return out;
          },
          { url: pdfUrl, fetchTimeoutMs: PDF_PROBE_FETCH_TIMEOUT_MS },
        )
        .catch((e) => {
          if (verbose) console.log(`[pdf-gate] evaluate error (transient): ${String(e)}`);
          return null;
        });
      // Host-side bound (b): if evaluate itself never resolves (wedged renderer), don't hang
      // the loop — resolve null (transient → keep polling; the outer loop enforces the budget).
      let hostTimer: ReturnType<typeof setTimeout> | undefined;
      const hostTimeout = new Promise<null>((resolve) => {
        hostTimer = setTimeout(() => {
          if (verbose) console.log('[pdf-gate] host-side evaluate timeout (transient)');
          resolve(null);
        }, PDF_PROBE_FETCH_TIMEOUT_MS + 5_000);
      });
      const result = await Promise.race([evalPromise, hostTimeout]);
      if (hostTimer) clearTimeout(hostTimer);
      return result;
    };

    while (Date.now() - gateStart < pdfGateTimeoutMs) {
      await failIfCrashed('pdf-render gate');
      const verdict = classifyRebelMediaPdfFetch(await probe());
      lastReason = verdict.reason;
      if (verbose) console.log(`[pdf-gate] t=${Date.now() - gateStart}ms ${verdict.reason}`);
      if (verdict.ok) {
        console.log(`[boot-smoke] pdf gate PASS: ${verdict.reason}`);
        return verdict.reason;
      }
      if (verdict.done && verdict.kind === 'render') {
        // One bounded re-read so a handler-startup-vs-probe race can't produce a spurious red.
        await win.waitForTimeout(1_000);
        const recheck = classifyRebelMediaPdfFetch(await probe());
        if (recheck.ok) {
          console.log(`[boot-smoke] pdf gate PASS (on recheck): ${recheck.reason}`);
          return recheck.reason;
        }
        await close().catch(() => {});
        fail(1, `[pdf-gate] RENDER FAILURE: ${verdict.reason}`);
      }
      if (verdict.done) {
        await close().catch(() => {});
        fail(2, `[pdf-gate] SETUP FAILURE: ${verdict.reason}`);
      }
      await win.waitForTimeout(POLL_INTERVAL_MS);
    }
    await close().catch(() => {});
    fail(2, `[pdf-gate] SETUP FAILURE (timeout after ${pdfGateTimeoutMs}ms): ${lastReason}`);
  };

  const started = Date.now();
  let lastReason = 'no readiness snapshot read yet';
  try {
    while (Date.now() - started < timeoutMs) {
      await failIfCrashed('before appReady');
      const { verdict } = await readSnapshot();
      lastReason = verdict.reason;
      if (verbose) console.log(`[boot-smoke] t=${Date.now() - started}ms ${verdict.reason}`);

      if (verdict.ok) {
        // Settle window: ready must HOLD (no crash, no degraded transition) for SETTLE_MS
        // before we trust the boot. Catches flip-ready-then-crash builds.
        const settleEnd = Date.now() + SETTLE_MS;
        while (Date.now() < settleEnd) {
          await win.waitForTimeout(POLL_INTERVAL_MS);
          await failIfCrashed(`${SETTLE_MS}ms settle window`);
          const { verdict: recheck } = await readSnapshot();
          if (!recheck.ok && recheck.done) {
            await close().catch(() => {});
            fail(1, `degraded during settle window after first appReady: ${recheck.reason}`);
          }
          // A transient not-ready re-read (e.g. evaluate race) doesn't fail; we only
          // require no crash and no terminal-degraded state across the window.
        }

        // GATING fsevents interception assertion (Stage 3a) — runs after ready has
        // settled; exits 1 (interception failure) / 2 (setup failure) on red.
        const fseventsGateSummary = await runFseventsInterceptionGate();

        // GATING PDF-render-via-protocol assertion (PM 260619) — proves a packaged
        // file:// renderer can obtain a PDF over rebel-media://; exits 1 (render failure)
        // / 2 (setup failure) on red. Platform-agnostic.
        const pdfGateSummary = await runPdfRenderGate();

        // Optional await-tools window: watch for the Super-MCP startup outcome so the
        // test-mode superMcpStartupFailed signal (which fires only after retries exhaust)
        // is actually observed. Fail only on an explicit terminal-degraded signal; a
        // slow/never-ready Super-MCP just elapses the window → pass (no flaky false-red).
        if (awaitToolsMs > 0) {
          const awaitEnd = Date.now() + awaitToolsMs;
          while (Date.now() < awaitEnd) {
            await failIfCrashed(`${awaitToolsMs}ms await-tools window`);
            const { verdict: w, toolsReady } = await readSnapshot();
            if (!w.ok && w.done) {
              await close().catch(() => {});
              fail(1, `degraded during await-tools window: ${w.reason}`);
            }
            if (toolsReady) {
              await passNow(verdict.reason, `held ready ${SETTLE_MS}ms; Super-MCP toolsReady; fsevents gate: ${fseventsGateSummary}; pdf gate: ${pdfGateSummary}`);
            }
            await win.waitForTimeout(POLL_INTERVAL_MS);
          }
          await passNow(verdict.reason, `held ready ${SETTLE_MS}ms; no Super-MCP failure within ${awaitToolsMs}ms; fsevents gate: ${fseventsGateSummary}; pdf gate: ${pdfGateSummary}`);
        }
        await passNow(verdict.reason, `held ready ${SETTLE_MS}ms; fsevents gate: ${fseventsGateSummary}; pdf gate: ${pdfGateSummary}`);
      }
      if (!verdict.ok && verdict.done) {
        await close().catch(() => {});
        fail(1, verdict.reason);
      }
      await win.waitForTimeout(POLL_INTERVAL_MS);
    }
  } finally {
    await close().catch(() => {});
  }

  // Timed out without reaching appReady — dump diagnostics.
  const diag = [
    `last: ${lastReason}`,
    crashed ? `crash: ${crashed}` : null,
    pageErrors.length ? `pageerrors: ${pageErrors.slice(-3).join(' | ')}` : null,
    consoleErrors.length ? `console.errors: ${consoleErrors.slice(-3).join(' | ')}` : null,
  ]
    .filter(Boolean)
    .join('; ');
  fail(1, `app did not reach appReady within ${timeoutMs}ms. ${diag}`);
}

if (require.main === module) {
  void main().catch((err) => {
    fail(1, `unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  });
}
