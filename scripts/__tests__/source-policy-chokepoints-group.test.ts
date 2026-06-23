import { describe, it, expect } from 'vitest';
import { GROUP_NAME, GUARDS, GUARD_NAMES } from '../groups/source-policy-chokepoints';

/**
 * Pins the batched group's membership. The step-identity baseline + registry
 * test (validate-fast-step-registry.test.ts) already fail if a member is
 * silently dropped from validate:fast; this test additionally documents the
 * expected set and asserts the group module is internally consistent, so a
 * drop is caught at the group module itself (closest to the change).
 */
const EXPECTED_MEMBERS = [
  'check-role-resolution-chokepoint',
  'check-app-exit-chokepoint',
  'check-fsevents-containment',
  'check-capability-resolution-dispatch-seam',
  'check-will-quit-preventdefault-chokepoint',
  'check-agent-tool-body-model-source',
  'check-agent-turn-dispatch-chokepoint',
  'check-safety-dir-call-sites',
  'check-trusted-tool-write-normalization',
  'check-failopen-scope-readers',
  'check-safety-eval-retry-transience',
  'check-pathroot-startswith-containment',
] as const;

describe('source-policy-chokepoints group', () => {
  it('has the expected group name', () => {
    expect(GROUP_NAME).toBe('validate:source-policy-chokepoints');
  });

  it('contains exactly the expected members (drop/add is a visible test diff)', () => {
    expect([...GUARD_NAMES].sort()).toEqual([...EXPECTED_MEMBERS].sort());
  });

  it('GUARD_NAMES is derived from GUARDS (no drift between the two exports)', () => {
    expect(GUARD_NAMES).toEqual(GUARDS.map((g) => g.name));
  });

  it('every member is well-formed (name + callable run + standalone rerun hint)', () => {
    for (const guard of GUARDS) {
      expect(typeof guard.name).toBe('string');
      expect(guard.name.length).toBeGreaterThan(0);
      expect(typeof guard.run).toBe('function');
      // every member sets an explicit standalone rerun hint
      expect(guard.rerun).toMatch(/^npx tsx scripts\/check-.*\.ts$/);
    }
  });

  it('has no duplicate members', () => {
    expect(new Set(GUARD_NAMES).size).toBe(GUARD_NAMES.length);
  });
});
