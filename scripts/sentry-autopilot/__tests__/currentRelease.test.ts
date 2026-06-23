import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';

const dirs: string[] = [];

function tempRepo(version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-release-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }, null, 2));
  return dir;
}

function makeConfig(repoRoot: string): AutopilotConfig {
  return {
    sentryAuthToken: 'token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: undefined,
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    pendingMode: 'enforce',
    stateDir: '/tmp/sentry-autopilot',
    maxConcurrent: 1,
    maxHourly: 1,
    maxDaily: 1,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot,
    cli: 'droid',
    cursorModel: 'composer-2.5',
    claudeModel: 'claude-opus-4-8',
  };
}

async function importCurrentRelease(): Promise<typeof import('../triage/currentRelease.ts')> {
  vi.resetModules();
  return import('../triage/currentRelease.ts');
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('getCurrentRelease', () => {
  it('uses AUTOPILOT_CURRENT_RELEASE when set', async () => {
    vi.stubEnv('AUTOPILOT_CURRENT_RELEASE', 'v1.2.3');
    const { getCurrentRelease } = await importCurrentRelease();

    await expect(getCurrentRelease(makeConfig(tempRepo('9.9.9')))).resolves.toBe('v1.2.3');
  });

  it('falls back to package.json version when the env override is missing', async () => {
    const { getCurrentRelease } = await importCurrentRelease();

    await expect(getCurrentRelease(makeConfig(tempRepo('0.4.46')))).resolves.toBe('v0.4.46');
  });

  it('returns null when the env override is not semver-shaped', async () => {
    vi.stubEnv('AUTOPILOT_CURRENT_RELEASE', 'not-a-release');
    const { getCurrentRelease } = await importCurrentRelease();

    await expect(getCurrentRelease(makeConfig(tempRepo('0.4.46')))).resolves.toBeNull();
  });

  it('returns null when package.json version is not semver-shaped', async () => {
    const { getCurrentRelease } = await importCurrentRelease();

    await expect(getCurrentRelease(makeConfig(tempRepo('banana')))).resolves.toBeNull();
  });

  it('normalizes valid semver to the v-prefixed release shape', async () => {
    vi.stubEnv('AUTOPILOT_CURRENT_RELEASE', '2.3.4-beta.1');
    const { getCurrentRelease } = await importCurrentRelease();

    await expect(getCurrentRelease(makeConfig(tempRepo('0.4.46')))).resolves.toBe('v2.3.4-beta.1');
  });
});
