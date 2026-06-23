import { describe, expect, it } from 'vitest';

import {
  buildRetryLegSpawnPlan,
  classifyPushFailure,
  decidePushRetry,
  parseRetryDepth,
  NO_RETRY_ENV,
  RETRY_DEPTH_ENV,
  RETRY_LEG_FLAG,
  type PushRetryDecisionInput,
} from '../push-race-retry';

/**
 * Unit tests for git-safe-sync's Stage-7 push-race classification, retry
 * decision matrix, and self-respawn spawn plan
 * (docs/plans/260611_prepush-gate-speedup/PLAN.md, Decision Log 2026-06-11
 * 18:15). The classification cases use real `git push` stderr shapes; the
 * `[remote rejected]` case is the DA's substring trap ('[rejected]' ⊂
 * '[remote rejected]') and must never classify as a race.
 */

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** Real-shape stderr for a non-FF rejection (the race candidate). */
const NON_FF_STDERR = [
  "To github.com:mindstone/rebel-app.git",
  ' ! [rejected]        dev -> dev (non-fast-forward)',
  "error: failed to push some refs to 'github.com:mindstone/rebel-app.git'",
  'hint: Updates were rejected because the tip of your current branch is behind',
  'hint: its remote counterpart. If you want to integrate the remote changes,',
  "hint: use 'git pull' before pushing again.",
].join('\n');

const FETCH_FIRST_STDERR = [
  'To /tmp/fixture-origin.git',
  ' ! [rejected]        main -> main (fetch first)',
  "error: failed to push some refs to '/tmp/fixture-origin.git'",
].join('\n');

/** The DA trap: a remote-side policy decline — '[rejected]' is a substring. */
const REMOTE_REJECTED_STDERR = [
  'remote: error: GH013: Repository rule violations found for refs/heads/dev.',
  'To github.com:mindstone/rebel-app.git',
  ' ! [remote rejected] dev -> dev (push declined due to repository rule violations)',
  "error: failed to push some refs to 'github.com:mindstone/rebel-app.git'",
].join('\n');

const PERMISSION_DENIED_STDERR = [
  '[external-email]: Permission denied (publickey).',
  'fatal: Could not read from remote repository.',
  '',
  'Please make sure you have the correct access rights',
  'and the repository exists.',
].join('\n');

/** Pre-push hook output that ECHOES race-like words without a rejection line. */
const HOOK_ECHO_STDERR = [
  '> vitest related --run scripts/lib/__tests__/push-race-retry.test.ts',
  "  ✓ classifies ' ! [rejected] ... (non-fast-forward)' shapes",
  '  ✗ expected "fetch first" hint to be printed',
  'error: failed to push some refs (simulated in test output)',
].join('\n');

/**
 * Real-shape stderr for a LOST CAS RACE on the ruleset-protected `dev` branch.
 * GitHub surfaces it as `[remote rejected]` (because dev requires PRs and we
 * hold bypass) with a `cannot lock ref … is at X but expected Y` reason — the
 * exact shape that used to be misfiled as a policy decline so the auto-retry
 * never fired. `expected` = the tip we fetched (SHA_A); `is at` = where the
 * remote moved (SHA_B). The "Bypassed rule violations" preamble is informational.
 */
const CAS_REF_LOCK_STDERR = [
  'remote: Bypassed rule violations for refs/heads/dev:',
  'remote: - Changes must be made through a pull request.',
  'To github.com:mindstone/rebel-app.git',
  ` ! [remote rejected] dev -> dev (cannot lock ref 'refs/heads/dev': is at ${SHA_B} but expected ${SHA_A})`,
  "error: failed to push some refs to 'github.com:mindstone/rebel-app.git'",
].join('\n');

/**
 * The CAS-words echo trap (the analogue of HOOK_ECHO_STDERR for the new shape):
 * pre-push hook / test output that PRINTS the CAS phrase with two real SHAs but
 * is NOT a git per-ref `[remote rejected]` status line. Must stay non-race — the
 * CAS matcher is anchored to the status line precisely to exclude this.
 */
const CAS_HOOK_ECHO_STDERR = [
  '> vitest related --run scripts/lib/__tests__/push-race-retry.test.ts',
  "  ✓ classifies CAS reason \"cannot lock ref 'refs/heads/dev': " +
    `is at ${SHA_B} but expected ${SHA_A}\"`,
  'error: failed to push some refs (simulated in test output)',
].join('\n');

