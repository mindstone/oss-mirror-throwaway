import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findUnresolvedModuleErrors,
  installDirForTsconfig,
  resolveRatchetConcurrency,
  runOne,
  runRatchet,
  type ProjectConfig,
} from '../check-typescript-errors';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

interface SpawnFixture {
  stdout: string[];
  stderr: string[];
  exitCode: number;
  delayMs?: number;
}

type MockChildProcess = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
};

const fixtureQueues = new Map<string, SpawnFixture[]>();
let inFlight = 0;
let maxInFlight = 0;

function project(name: string, baseline = 0): ProjectConfig {
  return { name, tsconfig: `${name}.json`, baseline };
}

function errorLines(count: number, code = 'TS2304'): string {
  return Array.from(
    { length: count },
    (_unused, index) =>
      `src/file${index}.ts:1:1 - error ${code}: message ${index}\n`,
  ).join('');
}

function queueFixture(tsconfig: string, fixture: SpawnFixture): void {
  const queue = fixtureQueues.get(tsconfig) ?? [];
  queue.push(fixture);
  fixtureQueues.set(tsconfig, queue);
}

function takeFixture(tsconfig: string): SpawnFixture {
  const queue = fixtureQueues.get(tsconfig);
  const fixture = queue?.shift();
  if (!fixture) {
    throw new Error(`No spawn fixture queued for ${tsconfig}`);
  }
  return fixture;
}

function installSpawnMock(): void {
  vi.mocked(spawn).mockImplementation((_command, args) => {
    const spawnArgs = Array.isArray(args) ? args.map(String) : [];
    const tsconfig = spawnArgs[2] ?? 'unknown';
    const fixture = takeFixture(tsconfig);
    const child: MockChildProcess = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);

    setTimeout(() => {
      for (const chunk of fixture.stdout) {
        child.stdout.emit('data', chunk);
      }
      for (const chunk of fixture.stderr) {
        child.stderr.emit('data', chunk);
      }
      child.stdout.end();
      child.stderr.end();
      inFlight -= 1;
      child.emit('close', fixture.exitCode, null);
    }, fixture.delayMs ?? 0);

    return child as unknown as ReturnType<typeof spawn>;
  });
}

