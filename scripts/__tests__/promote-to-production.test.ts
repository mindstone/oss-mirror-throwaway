import { describe, expect, it, vi } from 'vitest';

import {
  runPromoteToProduction,
  parseOwnerRepoFromRemote,
  classifyRefUpdateResult,
  buildAdvanceMainCommand,
  medianStableRunMinutes,
  computeWatchWindowMinutes,
  isCanonicalOid,
  PROMOTE_EXIT_CODES,
  CANONICAL_PRODUCTION_REPO,
  type PromoteOptions,
  type PromoteDeps,
} from '../promote-to-production';
import type { ExecFn, ExecResult, ExecOpts, GhJob } from '../promote-preflight-facts';

// ---------------------------------------------------------------------------
// SAFETY: every test injects a MOCK exec. No real git/gh/network is ever run.
// The load-bearing assertions:
//   - not-eligible ⇒ the main-advance command is NEVER issued + non-zero exit
//   - eligible + --dry-run ⇒ real main-advance NEVER issued
//   - eligible + checkpoint-cancelled ⇒ main-advance NEVER issued
//   - eligible + confirmed + non-dry-run ⇒ EXACTLY one FF `git push` of the SHA
//     to refs/heads/main (no --force, no leading `+`)
//   - a non-fast-forward push rejection ⇒ "main moved" re-brief + non-zero exit
//     (never retried/forced); a ruleset/permission decline ⇒ REF_UPDATE_FAILED
// ---------------------------------------------------------------------------

const SHA = '428259cb83e22a32fdcc36bf538002f81fdd9fa8';
const SUB_OID = '9807d9d20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWNER_REPO = 'mindstone/rebel-app';
const EXPECTED_REF_CMD = `git push origin ${SHA}:refs/heads/main`;

const PKG_AT_SHA = JSON.stringify({ name: 'mindstone-rebel', version: '0.4.49' });
const PKG_AT_MAIN = JSON.stringify({ name: 'mindstone-rebel', version: '0.4.48' });
const CHANGELOG_WITH_HEADING = `# Changelog\n\n## v0.4.49 — June 2026\n\n- Did things.\n`;
const CHANGELOG_UNRELEASED = `# Changelog\n\n## Unreleased\n\n- Did things.\n`;

const GITMODULES_CONTENT = `[submodule "rebel-system"]
\tpath = rebel-system
\turl = [external-email]:mindstone/rebel-system.git
\tbranch = main
`;

function greenJobs(): GhJob[] {
  return [
    { name: 'Validate & Test / validate', status: 'completed', conclusion: 'success' },
    { name: 'Build macOS (arm64, beta)', status: 'completed', conclusion: 'success' },
    { name: 'Build macOS (x64, beta)', status: 'completed', conclusion: 'success' },
    { name: 'Build Linux (beta)', status: 'completed', conclusion: 'success' },
    { name: 'Build Windows (beta)', status: 'completed', conclusion: 'success' },
    { name: 'Publish to Google Cloud Storage', status: 'completed', conclusion: 'success' },
  ];
}

function lsTreeLine(oid: string, path: string): string {
  return `160000 commit ${oid}\t${path}`;
}

/**
 * A recording mock exec. The FIRST rule whose substring matches wins; unmatched
 * commands fail-closed to `{ success: false }`. Every issued command is captured
 * in `.calls` so a test can assert exactly which commands ran (or never ran).
 */
type RecordingExec = ExecFn & { calls: string[]; callsWithOpts: Array<{ cmd: string; opts?: ExecOpts }> };

function makeExec(rules: Array<[string, Partial<ExecResult>]>): RecordingExec {
  const calls: string[] = [];
  const callsWithOpts: Array<{ cmd: string; opts?: ExecOpts }> = [];
  const fn = ((cmd: string, opts?: ExecOpts): ExecResult => {
    calls.push(cmd);
    callsWithOpts.push({ cmd, opts });
    for (const [needle, result] of rules) {
      if (cmd.includes(needle)) {
        return { success: true, output: '', ...result };
      }
    }
    return { success: false, output: '', error: `unstubbed: ${cmd}`, exitCode: 1 };
  }) as RecordingExec;
  fn.calls = calls;
  fn.callsWithOpts = callsWithOpts;
  return fn;
}

