/**
 * Single-source-of-truth classifier for `AgentTurnMessage['endedWith']` at
 * renderer-presentation read sites.
 *
 * Renderer presentation surfaces (e.g. `ContextualProgressCard`, `MessageItem`,
 * `deriveCollapsedSummary`) need to decide *how to render a turn that ended
 * with `X`*. Previously each surface inlined a `endedWith === 'transient_error'`
 * literal comparison, which meant adding a fourth terminal state required
 * touching every site and risked silent "complete" inheritance — the MA-2 bug
 * class flagged by the structural-health specialist on this plan.
 *
 * This helper centralises that destructure behind a typed `switch` with
 * `assertNever` in the default arm. When `AgentTurnMessage['endedWith']` gains
 * a new variant upstream, the helper fails to compile until the new arm is
 * handled, surfacing the change to whoever next maintains the renderer.
 *
 * **Scope invariant (per PLAN.md Stage 4):** only renderer *presentation*
 * consumers route through this helper. Reducer reads in
 * `src/shared/utils/conversationState.ts` (lines 296, 335, 403) intentionally
 * keep their direct equality checks — those are semantic state-transition
 * checks, not UI presentation classification, and routing them through this
 * helper would not add meaningful exhaustiveness.
 *
 * **TS/Zod schema-drift note:** `TurnEndingInput` is sourced from
 * `AgentTurnMessage['endedWith']` (`src/shared/types/agent.ts:1577`). The Zod
 * counterpart at `src/shared/ipc/schemas/agent.ts:715` is hand-maintained and
 * could drift. If Zod accepts a new value before the TS type updates, runtime
 * data could reach this helper as a string TypeScript believes is impossible;
 * `assertNever` would then throw `InvariantViolationError` at the call site.
 * That's a fail-closed outcome but not the compile-time guarantee the rest of
 * Stage 4 provides.
 *
 * @see docs/plans/260527_transient-error-ux-cleanup/PLAN.md (Stage 4)
 */

import type { AgentTurnMessage } from '@shared/types/agent';
import { assertNever } from './assertNever';

/**
 * Re-export of the source-of-truth type for `endedWith` so consumers can
 * import a single name instead of inlining `'transient_error' | 'superseded'`
 * or chaining `AgentTurnMessage['endedWith']` everywhere.
 */
export type TurnEndingInput = AgentTurnMessage['endedWith'];

/** Discriminant tag emitted by `classifyTurnEnding`. */
export type TurnEndingKind = 'live' | 'transient_error' | 'superseded';

/** Discriminated-union result of `classifyTurnEnding`. */
export type TurnEndingClassification =
  | { kind: 'live' }
  | { kind: 'transient_error' }
  | { kind: 'superseded' };

/**
 * Classify a turn's `endedWith` value into a renderer-friendly discriminated
 * union. `undefined` maps to `{ kind: 'live' }` (turn is still live or ended
 * without a recovered-terminal marker); the other branches mirror the source
 * union 1:1.
 */
export function classifyTurnEnding(endedWith: TurnEndingInput): TurnEndingClassification {
  switch (endedWith) {
    case undefined:
      return { kind: 'live' };
    case 'transient_error':
      return { kind: 'transient_error' };
    case 'superseded':
      return { kind: 'superseded' };
    default:
      return assertNever(endedWith, 'classifyTurnEnding');
  }
}
