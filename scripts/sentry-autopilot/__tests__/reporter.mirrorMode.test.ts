/**
 * Stage C — mirror-mode shadow test.
 *
 * `pendingMode='mirror'` produces the same observable side effects as
 * `pendingMode='disabled'` (legacy inline reporter still fires) PLUS a
 * row-level `pending_actions` shadow that captures what the drainer would
 * have done. The dispatcher's start-of-tick `reconcileAll()` then prunes
 * mirrored actions whose probes confirm "already done".
 *
 * Q4 from the planning doc — mirror-mode reconcile divergence allowlist:
 * `slack_*`, `sentry_comment`, and `linear_comment_existing` have no
 * external idempotency probe, so they always show up as `divergent` in
 * mirror mode. That's expected and documented here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { PendingDrainer } from '../pending-drainer.ts';
import { planActions, Reporter } from '../reporter.ts';
import type { SessionOutcome } from '../session-manager.ts';
import { StateDB } from '../state.ts';
import type { VerificationResult } from '../verifier.ts';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-mirror-'));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(stateDir: string): AutopilotConfig {
  return {
    sentryAuthToken: 'token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: 'lin-key',
    slackWebhook: 'https://slack.example/webhook',
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    pendingMode: 'mirror',
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
  };
}

describe('Reporter mirror mode (Stage C)', () => {
  let config: AutopilotConfig;
  let db: StateDB;
  let reporter: Reporter;
  let drainer: PendingDrainer;

  beforeEach(() => {
    config = makeConfig(tempDir());
    fs.mkdirSync(config.stateDir, { recursive: true });
    db = new StateDB(path.join(config.stateDir, 'state.db'));
    reporter = new Reporter(config);
    drainer = new PendingDrainer(db, reporter, config);
    db.upsertIssue({
      sentry_id: 'SENTRY-MIRROR',
      sentry_url: 'https://sentry.io/issues/SENTRY-MIRROR',
      title: 'mirror-mode fixture',
      status: 'completed',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('writes the shadow queue when planActions emits actions', () => {
    const issue = db.getIssue('SENTRY-MIRROR');
    if (!issue) throw new Error('issue missing');
    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 80,
      plan_file: 'plan.md',
      root_cause: 'something broke',
      is_bug: true,
    };
    const verification: VerificationResult = { status: 'skipped', details: [], metrics: {} };
    const planned = planActions({ issue, outcome, verification, config });
    db.markCompleted('SENTRY-MIRROR', 'plan_created', 80, undefined, 'plan.md', {}, planned);

    const queue = db.getPendingActions('SENTRY-MIRROR');
    expect(queue.map((a) => a.kind)).toEqual([
      'linear_create_issue',
      'sentry_comment',
      'slack_outcome',
    ]);
  });

  it('reconcileIssue prunes only actions with an external probe; rest are divergent (Q4 allowlist)', async () => {
    const issue = db.getIssue('SENTRY-MIRROR');
    if (!issue) throw new Error('issue missing');
    const outcome: SessionOutcome = {
      outcome: 'auto_committed',
      confidence: 95,
      commit_hash: 'abc1234',
      root_cause: 'fix',
    };
    const verification: VerificationResult = { status: 'pass', details: [], metrics: {} };
    const planned = planActions({ issue, outcome, verification, config });
    db.markCompleted('SENTRY-MIRROR', 'auto_committed', 95, 'abc1234', undefined, {}, planned);

    // Sentry status probe: legacy inline reporter has already marked the
    // issue resolved → mirror should prune sentry_status.
    vi.spyOn(reporter, 'probeSentryStatus').mockResolvedValue('resolved');
    // No execute spies — reconcile must never invoke executors.
    const statusExec = vi.spyOn(reporter, 'executeSentryStatus').mockResolvedValue(undefined);
    const commentExec = vi.spyOn(reporter, 'executeSentryComment').mockResolvedValue(undefined);
    const slackExec = vi.spyOn(reporter, 'executeSlackMessage').mockResolvedValue(undefined);

    const stats = await drainer.reconcileIssue(issue);
    expect(statusExec).not.toHaveBeenCalled();
    expect(commentExec).not.toHaveBeenCalled();
    expect(slackExec).not.toHaveBeenCalled();
    expect(stats.pruned).toBe(1); // sentry_status
    expect(stats.divergent).toBe(2); // sentry_comment + slack_outcome (no external probe)

    const remaining = db.getPendingActions('SENTRY-MIRROR');
    expect(remaining.map((a) => a.kind)).toEqual(['sentry_comment', 'slack_outcome']);
  });
});