beforeEach(() => {
  fixtureQueues.clear();
  inFlight = 0;
  maxInFlight = 0;
  vi.mocked(spawn).mockReset();
  installSpawnMock();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('check-typescript-errors ratchet', () => {
  it('handles the zero-error happy path', async () => {
    const target = project('zero');
    queueFixture(target.tsconfig, { stdout: [''], stderr: [''], exitCode: 0 });

    const result = await runOne(target);

    expect(result.errorCount).toBe(0);
  });

  it('counts N TypeScript errors from tsc output', async () => {
    const target = project('counting');
    queueFixture(target.tsconfig, {
      stdout: [errorLines(3)],
      stderr: [''],
      exitCode: 2,
    });

    const result = await runOne(target);

    expect(result.errorCount).toBe(3);
  });

  it('passes when the current count exactly matches the baseline', async () => {
    const target = project('exact', 2);
    queueFixture(target.tsconfig, {
      stdout: [errorLines(2)],
      stderr: [''],
      exitCode: 2,
    });

    const result = await runRatchet([target], {
      concurrency: 1,
      report: false,
    });

    expect(result.failed).toBe(false);
    expect(result.summaries[0]?.maxErrorCount).toBe(2);
  });

  it('fails when the current count exceeds the baseline', async () => {
    const target = project('exceeded', 1);
    queueFixture(target.tsconfig, {
      stdout: [errorLines(2)],
      stderr: [''],
      exitCode: 2,
    });

    const result = await runRatchet([target], {
      concurrency: 1,
      report: false,
    });

    expect(result.failed).toBe(true);
    expect(result.summaries[0]?.maxErrorCount).toBe(2);
  });

  it('passes and warns when the current count undershoots the baseline', async () => {
    const target = project('undershot', 3);
    const logger = {
      error: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    };
    queueFixture(target.tsconfig, {
      stdout: [errorLines(1)],
      stderr: [''],
      exitCode: 2,
    });

    const result = await runRatchet([target], {
      concurrency: 1,
      report: true,
      logger,
    });

    expect(result.failed).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      '⚠ Undershot: 1 errors is below baseline 3; lower the baseline.',
    );
  });

  it('counts TypeScript errors even if the child exits zero', async () => {
    const target = project('exit-zero-with-errors');
    queueFixture(target.tsconfig, {
      stdout: [errorLines(2)],
      stderr: [''],
      exitCode: 0,
    });

    const result = await runRatchet([target], {
      concurrency: 1,
      report: false,
    });

    expect(result.failed).toBe(true);
    expect(result.summaries[0]?.maxErrorCount).toBe(2);
  });

  it('fails closed when tsc exits non-zero with no parsed TypeScript errors', async () => {
    const target = project('broken-capture');
    queueFixture(target.tsconfig, {
      stdout: [''],
      stderr: ['tsc crashed before diagnostics'],
      exitCode: 2,
    });

    await expect(runOne(target)).rejects.toThrow(
      'tsc exited with code 2 but no error TS lines parsed; output capture likely broken: tsc crashed before diagnostics',
    );
  });

  it('counts diagnostics emitted only on stderr', async () => {
    const target = project('stderr-only');
    queueFixture(target.tsconfig, {
      stdout: [''],
      stderr: [errorLines(4)],
      exitCode: 2,
    });

    const result = await runOne(target);

    expect(result.errorCount).toBe(4);
  });

  it('counts diagnostics emitted only on stdout', async () => {
    const target = project('stdout-only');
    queueFixture(target.tsconfig, {
      stdout: [errorLines(4)],
      stderr: [''],
      exitCode: 2,
    });

    const result = await runOne(target);

    expect(result.errorCount).toBe(4);
  });

  it('counts interleaved diagnostics from stdout and stderr', async () => {
    const target = project('interleaved');
    queueFixture(target.tsconfig, {
      stdout: [errorLines(2)],
      stderr: [errorLines(3)],
      exitCode: 2,
    });

    const result = await runOne(target);

    expect(result.errorCount).toBe(5);
  });

  it('counts a diagnostic token split across stdout chunks after buffers are joined', async () => {
    const target = project('chunk-boundary');
    const firstFour = errorLines(4);
    queueFixture(target.tsconfig, {
      stdout: [
        firstFour,
        'src/file4.ts:1:1 - 5 erro',
        'r TS2304: split message\n',
      ],
      stderr: [''],
      exitCode: 2,
    });

    const result = await runOne(target);

    expect(result.errorCount).toBe(5);
  });

  it('keeps scheduling queued projects when one project rejects', async () => {
    const broken = project('broken');
    const healthyOne = project('healthy-one');
    const healthyTwo = project('healthy-two');
    queueFixture(broken.tsconfig, {
      stdout: [''],
      stderr: ['compiler panic'],
      exitCode: 2,
    });
    queueFixture(healthyOne.tsconfig, {
      stdout: [''],
      stderr: [''],
      exitCode: 0,
    });
    queueFixture(healthyTwo.tsconfig, {
      stdout: [''],
      stderr: [''],
      exitCode: 0,
    });

    const result = await runRatchet([broken, healthyOne, healthyTwo], {
      concurrency: 1,
      report: false,
    });

    expect(result.failed).toBe(true);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(3);
    expect(result.summaries.map((summary) => summary.project.name)).toEqual([
      'broken',
      'healthy-one',
      'healthy-two',
    ]);
    expect(result.summaries[0]?.rejectionReasons).toHaveLength(1);
    expect(result.summaries[1]?.maxErrorCount).toBe(0);
    expect(result.summaries[2]?.maxErrorCount).toBe(0);
  });

  it('limits concurrent tsc invocations to RATCHET_CONCURRENCY', async () => {
    vi.useFakeTimers();
    const projects = Array.from({ length: 8 }, (_unused, index) =>
      project(`limited-${index}`),
    );
    for (const target of projects) {
      queueFixture(target.tsconfig, {
        stdout: [''],
        stderr: [''],
        exitCode: 0,
        delayMs: 50,
      });
    }

    const concurrency = resolveRatchetConcurrency('2', 4);
    const runPromise = runRatchet(projects, { concurrency, report: false });

    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(50);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(50);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(8);
    await vi.advanceTimersByTimeAsync(50);

    const result = await runPromise;
    expect(result.failed).toBe(false);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('falls back with a warning for invalid RATCHET_CONCURRENCY values', () => {
    for (const raw of ['0', '-1', 'NaN', '9999', 'abc']) {
      const warn = vi.fn();

      const resolved = resolveRatchetConcurrency(raw, 4, warn);

      expect(resolved).toBe(4);
      expect(warn).toHaveBeenCalledWith(
        `[ratchet] WARN: ignoring invalid RATCHET_CONCURRENCY=${raw}; falling back to 4`,
      );
    }
  });
});

describe('findUnresolvedModuleErrors (stale-deps / unresolved-module guard)', () => {
  const ts2307 = (spec: string) =>
    `src/x.ts:1:1 - error TS2307: Cannot find module '${spec}' or its corresponding type declarations.\n`;

  it('flags a bare package specifier (the stale/missing-deps signature)', () => {
    expect(findUnresolvedModuleErrors(ts2307('@rudderstack/rudder-sdk-react-native'), '')).toEqual({
      count: 1,
      specifiers: ['@rudderstack/rudder-sdk-react-native'],
    });
  });

  it('also flags relative/path-alias TS2307 (broken imports mask diagnostics too — GPT F1/F3)', () => {
    expect(findUnresolvedModuleErrors(ts2307('./typo'), '').count).toBe(1);
    expect(findUnresolvedModuleErrors(ts2307('@shared/missing'), '').count).toBe(1);
    expect(findUnresolvedModuleErrors(ts2307('/abs/path'), '').specifiers).toEqual(['/abs/path']);
  });

  it('ignores non-TS2307 errors (TS2322 type mismatch, TS7016 untyped dep is baseline-able)', () => {
    expect(
      findUnresolvedModuleErrors(
        "src/x.ts:1:1 - error TS2322: Type 'string' is not assignable to type 'number'.\n" +
          "src/y.ts:2:1 - error TS7016: Could not find a declaration file for module 'foo'.\n",
        '',
      ),
    ).toEqual({ count: 0, specifiers: [] });
  });

  it('counts by diagnostic code and reads stderr; dedupes specifiers for the hint', () => {
    const result = findUnresolvedModuleErrors(ts2307('pkg-a') + ts2307('pkg-a'), ts2307('pkg-b'));
    expect(result.count).toBe(3); // detection is by code, not de-duped
    expect(result.specifiers).toEqual(['pkg-a', 'pkg-b']); // hint specifiers are de-duped
  });

  it('returns zero for clean output', () => {
    expect(findUnresolvedModuleErrors('', '')).toEqual({ count: 0, specifiers: [] });
  });
});

describe('runOne stale-deps guard', () => {
  it('rejects with remediation when tsc reports an unresolved package, not a silent count', async () => {
    const target = project('mobile-like');
    queueFixture(target.tsconfig, {
      stdout: [
        "mobile/src/analytics/analytics.ts:33:26 - error TS2307: Cannot find module '@rudderstack/rudder-sdk-react-native' or its corresponding type declarations.\n",
      ],
      stderr: [''],
      exitCode: 2,
    });

    const error = await runOne(target).then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/unresolved-module error/i);
    expect(error?.message).toMatch(/npm ci --prefix/i);
  });
});

describe('installDirForTsconfig', () => {
  it('maps a nested tsconfig to its directory and a root tsconfig to "."', () => {
    expect(installDirForTsconfig('mobile/tsconfig.json')).toBe('mobile');
    expect(installDirForTsconfig('packages/browser-extension/tsconfig.json')).toBe(
      'packages/browser-extension',
    );
    expect(installDirForTsconfig('tsconfig.scripts.json')).toBe('.');
  });
});
