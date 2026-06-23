/**
 * Stage E — prompt-builder pushMode tests.
 *
 * For pushMode permutations the prompt must:
 *   - `disabled`: stay quiet about push commands; explain push is off.
 *   - `branch_only`: include git-safe-sync push instructions but explicitly
 *     note that NO PR will be opened (operator picks up from there).
 *   - `pr`: include push instructions AND mention that the reporter opens
 *     the PR automatically (bugfixer must not open it manually).
 *
 * All modes must keep the "Autopilot Branch Convention" + branch_name in
 * outcome.json instructions (Stage D contract preserved under Stage E).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-prompt-pushmode-'));
  tempDirs.push(dir);
  return dir;
}

function baseConfig(
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
    phase: 'full',
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

function readPrompt(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

describe('buildPrompt pushMode handling (Stage E)', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = tempStateDir();
  });

  it('disabled mode: no push command instructions; branch convention still present', () => {
    const prompt = readPrompt(buildPrompt(pollerIssue('REBEL-D'), baseConfig('disabled', stateDir)));
    expect(prompt).toContain('### Autopilot Branch Convention');
    expect(prompt).toContain('autopilot/sentry-REBEL-D');
    expect(prompt).toMatch(/Push is NOT attempted/);
    expect(prompt).not.toMatch(/scripts\/git-safe-sync\.ts.*--branch=autopilot/);
    expect(prompt).not.toContain('reporter will open a pull request');
  });

  it('branch_only mode: push command included, but no PR-opening promise', () => {
    const prompt = readPrompt(buildPrompt(pollerIssue('REBEL-BO'), baseConfig('branch_only', stateDir)));
    expect(prompt).toContain('### Push the autopilot branch');
    expect(prompt).toContain(
      'flock -w 300 /tmp/sentry-autopilot-push.lock npx tsx scripts/git-safe-sync.ts --branch=autopilot/sentry-REBEL-BO --no-advance-submodules',
    );
    expect(prompt).toContain('no PR will be opened');
    expect(prompt).not.toContain('reporter will open a pull request');
  });

  it('pr mode: push command included AND PR-opening promise present', () => {
    const prompt = readPrompt(buildPrompt(pollerIssue('REBEL-PR'), baseConfig('pr', stateDir)));
    expect(prompt).toContain('### Push the autopilot branch');
    expect(prompt).toContain(
      'flock -w 300 /tmp/sentry-autopilot-push.lock npx tsx scripts/git-safe-sync.ts --branch=autopilot/sentry-REBEL-PR --no-advance-submodules',
    );
    expect(prompt).toContain('reporter will open a pull request');
    expect(prompt).toContain('do NOT need to open the PR yourself');
  });

  it('all push modes preserve the branch_name outcome.json requirement', () => {
    for (const mode of ['disabled', 'branch_only', 'pr'] as const) {
      const prompt = readPrompt(buildPrompt(pollerIssue('REBEL-X'), baseConfig(mode, stateDir)));
      expect(prompt).toContain('`"branch_name"`');
    }
  });

  it('branch_only and pr modes explicitly forbid raw git push', () => {
    for (const mode of ['branch_only', 'pr'] as const) {
      const prompt = readPrompt(buildPrompt(pollerIssue('REBEL-Y'), baseConfig(mode, stateDir)));
      expect(prompt).toMatch(/Do NOT use raw `git push`/);
    }
  });
});
