/**
 * Stage 2 — prompt-builder User-Reported Bug Context section tests.
 *
 * When a Sentry issue originates from the user feedback widget
 * (`isUserReported === true`), the prompt must contain a dedicated
 * "User-Reported Bug Context" section that instructs the agent to:
 *   - Draft a non-technical user response after investigation
 *   - Greet the reporter by their first name when one is available
 *   - Fall back to a neutral greeting when no reporter name is available
 *   - Promise a timeline only if the fix was actually committed to dev
 *
 * Non-user-reported issues must NOT include this section.
 *
 * Source of truth: docs/plans/260528_autopilot-user-response-draft/PLAN.md (Stage 2).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-prompt-user-reported-'));
  tempDirs.push(dir);
  return dir;
}

function baseConfig(stateDir: string): AutopilotConfig {
  return {
    sentryAuthToken: 'token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: undefined,
    githubToken: undefined,
    repoFullName: undefined,
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
  };
}

function userReportedIssue(overrides: Partial<PolledIssue> = {}): PolledIssue {
  return {
    sentryId: 'REBEL-USER-REPORTED',
    sentryUrl: 'https://sentry.io/issues/REBEL-USER-REPORTED',
    title: 'A bug a user reported',
    errorType: 'feedback',
    level: 'error',
    occurrences: 1,
    users: 1,
    isUserReported: true,
    userDescription: 'I clicked the button and nothing happened.',
    firstSeen: '2026-05-15T00:00:00Z',
    lastSeen: '2026-05-15T01:00:00Z',
    ...overrides,
  };
}

function nonUserReportedIssue(): PolledIssue {
  return {
    sentryId: 'REBEL-EXCEPTION',
    sentryUrl: 'https://sentry.io/issues/REBEL-EXCEPTION',
    title: 'A regular exception',
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

const SECTION_HEADING = '## User-Reported Bug Context';
const DRAFT_HEADING = '### Draft User Response';
const TIMELINE_HEADING = '**Timeline language — read carefully:**';

describe('buildPrompt User-Reported Bug Context section (Stage 2)', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = tempStateDir();
  });

  describe('section presence', () => {
    it('includes the User-Reported Bug Context section when isUserReported is true', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue(), baseConfig(stateDir)));
      expect(prompt).toContain(SECTION_HEADING);
      expect(prompt).toContain(DRAFT_HEADING);
    });

    it('omits the User-Reported Bug Context section when isUserReported is false', () => {
      const prompt = readPrompt(buildPrompt(nonUserReportedIssue(), baseConfig(stateDir)));
      expect(prompt).not.toContain(SECTION_HEADING);
      expect(prompt).not.toContain(DRAFT_HEADING);
      expect(prompt).not.toContain(TIMELINE_HEADING);
    });
  });

  describe('user description', () => {
    it('includes the user description in a fenced block', () => {
      const description = 'I clicked the save button and lost my work.';
      const prompt = readPrompt(buildPrompt(userReportedIssue({ userDescription: description }), baseConfig(stateDir)));
      expect(prompt).toContain('**User description**');
      expect(prompt).toContain(description);
    });
  });

  describe('reporter name handling', () => {
    it('includes the reporter name in a fenced block when present', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue({ userName: 'Alice Example' }), baseConfig(stateDir)));
      expect(prompt).toContain('**Reporter name (if available)**');
      expect(prompt).toContain('Alice Example');
    });

    it('instructs the agent to address the reporter by first name when a name is present', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue({ userName: 'Alice Example' }), baseConfig(stateDir)));
      expect(prompt).toMatch(/Address the reporter by their first name where natural/);
      expect(prompt).toMatch(/take the first token/);
    });

    it('flags email-shaped and Anonymous values as not-a-real-first-name in the name guidance', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue({ userName: 'Alice Example' }), baseConfig(stateDir)));
      expect(prompt).toMatch(/email-shaped/);
      expect(prompt).toMatch(/Anonymous/);
    });

    it('falls back to a neutral greeting when reporter name is missing', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue({ userName: undefined }), baseConfig(stateDir)));
      expect(prompt).toMatch(/No reporter name is available, so do not invent one/);
      expect(prompt).toMatch(/Hi there/);
      expect(prompt).toContain('(not provided)');
    });

    it('falls back to neutral greeting when reporter name is an empty string', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue({ userName: '' }), baseConfig(stateDir)));
      expect(prompt).toMatch(/No reporter name is available, so do not invent one/);
      expect(prompt).toContain('(not provided)');
    });

    it('falls back to neutral greeting when reporter name is only whitespace', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue({ userName: '   ' }), baseConfig(stateDir)));
      expect(prompt).toMatch(/No reporter name is available, so do not invent one/);
      expect(prompt).toContain('(not provided)');
    });
  });

  describe('draft response instructions', () => {
    it('forbids technical content in the draft', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue(), baseConfig(stateDir)));
      expect(prompt).toMatch(/Do NOT include code, stack traces, error names, file paths, or jargon/);
    });

    it('forbids including a subject line in the draft', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue(), baseConfig(stateDir)));
      expect(prompt).toMatch(/Do NOT include a subject line/);
    });

    it('writes the draft to a deterministic path under the artifact directory', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue(), baseConfig(stateDir)));
      expect(prompt).toContain('user_response_draft.md');
      expect(prompt).toMatch(/artifacts\/REBEL-USER-REPORTED\/user_response_draft\.md/);
    });

    it('describes the expected tone (warm, professional, concise)', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue(), baseConfig(stateDir)));
      expect(prompt).toMatch(/warm, professional, and concise/);
    });

    it('enumerates the required components of the draft', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue(), baseConfig(stateDir)));
      expect(prompt).toMatch(/Thank the reporter/);
      expect(prompt).toMatch(/Acknowledge the specific behaviour/);
      expect(prompt).toMatch(/Explain in plain language what was happening/);
      expect(prompt).toMatch(/Explain in plain language what we did about it/);
      expect(prompt).toMatch(/Close with a brief, friendly sign-off/);
    });
  });

  describe('timeline language guidance', () => {
    it('includes the Timeline language heading when isUserReported is true', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue(), baseConfig(stateDir)));
      expect(prompt).toContain(TIMELINE_HEADING);
    });

    it('allows a soft timeline only when the fix is committed to dev', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue(), baseConfig(stateDir)));
      expect(prompt).toMatch(/If, and only if, you have just auto-committed a fix to the `dev` branch/);
      expect(prompt).toMatch(/typically within a few days/);
      expect(prompt).toMatch(/soft expectation, not a guarantee/);
      expect(prompt).toMatch(/never give a specific date/);
    });

    it('forbids promising any timeline when the fix has not been committed to dev', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue(), baseConfig(stateDir)));
      expect(prompt).toMatch(/If the fix has NOT been committed to `dev`/);
      expect(prompt).toMatch(/do NOT promise any timeline/);
      expect(prompt).toMatch(/we're working on it/);
      expect(prompt).toMatch(/the team is looking into it/);
    });

    it('instructs the agent to err toward saying less when uncertain', () => {
      const prompt = readPrompt(buildPrompt(userReportedIssue(), baseConfig(stateDir)));
      expect(prompt).toMatch(/When in doubt, say less rather than more/);
      expect(prompt).toMatch(/A vague honest answer beats a specific one we can't keep/);
    });
  });
});
