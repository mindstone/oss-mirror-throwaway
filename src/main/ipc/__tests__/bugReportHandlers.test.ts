/**
 * Integration tests for the enriched bug report handler pipeline.
 *
 * Verifies the full background flow:
 *   IPC accept → Phase A gathering → Phase B LLM analysis → Sentry submission → toast broadcasts
 *
 * All external dependencies (Sentry, BTS, diagnostics, logs) are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { collectSerdeStrictnessIssues } from '@shared/utils/sentrySerdeStrictness';

// ── Mocks (must be before imports) ──────────────────────────────────────────

// Scope-level captureMessage(message, level, { event_id }) is the capture path
// now (the caller-supplied event_id is honored there, NOT on the top-level
// helper). Tests assert on `mockScopeCaptureMessage`.
const mockScopeCaptureMessage = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(true);
const mockWithScope = vi.fn().mockImplementation((callback: (scope: unknown) => void) => {
  const scope = {
    setTag: vi.fn(),
    setExtra: vi.fn(),
    setLevel: vi.fn(),
    setFingerprint: vi.fn(),
    addAttachment: vi.fn(),
    captureMessage: mockScopeCaptureMessage,
  };
  callback(scope);
  return scope;
});

vi.mock('@sentry/electron/main', () => ({
  flush: mockFlush,
  withScope: mockWithScope,
}));

const mockLog = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLog,
}));

const mockBroadcast = vi.fn();
vi.mock('../../utils/broadcastHelpers', () => ({
  broadcastToAllWindows: (...args: unknown[]) => mockBroadcast(...args),
}));

const mockGatherDiagnostics = vi.fn();
const mockGatherUpdateForensics = vi.fn();
const mockAttachUpdateForensicsToScope = vi.fn();
vi.mock('../../services/bugReportDiagnosticService', () => ({
  gatherDeterministicDiagnostics: (...args: unknown[]) => mockGatherDiagnostics(...args),
  gatherUpdateForensics: (...args: unknown[]) => mockGatherUpdateForensics(...args),
  attachUpdateForensicsToScope: (...args: unknown[]) => mockAttachUpdateForensicsToScope(...args),
}));

const mockAnalyzeBugReport = vi.fn();
const mockBuildFallbackDiagnosticSummary = vi.fn();
vi.mock('../../services/bugReportAnalysisService', () => ({
  analyzeBugReport: (...args: unknown[]) => mockAnalyzeBugReport(...args),
  buildFallbackDiagnosticSummary: (...args: unknown[]) =>
    mockBuildFallbackDiagnosticSummary(...args),
}));

const mockExportRecentLogs = vi.fn();
vi.mock('../../services/logExportService', () => ({
  exportRecentLogs: (...args: unknown[]) => mockExportRecentLogs(...args),
}));

vi.mock('../../services/shutdownState', () => ({
  isShuttingDown: vi.fn().mockReturnValue(false),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: vi.fn().mockReturnValue({ behindTheScenesModel: 'claude-haiku-4-5' }),
}));

// The durable outbox (Stage 4) persists records under getDataPath()/bug-report-
// outbox. Point it at an isolated temp dir so these handler tests write to a
// throwaway location. getDataPath must be present or the outbox constructor
// throws (path.join on undefined).
const TEST_OUTBOX_ROOT = path.join(os.tmpdir(), `bug-report-handlers-test-${process.pid}`);
// Per-test outbox root. The handler fires `void drain('enqueue')` and does NOT
// await delivery, so under concurrent CI load (real fs lags) a test's immediate
// drain can outlive the test's tick/settle and leak into the next test. With a
// SHARED dir that leaked drain would readdir the next test's record and submit
// it alongside that test's own drain — two outbox instances on one dir, no
// coalescing → double delivery (the pre-existing `toHaveBeenCalledTimes(1)` →
// got 2 flake). A fresh per-test subdir pins each outbox (its `dir` is read once
// at construction) to its own directory, so a leaked drain can never see a later
// test's record. `getDataPath` is re-established each test by the vi.resetModules
// + re-import in beforeEach (which re-runs this factory), reading the live value.
let outboxDirCounter = 0;
let currentTestDataRoot = TEST_OUTBOX_ROOT;
vi.mock('../../utils/dataPaths', () => ({
  getAppVersion: vi.fn().mockReturnValue('1.2.3-test'),
  getDataPath: vi.fn(() => currentTestDataRoot),
}));

vi.mock('../../services/superMcpHttpManager', () => ({
  superMcpHttpManager: { getState: () => ({ isRunning: false, url: null }) },
}));

vi.mock('../../services/coreStartup', () => ({
  getMcpRegistrationStatus: vi.fn().mockReturnValue({
    lifecycle: 'idle',
    registered: [],
    gated: [],
    failed: [],
  }),
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn(),
}));

const mockIsMainSentryEnabled = vi.fn().mockReturnValue(true);
const mockGetMainSentryDisabledReason = vi.fn().mockReturnValue(null);
const mockGetSendOutcome = vi.fn().mockReturnValue({
  eventId: 'mock-sentry-event-id',
  statusCode: 200,
  recordedAt: 1,
});
vi.mock('../../sentry', () => ({
  getSendOutcome: (...args: unknown[]) => mockGetSendOutcome(...args),
  isMainSentryEnabled: (...args: unknown[]) => mockIsMainSentryEnabled(...args),
  getMainSentryDisabledReason: (...args: unknown[]) => mockGetMainSentryDisabledReason(...args),
}));

vi.mock('@core/utils/logFieldFilter', () => ({
  sanitizeLogMessage: vi.fn((v: string) => v),
}));

// ── Imports ─────────────────────────────────────────────────────────────────

import { registerHandler } from '../utils/registerHandler';
import { isShuttingDown } from '../../services/shutdownState';
import type { DeterministicDiagnostics } from '../../services/bugReportDiagnosticService';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeDiagnostics(overrides?: Partial<DeterministicDiagnostics>): DeterministicDiagnostics {
  return {
    health: { status: 'healthy', failedChecks: [], warnChecks: [] },
    filteredLogs: [{ filename: 'app.log', lineCount: 5, filteredContent: '{"level":30,"msg":"ok"}' }],
    errorPatterns: [],
    recentSessions: [],
    storeStats: { cleanExitFlag: null, autoUpdateState: null },
    ...overrides,
  } as unknown as DeterministicDiagnostics;
}

/**
 * The freshly-imported bugReportHandlers module from the most recent
 * loadAndGetHandler(). Liveness tests use its `getBugReportOutboxForTest` to
 * deterministically await the outbox drain (the handler intentionally does NOT
 * await delivery).
 */
