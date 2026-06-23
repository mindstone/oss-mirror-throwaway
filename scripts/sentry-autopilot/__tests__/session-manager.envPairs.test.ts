/**
 * Stage 1 regression test for autopilot-claude-runtime-fixes.
 *
 * Background
 * ----------
 * The bug-fixer subprocess inherits its env from tmux, not from the cron
 * shell that ran `dispatcher.ts`. The long-running tmux server on
 * `team-cloud` was started months before `SENTRY_AUTH_TOKEN` was added to
 * `~/autopilot.env`, so its global env doesn't carry the token. Inline
 * `env KEY=val …` pairs in the spawned command are therefore the only
 * reliable propagation path.
 *
 * Symptom this guards against: claude shadow-mode runs escalated with the
 * diagnosis "no SENTRY_AUTH_TOKEN exists in the supervisor process
 * environment, so the REST fallback cannot run." Droid mode worked around
 * this by auto-loading `~/.config/droid/env`; claude has no equivalent.
 *
 * What this test asserts
 * ----------------------
 * `buildSpawnTmuxCommand()` includes an explicit `SENTRY_AUTH_TOKEN=…` pair
 * when the config carries the token, and omits it when the token is empty
 * (mirrors the existing CURSOR_API_KEY / ANTHROPIC_API_KEY guard pattern).
 */

import { describe, expect, it } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { buildSpawnTmuxCommand } from '../session-manager.ts';

function makeConfig(overrides: Partial<AutopilotConfig> = {}): AutopilotConfig {
  return {
    sentryAuthToken: 'test-sentry-token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: undefined,
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    pendingMode: 'disabled',
    stateDir: '/tmp/test-state',
    maxConcurrent: 1,
    maxHourly: 1,
    maxDaily: 1,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: '/tmp/test-repo',
    cli: 'claude',
    cursorModel: 'composer-2.5',
    claudeModel: 'claude-opus-4-8',
    ...overrides,
  };
}

const COMMON_ARGS = {
  worktreePath: '/tmp/test-state/worktrees/slot-0',
  sentryId: '7521700556',
  promptFile: '/tmp/test-state/artifacts/7521700556/prompt.md',
  artifactDir: '/tmp/test-state/artifacts/7521700556',
  supervisorScript: '/tmp/test-repo/scripts/sentry-autopilot/session-supervisor.sh',
};

describe('buildSpawnTmuxCommand — env-pair propagation', () => {
  it('includes SENTRY_AUTH_TOKEN when the config carries it', () => {
    const command = buildSpawnTmuxCommand({
      config: makeConfig({ sentryAuthToken: 'sntrys-real-token-value' }),
      ...COMMON_ARGS,
    });

    expect(command).toContain("SENTRY_AUTH_TOKEN='sntrys-real-token-value'");
    // Sanity: the existing pairs are still emitted so the new push didn't
    // accidentally replace prior keys.
    expect(command).toContain("AUTOPILOT_CLI='claude'");
    expect(command).toContain("AUTOPILOT_CLAUDE_MODEL='claude-opus-4-8'");
  });

  it('omits SENTRY_AUTH_TOKEN when the config carries an empty token', () => {
    // The runtime config requires the token (loadConfig fail-fasts) but the
    // helper is defensive: an empty value should not emit a `KEY=` pair, the
    // same pattern as cursorApiKey / anthropicApiKey.
    const command = buildSpawnTmuxCommand({
      config: makeConfig({ sentryAuthToken: '' as unknown as string }),
      ...COMMON_ARGS,
    });

    expect(command).not.toContain('SENTRY_AUTH_TOKEN=');
  });

  it('passes ANTHROPIC_API_KEY only when set (claude mode)', () => {
    // Neutral synthetic token (no real-key prefix shape) to keep the
    // pre-push test-token drift gate happy. The shape of the token does not
    // matter for envPair construction — we only check string passthrough.
    const fakeAnthropicKey = 'fake-anthropic-test-key';
    const withKey = buildSpawnTmuxCommand({
      config: makeConfig({ anthropicApiKey: fakeAnthropicKey }),
      ...COMMON_ARGS,
    });
    const withoutKey = buildSpawnTmuxCommand({
      config: makeConfig({ anthropicApiKey: undefined }),
      ...COMMON_ARGS,
    });

    expect(withKey).toContain(`ANTHROPIC_API_KEY='${fakeAnthropicKey}'`);
    expect(withoutKey).not.toContain('ANTHROPIC_API_KEY=');
  });

  it('positions env pairs before bash invocation (env KEY=val bash …)', () => {
    const command = buildSpawnTmuxCommand({
      config: makeConfig({ sentryAuthToken: 'tok' }),
      ...COMMON_ARGS,
    });

    const tokenPos = command.indexOf("SENTRY_AUTH_TOKEN='tok'");
    const bashPos = command.indexOf(' bash ');
    expect(tokenPos).toBeGreaterThan(0);
    expect(bashPos).toBeGreaterThan(tokenPos);
  });

  it('shell-quotes single-quoted token values to defend against injection', () => {
    const command = buildSpawnTmuxCommand({
      config: makeConfig({ sentryAuthToken: "evil'; rm -rf /" }),
      ...COMMON_ARGS,
    });

    // Single quotes inside the value get escaped to '\'' so the shell parses
    // a single string literal. The naive `'evil'; rm -rf /'` would close the
    // quote and inject a command — the escaping prevents that.
    expect(command).toContain("SENTRY_AUTH_TOKEN='evil'\\''; rm -rf /'");
  });
});
