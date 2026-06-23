import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { SessionManager } from '../session-manager.ts';
import type { IssueRow, StateDB } from '../state.ts';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const tempDirs: string[] = [];

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
    pendingMode: 'disabled',
    stateDir,
    maxConcurrent: 1,
    maxHourly: 1,
    maxDaily: 1,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: REPO_ROOT,
    cli: 'droid',
    cursorModel: 'composer-2.5',
    claudeModel: 'claude-opus-4-8',
  };
}

function makeIssue(sentryId: string): IssueRow {
  return {
    sentry_id: sentryId,
    sentry_url: `https://sentry.io/issues/${sentryId}`,
    title: 'Autopilot test issue',
    error_type: 'exception',
    is_user_reported: false,
    occurrences: 1,
    users: 1,
    status: 'dispatched',
    dispatch_count: 1,
    max_retries: 2,
    confidence: null,
    outcome: null,
    last_error: null,
    commit_hash: null,
    plan_file: null,
    linear_issue_id: null,
    tmux_session: 'sentry-test',
    worktree_slot: 0,
    user_description: null,
    pending_actions: null,
    verification_status: null,
    verification_details: null,
    branch_name: null,
    pr_url: null,
    pushed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    dispatched_at: new Date().toISOString(),
    completed_at: null,
  };
}

function createArtifactDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-session-manager-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('SessionManager outcome handling', () => {
  it('preserves original_outcome when plan_created + is_bug=false is reclassified to not_a_bug', async () => {
    const stateDir = createArtifactDir();
    const artifactDir = createArtifactDir();
    const issue = makeIssue('SENTRY-RECLASSIFY');
    const db = {
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    } as unknown as StateDB;
    const manager = new SessionManager(makeConfig(stateDir), db);
    vi.spyOn(manager as unknown as { tryReleaseSlot: (slot: number | null, dir: string) => Promise<Error | null> }, 'tryReleaseSlot')
      .mockResolvedValue(null);

    fs.writeFileSync(
      path.join(artifactDir, 'outcome.json'),
      JSON.stringify({
        outcome: 'plan_created',
        sentry_id: issue.sentry_id,
        confidence: 80,
        plan_file: 'plan.md',
        is_bug: false,
        root_cause: 'works as designed',
      }),
    );

    await (manager as unknown as { harvestOutcome: (row: IssueRow, dir: string) => Promise<unknown> }).harvestOutcome(
      issue,
      artifactDir,
    );

    expect((db as unknown as { markFailed: ReturnType<typeof vi.fn> }).markFailed).not.toHaveBeenCalled();
    const markCompleted = (db as unknown as { markCompleted: ReturnType<typeof vi.fn> }).markCompleted;
    expect(markCompleted).toHaveBeenCalledTimes(1);
    expect(markCompleted).toHaveBeenCalledWith(
      issue.sentry_id,
      'not_a_bug',
      80,
      undefined,
      undefined,
      expect.objectContaining({
        original_outcome: 'plan_created',
        is_bug: false,
        root_cause: 'works as designed',
      }),
      [],
    );
  });

  it('keeps original_outcome equal to outcome when no reclassification applies', async () => {
    const stateDir = createArtifactDir();
    const artifactDir = createArtifactDir();
    const issue = makeIssue('SENTRY-NORMAL');
    const db = {
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    } as unknown as StateDB;
    const manager = new SessionManager(makeConfig(stateDir), db);
    vi.spyOn(manager as unknown as { tryReleaseSlot: (slot: number | null, dir: string) => Promise<Error | null> }, 'tryReleaseSlot')
      .mockResolvedValue(null);

    fs.writeFileSync(
      path.join(artifactDir, 'outcome.json'),
      JSON.stringify({
        outcome: 'escalated',
        sentry_id: issue.sentry_id,
        confidence: 55,
        reason: 'needs human review',
      }),
    );

    await (manager as unknown as { harvestOutcome: (row: IssueRow, dir: string) => Promise<unknown> }).harvestOutcome(
      issue,
      artifactDir,
    );

    const markCompleted = (db as unknown as { markCompleted: ReturnType<typeof vi.fn> }).markCompleted;
    expect(markCompleted).toHaveBeenCalledTimes(1);
    expect(markCompleted).toHaveBeenCalledWith(
      issue.sentry_id,
      'escalated',
      55,
      undefined,
      undefined,
      expect.objectContaining({
        original_outcome: 'escalated',
      }),
      [],
    );
  });

  it('returns a synthetic failed HarvestResult when outcome.json is malformed', async () => {
    const stateDir = createArtifactDir();
    const artifactDir = createArtifactDir();
    const issue = makeIssue('SENTRY-PARSE-FAIL');
    const db = {
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
      markParseFailure: vi.fn(),
    } as unknown as StateDB;
    const manager = new SessionManager(makeConfig(stateDir), db);
    vi
      .spyOn(
        manager as unknown as { tryReleaseSlot: (slot: number | null, dir: string) => Promise<Error | null> },
        'tryReleaseSlot',
      )
      .mockResolvedValue(null);

    fs.writeFileSync(path.join(artifactDir, 'outcome.json'), '{not-json');

    const result = await (
      manager as unknown as { harvestOutcome: (row: IssueRow, dir: string) => Promise<unknown> }
    ).harvestOutcome(issue, artifactDir);

    expect((db as unknown as { markCompleted: ReturnType<typeof vi.fn> }).markCompleted).not.toHaveBeenCalled();
    expect((db as unknown as { markFailed: ReturnType<typeof vi.fn> }).markFailed).not.toHaveBeenCalled();
    const markParseFailure = (db as unknown as { markParseFailure: ReturnType<typeof vi.fn> }).markParseFailure;
    expect(markParseFailure).toHaveBeenCalledTimes(1);
    const callArgs = markParseFailure.mock.calls[0];
    expect(callArgs?.[0]).toBe(issue.sentry_id);
    expect(callArgs?.[1]).toContain('Failed to harvest outcome:');
    const originalOutcome = JSON.parse(callArgs?.[2] as string) as { truncated_text?: string; artifact_path?: string };
    expect(originalOutcome).toMatchObject({
      truncated_text: expect.stringContaining('{not-json'),
      artifact_path: expect.stringContaining('outcome.json'),
    });
    expect(result).toMatchObject({
      sentryId: issue.sentry_id,
      logFile: path.join(artifactDir, 'supervisor.log'),
      outcome: {
        outcome: 'failed',
        failure_kind: 'parse_failure',
      },
    });
  });

  it('includes slot cleanup failure details in synthetic parse-failure outcome errors', async () => {
    const stateDir = createArtifactDir();
    const artifactDir = createArtifactDir();
    const issue = makeIssue('SENTRY-PARSE-FAIL-CLEANUP');
    const db = {
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
      markParseFailure: vi.fn(),
    } as unknown as StateDB;
    const manager = new SessionManager(makeConfig(stateDir), db);
    vi
      .spyOn(
        manager as unknown as { tryReleaseSlot: (slot: number | null, dir: string) => Promise<Error | null> },
        'tryReleaseSlot',
      )
      .mockResolvedValue(new Error('cleanup exploded'));

    fs.writeFileSync(path.join(artifactDir, 'outcome.json'), '{bad');

    const result = await (
      manager as unknown as { harvestOutcome: (row: IssueRow, dir: string) => Promise<{ outcome: { error?: string } }> }
    ).harvestOutcome(issue, artifactDir);

    expect((db as unknown as { markFailed: ReturnType<typeof vi.fn> }).markFailed).not.toHaveBeenCalled();
    const markParseFailure = (db as unknown as { markParseFailure: ReturnType<typeof vi.fn> }).markParseFailure;
    expect(markParseFailure).toHaveBeenCalledTimes(1);
    const callArgs = markParseFailure.mock.calls[0];
    expect(callArgs?.[0]).toBe(issue.sentry_id);
    expect(callArgs?.[1]).toContain('slot cleanup also failed: cleanup exploded');
    const originalOutcome = JSON.parse(callArgs?.[2] as string) as { truncated_text?: string; artifact_path?: string };
    expect(originalOutcome).toMatchObject({
      truncated_text: expect.stringContaining('{bad'),
      artifact_path: expect.stringContaining('outcome.json'),
    });
    expect(result.outcome.error).toContain('slot cleanup also failed: cleanup exploded');
    expect(result.outcome).toMatchObject({
      outcome: 'failed',
      failure_kind: 'parse_failure',
    });
  });
});
