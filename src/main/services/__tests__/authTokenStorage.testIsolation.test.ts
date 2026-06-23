/**
 * Verifies that the safeStorage/keychain gate in authTokenStorage.ts works
 * correctly via the isE2eTestMode() check. Testing the gate function directly
 * is impractical due to the heavy Electron dependency chain, but we verify the
 * underlying gate logic is sound. The actual integration is:
 *   authTokenStorage.isEncryptionAvailable() → isE2eTestMode() → false → skip keychain
 *
 * See: docs/plans/partway/260220_e2e_test_isolation_hardening.md (Stage 4)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isE2eTestMode } from '../../utils/testIsolation';

describe('safeStorage keychain gate (via isE2eTestMode)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.REBEL_E2E_TEST_MODE;
    delete process.env.REBEL_TEST_USER_DATA_DIR;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('gate is OFF in production (safeStorage allowed)', () => {
    expect(isE2eTestMode()).toBe(false);
  });

  it('gate is OFF with only one env var (safeStorage allowed)', () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    expect(isE2eTestMode()).toBe(false);
  });

  it('gate is ON in E2E test mode (safeStorage blocked)', () => {
    process.env.REBEL_E2E_TEST_MODE = '1';
    process.env.REBEL_TEST_USER_DATA_DIR = '/tmp/rebel-test';
    expect(isE2eTestMode()).toBe(true);
  });
});
