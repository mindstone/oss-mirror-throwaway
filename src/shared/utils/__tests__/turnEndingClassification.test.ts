/**
 * Unit + type-level contract for `classifyTurnEnding`.
 *
 * See PLAN.md Stage 4 — this helper locks renderer-presentation reads of
 * `AgentTurnMessage['endedWith']` behind a single typed classifier.
 *
 * Coverage:
 *   - Three runtime mapping tests (`undefined`, `'transient_error'`, `'superseded'`).
 *   - One runtime guard mirroring `assertNever.test.ts`: invalid literal cast to
 *     `never` should throw `InvariantViolationError`.
 *   - One input-narrowness `@ts-expect-error` proving the helper rejects values
 *     outside `AgentTurnMessage['endedWith']` at compile time.
 *   - One type-level signature guard pinning the helper's parameter type to
 *     `AgentTurnMessage['endedWith']` (catches drift if someone narrows or
 *     widens `TurnEndingInput` away from the source of truth).
 */

import { describe, expect, it } from 'vitest';
import {
  classifyTurnEnding,
  type TurnEndingInput,
} from '../turnEndingClassification';
import { InvariantViolationError } from '../invariant';
import type { AgentTurnMessage } from '@shared/types/agent';

// ---------------------------------------------------------------------------
// Type-level signature guard (per F2)
// ---------------------------------------------------------------------------

/** Type-level assertion: `T` must be `true`. */
type Expect<T extends true> = T;
/** Type-level equality: are `A` and `B` mutually assignable? */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

// If `classifyTurnEnding`'s parameter type drifts away from
// `AgentTurnMessage['endedWith']`, this alias fails to instantiate and the
// file no longer compiles — forcing a sync with the source-of-truth type.
type SignatureCheck = Expect<
  Equal<Parameters<typeof classifyTurnEnding>[0], AgentTurnMessage['endedWith']>
>;
// Touch the alias so an over-zealous linter doesn't strip it as unused.
const signatureCheck: SignatureCheck = true;
void signatureCheck;

// Same guard for the re-exported `TurnEndingInput` alias.
type InputAliasCheck = Expect<Equal<TurnEndingInput, AgentTurnMessage['endedWith']>>;
const inputAliasCheck: InputAliasCheck = true;
void inputAliasCheck;

// ---------------------------------------------------------------------------
// Runtime contract
// ---------------------------------------------------------------------------

describe('classifyTurnEnding', () => {
  it('maps undefined to { kind: "live" }', () => {
    expect(classifyTurnEnding(undefined)).toEqual({ kind: 'live' });
  });

  it('maps "transient_error" to { kind: "transient_error" }', () => {
    expect(classifyTurnEnding('transient_error')).toEqual({ kind: 'transient_error' });
  });

  it('maps "superseded" to { kind: "superseded" }', () => {
    expect(classifyTurnEnding('superseded')).toEqual({ kind: 'superseded' });
  });

  it('throws InvariantViolationError when given an out-of-union value (assertNever default)', () => {
    expect(() => classifyTurnEnding('foo' as never)).toThrow(InvariantViolationError);
  });

  it('rejects out-of-union literals at compile time', () => {
    // @ts-expect-error: helper rejects values outside AgentTurnMessage['endedWith']
    expect(() => classifyTurnEnding('something_else_entirely')).toThrow(
      InvariantViolationError,
    );
  });
});
