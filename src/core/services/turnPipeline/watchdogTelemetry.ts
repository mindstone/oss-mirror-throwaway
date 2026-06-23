/**
 * Watchdog telemetry — registry-owned Sentry captures + analytics for the
 * agent-turn watchdog family (REBEL-N4 / REBEL-1AD / REBEL-RD).
 *
 * Stage 2 of docs/plans/260610_improve-sentry-noise/PLAN.md:
 * - "Watchdog self-resolved" is SUCCESS telemetry — it never reaches the
 *   Sentry issue stream. It goes to the analytics rail (preserving the
 *   resolution-time-bucket aggregate) + the diagnostic ledger; the structured
 *   log line at the call site rides to Sentry as a breadcrumb on the next
 *   real event.
 * - "stalled" and "auto-abort" remain sweep-visible warnings, but are now
 *   registry-owned (`captureKnownCondition`) so level + fingerprint are
 *   governed and every capture is mirrored to the on-device ledger.
 *
 * Extracted from inline `getErrorReporter()` calls in agentTurnExecute.ts so
 * the payload assembly is unit-testable (the stalled capture's rich
 * diagnostics extras are load-bearing for stall debugging — tests assert
 * they survive the wrapper conversion).
 */

import {
  captureKnownCondition,
  recordKnownConditionLedgerOnly,
} from '@core/sentry/captureKnownCondition';
import { createScopedLogger } from '@core/logger';
import { getTracker } from '@core/tracking';
import type { WatchdogPhase } from '@core/services/watchdog/watchdogTracker';

const log = createScopedLogger({ service: 'watchdogTelemetry' });

export type WatchdogToolKind = 'mcp' | 'builtin' | 'none';

/** Infer tool kind for low-cardinality telemetry tagging. */
function inferWatchdogToolKind(toolName?: string): WatchdogToolKind {
  if (!toolName) return 'none';
  // MCP tools typically have server prefix like "server_name/tool_name" or specific patterns
  if (toolName.includes('/') || toolName.includes('mcp_') || toolName.startsWith('rebel_')) return 'mcp';
  return 'builtin';
}

export type WatchdogResolutionTimeBucket = '<30s' | '30-60s' | '60-120s' | '>120s';

/** Low-cardinality resolution-time bucket for aggregate stall analysis. */
export function getWatchdogResolutionTimeBucket(ms: number): WatchdogResolutionTimeBucket {
  if (ms < 30_000) return '<30s';
  if (ms < 60_000) return '30-60s';
  if (ms < 120_000) return '60-120s';
  return '>120s';
}

/**
 * Low-cardinality reachability marker captured at stall time (Stage 3a).
 * Mirrors `TimeoutDiagnosticResult['kind']` plus a `'not_probed'` sentinel for
 * stalls where the bounded `diagnoseTimeout` probe was skipped (non-Anthropic
 * route, tool/subagent in flight, turn already moved on) or threw. This is the
 * marker that will let us confirm/deny the DNS-threadpool-starvation class
 * (`fb7f72095`) the next time an `awaiting_api` stall lands in the wild.
 */
export type WatchdogReachabilityMarker =
  | 'anthropic_issue'
  | 'internet_unreachable'
  | 'transient_stall'
  | 'not_probed';

export interface WatchdogSelfResolvedTelemetryParams {
  resolvedAfterMs: number;
  phase: WatchdogPhase;
  mcpMode: string | undefined;
  model: string | undefined;
  extendedContext: boolean | undefined;
  lastToolName: string | undefined;
  maxWatchdogLevel: number;
  messageCount: number;
}

/**
 * Watchdog self-resolved: the turn completed successfully after a stall.
 * Analytics + ledger ONLY — deliberately no Sentry capture (this was
 * REBEL-N4, 11.5k info events/14d of pure success telemetry).
 * Fail-safe: telemetry must never break turn completion.
 */
export function emitWatchdogSelfResolvedTelemetry(
  params: WatchdogSelfResolvedTelemetryParams,
): void {
  try {
    // Lean payload, no PII — preserves the fields previously tagged on the
    // Sentry event so the resolution-time-bucket analysis survives the move.
    getTracker().track('Watchdog Self-Resolved', {
      area: 'agent-turn',
      component: 'watchdog',
      outcome: 'resolved',
      phase: params.phase,
      platform: process.platform,
      mcp_mode: params.mcpMode ?? 'unknown',
      model: params.model ?? 'unknown',
      extended_context: String(params.extendedContext ?? false),
      last_tool_kind: inferWatchdogToolKind(params.lastToolName),
      resolution_time_bucket: getWatchdogResolutionTimeBucket(params.resolvedAfterMs),
      resolved_after_ms: params.resolvedAfterMs,
      max_watchdog_level: params.maxWatchdogLevel,
      message_count: params.messageCount,
    });
  } catch (trackError) {
    log.warn({ err: trackError }, 'Watchdog self-resolved analytics emit failed');
  }
  recordKnownConditionLedgerOnly('agent_watchdog_self_resolved');
}

