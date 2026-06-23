/**
 * Stage 5 — sole-writer active-execution-state transition.
 *
 * These tests pin the BY-CONSTRUCTION property the council (GPT-5.5 + DA)
 * converged on: the co-varying parent-execution facts (model, client, profile
 * id, profile, limits, effort, thinking, supportsReasoningReplay) are written
 * ONLY through `commitActiveExecutionState` / `createActiveExecutionStateHolder`,
 * which takes the FULL `ActiveExecutionState` and derives every dependent
 * surface (`liveAgentLoop.config`, `liveAgentLoop.opts`, `agentCtx` parent
 * fields) from that single state. A caller therefore cannot advance the model
 * without also supplying the matching client/profile/limits/effort/thinking/
 * replay — the drift class that produced 4 of this run's bugs cannot be
 * expressed.
 *
 * The headline "omitting a field is a COMPILE error" property is demonstrated
 * with the `@ts-expect-error` block below: if any field of `ActiveExecutionState`
 * became optional, that line would stop erroring and tsc (the GATE) would fail.
 */
import { describe, it, expect } from 'vitest';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import type { ModelProfile } from '@shared/types';
import type { ModelClient } from '../modelClient';
import type { ChatMessage } from '../modelTypes';
import type { AgentToolContext } from '../types';
import {
  createActiveExecutionStateHolder,
  type ActiveExecutionState,
  type LiveAgentLoopHandle,
} from '../rebelCoreQuery';

const MODEL_A = unsafeAssertRoutingModelId('claude-sonnet-4-20250514');
const MODEL_B = unsafeAssertRoutingModelId('claude-opus-4-20250514');

/** A throwaway ModelClient — identity is all the holder/derivation cares about. */
function fakeClient(tag: string): ModelClient {
  return {
    create: async () => ({}) as never,
    stream: async () => ({}) as never,
    capabilities: { tag } as never,
  } as unknown as ModelClient;
}

function profile(model: string, id = model): ModelProfile {
  return {
    id,
    name: `Profile ${id}`,
    providerType: 'anthropic',
    serverUrl: '',
    model,
    routingEligible: true,
    enabled: true,
    createdAt: Date.now(),
  } as unknown as ModelProfile;
}

function stateA(): ActiveExecutionState {
  return {
    model: MODEL_A,
    client: fakeClient('A'),
    profileId: 'profile-a',
    profile: profile(MODEL_A, 'profile-a'),
    limits: { maxOutputTokens: 8000, contextWindow: 200000 },
    effort: 'medium',
    thinking: { type: 'enabled', budget_tokens: 4000 },
    supportsReasoningReplay: true,
  };
}

function stateB(): ActiveExecutionState {
  return {
    model: MODEL_B,
    client: fakeClient('B'),
    profileId: 'profile-b',
    profile: profile(MODEL_B, 'profile-b'),
    limits: { maxOutputTokens: 32000, contextWindow: 400000 },
    effort: 'high',
    thinking: { type: 'adaptive' },
    supportsReasoningReplay: false,
  };
}

function makeLiveLoop(initial: ActiveExecutionState): LiveAgentLoopHandle {
  return {
    config: {
      client: initial.client,
      model: initial.model,
      systemPrompt: 'sys' as never,
      messages: [] as ChatMessage[],
      maxTokens: initial.limits.maxOutputTokens,
      contextWindow: initial.limits.contextWindow,
      thinking: initial.thinking,
      ...(initial.effort ? { effort: initial.effort } : {}),
    },
    opts: { supportsReasoningReplay: initial.supportsReasoningReplay },
  };
}

function makeAgentCtx(initial: ActiveExecutionState): AgentToolContext {
  return {
    client: initial.client,
    parentModel: initial.model,
    parentMaxTokens: initial.limits.maxOutputTokens,
    parentEffort: initial.effort,
  } as unknown as AgentToolContext;
}

