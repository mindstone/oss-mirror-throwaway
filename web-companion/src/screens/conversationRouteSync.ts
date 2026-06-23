/**
 * Pure planner for `ConversationScreen`'s route-sync effect.
 *
 * Extracted from `syncConversationForRoute(conversationId)` so the decision
 * tree can be exhaustively unit-tested without spinning up a DOM/React
 * harness. The screen's effect now delegates the decision to this function
 * and dispatches the resulting `RouteSyncPlan`.
 *
 * Bug class guarded:
 *   - Auto-send firing more than once for the same conversation id (fixed by
 *     `initialSentForIdRef` in I10 follow-up Q3 — AMD-8 in
 *     `docs/plans/260422_i10_followups_STAGED_PLAN.md`). Silently skipped on
 *     the previous plain-boolean ref when navigating between two
 *     `?initialPrompt=` URLs.
 *   - Compose mode vs. fetch choice when no `initialPrompt` is present.
 *
 * This module is deliberately TypeScript-only (no React imports) so the test
 * file runs in the vitest `node` environment without jsdom.
 */

/**
 * Discriminated union describing what the caller should do in response to a
 * route change. `nextSentForId` tells the caller how to update the
 * `initialSentForIdRef` after executing the plan.
 */
export type RouteSyncPlan =
  | {
      /** Fire the initial auto-send; update the "sent for id" ref to `id`. */
      kind: 'send';
      id: string;
      prompt: string;
      nextSentForId: string;
    }
  | {
      /** Enter text-compose mode; reset the "sent for id" ref to null. */
      kind: 'compose-text';
      id: string;
      nextSentForId: null;
    }
  | {
      /** Fetch the existing session; reset the "sent for id" ref to null. */
      kind: 'fetch';
      id: string;
      nextSentForId: null;
    }
  | {
      /**
       * Initial-prompt already fired for this id — do nothing. Ref unchanged.
       * This is the case T-RS.2 regression-guards.
       */
      kind: 'noop-already-sent';
      id: string;
    };

export interface RouteSyncInputs {
  /** Route param `:id`. Caller must ensure this is defined before calling. */
  id: string;
  /** Search param `?initialPrompt=`. `undefined` if not present. */
  initialPrompt: string | undefined;
  /** Search param `?compose=`. `null` if not present (URLSearchParams semantics). */
  composeMode: string | null;
  /** Current value of `initialSentForIdRef.current`. */
  lastSentForId: string | null;
}

/**
 * Plan the response to a conversation route change.
 *
 * Decision order (matches `syncConversationForRoute` before extraction):
 *   1. If `initialPrompt` is set:
 *      - already sent for this id → `noop-already-sent`
 *      - otherwise → `send`
 *   2. Else if `composeMode === 'text'` → `compose-text`
 *   3. Else → `fetch`
 *
 * `initialPrompt === ''` (empty string) is treated as NOT set, matching the
 * screen's `searchParams.get('initialPrompt') ?? undefined` reading which
 * coalesces missing but not empty. Callers should not rely on empty-prompt
 * auto-send semantics.
 */
export function planConversationRouteSync(inputs: RouteSyncInputs): RouteSyncPlan {
  const { id, initialPrompt, composeMode, lastSentForId } = inputs;

  if (initialPrompt !== undefined && initialPrompt !== '') {
    if (lastSentForId === id) {
      return { kind: 'noop-already-sent', id };
    }
    return { kind: 'send', id, prompt: initialPrompt, nextSentForId: id };
  }

  if (composeMode === 'text') {
    return { kind: 'compose-text', id, nextSentForId: null };
  }

  return { kind: 'fetch', id, nextSentForId: null };
}
