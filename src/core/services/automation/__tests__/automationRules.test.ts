import { describe, expect, it } from 'vitest';
import {
  evaluateProviderReadinessRule,
  isProviderReadinessEligibleAutomation,
  summarizeProviderReadinessBlocks,
  type ProviderReadinessDecision,
} from '../automationRules';
import type { AutomationAdmissionBlock } from '@shared/types';
import type { ProviderCredentialState } from '@core/utils/validateProviderCredentials';

function makeBlockedReason(
  code: AutomationAdmissionBlock['code'],
): Extract<ProviderReadinessDecision, { status: 'blocked' }> {
  return {
    status: 'blocked',
    reason: {
      source: 'provider-readiness',
      code,
      errorKind: 'connection-not-configured',
      headlineClass: 'auth',
      provider:
        code === 'codex_disconnected'
          ? 'codex'
          : code === 'openrouter_disconnected'
            ? 'openrouter'
            : 'anthropic',
      message: 'blocked',
    },
  };
}

describe('evaluateProviderReadinessRule', () => {
  it('blocks codex disconnected with a cause-coded reason', () => {
    const credentialState: ProviderCredentialState = { kind: 'codex', status: 'disconnected' };

    const result = evaluateProviderReadinessRule({ credentialState });

    expect(result).toEqual({
      status: 'blocked',
      reason: {
        source: 'provider-readiness',
        code: 'codex_disconnected',
        errorKind: 'connection-not-configured',
        headlineClass: 'auth',
        provider: 'codex',
        message: 'ChatGPT Pro is disconnected. Reconnect it in Settings, or switch to another provider.',
      },
    });
  });

  it('blocks anthropic missing key with admission-compatible copy', () => {
    const credentialState: ProviderCredentialState = { kind: 'anthropic', status: 'missing' };

    const result = evaluateProviderReadinessRule({ credentialState });

    expect(result).toEqual({
      status: 'blocked',
      reason: {
        source: 'provider-readiness',
        code: 'anthropic_missing_api_key',
        errorKind: 'connection-not-configured',
        headlineClass: 'auth',
        provider: 'anthropic',
        message: 'Authentication is missing. Please add an API key in Settings.',
      },
    });
  });

  it('returns ready for valid local provider state', () => {
    const credentialState: ProviderCredentialState = {
      kind: 'local',
      status: 'valid',
      profile: {
        id: 'local-profile',
        name: 'Local',
        provider: 'mindstone-local',
        model: 'gpt-4.1-mini',
      } as any,
    };

    expect(evaluateProviderReadinessRule({ credentialState })).toEqual({ status: 'ready' });
  });
});

describe('summarizeProviderReadinessBlocks', () => {
  it('returns ready summary when readiness is ready', () => {
    const summary = summarizeProviderReadinessBlocks({
      readiness: { status: 'ready' },
      runs: [],
      definitions: [],
    });

    expect(summary).toEqual({
      readiness: 'ready',
      affectedAutomationCount: 0,
      affectedAutomationIds: [],
      blockedRunCount: 0,
      sinceMs: null,
      cause: null,
    });
  });

  it('reports affected automations even before any blocked run exists', () => {
    const blockedReason = makeBlockedReason('anthropic_missing_api_key');

    const summary = summarizeProviderReadinessBlocks({
      readiness: blockedReason,
      definitions: [
        { id: 'scheduled-llm', enabled: true, schedule: { type: 'daily' }, executor: 'llm' },
        { id: 'event-llm', enabled: true, schedule: { type: 'event' }, executor: 'llm' },
        { id: 'scheduled-script', enabled: true, schedule: { type: 'daily' }, executor: 'script' },
        { id: 'disabled-llm', enabled: false, schedule: { type: 'daily' }, executor: 'llm' },
      ],
      runs: [],
    });

    expect(summary.readiness).toBe('blocked');
    expect(summary.affectedAutomationCount).toBe(1);
    expect(summary.affectedAutomationIds).toEqual(['scheduled-llm']);
    expect(summary.blockedRunCount).toBe(0);
    expect(summary.sinceMs).toBeNull();
    expect(summary.cause?.code).toBe('anthropic_missing_api_key');
  });

  it('separates affected automation count from historical blocked-run footprint', () => {
    const blockedReason = makeBlockedReason('anthropic_missing_api_key');

    const summary = summarizeProviderReadinessBlocks({
      readiness: blockedReason,
      definitions: [
        { id: 'a', enabled: true, schedule: { type: 'daily' }, executor: 'llm' },
        { id: 'b', enabled: true, schedule: { type: 'daily' }, executor: undefined },
        { id: 'c', enabled: false, schedule: { type: 'daily' }, executor: 'llm' },
      ],
      runs: [
        {
          automationId: 'a',
          startedAt: 1_000,
          completedAt: 1_050,
          admissionBlock: blockedReason.reason,
        },
        {
          automationId: 'a',
          startedAt: 2_000,
          completedAt: 2_050,
        },
        {
          automationId: 'b',
          startedAt: 3_000,
          completedAt: 3_050,
          admissionBlock: blockedReason.reason,
        },
        {
          automationId: 'c',
          startedAt: 4_000,
          completedAt: 4_050,
          admissionBlock: blockedReason.reason,
        },
      ],
    });

    expect(summary.readiness).toBe('blocked');
    expect(summary.affectedAutomationCount).toBe(2);
    expect(summary.affectedAutomationIds).toEqual(['a', 'b']);
    expect(summary.blockedRunCount).toBe(2);
    expect(summary.sinceMs).toBe(1_050);
    expect(summary.cause?.code).toBe('anthropic_missing_api_key');
  });
});

describe('isProviderReadinessEligibleAutomation', () => {
  it('includes enabled scheduled llm definitions', () => {
    expect(
      isProviderReadinessEligibleAutomation({
        enabled: true,
        schedule: { type: 'daily' },
        executor: 'llm',
      }),
    ).toBe(true);
  });

  it('excludes script and event definitions', () => {
    expect(
      isProviderReadinessEligibleAutomation({
        enabled: true,
        schedule: { type: 'daily' },
        executor: 'script',
      }),
    ).toBe(false);

    expect(
      isProviderReadinessEligibleAutomation({
        enabled: true,
        schedule: { type: 'event' },
        executor: 'llm',
      }),
    ).toBe(false);
  });
});
