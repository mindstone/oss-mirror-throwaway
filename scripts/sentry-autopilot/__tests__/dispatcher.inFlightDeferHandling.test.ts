import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import type { PolledIssue } from '../poller.ts';
import type { Reporter } from '../reporter.ts';
import { SessionManager } from '../session-manager.ts';
import { StateDB } from '../state.ts';

const mocks = vi.hoisted(() => ({
  pollSentry: vi.fn(),
  runTriageGates: vi.fn(),
  emitCounter: vi.fn(),
}));

vi.mock('../poller.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../poller.ts')>()),
  pollSentry: mocks.pollSentry,
}));

vi.mock('../triage/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../triage/index.ts')>()),
  runTriageGates: mocks.runTriageGates,
}));

vi.mock('../metrics.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../metrics.ts')>()),
  emitCounter: mocks.emitCounter,
}));

import { dispatchPendingIssues, triagePolledIssues } from '../dispatcher.ts';

const dirs: string[] = [];
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-inflight-defer-'));
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
    maxConcurrent: 2,
    maxHourly: 10,
    maxDaily: 100,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: REPO_ROOT,
    cli: 'droid',
    cursorModel: 'composer-2.5',
    claudeModel: 'claude-opus-4-8',
    inFlightDedupEnabled: true,
    inFlightDedupWindowHours: 6,
  };
}

function makeIssue(): PolledIssue {
  return {
    sentryId: 'SENTRY-INFLIGHT-DEFER',
    sentryUrl: 'https://sentry.io/issues/SENTRY-INFLIGHT-DEFER',
    title: 'In-flight defer fixture',
    errorType: 'exception',
    isUserReported: false,
    occurrences: 10,
    users: 4,
    level: 'error',
    firstSeen: '2026-06-07T00:00:00Z',
    lastSeen: '2026-06-07T00:00:00Z',
  };
}

let db: StateDB;
let config: AutopilotConfig;

beforeEach(() => {
  mocks.pollSentry.mockReset();
  mocks.runTriageGates.mockReset();
  mocks.emitCounter.mockReset();
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

describe('triagePolledIssues in-flight defer handling', () => {
  it('stores deferred status with structured reason, emits defer counter, and emits no queue side effects', async () => {
    const issue = makeIssue();
    const reason = 'inflight-dedup:fingerprint=deadbeefcafebabe:active=SENTRY-ACTIVE-1';
    mocks.pollSentry.mockResolvedValue([issue]);
    mocks.runTriageGates.mockResolvedValue({
      decision: 'defer',
      gate: 'inflight-dedup',
      reason,
    });
    const releaseSpy = vi.spyOn(StateDB.prototype, 'enqueueReleaseGateSkipComment');
    const linearSpy = vi.spyOn(StateDB.prototype, 'enqueueLinearDedupSkipComment');
    const stats = { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 };

    await triagePolledIssues(db, config, stats);

    const row = db.getIssue(issue.sentryId);
    expect(row?.status).toBe('deferred');
    expect(row?.last_error).toBe(reason);
    expect(stats).toMatchObject({ issuesFound: 1, issuesSkipped: 1, issuesDispatched: 0 });
    expect(db.getPendingActions(issue.sentryId)).toHaveLength(0);
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(linearSpy).not.toHaveBeenCalled();
    expect(mocks.emitCounter).toHaveBeenCalledWith('reporter.deferred.inflight_dedup', {
      fingerprint: 'deadbeefcafebabe',
      activeSentryId: 'SENTRY-ACTIVE-1',
    });
  });

  it('emits defer counter when dispatch-time SQL guard defers a pending row', async () => {
    const issue = makeIssue();
    const fingerprintHash = 'feedfacecafebeef';
    const activeSentryId = 'SENTRY-ACTIVE-2';
    db.upsertIssue({
      sentry_id: activeSentryId,
      sentry_url: `https://sentry.io/issues/${activeSentryId}`,
      title: 'Active blocker',
      status: 'dispatched',
      fingerprint_hash: fingerprintHash,
      worktree_slot: 0,
      tmux_session: 'sentry-active-2',
      max_retries: 2,
    });
    db.upsertIssue({
      sentry_id: issue.sentryId,
      sentry_url: issue.sentryUrl,
      title: issue.title,
      error_type: issue.errorType,
      is_user_reported: issue.isUserReported,
      occurrences: issue.occurrences,
      users: issue.users,
      status: 'pending',
      fingerprint_hash: fingerprintHash,
      max_retries: 2,
    });

    const sessionManager = new SessionManager(config, db);
    const reporter = { reportSessionStarted: vi.fn(async () => undefined) } as unknown as Reporter;
    const stats = { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 };

    await dispatchPendingIssues(
      db,
      config,
      sessionManager,
      reporter,
      stats,
      () => true,
      new Map(),
    );

    expect(stats).toMatchObject({ issuesDispatched: 0, issuesSkipped: 1 });
    expect(db.getIssue(issue.sentryId)?.status).toBe('deferred');
    expect(mocks.emitCounter).toHaveBeenCalledWith('reporter.deferred.inflight_dedup', {
      fingerprint: fingerprintHash,
      activeSentryId,
    });
    expect(reporter.reportSessionStarted).not.toHaveBeenCalled();
  });
});
