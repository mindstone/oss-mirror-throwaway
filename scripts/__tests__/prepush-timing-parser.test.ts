import { describe, it, expect } from 'vitest';

import { parsePrepushTimingMarkers, extractValidateFastFailure } from '../lib/prepush-timing-parser';

const ANCHOR_PERF_MS = 0;
const ANCHOR_WALL_SEC = 1000;
const PUSH_END_PERF_MS = 60_000;

function marker(phase: string, event: string, sec: number): string {
  return `PREPUSH_TIMING\tv=1\tphase=${phase}\tevent=${event}\tsec=${sec}`;
}

const RULE = '═'.repeat(63);
/** A representative run-validate-fast failure banner (matches scripts/run-validate-fast.ts). */
function failBanner(step: string, rerun?: string, ran?: string): string[] {
  return [
    '',
    RULE,
    '  validate:fast FAILED',
    `  step:    ${step}`,
    '  exit 1',
    '  elapsed: 0.5s (step) / 111.8s (total)',
    ...(rerun !== undefined ? [`  rerun:   ${rerun}`] : []),
    ...(ran !== undefined ? [`  ran:     ${ran}`] : []),
    RULE,
    '',
  ];
}

describe('parsePrepushTimingMarkers', () => {
  it('pairs matching start/end markers and converts epoch seconds to perf ms', () => {
    const stderr = [
      'Counting objects: 100, done.',
      marker('merge-integrity', 'start', 1000),
      marker('merge-integrity', 'end', 1003),
      marker('validate-fast', 'start', 1004),
      marker('validate-fast', 'end', 1024),
      'Writing objects: 100, done.',
    ].join('\n');

    const result = parsePrepushTimingMarkers(
      stderr,
      ANCHOR_PERF_MS,
      ANCHOR_WALL_SEC,
      PUSH_END_PERF_MS,
    );

    expect(result.childSpans).toEqual([
      { name: 'push:merge-integrity', startMs: 0, endMs: 3000, status: 'ok' },
      { name: 'push:validate-fast', startMs: 4000, endMs: 24000, status: 'ok' },
    ]);
    expect(result.notes).toEqual([]);
  });

  it('strips marker lines from replayed stderr (protocol noise stays hidden)', () => {
    const stderr = [
      'Counting objects: 100, done.',
      marker('validate-fast', 'start', 1000),
      marker('validate-fast', 'end', 1001),
      'Writing objects: 100, done.',
    ].join('\n');

    const result = parsePrepushTimingMarkers(
      stderr,
      ANCHOR_PERF_MS,
      ANCHOR_WALL_SEC,
      PUSH_END_PERF_MS,
    );

    expect(result.cleanedStderr).toBe(
      ['Counting objects: 100, done.', 'Writing objects: 100, done.'].join('\n'),
    );
    expect(result.cleanedStderr.includes('PREPUSH_TIMING')).toBe(false);
  });

  it('records unpaired start as an err span clamped to push-end (simulates hook failure mid-phase)', () => {
    // The hook exits mid-phase because a command under `sh -e` failed; we
    // never get the matching `end` marker. We still want visibility into the
    // wall time spent inside that phase.
    const stderr = [
      marker('merge-integrity', 'start', 1000),
      marker('merge-integrity', 'end', 1002),
      marker('validate-fast', 'start', 1003),
      // no end marker — simulates validate-fast failing
    ].join('\n');

    const result = parsePrepushTimingMarkers(
      stderr,
      ANCHOR_PERF_MS,
      ANCHOR_WALL_SEC,
      PUSH_END_PERF_MS,
    );

    expect(result.childSpans).toEqual([
      { name: 'push:merge-integrity', startMs: 0, endMs: 2000, status: 'ok' },
      {
        name: 'push:validate-fast',
        startMs: 3000,
        endMs: PUSH_END_PERF_MS,
        status: 'err',
        note: 'incomplete — hook exited before end marker',
      },
    ]);
  });

  it('rejects markers with unknown schema version', () => {
    const stderr = [
      'PREPUSH_TIMING\tv=2\tphase=validate-fast\tevent=start\tsec=1000',
      'PREPUSH_TIMING\tv=2\tphase=validate-fast\tevent=end\tsec=1001',
    ].join('\n');

    const result = parsePrepushTimingMarkers(
      stderr,
      ANCHOR_PERF_MS,
      ANCHOR_WALL_SEC,
      PUSH_END_PERF_MS,
    );

    expect(result.childSpans).toEqual([]);
    expect(result.notes).toHaveLength(2);
    expect(result.notes[0]).toMatch(/unknown version '2'/);
  });

  it('rejects markers with unknown phase name (defends against accidental matches)', () => {
    const stderr = marker('bogus-phase', 'start', 1000);

    const result = parsePrepushTimingMarkers(
      stderr,
      ANCHOR_PERF_MS,
      ANCHOR_WALL_SEC,
      PUSH_END_PERF_MS,
    );

    expect(result.childSpans).toEqual([]);
    expect(result.notes).toEqual([
      "pre-push marker: unknown phase 'bogus-phase' — ignored",
    ]);
  });

  it('rejects markers with unknown event name', () => {
    const stderr = marker('validate-fast', 'somewhere', 1000);

    const result = parsePrepushTimingMarkers(
      stderr,
      ANCHOR_PERF_MS,
      ANCHOR_WALL_SEC,
      PUSH_END_PERF_MS,
    );

    expect(result.childSpans).toEqual([]);
    expect(result.notes).toEqual([
      "pre-push marker: unknown event 'somewhere' — ignored",
    ]);
  });

  it('rejects markers missing required fields', () => {
    const stderr = 'PREPUSH_TIMING\tmalformed-no-fields';

    const result = parsePrepushTimingMarkers(
      stderr,
      ANCHOR_PERF_MS,
      ANCHOR_WALL_SEC,
      PUSH_END_PERF_MS,
    );

    expect(result.childSpans).toEqual([]);
    expect(result.notes[0]).toMatch(/unknown version/);
  });

  it('ignores end-without-start and continues parsing', () => {
    const stderr = [
      marker('validate-fast', 'end', 1005),
      marker('vitest-related', 'start', 1006),
      marker('vitest-related', 'end', 1010),
    ].join('\n');

    const result = parsePrepushTimingMarkers(
      stderr,
      ANCHOR_PERF_MS,
      ANCHOR_WALL_SEC,
      PUSH_END_PERF_MS,
    );

    expect(result.childSpans).toEqual([
      { name: 'push:vitest-related', startMs: 6000, endMs: 10000, status: 'ok' },
    ]);
    expect(result.notes).toEqual([
      "pre-push marker: end without start for 'validate-fast' — ignored",
    ]);
  });

  it('keeps first start when a duplicate is seen (rare but possible)', () => {
    const stderr = [
      marker('validate-fast', 'start', 1000),
      marker('validate-fast', 'start', 1005),
      marker('validate-fast', 'end', 1010),
    ].join('\n');

    const result = parsePrepushTimingMarkers(
      stderr,
      ANCHOR_PERF_MS,
      ANCHOR_WALL_SEC,
      PUSH_END_PERF_MS,
    );

    expect(result.childSpans).toEqual([
      { name: 'push:validate-fast', startMs: 0, endMs: 10000, status: 'ok' },
    ]);
    expect(result.notes).toEqual([
      "pre-push marker: duplicate start for 'validate-fast' — keeping first",
    ]);
  });

  it('returns empty result for stderr with no markers', () => {
    const stderr = [
      'Enumerating objects: 100, done.',
      'Total 100 (delta 50), reused 0 (delta 0).',
      'To github.com:example/repo.git',
      '   abc1234..def5678  dev -> dev',
    ].join('\n');

    const result = parsePrepushTimingMarkers(
      stderr,
      ANCHOR_PERF_MS,
      ANCHOR_WALL_SEC,
      PUSH_END_PERF_MS,
    );

    expect(result.childSpans).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.cleanedStderr).toBe(stderr);
  });

  it('lines that merely contain the prefix mid-string are NOT consumed (start-of-line anchor)', () => {
    const stderr = 'Some log line that mentions PREPUSH_TIMING\tv=1\tphase=validate-fast';

    const result = parsePrepushTimingMarkers(
      stderr,
      ANCHOR_PERF_MS,
      ANCHOR_WALL_SEC,
      PUSH_END_PERF_MS,
    );

    expect(result.childSpans).toEqual([]);
    expect(result.cleanedStderr).toBe(stderr); // preserved verbatim
  });

  it('unpaired validate-fast start + failure banner → note names the failing step + rerun', () => {
    const stderr = [
      marker('validate-fast', 'start', 1003),
      // no end marker — validate:fast failed mid-run
      ...failBanner('validate:git-exec-maxbuffer', 'npm run validate:git-exec-maxbuffer', 'node --import tsx scripts/check-git-exec-maxbuffer.ts'),
    ].join('\n');

    const result = parsePrepushTimingMarkers(stderr, ANCHOR_PERF_MS, ANCHOR_WALL_SEC, PUSH_END_PERF_MS);

    const span = result.childSpans.find((s) => s.name === 'push:validate-fast');
    expect(span?.status).toBe('err');
    expect(span?.note).toBe('failed at step: validate:git-exec-maxbuffer — rerun: npm run validate:git-exec-maxbuffer');
    // The banner stays in replayed stderr — only PREPUSH_TIMING markers are stripped.
    expect(result.cleanedStderr).toContain('validate:fast FAILED');
    expect(result.cleanedStderr).toContain('validate:git-exec-maxbuffer');
  });

  it('unpaired validate-fast start + banner with step but NO rerun → note degrades to step only', () => {
    const stderr = [
      marker('validate-fast', 'start', 1003),
      ...failBanner('check-typecheck-coverage'), // no rerun line
    ].join('\n');

    const result = parsePrepushTimingMarkers(stderr, ANCHOR_PERF_MS, ANCHOR_WALL_SEC, PUSH_END_PERF_MS);

    const span = result.childSpans.find((s) => s.name === 'push:validate-fast');
    expect(span?.note).toBe('failed at step: check-typecheck-coverage');
  });

  it('unpaired validate-fast start + NO banner → generic incomplete note preserved (true kill/timeout)', () => {
    const stderr = [marker('validate-fast', 'start', 1003), 'remote: some unrelated output'].join('\n');

    const result = parsePrepushTimingMarkers(stderr, ANCHOR_PERF_MS, ANCHOR_WALL_SEC, PUSH_END_PERF_MS);

    const span = result.childSpans.find((s) => s.name === 'push:validate-fast');
    expect(span?.note).toBe('incomplete — hook exited before end marker');
  });

  it('banner is validate-fast-specific: an unpaired NON-validate-fast phase keeps the generic note', () => {
    // validate-fast paired fine; vitest-related is the phase that didn't close.
    const stderr = [
      marker('validate-fast', 'start', 1000),
      marker('validate-fast', 'end', 1010),
      marker('vitest-related', 'start', 1011),
      // a stray banner in output must NOT be attributed to vitest-related
      ...failBanner('check-something', 'npm run x'),
    ].join('\n');

    const result = parsePrepushTimingMarkers(stderr, ANCHOR_PERF_MS, ANCHOR_WALL_SEC, PUSH_END_PERF_MS);

    const vitest = result.childSpans.find((s) => s.name === 'push:vitest-related');
    expect(vitest?.status).toBe('err');
    expect(vitest?.note).toBe('incomplete — hook exited before end marker');
  });
});

