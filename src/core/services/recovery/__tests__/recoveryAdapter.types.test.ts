import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type { RecoveryAdapter } from '../recoveryAdapter';

/**
 * Compile-time seam test for Stage 1 of
 * docs/plans/260529_error-emit-funnel/PLAN.md.
 *
 * `RecoveryAdapter.forwardOriginalEvent` is the one `@core` seam that escaped
 * the `dispatchAgentEvent` type-wall: it used to be typed against the full
 * `AgentEvent` union, so the recovery-disabled `.catch` paths could hand-build
 * a raw, classification-blind `{ type: 'error' }` event and push it straight to
 * the subscriber/SSE stream (the F3-class bypass). Its `event` param is now
 * narrowed to `Exclude<AgentEvent, { type: 'error' }>`, so a raw error literal
 * is uncompilable through the seam — error events MUST route through
 * `dispatchAgentErrorEvent` (the funnel) to be classified.
 *
 * If this test starts compiling without the `@ts-expect-error` suppression, the
 * seam has been re-widened and the bypass has returned.
 */
// These functions are type-checked but never invoked — the assertions are the
// presence/absence of the `@ts-expect-error` suppression at compile time, not a
// runtime effect (a real forwardOriginalEvent dispatch would need a live
// adapter). `tsc` (lint:ts) is the real gate; vitest just needs the file to
// transpile + run the trivial truthy assertion below.
function _rejectsRawErrorEvent(adapter: RecoveryAdapter): void {
  // Typed constant so the suppression directive applies to the single
  // forwardOriginalEvent statement (mirrors agentEventDispatcher.types.test.ts).
  const bannedEvent: AgentEvent = {
    type: 'error',
    error: 'raw error not allowed through the recovery seam',
    errorSource: 'main',
    timestamp: 0,
  };
  // @ts-expect-error — raw error events must not flow through forwardOriginalEvent
  adapter.forwardOriginalEvent('turn-id', bannedEvent);
}

function _acceptsNonErrorEvent(adapter: RecoveryAdapter): void {
  adapter.forwardOriginalEvent('turn-id', {
    type: 'context_overflow',
    originalPrompt: 'prompt',
    timestamp: 0,
  });
}

describe('RecoveryAdapter.forwardOriginalEvent type-wall (Stage 1)', () => {
  it('compiles only with the type-wall in place (asserted by tsc / lint:ts)', () => {
    // Reference the type-checked functions so they are not tree-shaken/unused.
    expect(typeof _rejectsRawErrorEvent).toBe('function');
    expect(typeof _acceptsNonErrorEvent).toBe('function');
  });
});