export interface WatchdogStalledCaptureParams {
  silentMs: number;
  threshold: number;
  turnId: string;
  phase: WatchdogPhase;
  mcpMode: string | undefined;
  lastMessageType: string | undefined;
  lastToolName: string | undefined;
  messageCount: number;
  upstreamServerCount: number | undefined;
  hasMedia: boolean;
  totalAttachments: number;
  model: string | undefined;
  extendedContext: boolean | undefined;
  hasActiveSubagent: boolean;
  activeSubagentCount: number;
  upstreamActivity: number | undefined;
  mainProcessMemory: NodeJS.MemoryUsage;
  processCount: number;
  highMemoryProcesses: ReadonlyArray<unknown>;
  totalAppMemory: number;
  rawStreamLastEvent: string | null;
  rawStreamLastEventAgeMs: number | null;
  rawStreamEventCount: number;
  /** Present only when the last runtime activity was an unmapped stream event. */
  unmappedActivity?: { kind: string; rawEventType: string };
  // --- Stage 3a stall-debuggability enrichment (260617 bricked-state plan) ---
  /**
   * Ms from turn start to the first streamed byte/token, or `null` when nothing
   * has streamed yet (the `awaiting_api` stall class — request sent, silence).
   */
  timeToFirstTokenMs?: number | null;
  /** True iff at least one raw-stream event arrived (rawStreamEventCount > 0). */
  firstByteReceived?: boolean;
  /** Active provider for the turn (e.g. 'anthropic', 'codex', 'openrouter'). */
  provider?: string;
  /**
   * Transport route inferred from the stream shape ('anthropic' SSE vs
   * 'openai' Responses/chat). Distinct from `provider` (the configured
   * provider) — together they localise where the stall sits.
   */
  route?: 'anthropic' | 'openai';
  /**
   * Cheap, time-boxed network/DNS reachability marker captured AT stall time
   * (never on healthy turns). See {@link WatchdogReachabilityMarker}.
   */
  reachabilityMarker?: WatchdogReachabilityMarker;
}

/**
 * Watchdog first-trigger (level 1) stalled capture — REBEL-1AD.
 * Registry-owned warning with stable fingerprint; the rich diagnostics
 * extras (process metrics, raw-stream state) are preserved verbatim.
 */
