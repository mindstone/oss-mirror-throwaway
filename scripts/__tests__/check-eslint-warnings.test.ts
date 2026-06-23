import { describe, expect, it, vi } from 'vitest';
import {
  RULE_BASELINES,
  checkBaselines,
  main,
  parseRepeatArg,
  runRepeatedEslintAudit,
} from '../check-eslint-warnings';
import {
  DEFAULT_ESLINT_PATHS,
  parseEslintJson,
  runEslintAudit,
  type EslintRunner,
} from '../lib/eslint-warning-audit';
import { SILENT_SWALLOW_RULE_ID } from '../silent-swallow-budgets';

const ESLINT_AUDIT_ARGS = [
  '--format',
  'json',
  '--no-warn-ignored',
  '--max-warnings',
  '99999',
  '--cache',
  '--cache-location',
  'node_modules/.cache/eslint/',
] as const;

describe('parseEslintJson', () => {
  it('parses normal warning output', () => {
    const stdout = JSON.stringify([
      {
        filePath: 'src/a.ts',
        messages: [
          {
            ruleId: '@typescript-eslint/no-unused-vars',
            severity: 1,
            line: 10,
            column: 2,
            message: 'unused var',
          },
        ],
      },
      {
        filePath: 'src/b.ts',
        messages: [
          {
            ruleId: 'no-console',
            severity: 1,
            line: 3,
            column: 1,
            message: 'Unexpected console statement',
          },
        ],
      },
    ]);

    const result = parseEslintJson(stdout);

    expect(result.totalWarnings).toBe(2);
    expect(result.perRuleCounts.get('@typescript-eslint/no-unused-vars')).toBe(
      1,
    );
    expect(result.perRuleCounts.get('no-console')).toBe(1);
    expect(result.warnings).toHaveLength(2);
  });

  it('ignores severity 0 entries', () => {
    const stdout = JSON.stringify([
      {
        filePath: 'src/a.ts',
        messages: [
          {
            ruleId: 'no-console',
            severity: 0,
            line: 1,
            column: 1,
            message: 'informational',
          },
        ],
      },
    ]);

    const result = parseEslintJson(stdout);

    expect(result.totalWarnings).toBe(0);
    expect(result.perRuleCounts.size).toBe(0);
  });

  it('ignores severity 2 entries', () => {
    const stdout = JSON.stringify([
      {
        filePath: 'src/a.ts',
        messages: [
          {
            ruleId: '@typescript-eslint/no-explicit-any',
            severity: 2,
            line: 1,
            column: 1,
            message: 'error',
          },
        ],
      },
    ]);

    const result = parseEslintJson(stdout);

    expect(result.totalWarnings).toBe(0);
    expect(result.perRuleCounts.size).toBe(0);
  });

  it('counts severity 1 entries', () => {
    const stdout = JSON.stringify([
      {
        filePath: 'src/a.ts',
        messages: [
          {
            ruleId: '@typescript-eslint/no-explicit-any',
            severity: 1,
            line: 1,
            column: 1,
            message: 'warning',
          },
        ],
      },
    ]);

    const result = parseEslintJson(stdout);

    expect(result.totalWarnings).toBe(1);
    expect(result.perRuleCounts.get('@typescript-eslint/no-explicit-any')).toBe(
      1,
    );
  });

  it('buckets null ruleId under the null key', () => {
    const stdout = JSON.stringify([
      {
        filePath: 'src/a.ts',
        messages: [
          {
            ruleId: null,
            severity: 1,
            line: 7,
            column: 3,
            message: 'Unused disable directive',
          },
        ],
      },
    ]);

    const result = parseEslintJson(stdout);

    expect(result.totalWarnings).toBe(1);
    expect(result.perRuleCounts.get('null')).toBe(1);
    expect(result.warnings[0]?.ruleId).toBeNull();
  });

  it('handles empty lint results', () => {
    const result = parseEslintJson('[]');

    expect(result.totalWarnings).toBe(0);
    expect(result.perRuleCounts.size).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it('throws on malformed JSON output', () => {
    expect(() => parseEslintJson('{not valid json')).toThrow(
      'Failed to parse ESLint JSON output',
    );
  });
});

describe('checkBaselines', () => {
  it('passes when all tracked rules are at or below baseline', () => {
    const baselines: typeof RULE_BASELINES = [
      { ruleId: 'alpha', baseline: 2 },
      { ruleId: 'null', baseline: 1 },
    ];
    const perRuleCounts = new Map<string, number>([
      ['alpha', 2],
      ['null', 1],
    ]);

    const result = checkBaselines(perRuleCounts, baselines);

    expect(result.failed).toBe(false);
    expect(result.failures).toEqual([]);
  });

  it('fails when a baseline rule regresses', () => {
    const baselines: typeof RULE_BASELINES = [{ ruleId: 'alpha', baseline: 1 }];
    const perRuleCounts = new Map<string, number>([['alpha', 2]]);

    const result = checkBaselines(perRuleCounts, baselines);

    expect(result.failed).toBe(true);
    expect(result.failures).toEqual([
      {
        ruleId: 'alpha',
        observed: 2,
        baseline: 1,
        kind: 'regression',
      },
    ]);
  });

  it('fails when a new warning rule appears', () => {
    const baselines: typeof RULE_BASELINES = [{ ruleId: 'alpha', baseline: 5 }];
    const perRuleCounts = new Map<string, number>([
      ['alpha', 1],
      ['beta', 1],
    ]);

    const result = checkBaselines(perRuleCounts, baselines);

    expect(result.failed).toBe(true);
    expect(result.failures).toEqual([
      {
        ruleId: 'beta',
        observed: 1,
        baseline: 0,
        kind: 'new_rule',
      },
    ]);
  });

  it('does not flag silent-swallow as a new rule (intentionally untracked — count baseline retired Stage 3)', () => {
    const baselines: typeof RULE_BASELINES = [{ ruleId: 'alpha', baseline: 5 }];
    const perRuleCounts = new Map<string, number>([
      ['alpha', 1],
      [SILENT_SWALLOW_RULE_ID, 2235],
    ]);

    const result = checkBaselines(perRuleCounts, baselines);

    expect(result.failed).toBe(false);
    expect(result.failures).toEqual([]);
  });

  it('passes when a non-baseline rule has zero warnings', () => {
    const baselines: typeof RULE_BASELINES = [{ ruleId: 'alpha', baseline: 5 }];
    const perRuleCounts = new Map<string, number>([
      ['alpha', 1],
      ['beta', 0],
    ]);

    const result = checkBaselines(perRuleCounts, baselines);

    expect(result.failed).toBe(false);
    expect(result.failures).toEqual([]);
  });
});

describe('parseRepeatArg', () => {
  it('defaults to one run when --repeat is omitted', () => {
    expect(parseRepeatArg([])).toBe(1);
  });

  it('throws on unsupported arguments', () => {
    expect(() => parseRepeatArg(['--no-such-flag'])).toThrow(
      'Unsupported argument: --no-such-flag',
    );
  });
});

describe('runRepeatedEslintAudit', () => {
  it('uses max warning counts across repeated runs', async () => {
    const runner: EslintRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            {
              filePath: 'src/a.ts',
              messages: [
                {
                  ruleId: 'alpha',
                  severity: 1,
                  line: 1,
                  column: 1,
                  message: 'alpha warning',
                },
              ],
            },
          ]),
          stderr: '',
          exitCode: 0,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            {
              filePath: 'src/a.ts',
              messages: [
                {
                  ruleId: 'alpha',
                  severity: 1,
                  line: 1,
                  column: 1,
                  message: 'alpha warning',
                },
                {
                  ruleId: 'alpha',
                  severity: 1,
                  line: 2,
                  column: 1,
                  message: 'alpha warning',
                },
              ],
            },
            {
              filePath: 'src/b.ts',
              messages: [
                {
                  ruleId: 'beta',
                  severity: 1,
                  line: 1,
                  column: 1,
                  message: 'beta warning',
                },
              ],
            },
          ]),
          stderr: '',
          exitCode: 0,
        }),
    };

    const result = await runRepeatedEslintAudit(runner, 2);

    expect(result.totalWarnings).toBe(3);
    expect(result.perRuleCounts.get('alpha')).toBe(2);
    expect(result.perRuleCounts.get('beta')).toBe(1);
    expect(runner.run).toHaveBeenCalledTimes(2);
  });
});

