import { describe, it } from 'vitest';
import type { EventWindow } from '@core/types';
import type { AgentEvent } from '@shared/types';
import { dispatchAgentEvent } from '../agentEventDispatcher';

/**
 * Compile-time type-wall regression test for Stage 3 of
 * docs/plans/260420_inline_error_dispatch_migration.md.
 *
 * Inline dispatch of `type: 'error'` agent events via `dispatchAgentEvent`
 * MUST fail to compile. Error events must route through
 * `dispatchAgentErrorEvent` for correct classification + humanization +
 * analytics. If this test starts compiling without the `@ts-expect-error`
 * suppression, the type-wall has been accidentally weakened and the class
 * of bugs described in the planning doc has returned.
 */
describe('dispatchAgentEvent type-wall (Stage 3)', () => {
  it('rejects inline type:"error" dispatch at compile time', () => {
    const fakeWin = null as unknown as EventWindow;
    // Build the offending event as a typed constant so the suppression directive
    // applies to a single statement (the dispatch call). Inline object literals
    // make `@ts-expect-error` apply to the wrapping statement but TS can still
    // report the property-level error separately, which leaves the directive
    // "unused" against the line-exact rule. See TS2578.
    const bannedEvent: AgentEvent = {
      type: 'error',
      error: 'inline error not allowed',
      errorSource: 'main',
      timestamp: 0,
    };
    // @ts-expect-error — inline error dispatch must be blocked by the type-wall
    dispatchAgentEvent(fakeWin, 'turn-id', bannedEvent);
  });

  it('accepts non-error dispatch', () => {
    const fakeWin = null as unknown as EventWindow;
    dispatchAgentEvent(fakeWin, 'turn-id', {
      type: 'status',
      message: 'status ok',
      timestamp: 0,
    });
  });
});