/** CAS-words echo PLUS a genuine GH013 policy decline `[remote rejected]` line
 * whose own reason is NOT a ref-lock CAS. Must classify as remote-rejected non-race. */
const CAS_ECHO_PLUS_POLICY_STDERR = [
  `  hook log: cannot lock ref 'refs/heads/dev': is at ${SHA_B} but expected ${SHA_A}`,
  'remote: error: GH013: Repository rule violations found for refs/heads/dev.',
  'To github.com:mindstone/rebel-app.git',
  ' ! [remote rejected] dev -> dev (push declined due to repository rule violations)',
].join('\n');

const moved = { fetchedRemoteTip: SHA_A, observedRemoteTip: SHA_B };
const unmoved = { fetchedRemoteTip: SHA_A, observedRemoteTip: SHA_A };
const unknown = { fetchedRemoteTip: SHA_A, observedRemoteTip: null };

describe('classifyPushFailure', () => {
  it('classifies a non-FF rejection with a moved remote tip as a race', () => {
    const c = classifyPushFailure(NON_FF_STDERR, moved);
    expect(c.kind).toBe('race-non-ff');
    expect(c.rejectionShape).toBe('non-ff-rejected');
    expect(c.remoteMoved).toBe(true);
  });

  it('classifies the (fetch first) variant with a moved tip as a race', () => {
    const c = classifyPushFailure(FETCH_FIRST_STDERR, moved);
    expect(c.kind).toBe('race-non-ff');
  });

  it('NEVER classifies [remote rejected] as a race, even with a moved tip (the substring trap)', () => {
    const c = classifyPushFailure(REMOTE_REJECTED_STDERR, moved);
    expect(c.kind).toBe('non-race');
    expect(c.rejectionShape).toBe('remote-rejected');
  });

  it('treats a mixed [remote rejected] + [rejected] stderr as non-race (conservative)', () => {
    const c = classifyPushFailure(`${REMOTE_REJECTED_STDERR}\n${NON_FF_STDERR}`, moved);
    expect(c.kind).toBe('non-race');
    expect(c.rejectionShape).toBe('remote-rejected');
  });

  it('classifies permission failures as non-race', () => {
    const c = classifyPushFailure(PERMISSION_DENIED_STDERR, moved);
    expect(c.kind).toBe('non-race');
    expect(c.rejectionShape).toBe('other');
  });

  it('requires remote-moved evidence: non-FF shape with an unchanged tip is non-race', () => {
    const c = classifyPushFailure(NON_FF_STDERR, unmoved);
    expect(c.kind).toBe('non-race');
    expect(c.remoteMoved).toBe(false);
  });

  it('fails closed when the remote tip is unobservable (ls-remote failed)', () => {
    const c = classifyPushFailure(NON_FF_STDERR, unknown);
    expect(c.kind).toBe('non-race');
    expect(c.remoteMoved).toBe('unknown');
  });

  it('fails closed when the fetched tip is garbage (not a sha)', () => {
    const c = classifyPushFailure(NON_FF_STDERR, {
      fetchedRemoteTip: 'fatal: ambiguous argument',
      observedRemoteTip: SHA_B,
    });
    expect(c.kind).toBe('non-race');
    expect(c.remoteMoved).toBe('unknown');
  });

  it('rejects abbreviated shas: abbreviated-vs-full of the SAME tip must not count as "moved" (exec-review A11)', () => {
    // Both wiring probes emit full 40-char shas, so an abbreviation reaching
    // here means something unexpected produced the evidence — normalize to
    // null ⇒ 'unknown' ⇒ non-race, never a spurious "remote moved".
    const c = classifyPushFailure(NON_FF_STDERR, {
      fetchedRemoteTip: SHA_A.slice(0, 12),
      observedRemoteTip: SHA_A,
    });
    expect(c.kind).toBe('non-race');
    expect(c.remoteMoved).toBe('unknown');
  });

  it('does not match race-like words echoed by pre-push hook output (no rejection line)', () => {
    const c = classifyPushFailure(HOOK_ECHO_STDERR, moved);
    expect(c.kind).toBe('non-race');
    expect(c.rejectionShape).toBe('other');
  });

  it('classifies a CAS ref-lock rejection (the protected-branch race) as a race via embedded SHAs', () => {
    // Even with `unknown` ls-remote evidence, the embedded `is at X / expected Y`
    // SHAs prove the tip moved — so the race is detected without the probe.
    const c = classifyPushFailure(CAS_REF_LOCK_STDERR, unknown);
    expect(c.kind).toBe('race-non-ff');
    expect(c.rejectionShape).toBe('cas-ref-lock');
    expect(c.remoteMoved).toBe(true);
  });

  it('does NOT classify CAS words echoed by hook/test output (no [remote rejected] status line) as a race', () => {
    // The anchoring guard: the CAS phrase appears with two real, differing SHAs
    // but only in hook/test stderr, never on a git per-ref status line.
    const c = classifyPushFailure(CAS_HOOK_ECHO_STDERR, moved);
    expect(c.kind).toBe('non-race');
    expect(c.rejectionShape).toBe('other');
  });

  it('treats CAS-words echo + a genuine GH013 policy decline as remote-rejected non-race', () => {
    // CAS words live in a hook log line; the actual [remote rejected] status
    // line is a policy decline with no ref-lock reason ⇒ must not be a race.
    const c = classifyPushFailure(CAS_ECHO_PLUS_POLICY_STDERR, moved);
    expect(c.kind).toBe('non-race');
    expect(c.rejectionShape).toBe('remote-rejected');
  });

  it('falls back to ls-remote evidence when CAS embedded SHAs are abbreviated', () => {
    // Abbreviated embedded SHAs normalize to null ⇒ defer to the ls-remote
    // probe, which here shows movement (SHA_A → SHA_B) ⇒ still a race.
    const stderr =
      " ! [remote rejected] dev -> dev (cannot lock ref 'refs/heads/dev': is at bbbbbbb but expected aaaaaaa)";
    const c = classifyPushFailure(stderr, moved);
    expect(c.kind).toBe('race-non-ff');
    expect(c.rejectionShape).toBe('cas-ref-lock');
  });

  it('fails closed on a CAS rejection when neither embedded SHAs nor ls-remote can prove movement', () => {
    const stderr =
      " ! [remote rejected] dev -> dev (cannot lock ref 'refs/heads/dev': is at bbbbbbb but expected aaaaaaa)";
    const c = classifyPushFailure(stderr, unknown);
    expect(c.kind).toBe('non-race');
    expect(c.rejectionShape).toBe('cas-ref-lock');
    expect(c.remoteMoved).toBe('unknown');
  });

  it('treats a CAS reason whose embedded SHAs are equal as non-race (fail-closed)', () => {
    const stderr = ` ! [remote rejected] dev -> dev (cannot lock ref 'refs/heads/dev': is at ${SHA_A} but expected ${SHA_A})`;
    const c = classifyPushFailure(stderr, moved);
    expect(c.kind).toBe('non-race');
    expect(c.rejectionShape).toBe('cas-ref-lock');
    expect(c.remoteMoved).toBe(false);
  });

  it('still treats a genuine policy decline (no cannot-lock-ref reason) as non-race remote-rejected', () => {
    // The CAS matcher must NOT swallow real declines — they lack the
    // `cannot lock ref … expected` reason and fall through to remote-rejected.
    const c = classifyPushFailure(REMOTE_REJECTED_STDERR, moved);
    expect(c.kind).toBe('non-race');
    expect(c.rejectionShape).toBe('remote-rejected');
  });

  it('does not match a (pre-receive hook declined) [rejected]-style reason without non-FF', () => {
    // Hypothetical: a '[rejected]' line whose reason is not non-FF/fetch-first
    // must not classify as a race shape.
    const stderr = ' ! [rejected]        dev -> dev (stale info)';
    const c = classifyPushFailure(stderr, moved);
    expect(c.kind).toBe('non-race');
    expect(c.rejectionShape).toBe('other');
  });
});

