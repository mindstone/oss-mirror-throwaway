import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { PendingDrainer } from '../pending-drainer.ts';
import type { PolledIssue } from '../poller.ts';
import { Reporter } from '../reporter.ts';
import { StateDB } from '../state.ts';

const mocks = vi.hoisted(() => ({
  emitCounter: vi.fn(),
  errorLog: vi.fn(),
  pollSentry: vi.fn(),
  runTriageGates: vi.fn(),
}));

vi.mock('../metrics.ts', () => ({
  emitCounter: mocks.emitCounter,
  errorLog: mocks.errorLog,
}));

vi.mock('../poller.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../poller.ts')>()),
  pollSentry: mocks.pollSentry,
}));

vi.mock('../triage/index.ts', () => ({
  runTriageGates: mocks.runTriageGates,
}));

import { triagePolledIssues } from '../dispatcher.ts';

const dirs: string[] = [];
const releaseSkipReason = 'release-aware-skip:lag=1:current=v0.4.46:issue=v0.3.99';

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-release-gate-'));
  dirs.push(dir);
  return dir;
}

function makeConfig(stateDir: string): AutopilotConfig {
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
    releaseLagToleranceMinor: 0,
  };
}

function makeIssue(): PolledIssue {
  return {
    sentryId: 'SENTRY-RELEASE-SKIP',
    sentryUrl: 'https://sentry.io/issues/SENTRY-RELEASE-SKIP',
    title: 'Old release issue',
    errorType: 'exception',
    isUserReported: false,
    occurrences: 10,
    users: 3,
    level: 'error',
    firstSeen: '2026-06-07T00:00:00Z',
    lastSeen: '2026-06-07T00:00:00Z',
  };
}

let db: StateDB;
let config: AutopilotConfig;

