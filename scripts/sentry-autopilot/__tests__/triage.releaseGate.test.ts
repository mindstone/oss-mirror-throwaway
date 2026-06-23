import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import type { PolledIssue } from '../poller.ts';

const mocks = vi.hoisted(() => ({
  fetchIssueDetail: vi.fn(),
  getCurrentRelease: vi.fn(),
}));

vi.mock('../sentryRest.ts', () => ({
  fetchIssueDetail: mocks.fetchIssueDetail,
}));

vi.mock('../triage/currentRelease.ts', () => ({
  getCurrentRelease: mocks.getCurrentRelease,
}));

import { releaseGate } from '../triage/releaseGate.ts';

function makeConfig(overrides: Partial<AutopilotConfig> = {}): AutopilotConfig {
  return {
    sentryAuthToken: 'token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: undefined,
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
    releaseGateEnabled: true,
    releaseLagToleranceMinor: 0,
    ...overrides,
  };
}

function makeIssue(overrides: Partial<PolledIssue> = {}): PolledIssue {
  return {
    sentryId: 'SENTRY-RELEASE',
    sentryUrl: 'https://sentry.io/issues/SENTRY-RELEASE',
    title: 'Release-gated issue',
    errorType: 'exception',
    isUserReported: false,
    occurrences: 10,
    users: 3,
    level: 'error',
    firstSeen: '2026-06-07T00:00:00Z',
    lastSeen: '2026-06-07T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.fetchIssueDetail.mockReset();
  mocks.getCurrentRelease.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('releaseGate', () => {
  it('passes without fetching when the release gate flag is disabled', async () => {
    const result = await releaseGate(makeIssue(), { config: makeConfig({ releaseGateEnabled: false }) });

    expect(result).toEqual({ decision: 'dispatch' });
    expect(mocks.getCurrentRelease).not.toHaveBeenCalled();
    expect(mocks.fetchIssueDetail).not.toHaveBeenCalled();
  });

  it('fails open and logs a structured warning when current release is null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.getCurrentRelease.mockResolvedValue(null);

    const result = await releaseGate(makeIssue(), { config: makeConfig() });

    expect(result).toEqual({ decision: 'dispatch' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"gate":"release"'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"fail_reason":"current_release_unparseable"'),
    );
    expect(mocks.fetchIssueDetail).not.toHaveBeenCalled();
  });

  it('fails open and logs a structured warning when issue detail fetch throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.getCurrentRelease.mockResolvedValue('v0.4.46');
    mocks.fetchIssueDetail.mockRejectedValue(new Error('Sentry API request timed out'));

    const result = await releaseGate(makeIssue(), { config: makeConfig() });

    expect(result).toEqual({ decision: 'dispatch' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"gate":"release"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"fail_reason":"issue_detail_fetch_failed"'));
  });

  it('passes when lastRelease is from the same major.minor line as current release', async () => {
    mocks.getCurrentRelease.mockResolvedValue('v0.4.46');
    mocks.fetchIssueDetail.mockResolvedValue({ lastRelease: { shortVersion: '0.4.43' } });

    const result = await releaseGate(makeIssue(), { config: makeConfig() });

    expect(result).toEqual({ decision: 'dispatch' });
  });

  it('skips when lastRelease is one minor behind and tolerance is zero', async () => {
    mocks.getCurrentRelease.mockResolvedValue('v0.4.46');
    mocks.fetchIssueDetail.mockResolvedValue({ lastRelease: { version: 'v0.3.99' } });

    const result = await releaseGate(makeIssue(), { config: makeConfig({ releaseLagToleranceMinor: 0 }) });

    expect(result).toEqual({
      decision: 'skip',
      gate: 'release',
      reason: 'release-aware-skip:lag=1:current=v0.4.46:issue=v0.3.99',
    });
  });

  it('passes when lastRelease is one minor behind and tolerance is one', async () => {
    mocks.getCurrentRelease.mockResolvedValue('v0.4.46');
    mocks.fetchIssueDetail.mockResolvedValue({ lastRelease: { version: 'v0.3.99' } });

    const result = await releaseGate(makeIssue(), { config: makeConfig({ releaseLagToleranceMinor: 1 }) });

    expect(result).toEqual({ decision: 'dispatch' });
  });

  it('fails open when lastRelease is unparseable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.getCurrentRelease.mockResolvedValue('v0.4.46');
    mocks.fetchIssueDetail.mockResolvedValue({ lastRelease: { shortVersion: 'banana' } });

    const result = await releaseGate(makeIssue(), { config: makeConfig() });

    expect(result).toEqual({ decision: 'dispatch' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"fail_reason":"issue_release_unparseable"'));
  });

  it('uses firstRelease when lastRelease is missing and firstRelease is parseable', async () => {
    mocks.getCurrentRelease.mockResolvedValue('v0.4.46');
    mocks.fetchIssueDetail.mockResolvedValue({ firstRelease: { version: 'v0.3.10' } });

    const result = await releaseGate(makeIssue(), { config: makeConfig() });

    expect(result).toEqual({
      decision: 'skip',
      gate: 'release',
      reason: 'release-aware-skip:lag=1:current=v0.4.46:issue=v0.3.10',
    });
  });

  it('uses firstRelease when lastRelease is present but unparseable', async () => {
    mocks.getCurrentRelease.mockResolvedValue('v0.4.46');
    mocks.fetchIssueDetail.mockResolvedValue({
      lastRelease: { shortVersion: 'banana' },
      firstRelease: { version: 'v0.3.10' },
    });

    const result = await releaseGate(makeIssue(), { config: makeConfig() });

    expect(result).toEqual({
      decision: 'skip',
      gate: 'release',
      reason: 'release-aware-skip:lag=1:current=v0.4.46:issue=v0.3.10',
    });
  });

  it('fails open when both lastRelease and firstRelease are missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.getCurrentRelease.mockResolvedValue('v0.4.46');
    mocks.fetchIssueDetail.mockResolvedValue({});

    const result = await releaseGate(makeIssue(), { config: makeConfig() });

    expect(result).toEqual({ decision: 'dispatch' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"fail_reason":"issue_release_unparseable"'));
  });

  it('prefers lastRelease when both lastRelease and firstRelease are parseable', async () => {
    mocks.getCurrentRelease.mockResolvedValue('v0.4.46');
    mocks.fetchIssueDetail.mockResolvedValue({
      lastRelease: { version: 'v0.4.44' },
      firstRelease: { version: 'v0.3.10' },
    });

    const result = await releaseGate(makeIssue(), { config: makeConfig() });

    expect(result).toEqual({ decision: 'dispatch' });
  });

  it('passes when lastRelease is newer than current release', async () => {
    mocks.getCurrentRelease.mockResolvedValue('v0.4.46');
    mocks.fetchIssueDetail.mockResolvedValue({ lastRelease: { version: 'v0.5.0' } });

    const result = await releaseGate(makeIssue(), { config: makeConfig() });

    expect(result).toEqual({ decision: 'dispatch' });
  });
});
