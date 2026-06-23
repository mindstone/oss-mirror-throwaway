import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { Reporter } from '../reporter.ts';

function makeConfig(): AutopilotConfig {
  return {
    sentryAuthToken: 'token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: 'https://slack.example/webhook',
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    pendingMode: 'enforce',
    stateDir: '/tmp/sentry-autopilot',
    maxConcurrent: 1,
    maxHourly: 1,
    maxDaily: 1,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: '/tmp/repo',
    cli: 'droid',
    cursorModel: 'composer-2.5',
    claudeModel: 'claude-opus-4-8',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Reporter.reportReleaseGateEnabled', () => {
  it('posts rollout copy that matches the release-gate delivery model', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new Reporter(makeConfig()).reportReleaseGateEnabled(2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Autopilot: release-aware triage filter is now enabled (lag tolerance: 2 minor versions; requires AUTOPILOT_PENDING_MODE=enforce). Issues whose last seen release predates the current monitored release will be skipped with one quiet Sentry comment per (issue, release-pair). If you didn't expect this behavioural change, see plan 260607_autopilot-triage-hardening.",
    });
  });
});
