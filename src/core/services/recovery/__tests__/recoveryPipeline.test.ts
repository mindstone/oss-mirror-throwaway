import { afterEach, describe, expect, it, vi } from 'vitest';

import { runRecoveryPipeline } from '../recoveryPipeline';
import type { RecoveryContext } from '../recoveryStateMachine';
import { createStubRecoveryAdapter, makeMessage } from './fixtures/stubAdapter';

const ctx = (overrides: Partial<RecoveryContext> = {}): RecoveryContext => ({
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
  originalPrompt: 'Please continue the work',
  abortSignal: new AbortController().signal,
  messages: [makeMessage('user', 'Please continue the work')],
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

describe('recoveryPipeline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not dispatch recovery:failed for a first-call non-overflow agent loop error', async () => {
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'error_non_overflow', error: new Error('provider failed before recovery') }],
    });

    const outcome = await run(adapter);

    expect(outcome).toMatchObject({
      kind: 'failure_terminal',
      exhaustedReason: 'agent_loop_error_before_recovery',
      finalState: {
        kind: 'terminal_failure',
        exhaustedReason: 'agent_loop_error_before_recovery',
      },
    });
    expect(eventTypes(adapter)).toEqual([]);
    expect(adapter.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'reportKnownCondition',
        args: [
          'recovery_pipeline_agent_loop_error_before_recovery',
          expect.objectContaining({
            exhaustedReason: 'agent_loop_error_before_recovery',
            phase: 'post_activity',
            error: expect.any(Error),
          }),
        ],
      }),
      expect.objectContaining({
        name: 'emitTelemetryCounter',
        args: [
          'recovery_terminal_failure',
          expect.objectContaining({ exhaustedReason: 'agent_loop_error_before_recovery' }),
        ],
      }),
    ]));
    expect(adapter.calls.some((call) => call.name === 'reportError')).toBe(false);
  });

  it('emits fallback_succeeded before succeeded when the long-context fallback attempt succeeds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const adapter = createStubRecoveryAdapter({
      fallbackTarget: { kind: 'model', modelName: 'claude-opus-4-7' },
      outcomes: [
        { kind: 'overflow', messages: [] },
        { kind: 'success', result: 'ok' },
      ],
    });
    const invokeAgentLoop = adapter.invokeAgentLoop.bind(adapter);
    let invokeCount = 0;
    vi.spyOn(adapter, 'invokeAgentLoop').mockImplementation(async (...args) => {
      invokeCount += 1;
      if (invokeCount === 2) {
        vi.setSystemTime(6_000);
      }
      return invokeAgentLoop(...args);
    });

    const outcome = await run(adapter, ctx({ phase: 'pre_activity', messages: [] }));

    expect(outcome.kind).toBe('success');
    expect(eventTypes(adapter)).toEqual([
      'recovery:started',
      'recovery:fallback_attempting',
      'recovery:fallback_succeeded',
      'recovery:succeeded',
    ]);
    expect(eventTypes(adapter).filter((type) => type === 'recovery:fallback_succeeded')).toHaveLength(1);
    const succeeded = adapter.dispatchedEvents.find((event) => event.type === 'recovery:succeeded');
    expect(succeeded?.totalDurationMs).toBe(5_000);
  });

  it('falls through to skeleton recovery when both intelligent and legacy summaries throw', async () => {
    const messages = [makeMessage('user', 'task'), makeMessage('assistant', 'answer')];
    const adapter = createStubRecoveryAdapter({
      intelligentSummary: new Error('intelligent summary failed'),
      legacySummary: new Error('legacy summary failed'),
      skeletonMessages: [makeMessage('user', 'task')],
      outcomes: [
        { kind: 'overflow', messages },
        { kind: 'success', result: 'ok' },
      ],
    });

    const outcome = await run(adapter, ctx({ messages }));

    expect(outcome.kind).toBe('success');
    expect(eventTypes(adapter)).toEqual([
      'recovery:started',
      'recovery:compacting',
      'recovery:skeleton_attempting',
      'recovery:succeeded',
    ]);
    expect(adapter.calls.map((call) => call.name)).toContain('generateLegacyCompactionSummary');
    expect(adapter.calls.map((call) => call.name)).toContain('buildSkeletonMessages');
  });

  it('T4.2 pre-activity routes through long-context fallback, then directly to recovery model', async () => {
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
    expect(eventTypes(adapter)).toEqual([
      'recovery:started',
      'recovery:fallback_attempting',
      'recovery:depth4_attempting',
      'recovery:succeeded',
    ]);
    expect(adapter.calls.map((call) => call.name)).not.toContain('generateIntelligentSummary');
  });

  it('T4.3 post-activity routes through depths 1-3, then recovery model', async () => {
    const messages = [makeMessage('user', 'first task'), makeMessage('assistant', 'answer')];
    const adapter = createStubRecoveryAdapter({
      profiles: [{ id: 'profile-1', name: 'Recovery Opus', model: 'claude-opus-4-7' }],
      outcomes: [
        { kind: 'overflow', messages },
        { kind: 'overflow', messages },
        { kind: 'overflow', messages },
        { kind: 'overflow', messages },
        { kind: 'success', result: 'ok' },
      ],
    });

    await run(adapter, ctx({ messages }));

    expect(eventTypes(adapter)).toEqual([
      'recovery:started',
      'recovery:compacting',
      'recovery:summary_ready',
      'recovery:retrying',
      'recovery:compacting',
      'recovery:summary_ready',
      'recovery:retrying',
      'recovery:compacting',
      'recovery:summary_ready',
      'recovery:retrying',
      'recovery:depth4_attempting',
      'recovery:succeeded',
    ]);
  });

  it('T4.4 enableRecovery=false produces terminal recovery_disabled without compaction or depth-4', async () => {
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'overflow', messages: [makeMessage('user', 'task')] }],
    });

    const outcome = await run(adapter, ctx({ enableRecovery: false }));

    expect(outcome).toMatchObject({ kind: 'failure_terminal', exhaustedReason: 'recovery_disabled' });
    expect(adapter.calls.map((call) => call.name)).not.toContain('generateIntelligentSummary');
    expect(eventTypes(adapter)).toEqual([]);
    expect(adapter.calls.filter((call) => call.name === 'forwardOriginalEvent')).toHaveLength(1);
  });

  it('T4.5 memory-update style enableRecovery=false preserves intentional fail-fast', async () => {
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'overflow', messages: [makeMessage('user', 'memory update')] }],
    });

    const outcome = await run(adapter, ctx({ enableRecovery: false, originalPrompt: 'Update memory' }));

    expect(outcome.exhaustedReason).toBe('recovery_disabled');
    expect(adapter.calls.some((call) => call.name === 'clearAccumulator')).toBe(false);
    expect(adapter.calls.filter((call) => call.name === 'forwardOriginalEvent')).toHaveLength(1);
  });

  it('R-Stage4.A2 preserves agent loop options across compaction retries except resetConversation', async () => {
    const messages = [makeMessage('user', 'task'), makeMessage('assistant', 'answer')];
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'overflow', messages }, { kind: 'success', result: 'ok' }],
    });
    const controller = new AbortController();
    const loadSessions = () => [];
    const getMeetingCompanionContext = async () => null;
    const setLastInjectedCoachPath = () => undefined;
    const getFocusContext = async () => null;
    const options = {
      sessionId: 'session-1',
      resetConversation: false,
      modelOverride: 'model-a',
      thinkingModelOverride: 'thinking-a',
      workingProfileOverrideId: 'working-profile',
      thinkingProfileOverrideId: 'thinking-profile',
      thinkingEffortOverride: 'high' as const,
      privateMode: true,
      unleashedMode: true,
      councilMode: true,
      attachments: [],
      loadSessions,
      getMeetingCompanionContext,
      setLastInjectedCoachPath,
      getFocusContext,
      bypassToolSafety: true,
      memoryWriteHook: async () => ({}),
      mcpDenyHook: async () => ({}),
      inboundSafetyHook: async () => undefined,
      sessionType: 'automation',
      existingAbortController: controller,
      origin: 'focus',
      inputSource: 'text' as const,
      metadata: { source: 'test' },
    };

    await runRecoveryPipeline({
      phase: 'post_activity',
      prompt: 'task',
      agentLoopOptions: options,
      enableRecovery: true,
      ctx: ctx({ messages }),
      adapter,
      abortSignal: ctx().abortSignal,
      revealDurationMs: 0,
    });

    const invokeOptions = adapter.calls
      .filter((call) => call.name === 'invokeAgentLoop')
      .map((call) => call.args[1]);
    expect(invokeOptions).toHaveLength(2);
    expect(invokeOptions[0]).toMatchObject(options);
    expect(invokeOptions[1]).toMatchObject({ ...options, resetConversation: true });
  });

  it('R-Stage4.A14 skips long-context fallback when target is null', async () => {
    const adapter = createStubRecoveryAdapter({
      fallbackTarget: null,
      outcomes: [
        { kind: 'overflow', messages: [makeMessage('user', 'task')] },
        { kind: 'success', result: 'ok' },
      ],
    });

    await run(adapter, ctx({ phase: 'pre_activity', longContextFallbackAttempted: false }));

    expect(eventTypes(adapter)[0]).toBe('recovery:started');
    expect(eventTypes(adapter)).not.toContain('recovery:fallback_attempting');
    expect(eventTypes(adapter)).toContain('recovery:compacting');
  });

  it('T4.6 pre-activity with no messages never invokes summary generation before State 4', async () => {
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

    expect(adapter.calls.map((call) => call.name)).not.toContain('generateIntelligentSummary');
  });

  it('T4.7 I8 preserves the first user message as task context during compaction', async () => {
    const messages = [
      makeMessage('user', 'Original goal with crucial details'),
      makeMessage('assistant', 'working'),
    ];
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'overflow', messages }, { kind: 'success', result: 'ok' }],
    });

    await run(adapter, ctx({ messages }));

    const summaryCall = adapter.calls.find((call) => call.name === 'generateIntelligentSummary');
    expect(summaryCall?.args[1]).toMatchObject({ taskContext: 'Original goal with crucial details' });
  });

  it('T4.8 I10 leaves Anthropic compact support gating outside the pipeline', async () => {
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'success', result: 'ok' }],
    });

    await run(adapter);

    expect(adapter.calls.map((call) => call.name)).toEqual(['resolveLongContextFallbackTarget', 'invokeAgentLoop']);
  });

  it('T4.9 abort before recovery is terminal and emits no retry dispatch', async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = createStubRecoveryAdapter();

    const outcome = await run(adapter, ctx({ abortSignal: controller.signal }));

    expect(outcome.exhaustedReason).toBe('aborted');
    expect(adapter.calls.some((call) => call.name === 'invokeAgentLoop')).toBe(false);
    expect(adapter.calls.some((call) => call.name === 'emitTelemetryCounter' && call.args[0] === 'recovery_terminal_failure')).toBe(true);
    expect(adapter.calls.some((call) => call.name === 'reportError')).toBe(false);
  });

  it('T4.10 I20 blocks recovery-model re-entry after a depth-4 overflow', async () => {
    const adapter = createStubRecoveryAdapter({
      profiles: [{ id: 'profile-1', name: 'Recovery Opus', model: 'claude-opus-4-7' }],
      outcomes: [
        { kind: 'overflow', messages: [] },
        { kind: 'overflow', messages: [] },
      ],
    });

    const outcome = await run(adapter, ctx({
      phase: 'pre_activity',
      longContextFallbackAttempted: true,
      messages: [],
    }));

    expect(outcome.exhaustedReason).toBe('depth_limit_reached');
    expect(adapter.calls.filter((call) => call.name === 'emitTelemetryCounter' && call.args[0] === 'recovery_depth_4_invocation')).toHaveLength(1);
  });

  it('T4.11 I22 no qualifying profile emits last_resort_skipped and does not invoke depth-4', async () => {
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'overflow', messages: [] }],
    });

    const outcome = await run(adapter, ctx({ phase: 'pre_activity', longContextFallbackAttempted: true, messages: [] }));

    expect(outcome).toMatchObject({ kind: 'failure_skipped', exhaustedReason: 'no_qualifying_profile' });
    expect(eventTypes(adapter)).toEqual(['recovery:started', 'recovery:last_resort_skipped']);
  });

  it('T4.12 I23 clears orphan accumulators before the next retry invoke', async () => {
    const messages = [makeMessage('user', 'task'), makeMessage('assistant', 'answer')];
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'overflow', messages }, { kind: 'success', result: 'ok' }],
    });

    await run(adapter, ctx({ messages }));

    const order = adapter.calls.map((call) => call.name);
    const clearIndex = order.indexOf('clearAccumulator');
    const secondInvokeIndex = order.findIndex((name, index) => name === 'invokeAgentLoop' && index > clearIndex);
    expect(clearIndex).toBeGreaterThan(-1);
    expect(secondInvokeIndex).toBeGreaterThan(clearIndex);
  });

  it('T4.13 every outbound event has provenance', async () => {
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'overflow', messages: [makeMessage('user', 'task')] }, { kind: 'success', result: 'ok' }],
    });

    await run(adapter);

    for (const event of adapter.dispatchedEvents) {
      expect(event.turnId).toBe('turn-1');
      expect(event.sessionId).toBe('session-1');
      expect(event.originalSessionId).toBe('original-session-1');
    }
  });

  it('T4.14 totalCalls is present and monotonic on outbound events', async () => {
    const adapter = createStubRecoveryAdapter({
      outcomes: [
        { kind: 'overflow', messages: [makeMessage('user', 'task')] },
        { kind: 'overflow', messages: [makeMessage('user', 'task')] },
        { kind: 'success', result: 'ok' },
      ],
    });

    await run(adapter);

    const calls = adapter.dispatchedEvents.map((event) => event.totalCalls);
    expect(calls).toEqual([...calls].sort((a, b) => a - b));
  });

  it('T4.15 happy path emits zero recovery events', async () => {
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'success', result: 'ok' }],
    });

    const outcome = await run(adapter);

    expect(outcome.kind).toBe('success');
    expect(adapter.dispatchedEvents).toHaveLength(0);
  });

  it('T4.16 cross-axis budget reaches three depths before State 4', async () => {
    const messages = [makeMessage('user', 'task'), makeMessage('assistant', 'answer')];
    const adapter = createStubRecoveryAdapter({
      profiles: [{ id: 'profile-1', name: 'Recovery Opus', model: 'claude-opus-4-7' }],
      outcomes: [
        { kind: 'overflow', messages },
        { kind: 'overflow', messages },
        { kind: 'overflow', messages },
        { kind: 'overflow', messages },
        { kind: 'success', result: 'ok' },
      ],
    });

    await run(adapter, ctx({ messages }));

    const compactionDepths = adapter.dispatchedEvents
      .filter((event) => event.type === 'recovery:compacting')
      .map((event) => event.depth);
    expect(compactionDepths).toEqual([1, 2, 3]);
    expect(eventTypes(adapter)).toContain('recovery:depth4_attempting');
  });

  it('T4.17 telemetry fires once for depth-4 and recovery_skipped fires for no-op State 4', async () => {
    const depth4Adapter = createStubRecoveryAdapter({
      profiles: [{ id: 'profile-1', name: 'Recovery Opus', model: 'claude-opus-4-7' }],
      outcomes: [{ kind: 'overflow', messages: [] }, { kind: 'success', result: 'ok' }],
    });
    await run(depth4Adapter, ctx({ phase: 'pre_activity', longContextFallbackAttempted: true, messages: [] }));
    expect(depth4Adapter.calls.filter((call) => call.name === 'emitTelemetryCounter' && call.args[0] === 'recovery_depth_4_invocation')).toHaveLength(1);

    const skippedAdapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'overflow', messages: [] }],
    });
    await run(skippedAdapter, ctx({ phase: 'pre_activity', longContextFallbackAttempted: true, messages: [] }));
    expect(skippedAdapter.calls.some((call) => call.name === 'emitTelemetryCounter' && call.args[0] === 'recovery_skipped')).toBe(true);
  });

  it('I2 strips conversation_history from retry prompts through canonical compaction prompt builders', async () => {
    const messages = [makeMessage('user', 'User asks cleanly'), makeMessage('assistant', 'answer')];
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'overflow', messages }, { kind: 'success', result: 'ok' }],
    });

    await run(adapter, ctx({
      originalPrompt: '<conversation_history>old leaked context</conversation_history>\nUser asks cleanly',
      messages,
    }));

    const secondInvoke = adapter.calls.filter((call) => call.name === 'invokeAgentLoop')[1];
    expect(secondInvoke.args[0]).not.toContain('<conversation_history>');
  });

  it('I3 unwraps nested compaction artifacts before deriving task context', async () => {
    const messages = [
      makeMessage('user', '[COMPACTION_DEPTH:1]\n=== CONTINUE WITH REQUEST ===\nactual ask'),
      makeMessage('assistant', 'answer'),
    ];
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'overflow', messages }, { kind: 'success', result: 'ok' }],
    });

    await run(adapter, ctx({ messages }));

    const summaryCall = adapter.calls.find((call) => call.name === 'generateIntelligentSummary');
    expect(summaryCall?.args[1]).toMatchObject({ taskContext: 'actual ask' });
  });

  it('I13 keeps recovery state scoped by session and originalSessionId', async () => {
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'overflow', messages: [makeMessage('user', 'task')] }, { kind: 'success', result: 'ok' }],
    });

    await run(adapter, ctx({ sessionId: 'active-session', originalSessionId: 'background-session' }));

    expect(adapter.dispatchedEvents.every((event) => event.sessionId === 'active-session')).toBe(true);
    expect(adapter.dispatchedEvents.every((event) => event.originalSessionId === 'background-session')).toBe(true);
  });

  it('I14 preserves the user prompt in the enhanced retry prompt', async () => {
    const messages = [makeMessage('user', 'User prompt must survive'), makeMessage('assistant', 'answer')];
    const adapter = createStubRecoveryAdapter({
      outcomes: [{ kind: 'overflow', messages }, { kind: 'success', result: 'ok' }],
    });

    await run(adapter, ctx({ originalPrompt: 'User prompt must survive', messages }));

    const secondInvoke = adapter.calls.filter((call) => call.name === 'invokeAgentLoop')[1];
    expect(secondInvoke.args[0]).toContain('User prompt must survive');
  });

  // ---------------------------------------------------------------------------
  // Phase 6 regression — Stage 2 R3-arbiter dual-path retry barrier-marker
  // contract. Every recovery retry path that re-enters `invokeAgentLoop` MUST
  // clear the renderer-side `answer_phase_started` sentinel BEFORE the next
  // invoke so the next answer phase can re-emit the marker (otherwise the
  // renderer skips the second clearThinkingBuffer and regression-leaks
  // partially-rendered tokens from the failed attempt). Plan reference:
  // docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md Stage 2 R2-6 / F16.
  // ---------------------------------------------------------------------------

  function findCallIndex(
    adapter: ReturnType<typeof createStubRecoveryAdapter>,
    name: string,
    after = -1,
  ): number {
    return adapter.calls.findIndex((call, idx) => idx > after && call.name === name);
  }

  it('clears the renderer barrier marker before retrying via long-context fallback (in-pipeline path)', async () => {
    const adapter = createStubRecoveryAdapter({
      fallbackTarget: { kind: 'model', modelName: 'claude-opus-4-7' },
      outcomes: [
        { kind: 'overflow', messages: [] },
        { kind: 'success', result: 'ok' },
      ],
    });

    await run(adapter, ctx({ phase: 'pre_activity', messages: [] }));

    const firstInvoke = findCallIndex(adapter, 'invokeAgentLoop');
    const clearMarker = findCallIndex(adapter, 'clearRendererBarrierMarker', firstInvoke);
    const secondInvoke = findCallIndex(adapter, 'invokeAgentLoop', firstInvoke);
    expect(clearMarker).toBeGreaterThan(firstInvoke);
    expect(secondInvoke).toBeGreaterThan(clearMarker);
  });

  it('clears the renderer barrier marker before depth-4 recovery_model retry', async () => {
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

    const invokes = adapter.calls
      .map((call, idx) => ({ name: call.name, idx }))
      .filter((c) => c.name === 'invokeAgentLoop')
      .map((c) => c.idx);
    expect(invokes.length).toBeGreaterThanOrEqual(3);
    const clearMarkers = adapter.calls
      .map((call, idx) => ({ name: call.name, idx }))
      .filter((c) => c.name === 'clearRendererBarrierMarker')
      .map((c) => c.idx);
    // Each retry boundary must be preceded by a barrier-marker clear.
    expect(clearMarkers.length).toBeGreaterThanOrEqual(invokes.length - 1);
    expect(clearMarkers[clearMarkers.length - 1]!).toBeLessThan(invokes[invokes.length - 1]!);
  });

  it('clears the renderer barrier marker before depth-4 retry on the post-activity compaction route (legacy profile-based)', async () => {
    // Post-activity overflow without an explicit long-context fallback target
    // routes through compaction depths 1-3 and then the depth-4 recovery
    // profile. Compaction retries reuse the same model so don't clear the
    // marker; only the depth-4 model-changing retry must clear it.
    const messages = [makeMessage('user', 'task'), makeMessage('assistant', 'answer')];
    const adapter = createStubRecoveryAdapter({
      profiles: [{ id: 'profile-1', name: 'Recovery Opus', model: 'claude-opus-4-7' }],
      recoveryProfilePreference: { profileId: 'profile-1', configuredId: 'profile-1' },
      outcomes: [
        { kind: 'overflow', messages },
        { kind: 'overflow', messages },
        { kind: 'overflow', messages },
        { kind: 'overflow', messages },
        { kind: 'success', result: 'ok' },
      ],
    });

    await run(adapter, ctx({ messages }));

    const invokes = adapter.calls
      .map((call, idx) => ({ name: call.name, idx }))
      .filter((c) => c.name === 'invokeAgentLoop')
      .map((c) => c.idx);
    const clearMarkers = adapter.calls
      .map((call, idx) => ({ name: call.name, idx }))
      .filter((c) => c.name === 'clearRendererBarrierMarker')
      .map((c) => c.idx);

    // Exactly one model-changing retry boundary (depth-4) — must be preceded
    // by exactly one barrier-marker clear, and that clear must come AFTER
    // every compaction-retry boundary so the marker is cleared *just before*
    // the model swap rather than during compaction.
    expect(clearMarkers.length).toBe(1);
    const lastInvoke = invokes[invokes.length - 1]!;
    expect(clearMarkers[0]!).toBeLessThan(lastInvoke);
    expect(clearMarkers[0]!).toBeGreaterThan(invokes[invokes.length - 2]!);
  });

  it('clears the renderer barrier marker before legacy model-based fallback retry', async () => {
    const adapter = createStubRecoveryAdapter({
      fallbackTarget: { kind: 'model', modelName: 'claude-opus-4-7' },
      outcomes: [
        { kind: 'overflow', messages: [makeMessage('user', 'task')] },
        { kind: 'success', result: 'ok' },
      ],
    });

    await run(adapter, ctx({ phase: 'pre_activity', messages: [] }));

    const firstInvoke = findCallIndex(adapter, 'invokeAgentLoop');
    const clearMarker = findCallIndex(adapter, 'clearRendererBarrierMarker', firstInvoke);
    const secondInvoke = findCallIndex(adapter, 'invokeAgentLoop', firstInvoke);
    expect(clearMarker).toBeGreaterThan(firstInvoke);
    expect(secondInvoke).toBeGreaterThan(clearMarker);
  });

  // ---------------------------------------------------------------------------
  // Stage 5b regression — REBEL-5BM/5BV/5BX/5BH:
  // pre_activity long-context fallback failure was misclassified as
  // `summary_generation_failed` (because `lastAttemptedFallbackTarget` was
  // cleared before the error_non_overflow branch ran), and the existing
  // `fallback_failed` state-machine transition was never exercised so the
  // depth-4 escalation path was dead. The fixes are (a) preserve the
  // fallback-attempt signal across the error_non_overflow branch and (b)
  // wire the state-machine transition so depth-4 retries when a recovery
  // profile is available.
  // ---------------------------------------------------------------------------

  it('pre_activity fallback failure no longer mislabels as summary_generation_failed; routes through fallback_failed and skips at recovery_model when no profile is available', async () => {
    // REBEL-5BM/5BV/5BX/5BH primary regression: before the fix the bare
    // `lastAttemptedFallbackTarget = null` ahead of the `error_non_overflow`
    // branch lost the fallback-attempt signal, so the failure was captured as
    // `summary_generation_failed` and we never tried the depth-4 recovery
    // model. After the fix the state-machine `fallback_failed` transition is
    // wired through, so the absence of a recovery profile surfaces as the
    // user-friendly `last_resort_skipped` / `no_qualifying_profile` outcome
    // — and no spurious `summary_generation_failed` Sentry fingerprint fires.
    const adapter = createStubRecoveryAdapter({
      fallbackTarget: { kind: 'model', modelName: 'claude-opus-4-7' },
      profiles: [],
      outcomes: [
        { kind: 'overflow', messages: [] },
        { kind: 'error_non_overflow', error: new Error('fallback model crashed') },
      ],
    });

    const outcome = await run(adapter, ctx({ phase: 'pre_activity', messages: [] }));

    expect(outcome).toMatchObject({
      kind: 'failure_skipped',
      exhaustedReason: 'no_qualifying_profile',
    });
    expect(eventTypes(adapter)).toContain('recovery:last_resort_skipped');
    const reportCalls = adapter.calls.filter((call) => call.name === 'reportKnownCondition');
    expect(reportCalls.map((call) => call.args[0])).not.toContain('recovery_pipeline_summary_generation_failed');
    expect(reportCalls.map((call) => call.args[0])).not.toContain('recovery_pipeline_long_context_fallback_failed');
    expect(adapter.calls.some((call) => call.name === 'reportError')).toBe(false);
  });

  it('captures recovery_pipeline_depth_limit_reached when fallback fails and depth-4 is already attempted', async () => {
    // Defensive branch coverage: when isRecoveryModelAttempt is already set
    // (synthetic ctx — equivalent to "depth-4 was tried earlier"), the
    // state-machine `fallback_failed` transition returns terminal_failure
    // with `depth_limit_reached` and we forward the original error through
    // dispatchFailure → captureExhaustion. Confirms (a) the new fingerprint
    // route fires with the underlying error attached, and (b) the legacy
    // `summary_generation_failed` mislabel is gone.
    const adapter = createStubRecoveryAdapter({
      fallbackTarget: { kind: 'model', modelName: 'claude-opus-4-7' },
      profiles: [{ id: 'profile-1', name: 'Recovery Opus', model: 'claude-opus-4-7' }],
      outcomes: [
        { kind: 'overflow', messages: [] },
        { kind: 'error_non_overflow', error: new Error('fallback model crashed') },
      ],
    });

    const outcome = await run(
      adapter,
      ctx({ phase: 'pre_activity', messages: [], isRecoveryModelAttempt: true }),
    );

    expect(outcome).toMatchObject({
      kind: 'failure_terminal',
      exhaustedReason: 'depth_limit_reached',
    });
    const reportCalls = adapter.calls.filter((call) => call.name === 'reportKnownCondition');
    expect(reportCalls.map((call) => call.args[0])).toContain('recovery_pipeline_depth_limit_reached');
    expect(reportCalls.map((call) => call.args[0])).not.toContain('recovery_pipeline_summary_generation_failed');
    const depthKnownCondition = reportCalls.find(
      (call) => call.args[0] === 'recovery_pipeline_depth_limit_reached',
    );
    expect(depthKnownCondition?.args[1]).toMatchObject({
      phase: 'pre_activity',
      exhaustedReason: 'depth_limit_reached',
      error: expect.any(Error),
    });
    expect(adapter.calls.some((call) => call.name === 'reportError')).toBe(false);
  });

  it('labels post_activity error_non_overflow at started as agent_loop_error_after_recovery (REBEL-5BM re-label)', async () => {
    const messages = [makeMessage('user', 'task'), makeMessage('assistant', 'answer')];
    const adapter = createStubRecoveryAdapter({
      outcomes: [
        { kind: 'overflow', messages },
        { kind: 'error_non_overflow', error: new Error('compaction-retry crashed') },
      ],
    });

    const outcome = await run(adapter, ctx({ messages }));

    expect(outcome).toMatchObject({
      kind: 'failure_terminal',
      exhaustedReason: 'agent_loop_error_after_recovery',
    });
    const reportCalls = adapter.calls.filter((call) => call.name === 'reportKnownCondition');
    expect(reportCalls.map((call) => call.args[0])).toContain('recovery_pipeline_agent_loop_error_after_recovery');
    // The started-non-overflow bucket no longer pollutes the summary-failure label.
    expect(reportCalls.map((call) => call.args[0])).not.toContain('recovery_pipeline_summary_generation_failed');
    expect(reportCalls.map((call) => call.args[0])).not.toContain('recovery_pipeline_long_context_fallback_failed');
    const afterRecoveryCall = reportCalls.find(
      (call) => call.args[0] === 'recovery_pipeline_agent_loop_error_after_recovery',
    );
    expect(afterRecoveryCall?.args[1]).toMatchObject({
      phase: 'post_activity',
      exhaustedReason: 'agent_loop_error_after_recovery',
      error: expect.any(Error),
    });
    expect(adapter.calls.some((call) => call.name === 'reportError')).toBe(false);
  });

  it('threads errorKind/provider/rawError diagnostics onto the after-recovery known-condition ctx (REBEL-5BM string-error path)', async () => {
    const messages = [makeMessage('user', 'task'), makeMessage('assistant', 'answer')];
    const adapter = createStubRecoveryAdapter({
      outcomes: [
        { kind: 'overflow', messages },
        // In-band error events resolve with a STRING error plus the diagnostic
        // fields the surface adapter lifted off the error event.
        {
          kind: 'error_non_overflow',
          error: 'rate limit exceeded',
          errorKind: 'rate_limit',
          provider: 'Anthropic',
          rawError: 'HTTP 429 too many requests',
        },
      ],
    });

    const outcome = await run(adapter, ctx({ messages }));

    expect(outcome).toMatchObject({
      kind: 'failure_terminal',
      exhaustedReason: 'agent_loop_error_after_recovery',
    });
    const afterRecoveryCall = adapter.calls
      .filter((call) => call.name === 'reportKnownCondition')
      .find((call) => call.args[0] === 'recovery_pipeline_agent_loop_error_after_recovery');
    expect(afterRecoveryCall?.args[1]).toMatchObject({
      error: 'rate limit exceeded',
      errorKind: 'rate_limit',
      provider: 'Anthropic',
      rawError: 'HTTP 429 too many requests',
    });
  });

  it('threads errorKind/provider/rawError diagnostics onto the before-recovery known-condition ctx (REBEL-603 string-error path)', async () => {
    // Mirror of the after-recovery diagnostics test for the `!started` first-call
    // error path (recovery_pipeline_agent_loop_error_before_recovery). This path
    // captures via terminalOutcome (no recovery:failed dispatch), so the only
    // signal carrier is the known-condition ctx — assert the diagnostics reach it.
    const adapter = createStubRecoveryAdapter({
      outcomes: [
        {
          kind: 'error_non_overflow',
          error: 'rate limit exceeded',
          errorKind: 'rate_limit',
          provider: 'Anthropic',
          rawError: 'HTTP 429 too many requests',
        },
      ],
    });

    const outcome = await run(adapter);

    expect(outcome).toMatchObject({
      kind: 'failure_terminal',
      exhaustedReason: 'agent_loop_error_before_recovery',
    });
    // !started path does NOT dispatch recovery:failed (terminalOutcome only).
    expect(eventTypes(adapter)).toEqual([]);
    const beforeRecoveryCall = adapter.calls
      .filter((call) => call.name === 'reportKnownCondition')
      .find((call) => call.args[0] === 'recovery_pipeline_agent_loop_error_before_recovery');
    expect(beforeRecoveryCall?.args[1]).toMatchObject({
      error: 'rate limit exceeded',
      errorKind: 'rate_limit',
      provider: 'Anthropic',
      rawError: 'HTTP 429 too many requests',
    });
  });

  it('routes pre_activity fallback failure to depth-4 when a recovery profile is available', async () => {
    const adapter = createStubRecoveryAdapter({
      fallbackTarget: { kind: 'model', modelName: 'claude-opus-4-7' },
      profiles: [{ id: 'profile-1', name: 'Recovery Opus', model: 'claude-opus-4-7' }],
      outcomes: [
        { kind: 'overflow', messages: [] },
        { kind: 'error_non_overflow', error: new Error('fallback model crashed') },
        { kind: 'success', result: 'ok' },
      ],
    });

    const outcome = await run(adapter, ctx({ phase: 'pre_activity', messages: [] }));

    expect(outcome.kind).toBe('success');
    expect(eventTypes(adapter)).toEqual([
      'recovery:started',
      'recovery:fallback_attempting',
      'recovery:depth4_attempting',
      'recovery:succeeded',
    ]);
    expect(adapter.calls.filter((call) => call.name === 'invokeAgentLoop')).toHaveLength(3);
    expect(
      adapter.calls.filter(
        (call) => call.name === 'emitTelemetryCounter' && call.args[0] === 'recovery_depth_4_invocation',
      ),
    ).toHaveLength(1);
    expect(adapter.calls.some((call) => call.name === 'reportKnownCondition')).toBe(false);
    expect(adapter.calls.some((call) => call.name === 'reportError')).toBe(false);
  });
});
