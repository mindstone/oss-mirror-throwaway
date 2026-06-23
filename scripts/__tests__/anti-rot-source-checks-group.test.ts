import { describe, it, expect } from 'vitest';
import { GROUP_NAME, GUARDS, GUARD_NAMES } from '../groups/anti-rot-source-checks';

/**
 * Pins the batched anti-rot-source-checks group membership (companion to the
 * step-identity registry test). check-bound-bts-eval-contracts and
 * check-sentry-breadcrumb-scrub were candidates but stay standalone (evals/
 * manifest import cascade; multi-line entry + own wiring test, respectively).
 */
const EXPECTED_MEMBERS = [
  'check-husky-pre-push-fast-tier',
  'check-oauth-setup-guidance',
  'check-renderer-oauth-setup-guidance',
  'check-no-legacy-eval-tokens',
  'validate:escape-hatches',
  'validate:direct-session-puts',
  'validate:agent-error-emit-callers',
  'check-no-raw-ipc-invoke',
  'validate:r2-manifest-guard',
  'check-commit-marker-detection',
] as const;

describe('anti-rot-source-checks group', () => {
  it('has the expected group name', () => {
    expect(GROUP_NAME).toBe('validate:anti-rot-source-checks');
  });

  it('contains exactly the expected members (drop/add is a visible test diff)', () => {
    expect([...GUARD_NAMES].sort()).toEqual([...EXPECTED_MEMBERS].sort());
  });

  it('GUARD_NAMES is derived from GUARDS (no drift)', () => {
    expect(GUARD_NAMES).toEqual(GUARDS.map((g) => g.name));
  });

  it('every member is well-formed (name + callable run + rerun hint)', () => {
    for (const guard of GUARDS) {
      expect(guard.name.length).toBeGreaterThan(0);
      expect(typeof guard.run).toBe('function');
      expect(guard.rerun).toMatch(/^(npm run |npx tsx scripts\/).+/);
    }
  });

  it('has no duplicate members', () => {
    expect(new Set(GUARD_NAMES).size).toBe(GUARD_NAMES.length);
  });
});