describe('decidePushRetry', () => {
  const base: PushRetryDecisionInput = {
    failureKind: 'race-non-ff',
    autostashCreated: false,
    isRetryLeg: false,
    noRetryFlag: false,
    env: {},
  };

  it('retries a clean race (default-on)', () => {
    expect(decidePushRetry(base).retry).toBe(true);
  });

  it('does not retry a non-race failure', () => {
    expect(decidePushRetry({ ...base, failureKind: 'non-race' }).retry).toBe(false);
  });

  it('does not retry when an autostash was created (conservative)', () => {
    const d = decidePushRetry({ ...base, autostashCreated: true });
    expect(d.retry).toBe(false);
    expect(d.reason).toContain('autostash');
  });

  it('does not retry from the retry leg (single-retry bound)', () => {
    expect(decidePushRetry({ ...base, isRetryLeg: true }).retry).toBe(false);
  });

  it('does not retry with --no-retry', () => {
    const d = decidePushRetry({ ...base, noRetryFlag: true });
    expect(d.retry).toBe(false);
    expect(d.reason).toBe('--no-retry');
  });

  it(`does not retry when ${NO_RETRY_ENV} is set`, () => {
    expect(decidePushRetry({ ...base, env: { [NO_RETRY_ENV]: '1' } }).retry).toBe(false);
  });

  it('depth env guard blocks a nested respawn even if the --retry-leg flag was mangled away', () => {
    const d = decidePushRetry({ ...base, isRetryLeg: false, env: { [RETRY_DEPTH_ENV]: '1' } });
    expect(d.retry).toBe(false);
    expect(d.reason).toContain(RETRY_DEPTH_ENV);
  });

  it('ignores garbage depth values (treated as 0)', () => {
    expect(decidePushRetry({ ...base, env: { [RETRY_DEPTH_ENV]: 'banana' } }).retry).toBe(true);
  });
});

