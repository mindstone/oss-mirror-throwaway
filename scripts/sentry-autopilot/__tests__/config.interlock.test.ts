import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../config.ts';

const ORIGINAL_ENV = { ...process.env };

function setEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  setEnv({
    SENTRY_AUTH_TOKEN: 'token',
    AUTOPILOT_VERIFY_MODE: undefined,
    AUTOPILOT_PUSH_MODE: undefined,
    AUTOPILOT_PENDING_MODE: undefined,
    AUTOPILOT_CLI: undefined,
    CURSOR_API_KEY: undefined,
    AUTOPILOT_CURSOR_MODEL: undefined,
    ANTHROPIC_API_KEY: undefined,
    AUTOPILOT_CLAUDE_MODEL: undefined,
    GITHUB_TOKEN: undefined,
    AUTOPILOT_REPO_FULL_NAME: undefined,
    AUTOPILOT_TARGET_SENTRY_ID: undefined,
    AUTOPILOT_RELEASE_GATE_ENABLED: undefined,
    AUTOPILOT_RELEASE_LAG_TOLERANCE_MINOR: undefined,
    AUTOPILOT_LINEAR_DEDUP_ENABLED: undefined,
    AUTOPILOT_LINEAR_DEDUP_STATUSES: undefined,
    AUTOPILOT_INFLIGHT_DEDUP_ENABLED: undefined,
    AUTOPILOT_INFLIGHT_DEDUP_WINDOW_HOURS: undefined,
  });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('config interlock', () => {
  it('defaults verifyMode and pushMode to "disabled"', () => {
    const config = loadConfig();
    expect(config.verifyMode).toBe('disabled');
    expect(config.pushMode).toBe('disabled');
  });

  it('throws when pushMode=pr but verifyMode is not enforce', () => {
    setEnv({ AUTOPILOT_PUSH_MODE: 'pr', AUTOPILOT_VERIFY_MODE: 'log_only' });
    expect(() => loadConfig()).toThrowError(/AUTOPILOT_PUSH_MODE=pr requires AUTOPILOT_VERIFY_MODE=enforce/);
  });

  it('throws when pushMode=pr but verifyMode is disabled', () => {
    setEnv({ AUTOPILOT_PUSH_MODE: 'pr' });
    expect(() => loadConfig()).toThrowError(/AUTOPILOT_PUSH_MODE=pr requires AUTOPILOT_VERIFY_MODE=enforce/);
  });

  it('allows pushMode=pr when verifyMode=enforce AND github credentials present', () => {
    setEnv({
      AUTOPILOT_PUSH_MODE: 'pr',
      AUTOPILOT_VERIFY_MODE: 'enforce',
      GITHUB_TOKEN: 'ghp_FAKE_FOR_TEST',
      AUTOPILOT_REPO_FULL_NAME: 'mindstone/rebel-app',
    });
    const config = loadConfig();
    expect(config.pushMode).toBe('pr');
    expect(config.verifyMode).toBe('enforce');
    expect(config.githubToken).toBe('ghp_FAKE_FOR_TEST');
    expect(config.repoFullName).toBe('mindstone/rebel-app');
  });

  it('throws when pushMode=pr + verifyMode=enforce but GITHUB_TOKEN missing', () => {
    setEnv({
      AUTOPILOT_PUSH_MODE: 'pr',
      AUTOPILOT_VERIFY_MODE: 'enforce',
      AUTOPILOT_REPO_FULL_NAME: 'mindstone/rebel-app',
    });
    expect(() => loadConfig()).toThrowError(/GITHUB_TOKEN/);
  });

  it('throws when pushMode=pr + verifyMode=enforce but AUTOPILOT_REPO_FULL_NAME missing', () => {
    setEnv({
      AUTOPILOT_PUSH_MODE: 'pr',
      AUTOPILOT_VERIFY_MODE: 'enforce',
      GITHUB_TOKEN: 'ghp_FAKE_FOR_TEST',
    });
    expect(() => loadConfig()).toThrowError(/AUTOPILOT_REPO_FULL_NAME/);
  });

  it('rejects malformed AUTOPILOT_REPO_FULL_NAME values', () => {
    setEnv({
      AUTOPILOT_PUSH_MODE: 'pr',
      AUTOPILOT_VERIFY_MODE: 'enforce',
      GITHUB_TOKEN: 'ghp_FAKE_FOR_TEST',
      AUTOPILOT_REPO_FULL_NAME: 'no_slash_in_here',
    });
    expect(() => loadConfig()).toThrowError(/owner\/repo/);
  });

  it('does not require github credentials for pushMode=branch_only', () => {
    setEnv({
      AUTOPILOT_PUSH_MODE: 'branch_only',
      AUTOPILOT_VERIFY_MODE: 'enforce',
    });
    const config = loadConfig();
    expect(config.pushMode).toBe('branch_only');
    expect(config.githubToken).toBeUndefined();
    expect(config.repoFullName).toBeUndefined();
  });

  it('allows pushMode=branch_only with any verifyMode', () => {
    setEnv({ AUTOPILOT_PUSH_MODE: 'branch_only', AUTOPILOT_VERIFY_MODE: 'disabled' });
    expect(() => loadConfig()).not.toThrow();
  });

  it('rejects invalid verifyMode values', () => {
    setEnv({ AUTOPILOT_VERIFY_MODE: 'maybe' });
    expect(() => loadConfig()).toThrowError(/AUTOPILOT_VERIFY_MODE/);
  });

  it('rejects invalid pushMode values', () => {
    setEnv({ AUTOPILOT_PUSH_MODE: 'force' });
    expect(() => loadConfig()).toThrowError(/AUTOPILOT_PUSH_MODE/);
  });

  it('defaults pendingMode to "disabled"', () => {
    const config = loadConfig();
    expect(config.pendingMode).toBe('disabled');
  });

  it('accepts pendingMode "mirror" / "enforce"', () => {
    setEnv({ AUTOPILOT_PENDING_MODE: 'mirror' });
    expect(loadConfig().pendingMode).toBe('mirror');
    setEnv({ AUTOPILOT_PENDING_MODE: 'enforce' });
    expect(loadConfig().pendingMode).toBe('enforce');
  });

  it('rejects invalid pendingMode values', () => {
    setEnv({ AUTOPILOT_PENDING_MODE: 'maybe' });
    expect(() => loadConfig()).toThrowError(/AUTOPILOT_PENDING_MODE/);
  });

  it('defaults to the droid CLI when AUTOPILOT_CLI is unset', () => {
    const config = loadConfig();
    expect(config.cli).toBe('droid');
    expect(config.cursorModel).toBe('composer-2.5');
    expect(config.claudeModel).toBe('claude-opus-4-8');
  });

  it('loads Cursor CLI config with the default cursor model when CURSOR_API_KEY is set', () => {
    setEnv({ AUTOPILOT_CLI: 'cursor', CURSOR_API_KEY: 'fake-test-key' });

    const config = loadConfig();
    expect(config.cli).toBe('cursor');
    expect(config.cursorApiKey).toBe('fake-test-key');
    expect(config.cursorModel).toBe('composer-2.5');
  });

  it('requires CURSOR_API_KEY when AUTOPILOT_CLI is cursor', () => {
    setEnv({ AUTOPILOT_CLI: 'cursor' });

    expect(() => loadConfig()).toThrowError(/CURSOR_API_KEY/);
  });

  it('rejects invalid AUTOPILOT_CLI values', () => {
    setEnv({ AUTOPILOT_CLI: 'banana' });

    expect(() => loadConfig()).toThrowError(/AUTOPILOT_CLI/);
  });

  it('loads the configured Cursor model when provided', () => {
    setEnv({
      AUTOPILOT_CLI: 'cursor',
      CURSOR_API_KEY: 'fake-test-key',
      AUTOPILOT_CURSOR_MODEL: 'composer-pro',
    });

    const config = loadConfig();
    expect(config.cli).toBe('cursor');
    expect(config.cursorApiKey).toBe('fake-test-key');
    expect(config.cursorModel).toBe('composer-pro');
  });

  it('loads Claude CLI config with the default model when ANTHROPIC_API_KEY is set', () => {
    setEnv({ AUTOPILOT_CLI: 'claude', ANTHROPIC_API_KEY: 'fake-anthropic-test-key' });

    const config = loadConfig();
    expect(config.cli).toBe('claude');
    expect(config.anthropicApiKey).toBe('fake-anthropic-test-key');
    expect(config.claudeModel).toBe('claude-opus-4-8');
  });

  it('requires ANTHROPIC_API_KEY when AUTOPILOT_CLI is claude', () => {
    setEnv({ AUTOPILOT_CLI: 'claude' });

    expect(() => loadConfig()).toThrowError(/ANTHROPIC_API_KEY/);
  });

  it('loads the configured Claude model when provided', () => {
    setEnv({
      AUTOPILOT_CLI: 'claude',
      ANTHROPIC_API_KEY: 'fake-anthropic-test-key',
      AUTOPILOT_CLAUDE_MODEL: 'claude-sonnet-4-5',
    });

    const config = loadConfig();
    expect(config.cli).toBe('claude');
    expect(config.anthropicApiKey).toBe('fake-anthropic-test-key');
    expect(config.claudeModel).toBe('claude-sonnet-4-5');
  });

  it('still exposes anthropicApiKey on non-claude runs (droid uses it under the hood)', () => {
    // The Anthropic key may be present for the droid runner's use even when
    // claude isn't selected; loadConfig should surface it without forcing it
    // through an interlock. Mirrors how CURSOR_API_KEY is allowed on droid
    // runs without being required.
    setEnv({ ANTHROPIC_API_KEY: 'fake-anthropic-test-key' });

    const config = loadConfig();
    expect(config.cli).toBe('droid');
    expect(config.anthropicApiKey).toBe('fake-anthropic-test-key');
  });

  it('defaults targetSentryId to undefined when AUTOPILOT_TARGET_SENTRY_ID is unset', () => {
    expect(loadConfig().targetSentryId).toBeUndefined();
  });

  it('parses AUTOPILOT_TARGET_SENTRY_ID and exposes it on config', () => {
    setEnv({ AUTOPILOT_TARGET_SENTRY_ID: 'REBEL-1234' });
    expect(loadConfig().targetSentryId).toBe('REBEL-1234');
  });

  it('treats whitespace-only AUTOPILOT_TARGET_SENTRY_ID as unset', () => {
    setEnv({ AUTOPILOT_TARGET_SENTRY_ID: '   ' });
    expect(loadConfig().targetSentryId).toBeUndefined();
  });

  it('trims surrounding whitespace from AUTOPILOT_TARGET_SENTRY_ID', () => {
    setEnv({ AUTOPILOT_TARGET_SENTRY_ID: '  REBEL-9999  ' });
    expect(loadConfig().targetSentryId).toBe('REBEL-9999');
  });

  it('defaults the release gate to disabled with zero minor-version lag tolerance', () => {
    const config = loadConfig();
    expect(config.releaseGateEnabled).toBe(false);
    expect(config.releaseLagToleranceMinor).toBe(0);
  });

  it('parses AUTOPILOT_RELEASE_GATE_ENABLED and AUTOPILOT_RELEASE_LAG_TOLERANCE_MINOR', () => {
    setEnv({
      AUTOPILOT_RELEASE_GATE_ENABLED: 'true',
      AUTOPILOT_PENDING_MODE: 'enforce',
      AUTOPILOT_RELEASE_LAG_TOLERANCE_MINOR: '1',
    });

    const config = loadConfig();
    expect(config.releaseGateEnabled).toBe(true);
    expect(config.releaseLagToleranceMinor).toBe(1);
  });

  it('rejects release gate enabled when pendingMode is disabled', () => {
    setEnv({ AUTOPILOT_RELEASE_GATE_ENABLED: 'true', AUTOPILOT_PENDING_MODE: 'disabled' });

    expect(() => loadConfig()).toThrowError(
      'AUTOPILOT_RELEASE_GATE_ENABLED requires AUTOPILOT_PENDING_MODE=enforce — release-skip quiet Sentry comments are routed through the pending-actions queue; with pendingMode=disabled or mirror, the queue is enqueued but never drained, so the comment is never delivered. Set AUTOPILOT_PENDING_MODE=enforce or AUTOPILOT_RELEASE_GATE_ENABLED=false.',
    );
  });

  it('allows release gate enabled when pendingMode is enforce', () => {
    setEnv({ AUTOPILOT_RELEASE_GATE_ENABLED: 'true', AUTOPILOT_PENDING_MODE: 'enforce' });

    const config = loadConfig();

    expect(config.releaseGateEnabled).toBe(true);
    expect(config.pendingMode).toBe('enforce');
  });

  it('rejects invalid release gate flag values', () => {
    setEnv({ AUTOPILOT_RELEASE_GATE_ENABLED: 'enabled' });
    expect(() => loadConfig()).toThrowError(/AUTOPILOT_RELEASE_GATE_ENABLED/);
  });

  it('rejects negative release lag tolerance values', () => {
    setEnv({ AUTOPILOT_RELEASE_LAG_TOLERANCE_MINOR: '-1' });
    expect(() => loadConfig()).toThrowError(/AUTOPILOT_RELEASE_LAG_TOLERANCE_MINOR/);
  });

  it('defaults the Linear dedup gate to disabled with the done/cancelled/duplicate status set', () => {
    const config = loadConfig();
    expect(config.linearDedupEnabled).toBe(false);
    expect(config.linearDedupStatuses).toEqual(['Done', 'Cancelled', 'Duplicate']);
  });

  it('parses AUTOPILOT_LINEAR_DEDUP_ENABLED and AUTOPILOT_LINEAR_DEDUP_STATUSES', () => {
    setEnv({
      AUTOPILOT_LINEAR_DEDUP_ENABLED: 'true',
      AUTOPILOT_PENDING_MODE: 'enforce',
      AUTOPILOT_LINEAR_DEDUP_STATUSES: 'Done, Cancelled, Custom Status',
    });

    const config = loadConfig();
    expect(config.linearDedupEnabled).toBe(true);
    expect(config.linearDedupStatuses).toEqual(['Done', 'Cancelled', 'Custom Status']);
  });

  it('rejects Linear dedup enabled when pendingMode is disabled', () => {
    setEnv({ AUTOPILOT_LINEAR_DEDUP_ENABLED: 'true', AUTOPILOT_PENDING_MODE: 'disabled' });

    expect(() => loadConfig()).toThrowError(
      'AUTOPILOT_LINEAR_DEDUP_ENABLED requires AUTOPILOT_PENDING_MODE=enforce — linear-dedup quiet Sentry comments are routed through the pending-actions queue; with pendingMode=disabled or mirror, the queue is enqueued but never drained, so the comment is never delivered. Set AUTOPILOT_PENDING_MODE=enforce or AUTOPILOT_LINEAR_DEDUP_ENABLED=false.',
    );
  });

  it('rejects invalid Linear dedup flag values', () => {
    setEnv({ AUTOPILOT_LINEAR_DEDUP_ENABLED: 'enabled' });
    expect(() => loadConfig()).toThrowError(/AUTOPILOT_LINEAR_DEDUP_ENABLED/);
  });

  it('defaults in-flight dedup to disabled with a 6-hour lookback window', () => {
    const config = loadConfig();
    expect(config.inFlightDedupEnabled).toBe(false);
    expect(config.inFlightDedupWindowHours).toBe(6);
  });

  it('parses AUTOPILOT_INFLIGHT_DEDUP_ENABLED and AUTOPILOT_INFLIGHT_DEDUP_WINDOW_HOURS', () => {
    setEnv({
      AUTOPILOT_INFLIGHT_DEDUP_ENABLED: 'true',
      AUTOPILOT_INFLIGHT_DEDUP_WINDOW_HOURS: '12',
    });

    const config = loadConfig();
    expect(config.inFlightDedupEnabled).toBe(true);
    expect(config.inFlightDedupWindowHours).toBe(12);
  });

  it('rejects invalid in-flight dedup flag values', () => {
    setEnv({ AUTOPILOT_INFLIGHT_DEDUP_ENABLED: 'enabled' });
    expect(() => loadConfig()).toThrowError(/AUTOPILOT_INFLIGHT_DEDUP_ENABLED/);
  });

  it('rejects invalid in-flight dedup window values', () => {
    setEnv({ AUTOPILOT_INFLIGHT_DEDUP_WINDOW_HOURS: '0' });
    expect(() => loadConfig()).toThrowError(/AUTOPILOT_INFLIGHT_DEDUP_WINDOW_HOURS/);
  });
});