/** Rules that make every pre-flight gate pass (eligible verdict). */
function eligibleRules(overrides: Array<[string, Partial<ExecResult>]> = []): Array<[string, Partial<ExecResult>]> {
  const runListDev = JSON.stringify([
    { databaseId: 27803427419, headSha: SHA, status: 'completed', conclusion: 'success' },
  ]);
  const runView = JSON.stringify({ jobs: greenJobs() });
  return [
    ...overrides,
    // owner/repo + actor
    ['git remote get-url origin', { success: true, output: 'https://github.com/mindstone/rebel-app.git' }],
    ['gh api user --jq .login', { success: true, output: 'gdetre' }],
    // facts
    [`rev-parse --verify ${SHA}^{commit}`, { success: true, output: SHA }],
    [`merge-base --is-ancestor ${SHA} origin/dev`, { success: true }],
    [`git show ${SHA}:package.json`, { success: true, output: PKG_AT_SHA }],
    ['git show origin/main:package.json', { success: true, output: PKG_AT_MAIN }],
    [`git show ${SHA}:.gitmodules`, { success: true, output: GITMODULES_CONTENT }],
    // gh run list/view now carry an explicit `--repo`, so key off `--branch <x>` (the `--repo`
    // segment sits between `gh run list` and `--workflow`, so "gh run list --workflow" no longer
    // matches). The dev-cert query is `--branch dev`; ETA + stable-run-confirm are `--branch main`.
    ['--branch dev', { success: true, output: runListDev }],
    ['gh run view', { success: true, output: runView }],
    [`ls-tree ${SHA} rebel-system`, { success: true, output: lsTreeLine(SUB_OID, 'rebel-system') }],
    ['git -C rebel-system show', { success: true, output: CHANGELOG_WITH_HEADING }],
    ['fetch --quiet origin', { success: true }],
    ['merge-base --is-ancestor', { success: true }], // submodule reachability catch-all
    // post-update: the FF push succeeds, ETA query, stable-run confirmation
    ['push origin', { success: true, output: '' }],
    ['--branch main', { success: true, output: stableRunListJson() }],
  ];
}

/** A `gh run list --branch main` response with a started run for the new SHA. */
function stableRunListJson(): string {
  return JSON.stringify([
    {
      databaseId: 99999,
      headSha: SHA,
      status: 'in_progress',
      conclusion: null,
      createdAt: '2026-06-19T00:00:00Z',
      updatedAt: '2026-06-19T00:01:00Z',
    },
  ]);
}

interface Harness {
  exec: RecordingExec;
  lines: string[];
  promptLine: ReturnType<typeof vi.fn>;
  deps: PromoteDeps;
}

function makeHarness(
  rules: Array<[string, Partial<ExecResult>]>,
  overrides: Partial<PromoteDeps> & { promptAnswer?: string } = {}
): Harness {
  const { promptAnswer, ...depOverrides } = overrides;
  const exec = makeExec(rules);
  const lines: string[] = [];
  const promptLine = vi.fn(async () => promptAnswer ?? 'y');
  // Monotonically-advancing clock: each read jumps a minute, so any poll loop that
  // fails to return early (a missing stub) EXITS the window instead of hanging the test.
  let clock = 0;
  const deps: PromoteDeps = {
    exec,
    repoRoot: '/repo',
    log: (m: string) => lines.push(m),
    promptLine,
    // Stub the fast-forward helper so gatherPromoteFacts never runs real git.
    isCleanFastForward: () => true,
    // Never poll real network / actually sleep in tests.
    fetchManifestVersion: async () => ({ ok: true, version: '0.4.49' }),
    now: () => (clock += 60_000),
    sleep: async () => undefined,
    watch: false,
    ...depOverrides,
  };
  return { exec, lines, promptLine, deps };
}

const baseOpts: PromoteOptions = {
  commit: SHA,
  dryRun: false,
  isTTY: false,
  confirmChangelogCurrent: '0.4.49',
  explainJson: false,
};

/** Did the run issue the production-touching main-advance (a FF `git push` to refs/heads/main)? */
function issuedRefUpdate(exec: { calls: string[] }): boolean {
  return exec.calls.some((c) => c.includes('push origin') && c.includes(':refs/heads/main'));
}

/** Did the run issue ANY `git push` (the dry-run/explain guarantee asserts it never does)? */
function issuedPush(exec: { calls: string[] }): boolean {
  return exec.calls.some((c) => /\bgit\s+push\b/.test(c));
}

/** The main-advance push calls (expected exactly one on the real path). */
function advanceCalls(exec: { calls: string[] }): string[] {
  return exec.calls.filter((c) => c.includes('push origin'));
}