beforeEach(() => {
  mocks.emitCounter.mockReset();
  mocks.errorLog.mockReset();
  mocks.pollSentry.mockReset();
  mocks.runTriageGates.mockReset();
  const stateDir = tmpDir();
  db = new StateDB(path.join(stateDir, 'state.db'));
  config = makeConfig(stateDir);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('triagePolledIssues release-gate skip handling', () => {
  it('marks release-gated skips as skipped and enqueues one idempotent quiet Sentry comment', async () => {
    const issue = makeIssue();
    mocks.pollSentry.mockResolvedValue([issue]);
    mocks.runTriageGates.mockResolvedValue({
      decision: 'skip',
      gate: 'release',
      reason: releaseSkipReason,
    });
    const enqueueSpy = vi.spyOn(StateDB.prototype, 'enqueueReleaseGateSkipComment');
    const stats = { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 };

    await triagePolledIssues(db, config, stats);

    const row = db.getIssue(issue.sentryId);
    expect(row?.status).toBe('skipped');
    expect(row?.last_error).toBe(releaseSkipReason);
    expect(stats).toMatchObject({ issuesFound: 1, issuesSkipped: 1 });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith(
      issue,
      "Autopilot: skipped — issue's last seen release (v0.3.99) predates the current monitored release (v0.4.46). Resolve manually if no longer relevant; if incorrect (e.g. issue still occurs on a newer release), no action needed — autopilot will re-evaluate when a fresh event arrives.",
      'sentry_comment:SENTRY-RELEASE-SKIP:release-gate-skip:v0.4.46-vs-v0.3.99',
    );
    expect(mocks.emitCounter).toHaveBeenCalledWith('reporter.skipped.release_lag', {
      currentRelease: 'v0.4.46',
      issueRelease: 'v0.3.99',
      lagSteps: 1,
    });

    const queue = db.getPendingActions(issue.sentryId);
    expect(queue).toHaveLength(1);
    expect(queue[0].kind).toBe('sentry_comment');
    expect(queue[0].idempotency_key).toBe(
      'sentry_comment:SENTRY-RELEASE-SKIP:release-gate-skip:v0.4.46-vs-v0.3.99',
    );
  });

  it('does not duplicate the quiet comment when the same release-gated skip reappears next tick', async () => {
    const issue = makeIssue();
    mocks.pollSentry.mockResolvedValue([issue]);
    mocks.runTriageGates.mockResolvedValue({
      decision: 'skip',
      gate: 'release',
      reason: releaseSkipReason,
    });

    await triagePolledIssues(db, config, { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 });
    db.upsertIssue({ sentry_id: issue.sentryId, status: 'pending' });
    await triagePolledIssues(db, config, { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 });

    expect(mocks.runTriageGates).toHaveBeenCalledTimes(2);
    const row = db.getIssue(issue.sentryId);
    expect(row?.status).toBe('skipped');
    expect(row?.last_error).toBe(releaseSkipReason);
    const queue = db.getPendingActions(issue.sentryId);
    expect(queue).toHaveLength(1);
    expect(queue[0].idempotency_key).toBe(
      'sentry_comment:SENTRY-RELEASE-SKIP:release-gate-skip:v0.4.46-vs-v0.3.99',
    );
  });

  it('does not re-post after the drainer empties the queue between consecutive ticks', async () => {
    const issue = makeIssue();
    const reporter = new Reporter(config);
    const drainer = new PendingDrainer(db, reporter, config);
    const executeSentryComment = vi.spyOn(reporter, 'executeSentryComment').mockResolvedValue(undefined);
    mocks.pollSentry.mockResolvedValue([issue]);
    mocks.runTriageGates.mockResolvedValue({
      decision: 'skip',
      gate: 'release',
      reason: releaseSkipReason,
    });

    await triagePolledIssues(db, config, { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 });
    await drainer.drainAll({ runId: 1 });
    expect(db.getPendingActions(issue.sentryId)).toHaveLength(0);

    db.upsertIssue({ sentry_id: issue.sentryId, status: 'pending' });
    await triagePolledIssues(db, config, { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 });
    await drainer.drainAll({ runId: 2 });

    expect(executeSentryComment).toHaveBeenCalledTimes(1);
    expect(db.getPendingActions(issue.sentryId)).toHaveLength(0);
  });

  it('posts again when the release-pair key changes', async () => {
    const issue = makeIssue();
    const reporter = new Reporter(config);
    const drainer = new PendingDrainer(db, reporter, config);
    const executeSentryComment = vi.spyOn(reporter, 'executeSentryComment').mockResolvedValue(undefined);
    mocks.pollSentry.mockResolvedValue([issue]);
    mocks.runTriageGates
      .mockResolvedValueOnce({
        decision: 'skip',
        gate: 'release',
        reason: releaseSkipReason,
      })
      .mockResolvedValueOnce({
        decision: 'skip',
        gate: 'release',
        reason: 'release-aware-skip:lag=1:current=v0.5.0:issue=v0.4.45',
      });

    await triagePolledIssues(db, config, { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 });
    await drainer.drainAll({ runId: 1 });

    db.upsertIssue({ sentry_id: issue.sentryId, status: 'pending' });
    await triagePolledIssues(db, config, { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 });
    await drainer.drainAll({ runId: 2 });

    expect(executeSentryComment).toHaveBeenCalledTimes(2);
    expect(db.getIssue(issue.sentryId)?.last_release_skip_comment_key).toBe(
      'sentry_comment:SENTRY-RELEASE-SKIP:release-gate-skip:v0.5.0-vs-v0.4.45',
    );
  });

  it('marks Linear-dedup skips as skipped and enqueues one idempotent quiet Sentry comment', async () => {
    const issue = makeIssue();
    mocks.pollSentry.mockResolvedValue([issue]);
    mocks.runTriageGates.mockResolvedValue({
      decision: 'skip',
      gate: 'linear-dedup',
      reason: 'linear-already-fixed:REBEL-123',
      metadata: {
        matchedLinearId: 'REBEL-123',
        matchedLinearStatus: 'Done',
      },
    });
    const enqueueSpy = vi.spyOn(StateDB.prototype, 'enqueueLinearDedupSkipComment');
    const stats = { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 };

    await triagePolledIssues(db, config, stats);

    const row = db.getIssue(issue.sentryId);
    expect(row?.status).toBe('skipped');
    expect(row?.last_error).toBe('linear-already-fixed:REBEL-123');
    expect(stats).toMatchObject({ issuesFound: 1, issuesSkipped: 1 });
    expect(enqueueSpy).toHaveBeenCalledWith(
      issue,
      'Autopilot: skipped — matches Linear ticket REBEL-123 (status=Done). If incorrect, reopen REBEL-123 or unlink. Autopilot will re-evaluate when a fresh event arrives.',
      'sentry_comment:SENTRY-RELEASE-SKIP:linear-dedup:REBEL-123',
    );
    expect(mocks.emitCounter).toHaveBeenCalledWith('reporter.skipped.linear_dedup', {
      sentryId: 'SENTRY-RELEASE-SKIP',
      linearId: 'REBEL-123',
    });

    const queue = db.getPendingActions(issue.sentryId);
    expect(queue).toHaveLength(1);
    expect(queue[0].kind).toBe('sentry_comment');
    expect(queue[0].idempotency_key).toBe('sentry_comment:SENTRY-RELEASE-SKIP:linear-dedup:REBEL-123');
  });

  it('does not re-post the Linear-dedup skip comment after the drainer empties the queue between consecutive ticks', async () => {
    const issue = makeIssue();
    const reporter = new Reporter(config);
    const drainer = new PendingDrainer(db, reporter, config);
    const executeSentryComment = vi.spyOn(reporter, 'executeSentryComment').mockResolvedValue(undefined);
    mocks.pollSentry.mockResolvedValue([issue]);
    mocks.runTriageGates.mockResolvedValue({
      decision: 'skip',
      gate: 'linear-dedup',
      reason: 'linear-already-fixed:REBEL-5RT',
      metadata: {
        matchedLinearId: 'REBEL-5RT',
        matchedLinearStatus: 'Done',
      },
    });
    const stats = { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 };

    await triagePolledIssues(db, config, stats);
    await drainer.drainAll({ runId: 1 });
    expect(db.getPendingActions(issue.sentryId)).toHaveLength(0);

    db.upsertIssue({ sentry_id: issue.sentryId, status: 'pending' });
    await triagePolledIssues(db, config, stats);
    await drainer.drainAll({ runId: 2 });

    expect(executeSentryComment).toHaveBeenCalledTimes(1);
    expect(db.getPendingActions(issue.sentryId)).toHaveLength(0);
    expect(db.getIssue(issue.sentryId)?.last_linear_dedup_comment_key).toBe(
      'sentry_comment:SENTRY-RELEASE-SKIP:linear-dedup:REBEL-5RT',
    );
  });

  it('posts the Linear-dedup skip comment again when the matched ticket changes', async () => {
    const issue = makeIssue();
    const reporter = new Reporter(config);
    const drainer = new PendingDrainer(db, reporter, config);
    const executeSentryComment = vi.spyOn(reporter, 'executeSentryComment').mockResolvedValue(undefined);
    mocks.pollSentry.mockResolvedValue([issue]);
    mocks.runTriageGates
      .mockResolvedValueOnce({
        decision: 'skip',
        gate: 'linear-dedup',
        reason: 'linear-already-fixed:REBEL-5RT',
        metadata: {
          matchedLinearId: 'REBEL-5RT',
          matchedLinearStatus: 'Done',
        },
      })
      .mockResolvedValueOnce({
        decision: 'skip',
        gate: 'linear-dedup',
        reason: 'linear-fingerprint-match:abc123:REBEL-9XY',
        metadata: {
          matchedLinearId: 'REBEL-9XY',
          matchedLinearStatus: 'Done',
          fingerprint: 'abc123',
        },
      });
    const stats = { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 };

    await triagePolledIssues(db, config, stats);
    await drainer.drainAll({ runId: 1 });

    db.upsertIssue({ sentry_id: issue.sentryId, status: 'pending' });
    await triagePolledIssues(db, config, stats);
    await drainer.drainAll({ runId: 2 });

    expect(executeSentryComment).toHaveBeenCalledTimes(2);
    expect(mocks.emitCounter).toHaveBeenCalledWith('reporter.skipped.linear_dedup', {
      sentryId: 'SENTRY-RELEASE-SKIP',
      linearId: 'REBEL-9XY',
      fingerprint: 'abc123',
    });
    expect(db.getIssue(issue.sentryId)?.last_linear_dedup_comment_key).toBe(
      'sentry_comment:SENTRY-RELEASE-SKIP:linear-dedup:REBEL-9XY',
    );
  });
});