let currentMod: typeof import('../bugReportHandlers') | null = null;

/** Import the module (triggers registerBugReportHandlers side effect capture) */
async function loadAndGetHandler() {
  const mod = await import('../bugReportHandlers');
  currentMod = mod;
  mod.registerBugReportHandlers();
  const calls = vi.mocked(registerHandler).mock.calls;
  const submitBugCall = calls.find(([ch]) => ch === 'bug-report:submit-bug');
  if (!submitBugCall) throw new Error('submit-bug handler not registered');
  return submitBugCall[1] as (event: unknown, request: unknown) => Promise<unknown>;
}

/** Wait for background task to settle */
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deterministically await the real-timer delivery drain to quiescence. The
 * handler returns `accepted` after awaiting `enqueue()`, which fires the
 * delivery as `void drain('enqueue')` and does NOT await it. A fixed `tick(...)`
 * races that drain: under concurrent CI load it can finish LATE (the assertion
 * sees 0 calls) or LATER STILL — bleeding into the next test and inflating a
 * shared mock's count (the `toHaveBeenCalledTimes(1)` → 2 flake). Awaiting the
 * coalesced drain instead makes the delivery side-effects (capture, forensics
 * attach) deterministic. Used by tests that assert exact delivery call counts.
 */
const settleRealDelivery = (): Promise<void> =>
  currentMod!.getBugReportOutboxForTest().drain('test');

/**
 * Real `setImmediate`, captured at module-eval time — BEFORE any
 * `vi.useFakeTimers()` install replaces the global. The fake-timer liveness
 * tests pump the outbox drain, which mixes faked `setTimeout` deadlines (the
 * enrichment `withTimeout` budgets) with REAL `fs/promises` I/O
 * (readdir/readFile/rename). `vi.advanceTimersByTimeAsync()` + a microtask flush
 * advance fake timers but are NOT a reliable yield for real fs completions, so
 * we interleave a real event-loop turn via this saved scheduler. Calling the
 * saved reference (not the patched global) is not intercepted by the fake clock.
 */
const realSetImmediate = globalThis.setImmediate;
const yieldRealIo = (): Promise<void> => new Promise((resolve) => realSetImmediate(resolve));

type BugReportStatusPayload = { status: string; reason?: string };

const getBugReportStatusPayloads = (): BugReportStatusPayload[] =>
  mockBroadcast.mock.calls
    .filter(([channel]) => channel === 'bug-report:status')
    .map(([, payload]) => payload as BugReportStatusPayload);

const getBugReportStatuses = (): string[] =>
  getBugReportStatusPayloads().map((payload) => payload.status);

// ── Tests ───────────────────────────────────────────────────────────────────

interface CapturedAttachment {
  filename: string;
  contentType: string;
  byteLength: number;
}

const capturedAttachments: CapturedAttachment[] = [];

interface CapturedTag {
  key: string;
  value: unknown;
}

const capturedTags: CapturedTag[] = [];

/** Fingerprint arrays passed to scope.setFingerprint, in call order. */
const capturedFingerprints: string[][] = [];

/** 32-char lowercase hex — a valid Sentry event_id (not a dashed UUID). */
const EVENT_ID_HEX = /^[0-9a-f]{32}$/;

