/**
 * Stage 2 spike: measure buildPrompt() output size.
 *
 * Calls buildPrompt with a synthetic Sentry issue + maximal config, writes the
 * generated prompt to /tmp and reports byte / character / line counts. Used to
 * confirm we are nowhere near ARG_MAX before deciding cursor-agent invocation
 * shape (positional arg vs stdin).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AutopilotConfig } from './config.ts';
import { buildPrompt } from './prompt-builder.ts';
import type { PolledIssue } from './poller.ts';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-spike-'));
}

function syntheticIssue(): PolledIssue {
  return {
    sentryId: 'SPIKE-12345',
    sentryUrl: 'https://sentry.io/organizations/mindstone/issues/SPIKE-12345/',
    title: 'TypeError: Cannot read properties of undefined (reading "id") in checkout flow',
    errorType: 'TypeError',
    level: 'error',
    occurrences: 1284,
    users: 412,
    isUserReported: false,
    firstSeen: '2026-05-20T00:00:00Z',
    lastSeen: '2026-05-31T01:00:00Z',
  };
}

function syntheticConfig(stateDir: string): AutopilotConfig {
  return {
    sentryAuthToken: 'sntrys_FAKE',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: undefined,
    githubToken: 'ghp_FAKE',
    repoFullName: 'mindstone/rebel-app',
    phase: 'full',
    verifyMode: 'enforce',
    pushMode: 'pr',
    pendingMode: 'enforce',
    stateDir,
    maxConcurrent: 1,
    maxHourly: 1,
    maxDaily: 1,
    maxRetries: 2,
    sessionTimeoutSeconds: 3600,
    bootstrapLookbackHours: 24,
    repoRoot: REPO_ROOT,
    cli: 'cursor',
    cursorApiKey: 'cur_FAKE',
    cursorModel: 'composer-2.5',
    claudeModel: 'claude-opus-4-8',
  };
}

function main(): void {
  const stateDir = makeStateDir();
  const issue = syntheticIssue();
  const config = syntheticConfig(stateDir);

  const promptPath = buildPrompt(issue, config);
  const prompt = fs.readFileSync(promptPath, 'utf8');

  const bytes = Buffer.byteLength(prompt, 'utf8');
  const chars = prompt.length;
  const lines = prompt.split('\n').length;

  console.log('Sentry Autopilot Stage 2 spike — buildPrompt size measurement');
  console.log('---------------------------------------------------------------');
  console.log(`stateDir:    ${stateDir}`);
  console.log(`promptPath:  ${promptPath}`);
  console.log(`bytes:       ${bytes.toLocaleString()}`);
  console.log(`chars:       ${chars.toLocaleString()}`);
  console.log(`lines:       ${lines.toLocaleString()}`);
  console.log('');
  console.log('Reference limits:');
  console.log('  Linux ARG_MAX (default):  ~131,072 bytes (`getconf ARG_MAX`)');
  console.log('  Linux ARG_MAX (Hetzner):  ~2,097,152 bytes on most kernels');
  console.log('  macOS ARG_MAX:            ~262,144 bytes');
  console.log('');
  console.log('First 400 chars of prompt:');
  console.log('---');
  console.log(prompt.slice(0, 400));
  console.log('---');
}

main();
