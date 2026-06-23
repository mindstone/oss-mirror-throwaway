import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  selectJudgeSample,
  selectRandomSample,
  shuffle,
  buildJudgePrompt,
  verifyJudgeOutput,
  renderJudgeReport,
} from '../audit-doc-reachability-judge';
import type { UnitCoverage } from '../audit-doc-reachability';

/** Deterministic LCG so random-sampling tests are reproducible. */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function unit(u: string, tier: 'high' | 'medium' | 'low', fanIn: number, hops: number | null): UnitCoverage {
  return { unit: u, tier, fanIn, hops, viaDoc: hops === null ? null : 'docs/project/X.md', hasOwnDoc: false };
}

describe('selectJudgeSample', () => {
  const coverage: UnitCoverage[] = [
    unit('src/a', 'high', 50, 2), unit('src/b', 'high', 40, null), unit('src/c', 'high', 30, 3),
    unit('src/d', 'high', 20, null), unit('src/e', 'high', 10, 2), unit('src/f', 'low', 99, null),
  ];
  it('samples high-risk only, mixing reachable + unreachable, sorted by fan-in', () => {
    const s = selectJudgeSample(coverage, 4);
    expect(s.length).toBe(4);
    expect(s.every((c) => c.tier === 'high')).toBe(true); // never low tier
    expect(s.some((c) => c.hops !== null)).toBe(true); // some reachable
    expect(s.some((c) => c.hops === null)).toBe(true); // some unreachable
    // sorted by fan-in desc
    expect(s[0].fanIn).toBeGreaterThanOrEqual(s[s.length - 1].fanIn);
  });
  it('respects the limit and dedupes', () => {
    const s = selectJudgeSample(coverage, 3);
    expect(s.length).toBe(3);
    expect(new Set(s.map((c) => c.unit)).size).toBe(3);
  });
});

describe('shuffle', () => {
  it('is a permutation (no loss/dup) and deterministic given an rng', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = shuffle(arr, seededRng(42));
    const b = shuffle(arr, seededRng(42));
    expect(a.sort()).toEqual(arr); // same multiset
    expect(shuffle(arr, seededRng(42))).toEqual(b); // reproducible
    expect(arr).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // input not mutated
  });
});

describe('selectRandomSample', () => {
  const coverage: UnitCoverage[] = [
    ...Array.from({ length: 8 }, (_, i) => unit(`src/high${i}`, 'high', 20 - i, i % 2 ? null : 2)),
    ...Array.from({ length: 6 }, (_, i) => unit(`src/low${i}`, 'low', 1, 2)),
    ...Array.from({ length: 3 }, (_, i) => unit(`src/med${i}`, 'medium', 5, null)),
  ];
  it('returns `limit` distinct units spread across tiers, guaranteeing high-risk + unreachable', () => {
    const s = selectRandomSample(coverage, 10, seededRng(7));
    expect(s.length).toBe(10);
    expect(new Set(s.map((c) => c.unit)).size).toBe(10);
    expect(s.filter((c) => c.tier === 'high').length).toBeGreaterThanOrEqual(Math.ceil(10 * 0.25));
    expect(s.some((c) => c.hops === null)).toBe(true); // some unreachable represented
    expect(s.some((c) => c.tier === 'low')).toBe(true); // breadth across tiers, unlike the deterministic sampler
  });
});

describe('buildJudgePrompt', () => {
  it('embeds targets, stage-1 hints, and the JSON output path', () => {
    const p = buildJudgePrompt([unit('src/a', 'high', 5, null), unit('src/b', 'high', 5, 2)], 'tmp/out.json');
    expect(p).toContain('`src/a/`');
    expect(p).toContain('UNREACHABLE');
    expect(p).toContain('reachable in 2 hops');
    expect(p).toContain('tmp/out.json');
    expect(p).toContain('PASS_EXACT');
  });
});

describe('verifyJudgeOutput', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-'));
    fs.mkdirSync(path.join(tmp, 'src', 'real'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '');
    fs.writeFileSync(path.join(tmp, 'src', 'real', 'file.ts'), '');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('marks a judgment trustworthy when all cited paths exist and grade is valid', () => {
    const v = verifyJudgeOutput([{ unit: 'src/real', grade: 'PASS_EXACT', route: ['AGENTS.md'], citedPaths: ['src/real/file.ts'] }], tmp);
    expect(v[0].trustworthy).toBe(true);
    expect(v[0].missingCited).toEqual([]);
  });
  it('flags hallucinated routes (cited path missing)', () => {
    const v = verifyJudgeOutput([{ unit: 'src/real', grade: 'PASS_EXACT', route: ['AGENTS.md'], citedPaths: ['src/ghost/nope.ts'] }], tmp);
    expect(v[0].trustworthy).toBe(false);
    expect(v[0].missingCited).toContain('src/ghost/nope.ts');
  });
  it('flags an invalid grade', () => {
    const v = verifyJudgeOutput([{ unit: 'src/real', grade: 'GREAT', citedPaths: ['src/real/file.ts'] }], tmp);
    expect(v[0].grade).toBe('INVALID');
    expect(v[0].trustworthy).toBe(false);
  });
  it('tolerates trailing slashes / anchors / line numbers in cited paths', () => {
    const v = verifyJudgeOutput([{ unit: 'src/real', grade: 'PASS_AREA', citedPaths: ['src/real/', 'src/real/file.ts:42', 'AGENTS.md#x'] }], tmp);
    expect(v[0].trustworthy).toBe(true);
  });
});

describe('renderJudgeReport', () => {
  it('surfaces untrustworthy and actionable (WEAK/FAIL) sections', () => {
    const verified = verifyJudgeOutput(
      [
        { unit: 'src/x', grade: 'PASS_EXACT', citedPaths: [] },
        { unit: 'src/y', grade: 'WEAK', citedPaths: [] },
        { unit: 'src/z', grade: 'PASS_EXACT', citedPaths: ['src/ghost.ts'] },
      ],
      os.tmpdir(),
    );
    const md = renderJudgeReport(verified);
    expect(md).toContain('Doc-quality gaps to fix');
    expect(md).toContain('src/y');
    expect(md).toContain('Untrustworthy');
    expect(md).toContain('src/z');
  });
});
