/**
 * Unit tests for `isResultAffectingStreamEvent` (modelClient.ts).
 *
 * The helper is the by-construction guard for the mid-stream retry
 * idempotency fix (docs/plans/260616_proxy-transient-retry): it classifies
 * which StreamEvent variants contribute to the persisted turn `result` (and
 * thus make a stream retry unsafe). The exhaustive `switch` means a NEW
 * StreamEvent variant fails to compile until explicitly classified — these
 * tests lock the runtime classification for today's variants.
 */

import { describe, expect, it } from 'vitest';
import { isResultAffectingStreamEvent } from '../modelClient';
import type { StreamEvent } from '../modelClient';

describe('isResultAffectingStreamEvent', () => {
  it('treats text_delta as result-affecting (enters accumulatedText / persisted result)', () => {
    const event: StreamEvent = { type: 'text_delta', text: 'hello' };
    expect(isResultAffectingStreamEvent(event)).toBe(true);
  });

  it('treats thinking_delta as NOT result-affecting (ephemeral)', () => {
    const event: StreamEvent = { type: 'thinking_delta', thinking: 'reasoning...' };
    expect(isResultAffectingStreamEvent(event)).toBe(false);
  });

  it('treats degraded-status as NOT result-affecting (ephemeral)', () => {
    const event: StreamEvent = {
      type: 'degraded-status',
      reason: 'late-reasoning-buffer-cap',
      cap: 'bytes',
    };
    expect(isResultAffectingStreamEvent(event)).toBe(false);
  });
});
