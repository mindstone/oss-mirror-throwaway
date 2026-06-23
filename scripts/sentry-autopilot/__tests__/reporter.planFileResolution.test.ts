import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { __testing__ } from '../reporter.ts';
import type { SessionOutcome } from '../session-manager.ts';
import type { IssueRow } from '../state.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-planfile-'));
  tempDirs.push(dir);
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
    pendingMode: 'disabled',
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

function makeIssue(plan_file: string | null): IssueRow {
  const ts = '2026-05-15T00:00:00.000Z';
  return {
    sentry_id: 'SENTRY-PLAN-FILE',
    sentry_url: 'https://sentry.io/issues/SENTRY-PLAN-FILE',
    title: 'plan-file resolution fixture',
    error_type: 'exception',
    is_user_reported: false,
    occurrences: 1,
    users: 1,
    status: 'completed',
    dispatch_count: 1,
    max_retries: 2,
    confidence: 80,
    outcome: 'plan_created',
    last_error: null,
    commit_hash: null,
    plan_file,
    linear_issue_id: null,
    tmux_session: null,
    worktree_slot: null,
    user_description: null,
    user_email: null,
    user_name: null,
    pending_actions: null,
    verification_status: null,
    verification_details: null,
    branch_name: null,
    pr_url: null,
    pushed_at: null,
    created_at: ts,
    updated_at: ts,
    dispatched_at: ts,
    completed_at: ts,
  };
}

function makeOutcome(plan_file: string | undefined): SessionOutcome {
  return {
    outcome: 'plan_created',
    sentry_id: 'SENTRY-PLAN-FILE',
    confidence: 80,
    plan_file,
  };
}

function writeArtifactPlan(stateDir: string, sentryId: string, body: string): string {
  const artifactDir = path.join(stateDir, 'artifacts', sentryId);
  fs.mkdirSync(artifactDir, { recursive: true });
  const planPath = path.join(artifactDir, 'plan.md');
  fs.writeFileSync(planPath, body);
  return planPath;
}

describe('reporter.readPlanFileText (plan-file resolution)', () => {
  it('reads <artifactDir>/plan.md when outcome.plan_file is the legacy literal "plan.md"', () => {
    const stateDir = tempStateDir();
    writeArtifactPlan(stateDir, 'SENTRY-PLAN-FILE', '# legacy plan body\n');

    const text = __testing__.readPlanFileText(
      makeIssue(null),
      makeOutcome('plan.md'),
      makeConfig(stateDir),
    );

    expect(text).toBe('# legacy plan body\n');
  });

  it('reads <artifactDir>/plan.md when outcome.plan_file is the CE2-native shape', () => {
    const stateDir = tempStateDir();
    writeArtifactPlan(stateDir, 'SENTRY-PLAN-FILE', '# CE2 plan body\n');

    const text = __testing__.readPlanFileText(
      makeIssue(null),
      makeOutcome('docs/plans/260605_my-fix/PLAN.md'),
      makeConfig(stateDir),
    );

    expect(text).toBe('# CE2 plan body\n');
  });

  it('falls back to issue.plan_file when outcome.plan_file is absent', () => {
    const stateDir = tempStateDir();
    writeArtifactPlan(stateDir, 'SENTRY-PLAN-FILE', '# from issue row\n');

    const text = __testing__.readPlanFileText(
      makeIssue('docs/plans/260605_my-fix/PLAN.md'),
      makeOutcome(undefined),
      makeConfig(stateDir),
    );

    expect(text).toBe('# from issue row\n');
  });

  it('returns null when no plan.md snapshot exists in the artifact dir', () => {
    const stateDir = tempStateDir();

    const text = __testing__.readPlanFileText(
      makeIssue(null),
      makeOutcome('docs/plans/260605_my-fix/PLAN.md'),
      makeConfig(stateDir),
    );

    expect(text).toBeNull();
  });

  it('honours absolute paths in plan_file (rare, used for special cases)', () => {
    const stateDir = tempStateDir();
    const absDir = tempStateDir();
    const absPlan = path.join(absDir, 'PLAN.md');
    fs.writeFileSync(absPlan, '# absolute path body\n');

    const text = __testing__.readPlanFileText(
      makeIssue(null),
      makeOutcome(absPlan),
      makeConfig(stateDir),
    );

    expect(text).toBe('# absolute path body\n');
  });
});
