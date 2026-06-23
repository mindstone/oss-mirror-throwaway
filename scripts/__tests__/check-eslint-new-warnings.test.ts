import { describe, expect, it, vi } from 'vitest';
import type { EslintRunner } from '../lib/eslint-warning-audit';
import {
  parseBaseArg,
  resolveBaseSha,
  runDiffScopedCheck,
  type ChangedFileRecord,
  type EnvReader,
  type GitRunner,
} from '../check-eslint-new-warnings';

function createEnv(values: Record<string, string | undefined>): EnvReader {
  return {
    get(name: string) {
      return values[name];
    },
  };
}

function createLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

interface WarningFixture {
  ruleId: string | null;
  line: number;
  column: number;
  message: string;
}

function createWarningsByCount(warningCount: number): WarningFixture[] {
  return Array.from({ length: warningCount }, (_, index) => ({
    ruleId: `rule-${index + 1}`,
    line: index + 1,
    column: 1,
    message: `warning ${index + 1}`,
  }));
}

function createEslintJson(filePath: string, warnings: WarningFixture[]): string {
  const messages = warnings.map((warning) => ({
    ruleId: warning.ruleId,
    severity: 1,
    line: warning.line,
    column: warning.column,
    message: warning.message,
  }));

  return JSON.stringify([
    {
      filePath,
      messages,
    },
  ]);
}

function createEslintRunnerByContent(
  warningsByContent: Map<string, WarningFixture[]>,
): EslintRunner {
  return {
    run: vi.fn(async () => ({ stdout: '[]', stderr: '', exitCode: 0 })),
    runOnStdin: vi.fn(async ({ content, filename }) => {
      const warnings = warningsByContent.get(content) ?? [];
      return {
        stdout: createEslintJson(filename, warnings),
        stderr: '',
        exitCode: warnings.length > 0 ? 1 : 0,
      };
    }),
  };
}

function createEslintRunnerByCounts(
  warningCountByContent: Map<string, number>,
): EslintRunner {
  return createEslintRunnerByContent(
    new Map(
      [...warningCountByContent.entries()].map(([content, warningCount]) => [
        content,
        createWarningsByCount(warningCount),
      ]),
    ),
  );
}

function changedFileModified(path: string): ChangedFileRecord {
  return {
    status: 'M',
    path,
    basePath: path,
  };
}

function changedFileAdded(path: string): ChangedFileRecord {
  return {
    status: 'A',
    path,
    basePath: null,
  };
}

function changedFileRenamed(oldPath: string, newPath: string): ChangedFileRecord {
  return {
    status: 'R',
    path: newPath,
    basePath: oldPath,
  };
}

function createGitRunner(params: {
  changedFiles?: ChangedFileRecord[];
  fileContents?: Map<string, string | null>;
  mergeBaseSha?: string;
  revParseSha?: string;
} = {}): GitRunner & {
  revParse: ReturnType<typeof vi.fn>;
  mergeBase: ReturnType<typeof vi.fn>;
  changedFiles: ReturnType<typeof vi.fn>;
  fileAtRev: ReturnType<typeof vi.fn>;
} {
  const fileContents = params.fileContents ?? new Map<string, string | null>();
  const mergeBaseSha = params.mergeBaseSha ?? 'merge-base-sha';
  const revParseSha = params.revParseSha ?? 'resolved-ref-sha';

  const revParse = vi.fn(async () => revParseSha);
  const mergeBase = vi.fn(async () => mergeBaseSha);
  const changedFiles = vi.fn(async () => params.changedFiles ?? []);
  const fileAtRev = vi.fn(async (rev: string, filePath: string) => {
    return fileContents.get(`${rev}:${filePath}`) ?? null;
  });

  return {
    revParse,
    mergeBase,
    changedFiles,
    fileAtRev,
  };
}

describe('parseBaseArg', () => {
  it('parses --base values', () => {
    expect(parseBaseArg(['--base=HEAD~3'])).toBe('HEAD~3');
  });

  it('throws on unsupported arguments', () => {
    expect(() => parseBaseArg(['--no-such-flag'])).toThrow(
      'Unsupported argument: --no-such-flag',
    );
  });
});