describe('parseRetryDepth', () => {
  it('parses unset/garbage/negative as 0 and positive ints as themselves', () => {
    expect(parseRetryDepth(undefined)).toBe(0);
    expect(parseRetryDepth('')).toBe(0);
    expect(parseRetryDepth('banana')).toBe(0);
    expect(parseRetryDepth('-3')).toBe(0);
    expect(parseRetryDepth('1')).toBe(1);
    expect(parseRetryDepth('2')).toBe(2);
  });
});

describe('buildRetryLegSpawnPlan', () => {
  const opts = {
    execPath: '/usr/local/bin/node',
    execArgv: ['--require', '/repo/node_modules/tsx/dist/preflight.cjs'],
    scriptPath: '/repo/scripts/git-safe-sync.ts',
    scriptArgs: ['--autostash', '--no-lock'],
    env: { PATH: '/usr/bin' } as Record<string, string | undefined>,
  };

  it('re-execs the same runtime + loader + script + args with --retry-leg appended exactly once', () => {
    const plan = buildRetryLegSpawnPlan(opts);
    expect(plan.command).toBe(opts.execPath);
    expect(plan.args).toEqual([
      '--require',
      '/repo/node_modules/tsx/dist/preflight.cjs',
      '/repo/scripts/git-safe-sync.ts',
      '--autostash',
      '--no-lock',
      RETRY_LEG_FLAG,
    ]);
  });

  it('still appends --retry-leg exactly once when the args were mangled to already contain it', () => {
    const plan = buildRetryLegSpawnPlan({
      ...opts,
      scriptArgs: ['--retry-leg', '--no-lock', '--retry-leg'],
    });
    expect(plan.args.filter((a) => a === RETRY_LEG_FLAG)).toHaveLength(1);
    expect(plan.args[plan.args.length - 1]).toBe(RETRY_LEG_FLAG);
  });

  it('increments the depth env from unset → 1 and 1 → 2, without mutating the input env', () => {
    const plan1 = buildRetryLegSpawnPlan(opts);
    expect(plan1.env[RETRY_DEPTH_ENV]).toBe('1');
    expect(opts.env[RETRY_DEPTH_ENV]).toBeUndefined();

    const plan2 = buildRetryLegSpawnPlan({
      ...opts,
      env: { ...opts.env, [RETRY_DEPTH_ENV]: '1' },
    });
    expect(plan2.env[RETRY_DEPTH_ENV]).toBe('2');
  });

  it('preserves the rest of the environment', () => {
    const plan = buildRetryLegSpawnPlan(opts);
    expect(plan.env.PATH).toBe('/usr/bin');
  });
});
