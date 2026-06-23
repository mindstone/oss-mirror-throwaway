import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'posthog-annotate-release.mjs');
const FIXTURE_CHANGELOG = path.resolve(HERE, '..', '__fixtures__', 'posthog-annotate', 'changelog.md');

/**
 * Runs the annotate script in a child process and returns exit code + captured
 * stdout + the contents written to a temp $GITHUB_OUTPUT. The POSTHOG_* secrets
 * are deliberately stripped so we exercise the missing-config path WITHOUT any
 * network call (the script exits before the PostHog API request).
 */
function runAnnotate(args: string[]) {
  const ghOutputDir = mkdtempSync(path.join(tmpdir(), 'posthog-annotate-test-'));
  const ghOutputFile = path.join(ghOutputDir, 'github_output');
  const env = {
    ...process.env,
    POSTHOG_ANNOTATE_CHANGELOG_PATH: FIXTURE_CHANGELOG,
    GITHUB_OUTPUT: ghOutputFile,
  };
  delete env.POSTHOG_PERSONAL_API_KEY;
  delete env.POSTHOG_PROJECT_ID;

  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync('node', [SCRIPT, ...args], { env, encoding: 'utf8' });
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    status = typeof e.status === 'number' ? e.status : 1;
    stdout = e.stdout ?? '';
  }
  let ghOutput = '';
  try {
    ghOutput = readFileSync(ghOutputFile, 'utf8');
  } catch {
    ghOutput = '';
  }
  cleanups.push(ghOutputDir);
  return { status, stdout, ghOutput };
}

const cleanups: string[] = [];
beforeEach(() => {
  cleanups.length = 0;
});
afterEach(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

describe('posthog-annotate-release missing-config behavior', () => {
  it('is a LOUD SKIP (exit 0 + warning + GITHUB_OUTPUT flag), not a hard failure', () => {
    // Regression guard: this branch was previously `exit 1`. The loud-skip
    // contract is what release.yml gates the Slack alert on, so it must hold.
    const { status, stdout, ghOutput } = runAnnotate(['v9.9.9', 'beta']);

    expect(status).toBe(0);
    expect(stdout).toContain('::warning title=PostHog annotation skipped::');
    expect(ghOutput).toContain('skipped=missing-config');
    expect(ghOutput).toMatch(/skip_reason=Missing .*POSTHOG_PERSONAL_API_KEY/);
  });

  it('does not set the skip flag when there is simply no changelog content for the version', () => {
    // The pre-existing "no content" skip path must stay distinct from
    // missing-config so the Slack alert only fires for the real misconfig.
    const { status, ghOutput } = runAnnotate(['v0.0.0-absent', 'beta']);

    expect(status).toBe(0);
    expect(ghOutput).not.toContain('skipped=missing-config');
  });
});
