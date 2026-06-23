/**
 * Stage D — prompt-builder autopilot-branch-instruction tests.
 *
 * The bugfixer needs to know to create `autopilot/sentry-<id>` BEFORE
 * committing. These tests assert that the prompt:
 *   - mentions the branch by the exact safePathSegment'd name
 *   - emits the `git checkout -B ... origin/dev` command
 *   - sets the upstream to origin/dev so first push (Stage E) finds a tracking branch
 *   - tells the bugfixer to include `branch_name` in outcome.json
 *   - replaces the legacy "commit to dev" instruction with the autopilot branch in guarded/full phases
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-prompt-'));
  tempDirs.push(dir);
  return dir;
}

function baseConfig(phase: AutopilotConfig['phase'], stateDir: string): AutopilotConfig {
  return {
    sentryAuthToken: 'token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: undefined,
    phase,
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

function pollerIssue(id: string): PolledIssue {
  return {
    sentryId: id,
    sentryUrl: `https://sentry.io/issues/${id}`,
    title: 'TypeError: cannot read x of undefined',
    errorType: 'exception',
    level: 'error',
    occurrences: 5,
    users: 2,
    isUserReported: false,
    firstSeen: '2026-05-15T00:00:00Z',
    lastSeen: '2026-05-15T01:00:00Z',
  };
}

function loadPrompt(promptPath: string): string {
  return fs.readFileSync(promptPath, 'utf8');
}

describe('buildPrompt autopilot branch instructions (Stage D)', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = tempStateDir();
  });

  it('instructs the bugfixer to checkout autopilot/sentry-<id> before committing', () => {
    const promptPath = buildPrompt(pollerIssue('REBEL-1234'), baseConfig('full', stateDir));
    const prompt = loadPrompt(promptPath);
    expect(prompt).toContain('### Autopilot Branch Convention');
    expect(prompt).toContain('git checkout -B autopilot/sentry-REBEL-1234 origin/dev');
    expect(prompt).toContain('git branch --set-upstream-to=origin/dev autopilot/sentry-REBEL-1234');
  });

  it('forbids committing on dev or main', () => {
    const promptPath = buildPrompt(pollerIssue('REBEL-1234'), baseConfig('full', stateDir));
    const prompt = loadPrompt(promptPath);
    expect(prompt).toContain('NOT `dev`');
    expect(prompt).toMatch(/main.*dev.*outside.*autopilot/i);
  });

  it('tells the bugfixer to write branch_name into outcome.json', () => {
    const promptPath = buildPrompt(pollerIssue('REBEL-9'), baseConfig('full', stateDir));
    const prompt = loadPrompt(promptPath);
    expect(prompt).toContain('"branch_name": "autopilot/sentry-REBEL-9"');
  });

  it('uses the safePathSegment-sanitized id (slashes replaced with underscore)', () => {
    const promptPath = buildPrompt(pollerIssue('REBEL/with/slash'), baseConfig('full', stateDir));
    const prompt = loadPrompt(promptPath);
    expect(prompt).toContain('autopilot/sentry-REBEL_with_slash');
    expect(prompt).not.toContain('autopilot/sentry-REBEL/with/slash');
  });

  it('emits guidance for plan_created commits on the autopilot branch', () => {
    const promptPath = buildPrompt(pollerIssue('REBEL-77'), baseConfig('full', stateDir));
    const prompt = loadPrompt(promptPath);
    expect(prompt).toContain('docs(autopilot): plan for Sentry REBEL-77');
  });

  it('shadow phase still warns about not committing or pushing', () => {
    const promptPath = buildPrompt(pollerIssue('REBEL-77'), baseConfig('shadow', stateDir));
    const prompt = loadPrompt(promptPath);
    expect(prompt).toContain('### Deployment Phase: Shadow');
    expect(prompt).toContain('Do not commit or push changes');
    // The autopilot-branch section is still present so the bugfixer knows to
    // include branch_name even when nothing is committed.
    expect(prompt).toContain('### Autopilot Branch Convention');
  });

  it('guarded and full phases route commits to the autopilot branch (not dev)', () => {
    const guarded = loadPrompt(buildPrompt(pollerIssue('REBEL-42'), baseConfig('guarded', stateDir)));
    const full = loadPrompt(buildPrompt(pollerIssue('REBEL-42'), baseConfig('full', stateDir)));
    expect(guarded).toMatch(/autopilot\/sentry-REBEL-42[^\n]*NOT `dev`/);
    expect(full).toMatch(/autopilot\/sentry-REBEL-42[^\n]*NOT `dev`/);
  });
});