export function captureWatchdogStalled(params: WatchdogStalledCaptureParams): void {
  captureKnownCondition(
    'agent_watchdog_stalled',
    {
      tags: {
        area: 'agent-turn',
        component: 'watchdog',
        mcp_mode: params.mcpMode ?? 'unknown',
        last_message_type: params.lastMessageType ?? 'none',
        platform: process.platform,
        phase: params.phase,
        // Enhanced tags for pattern analysis (Stage 2 diagnostics)
        model: params.model ?? 'unknown',
        extended_context: String(params.extendedContext ?? false),
        last_tool_kind: inferWatchdogToolKind(params.lastToolName),
        has_active_subagent: String(params.hasActiveSubagent),
        ...(params.unmappedActivity ? { unmapped_stream_event: 'true' } : {}),
        // Stage 3a: low-cardinality stall-debuggability tags. Only added when
        // provided so existing call sites / tests (which assert the exact tag
        // set) stay byte-identical when the enrichment is absent.
        ...(params.provider !== undefined ? { provider: params.provider } : {}),
        ...(params.route !== undefined ? { route: params.route } : {}),
        ...(params.firstByteReceived !== undefined
          ? { first_byte_received: String(params.firstByteReceived) }
          : {}),
        ...(params.reachabilityMarker !== undefined
          ? { reachability_marker: params.reachabilityMarker }
          : {}),
      },
      extra: {
        silentMs: params.silentMs,
        threshold: params.threshold,
        turnId: params.turnId,
        lastMessageType: params.lastMessageType,
        lastToolName: params.lastToolName,
        messageCount: params.messageCount,
        mcpMode: params.mcpMode,
        upstreamServerCount: params.upstreamServerCount,
        hasMedia: params.hasMedia,
        totalAttachments: params.totalAttachments,
        model: params.model,
        extendedContext: params.extendedContext,
        hasActiveSubagent: params.hasActiveSubagent,
        activeSubagentCount: params.activeSubagentCount,
        upstreamActivity: params.upstreamActivity,
        mainProcessMemory: params.mainProcessMemory,
        processCount: params.processCount,
        highMemoryProcesses: params.highMemoryProcesses,
        totalAppMemory: params.totalAppMemory,
        rawStreamLastEvent: params.rawStreamLastEvent,
        rawStreamLastEventAgeMs: params.rawStreamLastEventAgeMs,
        rawStreamEventCount: params.rawStreamEventCount,
        ...(params.unmappedActivity
          ? {
              runtime_activity_kind: params.unmappedActivity.kind,
              runtime_activity_raw: params.unmappedActivity.rawEventType,
            }
          : {}),
        // Stage 3a: numeric/enriched extras. Conditionally added so an absent
        // enrichment leaves the extras payload byte-identical to before.
        ...(params.timeToFirstTokenMs !== undefined
          ? { timeToFirstTokenMs: params.timeToFirstTokenMs }
          : {}),
        ...(params.firstByteReceived !== undefined
          ? { firstByteReceived: params.firstByteReceived }
          : {}),
        ...(params.provider !== undefined ? { provider: params.provider } : {}),
        ...(params.route !== undefined ? { route: params.route } : {}),
        ...(params.reachabilityMarker !== undefined
          ? { reachabilityMarker: params.reachabilityMarker }
          : {}),
      },
    },
    new Error('Agent turn watchdog triggered - agent output stalled'),
  );
}

export interface WatchdogAutoAbortCaptureParams {
  silentMs: number;
  phase: WatchdogPhase;
  mcpMode: string | undefined;
  lastMessageType: string | undefined;
  lastToolName: string | undefined;
  messageCount: number;
  model: string | undefined;
  extendedContext: boolean | undefined;
  autoAbortMs: number;
  toolInFlightMs: number | undefined;
  isToolInFlight: boolean;
  isComplexTurn: boolean;
  isAwaitingFirstResponse: boolean;
  hasActiveSubagent: boolean;
  activeSubagentCount: number;
  upstreamActivity: number | undefined;
  rawStreamLastEvent: string | null;
  rawStreamLastEventAgeMs: number | null;
  rawStreamEventCount: number;
  watchdogAbortReason: string;
}

/**
 * Watchdog auto-abort (REBEL-NQ / REBEL-RD): sustained silence hit the
 * phase-aware ceiling and the turn was aborted. Registry-owned warning.
 */
export function captureWatchdogAutoAbort(params: WatchdogAutoAbortCaptureParams): void {
  captureKnownCondition(
    'agent_watchdog_auto_abort',
    {
      tags: {
        area: 'agent-turn',
        component: 'watchdog',
        outcome: 'auto_aborted',
        phase: params.phase,
        platform: process.platform,
        mcp_mode: params.mcpMode ?? 'unknown',
        last_tool_kind: inferWatchdogToolKind(params.lastToolName),
        tool_in_flight: String(params.isToolInFlight),
        complex_turn: String(params.isComplexTurn),
        awaiting_first_response: String(params.isAwaitingFirstResponse),
        has_active_subagent: String(params.hasActiveSubagent),
        watchdog_abort_reason: params.watchdogAbortReason,
      },
      extra: {
        silentMs: params.silentMs,
        lastMessageType: params.lastMessageType,
        lastToolName: params.lastToolName,
        messageCount: params.messageCount,
        model: params.model,
        extendedContext: params.extendedContext,
        autoAbortMs: params.autoAbortMs,
        toolInFlightMs: params.toolInFlightMs,
        isToolInFlight: params.isToolInFlight,
        isComplexTurn: params.isComplexTurn,
        isAwaitingFirstResponse: params.isAwaitingFirstResponse,
        hasActiveSubagent: params.hasActiveSubagent,
        activeSubagentCount: params.activeSubagentCount,
        upstreamActivity: params.upstreamActivity,
        rawStreamLastEvent: params.rawStreamLastEvent,
        rawStreamLastEventAgeMs: params.rawStreamLastEventAgeMs,
        rawStreamEventCount: params.rawStreamEventCount,
        watchdogAbortReason: params.watchdogAbortReason,
      },
    },
    new Error('Watchdog auto-abort'),
  );
}
