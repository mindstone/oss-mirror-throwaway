import { isSubAgentTool } from '@shared/utils/eventSanitization';
import type { RuntimeActivityEvent } from '@core/rebelCore/runtimeActivity';

/**
 * WatchdogTracker — tracks agent silence and subagent (Task tool) lifecycle
 * for the agent turn watchdog system.
 *
 * Extracted from agentTurnExecutor.ts for testability. The tracker owns all
 * state related to:
 *   - Silence detection (time since last agent message)
 *   - Progressive stall levels (1-5 status messages, 6 auto-abort)
 *   - Subagent tracking (active Task tool_use_ids, threshold extension)
 *   - Level reset on activity resume
 *   - maxWatchdogLevel telemetry (never reset)
 *
 * See FOX-2810 for the subagent threshold extension rationale.
 */

export const WATCHDOG_THRESHOLDS = [30_000, 60_000, 120_000, 300_000, 600_000] as const;
export const WATCHDOG_THRESHOLDS_SUBAGENT = [120_000, 180_000, 240_000, 300_000, 600_000] as const;
export const AUTO_ABORT_MS = 1_800_000; // 30 min tool-in-flight ceiling (judge-extendable in later stages)
export const STREAMING_STALL_ABORT_MS = 600_000; // 10 min early abort when no tool is in flight

/**
 * Earlier abort ceiling for an INTERACTIVE turn stuck in the `awaiting_api`
 * phase — request sent to the provider, no first token / stream byte received.
 *
 * Intentionally CONSERVATIVE (5 min) and tunable from Stage-3 telemetry. The
 * `awaiting_api` phase is *inferred* from the last message type
 * (`inferWatchdogPhase`), NOT from provider liveness, and providers legitimately
 * allow >120s of pre-first-token silence (long reasoning, large context, queueing).
 * So this must stay comfortably above the longest expected legitimate
 * pre-first-token wait, well below the 10-min `STREAMING_STALL_ABORT_MS` ceiling,
 * and applies ONLY to interactive turns (automation keeps its 90-min hard cap +
 * the 10-min streaming ceiling — there is no user to click "Try again").
 */
export const AWAITING_API_STALL_ABORT_MS = 300_000; // 5 min — interactive awaiting_api hard stall (conservative; tune from Stage-3 telemetry)

/**
 * SOFT, non-destructive "still waiting" threshold for an INTERACTIVE turn stuck
 * in the `awaiting_api` phase (Stage 1b). At this point the turn keeps running —
 * we only surface an early, calm "this is taking longer than usual" affordance
 * with an inline "Try again / Stop" option, well before the 5-min hard terminal
 * (`AWAITING_API_STALL_ABORT_MS`).
 *
 * 30s (conservative + tunable): anchored to the existing `thinkingHint` duration
 * ladder boundary (`useWorkSurfaceView.ts` speaks up at 25s) so the two systems
 * read as one escalation, not two competing ones. The watchdog already fires its
 * own level-1 capture at the 30k threshold (`WATCHDOG_THRESHOLDS[0]`), so this
 * reuses a boundary the system already treats as "abnormally quiet" for a
 * no-first-token turn. Going earlier (e.g. 10s) would nag perfectly normal slow
 * turns; later (60s+) leaves the user in silent limbo too long. Like the hard
 * ceiling, `awaiting_api` is *inferred* from last-message-type (not provider
 * liveness), so this stays comfortably conservative and is tunable from Stage-3
 * time-to-first-token telemetry (REBEL-67Q, incl. the 133K-token case).
 */
export const AWAITING_API_SOFT_STALL_MS = 30_000; // 30s — interactive awaiting_api SOFT "still waiting" affordance (conservative; tune from Stage-3 telemetry)

/**
 * User-visible copy for the SOFT "still waiting" status (Stage 1b). Calm,
 * blame-free, brand-voice (chief-designer brief §3, recommended option 1).
 * Single source of truth lives in `@shared/constants/awaitingApiSoftStall` so
 * the producer (this executor path) and the reader (renderer State B + the
 * copy-leak eval) cannot drift; re-exported here for the executor's import
 * convenience. NO raw enums/codes (`awaiting_api`, timeout, ms) on the surface.
 */
