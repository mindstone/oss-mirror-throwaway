/**
 * Stage 5.7 (CE2 wrapper) — prompt-builder Workflow Switch (AUTOPILOT_WORKFLOW) tests.
 *
 * When AUTOPILOT_WORKFLOW=ce2 the prompt MUST:
 *  - Reference the CE2 autonomous-mode entry point
 *    (`coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2_AUTONOMOUS.md`).
 *  - Instruct the agent to use CHIEF_ENGINEER2, not CHIEF_BUGFIXER.
 *  - Tell the agent to write the autopilot cost-prune frontmatter
 *    (`bug_mode: true`, `review_mode: light`) into the plan doc.
 *  - Continue to compose with the eval-mode and outcome-contract sections that
 *    bugfixer mode already exercises.
 *
 * Source: docs/plans/260605_autopilot-autonomous-migration/PLAN.md
 *         coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2_AUTONOMOUS.md
 *         scripts/sentry-autopilot/prompt-builder.ts (getWorkflowChoice,
 *         readTemplateReference, buildWorkflowInstructionSection).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-prompt-ce2-'));
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

const CE2_WORKFLOW_HEADING = 'Use **CHIEF_ENGINEER2 (CE2)**, not CHIEF_BUGFIXER and not CHIEF_ENGINEER.';
const BUGFIXER_WORKFLOW_HEADING = 'Use **CHIEF_BUGFIXER**, not CHIEF_ENGINEER.';
const CE2_AUTONOMOUS_PATH = 'coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2_AUTONOMOUS.md';
const CE2_WORKFLOW_PATH = 'coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md';
const LEGACY_OVERLAY_PATH = 'factory/sentry-auto-fix-ce2.md';
const BUGFIXER_WORKFLOW_PATH = 'coding-agent-instructions/workflows/CHIEF_BUGFIXER.md';

describe('buildPrompt CE2 workflow switch (AUTOPILOT_WORKFLOW=ce2)', () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = tempStateDir();
  });

  it('AUTOPILOT_WORKFLOW=ce2 emits the CE2 critical workflow instruction', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', 'ce2');
    const promptPath = buildPrompt(pollerIssue('TEST-CE2-1'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain('## Critical Workflow Instruction');
    expect(prompt).toContain(CE2_WORKFLOW_HEADING);
    expect(prompt).not.toContain(BUGFIXER_WORKFLOW_HEADING);
  });

  it('AUTOPILOT_WORKFLOW=ce2 signposts the AUTONOMOUS.md entry point AND the full CE2 workflow file', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', 'ce2');
    const promptPath = buildPrompt(pollerIssue('TEST-CE2-2'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain(CE2_AUTONOMOUS_PATH);
    expect(prompt).toContain(CE2_WORKFLOW_PATH);
    expect(prompt).toContain('docs/project/CODING_PRINCIPLES.md');
    expect(prompt).not.toContain(`- \`${BUGFIXER_WORKFLOW_PATH}\``);
    expect(prompt).not.toContain(LEGACY_OVERLAY_PATH);
  });

  it('AUTOPILOT_WORKFLOW=ce2 instructs the agent to write cost-prune frontmatter (bug_mode + review_mode: light) into the plan doc', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', 'ce2');
    const promptPath = buildPrompt(pollerIssue('TEST-CE2-COST-PRUNE'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain('### Cost-Pruning Directives');
    expect(prompt).toContain('bug_mode: true');
    expect(prompt).toContain('review_mode: light');
    expect(prompt).toMatch(/YAML frontmatter/i);
    expect(prompt).toMatch(/docs\/plans\/<slug>\/PLAN\.md/);
  });

  it('AUTOPILOT_WORKFLOW=ce2 highlights that CE2 bug_mode covers the same ground as CHIEF_BUGFIXER', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', 'ce2');
    const promptPath = buildPrompt(pollerIssue('TEST-CE2-3'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain('`bug_mode: true`');
    expect(prompt).toMatch(/same ground as CHIEF_BUGFIXER/);
  });

  it('AUTOPILOT_WORKFLOW=ce2 retains autonomous-mode language for unattended sessions', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', 'ce2');
    const promptPath = buildPrompt(pollerIssue('TEST-CE2-4'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain('unattended automated session');
    expect(prompt).toMatch(/Do not ask the user questions/i);
  });

  it('AUTOPILOT_WORKFLOW=ce2 composes with the Stage B Outcome Contract section', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', 'ce2');
    const promptPath = buildPrompt(pollerIssue('TEST-CE2-5'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain('### Outcome Contract — outcome.json field types (STRICT)');
    expect(prompt).toContain(CE2_WORKFLOW_HEADING);
  });

  it('AUTOPILOT_WORKFLOW=ce2 emits diagnosis_confidence as a typed contract field with [0, 1] scale', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', 'ce2');
    const promptPath = buildPrompt(pollerIssue('TEST-CE2-DIAG-CONF'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toMatch(/`diagnosis_confidence` — JSON number/);
    expect(prompt).toMatch(/closed interval `\[0, 1\]`/);
    expect(prompt).toMatch(/Required when CE2 `bug_mode: true` is engaged/);
    expect(prompt).toMatch(/distinct from the typed integer `confidence` \(0-100\)/i);
  });

  it('AUTOPILOT_WORKFLOW=ce2 emits a CE2-aligned Required Review Mode (light, not sextuple)', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', 'ce2');
    const promptPath = buildPrompt(pollerIssue('TEST-CE2-REVIEW-MODE'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain('## Required Review Mode');
    expect(prompt).toMatch(/CE2 `review_mode: light`/);
    expect(prompt).toMatch(/diagnosis confidence is at least 0\.9/);
    expect(prompt).not.toMatch(/sextuple investigation\/review/);
  });

  it('AUTOPILOT_WORKFLOW=ce2 composes with the production Autopilot Branch Convention when eval mode is off', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', 'ce2');
    vi.stubEnv('AUTOPILOT_EVAL_MODE', '');
    const promptPath = buildPrompt(pollerIssue('TEST-CE2-6'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain('### Autopilot Branch Convention');
    expect(prompt).toContain('git checkout -B autopilot/sentry-TEST-CE2-6 origin/dev');
    expect(prompt).toContain(CE2_WORKFLOW_HEADING);
  });

  it('AUTOPILOT_WORKFLOW=ce2 composes with the Eval Mode override when AUTOPILOT_EVAL_MODE=true', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', 'ce2');
    vi.stubEnv('AUTOPILOT_EVAL_MODE', 'true');
    const promptPath = buildPrompt(pollerIssue('TEST-CE2-7'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain('### Eval Mode — No Repo Mutations (AUTOPILOT_EVAL_MODE=true)');
    expect(prompt).not.toContain('### Autopilot Branch Convention');
    expect(prompt).toContain(CE2_WORKFLOW_HEADING);

    expect(prompt).not.toMatch(/^\s*git checkout -B /m);
    expect(prompt).not.toMatch(/^\s*git branch --set-upstream-to=/m);
  });

  it.each(['shadow', 'guarded', 'full'] as const)(
    'AUTOPILOT_WORKFLOW=ce2 + phase=%s still renders the phase section (no workflow leakage)',
    (phase) => {
      vi.stubEnv('AUTOPILOT_WORKFLOW', 'ce2');
      const promptPath = buildPrompt(pollerIssue('TEST-CE2-8'), baseConfig(phase, 'pr', stateDir));
      const prompt = readPrompt(promptPath);

      const phaseTitle = phase.charAt(0).toUpperCase() + phase.slice(1);
      expect(prompt).toContain(`### Deployment Phase: ${phaseTitle}`);
      expect(prompt).toContain(CE2_WORKFLOW_HEADING);
      expect(prompt).not.toContain(BUGFIXER_WORKFLOW_HEADING);
    },
  );

  it('AUTOPILOT_WORKFLOW unset preserves the bugfixer critical workflow (regression guard)', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', '');
    const promptPath = buildPrompt(pollerIssue('TEST-CE2-9'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain(BUGFIXER_WORKFLOW_HEADING);
    expect(prompt).toContain(BUGFIXER_WORKFLOW_PATH);
    expect(prompt).not.toContain(CE2_WORKFLOW_HEADING);
    expect(prompt).not.toContain(CE2_AUTONOMOUS_PATH);
    expect(prompt).not.toContain(LEGACY_OVERLAY_PATH);
    // Bugfixer path keeps the legacy sextuple-investigation review mode and does
    // not introduce CE2-specific contract clauses.
    expect(prompt).toMatch(/sextuple investigation\/review/);
    expect(prompt).not.toMatch(/`diagnosis_confidence` — JSON number/);
  });

  it('AUTOPILOT_WORKFLOW=bugfixer (explicit) preserves the bugfixer critical workflow', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', 'bugfixer');
    const promptPath = buildPrompt(pollerIssue('TEST-CE2-10'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain(BUGFIXER_WORKFLOW_HEADING);
    expect(prompt).not.toContain(CE2_WORKFLOW_HEADING);
  });

  it('AUTOPILOT_WORKFLOW=Ce2 (case-insensitive) is accepted as ce2', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', 'Ce2');
    const promptPath = buildPrompt(pollerIssue('TEST-CE2-11'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain(CE2_WORKFLOW_HEADING);
    expect(prompt).not.toContain(BUGFIXER_WORKFLOW_HEADING);
  });

  it('AUTOPILOT_WORKFLOW with an unknown value falls back to bugfixer (does NOT throw)', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', 'sonnet5');
    const promptPath = buildPrompt(pollerIssue('TEST-CE2-12'), baseConfig('full', 'pr', stateDir));
    const prompt = readPrompt(promptPath);

    expect(prompt).toContain(BUGFIXER_WORKFLOW_HEADING);
    expect(prompt).not.toContain(CE2_WORKFLOW_HEADING);
  });
});
