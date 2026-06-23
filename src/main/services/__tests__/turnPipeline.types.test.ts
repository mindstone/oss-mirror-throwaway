/**
 * Turn Pipeline — Type Contracts (R1 Stage 1)
 *
 * Compile-time + runtime tests for the typed phase pipeline contracts:
 *   - Four-state `TurnPhaseResult<T>` exhaustive `assertNever`.
 *   - `failed-recoverable` REQUIRES `recovery` (TS compile-error guarded by
 *     `// @ts-expect-error` lines).
 *   - `failed-terminal` REQUIRES `completion`.
 *   - `TurnRecoveryDirective` is exhaustively switchable.
 *   - `keyof ErrorRecoveryContext ⊆ keyof TurnCompletionBaseContext &
 *      ResolvedRuntimePhaseAccumulator & MutableTrackingCounters &
 *      MutableWatchdogDiagnostics` — adding a new field to
 *     `ErrorRecoveryContext` without placing it in either bucket fails the
 *     test at compile time.
 *   - Exhaustive `Record<TurnCleanupKey, CleanupFn | null>` compiles for both
 *     attempt-scope and terminal-scope; a sentinel-key fixture demonstrates
 *     the compile error if registered in only one.
 *
 * These are the structural contracts — Stage 2+ phase impls + replay corpus
 * are the behavioural contracts.
 */

import { describe, it, expect } from 'vitest';
import { assertNever } from '@shared/utils/assertNever';
import type {
  TurnPhaseResult,
  TurnRecoveryDirective,
  TurnCompletionDirective,
  TurnCleanupReason,
  TurnCleanupKey,
  AttemptCleanupFnsRecord,
  TerminalCleanupFnsRecord,
  CleanupFn,
  ErrorRecoveryFieldCoverage,
  TurnCompletionBaseContext,
  ResolvedRuntimePhaseAccumulator,
  MutableTrackingCounters,
  MutableWatchdogDiagnostics,
  RuntimePhaseAccumulator,
} from '../turnPipeline';
import type { ErrorRecoveryContext } from '../turnErrorRecovery';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type-level assertion: `T` must be `true`. */
type Expect<T extends true> = T;
/** Type-level equality: are `A` and `B` mutually assignable? */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// ---------------------------------------------------------------------------
// SECTION 1: TurnPhaseResult<T> exhaustive switch
// ---------------------------------------------------------------------------