describe('runEslintAudit', () => {
  it('succeeds when the runner exits 0', async () => {
    const run = vi.fn(async () => ({
      stdout: JSON.stringify([
        {
          filePath: 'src/a.ts',
          messages: [
            {
              ruleId: 'no-console',
              severity: 1,
              line: 1,
              column: 1,
              message: 'warn',
            },
          ],
        },
      ]),
      stderr: '',
      exitCode: 0,
    }));
    const runner: EslintRunner = { run };

    const result = await runEslintAudit(runner);

    expect(result.totalWarnings).toBe(1);
    expect(run).toHaveBeenCalledWith({
      paths: [...DEFAULT_ESLINT_PATHS],
      extraArgs: [...ESLINT_AUDIT_ARGS],
    });
  });

  it('succeeds when the runner exits non-zero but emits valid JSON', async () => {
    const runner: EslintRunner = {
      run: vi.fn(async () => ({
        stdout: JSON.stringify([
          {
            filePath: 'src/a.ts',
            messages: [
              {
                ruleId: '@typescript-eslint/no-explicit-any',
                severity: 1,
                line: 1,
                column: 1,
                message: 'warn',
              },
            ],
          },
        ]),
        stderr: 'lint failed because of errors',
        exitCode: 2,
      })),
    };

    const result = await runEslintAudit(runner);

    expect(result.totalWarnings).toBe(1);
  });

  it('throws when the runner exits non-zero and emits invalid JSON', async () => {
    const runner: EslintRunner = {
      run: vi.fn(async () => ({
        stdout: 'not json',
        stderr: 'some lint failure',
        exitCode: 2,
      })),
    };

    await expect(runEslintAudit(runner)).rejects.toThrow(
      'ESLint exited with code 2 and emitted invalid JSON output',
    );
  });

  it('throws when the runner returns a null exit code (SIGTERM path)', async () => {
    const runner: EslintRunner = {
      run: vi.fn(async () => ({
        stdout: '[]',
        stderr: 'terminated',
        exitCode: null as unknown as number,
      })),
    };

    await expect(runEslintAudit(runner)).rejects.toThrow(
      'invalid exit code: null',
    );
  });

  it('throws when the runner fails to spawn', async () => {
    const runner: EslintRunner = {
      run: vi.fn(async () => {
        throw new Error('spawn ENOENT');
      }),
    };

    await expect(runEslintAudit(runner)).rejects.toThrow(
      'Failed to run ESLint audit: spawn ENOENT',
    );
  });
});

