/**
 * Stage D — pre-push hook tests.
 *
 * The autopilot pre-push hook is the runtime guarantee that no autopilot
 * worktree ever pushes to `main` or `dev`. These tests invoke the real bash
 * script with synthetic stdin (one line per ref-update being pushed) and
 * assert refusal / acceptance per the plan's branch policy:
 *   - refs/heads/main       → refuse
 *   - refs/heads/dev        → refuse
 *   - refs/heads/feature/*  → refuse (anything outside autopilot/*)
 *   - refs/heads/autopilot/* → accept (and exec into husky pre-push if present)
 *
 * The hook also resolves $REPO_ROOT explicitly so the husky chain reference
 * doesn't silently expand to "/.husky/pre-push" — that fix is folded into the
 * v2.2 plan and tested implicitly by ensuring the script doesn't error before
 * the per-ref loop runs.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HOOK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'hooks',
  'pre-push',
);

function runHook(input: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(HOOK_PATH, ['origin', '[external-email]:mindstone/rebel-app.git'], {
    input,
    encoding: 'utf8',
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const FAKE_SHA = '0000000000000000000000000000000000000000';
const refLine = (remote: string): string =>
  `refs/heads/local_dummy ${FAKE_SHA} ${remote} ${FAKE_SHA}\n`;

describe('autopilot pre-push hook', () => {
  it('refuses pushes to main with a clear message', () => {
    const r = runHook(refLine('refs/heads/main'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused.*main/i);
  });

  it('refuses pushes to dev with a clear message', () => {
    const r = runHook(refLine('refs/heads/dev'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused.*dev/i);
  });

  it('refuses pushes to feature branches outside autopilot/*', () => {
    const r = runHook(refLine('refs/heads/feature/some-branch'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused.*autopilot\/\*/);
  });

  it('refuses pushes to release/* or other non-autopilot branches', () => {
    const r = runHook(refLine('refs/heads/release/v1'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused/i);
  });

  it('accepts pushes to refs/heads/autopilot/sentry-FOO', () => {
    // In the dev checkout .husky/pre-push is not chmod +x, so the exec at the
    // end of the script is a no-op and the hook exits 0 cleanly after the
    // per-ref allowance loop. On the VM where husky is installed, the exec
    // chains into secret-scanning. Both paths are valid for "accept".
    const r = runHook(refLine('refs/heads/autopilot/sentry-FOO_123'));
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/refused/i);
  });

  it('accepts mixed batch where every ref matches autopilot/*', () => {
    const input =
      refLine('refs/heads/autopilot/sentry-abc') + refLine('refs/heads/autopilot/sentry-xyz');
    const r = runHook(input);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/refused/i);
  });

  it('refuses the whole batch if any single ref targets main or dev', () => {
    const input =
      refLine('refs/heads/autopilot/sentry-ok') + refLine('refs/heads/main');
    const r = runHook(input);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refused.*main/i);
  });

  it('exits cleanly when stdin has no ref-update lines', () => {
    // git invokes pre-push with empty stdin for some no-op flows; the loop
    // should be a no-op and exit 0 cleanly.
    const r = runHook('');
    expect(r.status).toBe(0);
  });
});
