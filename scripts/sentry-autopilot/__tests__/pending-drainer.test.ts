/**
 * Stage C — pending-drainer tests.
 *
 * Critical invariants under test:
 *   - `drainAll` / `drainIssue` probe → execute → remove (or
 *     `recordPendingAttempt` on failure).
 *   - `reconcileAll` / `reconcileIssue` NEVER invoke executors — strictly
 *     observational. This is the load-bearing guarantee that keeps
 *     `pendingMode='mirror'` safe alongside the legacy inline reporter.
 *   - Probes that report "already done" prune the action without firing
 *     the executor (idempotency invariant).
 *   - Aggregate-failure escalation writes the marker file + escalations
 *     row when any action exhausts retries.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { MAX_ATTEMPTS_PER_ACTION, type PendingAction } from '../pending-actions.ts';
import { PendingDrainer } from '../pending-drainer.ts';
import { Reporter } from '../reporter.ts';
import { StateDB } from '../state.ts';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-pending-drainer-'));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(stateDir = tempDir()): AutopilotConfig {
  return {
    sentryAuthToken: 'token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: 'lin-key',
    slackWebhook: 'https://slack.example/webhook',
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
  };
}

function action(
  kind: PendingAction['kind'],
  idempotencyKey: string,
  payload: PendingAction['payload'],
  overrides: Partial<PendingAction> = {},
): PendingAction {
  return {
    kind,
    payload,
    idempotency_key: idempotencyKey,
    attempts: 0,
    last_error: null,
    created_at: '2026-05-15T00:00:00.000Z',
    ...overrides,
  } as PendingAction;
}

function setupReporter(config: AutopilotConfig): Reporter {
  return new Reporter(config);
}

function freshDb(config: AutopilotConfig): StateDB {
  return new StateDB(path.join(config.stateDir, 'state.db'));
}

function seedIssue(db: StateDB, sentryId = 'SENTRY-DRAIN'): void {
  db.upsertIssue({
    sentry_id: sentryId,
    sentry_url: `https://sentry.io/issues/${sentryId}`,
    title: 'drainer fixture',
    status: 'completed',
  });
}

describe('PendingDrainer — drainIssue / drainAll', () => {
  let config: AutopilotConfig;
  let db: StateDB;
  let reporter: Reporter;
  let drainer: PendingDrainer;

  beforeEach(() => {
    config = makeConfig();
    fs.mkdirSync(config.stateDir, { recursive: true });
    db = freshDb(config);
    reporter = setupReporter(config);
    drainer = new PendingDrainer(db, reporter, config);
    seedIssue(db);
    // Silence reporter logs in tests.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('drainIssue invokes the matching executor and removes on success', async () => {
    const queue: PendingAction[] = [
      action('slack_outcome', 'slack_outcome:foo', { text: 'hello' }),
    ];
    db.markCompleted('SENTRY-DRAIN', 'plan_created', 80, undefined, 'plan.md', {}, queue);
    const execSpy = vi.spyOn(reporter, 'executeSlackMessage').mockResolvedValue(undefined);

    const issue = db.getIssue('SENTRY-DRAIN');
    if (!issue) throw new Error('issue missing');
    const stats = await drainer.drainIssue(issue);

    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(stats.drained).toBe(1);
    expect(db.getPendingActions('SENTRY-DRAIN')).toEqual([]);
  });

  it('drainIssue records a retry attempt when the executor throws', async () => {
    const queue: PendingAction[] = [
      action('slack_outcome', 'slack_outcome:bar', { text: 'hello' }),
    ];
    db.markCompleted('SENTRY-DRAIN', 'plan_created', 80, undefined, 'plan.md', {}, queue);
    vi.spyOn(reporter, 'executeSlackMessage').mockRejectedValue(new Error('slack 500'));

    const issue = db.getIssue('SENTRY-DRAIN');
    if (!issue) throw new Error('issue missing');
    const stats = await drainer.drainIssue(issue);

    expect(stats.retry).toBe(1);
    expect(stats.drained).toBe(0);
    const remaining = db.getPendingActions('SENTRY-DRAIN');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].attempts).toBe(1);
    expect(remaining[0].last_error).toBe('slack 500');
  });

  it('drainIssue prunes actions whose probe reports already-done (sentry_status case)', async () => {
    const queue: PendingAction[] = [
      action('sentry_status', 'sentry_status:SENTRY-DRAIN:resolved', { status: 'resolved' }),
    ];
    db.markCompleted('SENTRY-DRAIN', 'auto_committed', 95, 'abc', undefined, {}, queue);
    const probeSpy = vi.spyOn(reporter, 'probeSentryStatus').mockResolvedValue('resolved');
    const execSpy = vi.spyOn(reporter, 'executeSentryStatus').mockResolvedValue(undefined);

    const issue = db.getIssue('SENTRY-DRAIN');
    if (!issue) throw new Error('issue missing');
    const stats = await drainer.drainIssue(issue);

    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(execSpy).not.toHaveBeenCalled();
    expect(stats.probe_skipped).toBe(1);
    expect(db.getPendingActions('SENTRY-DRAIN')).toEqual([]);
  });

  it('drainAll counts permanently_failed actions and records an escalation marker', async () => {
    const queue: PendingAction[] = [
      action('slack_outcome', 'slack_outcome:perma', { text: 'hi' }, {
        attempts: MAX_ATTEMPTS_PER_ACTION - 1,
      }),
    ];
    db.markCompleted('SENTRY-DRAIN', 'plan_created', 80, undefined, 'plan.md', {}, queue);
    vi.spyOn(reporter, 'executeSlackMessage').mockRejectedValue(new Error('slack down'));

    const stats = await drainer.drainAll({ runId: 42 });
    expect(stats.permanently_failed).toBe(1);
    expect(fs.existsSync(path.join(config.stateDir, 'ESCALATION-42'))).toBe(true);
    expect(db.listUnacknowledgedEscalations()).toHaveLength(1);
  });

  it('drainIssue sorts by ACTION_DRAIN_ORDER (sentry_status → sentry_comment → slack_outcome)', async () => {
    // Insert in deliberately reversed order; the drainer must execute in
    // canonical drain order regardless.
    const queue: PendingAction[] = [
      action('slack_outcome', 'slack_outcome:o1', { text: 'last' }),
      action('sentry_comment', 'sentry_comment:o2', { text: 'middle' }),
      action('sentry_status', 'sentry_status:SENTRY-DRAIN:resolved', { status: 'resolved' }),
    ];
    db.markCompleted('SENTRY-DRAIN', 'auto_committed', 95, 'abc', undefined, {}, queue);

    const order: string[] = [];
    vi.spyOn(reporter, 'probeSentryStatus').mockResolvedValue('unresolved');
    vi.spyOn(reporter, 'executeSentryStatus').mockImplementation(async () => {
      order.push('sentry_status');
    });
    vi.spyOn(reporter, 'executeSentryComment').mockImplementation(async () => {
      order.push('sentry_comment');
    });
    vi.spyOn(reporter, 'executeSlackMessage').mockImplementation(async () => {
      order.push('slack_outcome');
    });

    const issue = db.getIssue('SENTRY-DRAIN');
    if (!issue) throw new Error('issue missing');
    await drainer.drainIssue(issue);

    expect(order).toEqual(['sentry_status', 'sentry_comment', 'slack_outcome']);
  });
});

describe('PendingDrainer — reconcileIssue / reconcileAll (mirror mode)', () => {
  let config: AutopilotConfig;
  let db: StateDB;
  let reporter: Reporter;
  let drainer: PendingDrainer;

  beforeEach(() => {
    config = makeConfig({ ...makeConfig() }.stateDir);
    config.pendingMode = 'mirror';
    fs.mkdirSync(config.stateDir, { recursive: true });
    db = freshDb(config);
    reporter = setupReporter(config);
    drainer = new PendingDrainer(db, reporter, config);
    seedIssue(db);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('reconcileIssue NEVER invokes any executor (load-bearing invariant)', async () => {
    const queue: PendingAction[] = [
      action('sentry_status', 'sentry_status:SENTRY-DRAIN:resolved', { status: 'resolved' }),
      action('slack_outcome', 'slack_outcome:r1', { text: 'msg' }),
      action('linear_create_issue', 'linear_create_issue:SENTRY-DRAIN', {
        title: 'x',
        description: 'y',
        priority: 3,
      }),
    ];
    db.markCompleted('SENTRY-DRAIN', 'plan_created', 80, undefined, 'plan.md', {}, queue);

    const statusExec = vi.spyOn(reporter, 'executeSentryStatus').mockResolvedValue(undefined);
    const slackExec = vi.spyOn(reporter, 'executeSlackMessage').mockResolvedValue(undefined);
    const linearExec = vi.spyOn(reporter, 'executeLinearCreateIssue').mockResolvedValue(null);
    const sentryCommentExec = vi.spyOn(reporter, 'executeSentryComment').mockResolvedValue(undefined);

    // Stub probes so we can observe pruning vs divergence without HTTP.
    vi.spyOn(reporter, 'probeSentryStatus').mockResolvedValue('resolved');
    vi.spyOn(reporter, 'probeLinearAnnotation').mockResolvedValue(null);

    const issue = db.getIssue('SENTRY-DRAIN');
    if (!issue) throw new Error('issue missing');
    await drainer.reconcileIssue(issue);

    expect(statusExec).not.toHaveBeenCalled();
    expect(slackExec).not.toHaveBeenCalled();
    expect(linearExec).not.toHaveBeenCalled();
    expect(sentryCommentExec).not.toHaveBeenCalled();
  });

  it('reconcileIssue prunes actions whose probe reports "already done"', async () => {
    const queue: PendingAction[] = [
      action('sentry_status', 'sentry_status:SENTRY-DRAIN:resolved', { status: 'resolved' }),
      action('slack_outcome', 'slack_outcome:r2', { text: 'still pending' }),
    ];
    db.markCompleted('SENTRY-DRAIN', 'auto_committed', 95, 'abc', undefined, {}, queue);

    vi.spyOn(reporter, 'probeSentryStatus').mockResolvedValue('resolved');

    const issue = db.getIssue('SENTRY-DRAIN');
    if (!issue) throw new Error('issue missing');
    const stats = await drainer.reconcileIssue(issue);

    expect(stats.pruned).toBe(1);
    expect(stats.divergent).toBe(1); // slack_outcome has no external probe → divergent
    const remaining = db.getPendingActions('SENTRY-DRAIN');
    expect(remaining.map((a) => a.kind)).toEqual(['slack_outcome']);
  });
});

describe('PendingDrainer — pendingMode dispatch branches', () => {
  let config: AutopilotConfig;
  let db: StateDB;
  let reporter: Reporter;
  let drainer: PendingDrainer;

  beforeEach(() => {
    config = makeConfig();
    fs.mkdirSync(config.stateDir, { recursive: true });
    db = freshDb(config);
    reporter = setupReporter(config);
    drainer = new PendingDrainer(db, reporter, config);
    seedIssue(db);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('drainAll iterates every issue with pending actions', async () => {
    db.upsertIssue({
      sentry_id: 'SENTRY-A',
      sentry_url: 'https://sentry.io/issues/A',
      title: 'A',
    });
    db.upsertIssue({
      sentry_id: 'SENTRY-B',
      sentry_url: 'https://sentry.io/issues/B',
      title: 'B',
    });
    db.markCompleted(
      'SENTRY-A',
      'plan_created',
      80,
      undefined,
      'plan.md',
      {},
      [action('slack_outcome', 'slack_outcome:a', { text: 'A' })],
    );
    db.markCompleted(
      'SENTRY-B',
      'plan_created',
      80,
      undefined,
      'plan.md',
      {},
      [action('slack_outcome', 'slack_outcome:b', { text: 'B' })],
    );

    const exec = vi.spyOn(reporter, 'executeSlackMessage').mockResolvedValue(undefined);
    const stats = await drainer.drainAll({ runId: 1 });
    expect(stats.drained).toBeGreaterThanOrEqual(2);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