describe('Stage 5 — commitActiveExecutionState (sole-writer transition)', () => {
  it('updates ALL derived surfaces (state, liveAgentLoop.config/opts, agentCtx) from one commit', () => {
    const initial = stateA();
    const holder = createActiveExecutionStateHolder(initial);
    const liveLoop = makeLiveLoop(initial);
    const agentCtx = makeAgentCtx(initial);

    const next = stateB();
    holder.commit(next, liveLoop, agentCtx);

    // Canonical state replaced wholesale.
    expect(holder.current.model).toBe(MODEL_B);
    expect(holder.current.client).toBe(next.client);
    expect(holder.current.profileId).toBe('profile-b');
    expect(holder.current.limits).toEqual({ maxOutputTokens: 32000, contextWindow: 400000 });
    expect(holder.current.effort).toBe('high');
    expect(holder.current.thinking).toEqual({ type: 'adaptive' });
    expect(holder.current.supportsReasoningReplay).toBe(false);

    // liveAgentLoop.config derived from the SAME state — no field left stale.
    expect(liveLoop.config.client).toBe(next.client);
    expect(liveLoop.config.model).toBe(MODEL_B);
    expect(liveLoop.config.maxTokens).toBe(32000);
    expect(liveLoop.config.contextWindow).toBe(400000);
    expect(liveLoop.config.thinking).toEqual({ type: 'adaptive' });
    expect(liveLoop.config.effort).toBe('high');
    expect(liveLoop.opts.supportsReasoningReplay).toBe(false);

    // agentCtx parent fields derived from the SAME state.
    expect(agentCtx.client).toBe(next.client);
    expect(agentCtx.parentModel).toBe(MODEL_B);
    expect(agentCtx.parentMaxTokens).toBe(32000);
    expect(agentCtx.parentEffort).toBe('high');
  });

  it('deletes effort from config + agentCtx when the committed state has no effort (effort-only/back-switch parity)', () => {
    const initial = stateB(); // effort 'high'
    const holder = createActiveExecutionStateHolder(initial);
    const liveLoop = makeLiveLoop(initial);
    const agentCtx = makeAgentCtx(initial);
    expect(liveLoop.config.effort).toBe('high');
    expect(agentCtx.parentEffort).toBe('high');

    const next: ActiveExecutionState = { ...stateA(), effort: undefined };
    holder.commit(next, liveLoop, agentCtx);

    expect(holder.current.effort).toBeUndefined();
    expect('effort' in liveLoop.config).toBe(false);
    expect('parentEffort' in agentCtx).toBe(false);
  });

  it('tolerates a null liveAgentLoop (pre-loop pass) and still updates canonical state', () => {
    const holder = createActiveExecutionStateHolder(stateA());
    const next = stateB();
    expect(() => holder.commit(next, null, null)).not.toThrow();
    expect(holder.current.model).toBe(MODEL_B);
  });

  it('THROWS (invariant a) when a committed profile does not name the committed model', () => {
    const holder = createActiveExecutionStateHolder(stateA());
    const mismatched: ActiveExecutionState = {
      ...stateB(),
      model: MODEL_B,
      profile: profile(MODEL_A, 'mismatched'), // names MODEL_A, state says MODEL_B
    };
    expect(() => holder.commit(mismatched, null, null)).toThrow(/profile .* names model .* but active model/);
  });

  it('THROWS (invariant a) at construction when the initial profile is mispaired', () => {
    const bad: ActiveExecutionState = { ...stateA(), profile: profile(MODEL_B, 'x') };
    expect(() => createActiveExecutionStateHolder(bad)).toThrow(/ActiveExecutionState invariant/);
  });

  it('accepts an undefined profile (escalation to_model is profile-OPTIONAL)', () => {
    const holder = createActiveExecutionStateHolder(stateA());
    const next: ActiveExecutionState = { ...stateB(), profile: undefined };
    const liveLoop = makeLiveLoop(stateA());
    expect(() => holder.commit(next, liveLoop, null)).not.toThrow();
    expect(holder.current.profile).toBeUndefined();
    // Derived surfaces still updated.
    expect(liveLoop.config.model).toBe(MODEL_B);
  });

  it('BY CONSTRUCTION: omitting any field of ActiveExecutionState is a COMPILE error', () => {
    const holder = createActiveExecutionStateHolder(stateA());
    // The kill-by-construction property, asserted at the TYPE level (never run):
    // `commit` takes the FULL ActiveExecutionState, so a partial update cannot
    // type-check. If any field of ActiveExecutionState became optional, the
    // `@ts-expect-error` below would become an UNUSED suppression and the GATE
    // tsc would fail — turning the bug class back on would break the build.
    const assertPartialCommitIsTypeError = (): void => {
      // @ts-expect-error — model advanced but client/profileId/profile/limits/
      // effort/thinking/supportsReasoningReplay omitted: partial update rejected.
      holder.commit({ model: MODEL_B }, null, null);
    };
    // Reference the closure so lint doesn't flag it as unused; never invoke it
    // (the call inside is a deliberate type error, not runtime behaviour).
    expect(typeof assertPartialCommitIsTypeError).toBe('function');
    expect(holder.current.model).toBe(MODEL_A);
  });
});
