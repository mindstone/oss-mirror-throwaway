/**
 * Tool Failure Tracker — Circuit breaker for agent tool execution.
 *
 * Tracks consecutive identical errors (per-tool and global), total tool call count,
 * and emits advisories to redirect the agent when failures spiral.
 *
 * Pure class with no side effects — all state is internal. Designed for easy
 * unit testing with injected `now()` function.
 *
 * Advisory messages use static classifications only — no raw error text is included
 * to prevent prompt injection from malicious MCP servers.
 */

// --- Constants (not configurable — keep simple) ---

/** Per-tool: N identical consecutive errors → advisory */
export const CONSECUTIVE_ERROR_LIMIT = 3;

/** Global: N consecutive errors across ANY tools → advisory */
export const GLOBAL_CONSECUTIVE_FAILURE_LIMIT = 5;

/** Soft budget: inject "wrap up" advisory */
export const SOFT_TOOL_CALL_BUDGET = 800;

/** Hard budget: force-stop the turn */
export const HARD_TOOL_CALL_BUDGET = 1000;

// --- Types ---

export interface ToolFailureAdvisory {
  type: 'consecutive_error' | 'global_consecutive_error' | 'soft_budget' | 'hard_budget';
  message: string;
}

export interface ToolFailureErrorBatchEntry {
  toolName: string;
  errorText: string;
}

// --- Error signature normalization ---

/**
 * Strip non-deterministic noise from error text to produce a stable signature
 * for identical-error detection. Removes UUIDs, timestamps, large numbers,
 * and trims to first 100 characters.
 */
export function normalizeErrorSignature(errorText: string): string {
  return errorText
    // Strip UUIDs (8-4-4-4-12 hex)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    // Strip ISO timestamps (2026-04-07T12:34:56.789Z variants)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\dZ+-]*/g, '<TIMESTAMP>')
    // Strip numbers with more than 6 digits (IDs, timestamps as numbers)
    .replace(/\d{7,}/g, '<NUM>')
    // Trim to first 100 chars
    .slice(0, 100);
}

// --- Tracker class ---

export class ToolFailureTracker {
  private totalToolCalls = 0;

  // Per-tool consecutive error tracking: tool → { signature, count }
  private perToolErrors = new Map<string, { signature: string; count: number }>();

  // Global consecutive error counter (any tool)
  private globalConsecutiveErrors = 0;

  // Advisory cooldown: Set of "{toolName}:{signature}" keys already emitted
  private emittedAdvisories = new Set<string>();

  // Whether soft budget advisory has been emitted
  private softBudgetEmitted = false;

  /**
   * Record a successful tool call. Resets all consecutive error counters.
   */
  recordToolSuccess(): void {
    this.totalToolCalls++;
    this.globalConsecutiveErrors = 0;
    // Reset all per-tool consecutive error tracking on any success
    this.perToolErrors.clear();
  }

  /**
   * Record a tool call that returned an error.
   */
  recordToolError(toolName: string, errorText: string): void {
    this.totalToolCalls++;
    this.globalConsecutiveErrors++;

    const signature = normalizeErrorSignature(errorText);
    const current = this.perToolErrors.get(toolName);

    if (current && current.signature === signature) {
      current.count++;
    } else {
      // Different error or first error for this tool — reset
      this.perToolErrors.set(toolName, { signature, count: 1 });
    }
  }

  /**
   * Record a batch of errored tool calls from a single fan-out.
   *
   * Global counter increments once per non-empty batch (one concurrent round).
   * Per-tool counters dedupe by (toolName, normalizedSignature) so a single
   * concurrent burst does not look like repeated retries of the same failure.
   */
  recordToolErrorBatch(errors: ToolFailureErrorBatchEntry[]): void {
    if (errors.length === 0) return;

    this.totalToolCalls += errors.length;
    this.globalConsecutiveErrors += 1;

    const seenPairs = new Set<string>();

    for (const { toolName, errorText } of errors) {
      const signature = normalizeErrorSignature(errorText);
      const pairKey = `${toolName}\u0000${signature}`;
      if (seenPairs.has(pairKey)) {
        continue;
      }
      seenPairs.add(pairKey);

      const current = this.perToolErrors.get(toolName);
      if (current && current.signature === signature) {
        current.count++;
      } else {
        this.perToolErrors.set(toolName, { signature, count: 1 });
      }
    }
  }

  /**
   * Check if an advisory should be emitted based on current state.
   * Returns the highest-priority advisory, or null if none.
   *
   * Priority: hard_budget > soft_budget > global_consecutive_error > consecutive_error
   */
  getAdvisory(): ToolFailureAdvisory | null {
    // Hard budget — always fires, terminates the loop
    if (this.totalToolCalls >= HARD_TOOL_CALL_BUDGET) {
      return {
        type: 'hard_budget',
        message: `[SYSTEM] This turn has exceeded the maximum tool call limit (${HARD_TOOL_CALL_BUDGET}). The turn must end now.`,
      };
    }

    // Soft budget — fires once at threshold
    if (this.totalToolCalls >= SOFT_TOOL_CALL_BUDGET && !this.softBudgetEmitted) {
      this.softBudgetEmitted = true;
      return {
        type: 'soft_budget',
        message: `[SYSTEM] This turn has used ${SOFT_TOOL_CALL_BUDGET} tool calls. Please wrap up your current work and provide your findings.`,
      };
    }

    // Global consecutive failures (across any tools)
    if (this.globalConsecutiveErrors >= GLOBAL_CONSECUTIVE_FAILURE_LIMIT) {
      const cooldownKey = '__global__:breaker';
      if (!this.emittedAdvisories.has(cooldownKey)) {
        this.emittedAdvisories.add(cooldownKey);
        return {
          type: 'global_consecutive_error',
          message: `[SYSTEM] ${this.globalConsecutiveErrors} consecutive tool calls have failed. Stop retrying and try a completely different approach, or explain what you've accomplished so far.`,
        };
      }
    }

    // Per-tool consecutive identical errors
    for (const [toolName, state] of this.perToolErrors) {
      if (state.count >= CONSECUTIVE_ERROR_LIMIT) {
        const cooldownKey = `${toolName}:${state.signature}`;
        if (!this.emittedAdvisories.has(cooldownKey)) {
          this.emittedAdvisories.add(cooldownKey);
          return {
            type: 'consecutive_error',
            message: `[SYSTEM] Tool "${toolName}" has failed ${state.count} times consecutively with the same error. Stop using this tool and try an alternative approach.`,
          };
        }
      }
    }

    return null;
  }

  /** Current total tool call count (for diagnostics). */
  getTotalToolCalls(): number {
    return this.totalToolCalls;
  }

  /**
   * Returns true when the given (toolName, errorText) collapses to a
   * normalized signature already seen for the SAME tool earlier in this turn.
   * Designed to be called BEFORE recordToolError so callers can inspect the
   * pre-update state. The check uses the same normalization pipeline as
   * recordToolError to keep the answer consistent across the codebase.
   *
   * Used by Stage 1a `tool_call_error` diagnostic emit (A3 / A12).
   */
  isRepeatOfNormalizedSignature(toolName: string, errorText: string): boolean {
    const current = this.perToolErrors.get(toolName);
    if (!current) return false;
    return current.signature === normalizeErrorSignature(errorText);
  }
}