/** Every `gh` command issued by the run (for the --repo binding assertion). */
function ghCommands(exec: { calls: string[] }): string[] {
  return exec.calls.filter((c) => c.includes('gh run ') || c.includes('gh api '));
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseOwnerRepoFromRemote', () => {
  it('parses HTTPS remotes (with and without .git)', () => {
    expect(parseOwnerRepoFromRemote('https://github.com/mindstone/rebel-app.git')).toBe(OWNER_REPO);
    expect(parseOwnerRepoFromRemote('https://github.com/mindstone/rebel-app')).toBe(OWNER_REPO);
  });
  it('parses SSH scp-style remotes', () => {
    expect(parseOwnerRepoFromRemote('[external-email]:mindstone/rebel-app.git')).toBe(OWNER_REPO);
    expect(parseOwnerRepoFromRemote('[external-email]:mindstone/rebel-app')).toBe(OWNER_REPO);
  });
  it('parses ssh:// schemed remotes', () => {
    expect(parseOwnerRepoFromRemote('ssh://[external-email]/mindstone/rebel-app.git')).toBe(OWNER_REPO);
  });
  it('is case-insensitive on the host', () => {
    expect(parseOwnerRepoFromRemote('https://GitHub.com/mindstone/rebel-app.git')).toBe(OWNER_REPO);
  });
  it('returns null on unparseable / empty input', () => {
    expect(parseOwnerRepoFromRemote('')).toBeNull();
    expect(parseOwnerRepoFromRemote('not-a-url')).toBeNull();
  });
  it('FAIL-CLOSED on a non-GitHub host (would PATCH the wrong forge otherwise)', () => {
    expect(parseOwnerRepoFromRemote('[external-email]:mindstone/rebel-app.git')).toBeNull();
    expect(parseOwnerRepoFromRemote('https://gitlab.com/mindstone/rebel-app.git')).toBeNull();
    expect(parseOwnerRepoFromRemote('https://github.evil.com/mindstone/rebel-app.git')).toBeNull();
  });
  it('FAIL-CLOSED on nested paths (more than owner/repo)', () => {
    expect(parseOwnerRepoFromRemote('https://github.com/a/b/c.git')).toBeNull();
    expect(parseOwnerRepoFromRemote('[external-email]:a/b/c.git')).toBeNull();
  });
  it('FAIL-CLOSED on shell metacharacters / whitespace in the segments', () => {
    expect(parseOwnerRepoFromRemote('[external-email]:mindstone/Repo;rm -rf.git')).toBeNull();
    expect(parseOwnerRepoFromRemote('https://github.com/mind stone/Repo.git')).toBeNull();
    expect(parseOwnerRepoFromRemote('[external-email]:mindstone/Repo\n.git')).toBeNull();
    expect(parseOwnerRepoFromRemote('https://github.com/owner/$(whoami).git')).toBeNull();
  });
});

describe('buildAdvanceMainCommand', () => {
  it('builds the exact FF git-push command (no --force, no leading +)', () => {
    expect(buildAdvanceMainCommand(SHA)).toBe(EXPECTED_REF_CMD);
    expect(buildAdvanceMainCommand(SHA)).toBe(`git push origin ${SHA}:refs/heads/main`);
    expect(buildAdvanceMainCommand(SHA)).not.toContain('--force');
    expect(buildAdvanceMainCommand(SHA)).not.toContain(`+${SHA}`);
  });
});

describe('classifyRefUpdateResult', () => {
  it('ok on success', () => {
    expect(classifyRefUpdateResult({ success: true, output: '' }).kind).toBe('ok');
  });
  it('not-fast-forward on a git push (non-fast-forward) / (fetch first) rejection', () => {
    expect(
      classifyRefUpdateResult({
        success: false,
        output: '',
        error: '! [rejected]        428259c -> main (non-fast-forward)\nUpdates were rejected because the tip is behind.',
      }).kind
    ).toBe('not-fast-forward');
    expect(
      classifyRefUpdateResult({ success: false, output: '', error: '! [rejected] 428259c -> main (fetch first)' }).kind
    ).toBe('not-fast-forward');
  });
  it('does NOT trip on a free-floating "not a fast forward" phrase (anchored to git\'s status line only)', () => {
    // Hook/test stderr that merely echoes the phrase (no `! [rejected]` status line) must NOT be
    // misread as "main moved" — it falls through to a generic failure (conservative).
    expect(
      classifyRefUpdateResult({ success: false, output: '', error: 'gh: Update is not a fast forward (HTTP 422)' }).kind
    ).toBe('failed');
    expect(
      classifyRefUpdateResult({ success: false, output: '', error: 'some test log mentioning non-fast-forward in prose' }).kind
    ).toBe('failed');
  });
  it('a ruleset / permission decline is a FAILURE, not "main moved" (checked before non-FF)', () => {
    // git push [remote rejected] (push declined due to repository rule violations) ⇒ generic failure
    expect(
      classifyRefUpdateResult({
        success: false,
        output: '',
        error: '! [remote rejected] 428259c -> main (push declined due to repository rule violations)',
      }).kind
    ).toBe('failed');
    expect(
      classifyRefUpdateResult({ success: false, output: '', error: '! [remote rejected] main (protected branch hook declined)' }).kind
    ).toBe('failed');
  });
  it('failed on any other error', () => {
    expect(classifyRefUpdateResult({ success: false, output: '', error: 'HTTP 403: forbidden' }).kind).toBe('failed');
  });
});