describe('resolveBaseSha', () => {
  it('uses --base ref when provided and logs env override', async () => {
    const env = createEnv({ BASE_SHA: 'from-env' });
    const git = createGitRunner({ revParseSha: 'from-flag' });
    const logger = createLogger();

    const result = await resolveBaseSha(env, git, {
      baseRef: 'HEAD~3',
      logger,
    });

    expect(git.revParse).toHaveBeenCalledWith('HEAD~3');
    expect(git.mergeBase).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'usable', sha: 'from-flag' });
    expect(logger.log).toHaveBeenCalledWith(
      '[eslint-new-warnings] --base=HEAD~3 provided; overriding BASE_SHA env value.',
    );
  });

  it('returns usable BASE_SHA when env value is set', async () => {
    const env = createEnv({ BASE_SHA: 'abc123' });
    const git = createGitRunner();

    const result = await resolveBaseSha(env, git);

    expect(result).toEqual({ kind: 'usable', sha: 'abc123' });
    expect(git.revParse).not.toHaveBeenCalled();
    expect(git.mergeBase).not.toHaveBeenCalled();
  });

  // The ESLint gate's opt-in fallback refs (default resolveBaseSha skips when
  // unset; only callers that pass these walk the merge-base chain). Mirrors
  // ESLINT_GATE_MERGE_BASE_FALLBACK_REFS in the source.
  const ESLINT_FALLBACK_REFS = ['@{upstream}', 'origin/dev'] as const;

  it('skips when BASE_SHA env is unset and NO fallback refs are opted in (default — preserves knip-diff-guard contract)', async () => {
    const env = createEnv({});
    const git = createGitRunner();

    const result = await resolveBaseSha(env, git);

    expect(result).toEqual({ kind: 'skip', reason: 'BASE_SHA env not set' });
    expect(git.revParse).not.toHaveBeenCalled();
    expect(git.mergeBase).not.toHaveBeenCalled();
  });

  it('falls back to @{upstream} merge-base when BASE_SHA unset AND opted in (D3)', async () => {
    const env = createEnv({});
    const git = createGitRunner({ mergeBaseSha: 'upstream-merge-base' });

    const result = await resolveBaseSha(env, git, {
      mergeBaseFallbackRefs: ESLINT_FALLBACK_REFS,
    });

    expect(git.revParse).not.toHaveBeenCalled();
    expect(git.mergeBase).toHaveBeenCalledWith('@{upstream}', 'HEAD');
    expect(result).toEqual({ kind: 'usable', sha: 'upstream-merge-base' });
  });

  it('falls through to origin/dev merge-base when @{upstream} fails (D3, opted in)', async () => {
    const env = createEnv({});
    const git = createGitRunner();
    git.mergeBase
      .mockRejectedValueOnce(new Error('no upstream configured for HEAD'))
      .mockResolvedValueOnce('origin-dev-merge-base');

    const result = await resolveBaseSha(env, git, {
      mergeBaseFallbackRefs: ESLINT_FALLBACK_REFS,
    });

    expect(git.mergeBase).toHaveBeenNthCalledWith(1, '@{upstream}', 'HEAD');
    expect(git.mergeBase).toHaveBeenNthCalledWith(2, 'origin/dev', 'HEAD');
    expect(result).toEqual({ kind: 'usable', sha: 'origin-dev-merge-base' });
  });

  it('loud-skips when BASE_SHA is unset and BOTH opted-in fallback rungs fail (D3)', async () => {
    const env = createEnv({});
    const git = createGitRunner();
    git.mergeBase
      .mockRejectedValueOnce(new Error('no upstream configured for HEAD'))
      .mockRejectedValueOnce(new Error('unknown revision origin/dev'));

    const result = await resolveBaseSha(env, git, {
      mergeBaseFallbackRefs: ESLINT_FALLBACK_REFS,
    });

    expect(result.kind).toBe('skip');
    expect(result.reason).toContain('BASE_SHA env not set and no fallback base resolved');
    expect(result.reason).toContain('git merge-base @{upstream} HEAD');
    expect(result.reason).toContain('git merge-base origin/dev HEAD');
  });

  it('falls back to merge-base when BASE_SHA is all zeros', async () => {
    const env = createEnv({
      BASE_SHA: '0000000000000000000000000000000000000000',
    });
    const git = createGitRunner({ mergeBaseSha: 'fallback-merge-base' });

    const result = await resolveBaseSha(env, git);

    expect(git.revParse).not.toHaveBeenCalled();
    expect(git.mergeBase).toHaveBeenCalledWith('origin/dev', 'HEAD');
    expect(result).toEqual({ kind: 'usable', sha: 'fallback-merge-base' });
  });
});

