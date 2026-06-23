import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { deriveModelRoles } from '../MessageItem';

/**
 * Renderer-side verification of the Turn Usage tooltip fix: the role rows are read from the
 * runtime-authored `roles[]` on the result event (Stage 3), not reconstructed by string-pairing.
 */
function resultEvent(partial: Partial<Extract<AgentEvent, { type: 'result' }>>): AgentEvent[] {
  return [{ type: 'result', text: 'x', timestamp: 1, ...partial } as Extract<AgentEvent, { type: 'result' }>];
}

describe('deriveModelRoles', () => {
  it('reads roles[] and labels them Planner / Main work / Behind the Scenes (the diagnosed direct-answer turn)', () => {
    const rows = deriveModelRoles(
      resultEvent({
        model: 'anthropic/claude-4.8-opus-20260528',
        planningModel: 'anthropic/claude-opus-4-8',
        roles: [
          { role: 'thinking', canonicalModelId: 'claude-opus-4-8', rawModelId: 'anthropic/claude-4.8-opus-20260528', status: 'observed', modelUsageKey: 'anthropic/claude-4.8-opus-20260528', authMethod: 'openrouter' },
          { role: 'working', canonicalModelId: 'deepseek-v4-pro', rawModelId: 'deepseek/deepseek-v4-pro', status: 'configured_not_used' },
          { role: 'fast', canonicalModelId: 'deepseek-v4-flash', rawModelId: 'deepseek/deepseek-v4-flash', status: 'configured_not_used' },
        ],
      }),
    );
    expect(rows.map((r) => r.role)).toEqual(['Planner', 'Main work', 'Behind the Scenes']);
    expect(rows[0].status).toBe('observed');
    expect(rows[1].status).toBe('configured_not_used');
    expect(rows[2].status).toBe('configured_not_used');
    // The Behind-the-Scenes row exists (the diagnosed "no BTS row" gap is closed).
    expect(rows.some((r) => r.role === 'Behind the Scenes')).toBe(true);
    // Friendly catalog labels: Anthropic main model resolves via canonical id (MODEL_OPTIONS),
    // OpenRouter/auxiliary models via the raw provider-prefixed id (catalog) — neither shows a raw id.
    expect(rows[0].model).toBe('Opus 4.8');
    expect(rows[1].model).toBe('DeepSeek V4 Pro');
    expect(rows[2].model).toBe('DeepSeek V4 Flash');
  });

  it('prefers roles[] over the legacy string-pairing when both are present', () => {
    const rows = deriveModelRoles(
      resultEvent({
        model: 'gpt-5.5',
        planningModel: 'claude-opus-4-8',
        roles: [
          { role: 'working', canonicalModelId: 'gpt-5.5', rawModelId: 'gpt-5.5', status: 'observed', modelUsageKey: 'gpt-5.5' },
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('Main work');
  });

  it('falls back to legacy derivation (relabeled) for pre-roles[] persisted turns', () => {
    const rows = deriveModelRoles(
      resultEvent({ model: 'gpt-5.5', planningModel: 'claude-opus-4-8' }),
    );
    expect(rows.map((r) => r.role)).toEqual(['Planner', 'Main work']);
    expect(rows.every((r) => r.status === undefined)).toBe(true);
  });

  it('returns no rows for a legacy single-model turn (planningModel === model)', () => {
    expect(deriveModelRoles(resultEvent({ model: 'gpt-5.5', planningModel: 'gpt-5.5' }))).toEqual([]);
    expect(deriveModelRoles(resultEvent({ model: 'gpt-5.5' }))).toEqual([]);
  });

  it('returns no rows when there is no result event', () => {
    expect(deriveModelRoles(undefined)).toEqual([]);
    expect(deriveModelRoles([{ type: 'status', message: 'x', timestamp: 1 } as AgentEvent])).toEqual([]);
  });

  it('joins per-model usage and computes token share across observed rows (Q1 "even better")', () => {
    const rows = deriveModelRoles(
      resultEvent({
        planningModel: 'anthropic/claude-opus-4-8',
        model: 'deepseek/deepseek-v4-pro',
        modelUsage: {
          'anthropic/claude-4.8-opus-20260528': { inputTokens: 10, outputTokens: 10, costUsd: 0.02, providersSeen: [] },
          'deepseek/deepseek-v4-pro': { inputTokens: 70, outputTokens: 10, costUsd: 0.001, providersSeen: [] },
        },
        roles: [
          { role: 'thinking', canonicalModelId: 'claude-opus-4-8', rawModelId: 'anthropic/claude-4.8-opus-20260528', status: 'observed', modelUsageKey: 'anthropic/claude-4.8-opus-20260528', pricingStatus: 'priced' },
          { role: 'working', canonicalModelId: 'deepseek-v4-pro', rawModelId: 'deepseek/deepseek-v4-pro', status: 'observed', modelUsageKey: 'deepseek/deepseek-v4-pro', pricingStatus: 'priced' },
        ],
      }),
    );
    const planner = rows.find((r) => r.role === 'Planner');
    const main = rows.find((r) => r.role === 'Main work');
    expect(planner?.usage).toEqual({ inputTokens: 10, outputTokens: 10, costUsd: 0.02 });
    expect(main?.usage?.inputTokens).toBe(70);
    // shares of observed input+output tokens: planner 20/100 = 20%, main 80/100 = 80%
    expect(planner?.sharePct).toBe(20);
    expect(main?.sharePct).toBe(80);
  });

  it('surfaces models that ran without a role tier as "Also ran" rows (council/sub-agents not lost)', () => {
    const rows = deriveModelRoles(
      resultEvent({
        planningModel: 'anthropic/claude-opus-4-8',
        model: 'anthropic/claude-opus-4-8',
        modelUsage: {
          'anthropic/claude-4.8-opus-20260528': { inputTokens: 5, outputTokens: 5, costUsd: 0.01, providersSeen: [] },
          'claude-haiku-4-5': { inputTokens: 100, outputTokens: 20, costUsd: 0.0005, providersSeen: [] },
        },
        roles: [
          { role: 'thinking', canonicalModelId: 'claude-opus-4-8', rawModelId: 'anthropic/claude-opus-4-8', status: 'observed', modelUsageKey: 'anthropic/claude-4.8-opus-20260528', pricingStatus: 'priced' },
        ],
      }),
    );
    const alsoRan = rows.filter((r) => r.role === 'Also ran');
    expect(alsoRan).toHaveLength(1);
    expect(alsoRan[0].usage?.inputTokens).toBe(100);
    expect(alsoRan[0].status).toBe('observed');
  });
});