describe('medianStableRunMinutes', () => {
  it('computes the median of completed runs in minutes', () => {
    const json = JSON.stringify([
      { status: 'completed', createdAt: '2026-06-19T00:00:00Z', updatedAt: '2026-06-19T00:26:00Z' },
      { status: 'completed', createdAt: '2026-06-19T01:00:00Z', updatedAt: '2026-06-19T01:30:00Z' },
      { status: 'in_progress', createdAt: '2026-06-19T02:00:00Z', updatedAt: '2026-06-19T02:05:00Z' },
    ]);
    expect(medianStableRunMinutes(json)).toBe(28);
  });
  it('returns null when no completed runs / unparseable', () => {
    expect(medianStableRunMinutes('[]')).toBeNull();
    expect(medianStableRunMinutes('not json')).toBeNull();
    expect(medianStableRunMinutes(JSON.stringify([{ status: 'in_progress' }]))).toBeNull();
  });
});

describe('computeWatchWindowMinutes', () => {
  it('floors at 45 min (null/zero/short ETA never watch less than the old fixed window)', () => {
    expect(computeWatchWindowMinutes(null)).toBe(45);
    expect(computeWatchWindowMinutes(0)).toBe(45);
    expect(computeWatchWindowMinutes(-10)).toBe(45);
    expect(computeWatchWindowMinutes(30)).toBe(45); // 30*1.5=45
    expect(computeWatchWindowMinutes(20)).toBe(45); // 20*1.5=30 -> floored
  });
  it('scales to ETA × 1.5 between the floor and cap', () => {
    expect(computeWatchWindowMinutes(60)).toBe(90); // 60*1.5
    expect(computeWatchWindowMinutes(93)).toBe(140); // round(139.5)
  });
  it('caps at 180 min (a build past 3× the floor is stuck)', () => {
    expect(computeWatchWindowMinutes(120)).toBe(180); // 120*1.5=180
    expect(computeWatchWindowMinutes(200)).toBe(180); // 300 -> capped
    expect(computeWatchWindowMinutes(99999)).toBe(180);
  });
  it('ignores a non-finite ETA (fail-safe to the floor)', () => {
    expect(computeWatchWindowMinutes(Number.NaN)).toBe(45);
    expect(computeWatchWindowMinutes(Number.POSITIVE_INFINITY)).toBe(45);
  });
});

