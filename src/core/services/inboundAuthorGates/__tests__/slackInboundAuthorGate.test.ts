import { describe, expect, it } from 'vitest';
import { evaluateInboundAuthor } from '../index';
import { SLACK_INBOUND_AUTHOR_GATE } from '../slackInboundAuthorGate';
import type { InboundAuthorContext, InboundAuthorPolicy } from '../types';

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

function evaluate(
  contextOverrides: Partial<InboundAuthorContext> = {},
  policyOverrides: Partial<InboundAuthorPolicy> = {},
) {
  return evaluateInboundAuthor(
    createContext(contextOverrides),
    createPolicy(policyOverrides),
    [SLACK_INBOUND_AUTHOR_GATE],
  );
}

describe('SLACK_INBOUND_AUTHOR_GATE', () => {
  it('denies when blocklist contains the owner (blocklist precedence)', () => {
    const decision = evaluate(
      { principal: { kind: 'human', normalizedAuthorId: 'U_OWNER' } },
      {
        mode: 'ownerOnly',
        blocklist: { slack: ['U_OWNER'] },
      },
    );

    expect(decision).toMatchObject({
      decision: 'deny',
      gateId: 'slack_owner_allowlist',
      reason: 'blocklist',
    });
  });

  it('denies when blocklist contains an author even in legacyPermissive mode', () => {
    const decision = evaluate(
      { principal: { kind: 'human', normalizedAuthorId: 'U_BLOCKED' } },
      {
        mode: 'legacyPermissive',
        blocklist: { slack: ['U_BLOCKED'] },
      },
    );

    expect(decision.reason).toBe('blocklist');
    expect(decision.decision).toBe('deny');
  });

  it('denies blocklisted agents even when they are on the agent allowlist', () => {
    const decision = evaluate(
      { principal: { kind: 'agent', normalizedAuthorId: 'B_BLOCKED_AGENT' } },
      {
        mode: 'ownerOnly',
        blocklist: { slack: ['B_BLOCKED_AGENT'] },
        agentAllowlist: { slack: ['B_BLOCKED_AGENT'] },
      },
    );

    expect(decision).toMatchObject({ decision: 'deny', reason: 'blocklist' });
  });

  it('allows human strangers in legacyPermissive mode', () => {
    const decision = evaluate(
      { principal: { kind: 'human', normalizedAuthorId: 'U_STRANGER' } },
      { mode: 'legacyPermissive' },
    );

    expect(decision).toMatchObject({ decision: 'allow', reason: 'legacy_permissive' });
  });

  it('allows agent strangers in legacyPermissive mode', () => {
    const decision = evaluate(
      { principal: { kind: 'agent', normalizedAuthorId: 'B_STRANGER' } },
      { mode: 'legacyPermissive' },
    );

    expect(decision).toMatchObject({ decision: 'allow', reason: 'legacy_permissive' });
  });

  it('allows owner in ownerOnly mode', () => {
    const decision = evaluate(
      { principal: { kind: 'human', normalizedAuthorId: 'U_OWNER' } },
      { mode: 'ownerOnly' },
    );

    expect(decision).toMatchObject({ decision: 'allow', reason: 'owner' });
  });

  it('allows owner in allowlist mode', () => {
    const decision = evaluate(
      { principal: { kind: 'human', normalizedAuthorId: 'U_OWNER' } },
      { mode: 'allowlist' },
    );

    expect(decision).toMatchObject({ decision: 'allow', reason: 'owner' });
  });

  it('denies strangers in ownerOnly mode', () => {
    const decision = evaluate(
      { principal: { kind: 'human', normalizedAuthorId: 'U_STRANGER' } },
      { mode: 'ownerOnly' },
    );

    expect(decision).toMatchObject({
      decision: 'deny',
      reason: 'not_owner_or_allowlisted',
    });
  });

  it('allows allowlist members in allowlist mode', () => {
    const decision = evaluate(
      { principal: { kind: 'human', normalizedAuthorId: 'U_TEAMMATE' } },
      {
        mode: 'allowlist',
        allowlist: { slack: ['U_TEAMMATE'] },
      },
    );

    expect(decision).toMatchObject({ decision: 'allow', reason: 'allowlist' });
  });

  it('denies allowlist members in ownerOnly mode', () => {
    const decision = evaluate(
      { principal: { kind: 'human', normalizedAuthorId: 'U_TEAMMATE' } },
      {
        mode: 'ownerOnly',
        allowlist: { slack: ['U_TEAMMATE'] },
      },
    );

    expect(decision).toMatchObject({ decision: 'deny', reason: 'not_owner_or_allowlisted' });
  });

  it('auto-allows human in trusted surface in allowlist mode even if not in allowlist', () => {
    const decision = evaluate(
      {
        principal: { kind: 'human', normalizedAuthorId: 'U_STRANGER' },
        surfaceTrusted: true,
      },
      { mode: 'allowlist' },
    );

    expect(decision).toMatchObject({ decision: 'allow', reason: 'surface_trusted' });
  });

  it('keeps blocklist precedence over surfaceTrusted in allowlist mode', () => {
    const decision = evaluate(
      {
        principal: { kind: 'human', normalizedAuthorId: 'U_BLOCKED' },
        surfaceTrusted: true,
      },
      {
        mode: 'allowlist',
        blocklist: { slack: ['U_BLOCKED'] },
      },
    );

    expect(decision).toMatchObject({ decision: 'deny', reason: 'blocklist' });
  });

  it('denies trusted surfaces in ownerOnly mode', () => {
    const decision = evaluate(
      {
        principal: { kind: 'human', normalizedAuthorId: 'U_STRANGER' },
        surfaceTrusted: true,
      },
      { mode: 'ownerOnly' },
    );

    expect(decision).toMatchObject({ decision: 'deny', reason: 'not_owner_or_allowlisted' });
  });

  it('does not auto-allow trusted surfaces in allowlist mode via policy.surfaceTrusted membership', () => {
    const decision = evaluate(
      {
        principal: { kind: 'human', normalizedAuthorId: 'U_STRANGER' },
        surfaceId: 'C_TRUSTED',
        surfaceTrusted: false,
      },
      {
        mode: 'allowlist',
        surfaceTrusted: { slack: ['C_TRUSTED'] },
      },
    );

    expect(decision).toMatchObject({ decision: 'deny', reason: 'not_owner_or_allowlisted' });
  });

  it('allows listed agents in ownerOnly mode via agentAllowlist', () => {
    const decision = evaluate(
      { principal: { kind: 'agent', normalizedAuthorId: 'B_ALLOWED' } },
      {
        mode: 'ownerOnly',
        agentAllowlist: { slack: ['B_ALLOWED'] },
      },
    );

    expect(decision).toMatchObject({ decision: 'allow', reason: 'agent_allowlist' });
  });

  it('denies non-listed agents in ownerOnly mode', () => {
    const decision = evaluate(
      { principal: { kind: 'agent', normalizedAuthorId: 'B_STRANGER' } },
      { mode: 'ownerOnly' },
    );

    expect(decision).toMatchObject({ decision: 'deny', reason: 'not_owner_or_allowlisted' });
  });

  it('denies non-listed agents in allowlist mode when surface is untrusted', () => {
    const decision = evaluate(
      {
        principal: { kind: 'agent', normalizedAuthorId: 'B_STRANGER' },
        surfaceTrusted: false,
      },
      {
        mode: 'allowlist',
        allowlist: { slack: [] },
      },
    );

    expect(decision).toMatchObject({ decision: 'deny', reason: 'not_owner_or_allowlisted' });
  });

  it('does not treat agent principals as owners even when IDs match', () => {
    const decision = evaluate(
      { principal: { kind: 'agent', normalizedAuthorId: 'U_OWNER' } },
      { mode: 'ownerOnly' },
    );

    expect(decision).toMatchObject({ decision: 'deny', reason: 'not_owner_or_allowlisted' });
  });

  it('denies allowlist mode strangers when they are neither owner nor allowlisted nor trusted', () => {
    const decision = evaluate(
      {
        principal: { kind: 'human', normalizedAuthorId: 'U_STRANGER' },
        surfaceTrusted: false,
      },
      {
        mode: 'allowlist',
        allowlist: { slack: ['U_TEAMMATE'] },
      },
    );

    expect(decision).toMatchObject({ decision: 'deny', reason: 'not_owner_or_allowlisted' });
  });

  it('denies unknown principals by default', () => {
    const decision = evaluate(
      { principal: { kind: 'unknown', normalizedAuthorId: 'UNKNOWN' } },
      { mode: 'ownerOnly' },
    );

    expect(decision).toMatchObject({ decision: 'deny', reason: 'not_owner_or_allowlisted' });
  });

  it('produces deterministic revision for same policy and context', () => {
    const context = createContext({
      principal: { kind: 'human', normalizedAuthorId: 'U_OWNER' },
    });
    const policy = createPolicy({ mode: 'ownerOnly' });

    const first = evaluateInboundAuthor(context, policy, [SLACK_INBOUND_AUTHOR_GATE]);
    const second = evaluateInboundAuthor(context, policy, [SLACK_INBOUND_AUTHOR_GATE]);

    expect(first.policyRevision).toBe(second.policyRevision);
  });

  it('changes revision when policy mode changes', () => {
    const context = createContext({
      principal: { kind: 'human', normalizedAuthorId: 'U_OWNER' },
    });
    const ownerOnly = createPolicy({ mode: 'ownerOnly' });
    const allowlist = createPolicy({ mode: 'allowlist' });

    const ownerOnlyDecision = evaluateInboundAuthor(context, ownerOnly, [SLACK_INBOUND_AUTHOR_GATE]);
    const allowlistDecision = evaluateInboundAuthor(context, allowlist, [SLACK_INBOUND_AUTHOR_GATE]);

    expect(ownerOnlyDecision.policyRevision).not.toBe(allowlistDecision.policyRevision);
  });

  it('changes revision when allowlist contents change', () => {
    const context = createContext({
      principal: { kind: 'human', normalizedAuthorId: 'U_TEAMMATE' },
    });
    const withEmptyAllowlist = createPolicy({
      mode: 'allowlist',
      allowlist: { slack: [] },
    });
    const withTeammateAllowlist = createPolicy({
      mode: 'allowlist',
      allowlist: { slack: ['U_TEAMMATE'] },
    });

    const first = evaluateInboundAuthor(context, withEmptyAllowlist, [SLACK_INBOUND_AUTHOR_GATE]);
    const second = evaluateInboundAuthor(context, withTeammateAllowlist, [SLACK_INBOUND_AUTHOR_GATE]);

    expect(first.policyRevision).not.toBe(second.policyRevision);
  });
});
