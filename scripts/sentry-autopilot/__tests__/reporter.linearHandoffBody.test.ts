/**
 * Locks the shape of the enriched Linear ticket body emitted by the autopilot
 * for `linear_create_issue` (description) and `linear_comment_existing` /
 * adopted-link comments.
 *
 * This is the autopilot → human-driven-agent handoff payload. The picking-up
 * agent reads this body to (a) decide whether to adopt the autopilot's
 * diagnosis or independently re-investigate, and (b) check out the autopilot
 * branch to continue from where the autopilot left off. Body must contain:
 *   1. Autopilot summary (outcome, confidence, branch, files in scope)
 *   2. "How to pick this up" with `git fetch && git checkout` commands
 *   3. "Instructions for the picking-up agent" (evidence-not-ground-truth framing)
 *   4. Full plan (inlined from artifact `plan.md`, truncated at 50 KB)
 *
 * If any of these sections drop, the human-handoff context exhausts and the
 * agent picking it up has to redo the diagnostic work from scratch.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { planActions } from '../reporter.ts';
import type { SessionOutcome } from '../session-manager.ts';
import type { IssueRow } from '../state.ts';
import { fingerprintLooseHash } from '../triage/fingerprint.ts';
import type { VerificationResult } from '../verifier.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-handoff-'));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(stateDir = tempStateDir()): AutopilotConfig {
  return {
    sentryAuthToken: 'token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: 'lin-key',
    slackWebhook: 'https://slack.example/webhook',
    phase: 'guarded',
    verifyMode: 'disabled',
    pushMode: 'branch_only',
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

function makeIssue(overrides: Partial<IssueRow> = {}): IssueRow {
  const ts = '2026-05-15T00:00:00.000Z';
  return {
    sentry_id: 'SENTRY-HANDOFF-1',
    sentry_url: 'https://sentry.io/issues/SENTRY-HANDOFF-1',
    title: 'Test handoff fixture',
    error_type: 'exception',
    is_user_reported: false,
    occurrences: 10,
    users: 3,
    status: 'completed',
    dispatch_count: 1,
    max_retries: 2,
    confidence: 78,
    outcome: null,
    original_outcome: undefined,
    root_cause: undefined,
    plan_summary: undefined,
    diagnosis: undefined,
    is_bug: undefined,
    failure_kind: undefined,
    last_error: null,
    commit_hash: null,
    plan_file: null,
    linear_issue_id: null,
    tmux_session: null,
    worktree_slot: null,
    user_description: null,
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
    ...overrides,
  };
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function writePlanArtifact(stateDir: string, sentryId: string, planContents: string): void {
  const artifactDir = path.join(stateDir, 'artifacts', safePathSegment(sentryId));
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'plan.md'), planContents);
}

const NOW = '2026-05-15T12:34:56.000Z';

function defaultVerification(): VerificationResult {
  return { status: 'skipped', details: [], metrics: {} };
}

function getCreateIssueDescription(actions: ReturnType<typeof planActions>): string {
  const action = actions.find((a) => a.kind === 'linear_create_issue');
  if (!action) throw new Error('Expected linear_create_issue action');
  const payload = action.payload as { description: string };
  return payload.description;
}

function getCommentExistingBody(actions: ReturnType<typeof planActions>): string {
  const action = actions.find((a) => a.kind === 'linear_comment_existing');
  if (!action) throw new Error('Expected linear_comment_existing action');
  const payload = action.payload as { body: string };
  return payload.body;
}

function expectSentryIssueIdTrailerAtEnd(body: string, sentryId: string): void {
  const sentinel = `sentry-issue-id: ${sentryId}`;
  expect(body).toContain(`\n\n${sentinel}`);
  expect(body.trimEnd().endsWith(sentinel)).toBe(true);
  expect(body.match(new RegExp(`^${sentinel}$`, 'gm'))).toHaveLength(1);
}

function makeIssueWithLatestEvent(sentryId: string): IssueRow {
  return {
    ...makeIssue({ sentry_id: sentryId, sentry_url: `https://sentry.io/issues/${sentryId}` }),
    latestEvent: {
      entries: [
        {
          data: {
            values: [
              {
                stacktrace: {
                  frames: [
                    { filename: '/app/src/main.ts', function: 'handleError', lineno: 10 },
                    { filename: '/app/src/worker.ts', function: 'runWorker', lineno: 20 },
                    { filename: '/app/src/index.ts', function: 'main', lineno: 30 },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  } as IssueRow;
}

describe('Linear handoff body — plan_created (low confidence) → linear_create_issue', () => {
  it('inlines plan.md, includes branch, and gives the picking-up agent explicit instructions', () => {
    const stateDir = tempStateDir();
    const sentryId = 'SENTRY-HANDOFF-1';
    const planContents = [
      '# Plan for SENTRY-HANDOFF-1',
      '',
      '## Diagnosis',
      'classifyError() drops error.code on the catch-all branch.',
      '',
      '## Proposed fix',
      'Add a NodeJS.ErrnoException check before the unknown branch.',
      '',
      '## Verification',
      'Add a test that throws EMFILE and asserts ModelError(`fs_exhaustion`).',
    ].join('\n');
    writePlanArtifact(stateDir, sentryId, planContents);

    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 78,
      plan_file: 'plan.md',
      branch_name: 'autopilot/sentry-SENTRY-HANDOFF-1',
      files_changed: ['src/core/rebelCore/modelErrors.ts', 'packages/shared/src/utils/classifyErrorUx.ts'],
      root_cause: 'classifyError catch-all wraps NodeJS.ErrnoException EMFILE as ModelError unknown.',
      reason: 'Below 90% confidence threshold for auto-commit.',
      blockers_to_auto_commit: 'Multi-file fix touches a shared classifier; reviewer flagged behavioral-safety concern.',
      risks: 'New ModelError kind requires updates to 7+ caller sites; possible downstream classification gap.',
      debuggers_consulted: ['gpt-5.5-high', 'gpt-5.3-codex', 'opus-4.7-thinking'],
      is_bug: true,
    };

    const actions = planActions({
      issue: makeIssue({ sentry_id: sentryId, sentry_url: 'https://sentry.io/issues/SENTRY-HANDOFF-1' }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(stateDir),
      now: NOW,
    });

    const description = getCreateIssueDescription(actions);

    expect(description).toContain('## Autopilot summary');
    expect(description).toContain('plan_created');
    expect(description).toContain('78%');
    expect(description).toContain('https://sentry.io/issues/SENTRY-HANDOFF-1');
    expect(description).toContain('autopilot/sentry-SENTRY-HANDOFF-1');
    expect(description).toContain('src/core/rebelCore/modelErrors.ts');

    expect(description).toContain('## How to pick this up');
    expect(description).toContain('git fetch origin');
    expect(description).toContain('git checkout autopilot/sentry-SENTRY-HANDOFF-1');

    expect(description).toContain('## Instructions for the picking-up agent');
    expect(description).toContain('evidence, not ground truth');
    expect(description).toContain('Independently re-derive');
    expect(description).toContain('Multi-file fix touches a shared classifier');
    expect(description).toContain('New ModelError kind requires updates to 7+ caller sites');
    expect(description).toContain('gpt-5.5-high');

    expect(description).toContain("## Full plan (autopilot's diagnosis)");
    expect(description).toContain('classifyError() drops error.code on the catch-all branch.');
    expect(description).toContain('Add a NodeJS.ErrnoException check');
    expectSentryIssueIdTrailerAtEnd(description, sentryId);
  });

  it('falls back gracefully when plan.md is missing from the artifact dir', () => {
    const stateDir = tempStateDir();
    const sentryId = 'SENTRY-HANDOFF-NOPLAN';

    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 65,
      branch_name: 'autopilot/sentry-SENTRY-HANDOFF-NOPLAN',
      root_cause: 'Cannot reproduce locally.',
      reason: 'Insufficient diagnostic signal.',
      is_bug: true,
    };

    const actions = planActions({
      issue: makeIssue({ sentry_id: sentryId, sentry_url: 'https://sentry.io/issues/SENTRY-HANDOFF-NOPLAN' }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(stateDir),
      now: NOW,
    });

    const description = getCreateIssueDescription(actions);
    expect(description).toContain('plan.md unavailable');
    expect(description).toContain('## How to pick this up');
    expect(description).toContain('## Instructions for the picking-up agent');
  });

  it('omits the git checkout block when no branch is recorded', () => {
    const stateDir = tempStateDir();
    const sentryId = 'SENTRY-HANDOFF-NOBRANCH';
    writePlanArtifact(stateDir, sentryId, '# Minimal plan');

    const outcome: SessionOutcome = {
      outcome: 'escalated',
      confidence: 30,
      reason: 'Divergent diagnoses; need human judgment.',
      is_bug: true,
    };

    const actions = planActions({
      issue: makeIssue({ sentry_id: sentryId, sentry_url: 'https://sentry.io/issues/SENTRY-HANDOFF-NOBRANCH' }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(stateDir),
      now: NOW,
    });

    const description = getCreateIssueDescription(actions);
    expect(description).toContain('did not commit a (validated) branch');
    expect(description).not.toMatch(/git checkout autopilot\//);
    expect(description).toContain('# Minimal plan');
  });

  it('truncates very large plans at the inline cap and surfaces a footer marker', () => {
    const stateDir = tempStateDir();
    const sentryId = 'SENTRY-HANDOFF-BIG';
    const bigPlan = '# Big plan\n\n' + 'x'.repeat(80_000);
    writePlanArtifact(stateDir, sentryId, bigPlan);

    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 80,
      branch_name: 'autopilot/sentry-SENTRY-HANDOFF-BIG',
      root_cause: 'Big root cause',
      is_bug: true,
    };

    const actions = planActions({
      issue: makeIssue({ sentry_id: sentryId, sentry_url: 'https://sentry.io/issues/SENTRY-HANDOFF-BIG' }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(stateDir),
      now: NOW,
    });

    const description = getCreateIssueDescription(actions);
    expect(description).toContain('truncated; full plan was');
    expect(description.length).toBeLessThan(80_000);
    expect(description).toContain('# Big plan');
    expectSentryIssueIdTrailerAtEnd(description, sentryId);
    expect(description.indexOf(`sentry-issue-id: ${sentryId}`)).toBeGreaterThan(
      description.indexOf('truncated; full plan was'),
    );
  });

  it('adds both Sentry id and autopilot fingerprint trailers when stack frames are available', () => {
    const stateDir = tempStateDir();
    const sentryId = 'SENTRY-HANDOFF-FINGERPRINT';
    writePlanArtifact(stateDir, sentryId, '# Fingerprint plan');
    const expectedHash = fingerprintLooseHash([
      { filename: '/app/src/main.ts', function: 'handleError', lineno: 10 },
      { filename: '/app/src/worker.ts', function: 'runWorker', lineno: 20 },
      { filename: '/app/src/index.ts', function: 'main', lineno: 30 },
    ]);

    const actions = planActions({
      issue: makeIssueWithLatestEvent(sentryId),
      outcome: {
        outcome: 'plan_created',
        confidence: 80,
        branch_name: 'autopilot/sentry-SENTRY-HANDOFF-FINGERPRINT',
        root_cause: 'Fingerprint root cause',
        is_bug: true,
      },
      verification: defaultVerification(),
      config: makeConfig(stateDir),
      now: NOW,
    });

    const description = getCreateIssueDescription(actions);
    expect(description).toContain(`sentry-issue-id: ${sentryId}`);
    expect(description).toContain(`autopilot-fingerprint: ${expectedHash}`);
    expect(description.trimEnd().endsWith(`autopilot-fingerprint: ${expectedHash}`)).toBe(true);
  });

  it('keeps only the Sentry id trailer when stack frames are unavailable', () => {
    const stateDir = tempStateDir();
    const sentryId = 'SENTRY-HANDOFF-NO-FINGERPRINT';
    writePlanArtifact(stateDir, sentryId, '# No fingerprint plan');

    const actions = planActions({
      issue: makeIssue({ sentry_id: sentryId, sentry_url: 'https://sentry.io/issues/SENTRY-HANDOFF-NO-FINGERPRINT' }),
      outcome: {
        outcome: 'plan_created',
        confidence: 80,
        branch_name: 'autopilot/sentry-SENTRY-HANDOFF-NO-FINGERPRINT',
        root_cause: 'No fingerprint root cause',
        is_bug: true,
      },
      verification: defaultVerification(),
      config: makeConfig(stateDir),
      now: NOW,
    });

    const description = getCreateIssueDescription(actions);
    expectSentryIssueIdTrailerAtEnd(description, sentryId);
    expect(description).not.toContain('autopilot-fingerprint:');
  });

  it('preserves both trailers after long-plan truncation when a fingerprint is available', () => {
    const stateDir = tempStateDir();
    const sentryId = 'SENTRY-HANDOFF-BIG-FINGERPRINT';
    writePlanArtifact(stateDir, sentryId, '# Big fingerprint plan\n\n' + 'x'.repeat(80_000));
    const expectedHash = fingerprintLooseHash([
      { filename: '/app/src/main.ts', function: 'handleError', lineno: 10 },
      { filename: '/app/src/worker.ts', function: 'runWorker', lineno: 20 },
      { filename: '/app/src/index.ts', function: 'main', lineno: 30 },
    ]);

    const actions = planActions({
      issue: makeIssueWithLatestEvent(sentryId),
      outcome: {
        outcome: 'plan_created',
        confidence: 80,
        branch_name: 'autopilot/sentry-SENTRY-HANDOFF-BIG-FINGERPRINT',
        root_cause: 'Big fingerprint root cause',
        is_bug: true,
      },
      verification: defaultVerification(),
      config: makeConfig(stateDir),
      now: NOW,
    });

    const description = getCreateIssueDescription(actions);
    expect(description).toContain('truncated; full plan was');
    expect(description).toContain(`sentry-issue-id: ${sentryId}`);
    expect(description).toContain(`autopilot-fingerprint: ${expectedHash}`);
    expect(description.indexOf(`autopilot-fingerprint: ${expectedHash}`)).toBeGreaterThan(
      description.indexOf('truncated; full plan was'),
    );
  });

  it('renders the on-branch plan path from outcome.plan_file (CE2-native shape) in the pickup section', () => {
    const stateDir = tempStateDir();
    const sentryId = 'SENTRY-HANDOFF-CE2-NATIVE';
    writePlanArtifact(stateDir, sentryId, '# CE2-native plan body');

    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 80,
      branch_name: 'autopilot/sentry-SENTRY-HANDOFF-CE2-NATIVE',
      plan_file: 'docs/plans/fix-handoff-ce2-native/PLAN.md',
      root_cause: 'CE2-native plan path',
      is_bug: true,
    };

    const actions = planActions({
      issue: makeIssue({ sentry_id: sentryId, sentry_url: 'https://sentry.io/issues/SENTRY-HANDOFF-CE2-NATIVE' }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(stateDir),
      now: NOW,
    });

    const description = getCreateIssueDescription(actions);
    expect(description).toContain('docs/plans/fix-handoff-ce2-native/PLAN.md');
    expect(description).not.toContain('`plan.md` is at the repo root on this branch');
  });

  it('renders the on-branch plan path as legacy plan.md when outcome.plan_file is the literal "plan.md"', () => {
    const stateDir = tempStateDir();
    const sentryId = 'SENTRY-HANDOFF-LEGACY';
    writePlanArtifact(stateDir, sentryId, '# Legacy plan body');

    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 80,
      branch_name: 'autopilot/sentry-SENTRY-HANDOFF-LEGACY',
      plan_file: 'plan.md',
      root_cause: 'Legacy plan path',
      is_bug: true,
    };

    const actions = planActions({
      issue: makeIssue({ sentry_id: sentryId, sentry_url: 'https://sentry.io/issues/SENTRY-HANDOFF-LEGACY' }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(stateDir),
      now: NOW,
    });

    const description = getCreateIssueDescription(actions);
    expect(description).toMatch(/Plan file on this branch: `plan\.md`/);
  });
});

describe('Linear handoff body — security & robustness', () => {
  it('rejects malformed branch_name and falls back to no-branch handoff (no shell injection)', () => {
    const stateDir = tempStateDir();
    const sentryId = 'SENTRY-INJECT';
    writePlanArtifact(stateDir, sentryId, '# Plan with hostile branch_name');

    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 75,
      // Malformed: contains shell metacharacters and a newline. A naive
      // implementation would render this into the `git checkout` block.
      branch_name: 'autopilot/sentry-X; rm -rf $HOME\nexit 0',
      root_cause: 'Test fixture for branch validation',
      is_bug: true,
    };

    const actions = planActions({
      issue: makeIssue({ sentry_id: sentryId, sentry_url: 'https://sentry.io/issues/SENTRY-INJECT' }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(stateDir),
      now: NOW,
    });

    const description = getCreateIssueDescription(actions);
    expect(description).not.toContain('rm -rf');
    expect(description).not.toMatch(/git checkout autopilot\/sentry-X;/);
    expect(description).toContain('did not commit a (validated) branch');
  });

  it('accepts well-formed autopilot branch names', () => {
    const stateDir = tempStateDir();
    const sentryId = 'SENTRY-OK';
    writePlanArtifact(stateDir, sentryId, '# Plan');

    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 75,
      branch_name: 'autopilot/sentry-7483061380',
      root_cause: 'r',
      is_bug: true,
    };
    const actions = planActions({
      issue: makeIssue({ sentry_id: sentryId, sentry_url: 'https://sentry.io/issues/SENTRY-OK' }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(stateDir),
      now: NOW,
    });

    const description = getCreateIssueDescription(actions);
    expect(description).toContain('git checkout autopilot/sentry-7483061380');
  });

  it('truncates non-ASCII (multi-byte UTF-8) plans by byte size, not character count', () => {
    const stateDir = tempStateDir();
    const sentryId = 'SENTRY-UTF8';
    // Each '日' is 3 UTF-8 bytes. 30,000 chars = 90,000 bytes, comfortably
    // over the 50KB byte cap. A character-based cap would NOT truncate.
    const bigUtf8Plan = '# Plan\n\n' + '日'.repeat(30_000);
    writePlanArtifact(stateDir, sentryId, bigUtf8Plan);

    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 80,
      branch_name: 'autopilot/sentry-utf8',
      root_cause: 'r',
      is_bug: true,
    };
    const actions = planActions({
      issue: makeIssue({ sentry_id: sentryId, sentry_url: 'https://sentry.io/issues/SENTRY-UTF8' }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(stateDir),
      now: NOW,
    });

    const description = getCreateIssueDescription(actions);
    expect(description).toContain('truncated; full plan was');
    // Body's plan section must fit under the byte cap (with some headroom
    // for the surrounding 4-section markdown scaffold).
    expect(Buffer.byteLength(description, 'utf8')).toBeLessThan(60_000);
  });

  it('preserves persisted root_cause / plan_summary / blockers / risks when plan.md is missing', () => {
    const stateDir = tempStateDir();
    const sentryId = 'SENTRY-FALLBACK';
    // Deliberately do NOT write plan.md.

    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 70,
      branch_name: 'autopilot/sentry-fallback',
      root_cause: 'PERSISTED root cause prose with details',
      plan_summary: 'PERSISTED plan summary',
      reason: 'PERSISTED reason field',
      blockers_to_auto_commit: 'PERSISTED blockers content',
      risks: 'PERSISTED risks content',
      is_bug: true,
    };
    const actions = planActions({
      issue: makeIssue({ sentry_id: sentryId, sentry_url: 'https://sentry.io/issues/SENTRY-FALLBACK' }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(stateDir),
      now: NOW,
    });

    const description = getCreateIssueDescription(actions);
    expect(description).toContain('plan.md unavailable');
    expect(description).toContain('PERSISTED root cause');
    expect(description).toContain('PERSISTED plan summary');
    expect(description).toContain('PERSISTED reason');
    expect(description).toContain('PERSISTED blockers');
    expect(description).toContain('PERSISTED risks');
  });

  it('emits sections in canonical order (summary → pickup → instructions → plan)', () => {
    const stateDir = tempStateDir();
    const sentryId = 'SENTRY-ORDER';
    writePlanArtifact(stateDir, sentryId, '# Plan body');
    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 80,
      branch_name: 'autopilot/sentry-order',
      root_cause: 'r',
      is_bug: true,
    };
    const actions = planActions({
      issue: makeIssue({ sentry_id: sentryId, sentry_url: 'https://sentry.io/issues/SENTRY-ORDER' }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(stateDir),
      now: NOW,
    });
    const description = getCreateIssueDescription(actions);
    const summaryIdx = description.indexOf('## Autopilot summary');
    const pickupIdx = description.indexOf('## How to pick this up');
    const instructionsIdx = description.indexOf('## Instructions for the picking-up agent');
    const planIdx = description.indexOf("## Full plan (autopilot's diagnosis)");
    const sentinelIdx = description.indexOf(`sentry-issue-id: ${sentryId}`);
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(pickupIdx).toBeGreaterThan(summaryIdx);
    expect(instructionsIdx).toBeGreaterThan(pickupIdx);
    expect(planIdx).toBeGreaterThan(instructionsIdx);
    expect(sentinelIdx).toBeGreaterThan(planIdx);
    expectSentryIssueIdTrailerAtEnd(description, sentryId);
  });
});

describe('Linear handoff body — adopted-link path (existing user-filed issue) → linear_comment_existing', () => {
  it('emits the same enriched handoff body as a comment with a clarifying header', () => {
    const stateDir = tempStateDir();
    const sentryId = 'SENTRY-ADOPT';
    writePlanArtifact(stateDir, sentryId, '# Adopted plan\n\nRoot cause analysis here.');

    const outcome: SessionOutcome = {
      outcome: 'plan_created',
      confidence: 72,
      branch_name: 'autopilot/sentry-SENTRY-ADOPT',
      root_cause: 'Race in MCP connection state.',
      reason: 'Below 90% confidence threshold.',
      is_bug: true,
    };

    const actions = planActions({
      issue: makeIssue({ sentry_id: sentryId, sentry_url: 'https://sentry.io/issues/SENTRY-ADOPT' }),
      outcome,
      verification: defaultVerification(),
      config: makeConfig(stateDir),
      now: NOW,
      existingLinearIdentifier: 'FOX-1234',
    });

    const body = getCommentExistingBody(actions);
    expect(body).toContain('Sentry Autopilot update');
    expect(body).toContain('user-filed issue');
    expect(body).toContain('## Autopilot summary');
    expect(body).toContain('## How to pick this up');
    expect(body).toContain('git checkout autopilot/sentry-SENTRY-ADOPT');
    expect(body).toContain('## Instructions for the picking-up agent');
    expect(body).toContain('evidence, not ground truth');
    expect(body).toContain('# Adopted plan');
    expectSentryIssueIdTrailerAtEnd(body, sentryId);
  });
});
