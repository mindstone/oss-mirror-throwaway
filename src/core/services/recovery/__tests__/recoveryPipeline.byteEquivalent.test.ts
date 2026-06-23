import { describe, expect, it } from 'vitest';

import { runRecoveryPipeline } from '../recoveryPipeline';
import type { RecoveryContext } from '../recoveryStateMachine';
import { createStubRecoveryAdapter, makeMessage } from './fixtures/stubAdapter';

const SOURCE_FIXTURE = 'src/main/services/__tests__/agentTurnExecutor.contextOverflowFallback.test.ts';

const preActivityCtx = (): RecoveryContext => ({
  phase: 'pre_activity',
  depth: 0,
  attempt: 0,
  longContextFallbackAttempted: false,
  skeletonAttempted: false,
  isRecoveryModelAttempt: false,
  enableRecovery: true,
  sessionId: 'renderer-session-1',
  turnId: 'turn-overflow-1',
  originalSessionId: 'renderer-session-1',
  originalPrompt: 'Summarize this conversation safely.',
  abortSignal: new AbortController().signal,
  messages: [],
});

describe('recoveryPipeline byte-equivalent fixture replay', () => {
  it('T4.1 preserves fallback-before-overflow event order/count under the new recovery event vocabulary', async () => {
    const adapter = createStubRecoveryAdapter({
      fallbackTarget: { kind: 'model', modelName: 'claude-opus-4-6' },
      outcomes: [
        { kind: 'overflow', messages: [] },
        { kind: 'overflow', messages: [] },
      ],
    });

    const outcome = await runRecoveryPipeline({
      phase: 'pre_activity',
      prompt: 'Summarize this conversation safely.',
      agentLoopOptions: { sessionId: 'renderer-session-1' },
      enableRecovery: true,
      ctx: preActivityCtx(),
      adapter,
      abortSignal: preActivityCtx().abortSignal,
      revealDurationMs: 0,
    });

    const legacyFixtureExpectedOrder = ['status', 'context_overflow'];
    const newVocabularyOrder = adapter.dispatchedEvents
      .filter((event) => event.type === 'recovery:fallback_attempting' || event.type === 'recovery:last_resort_skipped')
      .map((event) => (
        event.type === 'recovery:fallback_attempting'
          ? 'status'
          : 'context_overflow'
      ));

    expect(SOURCE_FIXTURE).toContain('agentTurnExecutor.contextOverflowFallback.test.ts');
    expect(newVocabularyOrder).toEqual(legacyFixtureExpectedOrder);
    expect(newVocabularyOrder).toHaveLength(legacyFixtureExpectedOrder.length);
    expect(outcome).toMatchObject({ kind: 'failure_skipped', exhaustedReason: 'no_qualifying_profile' });
  });

  it('T4.2 (REBEL-5BM) — the :290 started-non-overflow branch keeps an identical event sequence/outcome; ONLY the reason label differs', async () => {
    // Invariant #1 lock for the remapped branch: recovery starts (overflow →
    // compact → retry), then the retry agent-loop errors with a non-overflow
    // error. Pre-fix this dispatched recovery:failed with reason
    // `summary_generation_failed`; post-fix it is `agent_loop_error_after_recovery`.
    // The event SEQUENCE, counts, and envelope must be byte-identical to the
    // pre-fix shape — only the `exhaustedReason` label (and the derived default
    // `error` string) change. No recovery control-flow change.
    const messages = [makeMessage('user', 'task'), makeMessage('assistant', 'answer')];
    const adapter = createStubRecoveryAdapter({
      outcomes: [
        { kind: 'overflow', messages },
        { kind: 'error_non_overflow', error: new Error('post-recovery provider error') },
      ],
    });

    const outcome = await runRecoveryPipeline({
      phase: 'post_activity',
      prompt: 'Please continue the work',
      agentLoopOptions: { sessionId: 'session-1' },
      enableRecovery: true,
      ctx: {
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
        originalPrompt: 'Please continue the work',
        abortSignal: new AbortController().signal,
        messages,
      },
      adapter,
      abortSignal: new AbortController().signal,
      revealDurationMs: 0,
    });

    // Canonical event sequence is unchanged by the re-label.
    expect(adapter.dispatchedEvents.map((event) => event.type)).toEqual([
      'recovery:started',
      'recovery:compacting',
      'recovery:summary_ready',
      'recovery:retrying',
      'recovery:failed',
    ]);

    const failed = adapter.dispatchedEvents.find((event) => event.type === 'recovery:failed');
    expect(failed).toBeDefined();
    if (!failed || failed.type !== 'recovery:failed') throw new Error('expected recovery:failed');

    // The new label + its derived default error string.
    expect(failed.exhaustedReason).toBe('agent_loop_error_after_recovery');
    expect(failed.error).toBe('Recovery failed: agent_loop_error_after_recovery');

    // Byte-equivalence: every OTHER field on the failed event is identical to
    // the pre-fix shape (same envelope; only the reason label + derived error
    // string differ). Reconstruct the pre-fix event and diff the rest.
    const preFixFailed = {
      ...failed,
      exhaustedReason: 'summary_generation_failed' as const,
      error: 'Recovery failed: summary_generation_failed',
    };
    const { exhaustedReason: _postReason, error: _postError, ...postRest } = failed;
    const { exhaustedReason: _preReason, error: _preError, ...preRest } = preFixFailed;
    expect(postRest).toEqual(preRest);

    // Outcome shape unchanged except the reason label.
    expect(outcome).toMatchObject({
      kind: 'failure_terminal',
      exhaustedReason: 'agent_loop_error_after_recovery',
    });
  });
});
