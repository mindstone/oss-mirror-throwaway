import { describe, it, expect } from 'vitest';
import { GROUP_NAME, GUARDS, GUARD_NAMES } from '../groups/registry-parity';

/**
 * Pins the batched registry-parity group's membership (companion to the
 * step-identity registry test, which fails if a member is silently dropped from
 * validate:fast). check-boundary-registry-paths is deliberately NOT here — it
 * imports boundary-hints.ts and stays a standalone step.
 */
const EXPECTED_MEMBERS = [
  'validate:ipc-schema-strictness',
  'validate:startup-ipc-ordering',
  'validate:ipc-handler-parity',
  'validate:ipc-bridge-exposure-parity',
  'validate:cloud-channel-parity',
] as const;

describe('registry-parity group', () => {
  it('has the expected group name', () => {
    expect(GROUP_NAME).toBe('validate:registry-parity');
  });

  it('contains exactly the expected members (drop/add is a visible test diff)', () => {
    expect([...GUARD_NAMES].sort()).toEqual([...EXPECTED_MEMBERS].sort());
  });

  it('GUARD_NAMES is derived from GUARDS (no drift)', () => {
    expect(GUARD_NAMES).toEqual(GUARDS.map((g) => g.name));
  });

  it('every member is well-formed (name + callable run + standalone rerun hint)', () => {
    for (const guard of GUARDS) {
      expect(guard.name.length).toBeGreaterThan(0);
      expect(typeof guard.run).toBe('function');
      expect(guard.rerun).toMatch(/^npm run validate:.+$/);
    }
  });

  it('has no duplicate members', () => {
    expect(new Set(GUARD_NAMES).size).toBe(GUARD_NAMES.length);
  });
});
