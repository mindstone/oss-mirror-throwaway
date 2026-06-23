import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';

import {
  isE2eTestMode,
  isRebelTestMode,
  isHeadlessCli,
  isAutomatedOrHeadlessContext,
  getSuperMcpDir,
  getSuperMcpOAuthTokensDir,
  getClaudeProjectsDir,
} from '../testIsolation';

describe('testIsolation', () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.REBEL_E2E_TEST_MODE;
    delete process.env.REBEL_TEST_USER_DATA_DIR;
    delete process.env.REBEL_TEST_MODE;
    delete process.env.REBEL_HEADLESS_CLI;
    process.argv = originalArgv.filter((a) => a !== '--headless-cli');
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
  });

  // ── isE2eTestMode ──────────────────────────────────────────────────

  describe('isE2eTestMode', () => {
    it('returns false when no env vars are set', () => {
      expect(isE2eTestMode()).toBe(false);
    });

    it('returns false when only REBEL_E2E_TEST_MODE is set', () => {
      process.env.REBEL_E2E_TEST_MODE = '1';
      expect(isE2eTestMode()).toBe(false);
    });

    it('returns false when only REBEL_TEST_USER_DATA_DIR is set', () => {
      process.env.REBEL_TEST_USER_DATA_DIR = '/tmp/rebel-test';
      expect(isE2eTestMode()).toBe(false);
    });

    it('returns true when BOTH env vars are set', () => {
      process.env.REBEL_E2E_TEST_MODE = '1';
      process.env.REBEL_TEST_USER_DATA_DIR = '/tmp/rebel-test';
      expect(isE2eTestMode()).toBe(true);
    });

    it('returns false when REBEL_E2E_TEST_MODE is not "1"', () => {
      process.env.REBEL_E2E_TEST_MODE = 'true';
      process.env.REBEL_TEST_USER_DATA_DIR = '/tmp/rebel-test';
      expect(isE2eTestMode()).toBe(false);
    });
  });

  // ── isRebelTestMode ─────────────────────────────────────────────────

  describe('isRebelTestMode', () => {
    it('returns false when REBEL_TEST_MODE is not set', () => {
      expect(isRebelTestMode()).toBe(false);
    });

    it('returns true when REBEL_TEST_MODE is "1"', () => {
      process.env.REBEL_TEST_MODE = '1';
      expect(isRebelTestMode()).toBe(true);
    });

    it('returns false when REBEL_TEST_MODE is not "1"', () => {
      process.env.REBEL_TEST_MODE = 'true';
      expect(isRebelTestMode()).toBe(false);
    });
  });

  // ── isHeadlessCli ──────────────────────────────────────────────────

  describe('isHeadlessCli', () => {
    it('returns false with no env/argv/switch', () => {
      expect(isHeadlessCli()).toBe(false);
    });

    it('returns true when REBEL_HEADLESS_CLI=1', () => {
      process.env.REBEL_HEADLESS_CLI = '1';
      expect(isHeadlessCli()).toBe(true);
    });

    it('returns true when --headless-cli is in argv', () => {
      process.argv = [...process.argv, '--headless-cli'];
      expect(isHeadlessCli()).toBe(true);
    });
  });

  // ── isAutomatedOrHeadlessContext ───────────────────────────────────

  describe('isAutomatedOrHeadlessContext', () => {
    it('returns false in a normal user launch', () => {
      expect(isAutomatedOrHeadlessContext()).toBe(false);
    });

    it('returns true under --rebel-test (REBEL_TEST_MODE=1)', () => {
      process.env.REBEL_TEST_MODE = '1';
      expect(isAutomatedOrHeadlessContext()).toBe(true);
    });

    it('returns true under raw REBEL_E2E_TEST_MODE=1 even WITHOUT the isolated user-data dir', () => {
      // Deliberately broader than isE2eTestMode(): for "is there a user to click
      // the dialog?" the raw flag is the right signal.
      process.env.REBEL_E2E_TEST_MODE = '1';
      expect(isE2eTestMode()).toBe(false); // stricter data-isolation check
      expect(isAutomatedOrHeadlessContext()).toBe(true); // broader modal-suppression check
    });

    it('returns true under headless CLI', () => {
      process.env.REBEL_HEADLESS_CLI = '1';
      expect(isAutomatedOrHeadlessContext()).toBe(true);
    });
  });

  // ── getSuperMcpDir ─────────────────────────────────────────────────

  describe('getSuperMcpDir', () => {
    it('returns real homedir path in production mode', () => {
      expect(getSuperMcpDir()).toBe(path.join(os.homedir(), '.super-mcp'));
    });

    it('returns isolated path in test mode', () => {
      process.env.REBEL_E2E_TEST_MODE = '1';
      process.env.REBEL_TEST_USER_DATA_DIR = '/tmp/rebel-test';
      expect(getSuperMcpDir()).toBe(path.join('/tmp/rebel-test', '.super-mcp'));
    });
  });

  // ── getSuperMcpOAuthTokensDir ──────────────────────────────────────

  describe('getSuperMcpOAuthTokensDir', () => {
    it('returns real homedir path in production mode', () => {
      expect(getSuperMcpOAuthTokensDir()).toBe(
        path.join(os.homedir(), '.super-mcp', 'oauth-tokens'),
      );
    });

    it('returns isolated path in test mode', () => {
      process.env.REBEL_E2E_TEST_MODE = '1';
      process.env.REBEL_TEST_USER_DATA_DIR = '/tmp/rebel-test';
      expect(getSuperMcpOAuthTokensDir()).toBe(
        path.join('/tmp/rebel-test', '.super-mcp', 'oauth-tokens'),
      );
    });
  });

  // ── getClaudeProjectsDir ───────────────────────────────────────────

  describe('getClaudeProjectsDir', () => {
    it('returns real homedir path in production mode', () => {
      expect(getClaudeProjectsDir()).toBe(
        path.join(os.homedir(), '.claude', 'projects'),
      );
    });

    it('returns isolated path in test mode', () => {
      process.env.REBEL_E2E_TEST_MODE = '1';
      process.env.REBEL_TEST_USER_DATA_DIR = '/tmp/rebel-test';
      expect(getClaudeProjectsDir()).toBe(
        path.join('/tmp/rebel-test', '.claude', 'projects'),
      );
    });
  });
});
