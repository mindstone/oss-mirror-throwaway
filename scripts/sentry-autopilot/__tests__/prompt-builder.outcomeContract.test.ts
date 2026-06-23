/**
 * Stage 5.6 — prompt-builder Outcome Contract section tests.
 *
 * The Outcome Contract section (inserted between Confidence-Based Output
 * Policy and Exit Protocol) tells the agent the typed shape of outcome.json.
 * It must:
 *   - Appear under all three phases (shadow, guarded, full)
 *   - Appear under all three pushModes (disabled, branch_only, pr)
 *   - Name every typed field in the §3.2 contract
 *   - Explicitly forbid is_bug string values and diagnosis object values
 *   - Mention diagnosis_structured as the escape hatch for structured data
 *   - Appear AFTER Confidence-Based Output Policy and BEFORE Exit Protocol
 *
 * Source of truth: docs/plans/260520_sentry_autopilot_stage_5_6_prompt_tightening.md §3.2.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { buildPrompt } from '../prompt-builder.ts';
import type { PolledIssue } from '../poller.ts';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-prompt-outcome-contract-'));
  tempDirs.push(dir);
  return dir;
}

function baseConfig(
  phase: AutopilotConfig['phase'],
  pushMode: AutopilotConfig['pushMode'],
  stateDir: string,
): AutopilotConfig {
  return {
    sentryAuthToken: 'token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: undefined,
    githubToken: pushMode === 'pr' ? 'ghp_FAKE' : undefined,
    repoFullName: pushMode === 'pr' ? 'mindstone/rebel-app' : undefined,
    phase,
    verifyMode: pushMode === 'pr' ? 'enforce' : 'disabled',
    pushMode,
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

function pollerIssue(id: string): PolledIssue {
  return {
    sentryId: id,
    sentryUrl: `https://sentry.io/issues/${id}`,
    title: 'sample bug',
    errorType: 'exception',
    level: 'error',
    occurrences: 5,
    users: 2,
    isUserReported: false,
    firstSeen: '2026-05-15T00:00:00Z',
    lastSeen: '2026-05-15T01:00:00Z',
  };
}

function readPrompt(promptPath: string): string {
  return fs.readFileSync(promptPath, 'utf8');
}

const PHASES: AutopilotConfig['phase'][] = ['shadow', 'guarded', 'full'];
const PUSH_MODES: AutopilotConfig['pushMode'][] = ['disabled', 'branch_only', 'pr'];
const CONTRACT_HEADING = '### Outcome Contract — outcome.json field types (STRICT)';

describe('buildPrompt Outcome Contract section (Stage 5.6)', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = tempStateDir();
  });

  it('includes the Outcome Contract section under every phase', () => {
    for (const phase of PHASES) {
      const prompt = readPrompt(buildPrompt(pollerIssue(`REBEL-PH-${phase}`), baseConfig(phase, 'disabled', stateDir)));
      expect(prompt).toContain(CONTRACT_HEADING);
    }
  });

  it('includes the Outcome Contract section under every pushMode', () => {
    for (const pushMode of PUSH_MODES) {
      const prompt = readPrompt(buildPrompt(pollerIssue(`REBEL-PM-${pushMode}`), baseConfig('full', pushMode, stateDir)));
      expect(prompt).toContain(CONTRACT_HEADING);
    }
  });

  it('names every canonical typed field from §3.2', () => {
    const prompt = readPrompt(buildPrompt(pollerIssue('REBEL-FIELDS'), baseConfig('shadow', 'disabled', stateDir)));
    const typedFields = [
      '`outcome`',
      '`is_bug`',
      '`confidence`',
      '`diagnosis`',
      '`root_cause`',
      '`plan_summary`',
      '`files_changed`',
      '`commit_hash`',
      '`branch_name`',
      '`plan_file`',
      '`failure_kind`',
      '`error`',
      '`reason`',
      '`shadow_would_commit`',
      '`sentry_id`',
      '`pr_url`',
      '`original_outcome`',
      '`exit_code`',
    ];
    for (const field of typedFields) {
      expect(prompt).toContain(field);
    }
  });

  it('explicitly forbids is_bug string values and null', () => {
    const prompt = readPrompt(buildPrompt(pollerIssue('REBEL-BOOL'), baseConfig('shadow', 'disabled', stateDir)));
    expect(prompt).toMatch(/`is_bug`[^]+JSON boolean/);
    expect(prompt).toMatch(/Not a string/);
    expect(prompt).toMatch(/Do NOT emit \\?`"yes"\\?`/);
    expect(prompt).toMatch(/Do NOT emit `null`/);
  });

  it('explicitly forbids diagnosis as an object and points to diagnosis_structured', () => {
    const prompt = readPrompt(buildPrompt(pollerIssue('REBEL-DIAG'), baseConfig('shadow', 'disabled', stateDir)));
    expect(prompt).toMatch(/`diagnosis`[^]+Flat prose only — not an object/);
    expect(prompt).toContain('`diagnosis_structured`');
  });

  it('lists allowed extras keys to signal preservation', () => {
    const prompt = readPrompt(buildPrompt(pollerIssue('REBEL-EXTRAS'), baseConfig('shadow', 'disabled', stateDir)));
    const sampleExtras = [
      '`originating_commit`',
      '`debuggers_consulted`',
      '`reviewer_results`',
      '`diagnosis_structured`',
      '`verification_plan`',
    ];
    for (const key of sampleExtras) {
      expect(prompt).toContain(key);
    }
  });

  it('forbids duplicate-of-typed-field extras keys', () => {
    const prompt = readPrompt(buildPrompt(pollerIssue('REBEL-DUP'), baseConfig('shadow', 'disabled', stateDir)));
    expect(prompt).toContain('Do not duplicate a typed field under a different name');
    expect(prompt).toContain('`bug_confirmed: "yes"`');
    expect(prompt).toContain('`commit_sha`');
  });

  it('appears AFTER Confidence-Based Output Policy and BEFORE Exit Protocol', () => {
    const prompt = readPrompt(buildPrompt(pollerIssue('REBEL-ORDER'), baseConfig('shadow', 'disabled', stateDir)));
    const confidencePos = prompt.indexOf('### Confidence-Based Output Policy');
    const contractPos = prompt.indexOf(CONTRACT_HEADING);
    const exitPos = prompt.indexOf('### Exit Protocol');
    expect(confidencePos).toBeGreaterThan(-1);
    expect(contractPos).toBeGreaterThan(-1);
    expect(exitPos).toBeGreaterThan(-1);
    expect(contractPos).toBeGreaterThan(confidencePos);
    expect(exitPos).toBeGreaterThan(contractPos);
  });
});