/** UUID v4 shape — the per-report `report_id` minted at handler entry. */
const REPORT_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('bug-report:submit-bug handler', () => {
  let handler: (event: unknown, request: unknown) => Promise<unknown>;

  beforeEach(async () => {
    // resetAllMocks clears call records AND implementations (not just call records)
    vi.resetAllMocks();

    // Re-establish all mock implementations after reset.
    // captureMessage now returns void (the SDK assigns the supplied event_id);
    // the outcome mock echoes whatever eventId was passed to getSendOutcome.
    mockScopeCaptureMessage.mockReturnValue(undefined);
    mockFlush.mockResolvedValue(true);
    mockGetSendOutcome.mockImplementation((eventId?: string) => ({
      eventId,
      statusCode: 200,
      recordedAt: 1,
    }));
    capturedAttachments.length = 0;
    capturedTags.length = 0;
    capturedFingerprints.length = 0;
    mockWithScope.mockImplementation((callback: (scope: unknown) => void) => {
      const scope = {
        setTag: vi.fn((key: string, value: unknown) => {
          capturedTags.push({ key, value });
        }),
        setExtra: vi.fn(),
        setLevel: vi.fn(),
        setFingerprint: vi.fn((fingerprint: string[]) => {
          capturedFingerprints.push(fingerprint);
        }),
        captureMessage: mockScopeCaptureMessage,
        addAttachment: vi.fn((attachment: { filename: string; data: unknown; contentType: string }) => {
          capturedAttachments.push({
            filename: attachment.filename,
            contentType: attachment.contentType,
            byteLength:
              attachment.data instanceof Uint8Array
                ? attachment.data.byteLength
                : typeof attachment.data === 'string'
                  ? new TextEncoder().encode(attachment.data).byteLength
                  : 0,
          });
        }),
      };
      callback(scope);
      return scope;
    });

    mockIsMainSentryEnabled.mockReturnValue(true);
    mockGetMainSentryDisabledReason.mockReturnValue(null);
    mockGatherDiagnostics.mockResolvedValue(makeDiagnostics());
    mockAnalyzeBugReport.mockResolvedValue('## Likely Root Cause\nSomething broke');
    mockBuildFallbackDiagnosticSummary.mockReturnValue(
      '# Deterministic Diagnostic Summary\n\n(stub built from Phase A diagnostics)',
    );
    mockGatherUpdateForensics.mockResolvedValue({
      attachments: [
        { filename: 'auto-update-state.json', data: '{"ok":true}', contentType: 'application/json' },
      ],
      manifest: [{ filename: 'auto-update-state.json', status: 'attached' }],
    });
    mockAttachUpdateForensicsToScope.mockReturnValue(undefined);
    mockExportRecentLogs.mockResolvedValue({
      files: [{ filename: 'app.log', content: '{"msg":"test"}', lineCount: 1 }],
      totalLines: 1,
      timeWindow: { start: '', end: '' },
    });

    // Fresh, unique per-test outbox dir (see the getDataPath mock): isolates a
    // drain leaked by a prior test (which the shared dir let re-submit THIS
    // test's record → double delivery) onto its own directory.
    currentTestDataRoot = path.join(TEST_OUTBOX_ROOT, `t${++outboxDirCounter}`);
    await fsp.rm(currentTestDataRoot, { recursive: true, force: true });

    // Re-import to reset module-level bugReportInFlight flag AND the outbox
    // singleton (vi.resetModules gives a fresh module with bugReportOutbox=null).
    vi.resetModules();
    handler = await loadAndGetHandler();
  });

  afterEach(async () => {
    // Cross-test leak guard. The handler fires delivery as `void drain('enqueue')`
    // and returns `accepted` WITHOUT awaiting it (the accept contract). Tests that
    // assert exact delivery side-effects now await `settleRealDelivery()`, but the
    // looser flow tests still wait on a fixed `tick(...)`. Under concurrent CI load
    // a slow sibling drain can outlive its `tick` and call a shared module-level
    // mock (e.g. mockAttachUpdateForensicsToScope) AFTER the next test's
    // `vi.resetAllMocks()`, inflating its call count — the observed
    // `toHaveBeenCalledTimes(1)` → 2 flake. Awaiting the coalesced drain here
    // settles any in-flight delivery before we reset, so no async work crosses
    // the test boundary. `drain('test')` coalesces with the in-flight enqueue
    // drain (the handler awaits enqueue, which fires that drain before it
    // resolves), so this never starts duplicate delivery.
    //
    // INVARIANT: this guard awaits delivery to QUIESCENCE, so a real-timer test
    // whose delivery never settles (a hung enrichment await, a flush that never
    // resolves) would hang it. Such liveness repros MUST live in the separate
    // fake-timer `hard-bounded enrichment (liveness)` describe below, which pumps
    // the drain under a bounded fake-timer budget instead.
    await currentMod?.getBugReportOutboxForTest().drain('test');
    vi.restoreAllMocks();
    await fsp.rm(currentTestDataRoot, { recursive: true, force: true });
  });

  it('returns accepted immediately', async () => {
    const result = await handler(null, {
      description: 'Something broke',
      urgency: 'medium',
    });
    expect(result).toEqual({ outcome: 'accepted' });
  });

  it('broadcasts queued then delivery-unavailable (reason no-dsn) when the build shipped without a DSN', async () => {
    mockIsMainSentryEnabled.mockReturnValue(false);
    mockGetMainSentryDisabledReason.mockReturnValue('no-dsn');

    await handler(null, { description: 'Something broke', urgency: 'medium' });
    await tick(100);

    // Stage 5: the durable write fires the positive `queued` toast; the outbox's
    // disabled-drain then surfaces the honest `delivery-unavailable` with the
    // report text for the Copy-report action (no dev-mode mention in copy).
    expect(getBugReportStatusPayloads()).toEqual([
      { status: 'queued' },
      { status: 'delivery-unavailable', reason: 'no-dsn', reportText: 'Something broke' },
    ]);
    // The log must NOT claim "development mode" when the cause is a missing DSN.
    // (Structured pino call: `log.warn({ trigger }, 'message')`.)
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'enqueue' }),
      expect.stringContaining('no DSN'),
    );
  });

  it('broadcasts queued then delivery-unavailable (reason env-disabled) when SENTRY_ENABLED turned Sentry off', async () => {
    mockIsMainSentryEnabled.mockReturnValue(false);
    mockGetMainSentryDisabledReason.mockReturnValue('env-disabled');

    await handler(null, { description: 'Something broke', urgency: 'medium' });
    await tick(100);

    expect(getBugReportStatusPayloads()).toEqual([
      { status: 'queued' },
      { status: 'delivery-unavailable', reason: 'env-disabled', reportText: 'Something broke' },
    ]);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'enqueue' }),
      expect.stringContaining('SENTRY_ENABLED'),
    );
  });

  it('broadcasts queued on submit then delivered (silent upgrade) on success', async () => {
    await handler(null, { description: 'Something broke', urgency: 'medium' });
    await tick(200);

    const statuses = getBugReportStatuses();

    // Stage 5: no `gathering` (per-attempt noise removed); positive `queued` on
    // the durable write, then a SILENT `delivered` upgrade on confirmed 2xx.
    expect(statuses).not.toContain('gathering');
    expect(statuses).toContain('queued');
    expect(statuses).toContain('delivered');
  });

  it('broadcasts delivered when Sentry flushes and reports a 2xx transport outcome', async () => {
    mockFlush.mockResolvedValue(true);

    await handler(null, { description: 'Something broke', urgency: 'medium' });
    await tick(200);

    expect(mockFlush).toHaveBeenCalledWith(5000);
    expect(mockGetSendOutcome).toHaveBeenCalledWith(expect.stringMatching(EVENT_ID_HEX));
    expect(getBugReportStatuses()).toContain('delivered');
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: expect.stringMatching(EVENT_ID_HEX),
        statusCode: 200,
        totalAttachmentBytes: expect.any(Number),
      }),
      'Bug report accepted by Sentry transport (2xx — delivery not confirmed; processing may still reject)'
    );
  });

  it('does NOT toast on a transient 4xx transport outcome (retried silently; logs statusCode)', async () => {
    mockFlush.mockResolvedValue(true);
    mockGetSendOutcome.mockImplementation((eventId?: string) => ({
      eventId,
      statusCode: 413,
      recordedAt: 1,
    }));

    await handler(null, { description: 'Something broke', urgency: 'medium' });
    await tick(200);

    // Stage 5: a transient transport failure is background retry work — only the
    // positive `queued` toast fired; no `failed`/`delivery-unavailable` until the
    // record dead-letters after retries are exhausted.
    const statuses = getBugReportStatuses();
    expect(statuses).toContain('queued');
    expect(statuses).not.toContain('failed');
    expect(statuses).not.toContain('delivery-unavailable');
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: expect.stringMatching(EVENT_ID_HEX),
        statusCode: 413,
        totalAttachmentBytes: expect.any(Number),
        reason: 'transport-rejected',
      }),
      'Bug report rejected by Sentry transport'
    );
  });

  it('does NOT toast when Sentry flushes but no transport outcome is recorded (retried silently)', async () => {
    mockFlush.mockResolvedValue(true);
    mockGetSendOutcome.mockReturnValue(undefined);

    await handler(null, { description: 'Something broke', urgency: 'medium' });
    await tick(200);

    const statuses = getBugReportStatuses();
    expect(statuses).toContain('queued');
    expect(statuses).not.toContain('failed');
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: expect.stringMatching(EVENT_ID_HEX),
        totalAttachmentBytes: expect.any(Number),
        reason: 'transport-outcome-unknown',
      }),
      'Bug report Sentry transport outcome unknown'
    );
  });

  it('does NOT toast when Sentry flush times out (retried silently)', async () => {
    mockFlush.mockResolvedValue(false);

    await handler(null, { description: 'Something broke', urgency: 'medium' });
    await tick(200);

    expect(mockGetSendOutcome).not.toHaveBeenCalled();
    const statuses = getBugReportStatuses();
    expect(statuses).toContain('queued');
    expect(statuses).not.toContain('failed');
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: expect.stringMatching(EVENT_ID_HEX),
        totalAttachmentBytes: expect.any(Number),
        reason: 'transport-outcome-unknown',
      }),
      'Bug report Sentry transport outcome unknown'
    );
  });

  it('calls Sentry scope.captureMessage with bug report title/body and the minted event_id', async () => {
    await handler(null, { description: 'MCP tool timed out', urgency: 'high' });
    await tick(200);

    expect(mockScopeCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('MCP tool timed out'),
      'error',
      expect.objectContaining({ event_id: expect.stringMatching(EVENT_ID_HEX) }),
    );
  });

  it('keeps bug report title truncation serde-safe when an emoji straddles the title boundary', async () => {
    const boundaryDescription = `${'a'.repeat(118)}😀 this tail pushes beyond the title cap`;

    await handler(null, { description: boundaryDescription, urgency: 'high' });
    await tick(200);

    const payload = String(mockScopeCaptureMessage.mock.calls[0]?.[0] ?? '');
    const issues = collectSerdeStrictnessIssues(JSON.stringify({ message: payload }));
    expect(issues.loneSurrogateEscapes).toHaveLength(0);
    expect(issues.rawLoneSurrogates).toHaveLength(0);
    expect(payload).not.toContain('\uFFFD');
  });

  it('calls gatherDeterministicDiagnostics when enriched diagnostics enabled', async () => {
    await handler(null, {
      description: 'Something broke',
      urgency: 'medium',
      includeEnrichedDiagnostics: true,
    });
    await tick(200);

    expect(mockGatherDiagnostics).toHaveBeenCalled();
  });

  it('honors an explicit diagnosticSections=false on the IMMEDIATE attempt (consent — F3)', async () => {
    // The user unchecked the "recent_logs" section. Persisting + threading the
    // toggle map means the very first (immediate) attempt must pass that
    // explicit `false` down to gatherDeterministicDiagnostics — NOT silently
    // gather it anyway (the consent/privacy regression Stage-4 review F3 found).
    await handler(null, {
      description: 'Something broke',
      urgency: 'medium',
      includeEnrichedDiagnostics: true,
      diagnosticSections: { recent_logs: false, provider_reachability: true },
    });
    await tick(200);

    expect(mockGatherDiagnostics).toHaveBeenCalled();
    const optsArg = mockGatherDiagnostics.mock.calls[0]?.[1] as
      | { diagnosticSections?: Record<string, boolean> }
      | undefined;
    expect(optsArg?.diagnosticSections).toEqual({ recent_logs: false, provider_reachability: true });
  });

  it('calls analyzeBugReport when enriched diagnostics enabled', async () => {
    await handler(null, {
      description: 'Something broke',
      urgency: 'medium',
      includeEnrichedDiagnostics: true,
    });
    await tick(200);

    expect(mockAnalyzeBugReport).toHaveBeenCalledWith(
      expect.objectContaining({
        bugDescription: 'Something broke',
        urgency: 'medium',
      }),
    );
  });

  it('skips enriched diagnostics when flag is false', async () => {
    await handler(null, {
      description: 'Quick report',
      urgency: 'low',
      includeEnrichedDiagnostics: false,
    });
    await tick(200);

    expect(mockGatherDiagnostics).not.toHaveBeenCalled();
    expect(mockAnalyzeBugReport).not.toHaveBeenCalled();
    // Should still send to Sentry
    expect(mockScopeCaptureMessage).toHaveBeenCalled();
  });

  it('forces enriched diagnostics when attachContinuityDiagnostics is true', async () => {
    await handler(null, {
      description: 'Continuity issue',
      urgency: 'high',
      includeEnrichedDiagnostics: false,
      attachContinuityDiagnostics: true,
    });
    await tick(200);

    expect(mockGatherDiagnostics).toHaveBeenCalled();
    expect(mockAnalyzeBugReport).toHaveBeenCalled();
  });

  it('degrades gracefully when Phase A fails', async () => {
    mockGatherDiagnostics.mockRejectedValue(new Error('disk error'));

    await handler(null, { description: 'Something broke', urgency: 'medium' });
    await tick(200);

    // Should still send to Sentry (without diagnostics)
    expect(mockScopeCaptureMessage).toHaveBeenCalled();
    const statuses = mockBroadcast.mock.calls
      .filter((call: any[]) => call[0] === 'bug-report:status')
      .map((call: any[]) => call[1].status);
    expect(statuses).toContain('delivered');
  });

  it('degrades gracefully when Phase B fails', async () => {
    mockAnalyzeBugReport.mockRejectedValue(new Error('LLM timeout'));

    await handler(null, { description: 'Something broke', urgency: 'medium' });
    await tick(200);

    // Should still send to Sentry (with Phase A data but no LLM summary)
    expect(mockScopeCaptureMessage).toHaveBeenCalled();
    const statuses = mockBroadcast.mock.calls
      .filter((call: any[]) => call[0] === 'bug-report:status')
      .map((call: any[]) => call[1].status);
    expect(statuses).toContain('delivered');
  });

  // REBEL-4GH / FOX-3152 Fix C: when the LLM analyzer is rate-limited or
  // otherwise unavailable, the deterministic stub from Phase A must still
  // produce a `diagnostic-summary.md` attachment so triage is never blocked.
  it('attaches LLM-generated diagnostic-summary.md when analyzeBugReport succeeds', async () => {
    mockAnalyzeBugReport.mockResolvedValue('## Likely Root Cause\nReal LLM analysis output');

    await handler(null, {
      description: 'Something broke',
      urgency: 'medium',
      includeEnrichedDiagnostics: true,
    });
    await settleRealDelivery();

    const diagSummary = capturedAttachments.find((a) => a.filename === 'diagnostic-summary.md');
    expect(diagSummary).toBeDefined();
    expect(diagSummary?.contentType).toBe('text/markdown');
    // Fallback builder should NOT have been called on the happy path.
    expect(mockBuildFallbackDiagnosticSummary).not.toHaveBeenCalled();
  });

  it('attaches deterministic fallback diagnostic-summary.md when analyzeBugReport returns null', async () => {
    mockAnalyzeBugReport.mockResolvedValue(null);

    await handler(null, {
      description: 'Something broke',
      urgency: 'high',
      includeEnrichedDiagnostics: true,
    });
    await settleRealDelivery();

    const diagSummary = capturedAttachments.find((a) => a.filename === 'diagnostic-summary.md');
    expect(diagSummary).toBeDefined();
    expect(diagSummary?.contentType).toBe('text/markdown');
    expect(mockBuildFallbackDiagnosticSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        bugDescription: 'Something broke',
        urgency: 'high',
        reason: 'llm_failed',
      }),
    );
  });

  it('attaches deterministic fallback diagnostic-summary.md when analyzeBugReport throws', async () => {
    mockAnalyzeBugReport.mockRejectedValue(new Error('429 usage_limit_reached'));

    await handler(null, {
      description: 'Bug report fired during quota cap',
      urgency: 'medium',
      includeEnrichedDiagnostics: true,
    });
    await settleRealDelivery();

    const diagSummary = capturedAttachments.find((a) => a.filename === 'diagnostic-summary.md');
    expect(diagSummary).toBeDefined();
    expect(mockBuildFallbackDiagnosticSummary).toHaveBeenCalled();
  });

  it('attaches deterministic fallback when app is shutting down (Phase B is skipped)', async () => {
    vi.mocked(isShuttingDown).mockReturnValue(true);

    await handler(null, {
      description: 'Shutdown bug',
      urgency: 'medium',
      includeEnrichedDiagnostics: true,
    });
    await settleRealDelivery();

    const diagSummary = capturedAttachments.find((a) => a.filename === 'diagnostic-summary.md');
    expect(diagSummary).toBeDefined();
    expect(mockBuildFallbackDiagnosticSummary).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'llm_skipped_shutdown' }),
    );
  });

  it('skips Phase B when app is shutting down', async () => {
    vi.mocked(isShuttingDown).mockReturnValue(true);

    await handler(null, { description: 'Something broke', urgency: 'medium' });
    await tick(200);

    expect(mockAnalyzeBugReport).not.toHaveBeenCalled();
    // Phase A should still run, and report should still send
    expect(mockGatherDiagnostics).toHaveBeenCalled();
    expect(mockScopeCaptureMessage).toHaveBeenCalled();
  });

  it('accepts back-to-back submissions (each durably persisted independently)', async () => {
    // Stage 4 contract change: the in-flight guard now wraps only the fast
    // durable enqueue, not the whole delivery (delivery is owned by the outbox
    // and serialized there with concurrency 1). Two reports submitted in
    // sequence must BOTH be accepted and BOTH persisted — rejecting the second
    // would risk losing a report, the exact class of bug this work fixes.
    const r1 = await handler(null, { description: 'First report', urgency: 'medium' });
    const r2 = await handler(null, { description: 'Second report', urgency: 'low' });

    expect(r1).toEqual({ outcome: 'accepted' });
    expect(r2).toEqual({ outcome: 'accepted' });

    await tick(200);
  });

  it('accepts a subsequent submission after the prior one completes', async () => {
    await handler(null, { description: 'First', urgency: 'medium' });
    await tick(200);

    const result = await handler(null, { description: 'Second', urgency: 'low' });
    expect(result).toEqual({ outcome: 'accepted' });

    await tick(200);
  });

  it('keeps the report queued and does NOT toast failure when a single Sentry capture throws (retried silently)', async () => {
    mockScopeCaptureMessage.mockImplementation(() => {
      throw new Error('Sentry down');
    });

    await handler(null, { description: 'Something broke', urgency: 'medium' });
    await tick(200);

    // Stage 5: a transient capture throw is a background retry, not a user-facing
    // failure. The positive `queued` toast fired on the durable write; the report
    // stays on disk and retries. Only a terminal dead-letter (retries exhausted)
    // surfaces `delivery-unavailable`.
    const statuses = mockBroadcast.mock.calls
      .filter((call: any[]) => call[0] === 'bug-report:status')
      .map((call: any[]) => call[1].status);
    expect(statuses).toContain('queued');
    expect(statuses).not.toContain('failed');
    expect(statuses).not.toContain('delivery-unavailable');
  });

  it('caps raw logs at 50KB', async () => {
    const largeLogs = 'x'.repeat(100_000);
    mockExportRecentLogs.mockResolvedValue({
      files: [{ filename: 'app.log', content: largeLogs, lineCount: 1000 }],
      totalLines: 1000,
      timeWindow: { start: '', end: '' },
    });

    await handler(null, { description: 'Something broke', urgency: 'medium' });
    await tick(500);

    expect(mockAnalyzeBugReport).toHaveBeenCalled();
    const callArgs = mockAnalyzeBugReport.mock.calls[0]?.[0] as { rawLogs?: string } | undefined;
    expect(callArgs?.rawLogs).toBeDefined();
    expect(callArgs!.rawLogs!.length).toBeLessThanOrEqual(50_000);
  });

  // ── Update forensics (Stage 3) ──

  it('gathers and attaches update forensics on the happy path', async () => {
    await handler(null, { description: 'Update issue', urgency: 'medium' });
    await settleRealDelivery();

    expect(mockGatherUpdateForensics).toHaveBeenCalledWith(
      expect.objectContaining({
        userDataPath: expect.any(String),
        bundleId: expect.any(String),
      }),
    );
    expect(mockAttachUpdateForensicsToScope).toHaveBeenCalledTimes(1);
  });

  it('attaches update forensics even when LLM analysis fails (regression for REBEL-52C)', async () => {
    mockAnalyzeBugReport.mockRejectedValue(new Error('LLM timeout'));

    await handler(null, { description: 'Update broke', urgency: 'high' });
    await settleRealDelivery();

    // Forensics gather + attach must run independently of LLM success/failure
    expect(mockGatherUpdateForensics).toHaveBeenCalled();
    expect(mockAttachUpdateForensicsToScope).toHaveBeenCalledTimes(1);
    // Sentry capture still happens
    expect(mockScopeCaptureMessage).toHaveBeenCalled();
  });

  it('does not attach forensics when gather throws', async () => {
    mockGatherUpdateForensics.mockRejectedValue(new Error('readFile EPERM'));

    await handler(null, { description: 'Update broke', urgency: 'high' });
    await settleRealDelivery();

    expect(mockAttachUpdateForensicsToScope).not.toHaveBeenCalled();
    // Sentry still captures the report
    expect(mockScopeCaptureMessage).toHaveBeenCalled();
  });

  it('still captures the report when forensics attachment throws', async () => {
    mockAttachUpdateForensicsToScope.mockImplementation(() => {
      throw new Error('Sentry SDK rejected attachment');
    });

    await handler(null, { description: 'Update broke', urgency: 'high' });
    await settleRealDelivery();

    // Capture still happens despite attach throwing
    expect(mockScopeCaptureMessage).toHaveBeenCalled();
    const statuses = mockBroadcast.mock.calls
      .filter((call: any[]) => call[0] === 'bug-report:status')
      .map((call: any[]) => call[1].status);
    expect(statuses).toContain('delivered');
  });

  // ── Stage 1: identifiers + hard-bounded enrichment ──────────────────────────

  it('captures a single event with a stable 32-char-hex event_id and report_id tag', async () => {
    await handler(null, { description: 'Stable id check', urgency: 'medium' });
    await settleRealDelivery();

    // Exactly one capture.
    expect(mockScopeCaptureMessage).toHaveBeenCalledTimes(1);
    const hint = mockScopeCaptureMessage.mock.calls[0]?.[2] as { event_id?: string } | undefined;
    expect(hint?.event_id).toMatch(EVENT_ID_HEX);

    // event_id is delivered to the transport-outcome lookup (so a later retry
    // could reuse it for server-side dedup).
    expect(mockGetSendOutcome).toHaveBeenCalledWith(hint?.event_id);

    // A report_id tag is set (UUID-shaped, distinct from the event_id).
    const reportIdTag = capturedTags.find((t) => t.key === 'report_id');
    expect(reportIdTag).toBeDefined();
    expect(String(reportIdTag?.value)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(reportIdTag?.value).not.toBe(hint?.event_id);
  });

  // ── Stage 3: per-report fingerprint entropy ─────────────────────────────────

  it('gives each report a distinct fingerprint containing its per-report id, even with identical titles', async () => {
    // Two submissions with the IDENTICAL first line (the confirmed REBEL-692
    // harm: 'harry test' x2 collapsed into one Sentry issue → no second Linear
    // ticket). The per-report `report_id` must make their fingerprints distinct
    // so each becomes its own issue and the Sentry→Linear automation fires per
    // report — while the array still leads with 'user-bug-report' for filtering.
    await handler(null, { description: 'harry test', urgency: 'medium' });
    await settleRealDelivery();
    await handler(null, { description: 'harry test', urgency: 'medium' });
    await settleRealDelivery();

    expect(capturedFingerprints).toHaveLength(2);

    const [first, second] = capturedFingerprints;

    // Each fingerprint leads with the stable filter key and carries a per-report
    // UUID (the `report_id`) as its uniqueness component.
    for (const fp of [first, second]) {
      expect(fp[0]).toBe('user-bug-report');
      const reportId = fp[fp.length - 1];
      expect(reportId).toMatch(REPORT_ID_UUID);
    }

    // Same title → fingerprints would have collapsed before Stage 3; the
    // per-report id now makes them distinct.
    const firstReportId = first[first.length - 1];
    const secondReportId = second[second.length - 1];
    expect(firstReportId).not.toBe(secondReportId);
    expect(JSON.stringify(first)).not.toBe(JSON.stringify(second));
  });
});

