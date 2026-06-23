import { describe, expect, it } from 'vitest';
import type { ModelRoleTier, ModelRoleWire } from '@shared/types';
import {
  MODEL_ROLES,
  modelRoleToWire,
  modelRoleFromWire,
  serializeRoleResolutionFailureRawError,
  parseRoleResolutionFailureFromRawError,
  makeRoleNotConfiguredStatusMessage,
  parseRoleNotConfiguredStatusMessage,
  type RoleResolutionFailure,
} from '../modelRoleResolver';

/**
 * Guards the role-vocabulary unification invariants (see
 * docs/plans/260614_smart-model-routing/ROLE_VOCAB_UNIFICATION_PLAN.md):
 *
 *  - The CANONICAL capability tier (`ModelRoleTier`, the type all internal model-
 *    role logic uses) spells the cheap tier `'background'` — never `'fast'`.
 *  - The persisted WIRE spelling (`ModelRoleWire`, used by `ModelRoleBinding.role`
 *    + its Zod schemas) keeps `'fast'` for backward/cross-version compatibility
 *    with already-persisted turns. Renaming the wire would break loading old
 *    conversations / cloud-synced turns from other app versions.
 *
 * These two MUST stay distinct. The compile-time guards below fail (via the
 * `@ts-expect-error` flipping to "unused") the moment someone collapses them —
 * e.g. "fixing" the wire to `'background'` or letting `'fast'` leak into the
 * canonical tier. `lint:ts` type-checks test files, so these are enforced.
 */
describe('model role tier / wire invariants', () => {
  it('canonical MODEL_ROLES uses the background tier, not fast', () => {
    expect([...MODEL_ROLES].sort()).toEqual(['background', 'thinking', 'working']);
    expect(MODEL_ROLES).not.toContain('fast');
  });

  it('canonical and wire spellings are pinned at the type level', () => {
    const tier: ModelRoleTier = 'background';
    const wire: ModelRoleWire = 'fast';
    expect(tier).toBe('background');
    expect(wire).toBe('fast');

    // @ts-expect-error — 'fast' is the WIRE spelling; it must never be a canonical tier value.
    const notTier: ModelRoleTier = 'fast';
    void notTier;
    // @ts-expect-error — 'background' is the CANONICAL spelling; it must never be the wire value.
    const notWire: ModelRoleWire = 'background';
    void notWire;
  });
});

/**
 * The ModelRole value DOES reach the persisted wire via two serializers — the
 * role-resolution error `rawError` payload and the sub-agent role-not-configured
 * status string. Both must keep the cheap tier as `'fast'` on the wire (so old
 * conversations re-parse and old app versions can read new events), while
 * exposing canonical `'background'` to callers. Regression guard for the bug the
 * cross-family review caught.
 */
describe('persisted-wire serializers keep cheap tier as fast', () => {
  it('modelRoleToWire / modelRoleFromWire round-trip with legacy tolerance', () => {
    expect(modelRoleToWire('background')).toBe('fast');
    expect(modelRoleToWire('working')).toBe('working');
    expect(modelRoleToWire('thinking')).toBe('thinking');
    expect(modelRoleFromWire('fast')).toBe('background'); // legacy wire
    expect(modelRoleFromWire('background')).toBe('background'); // forward-compat
    expect(modelRoleFromWire('working')).toBe('working');
    expect(modelRoleFromWire('nonsense')).toBeNull();
  });

  it('serializes the error rawError role as wire fast, parses back to background', () => {
    const failure: RoleResolutionFailure = {
      ok: false,
      role: 'background',
      reason: 'no-profile-and-no-setting-for-role',
    };
    const raw = serializeRoleResolutionFailureRawError(failure, 'Behind the Scenes model needs setup');
    expect(raw).toContain('"role":"fast"'); // byte-identical wire
    expect(raw).not.toContain('"role":"background"');
    expect(parseRoleResolutionFailureFromRawError(raw)).toEqual(failure); // canonical on read
  });

  it('parses a LEGACY persisted rawError (role:fast) back to canonical background', () => {
    const legacyRaw = JSON.stringify({
      message: 'old event',
      details: { roleResolutionFailure: { ok: false, role: 'fast', reason: 'no-profile-and-no-setting-for-role' } },
    });
    expect(parseRoleResolutionFailureFromRawError(legacyRaw)).toEqual({
      ok: false,
      role: 'background',
      reason: 'no-profile-and-no-setting-for-role',
    });
  });

  it('status message uses wire fast and round-trips (incl. legacy)', () => {
    const msg = makeRoleNotConfiguredStatusMessage('background');
    expect(msg.endsWith(':fast')).toBe(true); // byte-identical wire
    expect(parseRoleNotConfiguredStatusMessage(msg)).toBe('background');
    // legacy persisted status string
    expect(parseRoleNotConfiguredStatusMessage('agent:role-not-configured:fast')).toBe('background');
  });
});
