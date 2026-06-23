/**
 * Watchdog telemetry — Stage 2 of docs/plans/260610_improve-sentry-noise/PLAN.md.
 *
 * Contract under test:
 * - "Watchdog self-resolved" NEVER reaches the error reporter (analytics +
 *   diagnostic ledger only, preserving the resolution-time-bucket fields).
 * - "stalled" / "auto-abort" go through captureKnownCondition with the
 *   registry condition names (warning level, stable fingerprints) and the
 *   rich diagnostics extras survive the wrapper conversion verbatim.
 *
 * Deliberately uses the REAL captureKnownCondition + KNOWN_CONDITIONS registry
 * (only the reporter/tracker/ledger sinks are injected) so registry drift —
 * missing entry, level change, fingerprint rename — fails these tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ErrorReporter, ErrorReporterCaptureContext } from '@core/errorReporter';
import { setErrorReporter } from '@core/errorReporter';
import { setTracker, type Tracker } from '@core/tracking';
import {
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerWriter,
  setDiagnosticEventsSurface,
  type DiagnosticEventsLedgerWriter,
} from '@core/services/diagnosticEventsLedger';
import type { DiagnosticEventEntry } from '@core/services/diagnostics/manifest';
import {
  captureWatchdogAutoAbort,
  captureWatchdogStalled,
  emitWatchdogSelfResolvedTelemetry,
  getWatchdogResolutionTimeBucket,
  type WatchdogSelfResolvedTelemetryParams,
  type WatchdogStalledCaptureParams,
} from '@core/services/turnPipeline/watchdogTelemetry';

const captureException = vi.fn<(error: unknown, context?: ErrorReporterCaptureContext) => void>();
const captureMessage = vi.fn<(message: string, context?: ErrorReporterCaptureContext) => void>();
const addBreadcrumb = vi.fn();
const track = vi.fn<(event: string, properties?: Record<string, unknown>) => void>();

const reporter: ErrorReporter = { captureException, captureMessage, addBreadcrumb };
const tracker: Tracker = {
  track,
  identify: vi.fn(),
  getAnonymousId: () => 'anon-test',
  isAvailable: () => true,
};
const noopTracker: Tracker = {
  track: () => {},
  identify: () => {},
  getAnonymousId: () => '',
  isAvailable: () => false,
};

let ledgerEntries: DiagnosticEventEntry[] = [];
const ledgerWriter: DiagnosticEventsLedgerWriter = {
  append: (entry) => {
    ledgerEntries.push(entry);
  },
};

function knownConditionLedgerEntries(): Array<{ condition: string; level: string }> {
  return ledgerEntries
    .filter((entry) => entry.kind === 'known_condition')
    .map((entry) => entry.data as { condition: string; level: string });
}

const selfResolvedParams: WatchdogSelfResolvedTelemetryParams = {
  resolvedAfterMs: 45_000,
  phase: 'streaming',
  mcpMode: 'http',
  model: 'claude-test-model',
  extendedContext: true,
  lastToolName: 'server_name/tool_name',
  maxWatchdogLevel: 3,
  messageCount: 12,
};

const stalledParams: WatchdogStalledCaptureParams = {
  silentMs: 31_000,
  threshold: 30_000,
  turnId: 'turn-123',
  phase: 'awaiting_api',
  mcpMode: 'direct',
  lastMessageType: 'assistant',
  lastToolName: 'Read',
  messageCount: 7,
  upstreamServerCount: 2,
  hasMedia: false,
  totalAttachments: 0,
  model: 'claude-test-model',
  extendedContext: false,
  hasActiveSubagent: false,
  activeSubagentCount: 0,
  upstreamActivity: 4,
  mainProcessMemory: process.memoryUsage(),
  processCount: 5,
  highMemoryProcesses: [{ type: 'GPU', pid: 42, memory: 600 * 1024 * 1024 }],
  totalAppMemory: 1_234_567,
  rawStreamLastEvent: 'content_block_delta',
  rawStreamLastEventAgeMs: 31_500,
  rawStreamEventCount: 88,
};

beforeEach(() => {
  vi.clearAllMocks();
  ledgerEntries = [];
  resetDiagnosticEventsLedgerForTests();
  setDiagnosticEventsSurface('desktop');
  setDiagnosticEventsLedgerWriter(ledgerWriter);
  setErrorReporter(reporter);
  setTracker(tracker);
});

afterEach(() => {
  setDiagnosticEventsLedgerWriter(null);
  resetDiagnosticEventsLedgerForTests();
  setTracker(noopTracker);
});

describe('getWatchdogResolutionTimeBucket', () => {
  it('buckets resolution times at the documented boundaries', () => {
    expect(getWatchdogResolutionTimeBucket(0)).toBe('<30s');
    expect(getWatchdogResolutionTimeBucket(29_999)).toBe('<30s');
    expect(getWatchdogResolutionTimeBucket(30_000)).toBe('30-60s');
    expect(getWatchdogResolutionTimeBucket(59_999)).toBe('30-60s');
    expect(getWatchdogResolutionTimeBucket(60_000)).toBe('60-120s');
    expect(getWatchdogResolutionTimeBucket(119_999)).toBe('60-120s');
    expect(getWatchdogResolutionTimeBucket(120_000)).toBe('>120s');
  });
});

describe('emitWatchdogSelfResolvedTelemetry', () => {
  it('emits analytics with the resolution-time-bucket fields and writes the ledger, WITHOUT calling the error reporter', () => {
    emitWatchdogSelfResolvedTelemetry(selfResolvedParams);

    // Analytics rail preserves the fields previously tagged on the Sentry event.
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('Watchdog Self-Resolved', {
      area: 'agent-turn',
      component: 'watchdog',
      outcome: 'resolved',
      phase: 'streaming',
      platform: process.platform,
      mcp_mode: 'http',
      model: 'claude-test-model',
      extended_context: 'true',
      last_tool_kind: 'mcp',
      resolution_time_bucket: '30-60s',
      resolved_after_ms: 45_000,
      max_watchdog_level: 3,
      message_count: 12,
    });

    // Ledger mirror via recordKnownConditionLedgerOnly.
    expect(knownConditionLedgerEntries()).toEqual([
      { condition: 'agent_watchdog_self_resolved', level: 'info' },
    ]);

    // The whole point: success telemetry never reaches the issue stream.
    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('defaults unknown mcp_mode/model and still never throws when analytics fails', () => {
    track.mockImplementationOnce(() => {
      throw new Error('analytics backend down');
    });

    expect(() =>
      emitWatchdogSelfResolvedTelemetry({
        ...selfResolvedParams,
        mcpMode: undefined,
        model: undefined,
        lastToolName: undefined,
      }),
    ).not.toThrow();

    // Ledger write still happens after an analytics failure.
    expect(knownConditionLedgerEntries()).toEqual([
      { condition: 'agent_watchdog_self_resolved', level: 'info' },
    ]);
    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });
});

describe('captureWatchdogStalled', () => {
  it('captures through the registry wrapper with stable fingerprint, warning level, and ALL diagnostics extras intact', () => {
    captureWatchdogStalled(stalledParams);

    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, context] = captureException.mock.calls[0] as [Error, Record<string, unknown>];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Agent turn watchdog triggered - agent output stalled');

    expect(context).toMatchObject({
      fingerprint: ['agent-watchdog-stalled'],
      level: 'warning',
      _knownConditionWrapped: true,
    });

    expect(context.tags).toEqual({
      // The captureKnownCondition wrapper stamps a queryable `condition` tag so
      // alert rules can scope to this specific condition vs the sibling
      // agent_watchdog_auto_abort (which shares area/component) — the exact
      // disambiguation this tag exists for.
      condition: 'agent_watchdog_stalled',
      area: 'agent-turn',
      component: 'watchdog',
      mcp_mode: 'direct',
      last_message_type: 'assistant',
      platform: process.platform,
      phase: 'awaiting_api',
      model: 'claude-test-model',
      extended_context: 'false',
      last_tool_kind: 'builtin',
      has_active_subagent: 'false',
    });

    // Rich diagnostics extras survive the wrapper conversion (PLAN Stage 2
    // failure-mode: "Watchdog stalled diagnostics regress during wrapper
    // conversion (extras lost)").
    expect(context.extra).toEqual({
      silentMs: 31_000,
      threshold: 30_000,
      turnId: 'turn-123',
      lastMessageType: 'assistant',
      lastToolName: 'Read',
      messageCount: 7,
      mcpMode: 'direct',
      upstreamServerCount: 2,
      hasMedia: false,
      totalAttachments: 0,
      model: 'claude-test-model',
      extendedContext: false,
      hasActiveSubagent: false,
      activeSubagentCount: 0,
      upstreamActivity: 4,
      mainProcessMemory: stalledParams.mainProcessMemory,
      processCount: 5,
      highMemoryProcesses: stalledParams.highMemoryProcesses,
      totalAppMemory: 1_234_567,
      rawStreamLastEvent: 'content_block_delta',
      rawStreamLastEventAgeMs: 31_500,
      rawStreamEventCount: 88,
    });

    // Wrapper mirrors every capture into the ledger.
    expect(knownConditionLedgerEntries()).toEqual([
      { condition: 'agent_watchdog_stalled', level: 'warning' },
    ]);
  });

  it('threads unmapped-activity diagnostics into tags and extras when present', () => {
    captureWatchdogStalled({
      ...stalledParams,
      unmappedActivity: { kind: 'unknown', rawEventType: 'response.new_thing.delta' },
    });

    const context = captureException.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(context.tags).toMatchObject({ unmapped_stream_event: 'true' });
    expect(context.extra).toMatchObject({
      runtime_activity_kind: 'unknown',
      runtime_activity_raw: 'response.new_thing.delta',
    });
  });

  // --- Stage 3a stall-debuggability enrichment (260617 bricked-state plan) ---
  it('carries the Stage-3a enrichment (TTFT/first-byte/provider/route/reachability) in tags + extras', () => {
    captureWatchdogStalled({
      ...stalledParams,
      // awaiting_api stall: request sent, nothing streamed back yet.
      rawStreamEventCount: 0,
      timeToFirstTokenMs: null,
      firstByteReceived: false,
      provider: 'anthropic',
      route: 'anthropic',
      reachabilityMarker: 'internet_unreachable',
    });

    const context = captureException.mock.calls[0]?.[1] as Record<string, unknown>;
    // Low-cardinality enrichment rides on tags.
    expect(context.tags).toMatchObject({
      provider: 'anthropic',
      route: 'anthropic',
      first_byte_received: 'false',
      reachability_marker: 'internet_unreachable',
    });
    // The numeric/enriched detail rides on extras (null TTFT preserved as null,
    // NOT dropped — absence of a first token is itself the signal).
    expect(context.extra).toMatchObject({
      timeToFirstTokenMs: null,
      firstByteReceived: false,
      provider: 'anthropic',
      route: 'anthropic',
      reachabilityMarker: 'internet_unreachable',
    });
  });

  it('carries a numeric timeToFirstTokenMs when the stream had started before stalling', () => {
    captureWatchdogStalled({
      ...stalledParams,
      rawStreamEventCount: 12,
      timeToFirstTokenMs: 1_840,
      firstByteReceived: true,
      provider: 'codex',
      route: 'openai',
      reachabilityMarker: 'not_probed',
    });

    const context = captureException.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(context.tags).toMatchObject({
      provider: 'codex',
      route: 'openai',
      first_byte_received: 'true',
      reachability_marker: 'not_probed',
    });
    expect(context.extra).toMatchObject({
      timeToFirstTokenMs: 1_840,
      firstByteReceived: true,
    });
  });

  it('preserves the EXISTING tag/extra set byte-identical when the Stage-3a enrichment is absent (back-compat)', () => {
    // `stalledParams` carries no enrichment fields → the capture must look
    // exactly as it did before Stage 3a (the file already asserts the full
    // extras survive in the test above; here we assert the new keys do NOT
    // appear when omitted).
    captureWatchdogStalled(stalledParams);

    const context = captureException.mock.calls[0]?.[1] as Record<string, unknown>;
    const tags = context.tags as Record<string, unknown>;
    const extra = context.extra as Record<string, unknown>;
    for (const key of ['provider', 'route', 'first_byte_received', 'reachability_marker']) {
      expect(tags).not.toHaveProperty(key);
    }
    for (const key of [
      'timeToFirstTokenMs',
      'firstByteReceived',
      'provider',
      'route',
      'reachabilityMarker',
    ]) {
      expect(extra).not.toHaveProperty(key);
    }
  });
});

describe('captureWatchdogAutoAbort', () => {
  it('captures through the registry wrapper with stable fingerprint, warning level, and the abort diagnostics extras', () => {
    captureWatchdogAutoAbort({
      silentMs: 600_000,
      phase: 'awaiting_tool',
      mcpMode: undefined,
      lastMessageType: 'assistant',
      lastToolName: 'mcp_search/query',
      messageCount: 3,
      model: 'claude-test-model',
      extendedContext: undefined,
      autoAbortMs: 600_000,
      toolInFlightMs: 580_000,
      isToolInFlight: true,
      isComplexTurn: false,
      isAwaitingFirstResponse: false,
      hasActiveSubagent: true,
      activeSubagentCount: 1,
      upstreamActivity: undefined,
      rawStreamLastEvent: null,
      rawStreamLastEventAgeMs: null,
      rawStreamEventCount: 0,
      watchdogAbortReason: 'watchdog',
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, context] = captureException.mock.calls[0] as [Error, Record<string, unknown>];
    expect(error.message).toBe('Watchdog auto-abort');

    expect(context).toMatchObject({
      fingerprint: ['agent-watchdog-auto-abort'],
      level: 'warning',
      _knownConditionWrapped: true,
    });
    expect(context.tags).toEqual({
      // Sibling of agent_watchdog_stalled — the wrapper-stamped `condition` tag
      // is what lets an alert scope to one and exclude the other.
      condition: 'agent_watchdog_auto_abort',
      area: 'agent-turn',
      component: 'watchdog',
      outcome: 'auto_aborted',
      phase: 'awaiting_tool',
      platform: process.platform,
      mcp_mode: 'unknown',
      last_tool_kind: 'mcp',
      tool_in_flight: 'true',
      complex_turn: 'false',
      awaiting_first_response: 'false',
      has_active_subagent: 'true',
      watchdog_abort_reason: 'watchdog',
    });
    expect(context.extra).toMatchObject({
      silentMs: 600_000,
      autoAbortMs: 600_000,
      toolInFlightMs: 580_000,
      watchdogAbortReason: 'watchdog',
      activeSubagentCount: 1,
      rawStreamEventCount: 0,
    });

    expect(knownConditionLedgerEntries()).toEqual([
      { condition: 'agent_watchdog_auto_abort', level: 'warning' },
    ]);
  });
});

describe('agentTurnExecute call sites (source guard)', () => {
  it('routes the watchdog family through the telemetry helpers — no raw watchdog captures remain', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'agentTurnExecute.ts'),
      'utf8',
    );

    // Converted call sites are present.
    expect(source).toContain('emitWatchdogSelfResolvedTelemetry({');
    expect(source).toContain('captureWatchdogStalled({');
    expect(source).toContain('captureWatchdogAutoAbort({');

    // The old raw captures are gone (self-resolved must NOT re-grow a Sentry
    // capture; stalled/auto-abort must stay registry-owned).
    expect(source).not.toContain("captureMessage('Watchdog self-resolved'");
    expect(source).not.toContain("captureMessage('Watchdog auto-abort'");
    expect(source).not.toContain(
      "captureException(\n              new Error('Agent turn watchdog triggered",
    );
  });
});
