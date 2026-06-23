import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOUNDARY_SETTER_EXPORT_REGEX,
  CONSTANT_STUB_REGEX,
  findCrossSurfaceParityGapViolations,
  findExemptCommentNear,
  GRANDFATHERED_UNCLASSIFIED_SETTERS,
  KNOWN_BOUNDARY_SETTERS,
  MIN_STRONG_RATIONALE_LENGTH,
  runCli,
  validateExemptionRationale,
  type DiffProvider,
} from '../check-cross-surface-parity-gap';

const fixtureRoot = join(__dirname, '..', '__fixtures__', 'cross-surface-parity-gap');
const tempEventPaths: string[] = [];

interface CapturedStreams {
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
  stdoutText: () => string;
  stderrText: () => string;
}

function createCapturedStreams(): CapturedStreams {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      write(chunk: string): boolean {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write(chunk: string): boolean {
        stderr += chunk;
        return true;
      },
    },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

function noDiffProvider(): DiffProvider {
  return () => '';
}

function writeTempGithubEvent(json: string): string {
  const eventPath = join(
    tmpdir(),
    `cross-surface-parity-gap-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  writeFileSync(eventPath, json);
  tempEventPaths.push(eventPath);
  return eventPath;
}

afterEach(() => {
  for (const eventPath of tempEventPaths.splice(0)) {
    if (existsSync(eventPath)) unlinkSync(eventPath);
  }
});

function collectFixtureFiles(root: string, current = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFixtureFiles(root, absolutePath));
      continue;
    }
    files.push(relative(root, absolutePath).replace(/\\/g, '/'));
  }
  return files.filter((file) => file !== 'registry.json').sort();
}

function lineNumberContaining(file: string, text: string): number {
  const lineIndex = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .findIndex((line) => line.includes(text));
  if (lineIndex === -1) {
    throw new Error(`Fixture line not found in ${file}: ${text}`);
  }
  return lineIndex + 1;
}

interface FixtureChange {
  file: string;
  line?: number;
  text?: string;
  deleted?: boolean;
}

function diffProviderForFixture(fixturePath: string, changes: readonly FixtureChange[]): DiffProvider {
  const changesByFile = new Map<string, Array<{ line: number; text: string }>>();
  const deletionOnlyFiles = new Set<string>();
  for (const change of changes) {
    const absolutePath = join(fixturePath, change.file);
    const lines = readFileSync(absolutePath, 'utf8').split(/\r?\n/);
    const line = change.line
      ?? (change.text && !change.deleted ? lineNumberContaining(absolutePath, change.text) : 1);
    const text = change.deleted && change.text ? change.text : (lines[line - 1] ?? '');
    const entries = changesByFile.get(change.file) ?? [];
    entries.push({ line, text });
    changesByFile.set(change.file, entries);
    if (change.deleted) deletionOnlyFiles.add(change.file);
  }

  return (query) => {
    if (query.mode === 'name-only') {
      return `${[...changesByFile.keys()].join('\n')}\n`;
    }
    const entries = changesByFile.get(query.file) ?? [];
    if (entries.length === 0) return '';
    return entries
      .map((entry) => [
        `diff --git a/${query.file} b/${query.file}`,
        `--- a/${query.file}`,
        `+++ b/${query.file}`,
        deletionOnlyFiles.has(query.file)
          ? `@@ -${entry.line},1 +${entry.line},0 @@`
          : `@@ -${entry.line},0 +${entry.line},1 @@`,
        `${deletionOnlyFiles.has(query.file) ? '-' : '+'}${entry.text}`,
      ].join('\n'))
      .join('\n');
  };
}

async function runFixture(
  fixtureName: string,
  options: {
    allFiles?: boolean;
    changes?: readonly FixtureChange[];
  } = {},
) {
  const root = join(fixtureRoot, fixtureName);
  const registryPath = 'registry.json';
  return findCrossSurfaceParityGapViolations({
    allFiles: options.allFiles ?? false,
    repoRoot: root,
    registryPath,
    diffProvider: options.allFiles ? noDiffProvider() : diffProviderForFixture(root, options.changes ?? []),
    trackedFilesProvider: () => collectFixtureFiles(root),
  });
}

async function runFixtureCli(
  fixtureName: string,
  argv: readonly string[],
  options: {
    changes?: readonly FixtureChange[];
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const root = join(fixtureRoot, fixtureName);
  const streams = createCapturedStreams();
  const exitCode = await runCli(argv, {}, streams, {
    repoRoot: root,
    registryPath: 'registry.json',
    diffProvider: argv.includes('--all-files') || argv.includes('--list-exemptions')
      ? noDiffProvider()
      : diffProviderForFixture(root, options.changes ?? []),
    trackedFilesProvider: () => collectFixtureFiles(root),
  });

  return {
    exitCode,
    stdout: streams.stdoutText(),
    stderr: streams.stderrText(),
  };
}

describe('check-cross-surface-parity-gap CLI skeleton', () => {
  it('prints usage and exits 0 for --help', async () => {
    const streams = createCapturedStreams();

    const exitCode = await runCli(['--help'], {}, streams);

    expect(exitCode).toBe(0);
    expect(streams.stdoutText()).toContain('Usage: npx tsx scripts/check-cross-surface-parity-gap.ts');
    expect(streams.stdoutText()).toContain('--list-exemptions');
    expect(streams.stderrText()).toBe('');
  });

  it('exits 0 with a loud warning when the kill switch is set', async () => {
    const streams = createCapturedStreams();

    const exitCode = await runCli(
      [],
      { SKIP_CROSS_SURFACE_PARITY_GAP: '1' },
      streams,
      {
        repoRoot: join(fixtureRoot, 'clean'),
        diffProvider: noDiffProvider(),
        trackedFilesProvider: () => ['src/clean.ts'],
      },
    );

    expect(exitCode).toBe(0);
    expect(streams.stdoutText()).toBe('');
    expect(streams.stderrText()).toContain(
      '[cross-surface-parity-gap] WARNING: SKIP_CROSS_SURFACE_PARITY_GAP=1 set; gate bypassed. This should only be used during emergency rollback.',
    );
  });

  it('returns a success summary while Rule A/B stubs emit no violations', async () => {
    const { exitCode, stdout, stderr } = await runFixtureCli('clean', ['--all-files']);

    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      'Cross-surface parity gap check passed (1 boundaries, 3 settings, 0 exemptions).\n',
    );
    expect(stderr).toContain(
      '[cross-surface-parity-gap] WARNING: --all-files mode requested but Rule B (CSACG) remains diff-scoped',
    );
  });

  it('warns when --all-files is requested while Rule B remains diff-scoped', async () => {
    const { exitCode, stdout, stderr } = await runFixtureCli('clean', ['--all-files']);

    expect(exitCode).toBe(0);
    expect(stderr).toContain('[cross-surface-parity-gap] WARNING:');
    expect(stderr).toContain('--all-files mode requested but Rule B (CSACG) remains diff-scoped');
    expect(stderr).toContain('activeProvider');
    expect(stderr).toContain('exposeProviderKeysInShell');
    expect(stderr).toContain('confirmed safe under sync-with-policy');
    expect(stderr).toContain('docs/plans/260516_rule_b_baseline_disposition_followup.md');
    expect(stdout).toContain('Cross-surface parity gap check passed');
  });

  it('lists exemptions from non-diff-changed files when --list-exemptions is used', async () => {
    const { exitCode, stdout, stderr } = await runFixtureCli('exempt-comment', ['--list-exemptions']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('file\tline\treason\n');
    expect(stdout).toContain('src/exempt.ts\t1\tvalid same line');
    expect(stdout).toContain('src/exempt.ts\t2\tvalid above reason');
    expect(stderr).toBe('');
  });

  it('lists exemptions when --list-exemptions and --all-files are both used', async () => {
    const { exitCode, stdout, stderr } = await runFixtureCli('exempt-comment', ['--list-exemptions', '--all-files']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('src/exempt.ts\t1\tvalid same line');
    expect(stdout).toContain('src/exempt.ts\t11\tfive!');
    expect(stderr).toContain(
      '[cross-surface-parity-gap] WARNING: --all-files mode requested but Rule B (CSACG) remains diff-scoped',
    );
  });

  it('warns when a scanned file contains an unclosed block comment', async () => {
    const { exitCode, stderr } = await runFixtureCli('block-comment-embedded', ['--all-files']);

    expect(exitCode).toBe(0);
    expect(stderr).toContain(
      '[cross-surface-parity-gap] WARNING: Unclosed /* block comment in src/block.ts starting at line',
    );
    expect(stderr).toContain('subsequent escape-hatch comments in this file may be unreachable.');
  });
});

describe('findCrossSurfaceParityGapViolations skeleton', () => {
  it('walks fixture files and counts valid exemptions', async () => {
    const result = await findCrossSurfaceParityGapViolations({
      allFiles: true,
      repoRoot: join(fixtureRoot, 'exempt-comment'),
      registryPath: 'registry.json',
      diffProvider: noDiffProvider(),
      trackedFilesProvider: () => collectFixtureFiles(join(fixtureRoot, 'exempt-comment')),
    });

    expect(result.violations).toEqual([]);
    expect(result.exemptedCount).toBe(4);
    expect(result.exemptions.map((exemption) => exemption.line)).toEqual([1, 2, 4, 11]);
  });
});

describe('CLI diff-source selection (CI semantics)', () => {
  it('emits INFO when CI=true and GITHUB_BASE_REF is set (auto-detect)', async () => {
    const root = join(fixtureRoot, 'clean');
    const streams = createCapturedStreams();
    const exitCode = await runCli(
      [],
      { CI: 'true', GITHUB_BASE_REF: 'main' },
      streams,
      {
        repoRoot: root,
        registryPath: 'registry.json',
        diffProvider: noDiffProvider(),
        trackedFilesProvider: () => collectFixtureFiles(root),
      },
    );

    expect(exitCode).toBe(0);
    expect(streams.stderrText()).toContain(
      '[cross-surface-parity-gap] INFO: CI base-ref auto-detected; comparing against origin/main',
    );
  });

  it('emits INFO when --base-ref is explicit', async () => {
    const root = join(fixtureRoot, 'clean');
    const streams = createCapturedStreams();
    const exitCode = await runCli(
      ['--base-ref', 'origin/dev'],
      {},
      streams,
      {
        repoRoot: root,
        registryPath: 'registry.json',
        diffProvider: noDiffProvider(),
        trackedFilesProvider: () => collectFixtureFiles(root),
      },
    );

    expect(exitCode).toBe(0);
    expect(streams.stderrText()).toContain(
      '[cross-surface-parity-gap] INFO: Comparing against base-ref origin/dev',
    );
  });

  it('does not emit INFO in default local mode (no CI env, no --base-ref)', async () => {
    const root = join(fixtureRoot, 'clean');
    const streams = createCapturedStreams();
    const exitCode = await runCli(
      [],
      {},
      streams,
      {
        repoRoot: root,
        registryPath: 'registry.json',
        diffProvider: noDiffProvider(),
        trackedFilesProvider: () => collectFixtureFiles(root),
      },
    );

    expect(exitCode).toBe(0);
    expect(streams.stderrText()).not.toContain('[cross-surface-parity-gap] INFO:');
  });

  it('explicit --base-ref takes precedence over CI env auto-detect', async () => {
    const root = join(fixtureRoot, 'clean');
    const streams = createCapturedStreams();
    const exitCode = await runCli(
      ['--base-ref', 'origin/explicit'],
      { CI: 'true', GITHUB_BASE_REF: 'main' },
      streams,
      {
        repoRoot: root,
        registryPath: 'registry.json',
        diffProvider: noDiffProvider(),
        trackedFilesProvider: () => collectFixtureFiles(root),
      },
    );

    expect(exitCode).toBe(0);
    expect(streams.stderrText()).toContain('Comparing against base-ref origin/explicit');
    expect(streams.stderrText()).not.toContain('CI base-ref auto-detected');
  });

  it('emits INFO when CI=true and GITHUB_EVENT_NAME=push with valid event.before', async () => {
    const root = join(fixtureRoot, 'clean');
    const streams = createCapturedStreams();
    const beforeSha = '1234567890abcdef1234567890abcdef12345678';
    const eventPath = writeTempGithubEvent(JSON.stringify({ before: beforeSha }));
    const exitCode = await runCli(
      [],
      { CI: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: eventPath },
      streams,
      {
        repoRoot: root,
        registryPath: 'registry.json',
        diffProvider: noDiffProvider(),
        trackedFilesProvider: () => collectFixtureFiles(root),
      },
    );

    expect(exitCode).toBe(0);
    expect(streams.stderrText()).toContain(
      '[cross-surface-parity-gap] INFO: CI push-event base-ref auto-detected from GITHUB_EVENT_PATH; comparing against 1234567',
    );
    expect(streams.stderrText()).not.toContain('[cross-surface-parity-gap] WARNING:');
  });

  it('falls through when GITHUB_EVENT_PATH points to nonexistent file', async () => {
    const root = join(fixtureRoot, 'clean');
    const streams = createCapturedStreams();
    const eventPath = join(
      tmpdir(),
      `does-not-exist-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    const exitCode = await runCli(
      [],
      { CI: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: eventPath },
      streams,
      {
        repoRoot: root,
        registryPath: 'registry.json',
        diffProvider: noDiffProvider(),
        trackedFilesProvider: () => collectFixtureFiles(root),
      },
    );

    expect(exitCode).toBe(0);
    expect(streams.stderrText()).toContain('[cross-surface-parity-gap] WARNING:');
    expect(streams.stderrText()).toContain('GITHUB_EVENT_PATH');
    expect(streams.stderrText()).not.toContain('[cross-surface-parity-gap] INFO:');
  });

  it('falls through silently when event.before is all zeros (initial push)', async () => {
    const root = join(fixtureRoot, 'clean');
    const streams = createCapturedStreams();
    const eventPath = writeTempGithubEvent(JSON.stringify({
      before: '0000000000000000000000000000000000000000',
    }));
    const exitCode = await runCli(
      [],
      { CI: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: eventPath },
      streams,
      {
        repoRoot: root,
        registryPath: 'registry.json',
        diffProvider: noDiffProvider(),
        trackedFilesProvider: () => collectFixtureFiles(root),
      },
    );

    expect(exitCode).toBe(0);
    expect(streams.stderrText()).not.toContain('[cross-surface-parity-gap] INFO:');
    expect(streams.stderrText()).not.toContain('[cross-surface-parity-gap] WARNING:');
  });

  it('PR-event auto-detect takes precedence over push-event auto-detect', async () => {
    const root = join(fixtureRoot, 'clean');
    const streams = createCapturedStreams();
    const beforeSha = 'abcdef1234567890abcdef1234567890abcdef12';
    const eventPath = writeTempGithubEvent(JSON.stringify({ before: beforeSha }));
    const exitCode = await runCli(
      [],
      {
        CI: 'true',
        GITHUB_BASE_REF: 'main',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_EVENT_PATH: eventPath,
      },
      streams,
      {
        repoRoot: root,
        registryPath: 'registry.json',
        diffProvider: noDiffProvider(),
        trackedFilesProvider: () => collectFixtureFiles(root),
      },
    );

    expect(exitCode).toBe(0);
    expect(streams.stderrText()).toContain(
      '[cross-surface-parity-gap] INFO: CI base-ref auto-detected; comparing against origin/main',
    );
    expect(streams.stderrText()).not.toContain('CI push-event base-ref auto-detected');
    expect(streams.stderrText()).not.toContain(beforeSha.slice(0, 7));
  });

  it('--all-files ignores diff refs entirely', async () => {
    const root = join(fixtureRoot, 'clean');
    const streams = createCapturedStreams();
    const exitCode = await runCli(
      ['--all-files'],
      { CI: 'true', GITHUB_BASE_REF: 'main' },
      streams,
      {
        repoRoot: root,
        registryPath: 'registry.json',
        diffProvider: noDiffProvider(),
        trackedFilesProvider: () => collectFixtureFiles(root),
      },
    );

    expect(exitCode).toBe(0);
    expect(streams.stderrText()).not.toContain('[cross-surface-parity-gap] INFO:');
  });
});

