/**
 * Stage 6 last-resort F-matrix coverage.
 *
 * Targets the depth-4 emergency branch in `runRecoveryPipeline()` — the
 * skeleton-with-summary attempt that runs when depth-3 fails and a qualifying
 * recovery profile exists. See docs/plans/260503_unified_recovery_pipeline.md
 * §10 fault matrix and § Stage 6 acceptance.
 */

import { runRecoveryPipeline } from '../recoveryPipeline';
import type { RecoveryContext } from '../recoveryStateMachine';
import { createStubRecoveryAdapter, makeMessage } from './fixtures/stubAdapter';

const ctx = (overrides: Partial<RecoveryContext> = {}): RecoveryContext => ({
  phase: 'pre_activity',
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
  abortSignal: new AbortController().signal,
  messages: [],
  ...overrides,
});

const run = (adapter: ReturnType<typeof createStubRecoveryAdapter>, context = ctx(), prompt = context.originalPrompt) =>
  runRecoveryPipeline({
    phase: context.phase,
    prompt,
    agentLoopOptions: { sessionId: context.sessionId },
    enableRecovery: context.enableRecovery,
    ctx: context,
    adapter,
    abortSignal: context.abortSignal,
    revealDurationMs: 0,
  });

const eventTypes = (adapter: ReturnType<typeof createStubRecoveryAdapter>): string[] =>
  adapter.dispatchedEvents.map((event) => event.type);

