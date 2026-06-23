import { describe, expect, it } from 'vitest';
import { derivePolicy } from '../turnPolicy';
import { runRecoveryPipeline } from '../recovery/recoveryPipeline';
import type { RecoveryContext } from '../recovery/recoveryStateMachine';
import { createStubRecoveryAdapter, makeMessage } from '../recovery/__tests__/fixtures/stubAdapter';

describe('recoveryPipeline policy threading', () => {
  it('preserves resolved policy across overflow retries', async () => {
    const policy = derivePolicy('automation');
    const adapter = createStubRecoveryAdapter({
      outcomes: [
        { kind: 'overflow', messages: [makeMessage('user', 'continue')] },
        { kind: 'success', result: 'done' },
      ],
    });
    const abortController = new AbortController();
    const ctx: RecoveryContext = {
      phase: 'post_activity',
      depth: 0,
      attempt: 0,
      longContextFallbackAttempted: false,
      skeletonAttempted: false,
      isRecoveryModelAttempt: false,
      enableRecovery: true,
      sessionId: 'session-1',
      turnId: 'turn-1',
      originalSessionId: 'original-session-1',
      originalPrompt: 'continue',
      abortSignal: abortController.signal,
      messages: [makeMessage('user', 'continue')],
    };

    await runRecoveryPipeline({
      phase: ctx.phase,
      prompt: ctx.originalPrompt,
      agentLoopOptions: {
        sessionId: ctx.sessionId,
        sessionType: 'automation',
        policy,
      },
      enableRecovery: true,
      ctx,
      adapter,
      abortSignal: abortController.signal,
      revealDurationMs: 0,
    });

    const invokeCalls = adapter.calls
      .filter((call) => call.name === 'invokeAgentLoop')
      .map((call) => call.args[1] as { policy?: unknown; sessionType?: unknown });

    expect(invokeCalls).toHaveLength(2);
    expect(invokeCalls[0]?.sessionType).toBe('automation');
    expect(invokeCalls[1]?.sessionType).toBe('automation');
    expect(invokeCalls[0]?.policy).toBe(policy);
    expect(invokeCalls[1]?.policy).toBe(policy);
  });
});