describe('isCanonicalOid', () => {
  it('accepts 40/64-char lowercase hex', () => {
    expect(isCanonicalOid(SHA)).toBe(true);
    expect(isCanonicalOid('a'.repeat(64))).toBe(true);
  });
  it('rejects short / uppercase / non-hex / empty', () => {
    expect(isCanonicalOid('428259c')).toBe(false);
    expect(isCanonicalOid(SHA.toUpperCase())).toBe(false);
    expect(isCanonicalOid('')).toBe(false);
    expect(isCanonicalOid('zzzz')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runPromoteToProduction — the driver core (the load-bearing safety tests)
// ---------------------------------------------------------------------------

describe('runPromoteToProduction — input validation', () => {
  it('rejects a non-canonical SHA fail-closed WITHOUT touching main', async () => {
    const h = makeHarness(eligibleRules());
    const code = await runPromoteToProduction({ ...baseOpts, commit: '428259c' }, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.BAD_INPUT);
    expect(issuedRefUpdate(h.exec)).toBe(false);
  });
});

describe('runPromoteToProduction — not eligible', () => {
  it('blocks (non-zero) and NEVER issues the ref update when a gate fails', async () => {
    // Changelog only under "## Unreleased" at the SHA ⇒ changelog-heading gate blocks.
    const h = makeHarness(
      eligibleRules([['git -C rebel-system show', { success: true, output: CHANGELOG_UNRELEASED }]])
    );
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.NOT_ELIGIBLE);
    expect(issuedRefUpdate(h.exec)).toBe(false);
    expect(h.promptLine).not.toHaveBeenCalled();
    expect(h.lines.some((l) => l.includes('BLOCKED'))).toBe(true);
  });

  it('blocks when beta is not certified (no matching green run)', async () => {
    const h = makeHarness(
      eligibleRules([['--branch dev', { success: true, output: '[]' }]])
    );
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.NOT_ELIGIBLE);
    expect(issuedRefUpdate(h.exec)).toBe(false);
  });

  it('blocks when version is not ahead of main', async () => {
    const h = makeHarness(
      eligibleRules([['git show origin/main:package.json', { success: true, output: JSON.stringify({ version: '0.4.49' }) }]])
    );
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.NOT_ELIGIBLE);
    expect(issuedRefUpdate(h.exec)).toBe(false);
  });

  it('blocks when the SHA is not a clean fast-forward of main', async () => {
    const h = makeHarness(eligibleRules(), { isCleanFastForward: () => false });
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.NOT_ELIGIBLE);
    expect(issuedRefUpdate(h.exec)).toBe(false);
  });
});

describe('runPromoteToProduction — --explain-json', () => {
  it('prints facts + verdict JSON and exits, touching nothing', async () => {
    const h = makeHarness(eligibleRules());
    const code = await runPromoteToProduction({ ...baseOpts, explainJson: true }, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.SUCCESS);
    expect(issuedRefUpdate(h.exec)).toBe(false);
    expect(h.promptLine).not.toHaveBeenCalled();
    const json = JSON.parse(h.lines.find((l) => l.trim().startsWith('{')) ?? '{}');
    expect(json.certifiedSha).toBe(SHA);
    expect(json.verdict.eligible).toBe(true);
    expect(json.facts.shaVersion).toBe('0.4.49');
  });

  it('--explain-json on a not-eligible verdict exits non-zero, still touching nothing', async () => {
    const h = makeHarness(
      eligibleRules([['--branch dev', { success: true, output: '[]' }]])
    );
    const code = await runPromoteToProduction({ ...baseOpts, explainJson: true }, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.NOT_ELIGIBLE);
    expect(issuedRefUpdate(h.exec)).toBe(false);
  });
});

describe('runPromoteToProduction — --dry-run', () => {
  it('eligible + dry-run NEVER issues the real ref update and exits 0', async () => {
    const h = makeHarness(eligibleRules());
    const code = await runPromoteToProduction({ ...baseOpts, dryRun: true }, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.SUCCESS);
    expect(issuedRefUpdate(h.exec)).toBe(false);
    // Dry-run logs the exact command it WOULD run.
    expect(h.lines.some((l) => l.includes('DRY RUN') && l.includes('would advance main'))).toBe(true);
    expect(h.lines.some((l) => l.includes(EXPECTED_REF_CMD))).toBe(true);
  });

  it('dry-run auto-proceeds the checkpoint without prompting (non-TTY, no flag)', async () => {
    const h = makeHarness(eligibleRules());
    const code = await runPromoteToProduction(
      { ...baseOpts, dryRun: true, confirmChangelogCurrent: undefined },
      h.deps
    );
    expect(code).toBe(PROMOTE_EXIT_CODES.SUCCESS);
    expect(h.promptLine).not.toHaveBeenCalled();
    expect(issuedRefUpdate(h.exec)).toBe(false);
  });
});

describe('runPromoteToProduction — human checkpoint', () => {
  it('cancelled checkpoint (non-TTY, no flag) ⇒ ref update NEVER issued + non-zero', async () => {
    const h = makeHarness(eligibleRules());
    const code = await runPromoteToProduction(
      { ...baseOpts, isTTY: false, confirmChangelogCurrent: undefined },
      h.deps
    );
    expect(code).toBe(PROMOTE_EXIT_CODES.USER_CANCELLED);
    expect(issuedRefUpdate(h.exec)).toBe(false);
  });

  it('interactive "n" ⇒ ref update NEVER issued + non-zero', async () => {
    const h = makeHarness(eligibleRules(), { promptAnswer: 'n' });
    const code = await runPromoteToProduction(
      { ...baseOpts, isTTY: true, confirmChangelogCurrent: undefined },
      h.deps
    );
    expect(code).toBe(PROMOTE_EXIT_CODES.USER_CANCELLED);
    expect(h.promptLine).toHaveBeenCalled();
    expect(issuedRefUpdate(h.exec)).toBe(false);
  });

  it('mismatched --confirm-changelog-current ⇒ cancelled, no ref update', async () => {
    const h = makeHarness(eligibleRules());
    const code = await runPromoteToProduction({ ...baseOpts, confirmChangelogCurrent: '9.9.9' }, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.USER_CANCELLED);
    expect(issuedRefUpdate(h.exec)).toBe(false);
  });
});

describe('runPromoteToProduction — the real main-advance (FF git push)', () => {
  it('eligible + confirmed + non-dry-run ⇒ EXACTLY the FF git push with the right SHA', async () => {
    const h = makeHarness(eligibleRules());
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.SUCCESS);
    const refCalls = advanceCalls(h.exec);
    expect(refCalls).toHaveLength(1);
    expect(refCalls[0]).toBe(EXPECTED_REF_CMD);
    // Belt + braces: it's a plain FF push of the SHA to refs/heads/main — never forced.
    expect(refCalls[0]).toContain('git push origin');
    expect(refCalls[0]).toContain(`${SHA}:refs/heads/main`);
    expect(refCalls[0]).not.toContain('--force');
    expect(refCalls[0]).not.toContain(`+${SHA}`);
  });

  it('the advance push carries the certified env + a long (hook-safe) timeout [F1/F2]', async () => {
    const h = makeHarness(eligibleRules());
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.SUCCESS);
    const pushCall = h.exec.callsWithOpts.find((c) => c.cmd.includes('push origin'));
    expect(pushCall).toBeDefined();
    // F2: REBEL_CERTIFIED_PROMOTE_SHA is set to the SHA so the pre-push hook takes the
    // certified-promote fast path (skips redundant heavy suites, keeps the safety gate).
    expect(pushCall!.opts?.env?.REBEL_CERTIFIED_PROMOTE_SHA).toBe(SHA);
    // F1: a generous timeout so the pre-push gate isn't killed at the default 30s.
    expect(pushCall!.opts?.timeoutMs ?? 0).toBeGreaterThan(60_000);
  });

  it('emits the handoff signal immediately after a successful advance', async () => {
    const h = makeHarness(eligibleRules());
    await runPromoteToProduction(baseOpts, h.deps);
    expect(h.lines.some((l) => l.includes('handoff complete'))).toBe(true);
  });

  it('refuses to advance when owner/repo cannot be derived (no main touched)', async () => {
    const h = makeHarness(
      eligibleRules([['git remote get-url origin', { success: true, output: 'not-a-remote-url' }]])
    );
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.BAD_INPUT);
    expect(issuedRefUpdate(h.exec)).toBe(false);
  });
});

