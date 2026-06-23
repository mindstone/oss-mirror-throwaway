import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import type { PolledIssue } from '../poller.ts';
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

import { triagePolledIssues } from '../dispatcher.ts';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-deferred-redispatch-'));
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
    maxHourly: 10,
    maxDaily: 100,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: '/tmp/repo',
    cli: 'droid',
    cursorModel: 'composer-2.5',
    claudeModel: 'claude-opus-4-8',
    inFlightDedupEnabled: true,
    inFlightDedupWindowHours: 6,
  };
}

function makeIssue(): PolledIssue {
  return {
    sentryId: 'SENTRY-DEFERRED-REDISPATCH',
    sentryUrl: 'https://sentry.io/issues/SENTRY-DEFERRED-REDISPATCH',
    title: 'Deferred redispatch fixture',
    errorType: 'exception',
    isUserReported: false,
    occurrences: 12,
    users: 5,
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

describe('deferred-row redispatch flow', () => {
  it('re-evaluates deferred rows and allows redispatch when gate passes', async () => {
    const issue = makeIssue();
    const fingerprintHash = 'deadbeefcafebabe';
    db.upsertIssue({
      sentry_id: issue.sentryId,
      sentry_url: issue.sentryUrl,
      title: issue.title,
      status: 'deferred',
      last_error: `inflight-dedup:fingerprint=${fingerprintHash}:active=SENTRY-BLOCKER`,
      max_retries: 2,
    });

    mocks.pollSentry.mockResolvedValue([issue]);
    mocks.runTriageGates.mockResolvedValue({
      decision: 'dispatch',
      gate: 'inflight-dedup',
      context: {
        fingerprint_hash: fingerprintHash,
      },
    });

    const dispatchPreparation = new Map<string, { fingerprintHash?: string }>();
    const stats = { issuesFound: 0, issuesDispatched: 0, issuesSkipped: 0, failures: 0 };
    await triagePolledIssues(db, config, stats, dispatchPreparation);

    const candidate = db.getPendingIssues().find((row) => row.sentry_id === issue.sentryId);
    expect(candidate?.status).toBe('deferred');
    expect(dispatchPreparation.get(issue.sentryId)?.fingerprintHash).toBe(fingerprintHash);

    const result = db.markDispatched(issue.sentryId, 0, 'sentry-SENTRY-DEFERRED-REDISPATCH', {
      fingerprintHash: dispatchPreparation.get(issue.sentryId)?.fingerprintHash,
      inFlightWindowHours: config.inFlightDedupWindowHours,
    });

    expect(result).toBe('dispatched');
    const updated = db.getIssue(issue.sentryId);
    expect(updated?.status).toBe('dispatched');
    expect(updated?.fingerprint_hash).toBe(fingerprintHash);
  });
});