export { AWAITING_API_SOFT_STALL_MESSAGE } from '@shared/constants/awaitingApiSoftStall';

export type WatchdogPhase = 'awaiting_tool' | 'awaiting_api' | 'streaming' | 'processing';

export interface WatchdogCheckResult {
  /** Whether a new level was reached this check. */
  escalated: boolean;
  /** Whether the auto-abort threshold (AUTO_ABORT_MS, default 30 min) was exceeded. */
  shouldAbort: boolean;
  /** The new watchdog level (0 = no stall). */
  level: number;
  /** Milliseconds since last agent message. */
  silentMs: number;
  /** Whether a subagent (Task) is currently active. */
  hasActiveSubagent: boolean;
  /** Number of active subagent Task tools. */
  activeSubagentCount: number;
  /** Inferred phase of the turn. */
  phase: WatchdogPhase;
  /** Whether this is the first time the watchdog fired this turn. */
  isFirstFire: boolean;
  /** The effective abort threshold in ms (phase-aware: STREAMING_STALL_ABORT_MS for streaming, AUTO_ABORT_MS for tool-in-flight or subagent). */
  effectiveAbortMs: number;
}

/**
 * Standalone phase inference — determines what the agent is doing based on
 * the last message type and whether a tool is currently in flight.
 *
 * Exported so that consumers like `turnErrorRecovery.ts` can call it without
 * needing a WatchdogTracker instance. The class's `inferPhase()` delegates here.
 */
export function inferWatchdogPhase(msgType?: string, toolInFlightSince?: number): WatchdogPhase {
  if (toolInFlightSince !== undefined) return 'awaiting_tool';
  if (msgType === 'user') return 'awaiting_api';
  if (msgType === 'assistant' || msgType === 'stream_event') return 'streaming';
  if (!msgType || msgType === 'system') return 'awaiting_api';
  return 'processing';
}

/**
 * Render the level-6 (safety-net auto-abort) watchdog status message, deriving
 * the minute count from `AUTO_ABORT_MS` so the user-visible copy stays in sync
 * with the constant.
 */
export function formatWatchdogAutoAbortMessage(autoAbortMs: number = AUTO_ABORT_MS): string {
  const minutes = Math.floor(autoAbortMs / 60_000);
  return `This turn has been silent for ${minutes} minutes. Stopping as a safety measure.`;
}

/**
 * Closed-form predicate over `RuntimeActivityEvent` for the level-1 watchdog
 * Sentry-capture gate. Each closed-union case is classified explicitly.
 *
 * Behaviour:
 *   - `null`                              → `false` (not suppressed; no activity yet)
 *   - `kind: 'token-delta'`               → `true`  (model is producing tokens)
 *   - `kind: 'tool-event'`, in-progress   → `true`  (pre-materialisation upstream activity)
 *   - `kind: 'tool-event'`, completed     → `false` (boundary event, not active production)
 *   - `kind: 'lifecycle'`                 → `false` (start/stop/boundary events)
 *   - `kind: 'unknown'`                   → `false` (FAIL-CLOSED — better captured than missed)
 *
 * The fail-closed default for `unknown` is the structural close on the Apr-20
 * → Apr-27 regression cycle: per `260427` postmortem prevention #5, the gate's
 * default for an unrecognised activity is to capture as a stall — better a
 * Sentry false positive than missing a real one.
 *
 * Pure function — no shared state.
 */
