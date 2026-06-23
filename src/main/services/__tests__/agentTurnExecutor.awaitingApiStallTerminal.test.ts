/**
 * Stage 1a (260617_bricked-state-0448-electron42): the interactive `awaiting_api`
 * hard-stall terminal must end the turn as a RECOGNISED retryable
 * `message_timeout` so the renderer surfaces the existing "Try again" affordance.
 *
 * `executeAgentTurn` is too heavyweight to harness directly (model client, MCP,
 * settings, IPC, registry, tool registry, plugin pre-turn, …). Following the
 * established extracted-pure-function pattern (`agentTurnExecutor.watchdogGate.test.ts`),
 * this file tests the extracted dispatch-contract builder + the terminal-dispatch
 * helper that the post-loop block invokes.
 *
 * The load-bearing assertion: the explicit `errorKindOverride: 'message_timeout'`
 * (+ `isTransient: true`, `markActionable: true`) is what produces the Try-again
 * copy/action — `isTransient` alone would NOT (the dispatcher only derives
 * `message_timeout` from a `MessageTimeoutError` name or this explicit override).
 * And the synthetic `result('error')` MUST follow the error event so a renderer
 * would clear `isBusy`.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAwaitingApiTimeoutDispatchOptions,
  dispatchAwaitingApiTimeoutTerminal,
} from '@core/services/turnPipeline/awaitingApiTimeoutTerminal';
import { shouldAutoExtend } from '../agentTurnExecutor';
import {
  isAwaitingApiHardStall,
  AWAITING_API_STALL_ABORT_MS,
} from '../watchdogTracker';
import { derivePolicy } from '@core/services/turnPolicy';
import type { SessionType } from '@core/services/promptTemplateService';

describe('buildAwaitingApiTimeoutDispatchOptions (Stage 1a, 260617)', () => {
  it('pins errorKindOverride to message_timeout (REQUIRED for the Try-again surface)', () => {
    const opts = buildAwaitingApiTimeoutDispatchOptions('copy');
    expect(opts.errorKindOverride).toBe('message_timeout');
  });

  it('marks the terminal transient + actionable so the renderer offers a retry', () => {
    const opts = buildAwaitingApiTimeoutDispatchOptions('copy');
    expect(opts.isTransient).toBe(true);
    expect(opts.markActionable).toBe(true);
  });

  it('threads the humanized override through verbatim', () => {
    const opts = buildAwaitingApiTimeoutDispatchOptions('This turn was unresponsive…');
    expect(opts.humanizedOverride).toBe('This turn was unresponsive…');
  });
});

describe('dispatchAwaitingApiTimeoutTerminal (Stage 1a, 260617)', () => {
  it('dispatches the message_timeout error event THEN the synthetic result(error) — in that order', () => {
    const calls: string[] = [];
    let capturedError: Error | undefined;
    let capturedOptions: ReturnType<typeof buildAwaitingApiTimeoutDispatchOptions> & {
      watchdogDiagnostic?: unknown;
    } | undefined;

    dispatchAwaitingApiTimeoutTerminal({
      humanizedOverride: 'This turn was unresponsive for 5 minutes and was stopped automatically. You can try sending your message again.',
      dispatchError: (error, options) => {
        calls.push('error');
        capturedError = error;
        capturedOptions = options;
      },
      dispatchSyntheticErrorResult: () => {
        calls.push('synthetic-result');
      },
    });

    // Ordering: error event first (carries the retry surface), synthetic result
    // second (the terminal that clears renderer isBusy).
    expect(calls).toEqual(['error', 'synthetic-result']);

    // The dispatched error carries the required message_timeout retryable contract.
    expect(capturedError).toBeInstanceOf(Error);
    expect(capturedOptions?.errorKindOverride).toBe('message_timeout');
    expect(capturedOptions?.isTransient).toBe(true);
    expect(capturedOptions?.markActionable).toBe(true);
  });

  it('forwards the watchdogDiagnostic payload when provided, omits the key when not', () => {
    let withDiagnostic: { watchdogDiagnostic?: unknown } | undefined;
    dispatchAwaitingApiTimeoutTerminal({
      humanizedOverride: 'copy',
      watchdogDiagnostic: {
        phase: 'awaiting_api',
        messageCount: 3,
        rawStreamEventCount: 0,
        rawStreamLastEventType: null,
        rawStreamLastEventAgeMs: null,
        watchdogLevel: 5,
        maxWatchdogLevel: 5,
        effectiveAbortMs: 300_000,
        model: 'claude-test',
      },
      dispatchError: (_error, options) => {
        withDiagnostic = options;
      },
      dispatchSyntheticErrorResult: () => {},
    });
    expect(withDiagnostic?.watchdogDiagnostic).toMatchObject({ phase: 'awaiting_api', effectiveAbortMs: 300_000 });

    let withoutDiagnostic: { watchdogDiagnostic?: unknown } | undefined;
    dispatchAwaitingApiTimeoutTerminal({
      humanizedOverride: 'copy',
      dispatchError: (_error, options) => {
        withoutDiagnostic = options;
      },
      dispatchSyntheticErrorResult: () => {},
    });
    expect(withoutDiagnostic && 'watchdogDiagnostic' in withoutDiagnostic).toBe(false);
  });
});

// =============================================================================
// Stage 1a (260617) FIX 2: the interactive awaiting_api hard ceiling DELIBERATELY
// pre-empts judge auto-extension. The executor's watchdog tick runs the
// `isAwaitingApiHardStall` check (which aborts + returns) BEFORE `shouldAutoExtend`.
// These tests document the supersession is intentional: at the 5-min ceiling for
// an interactive awaiting_api stall, `shouldAutoExtend` WOULD have extended (so the
// pre-emption is real, not a no-op), and the hard-stall predicate fires at exactly
// that point. (Note: the auto-extension was already INERT for awaiting_api because
// its `extendedCeilingMs` only takes effect when baseCeilingMs === AUTO_ABORT_MS —
// i.e. a tool/subagent in flight — which an awaiting_api stall never has.)
// =============================================================================
describe('awaiting_api hard ceiling deliberately supersedes judge auto-extension (Stage 1a, 260617)', () => {
  it('at the 5-min ceiling, an interactive awaiting_api stall trips the hard-stall predicate', () => {
    expect(
      isAwaitingApiHardStall({
        phase: 'awaiting_api',
        silentMs: AWAITING_API_STALL_ABORT_MS,
        hasRawStreamActivity: false,
        interactive: true,
      }),
    ).toBe(true);
  });

  it('shouldAutoExtend WOULD have extended at the same point (proving the pre-emption is real)', () => {
    // First-call modest silence (5 min < 25 min, priorExtensionCount 0) → extend.
    // Since the executor returns on the hard-stall check BEFORE this runs, the
    // extension never happens for an interactive awaiting_api stall.
    const decision = shouldAutoExtend({
      priorExtensionCount: 0,
      hasActiveSubagent: false,
      silentMs: AWAITING_API_STALL_ABORT_MS,
    });
    expect(decision.extend).toBe(true);
  });
});

// =============================================================================
// Stage 1a (260617) MEDIUM: the executor's interactive gate is
// `effectivePolicy.origin === 'manual'`. TurnPolicy.origin is only
// 'manual' | 'automation'; interactive + cli + mcp_server all resolve to
// 'manual' (turnPolicy.ts), so the awaiting_api ceiling correctly applies to
// ALL of them — a stalled cli/mcp_server turn also ends cleanly + retryably at
// 5 min. ONLY 'automation' is excluded (no user to retry; keeps 10-min ceiling +
// 90-min hard cap). This test pins the origin→interactive mapping against the
// real policy defaults so a future policy change can't silently flip it.
// =============================================================================
describe('interactive gate origin mapping (Stage 1a, 260617)', () => {
  const atCeiling = (interactive: boolean) =>
    isAwaitingApiHardStall({
      phase: 'awaiting_api',
      silentMs: AWAITING_API_STALL_ABORT_MS,
      hasRawStreamActivity: false,
      interactive,
    });

  it('manual-origin session types (interactive, cli, mcp_server) trip the ceiling', () => {
    const manualSessionTypes: SessionType[] = ['interactive', 'cli', 'mcp_server'];
    for (const sessionType of manualSessionTypes) {
      const policy = derivePolicy(sessionType);
      expect(policy.origin).toBe('manual');
      expect(atCeiling(policy.origin === 'manual')).toBe(true);
    }
  });

  it('automation-origin turns do NOT trip the ceiling', () => {
    const policy = derivePolicy('automation');
    expect(policy.origin).toBe('automation');
    expect(atCeiling(policy.origin === 'manual')).toBe(false);
  });
});