describe('TurnPhaseResult<T> — four-state exhaustive switch', () => {
  it('compiles when every status arm is handled (assertNever default)', () => {
    function classify<T>(result: TurnPhaseResult<T>): string {
      switch (result.status) {
        case 'ok':
          return 'ok';
        case 'terminal':
          return `terminal:${result.reason}`;
        case 'failed-recoverable':
          return `failed-recoverable:${result.recovery.kind}`;
        case 'failed-terminal':
          return `failed-terminal:${result.completion.reason}`;
        default:
          return assertNever(result);
      }
    }
    expect(classify({ status: 'ok', value: 42 })).toBe('ok');
    expect(classify<number>({ status: 'terminal', reason: 'completed' })).toBe('terminal:completed');
    expect(
      classify<number>({
        status: 'failed-recoverable',
        error: { phase: 'admission', cause: new Error('boom') },
        recovery: { kind: 'recursive-retry' },
      }),
    ).toBe('failed-recoverable:recursive-retry');
    expect(
      classify<number>({
        status: 'failed-terminal',
        error: { phase: 'admission', cause: new Error('boom') },
        completion: { reason: 'pre-runtime-failure' },
      }),
    ).toBe('failed-terminal:pre-runtime-failure');
  });

  it('rejects "failed-recoverable" without recovery (compile error)', () => {
    // @ts-expect-error — `failed-recoverable` REQUIRES `recovery` field
    const _missingRecovery: TurnPhaseResult<number> = {
      status: 'failed-recoverable',
      error: { phase: 'admission', cause: new Error('x') },
    };
    void _missingRecovery;
    expect(true).toBe(true);
  });

  it('rejects "failed-terminal" without completion (compile error)', () => {
    // @ts-expect-error — `failed-terminal` REQUIRES `completion` field
    const _missingCompletion: TurnPhaseResult<number> = {
      status: 'failed-terminal',
      error: { phase: 'admission', cause: new Error('x') },
    };
    void _missingCompletion;
    expect(true).toBe(true);
  });

  it('rejects "terminal" without reason (compile error)', () => {
    // @ts-expect-error — `terminal` REQUIRES `reason` field
    const _missingReason: TurnPhaseResult<number> = { status: 'terminal' };
    void _missingReason;
    expect(true).toBe(true);
  });

  it('rejects unknown status string (compile error)', () => {
    // @ts-expect-error — `'__test_status'` is not a member of the closed union
    const _badStatus: TurnPhaseResult<number> = { status: '__test_status' };
    void _badStatus;
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SECTION 2: TurnRecoveryDirective exhaustive switch
// ---------------------------------------------------------------------------

describe('TurnRecoveryDirective — exhaustive switch', () => {
  it('compiles when every directive kind is handled', () => {
    function describeDirective(d: TurnRecoveryDirective): string {
      switch (d.kind) {
        case 'recursive-retry':
          return 'recursive-retry';
        case 'cooldown-then-retry':
          return `cooldown-then-retry:${d.waitMs}`;
        case 'overflow-compaction-handoff':
          return 'overflow-compaction-handoff';
        case 'abort-acknowledge':
          return 'abort-acknowledge';
        case 'terminal-error-dispatch':
          return `terminal-error-dispatch:${d.humanizedMessage}`;
        default:
          return assertNever(d);
      }
    }
    expect(describeDirective({ kind: 'recursive-retry' })).toBe('recursive-retry');
    expect(describeDirective({ kind: 'cooldown-then-retry', waitMs: 1000 })).toBe('cooldown-then-retry:1000');
    expect(
      describeDirective({ kind: 'overflow-compaction-handoff', compactionPrompt: '' }),
    ).toBe('overflow-compaction-handoff');
    expect(describeDirective({ kind: 'abort-acknowledge' })).toBe('abort-acknowledge');
    expect(
      describeDirective({ kind: 'terminal-error-dispatch', humanizedMessage: 'oh no' }),
    ).toBe('terminal-error-dispatch:oh no');
  });
});

// ---------------------------------------------------------------------------
// SECTION 3: TurnCompletionDirective.reason ⊆ TurnCleanupReason
// ---------------------------------------------------------------------------

describe('TurnCompletionDirective + TurnCleanupReason', () => {
  it('compiles with valid reasons', () => {
    const completed: TurnCompletionDirective = { reason: 'completed' };
    const aborted: TurnCompletionDirective = { reason: 'aborted' };
    const preRuntime: TurnCompletionDirective = { reason: 'pre-runtime-failure' };
    expect(completed.reason).toBe('completed');
    expect(aborted.reason).toBe('aborted');
    expect(preRuntime.reason).toBe('pre-runtime-failure');
  });

  it('rejects unknown reason string (compile error)', () => {
    // @ts-expect-error — `'__not_a_reason'` is not a member of TurnCleanupReason
    const _bad: TurnCompletionDirective = { reason: '__not_a_reason' };
    void _bad;
    expect(true).toBe(true);
  });

  it('includes all 14 terminal-exit reasons enumerated by Stage 0', () => {
    // Sanity: every reason in Stage 0 § A is assignable to TurnCleanupReason.
    const reasons: TurnCleanupReason[] = [
      'missing-core-directory',
      'codex-not-connected',
      'openrouter-not-connected',
      'missing-auth',
      'aborted',
      'invalid-core-directory',
      'profile-incompatible',
      'council-proxy-failed',
      'council-proxy-missing-auth',
      'openrouter-proxy-failed',
      'completed',
      'hook-stopped',
      'watchdog-aborted',
      'pre-runtime-failure',
    ];
    expect(reasons.length).toBeGreaterThanOrEqual(13);
  });
});

// ---------------------------------------------------------------------------
// SECTION 4: ErrorRecoveryContext field coverage (Round 4 finding #4)
// ---------------------------------------------------------------------------

describe('ErrorRecoveryContext field coverage', () => {
  it('has every field assigned to either base context or runtime accumulator or mutable bags', () => {
    // Compile-time check: every key in `ErrorRecoveryContext` is covered.
    type CoverageOk = Expect<Equal<ErrorRecoveryFieldCoverage, true>>;
    const ok: CoverageOk = true;
    expect(ok).toBe(true);
  });

  it('keyof ErrorRecoveryContext is assignable to the union of bucket keys', () => {
    // Runtime sanity to ensure the type-level statement is exercised.
    type RecoveryKeys = keyof ErrorRecoveryContext;
    type BucketKeys =
      | keyof TurnCompletionBaseContext
      | keyof ResolvedRuntimePhaseAccumulator
      | keyof MutableTrackingCounters
      | keyof MutableWatchdogDiagnostics;
    type IsSubset = RecoveryKeys extends BucketKeys ? true : false;
    type AssertSubset = Expect<Equal<IsSubset, true>>;
    const ok: AssertSubset = true;
    expect(ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SECTION 5: Exhaustive cleanup-key records (Round 4 finding #5)
// ---------------------------------------------------------------------------

describe('Cleanup-key registry — exhaustive Record<TurnCleanupKey, CleanupFn | null>', () => {
  it('compiles when every TurnCleanupKey has an entry in attempt-scope', () => {
    const noop: CleanupFn = () => {};
    const attempt: AttemptCleanupFnsRecord = {
      councilTurnIds: noop,
      councilTurnMeta: noop,
      adHocTurnIds: noop,
      adHocTurnMeta: noop,
      proxyRoutes: noop,
      watchdogDisposer: noop,
      turnCheckpointing: noop,
      sleepBlocker: null,
      registryDeletion: null,
      sessionEventFinalization: null,
      costLedgerFlush: null,
      turnCompletedEvent: null,
      errorReporterScope: null,
    };
    expect(Object.keys(attempt).length).toBe(13);
  });

  it('compiles when every TurnCleanupKey has an entry in terminal-scope', () => {
    const noop: CleanupFn = () => {};
    const terminal: TerminalCleanupFnsRecord = {
      councilTurnIds: noop,
      councilTurnMeta: noop,
      adHocTurnIds: noop,
      adHocTurnMeta: noop,
      proxyRoutes: noop,
      watchdogDisposer: noop,
      turnCheckpointing: noop,
      sleepBlocker: noop,
      registryDeletion: noop,
      sessionEventFinalization: noop,
      costLedgerFlush: noop,
      turnCompletedEvent: noop,
      errorReporterScope: noop,
    };
    expect(Object.keys(terminal).length).toBe(13);
  });

  it('rejects partial cleanup record (compile error)', () => {
    // @ts-expect-error — missing keys; the exhaustive `Record` shape demands every TurnCleanupKey.
    const _partial: AttemptCleanupFnsRecord = {
      councilTurnIds: null,
      councilTurnMeta: null,
    };
    void _partial;
    expect(true).toBe(true);
  });

  it('demonstrates: a sentinel key not in the union is rejected at use site', () => {
    type Key = TurnCleanupKey;
    // @ts-expect-error — `'__test_key'` is not a member of `TurnCleanupKey`.
    const _bad: Key = '__test_key';
    void _bad;
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SECTION 6: RuntimePhaseAccumulator discriminated union
// ---------------------------------------------------------------------------

describe('RuntimePhaseAccumulator', () => {
  it('narrows pre-runtime arm cleanly', () => {
    const acc: RuntimePhaseAccumulator = { stage: 'pre-runtime' };
    if (acc.stage === 'pre-runtime') {
      // `modelConfig` etc. are explicitly typed as `undefined` in this arm —
      // this is the structural marker the orchestrator's catch block uses.
      expect(acc.modelConfig).toBeUndefined();
      expect(acc.queryOptions).toBeUndefined();
      expect(acc.providerRoutePlan).toBeUndefined();
    } else {
      throw new Error('expected pre-runtime');
    }
  });

  it('rejects mixing fields across arms (compile error)', () => {
    // The `'pre-runtime'` arm narrows `modelConfig` to `undefined`; the
    // `'runtime-ready'` arm requires `stage: 'runtime-ready'`. Mixing them
    // (a `'pre-runtime'` literal with the `runtime-ready` field set) is a
    // structural error — the object literal cannot satisfy either arm.
    const _mixed: RuntimePhaseAccumulator = {
      stage: 'pre-runtime',
      // @ts-expect-error — `error` does not exist on the `'pre-runtime'` arm.
      error: new Error('x'),
    };
    void _mixed;
    expect(true).toBe(true);
  });
});