describe('§11.6 violation output format contract', () => {
  it('emits the locked FAIL header plus rule-id, file:line, and suggested fix on Rule A violation', async () => {
    const { exitCode, stderr } = await runFixtureCli('rule-a-positive', [], {
      changes: [{ file: 'src/core/fooProvider.ts', text: 'setFooProvider' }],
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain('[cross-surface-parity-gap] FAIL: Cross-surface parity gap check failed (1 violations).');
    expect(stderr).toContain('[BIRP-cloud-missing]');
    expect(stderr).toContain('src/core/fooProvider.ts');
    expect(stderr).toMatch(/suggested fix: /u);
  });
});

describe('Rule A — Boundary-Interface Registration Parity (BIRP)', () => {
  it('flags a desktop-only boundary registration', async () => {
    const result = await runFixture('rule-a-positive', {
      changes: [{ file: 'src/core/fooProvider.ts', text: 'setFooProvider' }],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      ruleId: 'BIRP-cloud-missing',
      file: 'src/core/fooProvider.ts',
    });
  });

  it('passes when a boundary is registered on desktop and cloud', async () => {
    const result = await runFixture('rule-a-negative-both-registered', { allFiles: true });

    expect(result.violations).toEqual([]);
  });

  it('honors the default diff-scope filter for untouched boundary pairs', async () => {
    const result = await runFixture('rule-a-diff-scope-untouched', {
      changes: [{ file: 'src/unrelated.ts', text: 'unrelated' }],
    });

    expect(result.violations).toEqual([]);
  });

  it('flags deletion-only diffs that remove cloud registration', async () => {
    const result = await runFixture('rule-a-deletion-only', {
      changes: [{
        file: 'cloud-service/src/bootstrap.ts',
        line: 1,
        text: 'setFooProvider(realFooProvider);',
        deleted: true,
      }],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      ruleId: 'BIRP-cloud-missing',
      file: 'src/core/fooProvider.ts',
    });
  });

  it('honors declaration-line escape hatches', async () => {
    const result = await runFixture('rule-a-escape-hatch', { allFiles: true });

    expect(result.violations).toEqual([]);
  });

  it.each([
    ['rule-a-null-direct'],
    ['rule-a-null-multiline'],
    ['rule-a-null-ternary'],
    ['rule-a-null-as-assertion'],
    ['rule-a-null-nullish'],
  ])('flags cloud NULL sentinel registration in %s', async (fixtureName) => {
    const result = await runFixture(fixtureName, { allFiles: true });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.message).toContain('NULL_* sentinel');
  });

  it.each([
    ['rule-a-call-in-block-comment'],
    ['rule-a-call-in-string'],
    ['rule-a-method-call'],
  ])('does not count false cloud registration calls in %s', async (fixtureName) => {
    const result = await runFixture(fixtureName, { allFiles: true });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      ruleId: 'BIRP-cloud-missing',
      file: 'src/core/fooProvider.ts',
    });
  });

  it('allows NULL sentinel registration only with an adjacent escape hatch', async () => {
    const result = await runFixture('rule-a-null-with-escape', { allFiles: true });

    expect(result.violations).toEqual([]);
  });

  // 260623 class-killer: a constant-stub registrant (() => false / null / undefined)
  // on a both-surface seam used to pass parity silently — the exact mechanism by
  // which registerManagedKeyAvailability(() => false) on cloud went unnoticed for
  // ~27 days. It must now be flagged unless explicitly CROSS_SURFACE_PARITY_EXEMPT.
  it('flags a cloud constant-stub registrant (() => false) as missing parity', async () => {
    const result = await runFixture('rule-a-constant-stub', { allFiles: true });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      ruleId: 'BIRP-cloud-missing',
      file: 'src/core/fooProvider.ts',
    });
    expect(result.violations[0]?.message).toContain('constant stub');
  });

  it('allows a cloud constant-stub registrant only with an adjacent escape hatch', async () => {
    const result = await runFixture('rule-a-constant-stub-with-escape', { allFiles: true });

    expect(result.violations).toEqual([]);
  });

  it('CONSTANT_STUB_REGEX matches constant-stub bodies and rejects real registrants', () => {
    for (const stub of [
      '() => false',
      '() => true',
      '() => null',
      '() => undefined',
      '()=>false',
      '() => { return false; }',
      '() => (false)',
    ]) {
      expect(CONSTANT_STUB_REGEX.test(stub.trim()), stub).toBe(true);
    }
    for (const real of [
      '() => hasManagedOpenRouterKey()',
      'realFooProvider',
      'NULL_FOO',
      '() => settings.hasManagedKey ?? false',
      '(x) => false',
    ]) {
      expect(CONSTANT_STUB_REGEX.test(real.trim()), real).toBe(false);
    }
  });

  it('flags an inventoried boundary with no registrants on either surface', async () => {
    const result = await runFixture('rule-a-no-registrants', { allFiles: true });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.message).toContain('registered on neither desktop nor cloud');
  });

  it('exits 2 when the inventory points at a missing declaration file', async () => {
    const { exitCode, stderr } = await runFixtureCli('rule-a-inventory-drift', ['--all-files']);

    expect(exitCode).toBe(2);
    expect(stderr).toContain('[cross-surface-parity-gap] FATAL: Required file does not exist: src/core/missingProvider.ts');
    expect(stderr).toContain('phase: discovery');
  });

  it('exits 2 when src/core exports a widened-suffix setter missing from the inventory', async () => {
    // setBarFactory ends in `Factory`, a suffix matched ONLY by the widened
    // regex (260607) — so this exercises the forcing function end-to-end.
    const { exitCode, stderr } = await runFixtureCli('rule-a-reverse-inventory-drift', ['--all-files']);

    expect(exitCode).toBe(2);
    expect(stderr).toContain(
      'Boundary inventory drift: src/core/barService.ts exports setBarFactory but it is not classified.',
    );
    expect(stderr).toContain('phase: discovery');
    expect(stderr).toContain(
      "hint: Classify setBarFactory: if it is a desktop/cloud boundary seam, add { name: 'setBarFactory', decl: 'src/core/barService.ts', nullSentinel: '<NULL_SENTINEL>' } to KNOWN_BOUNDARY_SETTERS",
    );
  });

  it('keeps the real-repo boundary setter inventory in sync with src/core declarations', () => {
    const repoRoot = join(__dirname, '..', '..');
    for (const entry of KNOWN_BOUNDARY_SETTERS) {
      const absolutePath = join(repoRoot, entry.decl);
      expect(existsSync(absolutePath), entry.decl).toBe(true);
      const source = readFileSync(absolutePath, 'utf8');
      expect(source, entry.name).toMatch(new RegExp(`export\\s+function\\s+${entry.name}\\s*\\(`, 'u'));
    }
  });

  // Self-consistency invariant: the discovery regex must re-derive EVERY
  // classified setter (inventory + grandfather). If a new inventory entry uses
  // a suffix the regex doesn't cover, a future sibling of that shape would ship
  // undiscovered — the exact hole this guard closes. (Widened 260607.)
  it('discovery regex re-discovers every classified setter and covers the widened shapes', () => {
    const matcher = new RegExp(BOUNDARY_SETTER_EXPORT_REGEX.source, 'u');

    for (const entry of [...KNOWN_BOUNDARY_SETTERS, ...GRANDFATHERED_UNCLASSIFIED_SETTERS]) {
      expect(matcher.test(`export function ${entry.name}(`), entry.name).toBe(true);
    }

    // Each widened set* suffix shape is matched, plus the register* prefix.
    for (const name of [
      'setFooProvider', 'setFooService', 'setFooReporter', 'setFooCoordinator',
      'setFooLease', 'setFooResolver', 'setFooTransport', 'setFooFactory',
      'setFooRegistry', 'setFooConfig', 'setFooTracker',
      'registerFoo', 'registerFooHook', 'registerBarProvider',
    ]) {
      expect(matcher.test(`export function ${name}(`), name).toBe(true);
    }

    // Non-boundary shapes must NOT match (false-positive guard): set* suffixes
    // outside the inventory, and lowercase `setup*` / `registerfoo` helpers
    // (excluded by the `(?=[A-Z])` lookahead).
    for (const name of [
      'setFooStore', 'setFooAdapter', 'setFooBar', 'computeFoo', 'getFoo',
      'setupFooService', 'setupPromptService', 'registerfoo', 'reregister',
    ]) {
      expect(matcher.test(`export function ${name}(`), name).toBe(false);
    }
  });

  // The grandfather ratchet must not rot: every entry must still exist and be
  // exported (a dangling entry would silently re-open the discovery hole), and
  // it must not overlap the real inventory.
  // Shrink-only ratchet: pin the exact membership so a future PR cannot silently
  // GROW the grandfather list (which would re-open the discovery hole). To
  // legitimately shrink it (reclassify into the inventory), update this snapshot.
  it('pins GRANDFATHERED_UNCLASSIFIED_SETTERS membership (shrink-only)', () => {
    expect([...GRANDFATHERED_UNCLASSIFIED_SETTERS].map((entry) => entry.name).sort()).toEqual([
      'registerAutomationScript',
      'registerCloudApprovalMetadata',
      'registerContributionRelayExtension',
      'registerLocalTranscriber',
      'registerPreOAuthCallHook',
      'registerSpaceScanCacheInvalidationListener',
      'registerUserQuestionResponseHandler',
      'setCodexVoiceConfig',
      // 260622 meeting-bot backend-config desktop-only DI seam.
      'setMeetingBotBackendConfigProvider',
      'setOAuthCredentialsProvider',
      'setUserQuestionProvenanceResolver',
    ]);
  });

  it('keeps GRANDFATHERED_UNCLASSIFIED_SETTERS in sync with src/core and disjoint from the inventory', () => {
    const repoRoot = join(__dirname, '..', '..');
    const inventoryNames = new Set<string>(KNOWN_BOUNDARY_SETTERS.map((entry) => entry.name));
    for (const entry of GRANDFATHERED_UNCLASSIFIED_SETTERS) {
      expect(inventoryNames.has(entry.name), `${entry.name} must not be in both lists`).toBe(false);
      const absolutePath = join(repoRoot, entry.decl);
      expect(existsSync(absolutePath), entry.decl).toBe(true);
      const source = readFileSync(absolutePath, 'utf8');
      expect(source, entry.name).toMatch(new RegExp(`export\\s+function\\s+${entry.name}\\s*\\(`, 'u'));
    }
  });
});