// These liveness repros use fake timers to prove capture is ALWAYS reached even
// when a best-effort enrichment await never settles. Separate describe so the
// fake-timer lifecycle is isolated from the real-timer flow tests above.
describe('bug-report:submit-bug handler — hard-bounded enrichment (liveness)', () => {
  let handler: (event: unknown, request: unknown) => Promise<unknown>;

  beforeEach(async () => {
    vi.resetAllMocks();
    // Fresh, unique per-test outbox dir BEFORE enabling fake timers (real I/O).
    // Isolates any drain leaked by a prior test onto its own directory.
    currentTestDataRoot = path.join(TEST_OUTBOX_ROOT, `t${++outboxDirCounter}`);
    await fsp.rm(currentTestDataRoot, { recursive: true, force: true });
    vi.useFakeTimers();

    mockScopeCaptureMessage.mockReturnValue(undefined);
    mockFlush.mockResolvedValue(true);
    mockGetSendOutcome.mockImplementation((eventId?: string) => ({
      eventId,
      statusCode: 200,
      recordedAt: 1,
    }));
    capturedAttachments.length = 0;
    capturedTags.length = 0;
    mockWithScope.mockImplementation((callback: (scope: unknown) => void) => {
      const scope = {
        setTag: vi.fn((key: string, value: unknown) => {
          capturedTags.push({ key, value });
        }),
        setExtra: vi.fn(),
        setLevel: vi.fn(),
        setFingerprint: vi.fn(),
        captureMessage: mockScopeCaptureMessage,
        addAttachment: vi.fn(),
      };
      callback(scope);
      return scope;
    });

    mockIsMainSentryEnabled.mockReturnValue(true);
    mockGetMainSentryDisabledReason.mockReturnValue(null);
    mockGatherDiagnostics.mockResolvedValue(makeDiagnostics());
    mockBuildFallbackDiagnosticSummary.mockReturnValue('# fallback');
    mockGatherUpdateForensics.mockResolvedValue({ attachments: [], manifest: [] });
    mockAttachUpdateForensicsToScope.mockReturnValue(undefined);
    mockExportRecentLogs.mockResolvedValue({
      files: [{ filename: 'app.log', content: '{"msg":"ok"}', lineCount: 1 }],
      totalLines: 1,
      timeWindow: { start: '', end: '' },
    });
    vi.mocked(isShuttingDown).mockReturnValue(false);

    vi.resetModules();
    handler = await loadAndGetHandler();
  });

  afterEach(async () => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fsp.rm(currentTestDataRoot, { recursive: true, force: true });
  });

  const getStatuses = (): string[] =>
    mockBroadcast.mock.calls
      .filter((call: any[]) => call[0] === 'bug-report:status')
      .map((call: any[]) => call[1].status);

  /**
   * Deterministically drive the outbox drain to completion under fake timers.
   * The handler fires the immediate drain as `void this.drain('enqueue')` and
   * does NOT await delivery (the accept contract), so liveness tests grab the
   * coalesced drain promise and pump fake timers until it settles. The drain
   * mixes real fs I/O (readdir/readFile) with faked `withTimeout` deadlines, so
   * we interleave timer advances with microtask flushes until the promise
   * resolves (bounded so a genuine wedge still fails the test).
   */
  async function settleDelivery(): Promise<void> {
    const outbox = currentMod!.getBugReportOutboxForTest();
    const drainDone = outbox.drain('test');
    let settled = false;
    let rejected: unknown;
    // Mark settled on BOTH fulfilment and rejection so a drain that rejects
    // doesn't spin the pump to its safety bound.
    void drainDone.then(
      () => {
        settled = true;
      },
      (err) => {
        settled = true;
        rejected = err;
      },
    );
    // Pump fake-timer deadlines (the enrichment `withTimeout` budgets) while
    // letting the outbox's REAL fs I/O progress between advances. Loop until the
    // drain actually settles rather than abandoning advancement after a fixed
    // count: under concurrent CI load the real fs I/O lags, so a fixed budget
    // could advance all fake time UP FRONT while `submit` hasn't yet scheduled
    // its `withTimeout` deadlines — then the trailing `await drainDone` would
    // hang on a deadline that's no longer being advanced (the reproduced 60s
    // timeout). The high safety bound trips only on a genuine wedge, which then
    // fails fast and loud below instead of silently timing out at 60s.
    for (let i = 0; i < 1_000 && !settled; i++) {
      await yieldRealIo();
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await yieldRealIo();
    }
    if (!settled) {
      throw new Error(
        'bug-report outbox drain did not settle within the bounded fake-timer pump (1000 fake seconds)',
      );
    }
    if (rejected) throw rejected;
    await drainDone;
  }

  /**
   * Pump fake timers + microtasks to push the drain far enough to reach the
   * Sentry capture, WITHOUT awaiting the (intentionally hung) drain promise.
   * Used by tests where flush never resolves — capture happens before flush, so
   * we just need the drain to progress to it.
   */
  async function pumpToCapture(): Promise<void> {
    // Same real-I/O-yield interleave + generous bound as settleDelivery: the
    // capture sits behind the outbox's real fs reads, so a fixed 50-iteration
    // budget can exhaust before capture under concurrent CI load. No
    // `await drainDone` here (flush hangs in these cases), so exhaustion would
    // surface as an assertion failure downstream — throw explicitly instead.
    for (let i = 0; i < 1_000; i++) {
      await yieldRealIo();
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await yieldRealIo();
      if (mockScopeCaptureMessage.mock.calls.length > 0) return;
    }
    throw new Error('bug-report capture not reached within the bounded fake-timer pump (1000 fake seconds)');
  }

  it('captures the report when the LLM analysis hangs forever (hard total deadline)', async () => {
    // analyzeBugReport never resolves — the per-fetch 60s timeout is NOT a
    // global cap, so without the Stage-1 total deadline capture is never reached.
    mockAnalyzeBugReport.mockReturnValue(new Promise(() => {}));

    await handler(null, {
      description: 'LLM is wedged',
      urgency: 'medium',
      includeEnrichedDiagnostics: true,
    });

    // Advance past the LLM total deadline (20s) + flush; capture must happen.
    await settleDelivery();

    expect(mockScopeCaptureMessage).toHaveBeenCalledTimes(1);
    expect(getStatuses()).toContain('delivered');
  });

  it('captures the report when an enrichment await (log export) hangs forever', async () => {
    mockExportRecentLogs.mockReturnValue(new Promise(() => {}));
    // LLM still resolves fast so we isolate the log-export hang.
    mockAnalyzeBugReport.mockResolvedValue('## summary');

    await handler(null, {
      description: 'Log export wedged',
      urgency: 'medium',
      includeEnrichedDiagnostics: true,
    });

    await settleDelivery();

    expect(mockScopeCaptureMessage).toHaveBeenCalledTimes(1);
    expect(getStatuses()).toContain('delivered');
  });

  it('captures the report when forensics gather hangs forever', async () => {
    mockGatherUpdateForensics.mockReturnValue(new Promise(() => {}));
    mockAnalyzeBugReport.mockResolvedValue('## summary');

    await handler(null, {
      description: 'Forensics wedged',
      urgency: 'medium',
      includeEnrichedDiagnostics: true,
    });

    await settleDelivery();

    expect(mockScopeCaptureMessage).toHaveBeenCalledTimes(1);
    expect(getStatuses()).toContain('delivered');
  });

  it('captures the report when Phase A deterministic diagnostics hangs forever', async () => {
    // gatherDeterministicDiagnostics is file I/O (logs, continuity stores) and
    // can hang on a locked disk / EMFILE. Without a deadline it gates capture
    // and the first report is lost — exactly the liveness gap this fix closes.
    mockGatherDiagnostics.mockReturnValue(new Promise(() => {}));
    // LLM must NOT run when diagnostics is null (Phase B `&& diagnostics` guard);
    // make it resolve fast anyway so a stray call wouldn't itself wedge the test.
    mockAnalyzeBugReport.mockResolvedValue('## summary');

    await handler(null, {
      description: 'Diagnostics gather wedged',
      urgency: 'medium',
      includeEnrichedDiagnostics: true,
    });

    // Advance past the Phase A diagnostics deadline (5s) + flush; capture must
    // still happen with the deterministic fallback summary.
    await settleDelivery();

    expect(mockScopeCaptureMessage).toHaveBeenCalledTimes(1);
    expect(getStatuses()).toContain('delivered');
  });

  // ── INVARIANT GUARD: enrichment can never precede / gate the raw capture ─────
  // Postmortem rec 1 (260622_feedback_bugs_silent_report_loss, BUG-PREVENTION
  // test_coverage, implement_now): the original loss was caused by ordering the
  // must-never-lose raw capture *behind* unbounded enrichment awaits. The three
  // single-source hang repros above each prove ONE source can't gate capture;
  // this guard pins the whole invariant in one shot — ALL enrichment sources
  // (Phase A diagnostics, raw-log export, LLM analysis, update forensics) hang
  // FOREVER simultaneously, yet the raw report is STILL captured, bounded only by
  // the enrichment wall-clock deadlines. Because every enrichment promise never
  // settles, this fails DETERMINISTICALLY if a future edit reorders captureMessage
  // behind any of them (or strips a `withTimeout` wrapper): capture would then be
  // gated on a promise that never resolves and `mockScopeCaptureMessage` would
  // never be called within the bounded pump.
  it('captures the raw report when ALL enrichment hangs simultaneously (invariant: enrichment cannot precede capture)', async () => {
    // Every enrichment source wedged at once — the broken-environment worst case
    // the postmortem describes (a broken LLM/provider both triggers the report
    // AND widens the loss window). Each wedges WELL PAST its own deadline (the
    // longest budget is the LLM total, 20s; we settle at 120s so all four are
    // still pending when capture must occur), then settles so fake-timer teardown
    // drains cleanly (no permanently-dangling promise leaking into sibling tests).
    const HANG_MS = 120_000;
    const hangThenResolve = <T,>(value: T) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(value), HANG_MS));
    mockGatherDiagnostics.mockReturnValue(hangThenResolve(makeDiagnostics()));
    mockExportRecentLogs.mockReturnValue(
      hangThenResolve({ files: [], totalLines: 0, timeWindow: { start: '', end: '' } }),
    );
    mockAnalyzeBugReport.mockReturnValue(hangThenResolve('## late summary'));
    mockGatherUpdateForensics.mockReturnValue(hangThenResolve({ attachments: [], manifest: [] }));

    await handler(null, {
      description: 'Everything is wedged',
      urgency: 'high',
      includeEnrichedDiagnostics: true,
    });

    // Drive the drain to completion. Every enrichment promise is pending far
    // beyond its deadline, so capture can ONLY be reached because each is raced
    // against its bounded wall-clock deadline. If a future edit reorders
    // captureMessage behind any of them (or strips a `withTimeout`), the drain
    // wedges on a not-yet-settled enrichment promise and this times out without
    // ever reaching capture — the deterministic failure that pins the invariant.
    // (Verified by mutation: replacing any `withTimeout` enrichment wrapper with a
    // raw `await` makes this test hang to timeout.)
    await settleDelivery();

    // Explicit: capture reached exactly once, bounded by the enrichment deadlines
    // and independent of any enrichment completing — none of the (still-pending)
    // enrichment promises gated it — and delivery still confirmed a 2xx (each
    // wedged source dropped to its fallback rather than being awaited).
    expect(mockScopeCaptureMessage).toHaveBeenCalledTimes(1);
    const hint = mockScopeCaptureMessage.mock.calls[0]?.[2] as { event_id?: string } | undefined;
    expect(hint?.event_id).toMatch(EVENT_ID_HEX);
    expect(getStatuses()).toContain('delivered');
  });

  it('captures the report when an enrichment await REJECTS after its deadline (late rejection absorbed)', async () => {
    // The wedge cases above never settle; this case settles by REJECTING after
    // the timeout already won. `withTimeout` must absorb that late rejection
    // (no unhandledRejection) while still reaching capture with the fallback.
    // Track rejections that stay unhandled. `withTimeout` absorbs the late
    // rejection asynchronously (its `.catch` runs a microtask later than Node's
    // unhandled-rejection check fires under synchronous fake-timer advancement),
    // so we reconcile with `rejectionHandled`: a rejection that is later handled
    // must NOT count as a leak. What we guard against is a PERMANENTLY unhandled
    // rejection.
    const unhandled = new Map<Promise<unknown>, unknown>();
    const onUnhandled = (reason: unknown, promise: Promise<unknown>) => {
      unhandled.set(promise, reason);
    };
    const onRejectionHandled = (promise: Promise<unknown>) => {
      unhandled.delete(promise);
    };
    process.on('unhandledRejection', onUnhandled);
    process.on('rejectionHandled', onRejectionHandled);
    try {
      // Reject only AFTER the raw-log deadline (5s) has elapsed.
      mockExportRecentLogs.mockReturnValue(
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('log export blew up late')), 10_000);
        }),
      );
      mockAnalyzeBugReport.mockResolvedValue('## summary');

      await handler(null, {
        description: 'Log export rejects late',
        urgency: 'medium',
        includeEnrichedDiagnostics: true,
      });

      // Drive the drain to capture (5s raw-log deadline → fallback → capture →
      // 2xx). Then keep pumping PAST the 10s late-rejection so it actually
      // fires: withTimeout's `.catch` must absorb it (timedOut), so no
      // unhandledRejection surfaces.
      await settleDelivery();
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
        await Promise.resolve();
      }
      // Let any `rejectionHandled` reconciliation flush.
      await Promise.resolve();
      await Promise.resolve();

      expect(mockScopeCaptureMessage).toHaveBeenCalledTimes(1);
      expect(getStatuses()).toContain('delivered');
      // No PERMANENTLY-unhandled rejection (the late one was absorbed by withTimeout).
      expect([...unhandled.values()]).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      process.off('rejectionHandled', onRejectionHandled);
    }
  });

  it('does not block a subsequent submit while a prior delivery hangs at flush (durability decouples accept from delivery)', async () => {
    // Stage 4 contract change: the in-flight guard now wraps only the fast
    // durable enqueue, NOT the delivery. So a prior report whose delivery hangs
    // at flush must NOT block a subsequent submit — that submit is durably
    // persisted independently. (Pre-Stage-4 this case rejected the second submit
    // and risked losing it; durability makes that unnecessary and wrong.)
    mockAnalyzeBugReport.mockResolvedValue('## summary');
    mockFlush.mockReturnValue(new Promise(() => {})); // delivery hangs forever

    const first = await handler(null, { description: 'First (delivery hangs)', urgency: 'medium' });
    expect(first).toEqual({ outcome: 'accepted' });

    // Let the first report's durable write + immediate-drain start, then submit
    // a second while the first's flush is still pending: it must be accepted.
    await pumpToCapture();
    const second = await handler(null, { description: 'Second (not blocked)', urgency: 'low' });
    expect(second).toEqual({ outcome: 'accepted' });
  });

  it('persists the report durably even when delivery never confirms (replayable on next boot)', async () => {
    // The whole point of Stage 4: a report whose delivery hangs (flush never
    // resolves) is still safe on disk. We can't easily inspect the dir under the
    // module-scoped temp root here, but the accept itself is gated on the
    // durable write — so an `accepted` return PROVES the bytes are on disk.
    mockAnalyzeBugReport.mockResolvedValue('## summary');
    mockFlush.mockReturnValue(new Promise(() => {})); // delivery never confirms

    const result = await handler(null, { description: 'Never delivered', urgency: 'high' });
    expect(result).toEqual({ outcome: 'accepted' });

    // Capture was still attempted (immediate drain), and the record remains for
    // retry since flush never produced a 2xx.
    await pumpToCapture();
    expect(mockScopeCaptureMessage).toHaveBeenCalled();
  });
});
