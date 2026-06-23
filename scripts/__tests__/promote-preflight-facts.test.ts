import { describe, expect, it } from 'vitest';

import {
  evaluateBetaCertification,
  gatherPromoteFacts,
  parseGitlinkOid,
  parsePackageJsonVersion,
  parseSubmoduleConfig,
  type ExecFn,
  type ExecResult,
  type GhJob,
} from '../promote-preflight-facts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHA = '428259cb83e22a32fdcc36bf538002f81fdd9fa8';
const SUB_OID = '9807d9d20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const STALE_SUB_OID = '1f23f27aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** A green beta run's jobs (publish-success bar): every required group concluded success. */
function greenJobs(): GhJob[] {
  return [
    { name: 'Verify Submodules', status: 'completed', conclusion: 'success' },
    { name: 'Validate & Test / validate', status: 'completed', conclusion: 'success' },
    { name: 'Validate & Test / test (1)', status: 'completed', conclusion: 'success' },
    { name: 'Validate & Test / test (2)', status: 'completed', conclusion: 'success' },
    { name: 'Validate & Test / test (3)', status: 'completed', conclusion: 'success' },
    { name: 'Validate & Test / Validate Release Changelog', status: 'completed', conclusion: 'skipped' },
    { name: 'Build macOS (arm64, beta)', status: 'completed', conclusion: 'success' },
    { name: 'Build macOS (x64, beta)', status: 'completed', conclusion: 'success' },
    { name: 'Build Linux (beta)', status: 'completed', conclusion: 'success' },
    { name: 'Build Windows (beta)', status: 'completed', conclusion: 'success' },
    { name: 'E2E Tests (macOS)', status: 'completed', conclusion: 'success' },
    { name: 'Publish to Google Cloud Storage', status: 'completed', conclusion: 'success' },
  ];
}

/** A submodule .gitmodules `--get-regexp ...path` output for the 4 real submodules. */
/** The raw .gitmodules content for the 4 real submodules (read at the SHA via `git show <sha>:.gitmodules`). */
const GITMODULES_CONTENT = `[submodule "rebel-system"]
\tpath = rebel-system
\turl = [external-email]:mindstone/rebel-system.git
\tbranch = main
[submodule "super-mcp"]
\tpath = super-mcp
\turl = [external-email]:mindstone/Super-MCP.git
\tbranch = main
[submodule "coding-agent-instructions"]
\tpath = coding-agent-instructions
\turl = [external-email]:mindstone/coding-agent-instructions.git
\tbranch = main
[submodule "mcp-servers"]
\tpath = mcp-servers
\turl = [external-email]:mindstone/mcp-servers.git
\tbranch = main
`;

/** A `git ls-tree <sha> <path>` gitlink line. */
function lsTreeLine(oid: string, path: string): string {
  return `160000 commit ${oid}\t${path}`;
}

const PKG_AT_SHA = JSON.stringify({ name: 'mindstone-rebel', version: '0.4.49' });
const PKG_AT_MAIN = JSON.stringify({ name: 'mindstone-rebel', version: '0.4.48' });
const CHANGELOG_WITH_HEADING = `# Changelog\n\n## v0.4.49 — June 2026\n\n- Did things.\n`;
const CHANGELOG_UNRELEASED = `# Changelog\n\n## Unreleased\n\n- Did things.\n`;

/**
 * Build a mock `exec` from a list of [substring, result] rules. The FIRST rule whose substring
 * appears in the command wins. Unmatched commands fail-closed to `{ success: false }`, so a fact
 * relying on a command we forgot to stub becomes null (mirrors production fail-closed behaviour).
 */
function mockExec(rules: Array<[string, Partial<ExecResult>]>): ExecFn {
  return (cmd: string): ExecResult => {
    for (const [needle, result] of rules) {
      if (cmd.includes(needle)) {
        return { success: true, output: '', ...result };
      }
    }
    return { success: false, output: '', error: `unstubbed command: ${cmd}` };
  };
}

