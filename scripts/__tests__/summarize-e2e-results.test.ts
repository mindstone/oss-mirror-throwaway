import { describe, expect, it } from 'vitest';
import {
  classifyReport,
  renderMachineLine,
  renderSlackLine,
  renderSummaryMarkdown,
  type E2eFlakeSummary,
} from '../ci/summarize-e2e-results';

// ── Fixtures mirroring the @playwright/test JSONReport shape ──
// (JSONReportTest.status is the authoritative per-spec classification:
//  'expected' | 'flaky' | 'unexpected' | 'skipped'; results[].retry is 0-indexed.)

function spec(file: string, title: string, status: string, attempts = 1): object {
  return {
    file,
    title,
    ok: status === 'expected' || status === 'flaky',
    tests: [
      {
        status,
        results: Array.from({ length: attempts }, (_, i) => ({ retry: i })),
      },
    ],
  };
}

/** A report with one expected, one flaky (2 attempts), one unexpected, one skipped spec. */
const MIXED_REPORT = {
  suites: [
    {
      title: 'electron-smoke.spec.ts',
      file: 'electron-smoke.spec.ts',
      specs: [spec('electron-smoke.spec.ts', 'app boots cleanly', 'expected')],
    },
    {
      title: 'messaging.spec.ts',
      file: 'messaging.spec.ts',
      specs: [spec('messaging.spec.ts', 'Slack connects', 'flaky', 2)],
    },
    {
      title: 'session-management.spec.ts',
      file: 'session-management.spec.ts',
      specs: [
        spec('session-management.spec.ts', 'draft persists', 'unexpected', 2),
        spec('session-management.spec.ts', 'archived nav', 'skipped'),
      ],
    },
  ],
};

describe('classifyReport', () => {
  it('classifies expected / flaky / unexpected / skipped specs correctly', () => {
    const s = classifyReport(MIXED_REPORT);
    expect(s.expected).toBe(1);
    expect(s.flaky).toBe(1);
    expect(s.unexpected).toBe(1);
    expect(s.skipped).toBe(1);
    expect(s.total).toBe(4);
  });

  it('lists the flaky and unexpected specs by file + title', () => {
    const s = classifyReport(MIXED_REPORT);
    expect(s.flakySpecs).toEqual([
      { file: 'messaging.spec.ts', title: 'Slack connects', outcome: 'flaky', attempts: 2 },
    ]);
    expect(s.unexpectedSpecs).toEqual([
      { file: 'session-management.spec.ts', title: 'draft persists', outcome: 'unexpected', attempts: 2 },
    ]);
  });

  it('verdict is RED when ≥1 unexpected (the escalation predicate)', () => {
    expect(classifyReport(MIXED_REPORT).verdict).toBe('red');
  });

  it('verdict is SHIPPABLE-BUT-FLAKY when 0 unexpected + ≥1 flaky', () => {
    const report = {
      suites: [
        { specs: [spec('a.spec.ts', 'clean', 'expected')] },
        { specs: [spec('b.spec.ts', 'retried', 'flaky', 2)] },
      ],
    };
    const s = classifyReport(report);
    expect(s.verdict).toBe('shippable-but-flaky');
    expect(s.unexpected).toBe(0);
    expect(s.flaky).toBe(1);
  });

  it('verdict is CLEAN-GREEN when 0 unexpected + 0 flaky', () => {
    const report = { suites: [{ specs: [spec('a.spec.ts', 'one', 'expected'), spec('a.spec.ts', 'two', 'expected')] }] };
    const s = classifyReport(report);
    expect(s.verdict).toBe('clean-green');
    expect(s.flaky).toBe(0);
    expect(s.unexpected).toBe(0);
  });

  it('walks nested suites (describe blocks) recursively', () => {
    const nested = {
      suites: [
        {
          file: 'outer.spec.ts',
          specs: [],
          suites: [{ file: 'outer.spec.ts', specs: [spec('outer.spec.ts', 'deep', 'flaky', 2)] }],
        },
      ],
    };
    const s = classifyReport(nested);
    expect(s.flaky).toBe(1);
    expect(s.flakySpecs[0].title).toBe('deep');
  });

  it('rolls a spec up by worst-case severity (one flaky test among clean ones → flaky spec)', () => {
    const report = {
      suites: [
        {
          file: 'multi.spec.ts',
          specs: [
            {
              file: 'multi.spec.ts',
              title: 'parameterised',
              tests: [
                { status: 'expected', results: [{ retry: 0 }] },
                { status: 'flaky', results: [{ retry: 0 }, { retry: 1 }] },
              ],
            },
          ],
        },
      ],
    };
    const s = classifyReport(report);
    expect(s.flaky).toBe(1);
    expect(s.flakySpecs[0].attempts).toBe(2);
  });

  it('treats an unknown/missing status as skipped (never manufactures a false flaky/red)', () => {
    const report = { suites: [{ specs: [{ file: 'x.spec.ts', title: 'weird', tests: [{ status: 'bogus', results: [] }] }] }] };
    const s = classifyReport(report);
    expect(s.skipped).toBe(1);
    expect(s.flaky).toBe(0);
    expect(s.unexpected).toBe(0);
  });

  it('handles an empty / shapeless report without throwing', () => {
    expect(classifyReport({}).verdict).toBe('clean-green');
    expect(classifyReport(null).total).toBe(0);
    expect(classifyReport({ suites: [] }).total).toBe(0);
  });
});

describe('renderers', () => {
  it('machine line is one-line JSON with verdict + flaky/unexpected file+title lists', () => {
    const line = renderMachineLine(classifyReport(MIXED_REPORT));
    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line);
    expect(parsed.kind).toBe('e2e-flake-summary');
    expect(parsed.verdict).toBe('red');
    expect(parsed.flakySpecs).toEqual([{ file: 'messaging.spec.ts', title: 'Slack connects' }]);
    expect(parsed.unexpectedSpecs).toEqual([{ file: 'session-management.spec.ts', title: 'draft persists' }]);
  });

  it('markdown summary names the verdict badge and lists flaky + unexpected specs', () => {
    const md = renderSummaryMarkdown(classifyReport(MIXED_REPORT));
    expect(md).toContain('RED');
    expect(md).toContain('Unexpected');
    expect(md).toContain('draft persists');
    expect(md).toContain('Flaky');
    expect(md).toContain('Slack connects');
  });

  it('slack line summarises each verdict', () => {
    const flaky: E2eFlakeSummary = classifyReport({ suites: [{ specs: [spec('b.spec.ts', 'retried', 'flaky', 2)] }] });
    expect(renderSlackLine(flaky)).toContain('shippable-but-flaky');
    expect(renderSlackLine(flaky)).toContain('retried');
    expect(renderSlackLine(classifyReport(MIXED_REPORT))).toContain('red');
    const clean = classifyReport({ suites: [{ specs: [spec('a.spec.ts', 'ok', 'expected')] }] });
    expect(renderSlackLine(clean, 'https://example/run')).toContain('clean green');
    expect(renderSlackLine(clean, 'https://example/run')).toContain('run');
  });
});
