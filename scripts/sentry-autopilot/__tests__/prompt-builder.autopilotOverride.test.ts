import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { buildAutopilotSessionOverrideSection, buildPrompt } from '../prompt-builder.ts';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-autopilot-prompt-override-'));
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

const OVERRIDE_HEADING = '## Autopilot Session Override (precedes inherited guidance)';
const MCP_WHOAMI_TOOL = ['mcp', 'sentry', 'whoami'].join('__');
const DO_NOT_RUN_PRECEDENCE =
  `**MCP probe instructions: do NOT run.** Do not call \`${MCP_WHOAMI_TOOL}\`. Do not run the \`mcp probe\` step.`;
const SUPERSEDES_PRECEDENCE =
  'This override supersedes the MCP-first guidance in `coding-agent-instructions/workflows/CHIEF_BUGFIXER.md` Phase 0 preflight and `coding-agent-instructions/docs/SENTRY_REST_FALLBACK.md` § Probe — both are inapplicable here.';
const CANONICAL_ENDPOINTS = [
  'GET ${SENTRY_API_BASE_URL}/api/0/issues/{issue_id}/',
  'GET ${SENTRY_API_BASE_URL}/api/0/issues/{issue_id}/events/latest/',
  'GET ${SENTRY_API_BASE_URL}/api/0/issues/{issue_id}/events/?full=true&limit=10',
  'GET ${SENTRY_API_BASE_URL}/api/0/issues/{issue_id}/hashes/',
  'GET ${SENTRY_API_BASE_URL}/api/0/organizations/{org}/releases/?per_page=20',
] as const;

describe('buildPrompt autopilot session override', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = tempStateDir();
  });

  it('renders the autopilot override at the top before inherited bug-fixer guidance', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', 'bugfixer');
    const prompt = readPrompt(buildPrompt(pollerIssue('TEST-OVERRIDE-1'), baseConfig('full', 'pr', stateDir)));

    expect(prompt).toContain(OVERRIDE_HEADING);
    expect(prompt).toContain(DO_NOT_RUN_PRECEDENCE);
    expect(prompt).toContain(SUPERSEDES_PRECEDENCE);

    const overrideIdx = prompt.indexOf(OVERRIDE_HEADING);
    const workflowIdx = prompt.indexOf('## Critical Workflow Instruction');
    const bugDetailsIdx = prompt.indexOf('## Bug Details');

    expect(overrideIdx).toBeGreaterThan(prompt.indexOf('AUTOPILOT_PHASE: full'));
    expect(overrideIdx).toBeLessThan(workflowIdx);
    expect(overrideIdx).toBeLessThan(bugDetailsIdx);
  });

  it('lists all canonical REST endpoints and auth environment-variable placeholders verbatim', () => {
    const prompt = readPrompt(buildPrompt(pollerIssue('TEST-OVERRIDE-2'), baseConfig('shadow', 'disabled', stateDir)));

    for (const endpoint of CANONICAL_ENDPOINTS) {
      expect(prompt).toContain(endpoint);
    }
    expect(prompt).toContain('Authorization: Bearer ${SENTRY_AUTH_TOKEN}');
    expect(prompt).toContain('${SENTRY_ORG}');
    expect(prompt).toContain('${SENTRY_PROJECT}');
  });

  it('explicitly names the MCP probe mechanisms that must not run', () => {
    const prompt = readPrompt(buildPrompt(pollerIssue('TEST-OVERRIDE-3'), baseConfig('shadow', 'disabled', stateDir)));

    expect(prompt).toContain(MCP_WHOAMI_TOOL);
    expect(prompt).toContain('mcp probe');
    expect(prompt).toContain('do NOT run');
  });

  it('composes with the CE2 autopilot workflow branch before CE2 inherited guidance', () => {
    vi.stubEnv('AUTOPILOT_WORKFLOW', 'ce2');
    const prompt = readPrompt(buildPrompt(pollerIssue('TEST-OVERRIDE-CE2'), baseConfig('full', 'pr', stateDir)));

    const overrideIdx = prompt.indexOf(OVERRIDE_HEADING);
    const ce2ReferenceIdx = prompt.indexOf(
      'Loaded coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2_AUTONOMOUS.md',
    );
    const ce2InstructionIdx = prompt.indexOf('Use **CHIEF_ENGINEER2 (CE2)**');

    expect(overrideIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeLessThan(ce2ReferenceIdx);
    expect(overrideIdx).toBeLessThan(ce2InstructionIdx);
  });

  it('composes with eval mode while keeping the override before eval-mode branch guidance', () => {
    vi.stubEnv('AUTOPILOT_EVAL_MODE', 'true');
    const prompt = readPrompt(buildPrompt(pollerIssue('TEST-OVERRIDE-EVAL'), baseConfig('full', 'pr', stateDir)));

    const overrideIdx = prompt.indexOf(OVERRIDE_HEADING);
    const evalModeIdx = prompt.indexOf('### Eval Mode — No Repo Mutations (AUTOPILOT_EVAL_MODE=true)');

    expect(overrideIdx).toBeGreaterThan(-1);
    expect(evalModeIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeLessThan(evalModeIdx);
  });

  it('keeps the verbatim override text centralized for eval assertions', () => {
    expect(buildAutopilotSessionOverrideSection()).toContain(DO_NOT_RUN_PRECEDENCE);
    expect(buildAutopilotSessionOverrideSection()).toContain(SUPERSEDES_PRECEDENCE);
  });

  it('does not write the autopilot-only override into shared interactive workflow docs', () => {
    const sharedDocs = [
      path.join(REPO_ROOT, 'coding-agent-instructions', 'workflows', 'CHIEF_BUGFIXER.md'),
      path.join(REPO_ROOT, 'coding-agent-instructions', 'docs', 'SENTRY_REST_FALLBACK.md'),
      path.join(
        REPO_ROOT,
        'coding-agent-instructions',
        'workflows',
        'CHIEF_ENGINEER2',
        'CHIEF_ENGINEER2.md',
      ),
    ];

    for (const sharedDoc of sharedDocs) {
      expect(fs.readFileSync(sharedDoc, 'utf8')).not.toContain(OVERRIDE_HEADING);
    }
  });
});