/** A happy-path rule set: every fact resolves to true (with substring-keyed outputs). */
function happyRules(overrides: Array<[string, Partial<ExecResult>]> = []): Array<[string, Partial<ExecResult>]> {
  const runList = JSON.stringify([
    { databaseId: 27803427419, headSha: SHA, status: 'completed', conclusion: 'success' },
  ]);
  const runView = JSON.stringify({ jobs: greenJobs() });
  return [
    ...overrides,
    [`rev-parse --verify ${SHA}^{commit}`, { success: true, output: SHA }],
    [`merge-base --is-ancestor ${SHA} origin/dev`, { success: true }],
    [`git show ${SHA}:package.json`, { success: true, output: PKG_AT_SHA }],
    ['git show origin/main:package.json', { success: true, output: PKG_AT_MAIN }],
    [`git show ${SHA}:.gitmodules`, { success: true, output: GITMODULES_CONTENT }],
    ['gh run list', { success: true, output: runList }],
    ['gh run view', { success: true, output: runView }],
    [`ls-tree ${SHA} rebel-system`, { success: true, output: lsTreeLine(SUB_OID, 'rebel-system') }],
    [`ls-tree ${SHA} super-mcp`, { success: true, output: lsTreeLine(SUB_OID, 'super-mcp') }],
    [`ls-tree ${SHA} coding-agent-instructions`, { success: true, output: lsTreeLine(SUB_OID, 'coding-agent-instructions') }],
    [`ls-tree ${SHA} mcp-servers`, { success: true, output: lsTreeLine(SUB_OID, 'mcp-servers') }],
    ['git -C rebel-system show', { success: true, output: CHANGELOG_WITH_HEADING }],
    ['fetch --quiet origin', { success: true }],
    ['merge-base --is-ancestor', { success: true }], // submodule reachability (catch-all, after the dev one above)
  ];
}

const OWNER_REPO = 'mindstone/rebel-app';
const deps = (exec: ExecFn) => ({
  exec,
  repoRoot: '/repo',
  ownerRepo: OWNER_REPO,
  isCleanFastForward: () => true,
});

/** A recording mock exec that captures every issued command (for fetch-before-read / --repo asserts). */
function recordingExec(rules: Array<[string, Partial<ExecResult>]>): ExecFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((cmd: string): ExecResult => {
    calls.push(cmd);
    for (const [needle, result] of rules) {
      if (cmd.includes(needle)) return { success: true, output: '', ...result };
    }
    return { success: false, output: '', error: `unstubbed command: ${cmd}` };
  }) as ExecFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// parsePackageJsonVersion (pure)
// ---------------------------------------------------------------------------

