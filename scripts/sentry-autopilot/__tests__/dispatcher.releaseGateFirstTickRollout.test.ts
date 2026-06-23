import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { maybeReportReleaseGateRollout } from '../dispatcher.ts';
import type { Reporter } from '../reporter.ts';

let stateDir: string;

function makeConfig(overrides: Partial<AutopilotConfig> = {}): AutopilotConfig {
  return {
    sentryAuthToken: 'test-token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: undefined,
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    pendingMode: 'enforce',
    stateDir,
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
    releaseGateEnabled: true,
    releaseLagToleranceMinor: 1,
    ...overrides,
  };
}

function makeReporterMock(): {
  reporter: Reporter;
  reportReleaseGateEnabled: ReturnType<typeof vi.fn>;
} {
  const reportReleaseGateEnabled = vi.fn(async () => undefined);
  return {
    reporter: { reportReleaseGateEnabled } as unknown as Reporter,
    reportReleaseGateEnabled,
  };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-rollout-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('maybeReportReleaseGateRollout', () => {
  it('sends the first-tick Slack rollout message once when the gate is enabled', async () => {
    const { reporter, reportReleaseGateEnabled } = makeReporterMock();

    await maybeReportReleaseGateRollout(makeConfig(), reporter);

    expect(reportReleaseGateEnabled).toHaveBeenCalledTimes(1);
    expect(reportReleaseGateEnabled).toHaveBeenCalledWith(1);
    expect(fs.existsSync(path.join(stateDir, '.release_gate_rollout_notified'))).toBe(true);

    await maybeReportReleaseGateRollout(makeConfig(), reporter);

    expect(reportReleaseGateEnabled).toHaveBeenCalledTimes(1);
  });

  it('does not send when the release gate is disabled', async () => {
    const { reporter, reportReleaseGateEnabled } = makeReporterMock();

    await maybeReportReleaseGateRollout(makeConfig({ releaseGateEnabled: false }), reporter);

    expect(reportReleaseGateEnabled).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(stateDir, '.release_gate_rollout_notified'))).toBe(false);
  });
});
