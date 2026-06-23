import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  canEnterDepth4,
  MAX_COMPACTION_ATTEMPTS,
  shouldSkipDepth4,
  transition,
  type RecoveryContext,
  type RecoveryState,
} from '../recoveryStateMachine';

const baseCtx = (overrides: Partial<RecoveryContext> = {}): RecoveryContext => ({
  phase: 'post_activity',
  depth: 0,
  attempt: 0,
  longContextFallbackAttempted: false,
  skeletonAttempted: false,
  isRecoveryModelAttempt: false,
  enableRecovery: true,
  sessionId: 'session-1',
  turnId: 'turn-1',
  originalSessionId: 'session-1',
  originalPrompt: 'User request',
  abortSignal: new AbortController().signal,
  messages: [],
  ...overrides,
});

describe('recoveryStateMachine', () => {
  it('T1.1 routes pre-activity overflow from idle to long-context fallback when target is configured', () => {
    const state = transition(
      { kind: 'idle' },
      { kind: 'overflow' },
      baseCtx({
        phase: 'pre_activity',
        longContextFallbackTarget: { kind: 'model', modelName: 'haiku' },
      }),
    );

    expect(state).toMatchObject({ kind: 'long_context_fallback' });
  });

  it('T1.1b skips fallback and routes pre-activity overflow to compacting when no target is configured (R-Stage4.A14)', () => {
    const state = transition(
      { kind: 'idle' },
      { kind: 'overflow' },
      baseCtx({ phase: 'pre_activity', longContextFallbackTarget: null }),
    );

    expect(state).toEqual({ kind: 'compacting', depth: 1, attempt: 1 });
  });

  it('T1.2 routes post-activity overflow from idle to compaction depth 1', () => {
    const state = transition({ kind: 'idle' }, { kind: 'overflow' }, baseCtx());

    expect(state).toEqual({ kind: 'compacting', depth: 1, attempt: 1 });
  });

  it('T1.3 advances attempts within MAX_COMPACTION_ATTEMPTS before increasing depth', () => {
    let state: RecoveryState = { kind: 'compacting', depth: 1, attempt: 1 };
    state = transition(state, { kind: 'compact_failed' }, baseCtx({ depth: 1, attempt: 1 }));

    expect(state).toEqual({ kind: 'compacting', depth: 1, attempt: 2 });
    expect(MAX_COMPACTION_ATTEMPTS).toBe(3);
  });

  it('T1.4 escalates after three failed attempts and never lowers the depth-3 cap', () => {
    const state = transition(
      { kind: 'compacting', depth: 1, attempt: 3 },
      { kind: 'compact_failed' },
      baseCtx({ depth: 1, attempt: 3 }),
    );

    expect(state).toEqual({ kind: 'compacting', depth: 2, attempt: 1 });
  });

  it('T1.5 transitions from exhausted depth 3 to recovery model when depth-4 is allowed', () => {
    const state = transition(
      { kind: 'compacting', depth: 3, attempt: 3 },
      { kind: 'compact_failed' },
      baseCtx({ depth: 3, attempt: 3 }),
    );

    expect(state).toEqual({ kind: 'recovery_model', profileId: 'pending' });
  });

  it('T1.6 canEnterDepth4 is false when recovery model was already attempted', () => {
    expect(canEnterDepth4(baseCtx({ isRecoveryModelAttempt: true }))).toBe(false);
  });

  it('T1.7 shouldSkipDepth4 is true when no qualifying profile exists', () => {
    expect(shouldSkipDepth4(baseCtx(), false)).toBe(true);
  });

  it('T1.8 abort from any state is terminal with exhaustedReason=aborted', () => {
    const states: RecoveryState[] = [
      { kind: 'idle' },
      { kind: 'long_context_fallback', target: { kind: 'model', modelName: 'opus' } },
      { kind: 'compacting', depth: 1, attempt: 1 },
      { kind: 'skeleton', attempt: 1 },
      { kind: 'recovery_model', profileId: 'profile-1' },
    ];

    for (const state of states) {
      expect(transition(state, { kind: 'abort' }, baseCtx())).toMatchObject({
        kind: 'terminal_failure',
        exhaustedReason: 'aborted',
      });
    }
  });

  it('T1.9 pre-activity skips depths 1-3 after long-context fallback fails with no messages', () => {
    const state = transition(
      { kind: 'long_context_fallback', target: { kind: 'model', modelName: 'opus' } },
      { kind: 'fallback_failed' },
      baseCtx({ phase: 'pre_activity', longContextFallbackAttempted: true, messages: [] }),
    );

    expect(state).toEqual({ kind: 'recovery_model', profileId: 'pending' });
  });

  it('T1.10 post-activity uses the full depth ladder before depth 4', () => {
    let state: RecoveryState = { kind: 'idle' };
    let ctx = baseCtx({ depth: 0 });
    state = transition(state, { kind: 'overflow' }, ctx);
    expect(state).toEqual({ kind: 'compacting', depth: 1, attempt: 1 });

    ctx = baseCtx({ depth: 1, attempt: 3 });
    state = transition({ kind: 'compacting', depth: 1, attempt: 3 }, { kind: 'compact_failed' }, ctx);
    expect(state).toEqual({ kind: 'compacting', depth: 2, attempt: 1 });

    ctx = baseCtx({ depth: 3, attempt: 3 });
    state = transition({ kind: 'compacting', depth: 3, attempt: 3 }, { kind: 'compact_failed' }, ctx);
    expect(state).toEqual({ kind: 'recovery_model', profileId: 'pending' });
  });

  it('T1.11 recovery states and events are JSON-serializable for cloud transport parity', () => {
    const state: RecoveryState = { kind: 'compacting', depth: 2, attempt: 1 };
    const event = { kind: 'compact_failed' as const, payload: { reason: 'test' } };

    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it('I7 recovery disabled fails fast on the first overflow', () => {
    const state = transition({ kind: 'idle' }, { kind: 'overflow' }, baseCtx({ enableRecovery: false }));

    expect(state).toMatchObject({ kind: 'terminal_failure', exhaustedReason: 'recovery_disabled' });
  });

  it('I20 rejects depth-4 re-entry after the recovery model has already overflowed', () => {
    const state = transition(
      { kind: 'idle' },
      { kind: 'overflow' },
      baseCtx({ depth: 3, isRecoveryModelAttempt: true }),
    );

    expect(state).toMatchObject({ kind: 'terminal_failure', exhaustedReason: 'depth_limit_reached' });
  });
});

// -----------------------------------------------------------------------------
// Edge-reachability (dead-transition) guard — REBEL-5BM structural prevention.
//
// REBEL-5BM shipped because the `fallback_failed` RecoveryEvent kind was
// *declared* on the state machine and *handled* by `transition()` (the
// long_context_fallback case escalates on it), but **no `recoveryPipeline.ts`
// path ever dispatched it**. A pre_activity long-context-fallback failure could
// therefore never reach the depth-4 escalation the edge was built for, and was
// mislabelled `summary_generation_failed` for 456 users over 21 days.
//
// This guard statically enumerates the declared RecoveryEvent kinds (the source
// of truth) and the kinds the pipeline actually dispatches through
// `transition(...)`, then asserts every declared kind is *accounted for*:
// either dispatched, or explicitly pinned below as architecturally not routed
// through `transition()`. A NEW declared edge that nothing dispatches — the
// exact `fallback_failed` shape — fails this test until it is wired or pinned.
//
// Source of truth (declared): the `RecoveryEvent['kind']` union in
//   recoveryStateMachine.ts.
// Dispatch sites: `transition(state, { kind: '<X>' }, ctx)` calls in
//   recoveryPipeline.ts.
// -----------------------------------------------------------------------------

const RECOVERY_SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Parse the declared `RecoveryEvent['kind']` union from recoveryStateMachine.ts. */
function declaredTransitionKinds(): string[] {
  const source = readFileSync(resolve(RECOVERY_SRC_DIR, 'recoveryStateMachine.ts'), 'utf8');
  const match = source.match(/export interface RecoveryEvent\s*\{\s*kind:\s*([\s\S]*?);/);
  if (!match) {
    throw new Error('Could not locate the RecoveryEvent kind union in recoveryStateMachine.ts');
  }
  const kinds = [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  return [...new Set(kinds)];
}

/**
 * Parse every event kind passed as the SECOND argument to a `transition(...)`
 * call in recoveryPipeline.ts. Tracks paren/brace/bracket depth so a comma
 * inside the first state-object argument does not mis-split the arguments.
 */
function dispatchedTransitionKinds(): Set<string> {
  const source = readFileSync(resolve(RECOVERY_SRC_DIR, 'recoveryPipeline.ts'), 'utf8');
  const dispatched = new Set<string>();
  const callRe = /transition\(/g;
  // We only need to walk match positions (via callRe.lastIndex); the match
  // object itself is unused, so don't bind it.
  while (callRe.exec(source) !== null) {
    let i = callRe.lastIndex;
    let paren = 1;
    let brace = 0;
    let bracket = 0;
    const args: string[] = [''];
    while (i < source.length && paren > 0) {
      const ch = source[i];
      if (ch === '(') paren++;
      else if (ch === ')') {
        paren--;
        if (paren === 0) break;
      } else if (ch === '{') brace++;
      else if (ch === '}') brace--;
      else if (ch === '[') bracket++;
      else if (ch === ']') bracket--;
      if (paren === 1 && brace === 0 && bracket === 0 && ch === ',') {
        args.push('');
        i++;
        continue;
      }
      args[args.length - 1] += ch;
      i++;
    }
    const eventArg = args[1] ?? '';
    const kindMatch = eventArg.match(/kind:\s*'([a-z_]+)'/);
    if (kindMatch) dispatched.add(kindMatch[1]);
  }
  return dispatched;
}

/**
 * Declared kinds the pipeline intentionally resolves WITHOUT round-tripping
 * through `transition(...)`: the pipeline detects these terminal/skip/success
 * outcomes directly (from `outcome.kind === 'success'` or from the
 * `recovery_model` profile checks) and builds the terminal state inline,
 * using the string only as an `exhaustedReason`/telemetry tag — never as a
 * `transition()` event kind. They are pinned here so the guard stays quiet for
 * them while still firing on any *new* undispatched edge.
 *
 * NOTE: these are genuinely not dispatched via `transition()` today. That is
 * an accepted design choice (the state machine doubles as an outcome
 * classifier for these branches), NOT the REBEL-5BM bug — the 5BM bug was a
 * loop/escalation edge (`fallback_failed`) that the pipeline was supposed to
 * drive but didn't. The dedicated `fallback_failed` assertion below pins that
 * distinction.
 */
const KNOWN_NOT_DISPATCHED_VIA_TRANSITION = new Set<string>([
  // success outcomes — pipeline returns terminal_success directly on outcome.kind === 'success'
  'compact_succeeded',
  'summary_generated',
  'skeleton_succeeded',
  'recovery_model_succeeded',
  // recovery-model terminal/skip outcomes — built inline in the recovery_model case
  'recovery_model_failed',
  'no_qualifying_profile',
  'rate_limited',
]);

describe('recoveryStateMachine edge-reachability (REBEL-5BM dead-transition guard)', () => {
  it('every declared RecoveryEvent kind is either dispatched by the pipeline or explicitly pinned as non-dispatched', () => {
    const declared = declaredTransitionKinds();
    const dispatched = dispatchedTransitionKinds();

    // Sanity: we successfully parsed both source-of-truth sets.
    expect(declared.length).toBeGreaterThan(0);
    expect(dispatched.size).toBeGreaterThan(0);

    const unaccounted = declared.filter(
      (kind) => !dispatched.has(kind) && !KNOWN_NOT_DISPATCHED_VIA_TRANSITION.has(kind),
    );

    // A declared edge that no pipeline path dispatches AND is not pinned is a
    // latent dead transition — the exact REBEL-5BM `fallback_failed` shape.
    expect(unaccounted).toEqual([]);
  });

  it('the REBEL-5BM `fallback_failed` escalation edge is dispatched by the pipeline (not pinned dead)', () => {
    const declared = declaredTransitionKinds();
    const dispatched = dispatchedTransitionKinds();

    // The edge must still be declared (state machine still handles it)...
    expect(declared).toContain('fallback_failed');
    // ...and must actually be reachable from the pipeline. This is the
    // assertion that would have caught REBEL-5BM: pre-fix `fallback_failed`
    // was declared+handled but never dispatched here.
    expect(dispatched.has('fallback_failed')).toBe(true);
    // It must NOT be silently demoted into the "intentionally not dispatched"
    // pin list — that would re-introduce the dead-edge bug under cover.
    expect(KNOWN_NOT_DISPATCHED_VIA_TRANSITION.has('fallback_failed')).toBe(false);
  });

  it('the pinned non-dispatched set does not drift: every pinned kind is still declared and still undispatched', () => {
    const declared = new Set(declaredTransitionKinds());
    const dispatched = dispatchedTransitionKinds();

    for (const pinned of KNOWN_NOT_DISPATCHED_VIA_TRANSITION) {
      // A pin for a kind that no longer exists is stale book-keeping.
      expect(declared.has(pinned)).toBe(true);
      // A pin for a kind that is NOW dispatched is also stale — remove it so
      // the guard's coverage of that kind comes from real dispatch, not a pin.
      expect(dispatched.has(pinned)).toBe(false);
    }
  });
});
