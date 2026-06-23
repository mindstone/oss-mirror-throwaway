import { describe, it, expect } from 'vitest';
import {
  verifyNonce,
  NONCE_TTL_MS,
  type GateNonceSidecar,
  type TreeBinding,
  type VerifyInput,
} from '../lib/gate-nonce';

/**
 * The pure `verifyNonce` is the heart of the pre-push fast-path safety contract.
 * The hook skips the expensive gate ONLY when this returns ok=true, so every
 * field that could let an un-validated tree land must independently flip it to
 * false. These tests assert exactly that: start from a fully-valid input, then
 * perturb one axis at a time and confirm the verdict goes false.
 */

const NOW = Date.parse('2026-06-07T03:00:00.000Z');

function binding(overrides: Partial<TreeBinding> = {}): TreeBinding {
  return {
    head_sha: 'a'.repeat(40),
    tree_sha: 'b'.repeat(40),
    upstream_sha: 'c'.repeat(40),
    submodule_shas: { 'rebel-system': 'd'.repeat(40), 'super-mcp': 'e'.repeat(40) },
    tier_covered: 1,
    working_tree_clean: true,
    ...overrides,
  };
}

function sidecar(overrides: Partial<GateNonceSidecar> = {}, bindingOverrides: Partial<TreeBinding> = {}): GateNonceSidecar {
  return {
    nonce: 'deadbeef'.repeat(6),
    binding: binding(bindingOverrides),
    created_at: '2026-06-07T02:59:30.000Z', // 30s before NOW
    pid: 4242,
    ...overrides,
  };
}

function validInput(): VerifyInput {
  const sc = sidecar();
  return {
    envToken: sc.nonce,
    sidecar: sc,
    currentBinding: binding(),
    requiredTier: 1,
    nowMs: NOW,
  };
}

describe('verifyNonce — the happy path', () => {
  it('accepts a fresh, exact, clean, env-matched nonce', () => {
    const r = verifyNonce(validInput());
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/valid for tree/);
  });
});

describe('verifyNonce — env-token gating', () => {
  it('rejects when the env token is absent (a manual git push)', () => {
    const r = verifyNonce({ ...validInput(), envToken: undefined });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not set/);
  });

  it('rejects when the env token is empty string', () => {
    expect(verifyNonce({ ...validInput(), envToken: '' }).ok).toBe(false);
  });

  it('rejects when the env token does not equal the sidecar nonce (replay/forgery)', () => {
    const r = verifyNonce({ ...validInput(), envToken: 'f'.repeat(48) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not match/);
  });
});

describe('verifyNonce — sidecar presence', () => {
  it('rejects when there is no sidecar', () => {
    const r = verifyNonce({ ...validInput(), sidecar: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no nonce sidecar/);
  });
});

describe('verifyNonce — the tree/state binding (the critical safety axis)', () => {
  it('rejects when the committed tree changed since the gate (race re-merge)', () => {
    const input = validInput();
    const r = verifyNonce({ ...input, currentBinding: binding({ tree_sha: '9'.repeat(40) }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/tree changed/);
  });

  it('rejects when HEAD changed but tree somehow matched', () => {
    const input = validInput();
    const r = verifyNonce({ ...input, currentBinding: binding({ head_sha: '9'.repeat(40) }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/HEAD changed/);
  });

  it('rejects when upstream moved since the gate', () => {
    const input = validInput();
    const r = verifyNonce({ ...input, currentBinding: binding({ upstream_sha: '9'.repeat(40) }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/upstream moved/);
  });

  it('treats null upstream consistently (no-upstream gate vs no-upstream push = match)', () => {
    const sc = sidecar({}, { upstream_sha: null });
    const r = verifyNonce({
      envToken: sc.nonce,
      sidecar: sc,
      currentBinding: binding({ upstream_sha: null }),
      requiredTier: 1,
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects when a submodule pin changed', () => {
    const input = validInput();
    const r = verifyNonce({
      ...input,
      currentBinding: binding({ submodule_shas: { 'rebel-system': '1'.repeat(40), 'super-mcp': 'e'.repeat(40) } }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/submodule pins changed/);
  });

  it('rejects when a submodule was added/removed since the gate', () => {
    const input = validInput();
    const r = verifyNonce({
      ...input,
      currentBinding: binding({ submodule_shas: { 'rebel-system': 'd'.repeat(40) } }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/submodule pins changed/);
  });
});

describe('verifyNonce — clean-working-tree assertion (Opus F1)', () => {
  it('rejects when the working tree is dirty at push time even if HEAD/tree match', () => {
    const input = validInput();
    const r = verifyNonce({ ...input, currentBinding: binding({ working_tree_clean: false }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/dirty/);
  });
});

describe('verifyNonce — tier coverage', () => {
  it('rejects when the gate covered a lower tier than the push requires', () => {
    const sc = sidecar({}, { tier_covered: 1 });
    const r = verifyNonce({ envToken: sc.nonce, sidecar: sc, currentBinding: binding({ tier_covered: 1 }), requiredTier: 2, nowMs: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/tier/);
  });

  it('accepts when the gate covered a higher tier than required', () => {
    const sc = sidecar({}, { tier_covered: 3 });
    const r = verifyNonce({ envToken: sc.nonce, sidecar: sc, currentBinding: binding({ tier_covered: 3 }), requiredTier: 2, nowMs: NOW });
    expect(r.ok).toBe(true);
  });
});

describe('verifyNonce — TTL / clock', () => {
  it('rejects an expired nonce', () => {
    const input = validInput();
    const r = verifyNonce({ ...input, nowMs: NOW + NONCE_TTL_MS + 1000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });

  it('accepts right at the TTL edge', () => {
    const input = validInput();
    // created_at is 30s before NOW; choose now so age == TTL exactly.
    const created = Date.parse(input.sidecar!.created_at);
    const r = verifyNonce({ ...input, nowMs: created + NONCE_TTL_MS });
    expect(r.ok).toBe(true);
  });

  it('rejects a future-dated nonce beyond skew tolerance (tampering / bad clock)', () => {
    const input = validInput();
    const created = Date.parse(input.sidecar!.created_at);
    const r = verifyNonce({ ...input, nowMs: created - 120_000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/future/);
  });

  it('rejects an unparseable timestamp', () => {
    const sc = sidecar({ created_at: 'not-a-date' });
    const r = verifyNonce({ envToken: sc.nonce, sidecar: sc, currentBinding: binding(), requiredTier: 1, nowMs: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unparseable/);
  });
});
