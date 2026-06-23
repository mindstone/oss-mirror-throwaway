/**
 * SSOT gate tests for `isContractEnforcementOn`, co-located at its new @shared
 * home (relocated from registerContractHandler — Stage 1 of the broadcast
 * harness). The invoke seam's own test exercises this same function via the
 * re-export; these duplicate the fail-safe-OFF invariants at the canonical home
 * so a future move of the invoke test can't orphan them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isContractEnforcementOn } from './contractEnforcement';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isContractEnforcementOn (fail-safe-off gate)', () => {
  it('is ON under NODE_ENV==="test"', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('REBEL_CONTRACT_ENFORCE', '');
    expect(isContractEnforcementOn()).toBe(true);
  });

  it('is ON via the allowlisted opt-in flag ONLY under an explicit development env', () => {
    vi.stubEnv('NODE_ENV', 'development');
    for (const v of ['1', 'true', 'TRUE', ' true ']) {
      vi.stubEnv('REBEL_CONTRACT_ENFORCE', v);
      expect(isContractEnforcementOn()).toBe(true);
    }
  });

  it('KILL-BY-CONSTRUCTION: production + opt-in flag → OFF (no prod-enforce backdoor pre-shape-B)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    for (const v of ['1', 'true', 'TRUE']) {
      vi.stubEnv('REBEL_CONTRACT_ENFORCE', v);
      expect(isContractEnforcementOn()).toBe(false);
    }
  });

  it('KILL-BY-CONSTRUCTION: unset NODE_ENV (packaged-prod default) + opt-in flag → OFF', () => {
    vi.stubEnv('NODE_ENV', undefined as unknown as string);
    for (const v of ['1', 'true', 'TRUE', ' true ']) {
      vi.stubEnv('REBEL_CONTRACT_ENFORCE', v);
      expect(isContractEnforcementOn()).toBe(false);
    }
  });

  it('is OFF for unset / unknown env with no enabling flag (fail-safe default)', () => {
    vi.stubEnv('NODE_ENV', undefined as unknown as string);
    vi.stubEnv('REBEL_CONTRACT_ENFORCE', undefined as unknown as string);
    expect(isContractEnforcementOn()).toBe(false);

    vi.stubEnv('NODE_ENV', 'development');
    expect(isContractEnforcementOn()).toBe(false);

    vi.stubEnv('NODE_ENV', 'staging-unknown');
    expect(isContractEnforcementOn()).toBe(false);
  });

  it('treats ambiguous / falsy flag values as OFF (normalize-then-allowlist)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    for (const v of ['', ' ', '0', '0 ', 'false', 'FALSE', 'off', 'no']) {
      vi.stubEnv('REBEL_CONTRACT_ENFORCE', v);
      expect(isContractEnforcementOn()).toBe(false);
    }
  });
});
