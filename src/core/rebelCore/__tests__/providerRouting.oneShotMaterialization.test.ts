import { describe, expect, it } from 'vitest';
import {
  resolveProviderRoutePlan,
  type ProviderRouterTurnInput,
} from '../providerRouting';
import type { ProviderRouteDecision } from '../providerRouteDecision';

// Stage 4 — one-shot materialization (kill the same-request double-derive).
//
// Before this change, the executor computed the provider route decision TWICE
// from one request: once inside `resolveProviderRoutePlan` (via decisionForRequest
// → ProviderRouter.forTurn) to materialize the plan, and a second time via a
// separate `ProviderRouter.forTurn` call whose only job was to seed the runtime
// context. Two derivations of one fact is the SSOT-divergence shape this effort
// kills.
//
// The fix lets callers pass the runtime context as a FUNCTION of the decision, so
// the decision computed once inside `resolveProviderRoutePlan` is threaded to the
// context builder. These tests pin: (a) the builder is invoked exactly once per
// request, and (b) it receives the SAME decision instance the plan is materialized
// from (`plan.decision === receivedDecision`) — provably one derivation.

const codexConnectedClaudeInput: ProviderRouterTurnInput = {
  codexConnectivity: 'connected',
  model: 'claude-haiku-4-5',
  role: 'execution',
  settings: {
    activeProvider: 'codex',
    models: {
      apiKey: 'fake-ant-linger-key',
      authMethod: 'api-key',
      model: 'claude-sonnet-4-6',
      oauthToken: null,
    },
    localModel: { activeProfileId: null, profiles: [] },
    openRouter: { enabled: false, oauthToken: null, selectedModel: 'anthropic/claude-sonnet-4.6' },
    providerKeys: {},
  },
};

describe('resolveProviderRoutePlan one-shot materialization', () => {
  it('invokes the decision-derived runtime-context builder exactly once per request', async () => {
    let calls = 0;
    await resolveProviderRoutePlan(
      { kind: 'forTurn', input: codexConnectedClaudeInput },
      () => {
        calls += 1;
        return {};
      },
    );
    expect(calls).toBe(1);
  });

  it('threads the SAME decision instance into the runtime-context builder and the materialized plan', async () => {
    let received: ProviderRouteDecision | null = null;
    const plan = await resolveProviderRoutePlan(
      { kind: 'forTurn', input: codexConnectedClaudeInput },
      (decision) => {
        received = decision;
        return {};
      },
    );
    // The builder must see the same decision object the plan was materialized from
    // — proof the route is derived exactly once, not twice from the same request.
    expect(received).not.toBeNull();
    expect(plan.decision).toBe(received);
  });

  it('still accepts a static runtime-context object (backward-compatible static callers)', async () => {
    const plan = await resolveProviderRoutePlan(
      { kind: 'forTurn', input: codexConnectedClaudeInput },
      { turnId: 'static-context-test' },
    );
    expect(plan.decision).toBeDefined();
  });
});
