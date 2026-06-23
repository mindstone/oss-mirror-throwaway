import { describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { Reporter } from '../reporter.ts';

function makeConfig(): AutopilotConfig {
  return {
    sentryAuthToken: 'test-token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: undefined,
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    stateDir: '/tmp/sentry-autopilot-tests',
    maxConcurrent: 1,
    maxHourly: 1,
    maxDaily: 1,
    maxRetries: 1,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: '/tmp/repo',
    cli: 'droid',
    cursorModel: 'composer-2.5',
    claudeModel: 'claude-opus-4-8',
  };
}

describe('Reporter.reportPollerQueryFailure', () => {
  it('logs warn before Slack send and accepts unknown error values', async () => {
    const reporter = new Reporter(makeConfig());
    const sendSlack = vi.fn().mockRejectedValue(new Error('slack down'));
    const warn = vi.fn();

    (reporter as unknown as { sendSlack: typeof sendSlack }).sendSlack = sendSlack;
    (reporter as unknown as { log: { warn: typeof warn } }).log = { warn };

    await reporter.reportPollerQueryFailure('stale_cleanup', 'bad');

    expect(sendSlack).toHaveBeenCalledTimes(1);
    expect(sendSlack).toHaveBeenCalledWith({
      text: ':exclamation: Sentry autopilot poller query `stale_cleanup` failed: bad',
      log_discriminator: 'supervisor_fail',
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const [structured, message] = warn.mock.calls[0] ?? [];
    expect(structured).toMatchObject({
      name: 'stale_cleanup',
      error: 'bad',
      log_discriminator: 'supervisor_fail',
    });
    expect(typeof message).toBe('string');
    expect(message).toBe('Poller query stale_cleanup failed');
    expect(warn.mock.invocationCallOrder[0]).toBeLessThan(sendSlack.mock.invocationCallOrder[0]);
  });
});