describe('recoveryPipeline.lastResort', () => {
  it('LR.A recovery model configured + skeleton-primary fails -> recovery model engages', async () => {
    const adapter = createStubRecoveryAdapter({
      fallbackTarget: { kind: 'model', modelName: 'claude-opus-4-7' },
      profiles: [{ id: 'profile-1', name: 'Recovery Opus', model: 'claude-opus-4-7' }],
      outcomes: [
        { kind: 'overflow', messages: [] },
        { kind: 'overflow', messages: [] },
        { kind: 'success', result: 'ok' },
      ],
    });

    const outcome = await run(adapter, ctx({ phase: 'pre_activity', messages: [] }));

    expect(outcome.kind).toBe('success');
    expect(eventTypes(adapter)).toContain('recovery:depth4_attempting');
  });

  it('LR.A2 honours the long-context fallback profile preference at depth-4', async () => {
    const adapter = createStubRecoveryAdapter({
      fallbackTarget: { kind: 'profile', profileId: 'profile-selected', profileName: 'Selected Recovery', modelName: 'claude-opus-4-7' },
      profiles: [
        { id: 'profile-auto', name: 'Auto Recovery', model: 'claude-sonnet-4-6' },
        { id: 'profile-selected', name: 'Selected Recovery', model: 'claude-opus-4-7' },
      ],
      outcomes: [
        { kind: 'overflow', messages: [] },
        { kind: 'success', result: 'ok' },
      ],
    });

    const outcome = await run(adapter, ctx({
      phase: 'pre_activity',
      longContextFallbackAttempted: true,
      messages: [],
    }));

    expect(outcome.kind).toBe('success');
    expect(adapter.calls.map((call) => call.name)).toContain('getRecoveryProfilePreference');
    const depth4Event = adapter.dispatchedEvents.find((event) => event.type === 'recovery:depth4_attempting');
    expect(depth4Event && 'profileId' in depth4Event ? depth4Event.profileId : null).toBe('profile-selected');
    const secondInvokeOptions = adapter.calls.filter((call) => call.name === 'invokeAgentLoop')[1].args[1];
    expect(secondInvokeOptions).toMatchObject({ workingProfileOverrideId: 'profile-selected' });
  });

  it('LR.B recovery model NOT configured -> graceful no-op with last_resort_skipped, no infinite loop', async () => {
    const adapter = createStubRecoveryAdapter({
      profiles: [],
      outcomes: [{ kind: 'overflow', messages: [] }],
    });

    const outcome = await run(adapter, ctx({ phase: 'pre_activity', longContextFallbackAttempted: true, messages: [] }));

    expect(outcome).toMatchObject({ kind: 'failure_skipped', exhaustedReason: 'no_qualifying_profile' });
    expect(eventTypes(adapter)).toEqual(['recovery:started', 'recovery:last_resort_skipped']);
    const skipEvent = adapter.dispatchedEvents.find((event) => event.type === 'recovery:last_resort_skipped');
    expect(skipEvent && 'reason' in skipEvent ? skipEvent.reason : null).toBe('no_qualifying_profile');
  });

  it('LR.C recovery model also fails -> hard fail (terminal failure, not silent)', async () => {
    const adapter = createStubRecoveryAdapter({
      fallbackTarget: { kind: 'model', modelName: 'claude-opus-4-7' },
      profiles: [{ id: 'profile-1', name: 'Recovery Opus', model: 'claude-opus-4-7' }],
      outcomes: [
        { kind: 'overflow', messages: [] },
        { kind: 'overflow', messages: [] },
        { kind: 'error_non_overflow', error: new Error('recovery model failed') },
      ],
    });

    const outcome = await run(adapter, ctx({ phase: 'pre_activity', messages: [] }));

    expect(outcome.kind).toBe('failure_terminal');
    // REBEL-5BM: the depth-4 recovery model's own post-recovery agent-loop
    // error is a started-non-overflow failure → agent_loop_error_after_recovery.
    expect(outcome.exhaustedReason).toBe('agent_loop_error_after_recovery');
  });

  it('LR.D recovery model rate-limited via profile.rateLimited -> last_resort_skipped(rate_limited)', async () => {
    const adapter = createStubRecoveryAdapter({
      profiles: [{ id: 'profile-1', name: 'Recovery Opus', model: 'claude-opus-4-7', rateLimited: true }],
      outcomes: [{ kind: 'overflow', messages: [] }],
    });

    const outcome = await run(adapter, ctx({ phase: 'pre_activity', longContextFallbackAttempted: true, messages: [] }));

    expect(outcome).toMatchObject({ kind: 'failure_skipped', exhaustedReason: 'rate_limited' });
    const skipEvent = adapter.dispatchedEvents.find((event) => event.type === 'recovery:last_resort_skipped');
    expect(skipEvent && 'reason' in skipEvent ? skipEvent.reason : null).toBe('rate_limited');
  });

  it('LR.E F23 BTS shared cooldown blocks depth-4 -> last_resort_skipped(rate_limited)', async () => {
    const adapter = createStubRecoveryAdapter({
      profiles: [{ id: 'profile-1', name: 'Recovery Opus', model: 'claude-opus-4-7' }],
      sharedCooldownActive: true,
      outcomes: [{ kind: 'overflow', messages: [] }],
    });

    const outcome = await run(adapter, ctx({ phase: 'pre_activity', longContextFallbackAttempted: true, messages: [] }));

    expect(outcome).toMatchObject({ kind: 'failure_skipped', exhaustedReason: 'rate_limited' });
    expect(
      adapter.calls.some((call) => call.name === 'isSharedCooldownActiveFor'),
    ).toBe(true);
  });

  it('LR.F cost-estimate emits exactly once before depth-4 invocation', async () => {
    const adapter = createStubRecoveryAdapter({
      fallbackTarget: { kind: 'model', modelName: 'claude-opus-4-7' },
      profiles: [{ id: 'profile-1', name: 'Recovery Opus', model: 'claude-opus-4-7' }],
      outcomes: [
        { kind: 'overflow', messages: [] },
        { kind: 'overflow', messages: [] },
        { kind: 'success', result: 'ok' },
      ],
    });

    await run(adapter, ctx({ phase: 'pre_activity', messages: [] }));

    const costCalls = adapter.calls.filter((call) => call.name === 'emitCostEstimate');
    expect(costCalls).toHaveLength(1);
    expect(costCalls[0].args[0]).toMatchObject({
      model: 'claude-opus-4-7',
      profileId: 'profile-1',
      estimatedCost: 'high',
      recoveryDepth: 4,
    });

    const order = adapter.calls.map((call) => call.name);
    const costIndex = order.indexOf('emitCostEstimate');
    const depth4Counter = order.findIndex(
      (name, idx) => name === 'emitTelemetryCounter' && adapter.calls[idx].args[0] === 'recovery_depth_4_invocation',
    );
    expect(costIndex).toBeGreaterThan(-1);
    expect(depth4Counter).toBeGreaterThan(costIndex);
  });

  it('LR.G no cost-estimate emitted when depth-4 is skipped (no profile)', async () => {
    const adapter = createStubRecoveryAdapter({
      profiles: [],
      outcomes: [{ kind: 'overflow', messages: [] }],
    });

    await run(adapter, ctx({ phase: 'pre_activity', longContextFallbackAttempted: true, messages: [] }));

    expect(adapter.calls.find((call) => call.name === 'emitCostEstimate')).toBeUndefined();
  });

  it('LR.H I20 reentrancy guard: isRecoveryModelAttempt prevents re-entering depth-4', async () => {
    const adapter = createStubRecoveryAdapter({
      fallbackTarget: { kind: 'model', modelName: 'claude-opus-4-7' },
      profiles: [{ id: 'profile-1', name: 'Recovery Opus', model: 'claude-opus-4-7' }],
      outcomes: [
        { kind: 'overflow', messages: [] },
        { kind: 'overflow', messages: [] },
      ],
    });

    const outcome = await run(
      adapter,
      ctx({ phase: 'pre_activity', isRecoveryModelAttempt: true, messages: [] }),
    );

    expect(outcome.kind).toBe('failure_terminal');
    expect(outcome.exhaustedReason).toBe('depth_limit_reached');
    expect(eventTypes(adapter)).not.toContain('recovery:depth4_attempting');
  });

  it('LR.I F22 abort signal preempts depth-4 setup', async () => {
    const controller = new AbortController();
    const adapter = createStubRecoveryAdapter({
      profiles: [{ id: 'profile-1', name: 'Recovery Opus', model: 'claude-opus-4-7' }],
      outcomes: [{ kind: 'overflow', messages: [] }],
    });

    controller.abort();
    const outcome = await run(
      adapter,
      ctx({
        phase: 'pre_activity',
        longContextFallbackAttempted: true,
        abortSignal: controller.signal,
        messages: [],
      }),
    );

    expect(outcome.kind).toBe('failure_terminal');
    expect(outcome.exhaustedReason).toBe('aborted');
  });
});
