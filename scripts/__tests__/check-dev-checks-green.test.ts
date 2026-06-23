import { describe, it, expect } from 'vitest';
import {
  evaluateDevChecks,
  EXIT_CODE_BY_KIND,
  type GhRunner,
  type RunListEntry,
  type JobEntry,
} from '../check-dev-checks-green';

const SHA = 'abc1234567def8901234567890abcdef12345678';
const OTHER_SHA = '0000000000111111111122222222223333333333';

function run(partial: Partial<RunListEntry>): RunListEntry {
  return {
    databaseId: 100,
    headSha: SHA,
    status: 'completed',
    conclusion: 'success',
    createdAt: '2026-06-14T10:00:00Z',
    ...partial,
  };
}

function job(name: string, conclusion: string | null, status = 'completed'): JobEntry {
  return { name, status, conclusion };
}

/** Build a stub gh surface from a fixed run list + a per-run jobs map. */
function stubRunner(runs: RunListEntry[], jobsByRun: Record<number, JobEntry[]>, opts?: { listThrows?: Error; viewThrows?: Error }): GhRunner {
  return {
    runList() {
      if (opts?.listThrows) throw opts.listThrows;
      return runs;
    },
    runViewJobs(runId: number) {
      if (opts?.viewThrows) throw opts.viewThrows;
      return jobsByRun[runId] ?? [];
    },
  };
}

const GREEN_JOBS = [
  job('validate-and-test / validate', 'success'),
  job('validate-and-test / test (1)', 'success'),
  job('validate-and-test / test (2)', 'success'),
  job('validate-and-test / test-evals', 'success'),
  job('validate-and-test / test-gate', 'success'),
  // Intentionally skipped on dev/beta pushes (only runs on main) — must NOT count as red.
  job('validate-and-test / Validate Release Changelog', 'skipped'),
  job('knip-health', 'failure'), // non-gating extra — must be IGNORED
  job('oss-build-smoke', 'failure'), // non-gating extra — must be IGNORED
];

describe('evaluateDevChecks', () => {
  it('GREEN: gating jobs all success on exact SHA (ignores non-gating reds; skipped is acceptable)', () => {
    const v = evaluateDevChecks(SHA, stubRunner([run({ databaseId: 100 })], { 100: GREEN_JOBS }));
    expect(v.kind).toBe('green');
    expect(EXIT_CODE_BY_KIND[v.kind]).toBe(0);
  });

  it('GREEN: a skipped or neutral gating job does not block (regression guard for the live false-red)', () => {
    const jobs = [
      job('validate-and-test / validate', 'success'),
      job('validate-and-test / Validate Release Changelog', 'skipped'),
      job('validate-and-test / some-neutral-job', 'neutral'),
    ];
    const v = evaluateDevChecks(SHA, stubRunner([run({ databaseId: 100 })], { 100: jobs }));
    expect(v.kind).toBe('green');
  });

  it('RED: a gating job with null conclusion on a completed run blocks (never silent-pass)', () => {
    const jobs = [job('validate-and-test / validate', 'success'), job('validate-and-test / test (1)', null)];
    const v = evaluateDevChecks(SHA, stubRunner([run({ databaseId: 100 })], { 100: jobs }));
    expect(v.kind).toBe('red');
  });

  it('RED: a gating job failed', () => {
    const jobs = [job('validate-and-test / validate', 'success'), job('validate-and-test / test (2)', 'failure')];
    const v = evaluateDevChecks(SHA, stubRunner([run({ databaseId: 100 })], { 100: jobs }));
    expect(v.kind).toBe('red');
    if (v.kind === 'red') expect(v.failedJobs).toEqual(['validate-and-test / test (2) (failure)']);
    expect(EXIT_CODE_BY_KIND[v.kind]).not.toBe(0);
  });

  it('RED: cancelled gating job counts as not-success', () => {
    const jobs = [job('validate-and-test / validate', 'cancelled')];
    const v = evaluateDevChecks(SHA, stubRunner([run({ databaseId: 100 })], { 100: jobs }));
    expect(v.kind).toBe('red');
  });

  it('IN_PROGRESS: run for the SHA has not completed → block with wait hint', () => {
    const v = evaluateDevChecks(SHA, stubRunner([run({ databaseId: 100, status: 'in_progress', conclusion: null })], {}));
    expect(v.kind).toBe('in_progress');
    expect(EXIT_CODE_BY_KIND[v.kind]).not.toBe(0);
  });

  it('NO_SIGNAL: no run matches the target SHA (covers the stale-latest-run case)', () => {
    const v = evaluateDevChecks(SHA, stubRunner([run({ databaseId: 100, headSha: OTHER_SHA })], {}));
    expect(v.kind).toBe('no_signal');
    expect(EXIT_CODE_BY_KIND[v.kind]).not.toBe(0);
  });

  it('NO_SIGNAL: empty run list', () => {
    const v = evaluateDevChecks(SHA, stubRunner([], {}));
    expect(v.kind).toBe('no_signal');
  });

  it('GH_ERROR: runList throws → fail loud, never default-green', () => {
    const v = evaluateDevChecks(SHA, stubRunner([], {}, { listThrows: new Error('gh not authed') }));
    expect(v.kind).toBe('gh_error');
    expect(EXIT_CODE_BY_KIND[v.kind]).not.toBe(0);
  });

  it('GH_ERROR: runViewJobs throws → fail loud', () => {
    const v = evaluateDevChecks(SHA, stubRunner([run({ databaseId: 100 })], {}, { viewThrows: new Error('network') }));
    expect(v.kind).toBe('gh_error');
  });

  it('GH_ERROR: no gating jobs present (workflow shape changed) → never silent pass', () => {
    const jobs = [job('knip-health', 'success'), job('oss-build-smoke', 'success')];
    const v = evaluateDevChecks(SHA, stubRunner([run({ databaseId: 100 })], { 100: jobs }));
    expect(v.kind).toBe('gh_error');
  });

  it('picks the most recent run for a SHA when multiple exist (re-run / amended push)', () => {
    const older = run({ databaseId: 100, createdAt: '2026-06-14T09:00:00Z' });
    const newerRed = run({ databaseId: 101, createdAt: '2026-06-14T11:00:00Z' });
    const jobs = {
      100: GREEN_JOBS,
      101: [job('validate-and-test / validate', 'failure')],
    };
    const v = evaluateDevChecks(SHA, stubRunner([older, newerRed], jobs));
    // The newer (red) run must win, even though an older green run exists for the same SHA.
    expect(v.kind).toBe('red');
    if (v.kind === 'red') expect(v.runId).toBe(101);
  });

  it('tie-break on databaseId when createdAt is identical', () => {
    const a = run({ databaseId: 100, createdAt: '2026-06-14T10:00:00Z' });
    const b = run({ databaseId: 102, createdAt: '2026-06-14T10:00:00Z' });
    const jobs = { 100: [job('validate-and-test / validate', 'failure')], 102: GREEN_JOBS };
    const v = evaluateDevChecks(SHA, stubRunner([a, b], jobs));
    expect(v.kind).toBe('green'); // higher databaseId (102) wins the tie
  });
});