export function shouldSuppressLevel1WatchdogCapture(
  activity: RuntimeActivityEvent | null,
): boolean {
  if (activity === null) return false;
  switch (activity.kind) {
    case 'token-delta':
      return true;
    case 'tool-event': {
      const subkind = activity.subkind;
      switch (subkind) {
        case 'tool-call-in-progress':
          return true;
        case 'tool-call-completed':
          return false;
        default: {
          const _exhaustive: never = subkind;
          void _exhaustive;
          return false;
        }
      }
    }
    case 'lifecycle':
      return false;
    case 'unknown':
      return false;
    default: {
      const _exhaustive: never = activity;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * Pure predicate for the earlier, interactive-gated `awaiting_api` hard-stall
 * terminal (Stage 1a). Returns true ONLY when an INTERACTIVE turn has been
 * silent in the `awaiting_api` phase (request sent, no first token) past
 * `AWAITING_API_STALL_ABORT_MS`, with no raw-stream activity in flight.
 *
 * This is deliberately narrow so it cannot regress the existing ceilings:
 *   - `phase !== 'awaiting_api'`        → false (streaming/awaiting_tool/processing
 *                                          stay governed by STREAMING_STALL_ABORT_MS
 *                                          / AUTO_ABORT_MS)
 *   - `hasRawStreamActivity === true`   → false (the first byte/token has arrived;
 *                                          the turn is producing — the 10-min
 *                                          streaming ceiling governs from here)
 *   - `silentMs < AWAITING_API_STALL_ABORT_MS` → false (below the conservative ceiling)
 *   - `interactive === false`           → false (automation/headless turns keep the
 *                                          90-min hard cap + 10-min streaming ceiling;
 *                                          there is no user to click "Try again")
 *
 * `hasRawStreamActivity` should be derived from the SAME signal the executor uses
 * for the level-1 capture gate (`shouldSuppressLevel1WatchdogCapture(...) === true`
 * means a token-delta / in-progress tool activity is the latest raw-stream event).
 *
 * Pure function — no shared state.
 */
export function isAwaitingApiHardStall(args: {
  phase: WatchdogPhase;
  silentMs: number;
  hasRawStreamActivity: boolean;
  interactive: boolean;
}): boolean {
  const { phase, silentMs, hasRawStreamActivity, interactive } = args;
  if (!interactive) return false;
  if (phase !== 'awaiting_api') return false;
  if (hasRawStreamActivity) return false;
  return silentMs >= AWAITING_API_STALL_ABORT_MS;
}

/**
 * Pure predicate for the SOFT, non-destructive `awaiting_api` "still waiting"
 * affordance (Stage 1b). Mirrors {@link isAwaitingApiHardStall} exactly, but at
 * the earlier {@link AWAITING_API_SOFT_STALL_MS} (~30s) threshold. The turn is
 * NOT ended when this trips — we only surface an early calm "this is taking
 * longer than usual, Try again / Stop" affordance, leaving the spinner running.
 *
 * Same gate as the hard stall, so it can never fire while a turn is producing:
 *   - `phase !== 'awaiting_api'`               → false (a slowly-STREAMING turn is
 *                                                 making visible progress; it must
 *                                                 stay in State A "thinking", never
 *                                                 show "still waiting")
 *   - `hasRawStreamActivity === true`          → false (the first byte/token arrived)
 *   - `silentMs < AWAITING_API_SOFT_STALL_MS`  → false (below the soft threshold)
 *   - `interactive === false`                  → false (automation/headless turns
 *                                                 have no user to reassure / retry)
 *
 * Note: the soft threshold is BELOW the hard ceiling, so once the hard stall
 * fires the turn ends regardless. The one-shot-per-turn dispatch + clear-on-
 * activity-resume sequencing is owned by the executor (this stays pure).
 *
 * Pure function — no shared state.
 */
export function isAwaitingApiSoftStall(args: {
  phase: WatchdogPhase;
  silentMs: number;
  hasRawStreamActivity: boolean;
  interactive: boolean;
}): boolean {
  const { phase, silentMs, hasRawStreamActivity, interactive } = args;
  if (!interactive) return false;
  if (phase !== 'awaiting_api') return false;
  if (hasRawStreamActivity) return false;
  return silentMs >= AWAITING_API_SOFT_STALL_MS;
}

export class WatchdogTracker {
  private lastMessageTime: number;
  private level = 0;
  private _maxLevel = 0;
  private _fired = false;
  private _firedAt: number | undefined;
  private _lastMessageType: string | undefined;
  private _lastToolName: string | undefined;
  /** Tracks each in-flight tool by tool_use_id → start timestamp.
   *  Replaces the old single _toolInFlightSince which was blind to parallel tools:
   *  when the first of two parallel tools completed, it cleared the flag even
   *  though the second was still running. */
  private readonly _toolsInFlight = new Map<string, number>();
  private readonly activeTaskToolUseIds = new Set<string>();

  constructor(now = Date.now()) {
    this.lastMessageTime = now;
  }

  // ---------------------------------------------------------------------------
  // Public getters
  // ---------------------------------------------------------------------------
  get watchdogLevel(): number { return this.level; }
  get maxWatchdogLevel(): number { return this._maxLevel; }
  get fired(): boolean { return this._fired; }
  get firedAt(): number | undefined { return this._firedAt; }
  get lastMessageType(): string | undefined { return this._lastMessageType; }
  get lastToolName(): string | undefined { return this._lastToolName; }
  get toolInFlightSince(): number | undefined {
    if (this._toolsInFlight.size === 0) return undefined;
    // Return the earliest start timestamp (oldest in-flight tool)
    let earliest = Infinity;
    for (const ts of this._toolsInFlight.values()) {
      if (ts < earliest) earliest = ts;
    }
    return earliest;
  }
  get toolsInFlightCount(): number { return this._toolsInFlight.size; }
  get hasActiveSubagent(): boolean { return this.activeTaskToolUseIds.size > 0; }
  get activeSubagentCount(): number { return this.activeTaskToolUseIds.size; }

  /**
   * Reset tracker state after a tool is cancelled by the watchdog judge.
   * Removes the cancelled tool from in-flight tracking and re-anchors silence.
   *
   * Intentionally NOT reset (telemetry preservation):
   * - _maxLevel: highest level the watchdog reached this turn
   * - _fired: whether watchdog ever fired
   * - _firedAt: timestamp of first fire
   */
  markToolCancelledForWatchdog(toolUseId: string, now: number): void {
    this.lastMessageTime = now;
    this.level = 0;
    this._toolsInFlight.delete(toolUseId);
    this.activeTaskToolUseIds.delete(toolUseId);
  }

  // ---------------------------------------------------------------------------
  // Message processing — call on each agent message in the for-await loop
  // ---------------------------------------------------------------------------

  /**
   * Process an incoming agent message. Updates lastMessageTime, resets transient
   * level, and tracks tool/subagent state.
   *
   * Returns { levelWasReset, previousLevel } so the caller can log the reset.
   */
  onMessage(message: { type: string; message?: { content?: unknown[] } }, now = Date.now()): {
    levelWasReset: boolean;
    previousLevel: number;
  } {
    const previousLevel = this.level;
    this.lastMessageTime = now;
    this._lastMessageType = message.type;

    // Reset transient level on activity resume (FOX-2810)
    if (this.level > 0) {
      this.level = 0;
    }

    // Track tool lifecycle and subagent state
    if (message.type === 'assistant') {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const raw of content) {
          const block = raw as Record<string, unknown>;
          if (block?.type === 'tool_use' && block?.name) {
            this._lastToolName = block.name as string;
            const toolId = block.id as string | undefined;
            if (toolId) {
              this._toolsInFlight.set(toolId, now);
            }
            if (isSubAgentTool(block.name as string) && block.id) {
              this.activeTaskToolUseIds.add(block.id as string);
            }
          }
        }
      }
    } else if (message.type === 'user') {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const raw of content) {
          const block = raw as Record<string, unknown>;
          if (block?.type === 'tool_result' && block?.tool_use_id) {
            this._toolsInFlight.delete(block.tool_use_id as string);
            this.activeTaskToolUseIds.delete(block.tool_use_id as string);
          }
        }
      }
    } else if (message.type === 'result' || message.type === 'error') {
      this._toolsInFlight.clear();
      this.activeTaskToolUseIds.clear();
    }

    return { levelWasReset: previousLevel > 0, previousLevel };
  }

  // ---------------------------------------------------------------------------
  // Watchdog check — call from the setInterval callback
  // ---------------------------------------------------------------------------

  /**
   * Evaluate the current silence duration against thresholds.
   * Returns a result describing whether a new level was reached.
   *
   * @param now - Current timestamp (defaults to Date.now())
   * @param skipCommit - If true, computes the result without mutating internal state.
   *   Use this when the caller needs to defer state updates (e.g., when waiting for
   *   user approval in agentTurnExecutor). Call `commitCheck(result)` later to apply.
   * @param activityAgeMs - Optional age of most recent activity from an external source
   *   (e.g., raw stream bytes, agent turn registry). When provided, silentMs is
   *   `Math.min(now - lastMessageTime, activityAgeMs)`, matching the executor's
   *   unified liveness calculation. When omitted, falls back to message-time only
   *   (backwards-compatible).
   * @param extendedCeilingMs - Optional external override for the abort threshold.
   *   This can only extend the computed threshold (never shorten it): values less
   *   than or equal to the computed phase-aware abort threshold are ignored
   *   (strict `>`; equality is treated as a no-op since the result is identical).
   *   Phase-agnostic by design — the tracker applies any larger override regardless
   *   of streaming-stall vs tool-in-flight phase. Phase-binding (whether the
   *   extension should be active for the current phase) is owned by the executor.
   */
  check(
    now = Date.now(),
    skipCommit = false,
    activityAgeMs?: number,
    extendedCeilingMs?: number,
  ): WatchdogCheckResult {
    const messageSilentMs = now - this.lastMessageTime;
    const silentMs = activityAgeMs !== undefined ? Math.min(messageSilentMs, activityAgeMs) : messageSilentMs;
    const hasActiveSubagent = this.activeTaskToolUseIds.size > 0;
    const thresholds = hasActiveSubagent ? WATCHDOG_THRESHOLDS_SUBAGENT : WATCHDOG_THRESHOLDS;

    let newLevel = 0;
    for (let i = 0; i < thresholds.length; i++) {
      if (silentMs > thresholds[i]) {
        newLevel = i + 1;
      }
    }

    let shouldAbort = false;
    // Phase-aware early abort: when no tool is in flight (streaming/awaiting_api),
    // abort after STREAMING_STALL_ABORT_MS (10 min) instead of waiting for the
    // AUTO_ABORT_MS safety net. Tool execution and subagent gaps are expected to
    // be long — only abort those at AUTO_ABORT_MS (default 30 min).
    const isToolInFlight = this._toolsInFlight.size > 0;
    const computedEffectiveAbortMs = (!isToolInFlight && !hasActiveSubagent)
      ? STREAMING_STALL_ABORT_MS
      : AUTO_ABORT_MS;
    // Intentionally phase-agnostic: if callers provide a larger override, apply it.
    // The executor decides when an extension should be active for a given phase.
    const effectiveAbortMs = (
      extendedCeilingMs !== undefined
      && extendedCeilingMs > computedEffectiveAbortMs
    )
      ? extendedCeilingMs
      : computedEffectiveAbortMs;
    if (silentMs > effectiveAbortMs) {
      newLevel = thresholds.length + 1;
      shouldAbort = true;
    }

    const escalated = newLevel > this.level;
    let isFirstFire = false;

    if (escalated && !skipCommit) {
      if (!this._fired) {
        this._fired = true;
        this._firedAt = now;
        isFirstFire = true;
      }
      this.level = newLevel;
      this._maxLevel = Math.max(this._maxLevel, newLevel);
    }

    return {
      escalated,
      shouldAbort,
      level: newLevel,
      silentMs,
      hasActiveSubagent,
      activeSubagentCount: this.activeTaskToolUseIds.size,
      phase: this.inferPhase(),
      isFirstFire,
      effectiveAbortMs,
    };
  }

  /**
   * Apply a previously computed check result to internal state.
   * Use after `check(now, skipCommit=true)` when the caller decides to proceed.
   */
  commitCheck(result: WatchdogCheckResult, now = Date.now()): void {
    if (result.escalated) {
      if (!this._fired) {
        this._fired = true;
        this._firedAt = now;
      }
      this.level = result.level;
      this._maxLevel = Math.max(this._maxLevel, result.level);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  inferPhase(): WatchdogPhase {
    return inferWatchdogPhase(this._lastMessageType, this.toolInFlightSince);
  }
}