describe('parsePackageJsonVersion', () => {
  it('returns the version string', () => {
    expect(parsePackageJsonVersion(JSON.stringify({ version: '1.2.3' }))).toBe('1.2.3');
  });

  it('returns null when version is missing', () => {
    expect(parsePackageJsonVersion(JSON.stringify({ name: 'x' }))).toBeNull();
  });

  it('returns null when version is not a string', () => {
    expect(parsePackageJsonVersion(JSON.stringify({ version: 123 }))).toBeNull();
  });

  it('returns null on parse error', () => {
    expect(parsePackageJsonVersion('{ not json')).toBeNull();
    expect(parsePackageJsonVersion('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseGitlinkOid (pure)
// ---------------------------------------------------------------------------

describe('parseGitlinkOid', () => {
  it('parses the gitlink commit oid', () => {
    expect(parseGitlinkOid(lsTreeLine(SUB_OID, 'rebel-system'))).toBe(SUB_OID);
  });

  it('returns null for a non-gitlink (blob) entry', () => {
    expect(parseGitlinkOid('100644 blob abc123\tpackage.json')).toBeNull();
  });

  it('returns null for empty output', () => {
    expect(parseGitlinkOid('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseSubmoduleConfig (pure-ish, via injected exec)
// ---------------------------------------------------------------------------

describe('parseSubmoduleConfig', () => {
  it('parses the four submodules with their branches', () => {
    expect(parseSubmoduleConfig(GITMODULES_CONTENT)).toEqual([
      { path: 'rebel-system', branch: 'main' },
      { path: 'super-mcp', branch: 'main' },
      { path: 'coding-agent-instructions', branch: 'main' },
      { path: 'mcp-servers', branch: 'main' },
    ]);
  });

  it('defaults branch to main when none declared', () => {
    const content = '[submodule "foo"]\n\tpath = foo\n\turl = git@example.com:foo.git\n';
    expect(parseSubmoduleConfig(content)).toEqual([{ path: 'foo', branch: 'main' }]);
  });

  it('respects a non-default declared branch', () => {
    const content = '[submodule "foo"]\n\tpath = libs/foo\n\tbranch = develop\n';
    expect(parseSubmoduleConfig(content)).toEqual([{ path: 'libs/foo', branch: 'develop' }]);
  });

  it('returns null for empty content', () => {
    expect(parseSubmoduleConfig('')).toBeNull();
  });

  it('returns null when content has no submodule sections', () => {
    expect(parseSubmoduleConfig('# just a comment\n')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// evaluateBetaCertification (pure)
// ---------------------------------------------------------------------------

describe('evaluateBetaCertification', () => {
  it('returns true for a fully-published green run (publish-success bar)', () => {
    expect(evaluateBetaCertification(greenJobs(), 'publish-success')).toBe(true);
  });

  it('returns false when publish failed', () => {
    const jobs = greenJobs().map((j) =>
      j.name === 'Publish to Google Cloud Storage' ? { ...j, conclusion: 'failure' } : j
    );
    expect(evaluateBetaCertification(jobs, 'publish-success')).toBe(false);
  });

  it('returns false when a platform build failed', () => {
    const jobs = greenJobs().map((j) =>
      j.name === 'Build Windows (beta)' ? { ...j, conclusion: 'failure' } : j
    );
    expect(evaluateBetaCertification(jobs, 'publish-success')).toBe(false);
  });

  it('returns false when one of two macOS builds failed (all matched builds must succeed)', () => {
    const jobs = greenJobs().map((j) =>
      j.name === 'Build macOS (x64, beta)' ? { ...j, conclusion: 'failure' } : j
    );
    expect(evaluateBetaCertification(jobs, 'publish-success')).toBe(false);
  });

  it('returns null when jobs is null', () => {
    expect(evaluateBetaCertification(null, 'publish-success')).toBeNull();
  });

  it('returns null when jobs is empty', () => {
    expect(evaluateBetaCertification([], 'publish-success')).toBeNull();
  });

  it('returns null when a required job group is missing (job-name drift, fail-closed)', () => {
    // No "Publish to Google Cloud Storage" job at all → can't determine → null (not a false pass).
    const jobs = greenJobs().filter((j) => j.name !== 'Publish to Google Cloud Storage');
    expect(evaluateBetaCertification(jobs, 'publish-success')).toBeNull();
  });

  it('returns null when the Linux build group is missing', () => {
    const jobs = greenJobs().filter((j) => !j.name.toLowerCase().includes('build linux'));
    expect(evaluateBetaCertification(jobs, 'publish-success')).toBeNull();
  });

  it('does not false-block on the legitimately-skipped Validate Release Changelog job', () => {
    // greenJobs() includes a skipped "Validate Release Changelog"; precise match on
    // "validate & test / validate" must NOT include it (it would otherwise drag the group to false).
    expect(evaluateBetaCertification(greenJobs(), 'publish-success')).toBe(true);
  });

  it('does not accept a bare "Validate & Test" job in place of the exact validate sub-job', () => {
    // If the only validate-shaped job is the bare reusable-call name (no "/ validate"), the exact
    // matcher finds no validate job → null (could not determine), never a false pass.
    const jobs = greenJobs()
      .filter((j) => j.name !== 'Validate & Test / validate')
      .concat([{ name: 'Validate & Test', status: 'completed', conclusion: 'success' }]);
    expect(evaluateBetaCertification(jobs, 'publish-success')).toBeNull();
  });

  it('blocks when the exact validate job concluded a non-success (e.g. failure)', () => {
    const jobs = greenJobs().map((j) =>
      j.name === 'Validate & Test / validate' ? { ...j, conclusion: 'failure' } : j
    );
    expect(evaluateBetaCertification(jobs, 'publish-success')).toBe(false);
  });

  it('fails closed (null) for the unimplemented fully-green bar', () => {
    expect(evaluateBetaCertification(greenJobs(), 'fully-green')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gatherPromoteFacts — happy path
// ---------------------------------------------------------------------------

describe('gatherPromoteFacts — happy path', () => {
  it('produces every fact true on a fully-resolvable certified SHA', () => {
    const facts = gatherPromoteFacts(SHA, deps(mockExec(happyRules())));
    expect(facts).toEqual({
      certifiedSha: SHA,
      shaIsValidCommit: true,
      shaIsAncestorOfDev: true,
      betaCertified: true,
      changelogHeadingAtSha: true,
      mainIsAncestorOfSha: true,
      submodulePointersResolve: true,
      shaVersion: '0.4.49',
      mainVersion: '0.4.48',
    });
  });
});

// ---------------------------------------------------------------------------
// gatherPromoteFacts — freshness (F1) + explicit repo binding (F2)
// ---------------------------------------------------------------------------

describe('gatherPromoteFacts — freshness + repo binding', () => {
  it('refreshes origin/main + origin/dev BEFORE reading any ref-dependent fact [F1]', () => {
    const exec = recordingExec(happyRules());
    gatherPromoteFacts(SHA, deps(exec));

    const fetchIdx = exec.calls.findIndex(
      (c) => c.startsWith('git fetch') && c.includes('refs/heads/main') && c.includes('refs/heads/dev')
    );
    expect(fetchIdx).toBeGreaterThanOrEqual(0);

    // Every fact that reads a refreshed remote-tracking ref must come AFTER the fetch.
    const dependentIdxs = exec.calls
      .map((c, i) => ({ c, i }))
      .filter(
        ({ c }) =>
          c.includes('git show origin/main:package.json') ||
          c.includes(`merge-base --is-ancestor ${SHA} origin/dev`)
      )
      .map(({ i }) => i);
    expect(dependentIdxs.length).toBeGreaterThan(0);
    for (const idx of dependentIdxs) expect(idx).toBeGreaterThan(fetchIdx);
  });

  it('passes --repo to every gh command (cert proof bound to the same repo as the PATCH) [F2]', () => {
    const exec = recordingExec(happyRules());
    gatherPromoteFacts(SHA, deps(exec));

    const ghCalls = exec.calls.filter((c) => c.includes('gh run '));
    expect(ghCalls.length).toBeGreaterThan(0);
    for (const c of ghCalls) expect(c).toContain(`--repo ${OWNER_REPO}`);
  });

  it('FAIL-CLOSED: a failed remote refresh fetch nulls every origin-ref-dependent fact', () => {
    // [GPT F1 round-2] If the leading `git fetch origin main dev` fails, origin/main and origin/dev
    // may be stale, so we CANNOT prove live state: main-version, dev-ancestry, and fast-forward must
    // all be null (the verdict then blocks). It must NOT silently fall back to stale-but-readable
    // local refs (force=false only guards a non-fast-forward, not a stale version-ahead proof).
    const rules = happyRules([['git fetch --quiet origin', { success: false }]]);
    const facts = gatherPromoteFacts(SHA, deps(mockExec(rules)));
    expect(facts.mainVersion).toBeNull();
    expect(facts.shaIsAncestorOfDev).toBeNull();
    expect(facts.mainIsAncestorOfSha).toBeNull();
    // Facts that don't read origin/main|origin/dev are unaffected (the SHA object is still valid).
    expect(facts.shaIsValidCommit).toBe(true);
    expect(facts.certifiedSha).toBe(SHA);
  });
});

// ---------------------------------------------------------------------------
// gatherPromoteFacts — per-fact failure → null
// ---------------------------------------------------------------------------

describe('gatherPromoteFacts — fail-closed per fact', () => {
  it('shaIsValidCommit is false when rev-parse reports a bad object (exit 1)', () => {
    const rules = happyRules([[`rev-parse --verify ${SHA}^{commit}`, { success: false, exitCode: 1 }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).shaIsValidCommit).toBe(false);
  });

  it('shaIsValidCommit is null when rev-parse errors non-determinately (exit 128)', () => {
    const rules = happyRules([[`rev-parse --verify ${SHA}^{commit}`, { success: false, exitCode: 128 }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).shaIsValidCommit).toBeNull();
  });

  it('shaIsAncestorOfDev is false when not on dev (exit 1)', () => {
    const rules = happyRules([[`merge-base --is-ancestor ${SHA} origin/dev`, { success: false, exitCode: 1 }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).shaIsAncestorOfDev).toBe(false);
  });

  it('shaIsAncestorOfDev is null when the ancestry check errors (exit 128, e.g. missing origin/dev)', () => {
    const rules = happyRules([[`merge-base --is-ancestor ${SHA} origin/dev`, { success: false, exitCode: 128 }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).shaIsAncestorOfDev).toBeNull();
  });

  it('shaVersion is null when package.json at the SHA is unreadable', () => {
    const rules = happyRules([[`git show ${SHA}:package.json`, { success: false }]]);
    const facts = gatherPromoteFacts(SHA, deps(mockExec(rules)));
    expect(facts.shaVersion).toBeNull();
    // changelog read depends on shaVersion → also null (fail-closed cascade)
    expect(facts.changelogHeadingAtSha).toBeNull();
  });

  it('mainVersion is null when package.json on main is unreadable', () => {
    const rules = happyRules([['git show origin/main:package.json', { success: false }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).mainVersion).toBeNull();
  });

  it('mainVersion is null when package.json on main is unparseable', () => {
    const rules = happyRules([['git show origin/main:package.json', { success: true, output: 'not json' }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).mainVersion).toBeNull();
  });

  it('mainIsAncestorOfSha is null when the injected isCleanFastForward throws', () => {
    const facts = gatherPromoteFacts(SHA, {
      exec: mockExec(happyRules()),
      repoRoot: '/repo',
      ownerRepo: 'mindstone/rebel-app',
      isCleanFastForward: () => {
        throw new Error('git blew up');
      },
    });
    expect(facts.mainIsAncestorOfSha).toBeNull();
  });

  it('mainIsAncestorOfSha is false when not a fast-forward', () => {
    const facts = gatherPromoteFacts(SHA, {
      exec: mockExec(happyRules()),
      repoRoot: '/repo',
      ownerRepo: 'mindstone/rebel-app',
      isCleanFastForward: () => false,
    });
    expect(facts.mainIsAncestorOfSha).toBe(false);
  });

  it('treats a thrown exec as null (fail-closed), never as a pass', () => {
    const throwingExec: ExecFn = () => {
      throw new Error('exec exploded');
    };
    const facts = gatherPromoteFacts(SHA, deps(throwingExec));
    // Predicate facts go null on throw (tri-state); none ever optimistically true.
    expect(facts.shaIsValidCommit).toBeNull();
    expect(facts.shaIsAncestorOfDev).toBeNull();
    expect(facts.betaCertified).toBeNull();
    expect(facts.changelogHeadingAtSha).toBeNull();
    expect(facts.submodulePointersResolve).toBeNull();
    expect(facts.shaVersion).toBeNull();
    expect(facts.mainVersion).toBeNull();
  });

  it('refuses a malformed (non-canonical) SHA without running git against it', () => {
    let calledWithBadSha = false;
    const guardExec: ExecFn = (cmd) => {
      if (cmd.includes('not-a-valid-sha')) calledWithBadSha = true;
      // The leading freshness fetch succeeds (origin/main fresh), and main-version is the one
      // SHA-independent read we serve — so we can assert it still comes through for a malformed SHA.
      // (The fetch-FAILED → mainVersion null path is covered by its own dedicated test above.)
      if (cmd.includes('git fetch --quiet origin')) return { success: true, output: '' };
      if (cmd.includes('git show origin/main:package.json')) {
        return { success: true, output: PKG_AT_MAIN };
      }
      return { success: false, output: '' };
    };
    const facts = gatherPromoteFacts('not-a-valid-sha', deps(guardExec));
    expect(calledWithBadSha).toBe(false); // never interpolated into a git command
    expect(facts.shaIsValidCommit).toBe(false);
    expect(facts.shaIsAncestorOfDev).toBeNull();
    expect(facts.betaCertified).toBeNull();
    expect(facts.changelogHeadingAtSha).toBeNull();
    expect(facts.mainIsAncestorOfSha).toBeNull();
    expect(facts.submodulePointersResolve).toBeNull();
    expect(facts.shaVersion).toBeNull();
    expect(facts.mainVersion).toBe('0.4.48'); // SHA-independent fact still read
  });
});

// ---------------------------------------------------------------------------
// gatherPromoteFacts — beta certification
// ---------------------------------------------------------------------------

describe('gatherPromoteFacts — beta certification', () => {
  it('is true when the matching run published green', () => {
    expect(gatherPromoteFacts(SHA, deps(mockExec(happyRules()))).betaCertified).toBe(true);
  });

  it('is false when the matching run failed to publish', () => {
    const failedJobs = greenJobs().map((j) =>
      j.name === 'Publish to Google Cloud Storage' ? { ...j, conclusion: 'failure' } : j
    );
    const rules = happyRules([['gh run view', { success: true, output: JSON.stringify({ jobs: failedJobs }) }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).betaCertified).toBe(false);
  });

  it('is null when gh run list fails', () => {
    const rules = happyRules([['gh run list', { success: false }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).betaCertified).toBeNull();
  });

  it('is null when no run matches the certified SHA', () => {
    const otherRun = JSON.stringify([
      { databaseId: 1, headSha: 'deadbeef' + '0'.repeat(32), status: 'completed', conclusion: 'success' },
    ]);
    const rules = happyRules([['gh run list', { success: true, output: otherRun }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).betaCertified).toBeNull();
  });

  it('is null when gh run view fails', () => {
    const rules = happyRules([['gh run view', { success: false }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).betaCertified).toBeNull();
  });

  it('is null when the run list is not valid JSON', () => {
    const rules = happyRules([['gh run list', { success: true, output: 'oops not json' }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).betaCertified).toBeNull();
  });

  it('is null when jobs are missing/partial (job-name drift)', () => {
    const partial = JSON.stringify({ jobs: greenJobs().filter((j) => !j.name.includes('Publish')) });
    const rules = happyRules([['gh run view', { success: true, output: partial }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).betaCertified).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gatherPromoteFacts — changelog-at-SHA
// ---------------------------------------------------------------------------

describe('gatherPromoteFacts — changelog at SHA', () => {
  it('is true when the heading is present at the submodule commit', () => {
    expect(gatherPromoteFacts(SHA, deps(mockExec(happyRules()))).changelogHeadingAtSha).toBe(true);
  });

  it('is false when only ## Unreleased is present at the SHA', () => {
    const rules = happyRules([['git -C rebel-system show', { success: true, output: CHANGELOG_UNRELEASED }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).changelogHeadingAtSha).toBe(false);
  });

  it('is null when the rebel-system gitlink cannot be read', () => {
    const rules = happyRules([[`ls-tree ${SHA} rebel-system`, { success: false }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).changelogHeadingAtSha).toBeNull();
  });

  it('is null when the submodule changelog show fails', () => {
    const rules = happyRules([['git -C rebel-system show', { success: false }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).changelogHeadingAtSha).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gatherPromoteFacts — submodule resolvability (the orphan case)
// ---------------------------------------------------------------------------

describe('gatherPromoteFacts — submodule pointers resolve', () => {
  it('is true when every submodule pin is reachable', () => {
    expect(gatherPromoteFacts(SHA, deps(mockExec(happyRules()))).submodulePointersResolve).toBe(true);
  });

  it('is false when a pin is orphaned (OSS-squash case — not reachable, exit 1)', () => {
    // rebel-system pins a stale oid; its reachability check determinately fails (exit 1), others pass.
    // Order matters: the rebel-system ls-tree + its specific reachability rule come BEFORE the
    // generic catch-all merge-base rule.
    const rules: Array<[string, Partial<ExecResult>]> = [
      [`ls-tree ${SHA} rebel-system`, { success: true, output: lsTreeLine(STALE_SUB_OID, 'rebel-system') }],
      [`merge-base --is-ancestor ${STALE_SUB_OID} origin/main`, { success: false, exitCode: 1 }],
      ...happyRules(),
    ];
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).submodulePointersResolve).toBe(false);
  });

  it('is null when a submodule reachability check errors non-determinately (exit 128)', () => {
    const rules: Array<[string, Partial<ExecResult>]> = [
      [`ls-tree ${SHA} rebel-system`, { success: true, output: lsTreeLine(STALE_SUB_OID, 'rebel-system') }],
      [`merge-base --is-ancestor ${STALE_SUB_OID} origin/main`, { success: false, exitCode: 128 }],
      ...happyRules(),
    ];
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).submodulePointersResolve).toBeNull();
  });

  it('is null when a submodule fetch fails (cannot determine reachability)', () => {
    const rules = happyRules([['fetch --quiet origin', { success: false }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).submodulePointersResolve).toBeNull();
  });

  it('is null when a submodule pin cannot be read', () => {
    const rules = happyRules([[`ls-tree ${SHA} super-mcp`, { success: false }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).submodulePointersResolve).toBeNull();
  });

  it('reads .gitmodules AT THE SHA, not the working tree', () => {
    // If `git show <sha>:.gitmodules` can't be read, the whole gate is undeterminable → null.
    const rules = happyRules([[`git show ${SHA}:.gitmodules`, { success: false }]]);
    expect(gatherPromoteFacts(SHA, deps(mockExec(rules))).submodulePointersResolve).toBeNull();
  });
});
