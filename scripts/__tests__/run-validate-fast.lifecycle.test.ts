import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetValidateFastLifecycleForTests,
  onValidateFastSignal,
  runValidateFast,
  writeTimingArtifact,
  type Step,
  type StepResult,
  type TimingArtifactWriter,
  type ValidateFastTimingArtifact,
} from '../run-validate-fast';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDirs: string[] = [];

function makeTempArtifactPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-validate-fast-lifecycle-'));
  tempDirs.push(dir);
  return path.join(dir, 'validate-fast-timings.json');
}

function step(name: string): Step {
  return { name, command: `fake ${name}`, rerun: `fake ${name}` };
}

function makeRecordingWriter(): {
  readonly writes: ValidateFastTimingArtifact[];
  readonly writer: TimingArtifactWriter;
} {
  const writes: ValidateFastTimingArtifact[] = [];
  return {
    writes,
    writer: (artifact, artifactPath) => {
      writes.push(JSON.parse(JSON.stringify(artifact)) as ValidateFastTimingArtifact);
      writeTimingArtifact(artifact, artifactPath);
    },
  };
}

function readArtifact(artifactPath: string): ValidateFastTimingArtifact {
  return JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as ValidateFastTimingArtifact;
}

function expectArtifactEnvelope(artifact: ValidateFastTimingArtifact): void {
  expect(artifact.run_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(Date.parse(artifact.started_at)).not.toBeNaN();
  expect(Date.parse(artifact.ended_at)).not.toBeNaN();
  expect(artifact.surface === 'local' || artifact.surface === 'ci').toBe(true);
  expect(typeof artifact.git_sha).toBe('string');
  expect(typeof artifact.branch).toBe('string');
  expect(Array.isArray(artifact.steps)).toBe(true);
}

function expectStepSummary(
  artifact: ValidateFastTimingArtifact,
  expected: Array<{ name: string; exitCode: number }>,
): void {
  expect(
    artifact.steps.map(({ name, exit_code }) => ({
      name,
      exitCode: exit_code,
    })),
  ).toEqual(expected);
  for (const timing of artifact.steps) {
    expect(Number.isInteger(timing.duration_ms)).toBe(true);
    expect(timing.duration_ms).toBeGreaterThanOrEqual(0);
  }
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  __resetValidateFastLifecycleForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  __resetValidateFastLifecycleForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('runValidateFast lifecycle timing artifact', () => {
  it('writes the artifact exactly once for ordinary step failure', async () => {
    const artifactPath = makeTempArtifactPath();
    const { writes, writer } = makeRecordingWriter();
    const steps = [step('passes-first'), step('fails-second'), step('skipped-third')];

    const code = await runValidateFast([], {
      steps,
      artifactPath,
      installSignalHandlers: false,
      writeTimingArtifact: writer,
      runStep: async (currentStep) => ({
        exitCode: currentStep.name === 'fails-second' ? 7 : 0,
        signal: null,
      }),
    });

    expect(code).toBe(7);
    expect(writes).toHaveLength(1);
    expect(fs.existsSync(artifactPath)).toBe(true);
    const artifact = readArtifact(artifactPath);
    expectArtifactEnvelope(artifact);
    expectStepSummary(artifact, [
      { name: 'passes-first', exitCode: 0 },
      { name: 'fails-second', exitCode: 7 },
    ]);
  });

  it('writes the artifact exactly once when a step runner unexpectedly rejects', async () => {
    const artifactPath = makeTempArtifactPath();
    const { writes, writer } = makeRecordingWriter();
    const steps = [step('spawn-error')];

    const code = await runValidateFast([], {
      steps,
      artifactPath,
      installSignalHandlers: false,
      writeTimingArtifact: writer,
      runStep: async () => {
        throw new Error('simulated child error event');
      },
    });

    expect(code).toBe(1);
    expect(writes).toHaveLength(1);
    const artifact = readArtifact(artifactPath);
    expectArtifactEnvelope(artifact);
    expectStepSummary(artifact, [{ name: 'spawn-error', exitCode: 1 }]);
  });

  it('writes the artifact exactly once and exits 130 on SIGINT', async () => {
    await expectSignalLifecycle('SIGINT', 130);
  });

  it('writes the artifact exactly once and exits 143 on SIGTERM', async () => {
    await expectSignalLifecycle('SIGTERM', 143);
  });

  it('writes the artifact exactly once for success with all steps recorded', async () => {
    const artifactPath = makeTempArtifactPath();
    const { writes, writer } = makeRecordingWriter();
    const steps = [step('first'), step('second')];

    const code = await runValidateFast([], {
      steps,
      artifactPath,
      installSignalHandlers: false,
      writeTimingArtifact: writer,
      runStep: async () => ({ exitCode: 0, signal: null }),
    });

    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    const artifact = readArtifact(artifactPath);
    expectArtifactEnvelope(artifact);
    expectStepSummary(artifact, [
      { name: 'first', exitCode: 0 },
      { name: 'second', exitCode: 0 },
    ]);
  });

  it('honors VALIDATE_FAST_TIMINGS_PATH for test and harness isolation', async () => {
    const artifactPath = makeTempArtifactPath();
    vi.stubEnv('VALIDATE_FAST_TIMINGS_PATH', artifactPath);

    const code = await runValidateFast([], {
      steps: [step('env-path-step')],
      installSignalHandlers: false,
      runStep: async () => ({ exitCode: 0, signal: null }),
    });

    expect(code).toBe(0);
    const artifact = readArtifact(artifactPath);
    expectArtifactEnvelope(artifact);
    expectStepSummary(artifact, [{ name: 'env-path-step', exitCode: 0 }]);
  });

  it('records the resolved command per step in the timing artifact (additive field)', async () => {
    const artifactPath = makeTempArtifactPath();
    const steps: Step[] = [
      { name: 'transformed-step', command: 'npx tsx scripts/fake-transformed.ts --flag' },
      { name: 'verbatim-step', command: 'fake verbatim-step' },
    ];

    const code = await runValidateFast([], {
      steps,
      artifactPath,
      installSignalHandlers: false,
      runStep: async () => ({ exitCode: 0, signal: null }),
    });

    expect(code).toBe(0);
    const artifact = readArtifact(artifactPath);
    expect(artifact.steps.map((s) => s.resolved_command)).toEqual([
      'node --import tsx scripts/fake-transformed.ts --flag',
      'fake verbatim-step',
    ]);
  });

  it('failure banner shows the actual executed command for transformed steps only', async () => {
    const stderrSpy = process.stderr.write as ReturnType<typeof vi.fn>;

    const transformedCode = await runValidateFast([], {
      steps: [{ name: 'transformed-step', command: 'npx tsx scripts/fake-transformed.ts --flag' }],
      artifactPath: makeTempArtifactPath(),
      installSignalHandlers: false,
      runStep: async () => ({ exitCode: 3, signal: null }),
    });
    expect(transformedCode).toBe(3);
    const transformedStderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(transformedStderr).toContain('ran:     node --import tsx scripts/fake-transformed.ts --flag');
    expect(transformedStderr).toContain('rerun:   npm run transformed-step');

    stderrSpy.mockClear();
    const verbatimCode = await runValidateFast([], {
      steps: [{ name: 'verbatim-step', command: 'fake verbatim-step' }],
      artifactPath: makeTempArtifactPath(),
      installSignalHandlers: false,
      runStep: async () => ({ exitCode: 2, signal: null }),
    });
    expect(verbatimCode).toBe(2);
    const verbatimStderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(verbatimStderr).not.toContain('ran:');
  });

  it('--list and --help do not create a timing artifact for the real CLI path', () => {
    const artifactPath = makeTempArtifactPath();

    const listResult = spawnSync('npx', ['tsx', 'scripts/run-validate-fast.ts', '--list'], {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      env: { ...process.env, VALIDATE_FAST_TIMINGS_PATH: artifactPath },
    });
    const helpResult = spawnSync('npx', ['tsx', 'scripts/run-validate-fast.ts', '--help'], {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      env: { ...process.env, VALIDATE_FAST_TIMINGS_PATH: artifactPath },
    });

    expect(listResult.status).toBe(0);
    expect(listResult.stdout).toContain('check-husky-hooks-path');
    expect(helpResult.status).toBe(0);
    expect(helpResult.stdout).toContain('Usage: tsx scripts/run-validate-fast.ts [--list]');
    expect(fs.existsSync(artifactPath)).toBe(false);
  });
});

async function expectSignalLifecycle(
  signal: 'SIGINT' | 'SIGTERM',
  expectedExitCode: 130 | 143,
): Promise<void> {
  const artifactPath = makeTempArtifactPath();
  const { writes, writer } = makeRecordingWriter();
  const steps = [step('completed-before-signal'), step('interrupted-step')];
  let resolveInterruptedStep: ((result: StepResult) => void) | undefined;
  let markInterruptedStepStarted: (() => void) | undefined;
  const interruptedStepStarted = new Promise<void>((resolve) => {
    markInterruptedStepStarted = resolve;
  });

  const runPromise = runValidateFast([], {
    steps,
    artifactPath,
    installSignalHandlers: false,
    writeTimingArtifact: writer,
    runStep: async (currentStep) => {
      if (currentStep.name === 'completed-before-signal') {
        return { exitCode: 0, signal: null };
      }
      markInterruptedStepStarted?.();
      return new Promise<StepResult>((resolve) => {
        resolveInterruptedStep = resolve;
      });
    },
  });

  await interruptedStepStarted;
  let observedExitCode: 130 | 143 | undefined;
  class ExpectedExit extends Error {}

  expect(() =>
    onValidateFastSignal(signal, (code: 130 | 143): never => {
      observedExitCode = code;
      throw new ExpectedExit(String(code));
    }),
  ).toThrow(ExpectedExit);

  expect(observedExitCode).toBe(expectedExitCode);
  expect(writes).toHaveLength(1);
  let artifact = readArtifact(artifactPath);
  expectArtifactEnvelope(artifact);
  expectStepSummary(artifact, [{ name: 'completed-before-signal', exitCode: 0 }]);

  resolveInterruptedStep?.({ exitCode: expectedExitCode, signal });
  await expect(runPromise).resolves.toBe(expectedExitCode);
  expect(writes).toHaveLength(1);
  artifact = readArtifact(artifactPath);
  expectStepSummary(artifact, [{ name: 'completed-before-signal', exitCode: 0 }]);
}
