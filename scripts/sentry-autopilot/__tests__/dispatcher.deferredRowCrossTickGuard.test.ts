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
}));

vi.mock('../poller.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../poller.ts')>()),
  pollSentry: mocks.pollSentry,
}));

vi.mock('../triage/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../triage/index.ts')>()),
  runTriageGates: mocks.runTriageGates,
}));

import { dispatchPendingIssues, triagePolledIssues } from '../dispatcher.ts';

const dirs: string[] = [];
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-deferred-cross-tick-guard-'));
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

function makeIssue(sentryId = 'SENTRY-DEFERRED-CROSS-TICK'): PolledIssue {
  return {
    sentryId,
    sentryUrl: `https://sentry.io/issues/${sentryId}`,
    title: 'Deferred cross-tick fixture',
    errorType: 'exception',
    isUserReported: false,
    occurrences: 8,
    users: 3,
    level: 'error',
    firstSeen: '2026-06-07T00:00:00Z',
    lastSeen: '2026-06-07T00:00:00Z',
  };
}

function seedActive(
  db: StateDB,
  sentryId: string,
  fingerprintHash: string,
): void {
  db.upsertIssue({
    sentry_id: sentryId,
    sentry_url: `https://sentry.io/issues/${sentryId}`,
    title: `Active ${sentryId}`,
    status: 'dispatched',
    fingerprint_hash: fingerprintHash,
    worktree_slot: 1,
    tmux_session: `sentry-${sentryId}`,
    max_retries: 2,
  });
}

let db: StateDB;
let config: AutopilotConfig;

beforeEach(() => {
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

describe('deferred row cross-tick in-flight guard', () => {
  it('does not dispatch a deferred row that pollSentry no longer returns when same-fingerprint blocker is still active', async () => {
    const fingerprintHash = 'abc123';
    const activeSentryId = 'SENTRY-ACTIVE-CROSS-TICK';
    const deferredIssue = makeIssue();

    seedActive(db, activeSentryId, fingerprintHash);
    db.upsertIssue({
      sentry_id: deferredIssue.sentryId,
      sentry_url: deferredIssue.sentryUrl,
      title: deferredIssue.title,
      error_type: deferredIssue.errorType,
      is_user_reported: deferredIssue.isUserReported,
      occurrences: deferredIssue.occurrences,
      users: deferredIssue.users,
      status: 'deferred',
      fingerprint_hash: fingerprintHash,
      max_retries: 2,
      last_error: `inflight-dedup:fingerprint=${fingerprintHash}:active=${activeSentryId}`,
    });

    const stats = { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 };
    mocks.pollSentry.mockResolvedValue([]);
    await triagePolledIssues(db, config, stats, new Map());

    const sessionManager = new SessionManager(config, db);
    const reporter = { reportSessionStarted: vi.fn(async () => undefined) } as unknown as Reporter;
    await dispatchPendingIssues(db, config, sessionManager, reporter, stats, () => true, new Map());

    const row = db.getIssue(deferredIssue.sentryId);
    expect(row?.status).toBe('deferred');
    expect(row?.last_error).toBe(`inflight-dedup:fingerprint=${fingerprintHash}:active=${activeSentryId}`);
    expect(stats.issuesDispatched).toBe(0);
  });

  it('persists gate fingerprint_hash on defer so cross-tick guard still blocks dispatch when pollSentry later returns no issues', async () => {
    const fingerprintHash = 'abc123';
    const activeSentryId = 'SENTRY-ACTIVE-PERSIST';
    const deferredIssue = makeIssue('SENTRY-DEFERRED-PERSIST');

    seedActive(db, activeSentryId, fingerprintHash);
    mocks.pollSentry.mockResolvedValue([deferredIssue]);
    mocks.runTriageGates.mockResolvedValue({
      decision: 'defer',
      gate: 'inflight-dedup',
      reason: `inflight-dedup:fingerprint=${fingerprintHash}:active=${activeSentryId}`,
      context: {
        fingerprint_hash: fingerprintHash,
      },
    });

    const stats = { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 };
    await triagePolledIssues(db, config, stats, new Map());
    expect(db.getIssue(deferredIssue.sentryId)?.fingerprint_hash).toBe(fingerprintHash);

    mocks.pollSentry.mockResolvedValue([]);
    await triagePolledIssues(db, config, stats, new Map());

    const sessionManager = new SessionManager(config, db);
    const reporter = { reportSessionStarted: vi.fn(async () => undefined) } as unknown as Reporter;
    await dispatchPendingIssues(db, config, sessionManager, reporter, stats, () => true, new Map());

    const row = db.getIssue(deferredIssue.sentryId);
    expect(row?.status).toBe('deferred');
    expect(row?.last_error).toBe(`inflight-dedup:fingerprint=${fingerprintHash}:active=${activeSentryId}`);
    expect(stats.issuesDispatched).toBe(0);
  });
});