describe('extractValidateFastFailure', () => {
  it('returns step + rerun from a complete banner', () => {
    const lines = failBanner('check-git-exec-maxbuffer', 'npm run validate:git-exec-maxbuffer');
    expect(extractValidateFastFailure(lines)).toEqual({
      step: 'check-git-exec-maxbuffer',
      rerun: 'npm run validate:git-exec-maxbuffer',
    });
  });

  it('returns step only when rerun is absent', () => {
    expect(extractValidateFastFailure(failBanner('check-typecheck-coverage'))).toEqual({
      step: 'check-typecheck-coverage',
    });
  });

  it('returns null when there is no banner', () => {
    expect(extractValidateFastFailure(['Counting objects: 100, done.', 'Writing objects: 100.'])).toBeNull();
  });

  it('returns null when the banner has the marker but no step: line', () => {
    expect(extractValidateFastFailure([RULE, '  validate:fast FAILED', RULE])).toBeNull();
  });

  it('stops at the closing rule and does not absorb a later unrelated step: line', () => {
    const lines = [
      RULE,
      '  validate:fast FAILED',
      RULE, // closes immediately — no step captured before the rule
      '  step:    not-the-failing-step',
    ];
    expect(extractValidateFastFailure(lines)).toBeNull();
  });

  it('uses the LAST failure marker when output contains more than one', () => {
    const lines = [
      ...failBanner('first-step', 'npm run first'),
      'some intervening output',
      ...failBanner('second-step', 'npm run second'),
    ];
    expect(extractValidateFastFailure(lines)).toEqual({ step: 'second-step', rerun: 'npm run second' });
  });
});
