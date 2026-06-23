/**
 * Stage 5.6 Stage A.5 — prompt-builder Eval Mode (AUTOPILOT_EVAL_MODE) tests.
 *
 * When AUTOPILOT_EVAL_MODE=true, the bug-fixer prompt must disable all git
 * operations and file writes outside the artifact directory. The eval harness
 * spawns the runner (`droid exec` / `cursor-agent`) inside the host repo (no
 * isolated worktree); without this
 * guard, the bug-fixer follows the production prompt's `git checkout -B
 * autopilot/sentry-<id>` + `git commit plan.md` instructions and pollutes the
 * host repo with synthetic eval branches and commits.
 *
 * Source: docs/plans/260520_sentry_autopilot_stage_5_6_prompt_tightening.md
 * (Stage A.5 isolation guard).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  vi.unstubAllEnvs();
});

function tempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-prompt-eval-mode-'));
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
const EVAL_HEADING = '### Eval Mode — No Repo Mutations (AUTOPILOT_EVAL_MODE=true)';
const PRODUCTION_HEADING = '### Autopilot Branch Convention';

describe('buildPrompt eval-mode isolation guard (Stage 5.6 Stage A.5)', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = tempStateDir();
  });

  it('AUTOPILOT_EVAL_MODE=true replaces the Autopilot Branch Convention section', () => {
    vi.stubEnv('AUTOPILOT_EVAL_MODE', 'true');
    const promptPath = buildPrompt(pollerIssue('TEST-EVAL-1'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain(EVAL_HEADING);
    expect(prompt).not.toContain(PRODUCTION_HEADING);
  });

  it('AUTOPILOT_EVAL_MODE=true forbids git checkout, commit, push, and stash commands', () => {
    vi.stubEnv('AUTOPILOT_EVAL_MODE', 'true');
    const promptPath = buildPrompt(pollerIssue('TEST-EVAL-2'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    // None of the production git-mutation command lines should appear.
    // (The eval-mode section MENTIONS these by name to forbid them, so we match
    // the actual invocation forms rather than bare substrings.)
    expect(prompt).not.toMatch(/^\s*git checkout -B /m);
    expect(prompt).not.toMatch(/^\s*git branch --set-upstream-to=/m);
    expect(prompt).not.toMatch(/npx tsx scripts\/git-safe-sync\.ts/);
    expect(prompt).not.toMatch(/^\s*flock -w \d+ /m);

    // And the eval section explicitly enumerates the forbidden ops.
    expect(prompt).toContain('`git checkout`');
    expect(prompt).toContain('`git commit`');
    expect(prompt).toContain('`git push`');
  });

  it('AUTOPILOT_EVAL_MODE=true forbids file writes outside the artifact directory', () => {
    vi.stubEnv('AUTOPILOT_EVAL_MODE', 'true');
    const promptPath = buildPrompt(pollerIssue('TEST-EVAL-3'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain('File writes outside the artifact directory');
    expect(prompt).toContain('Edits to any tracked file in the working tree');
  });

  it('AUTOPILOT_EVAL_MODE=true tells the agent to simulate commit_hash + branch_name (not actually commit)', () => {
    vi.stubEnv('AUTOPILOT_EVAL_MODE', 'true');
    const promptPath = buildPrompt(pollerIssue('TEST-EVAL-4'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain('simulate');
    expect(prompt).toContain('skipCommitValidation: true');
    expect(prompt).toMatch(/placeholder.*commit_hash/i);
  });

  it.each(PHASES)(
    'AUTOPILOT_EVAL_MODE=true replaces "Deployment Phase: %s" with eval-mode variant',
    (phase) => {
      vi.stubEnv('AUTOPILOT_EVAL_MODE', 'true');
      const promptPath = buildPrompt(pollerIssue('TEST-EVAL-5'), baseConfig(phase, 'pr', stateDir));
      const prompt = readPrompt(promptPath);

      const phaseTitle = phase.charAt(0).toUpperCase() + phase.slice(1);
      expect(prompt).toContain(`### Deployment Phase: ${phaseTitle} (Eval Mode)`);
      expect(prompt).toContain('Phase semantics are simulated only');

      // The production deployment-phase bullets must NOT appear.
      expect(prompt).not.toContain('Auto-commit only high-confidence single-file fixes.');
      expect(prompt).not.toContain("Auto-commit all high-confidence fixes that satisfy the workflow's safety gates.");
    },
  );

  it('AUTOPILOT_EVAL_MODE unset preserves the production Autopilot Branch Convention (regression guard)', () => {
    vi.stubEnv('AUTOPILOT_EVAL_MODE', '');
    const promptPath = buildPrompt(pollerIssue('TEST-EVAL-6'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain(PRODUCTION_HEADING);
    expect(prompt).toContain('git checkout -B autopilot/sentry-TEST-EVAL-6 origin/dev');
    expect(prompt).not.toContain(EVAL_HEADING);
  });

  it('AUTOPILOT_EVAL_MODE=false (non-"true" string) behaves like unset (strict equality)', () => {
    vi.stubEnv('AUTOPILOT_EVAL_MODE', 'false');
    const promptPath = buildPrompt(pollerIssue('TEST-EVAL-7'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain(PRODUCTION_HEADING);
    expect(prompt).not.toContain(EVAL_HEADING);
  });

  it('AUTOPILOT_EVAL_MODE=true composes with the Stage B Outcome Contract section', () => {
    vi.stubEnv('AUTOPILOT_EVAL_MODE', 'true');
    const promptPath = buildPrompt(pollerIssue('TEST-EVAL-8'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain('### Outcome Contract — outcome.json field types (STRICT)');
    expect(prompt).toContain(EVAL_HEADING);

    const contractIdx = prompt.indexOf('### Outcome Contract');
    const evalIdx = prompt.indexOf(EVAL_HEADING);
    expect(contractIdx).toBeGreaterThan(-1);
    expect(evalIdx).toBeGreaterThan(contractIdx);
  });
});