describe('main — exit predicate wires in the parity check', () => {
  // The silent-swallow COUNT baselines (global + per-surface + per-file budget)
  // were retired in Stage 3 (docs/plans/260612_silent-swallow-gate/PLAN.md).
  // The surface-PARITY guard is orthogonal and still composed into main()'s exit
  // predicate — these cases prove a refactor can't silently drop it.
  const PASSING_GLOBAL = [{ ruleId: SILENT_SWALLOW_RULE_ID, baseline: 100 }];

  const makeRunner = (stdout: string): EslintRunner => ({
    run: vi.fn(async () => ({ stdout, stderr: '', exitCode: 0 })),
  });

  const makeLogger = () => ({ error: vi.fn(), log: vi.fn(), warn: vi.fn() });

  it('exits non-zero when the parity guard fails (an audited surface is unclassified)', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((): never => {
        throw new Error('__process_exit__');
      }) as never);
    const logger = makeLogger();
    await expect(
      main({
        args: [],
        runner: makeRunner(JSON.stringify([])),
        logger,
        baselines: PASSING_GLOBAL,
        surfaceParityAuditPaths: ['src/', 'packages/widget/src/'], // 'packages' unclassified → fails
      }),
    ).rejects.toThrow('__process_exit__');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('does not exit when every check passes', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((): never => {
        throw new Error('__process_exit__');
      }) as never);
    const logger = makeLogger();
    await main({
      args: [],
      runner: makeRunner(JSON.stringify([])),
      logger,
      baselines: PASSING_GLOBAL,
      surfaceParityAuditPaths: ['src/'],
    });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
