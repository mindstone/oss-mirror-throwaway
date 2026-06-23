import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { StateDB } from '../state.ts';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import { checkCommitResolutions } from '../poller.ts';

const dirs: string[] = [];
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poller-check-commit-resolutions-'));
  dirs.push(dir);
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
    maxHourly: 10,
    maxDaily: 100,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: REPO_ROOT,
    cli: 'droid',
    cursorModel: 'composer-2.5',
    claudeModel: 'claude-opus-4-8',
  };
}

let db: StateDB;
let config: AutopilotConfig;

beforeEach(() => {
  execFileMock.mockReset();
  const stateDir = tmpDir();
  db = new StateDB(path.join(stateDir, 'state.db'));
  config = makeConfig(stateDir);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('checkCommitResolutions', () => {
  it('completes deferred rows when recent autopilot commit subjects mention their sentry id', async () => {
    db.upsertIssue({
      sentry_id: 'SENTRY-DEFERRED-COMMIT',
      sentry_url: 'https://sentry.io/issues/SENTRY-DEFERRED-COMMIT',
      title: 'Deferred issue for commit check',
      status: 'deferred',
      max_retries: 2,
    });

    execFileMock.mockImplementation(
      (
        _command: string,
        _args: readonly string[],
        _options: unknown,
        callback: (
          error: Error | null,
          value: { stdout: string; stderr: string },
        ) => void,
      ) => {
        callback(null, {
          stdout: 'abc123\tfix(autopilot): resolve SENTRY-DEFERRED-COMMIT [autopilot]\n',
          stderr: '',
        });
      },
    );

    await checkCommitResolutions(config, db);

    const row = db.getIssue('SENTRY-DEFERRED-COMMIT');
    expect(row?.status).toBe('completed');
    expect(row?.outcome).toBe('commit_detected');
    expect(row?.commit_hash).toBe('abc123');
  });
});