describe('runDiffScopedCheck', () => {
  it('uses --base arg when BASE_SHA is missing', async () => {
    const env = createEnv({});
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/example.ts', 'head-content'],
      ['resolved-base:src/example.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileModified('src/example.ts')],
      fileContents,
      revParseSha: 'resolved-base',
    });
    const eslint = createEslintRunnerByCounts(
      new Map([
        ['head-content', 1],
        ['base-content', 1],
      ]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({
      env,
      git,
      eslint,
      logger,
      args: ['--base=HEAD~3'],
    });

    expect(result).toEqual({
      failed: false,
      status: 'ok',
      regressions: [],
    });
    expect(git.revParse).toHaveBeenCalledWith('HEAD~3');
    expect(git.changedFiles).toHaveBeenCalledWith('resolved-base', 'HEAD');
  });

  it('returns ok when no changed files are found', async () => {
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const git = createGitRunner({ changedFiles: [] });
    const eslint = createEslintRunnerByCounts(new Map());
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result).toEqual({
      failed: false,
      status: 'ok',
      regressions: [],
    });
  });

  it('returns ok when a changed file has no warning increase', async () => {
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/example.ts', 'head-content'],
      ['base-sha:src/example.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileModified('src/example.ts')],
      fileContents,
    });
    const eslint = createEslintRunnerByCounts(
      new Map([
        ['head-content', 2],
        ['base-content', 2],
      ]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.status).toBe('ok');
    expect(result.failed).toBe(false);
    expect(result.regressions).toHaveLength(0);
  });

  it('returns regressions when a changed file gains warnings', async () => {
    const env = createEnv({
      BASE_SHA: 'base-sha',
      GITHUB_ACTIONS: 'true',
    });
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/regressed.ts', 'head-content'],
      ['base-sha:src/regressed.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileModified('src/regressed.ts')],
      fileContents,
    });
    const eslint = createEslintRunnerByCounts(
      new Map([
        ['head-content', 3],
        ['base-content', 1],
      ]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.status).toBe('regressions');
    expect(result.failed).toBe(true);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toMatchObject({
      filePath: 'src/regressed.ts',
      baselineCount: 1,
      currentCount: 3,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('::warning file=src/regressed.ts'),
    );
  });

  it('loud-skips on stderr when no base is derivable (D3)', async () => {
    const env = createEnv({});
    const git = createGitRunner();
    // Both fallback rungs fail → no base derivable.
    git.mergeBase
      .mockRejectedValueOnce(new Error('no upstream configured for HEAD'))
      .mockRejectedValueOnce(new Error('unknown revision origin/dev'));
    const eslint = createEslintRunnerByCounts(new Map());
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.failed).toBe(false);
    expect(result.status).toBe('skipped');
    expect(result.regressions).toEqual([]);
    // LOUD: a visible human-readable banner on stderr (logger.warn), not just
    // the buried structured JSON line on logger.log.
    const warnLines = logger.warn.mock.calls.map(([line]) => String(line));
    expect(
      warnLines.some((line) => line.includes('[eslint-new-warnings] SKIPPED')),
    ).toBe(true);
  });

  it('loud-skips (exit 0, not fail) when git diff infra throws (D3 / GPT-r2-F1)', async () => {
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const git = createGitRunner();
    git.changedFiles.mockRejectedValue(
      new Error('git diff failed with code 128: bad object base-sha'),
    );
    const eslint = createEslintRunnerByCounts(new Map());
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.failed).toBe(false);
    expect(result.status).toBe('skipped');
    expect(result.skippedReason).toContain('base-prep-failed (git diff)');
    const warnLines = logger.warn.mock.calls.map(([line]) => String(line));
    expect(
      warnLines.some((line) => line.includes('[eslint-new-warnings] SKIPPED')),
    ).toBe(true);
  });

  it('loud-skips (exit 0, not fail) when a per-file ESLint/read infra op throws (D3)', async () => {
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/example.ts', 'head-content'],
      ['base-sha:src/example.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileModified('src/example.ts')],
      fileContents,
    });
    const eslint: EslintRunner = {
      run: vi.fn(async () => ({ stdout: '[]', stderr: '', exitCode: 0 })),
      runOnStdin: vi.fn(async () => {
        throw new Error('ESLint stdin worker crashed');
      }),
    };
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.failed).toBe(false);
    expect(result.status).toBe('skipped');
    expect(result.skippedReason).toContain('base-prep-failed (per-file lint/read');
    // F7 (Claude): the per-file infra skip must also be LOUD on stderr.
    const warnLines = logger.warn.mock.calls.map(([line]) => String(line));
    expect(
      warnLines.some((line) => line.includes('[eslint-new-warnings] SKIPPED')),
    ).toBe(true);
  });

  it('loud-skips (exit 0) and emits the banner when base-resolution infra throws (D3, F8)', async () => {
    // The all-zeros BASE_SHA path calls git.mergeBase during resolveBaseSha; a
    // throw there is an infra failure that must degrade to a LOUD skip, NOT
    // exit 1. This covers the outer base-resolution catch branch.
    const env = createEnv({
      BASE_SHA: '0000000000000000000000000000000000000000',
    });
    const git = createGitRunner();
    git.mergeBase.mockRejectedValue(
      new Error('git merge-base origin/dev HEAD failed with code 128'),
    );
    const eslint = createEslintRunnerByCounts(new Map());
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.failed).toBe(false);
    expect(result.status).toBe('skipped');
    expect(result.skippedReason).toContain('base-prep-failed (base resolution)');
    const warnLines = logger.warn.mock.calls.map(([line]) => String(line));
    expect(
      warnLines.some((line) => line.includes('[eslint-new-warnings] SKIPPED')),
    ).toBe(true);
  });

  it('FAILS CLOSED (throws, not skip) when a malformed CLI arg is passed (GPT-F2)', async () => {
    // A usage/config error is NOT a D3 infra failure: it must propagate (→ exit
    // 1 at the CLI), never normalize into status:"skipped"/exit 0.
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const git = createGitRunner();
    const eslint = createEslintRunnerByCounts(new Map());
    const logger = createLogger();

    await expect(
      runDiffScopedCheck({
        env,
        git,
        eslint,
        logger,
        args: ['--bad-arg'],
      }),
    ).rejects.toThrow('Unsupported argument: --bad-arg');
    // It must not have logged a loud-skip / silently passed.
    expect(git.changedFiles).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED (throws, not skip) when the comparator/detection logic throws (GPT-F1)', async () => {
    // A bug in findNewWarnings is NOT infra — it must propagate and fail closed,
    // never be normalized into a skip that silently disables enforcement.
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/example.ts', 'head-content'],
      ['base-sha:src/example.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileModified('src/example.ts')],
      fileContents,
    });
    const eslint = createEslintRunnerByCounts(
      new Map([
        ['head-content', 1],
        ['base-content', 1],
      ]),
    );
    const logger = createLogger();

    await expect(
      runDiffScopedCheck({
        env,
        git,
        eslint,
        logger,
        detectNewWarnings: () => {
          throw new Error('comparator bug: cannot read undefined');
        },
      }),
    ).rejects.toThrow('comparator bug');
    // A comparator throw must NOT be reported as a loud skip.
    const warnLines = logger.warn.mock.calls.map(([line]) => String(line));
    expect(
      warnLines.some((line) => line.includes('[eslint-new-warnings] SKIPPED')),
    ).toBe(false);
  });

  it('FAILS (does not skip) when a base resolves via fallback and a new swallow lands (D3)', async () => {
    // BASE_SHA unset → resolves via the @{upstream} merge-base fallback; a new
    // warning in a changed file must STILL fail — only infra failures skip.
    const env = createEnv({});
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/regressed.ts', 'head-content'],
      ['fallback-base:src/regressed.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileModified('src/regressed.ts')],
      fileContents,
      mergeBaseSha: 'fallback-base',
    });
    const eslint = createEslintRunnerByContent(
      new Map([
        ['base-content', []],
        [
          'head-content',
          [
            {
              ruleId: 'rebel-silent-swallow/no-silent-swallow',
              line: 12,
              column: 5,
              message: 'Empty catch block silently swallows the error.',
            },
          ],
        ],
      ]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(git.mergeBase).toHaveBeenCalledWith('@{upstream}', 'HEAD');
    expect(result.failed).toBe(true);
    expect(result.status).toBe('regressions');
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].newWarnings[0].ruleId).toBe(
      'rebel-silent-swallow/no-silent-swallow',
    );
  });

  it('treats newly added files as baseline zero', async () => {
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/new-file.ts', 'head-content'],
      ['base-sha:src/new-file.ts', null],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileAdded('src/new-file.ts')],
      fileContents,
    });
    const eslint = createEslintRunnerByCounts(new Map([['head-content', 2]]));
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.status).toBe('regressions');
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toMatchObject({
      filePath: 'src/new-file.ts',
      baselineCount: 0,
      currentCount: 2,
    });
  });

  it('filters out deleted and non-source files', async () => {
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/kept.ts', 'kept-head'],
      ['base-sha:src/kept.ts', 'kept-base'],
      ['HEAD:src/deleted.ts', null],
      ['base-sha:src/deleted.ts', 'old-content'],
      ['HEAD:scripts/not-in-lint-roots.ts', 'script-head'],
      ['base-sha:scripts/not-in-lint-roots.ts', 'script-base'],
    ]);
    const git = createGitRunner({
      changedFiles: [
        changedFileModified('docs/readme.md'),
        changedFileModified('src/deleted.ts'),
        changedFileModified('scripts/not-in-lint-roots.ts'),
        changedFileModified('src/kept.ts'),
      ],
      fileContents,
    });
    const eslint = createEslintRunnerByCounts(
      new Map([
        ['kept-head', 1],
        ['kept-base', 1],
      ]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.status).toBe('ok');
    expect(git.fileAtRev).toHaveBeenCalledWith('HEAD', 'src/deleted.ts');
    expect((eslint.runOnStdin as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(
      '[eslint-new-warnings] Skipping src/deleted.ts because file is not present at HEAD.',
    );
  });

  it('uses old-path baseline for pure rename without edits', async () => {
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/new-name.ts', 'shared-content'],
      ['base-sha:src/old-name.ts', 'shared-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileRenamed('src/old-name.ts', 'src/new-name.ts')],
      fileContents,
    });
    const eslint = createEslintRunnerByCounts(new Map([['shared-content', 2]]));
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.status).toBe('ok');
    expect(git.fileAtRev).toHaveBeenCalledWith('base-sha', 'src/old-name.ts');
    expect(git.fileAtRev).not.toHaveBeenCalledWith('base-sha', 'src/new-name.ts');
  });

  it('detects new warning when a renamed file is edited', async () => {
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/new-name.ts', 'head-content'],
      ['base-sha:src/old-name.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileRenamed('src/old-name.ts', 'src/new-name.ts')],
      fileContents,
    });
    const eslint = createEslintRunnerByContent(
      new Map([
        [
          'base-content',
          [
            {
              ruleId: 'no-console',
              line: 10,
              column: 1,
              message: 'Unexpected console statement.',
            },
          ],
        ],
        [
          'head-content',
          [
            {
              ruleId: 'no-console',
              line: 10,
              column: 1,
              message: 'Unexpected console statement.',
            },
            {
              ruleId: '@typescript-eslint/no-explicit-any',
              line: 50,
              column: 7,
              message: 'Unexpected any. Specify a different type.',
            },
          ],
        ],
      ]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.status).toBe('regressions');
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].newWarnings).toEqual([
      {
        ruleId: '@typescript-eslint/no-explicit-any',
        line: 50,
        column: 7,
        message: 'Unexpected any. Specify a different type.',
      },
    ]);
    expect(git.fileAtRev).toHaveBeenCalledWith('base-sha', 'src/old-name.ts');
  });

  it('does not regress when renamed-and-edited warnings only shift columns', async () => {
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/new-name.ts', 'head-content'],
      ['base-sha:src/old-name.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileRenamed('src/old-name.ts', 'src/new-name.ts')],
      fileContents,
    });
    const eslint = createEslintRunnerByContent(
      new Map([
        [
          'base-content',
          [
            {
              ruleId: 'no-console',
              line: 10,
              column: 1,
              message: 'Unexpected console statement.',
            },
          ],
        ],
        [
          'head-content',
          [
            {
              ruleId: 'no-console',
              line: 10,
              column: 9,
              message: 'Unexpected console statement.',
            },
          ],
        ],
      ]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.status).toBe('ok');
    expect(result.regressions).toHaveLength(0);
  });

  it('PINS the coverage-surface-changing rename limitation (D5): a file moved from an exempt path (evals/) into a covered path (src/) has its pre-existing swallows absorbed as baseline, NOT flagged as new', async () => {
    // D5 (docs/plans/260612_silent-swallow-gate/PLAN.md): this gate lints the
    // BASE content under the NEW path, so when an unedited file moves from a
    // surface where rebel-silent-swallow is exempt (e.g. evals/) into a covered
    // surface (e.g. src/), the swallows already in that file appear in BOTH the
    // baseline lint (old path content, linted under the new path's config) and
    // the HEAD lint — so they cancel out and are treated as pre-existing, not
    // new. The gate therefore does NOT catch them on the rename commit.
    //
    // This is a DOCUMENTED, INTENTIONAL limitation, not a silent gap. Making it
    // baseline-zero would require teaching this generic per-rule gate the
    // silent-swallow surface-coverage model (so it could tell that the OLD
    // path's surface differs from the NEW path's) — a disproportionate coupling
    // both confirming CE2 reviewers endorsed avoiding. The residual exposure is
    // narrow: the moved swallows are still subject to the always-on
    // `--max-warnings 3000` cap, and the FIRST edit to that file under its new
    // covered path re-lints it and would flag any swallow added thereafter.
    // This test exists to make the behaviour explicit and trip if it ever
    // silently changes.
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const swallowWarning = {
      ruleId: 'rebel-silent-swallow/no-silent-swallow',
      line: 5,
      column: 3,
      message: 'Avoid silently swallowing errors.',
    };
    const fileContents = new Map<string, string | null>([
      // Unedited move: identical content at the old (exempt) and new (covered) path.
      ['HEAD:src/moved-from-evals.ts', 'swallow-content'],
      ['base-sha:evals/moved-from-evals.ts', 'swallow-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [
        changedFileRenamed('evals/moved-from-evals.ts', 'src/moved-from-evals.ts'),
      ],
      fileContents,
    });
    // Both the base read (old-path content) and the HEAD read are linted under
    // the NEW path (src/), so both surface the same swallow → it cancels.
    const eslint = createEslintRunnerByContent(
      new Map([['swallow-content', [swallowWarning]]]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    // Observed (and documented) behaviour: the pre-existing swallow is treated
    // as baseline, so the rename commit passes. If this ever flips to
    // 'regressions' the limitation has been closed — update the docs in
    // CODE_HEALTH_TOOLS.md and the D5 note accordingly.
    expect(result.status).toBe('ok');
    expect(result.regressions).toHaveLength(0);
    expect(git.fileAtRev).toHaveBeenCalledWith('base-sha', 'evals/moved-from-evals.ts');
  });

  it('still catches a NEW swallow added while renaming evals/ -> src/ (D5: the edit path is covered)', async () => {
    // Complements the limitation test: the gate is blind only to PRE-EXISTING
    // swallows carried across the coverage boundary. A swallow ADDED in the
    // same commit (head has more than base) is still caught, because the base
    // lint (old-path content) does not contain it.
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const carriedSwallow = {
      ruleId: 'rebel-silent-swallow/no-silent-swallow',
      line: 5,
      column: 3,
      message: 'Avoid silently swallowing errors.',
    };
    const addedSwallow = {
      ruleId: 'rebel-silent-swallow/no-silent-swallow',
      line: 20,
      column: 3,
      message: 'Avoid silently swallowing errors.',
    };
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/moved-from-evals.ts', 'head-content'],
      ['base-sha:evals/moved-from-evals.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [
        changedFileRenamed('evals/moved-from-evals.ts', 'src/moved-from-evals.ts'),
      ],
      fileContents,
    });
    const eslint = createEslintRunnerByContent(
      new Map([
        ['base-content', [carriedSwallow]],
        ['head-content', [carriedSwallow, addedSwallow]],
      ]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.status).toBe('regressions');
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].newWarnings).toEqual([addedSwallow]);
  });

  it('PINS the same-signature swap residual (GPT-final-F1): removing one swallow and adding another with an identical (ruleId, message) in the same changed file does NOT regress', async () => {
    // The shared gate compares a MULTISET of (ruleId, message) signatures,
    // line/col-insensitive (so merge/rebase line-shifts don't false-positive).
    // Consequence: a same-file remove-one-swallow / add-one-swallow swap where
    // both produce the IDENTICAL message signature nets out (base count == head
    // count for that signature) → the gate reports no regression. This is an
    // ACCEPTED, documented residual (narrower than the old global count
    // ratchet's blind spot, which netted across the WHOLE codebase). We do NOT
    // make the shared gate line/diff-aware for one rule — that would diverge its
    // semantics. Backstops that still apply: the `--max-warnings 3000` cap
    // (mass growth) and the rule-presence smoke (disablement). Documented in
    // CODE_HEALTH_TOOLS.md § Silent-swallow gate. This test trips if the
    // behaviour ever silently changes.
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const swallow = {
      ruleId: 'rebel-silent-swallow/no-silent-swallow',
      column: 3,
      message: 'Avoid silently swallowing errors.',
    };
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/example.ts', 'head-content'],
      ['base-sha:src/example.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileModified('src/example.ts')],
      fileContents,
    });
    // Base has one swallow at line 5; head removed it and added a DIFFERENT
    // swallow at line 40 — same (ruleId, message), so the signature count is
    // unchanged (1 == 1) and the multiset comparison cancels them.
    const eslint = createEslintRunnerByContent(
      new Map([
        ['base-content', [{ ...swallow, line: 5 }]],
        ['head-content', [{ ...swallow, line: 40 }]],
      ]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.status).toBe('ok');
    expect(result.regressions).toHaveLength(0);
  });

  it('still fails on a NET-INCREASE of the same-signature swallow count (GPT-final-F1 contrast)', async () => {
    // Contrast to the swap residual: adding a swallow WITHOUT removing one
    // (head signature count > base) is a genuine net-new and DOES fail, since
    // the multiset only absorbs one current occurrence per baseline occurrence.
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const swallow = {
      ruleId: 'rebel-silent-swallow/no-silent-swallow',
      column: 3,
      message: 'Avoid silently swallowing errors.',
    };
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/example.ts', 'head-content'],
      ['base-sha:src/example.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileModified('src/example.ts')],
      fileContents,
    });
    const eslint = createEslintRunnerByContent(
      new Map([
        ['base-content', [{ ...swallow, line: 5 }]],
        ['head-content', [{ ...swallow, line: 5 }, { ...swallow, line: 40 }]],
      ]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.status).toBe('regressions');
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].newWarnings).toHaveLength(1);
  });

  it('annotates only actually new warning lines', async () => {
    const env = createEnv({
      BASE_SHA: 'base-sha',
      GITHUB_ACTIONS: 'true',
    });
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/example.ts', 'head-content'],
      ['base-sha:src/example.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileModified('src/example.ts')],
      fileContents,
    });
    const eslint = createEslintRunnerByContent(
      new Map([
        [
          'base-content',
          [
            {
              ruleId: 'no-console',
              line: 10,
              column: 1,
              message: 'Unexpected console statement.',
            },
          ],
        ],
        [
          'head-content',
          [
            {
              ruleId: 'no-console',
              line: 10,
              column: 1,
              message: 'Unexpected console statement.',
            },
            {
              ruleId: '@typescript-eslint/no-explicit-any',
              line: 50,
              column: 3,
              message: 'Unexpected any. Specify a different type.',
            },
          ],
        ],
      ]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });
    const annotationLines = logger.warn.mock.calls.map(([line]) => String(line));

    expect(result.status).toBe('regressions');
    expect(result.regressions[0].newWarnings).toHaveLength(1);
    expect(result.regressions[0].newWarnings[0].line).toBe(50);
    expect(annotationLines.some((line) => line.includes('line=50'))).toBe(true);
    expect(annotationLines.some((line) => line.includes('line=10'))).toBe(false);
  });

  it('does not regress when an existing warning only moves lines', async () => {
    const env = createEnv({
      BASE_SHA: 'base-sha',
      GITHUB_ACTIONS: 'true',
    });
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/moved-warning.ts', 'head-content'],
      ['base-sha:src/moved-warning.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileModified('src/moved-warning.ts')],
      fileContents,
    });
    const eslint = createEslintRunnerByContent(
      new Map([
        [
          'base-content',
          [
            {
              ruleId: 'no-console',
              line: 10,
              column: 1,
              message: 'Unexpected console statement.',
            },
          ],
        ],
        [
          'head-content',
          [
            {
              ruleId: 'no-console',
              line: 15,
              column: 1,
              message: 'Unexpected console statement.',
            },
          ],
        ],
      ]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });
    const annotationLines = logger.warn.mock.calls.map(([line]) => String(line));

    expect(result.status).toBe('ok');
    expect(result.failed).toBe(false);
    expect(result.regressions).toHaveLength(0);
    expect(annotationLines).toHaveLength(0);
  });

  it('treats same-rule warnings on different lines as new warnings', async () => {
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/rule-repeat.ts', 'head-content'],
      ['base-sha:src/rule-repeat.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileModified('src/rule-repeat.ts')],
      fileContents,
    });
    const eslint = createEslintRunnerByContent(
      new Map([
        [
          'base-content',
          [
            {
              ruleId: 'no-console',
              line: 10,
              column: 1,
              message: 'Unexpected console statement.',
            },
          ],
        ],
        [
          'head-content',
          [
            {
              ruleId: 'no-console',
              line: 10,
              column: 1,
              message: 'Unexpected console statement.',
            },
            {
              ruleId: 'no-console',
              line: 25,
              column: 1,
              message: 'Unexpected console statement.',
            },
          ],
        ],
      ]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.status).toBe('regressions');
    expect(result.regressions[0].newWarnings).toEqual([
      {
        ruleId: 'no-console',
        line: 25,
        column: 1,
        message: 'Unexpected console statement.',
      },
    ]);
  });

  it('detects multiplicity regressions for same-signature warnings', async () => {
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/multiplicity.ts', 'head-content'],
      ['base-sha:src/multiplicity.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileModified('src/multiplicity.ts')],
      fileContents,
    });
    const eslint = createEslintRunnerByContent(
      new Map([
        [
          'base-content',
          [
            {
              ruleId: 'no-console',
              line: 50,
              column: 3,
              message: 'Unexpected console statement.',
            },
          ],
        ],
        [
          'head-content',
          [
            {
              ruleId: 'no-console',
              line: 50,
              column: 3,
              message: 'Unexpected console statement.',
            },
            {
              ruleId: 'no-console',
              line: 50,
              column: 19,
              message: 'Unexpected console statement.',
            },
          ],
        ],
      ]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.status).toBe('regressions');
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].newWarnings).toEqual([
      {
        ruleId: 'no-console',
        line: 50,
        column: 19,
        message: 'Unexpected console statement.',
      },
    ]);
  });

  it('does not report regressions when signature multiplicity decreases', async () => {
    const env = createEnv({ BASE_SHA: 'base-sha' });
    const fileContents = new Map<string, string | null>([
      ['HEAD:src/multiplicity-down.ts', 'head-content'],
      ['base-sha:src/multiplicity-down.ts', 'base-content'],
    ]);
    const git = createGitRunner({
      changedFiles: [changedFileModified('src/multiplicity-down.ts')],
      fileContents,
    });
    const eslint = createEslintRunnerByContent(
      new Map([
        [
          'base-content',
          [
            {
              ruleId: 'no-console',
              line: 50,
              column: 3,
              message: 'Unexpected console statement.',
            },
            {
              ruleId: 'no-console',
              line: 50,
              column: 11,
              message: 'Unexpected console statement.',
            },
            {
              ruleId: 'no-console',
              line: 50,
              column: 19,
              message: 'Unexpected console statement.',
            },
          ],
        ],
        [
          'head-content',
          [
            {
              ruleId: 'no-console',
              line: 50,
              column: 3,
              message: 'Unexpected console statement.',
            },
            {
              ruleId: 'no-console',
              line: 50,
              column: 11,
              message: 'Unexpected console statement.',
            },
          ],
        ],
      ]),
    );
    const logger = createLogger();

    const result = await runDiffScopedCheck({ env, git, eslint, logger });

    expect(result.status).toBe('ok');
    expect(result.failed).toBe(false);
    expect(result.regressions).toHaveLength(0);
  });
});