describe('runPromoteToProduction — non-FF / failure mapping', () => {
  it('a non-fast-forward push ⇒ "main moved" re-brief + non-zero, never retried/forced', async () => {
    const h = makeHarness(
      eligibleRules([
        ['push origin', { success: false, output: '', error: '! [rejected] 428259c -> main (non-fast-forward)', exitCode: 1 }],
      ])
    );
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.NOT_FAST_FORWARD);
    // Issued exactly once — never retried, never forced.
    const refCalls = advanceCalls(h.exec);
    expect(refCalls).toHaveLength(1);
    expect(refCalls.some((c) => c.includes('--force') || c.includes(`+${SHA}`))).toBe(false);
    expect(h.lines.some((l) => l.includes('main moved'))).toBe(true);
  });

  it('a ruleset/permission decline ⇒ REF_UPDATE_FAILED (non-zero), no retry', async () => {
    const h = makeHarness(
      eligibleRules([
        [
          'push origin',
          {
            success: false,
            output: '',
            error: '! [remote rejected] 428259c -> main (push declined due to repository rule violations)',
            exitCode: 1,
          },
        ],
      ])
    );
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.REF_UPDATE_FAILED);
    const refCalls = advanceCalls(h.exec);
    expect(refCalls).toHaveLength(1);
  });
});

