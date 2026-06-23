import { describe, expect, it } from 'vitest';
import { buildInboundAuthorPolicyRevision, evaluateInboundAuthor } from '../index';
import type { InboundAuthorContext, InboundAuthorGate, InboundAuthorPolicy } from '../types';

function createPolicy(overrides: Partial<InboundAuthorPolicy> = {}): InboundAuthorPolicy {
  const base: InboundAuthorPolicy = {
    inboundAuthorPolicySchemaVersion: 1,
    policyRevision: 1,
    mode: 'ownerOnly',
    allowlist: { slack: [] },
    blocklist: { slack: [] },
    surfaceTrusted: { slack: [] },
    agentAllowlist: { slack: [] },
    notices: { upgradeReviewPending: false },
    ownerNormalizedAuthorId: 'U_OWNER',
  };

  return {
    ...base,
    ...overrides,
    allowlist: { ...base.allowlist, ...(overrides.allowlist ?? {}) },
    blocklist: { ...base.blocklist, ...(overrides.blocklist ?? {}) },
    surfaceTrusted: { ...base.surfaceTrusted, ...(overrides.surfaceTrusted ?? {}) },
    agentAllowlist: { ...base.agentAllowlist, ...(overrides.agentAllowlist ?? {}) },
    notices: { ...base.notices, ...(overrides.notices ?? {}) },
  };
}

function createContext(overrides: Partial<InboundAuthorContext> = {}): InboundAuthorContext {
  const base: InboundAuthorContext = {
    connector: 'slack',
    teamId: 'T_TEAM',
    surfaceId: 'C_SURFACE',
    principalKind: 'human',
    normalizedAuthorId: 'U_STRANGER',
    principal: { kind: 'human', normalizedAuthorId: 'U_STRANGER' },
    surfaceTrusted: false,
  };

  const merged = { ...base, ...overrides };
  const principal = overrides.principal ?? {
    kind: merged.principalKind,
    normalizedAuthorId: merged.normalizedAuthorId,
  };

  return {
    ...merged,
    principal,
    principalKind: principal.kind,
    normalizedAuthorId: principal.normalizedAuthorId,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nestedValue);
    }
  }
  return value;
}

describe('evaluateInboundAuthor', () => {
  it('evaluates gates in order and stops on first allow decision', () => {
    const callOrder: string[] = [];
    const gates: ReadonlyArray<InboundAuthorGate> = [
      {
        id: 'pass_gate',
        description: 'returns pass',
        evaluate: () => {
          callOrder.push('pass_gate');
          return { decision: 'pass', gateId: 'pass_gate' };
        },
      },
      {
        id: 'allow_gate',
        description: 'returns allow',
        evaluate: () => {
          callOrder.push('allow_gate');
          return { decision: 'allow', gateId: 'allow_gate', reason: 'allow_reason' };
        },
      },
      {
        id: 'deny_gate',
        description: 'should not run',
        evaluate: () => {
          callOrder.push('deny_gate');
          return { decision: 'deny', gateId: 'deny_gate', reason: 'deny_reason' };
        },
      },
    ];

    const decision = evaluateInboundAuthor(createContext(), createPolicy(), gates);

    expect(decision.decision).toBe('allow');
    expect(decision.gateId).toBe('allow_gate');
    expect(decision.reason).toBe('allow_reason');
    expect(callOrder).toEqual(['pass_gate', 'allow_gate']);
  });

  it('stops on first deny decision', () => {
    const callOrder: string[] = [];
    const gates: ReadonlyArray<InboundAuthorGate> = [
      {
        id: 'deny_gate',
        description: 'returns deny',
        evaluate: () => {
          callOrder.push('deny_gate');
          return { decision: 'deny', gateId: 'deny_gate', reason: 'blocked' };
        },
      },
      {
        id: 'allow_gate',
        description: 'should not run',
        evaluate: () => {
          callOrder.push('allow_gate');
          return { decision: 'allow', gateId: 'allow_gate', reason: 'not_expected' };
        },
      },
    ];

    const decision = evaluateInboundAuthor(createContext(), createPolicy(), gates);

    expect(decision).toMatchObject({
      decision: 'deny',
      gateId: 'deny_gate',
      reason: 'blocked',
    });
    expect(callOrder).toEqual(['deny_gate']);
  });

  it('returns fallback deny when all gates pass', () => {
    const gates: ReadonlyArray<InboundAuthorGate> = [
      {
        id: 'first_pass',
        description: 'pass',
        evaluate: () => ({ decision: 'pass', gateId: 'first_pass' }),
      },
      {
        id: 'second_pass',
        description: 'pass',
        evaluate: () => ({ decision: 'pass', gateId: 'second_pass' }),
      },
    ];

    const decision = evaluateInboundAuthor(createContext(), createPolicy(), gates);

    expect(decision).toMatchObject({
      decision: 'deny',
      gateId: 'fallback_deny',
      reason: 'no_matching_gate',
    });
  });

  it('computes deterministic policy revision for identical policy input', () => {
    const policy = createPolicy({
      mode: 'allowlist',
      allowlist: { slack: ['U_ALPHA', 'U_BETA'] },
      blocklist: { slack: ['U_BLOCKED'] },
    });
    const gates: ReadonlyArray<InboundAuthorGate> = [
      {
        id: 'pass',
        description: 'pass',
        evaluate: () => ({ decision: 'pass', gateId: 'pass' }),
      },
    ];

    const first = evaluateInboundAuthor(createContext(), policy, gates);
    const second = evaluateInboundAuthor(createContext(), policy, gates);
    const direct = buildInboundAuthorPolicyRevision(policy);

    expect(first.policyRevision).toBe(second.policyRevision);
    expect(first.policyRevision).toBe(direct);
    expect(first.policyRevision).toMatch(/^v1:[a-f0-9]{40}$/);
  });

  it('changes policy revision when mode or list content changes', () => {
    const base = createPolicy({ mode: 'ownerOnly' });
    const modeChanged = createPolicy({ mode: 'allowlist' });
    const listChanged = createPolicy({ allowlist: { slack: ['U_ALLOWLISTED'] } });

    const baseRevision = buildInboundAuthorPolicyRevision(base);
    const modeRevision = buildInboundAuthorPolicyRevision(modeChanged);
    const listRevision = buildInboundAuthorPolicyRevision(listChanged);

    expect(modeRevision).not.toBe(baseRevision);
    expect(listRevision).not.toBe(baseRevision);
    expect(listRevision).not.toBe(modeRevision);
  });

  it('does not mutate context or policy objects', () => {
    const policy = createPolicy({
      mode: 'allowlist',
      allowlist: { slack: ['U_ALLOWLISTED'] },
      blocklist: { slack: ['U_BLOCKED'] },
      surfaceTrusted: { slack: ['C_PUBLIC'] },
      agentAllowlist: { slack: ['B_AGENT'] },
    });
    const ctx = createContext({
      surfaceId: 'C_PUBLIC',
      principal: { kind: 'human', normalizedAuthorId: 'U_ALLOWLISTED' },
    });
    const before = structuredClone({ policy, ctx });
    deepFreeze(policy);
    deepFreeze(ctx);

    const gates: ReadonlyArray<InboundAuthorGate> = [
      {
        id: 'pass',
        description: 'pass',
        evaluate: () => ({ decision: 'pass', gateId: 'pass' }),
      },
    ];

    const decision = evaluateInboundAuthor(ctx, policy, gates);

    expect(decision.decision).toBe('deny');
    expect(policy).toEqual(before.policy);
    expect(ctx).toEqual(before.ctx);
  });
});