describe('Rule B — Cloud-Synced AppSettings Capability Gate (CSACG)', () => {
  it('flags an added provider-like inline string-literal union', async () => {
    const result = await runFixture('rule-b-positive-inline-union', {
      changes: [{ file: 'src/shared/types/settings.ts', text: 'someProvider' }],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      ruleId: 'CSACG-capability-flag',
      file: 'src/shared/types/settings.ts',
    });
  });

  it('flags the canonical 260422 same-file alias shape for activeProvider', async () => {
    const result = await runFixture('rule-b-positive-alias-260422', {
      changes: [{ file: 'src/shared/types/settings.ts', text: 'activeProvider' }],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.message).toContain('Setting "activeProvider"');
  });

  it('skips provider-like keys explicitly listed in LOCAL_ONLY_SETTINGS_KEYS_ARRAY', async () => {
    const result = await runFixture('rule-b-negative-local-only', {
      changes: [{ file: 'src/shared/types/settings.ts', text: 'someProvider' }],
    });

    expect(result.violations).toEqual([]);
  });

  it('honors field-level escape hatches', async () => {
    const result = await runFixture('rule-b-escape-hatch', {
      changes: [{ file: 'src/shared/types/settings.ts', text: 'someProvider' }],
    });

    expect(result.violations).toEqual([]);
  });

  it('does not classify nested object fields as top-level AppSettings keys', async () => {
    const result = await runFixture('rule-b-nested-key', {
      changes: [{ file: 'src/shared/types/settings.ts', text: 'enabled?: boolean' }],
    });

    expect(result.violations).toEqual([]);
  });

  it('parses multi-line type declarations', async () => {
    const result = await runFixture('rule-b-multiline-type', {
      changes: [{ file: 'src/shared/types/settings.ts', text: 'someProvider?' }],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.message).toContain('someProvider');
  });

  it('flags multi-line type value edits even when the declaration line is untouched', async () => {
    const result = await runFixture('rule-b-multiline-edit', {
      changes: [{ file: 'src/shared/types/settings.ts', text: "| 'c'" }],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      ruleId: 'CSACG-capability-flag',
      file: 'src/shared/types/settings.ts',
    });
  });

  it('resolves multi-line exported type aliases', async () => {
    const result = await runFixture('rule-b-multiline-alias', {
      changes: [{ file: 'src/shared/types/settings.ts', text: 'activeProvider' }],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.message).toContain('activeProvider');
  });

  it('does not resolve type aliases embedded in block comments', async () => {
    const result = await runFixture('rule-b-alias-in-block-comment', {
      changes: [{ file: 'src/shared/types/settings.ts', text: 'someProvider' }],
    });

    expect(result.violations).toEqual([]);
    expect(result.warnings).toContain(
      'Setting "someProvider" uses type "FakeAlias" which Rule B cannot classify (chained alias / generic / imported type). Cross-file and chained alias resolution is out of scope for this gate. Consider adding "someProvider" to LOCAL_ONLY_SETTINGS_KEYS if desktop-only, or // CROSS_SURFACE_PARITY_EXEMPT: <reason> if intentionally cloud-synced.',
    );
  });

  it('warns when Rule B encounters an unresolvable type identifier', async () => {
    const result = await runFixture('rule-b-unresolvable-alias', {
      changes: [{ file: 'src/shared/types/settings.ts', text: 'someProvider' }],
    });

    expect(result.violations).toEqual([]);
    expect(result.warnings).toContain(
      'Setting "someProvider" uses type "ExternalProvider" which Rule B cannot classify (chained alias / generic / imported type). Cross-file and chained alias resolution is out of scope for this gate. Consider adding "someProvider" to LOCAL_ONLY_SETTINGS_KEYS if desktop-only, or // CROSS_SURFACE_PARITY_EXEMPT: <reason> if intentionally cloud-synced.',
    );
  });

  it('warns when Rule B encounters an imported alias', async () => {
    const result = await runFixture('rule-b-imported-alias', {
      changes: [{ file: 'src/shared/types/settings.ts', text: 'activeProvider' }],
    });

    expect(result.violations).toEqual([]);
    expect(result.warnings).toContain(
      'Setting "activeProvider" uses type "X" which Rule B cannot classify (chained alias / generic / imported type). Cross-file and chained alias resolution is out of scope for this gate. Consider adding "activeProvider" to LOCAL_ONLY_SETTINGS_KEYS if desktop-only, or // CROSS_SURFACE_PARITY_EXEMPT: <reason> if intentionally cloud-synced.',
    );
  });

  it('uses the tightened name regex: voiceEnabled no longer triggers, someProvider still does', async () => {
    const result = await runFixture('rule-b-tightened-regex-coverage', {
      changes: [
        { file: 'src/shared/types/settings.ts', text: 'voiceEnabled' },
        { file: 'src/shared/types/settings.ts', text: 'someProvider' },
      ],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.message).toContain('someProvider');
  });
});

describe('parse-health sentinels', () => {
  it('exits 2 when AppSettings parses zero keys', async () => {
    const { exitCode, stderr } = await runFixtureCli('parse-health-appsettings-empty', ['--all-files']);

    expect(exitCode).toBe(2);
    expect(stderr).toContain('AppSettings parse returned 0 keys');
    expect(stderr).toContain('phase: parse');
  });

  it('exits 2 when AppSettings sentinel keys are missing', async () => {
    const { exitCode, stderr } = await runFixtureCli('parse-health-sentinel-missing', ['--all-files']);

    expect(exitCode).toBe(2);
    expect(stderr).toContain('AppSettings parse missing sentinel keys: activeProvider');
    expect(stderr).toContain('phase: parse');
  });

  it('exits 2 when LOCAL_ONLY_SETTINGS_KEYS parses zero entries', async () => {
    const { exitCode, stderr } = await runFixtureCli('parse-health-local-only-empty', ['--all-files']);

    expect(exitCode).toBe(2);
    expect(stderr).toContain('LOCAL_ONLY_SETTINGS_KEYS parse returned 0 entries');
    expect(stderr).toContain('phase: parse');
  });
});

describe('combined rules and performance', () => {
  it('emits Rule A and Rule B violations sorted by file and line', async () => {
    const result = await runFixture('combined-rule-a-and-b', {
      changes: [
        { file: 'src/core/fooProvider.ts', text: 'setFooProvider' },
        { file: 'src/shared/types/settings.ts', text: 'someProvider' },
      ],
    });

    expect(result.violations.map((violation) => violation.ruleId)).toEqual([
      'BIRP-cloud-missing',
      'CSACG-capability-flag',
    ]);
    expect(result.violations.map((violation) => violation.file)).toEqual([
      'src/core/fooProvider.ts',
      'src/shared/types/settings.ts',
    ]);
  });

  it('keeps representative fixture runtime under 500ms', async () => {
    const startedAt = performance.now();
    await runFixture('combined-rule-a-and-b', { allFiles: true });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500);
  });
});

describe('findExemptCommentNear', () => {
  const exemptFixture = join(fixtureRoot, 'exempt-comment', 'src', 'exempt.ts');
  const blockFixture = join(fixtureRoot, 'block-comment-embedded', 'src', 'block.ts');
  const stringLiteralBlockFixture = join(
    fixtureRoot,
    'escape-hatch-string-literal-paren',
    'src',
    'escape.ts',
  );

  it('accepts an escape hatch on the same line', () => {
    expect(findExemptCommentNear(exemptFixture, 1)).toMatchObject({
      line: 1,
      reason: 'valid same line',
    });
  });

  it('accepts an escape hatch on the line immediately above', () => {
    expect(findExemptCommentNear(exemptFixture, 3)).toMatchObject({
      line: 2,
      reason: 'valid above reason',
    });
  });

  it('rejects an escape hatch two lines above', () => {
    expect(findExemptCommentNear(exemptFixture, 6)).toBeNull();
  });

  it('rejects an escape hatch embedded inside a block comment', () => {
    expect(findExemptCommentNear(blockFixture, 2)).toBeNull();
  });

  it('rejects an escape hatch embedded inside JSDoc', () => {
    expect(findExemptCommentNear(blockFixture, 8)).toBeNull();
  });

  it('rejects an escape hatch enclosed by a single-line block comment', () => {
    const line = lineNumberContaining(blockFixture, 'hiddenSingleLineBlock');

    expect(findExemptCommentNear(blockFixture, line)).toBeNull();
  });

  it('accepts a trailing line-comment escape hatch after a same-line block close', () => {
    const line = lineNumberContaining(blockFixture, 'afterSameLineBlockClose');

    expect(findExemptCommentNear(blockFixture, line)).toMatchObject({
      reason: 'legit reason',
    });
  });

  it('accepts an escape hatch after a string literal containing a block-comment opener', () => {
    const line = lineNumberContaining(stringLiteralBlockFixture, 'afterStringLiteral');

    expect(findExemptCommentNear(stringLiteralBlockFixture, line)).toMatchObject({
      reason: 'legit on next line',
    });
  });

  it('rejects whitespace-only reasons', () => {
    expect(findExemptCommentNear(exemptFixture, 7)).toBeNull();
  });

  it('rejects four-character reasons', () => {
    expect(findExemptCommentNear(exemptFixture, 8)).toBeNull();
  });

  it('accepts five-character reasons', () => {
    const line = lineNumberContaining(exemptFixture, 'five!');

    expect(findExemptCommentNear(exemptFixture, line)).toMatchObject({
      line,
      reason: 'five!',
    });
  });
});

describe('validateExemptionRationale (Stage 9 — rationale quality)', () => {
  it('accepts a rationale that meets the minimum length and contains no weak markers', () => {
    expect(validateExemptionRationale('Desktop-only: requires Electron safeStorage')).toEqual({ strong: true });
  });

  it('rejects a rationale below the minimum length', () => {
    const verdict = validateExemptionRationale('short reason');
    expect(verdict.strong).toBe(false);
    if (verdict.strong) throw new Error('unreachable');
    expect(verdict.explanation).toContain(`minimum ${MIN_STRONG_RATIONALE_LENGTH}`);
    expect(verdict.explanation).toContain('12 characters');
  });

  it('rejects a rationale containing TODO even when long enough', () => {
    const verdict = validateExemptionRationale('Desktop-only: TODO add the real reason here later');
    expect(verdict.strong).toBe(false);
    if (verdict.strong) throw new Error('unreachable');
    expect(verdict.explanation).toContain('TODO');
  });

  it('rejects a rationale containing FIXME', () => {
    const verdict = validateExemptionRationale('FIXME explain this exemption properly soon');
    expect(verdict.strong).toBe(false);
    if (verdict.strong) throw new Error('unreachable');
    expect(verdict.explanation).toContain('FIXME');
  });

  it('rejects a rationale containing temporary', () => {
    const verdict = validateExemptionRationale('Temporary workaround for the cloud bootstrap order');
    expect(verdict.strong).toBe(false);
    if (verdict.strong) throw new Error('unreachable');
    expect(verdict.explanation).toContain('temp/temporary');
  });

  it('rejects a rationale containing later', () => {
    const verdict = validateExemptionRationale('Desktop-only path; we will replace this later somehow');
    expect(verdict.strong).toBe(false);
    if (verdict.strong) throw new Error('unreachable');
    expect(verdict.explanation).toContain('later');
  });

  it('accepts the production-style strict-template rationale', () => {
    const rationale =
      'Desktop-only: requires Electron BrowserWindow + navigation IPC to programmatically navigate the Rebel app shell';
    expect(validateExemptionRationale(rationale)).toEqual({ strong: true });
  });

  it('treats whitespace as non-content when measuring length', () => {
    const verdict = validateExemptionRationale('   short   ');
    expect(verdict.strong).toBe(false);
    if (verdict.strong) throw new Error('unreachable');
    expect(verdict.explanation).toContain('5 characters');
  });
});

describe('Rule B with weak rationale (Stage 9 — wired suppression)', () => {
  it('rejects a weak exemption rationale, surfacing the violation with a warning', async () => {
    const result = await runFixture('rule-b-weak-rationale', {
      changes: [{ file: 'src/shared/types/settings.ts', text: 'someProvider' }],
    });

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.message).toContain('someProvider');
    expect(result.warnings.some((warning) => warning.includes('Exemption rationale rejected'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('TODO'))).toBe(true);
  });
});