describe('runPromoteToProduction — post-update watch', () => {
  it('with watch enabled, reports the GCS manifest advancing', async () => {
    const h = makeHarness(eligibleRules(), {
      watch: true,
      fetchManifestVersion: async () => ({ ok: true, version: '0.4.49' }),
    });
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.SUCCESS);
    expect(h.lines.some((l) => l.includes('GCS manifest advanced to v0.4.49'))).toBe(true);
  });

  it('the watch window is DERIVED from the calibrated ETA (not a fixed 45) [watch-window wiring]', async () => {
    // A completed stable run with a 60-min duration ⇒ median ETA 60 ⇒ window 60×1.5 = 90 min.
    // (The in_progress SHA run satisfies run-confirm; the completed run feeds the ETA median.)
    const runListMain = JSON.stringify([
      { databaseId: 99999, headSha: SHA, status: 'in_progress', conclusion: null, createdAt: '2026-06-19T00:00:00Z', updatedAt: '2026-06-19T00:01:00Z' },
      { databaseId: 88888, headSha: 'old0000', status: 'completed', conclusion: 'success', createdAt: '2026-06-19T00:00:00Z', updatedAt: '2026-06-19T01:00:00Z' },
    ]);
    const h = makeHarness(eligibleRules([['--branch main', { success: true, output: runListMain }]]), {
      watch: true,
      fetchManifestVersion: async () => ({ ok: true, version: '0.4.49' }),
    });
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.SUCCESS);
    // Proves etaMinutes is actually threaded into watchGcsManifest (a regression that passed
    // null/wrong arg would leave computeWatchWindowMinutes green but show "up to 45 min" here).
    expect(h.lines.some((l) => l.includes('up to 90 min'))).toBe(true);
    expect(h.lines.some((l) => l.includes('up to 45 min'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F5 — canonical-repo hard-bind (fail-closed on a non-canonical / wrong origin)
// ---------------------------------------------------------------------------

describe('runPromoteToProduction — canonical-repo hard-bind [F5]', () => {
  it('the canonical repo constant is exactly mindstone/rebel-app', () => {
    expect(CANONICAL_PRODUCTION_REPO).toBe('mindstone/rebel-app');
  });

  it('fails closed (BAD_INPUT, no main touched) when origin is a DIFFERENT GitHub repo', async () => {
    const h = makeHarness(
      eligibleRules([['git remote get-url origin', { success: true, output: 'https://github.com/someone/Fork.git' }]])
    );
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.BAD_INPUT);
    expect(issuedRefUpdate(h.exec)).toBe(false);
    expect(h.lines.some((l) => l.includes('not the canonical production repo'))).toBe(true);
  });

  it('fails closed (BAD_INPUT) when origin cannot be parsed to owner/repo at all', async () => {
    const h = makeHarness(
      eligibleRules([['git remote get-url origin', { success: true, output: 'not-a-remote-url' }]])
    );
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.BAD_INPUT);
    expect(issuedRefUpdate(h.exec)).toBe(false);
  });

  it('hard-binds BEFORE gathering — a wrong origin never even runs the pre-flight gh calls', async () => {
    const h = makeHarness(
      eligibleRules([['git remote get-url origin', { success: true, output: '[external-email]:someone/Fork.git' }]])
    );
    await runPromoteToProduction(baseOpts, h.deps);
    // No cert-proof gh call should have fired for a non-canonical origin.
    expect(h.exec.calls.some((c) => c.includes('gh run list --repo'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F2 — every gh command carries the explicit --repo (same target as the PATCH)
// ---------------------------------------------------------------------------

describe('runPromoteToProduction — explicit --repo binding [F2]', () => {
  it('passes --repo <canonical> to every gh run/api command, and the advance pushes to origin', async () => {
    const h = makeHarness(eligibleRules(), {
      watch: true,
      fetchManifestVersion: async () => ({ ok: true, version: '0.4.49' }),
    });
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.SUCCESS);

    const gh = ghCommands(h.exec).filter((c) => c.includes('gh run '));
    expect(gh.length).toBeGreaterThan(0);
    for (const c of gh) expect(c).toContain(`--repo ${CANONICAL_PRODUCTION_REPO}`);

    // The advance pushes to `origin` (already hard-bound to the canonical repo upstream by the
    // resolveOwnerRepo === CANONICAL check — see the hard-bind tests), not a /repos/<owner> path.
    const refCalls = advanceCalls(h.exec);
    expect(refCalls).toHaveLength(1);
    expect(refCalls[0]).toBe(EXPECTED_REF_CMD);
  });
});

// ---------------------------------------------------------------------------
// F4 — post-advance success semantics (exit 0 = SHIPPED, not "PATCH returned")
// ---------------------------------------------------------------------------

describe('runPromoteToProduction — post-advance success semantics [F4]', () => {
  it('main advanced but NO stable run started ⇒ RUN_NOT_TRIGGERED (non-zero), after the push', async () => {
    // The FF push succeeds, but the stable-run list never shows a matching run.
    const h = makeHarness(
      eligibleRules([['--branch main', { success: true, output: '[]' }]])
    );
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.RUN_NOT_TRIGGERED);
    // main HAS advanced — the push was issued exactly once.
    expect(issuedRefUpdate(h.exec)).toBe(true);
    expect(h.lines.some((l) => l.includes('main advanced but no stable run triggered'))).toBe(true);
    // The "safe to close your laptop" handoff must NOT have been emitted (no confirmed run).
    expect(h.lines.some((l) => l.includes('handoff complete'))).toBe(false);
  });

  it('run started but the GCS manifest NEVER advances ⇒ PUBLISH_NOT_CONFIRMED (non-zero)', async () => {
    const h = makeHarness(eligibleRules(), {
      watch: true,
      // Manifest stays on the OLD version forever ⇒ never advances to 0.4.49.
      fetchManifestVersion: async () => ({ ok: true, version: '0.4.48' }),
    });
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.PUBLISH_NOT_CONFIRMED);
    expect(issuedRefUpdate(h.exec)).toBe(true);
    expect(h.lines.some((l) => l.includes('GCS publish was not confirmed'))).toBe(true);
  });

  it('run started AND manifest advances ⇒ SUCCESS (the full shipped path)', async () => {
    const h = makeHarness(eligibleRules(), {
      watch: true,
      fetchManifestVersion: async () => ({ ok: true, version: '0.4.49' }),
    });
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.SUCCESS);
  });

  it('with watch disabled, a confirmed-started run is the SUCCESS bar', async () => {
    // watch:false (default harness) — success once a stable run is confirmed started.
    const h = makeHarness(eligibleRules());
    const code = await runPromoteToProduction(baseOpts, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.SUCCESS);
    expect(h.lines.some((l) => l.includes('Stable run started'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F6 — handoff message ordering (after run-confirm, not before)
// ---------------------------------------------------------------------------

describe('runPromoteToProduction — handoff timing [F6]', () => {
  it('emits "confirming CI trigger…" BEFORE the "handoff complete" message', async () => {
    const h = makeHarness(eligibleRules());
    await runPromoteToProduction(baseOpts, h.deps);
    const confirmingIdx = h.lines.findIndex((l) => l.includes('confirming CI trigger'));
    const handoffIdx = h.lines.findIndex((l) => l.includes('handoff complete'));
    const runStartedIdx = h.lines.findIndex((l) => l.includes('Stable run started'));
    expect(confirmingIdx).toBeGreaterThanOrEqual(0);
    expect(handoffIdx).toBeGreaterThanOrEqual(0);
    expect(runStartedIdx).toBeGreaterThanOrEqual(0);
    // handoff complete comes AFTER both the "confirming" line and the confirmed start.
    expect(handoffIdx).toBeGreaterThan(confirmingIdx);
    expect(handoffIdx).toBeGreaterThan(runStartedIdx);
  });
});

// ---------------------------------------------------------------------------
// F3 — dry-run / --explain-json never advance main, never push (narrowed guarantee)
// ---------------------------------------------------------------------------

describe('runPromoteToProduction — preview modes issue no main-advance / no push [F3]', () => {
  it('--dry-run issues NO main-advance push', async () => {
    const h = makeHarness(eligibleRules());
    const code = await runPromoteToProduction({ ...baseOpts, dryRun: true }, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.SUCCESS);
    expect(issuedRefUpdate(h.exec)).toBe(false);
    expect(issuedPush(h.exec)).toBe(false);
  });

  it('--explain-json issues NO main-advance push', async () => {
    const h = makeHarness(eligibleRules());
    const code = await runPromoteToProduction({ ...baseOpts, explainJson: true }, h.deps);
    expect(code).toBe(PROMOTE_EXIT_CODES.SUCCESS);
    expect(issuedRefUpdate(h.exec)).toBe(false);
    expect(issuedPush(h.exec)).toBe(false);
  });

  it('preview modes DO perform the read-only remote-ref fetch (accurate preview, narrowed guarantee)', async () => {
    const h = makeHarness(eligibleRules());
    await runPromoteToProduction({ ...baseOpts, dryRun: true }, h.deps);
    // The freshness fetch is allowed in preview (read-only) — but never a main-advance/push.
    expect(
      h.exec.calls.some((c) => c.startsWith('git fetch') && c.includes('refs/heads/main'))
    ).toBe(true);
    expect(issuedRefUpdate(h.exec)).toBe(false);
    expect(issuedPush(h.exec)).toBe(false);
  });
});
