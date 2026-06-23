import { describe, expect, it } from 'vitest';

import { computeCoveredSet, enumerateWiredScripts, evaluateCoverage } from '../check-typecheck-coverage';

describe('enumerateWiredScripts', () => {
  it('extracts direct tsx script tokens and resolves npm run via package.json', () => {
    const runner = `
      const STEPS = [
        { name: 'a', command: 'npx tsx scripts/check-a.ts', rerun: 'npx tsx scripts/check-a.ts' },
        { name: 'b', command: 'npm run validate:b' },
        { name: 'c', command: 'node --import tsx scripts/check-c.ts --check' },
      ];
    `;
    const pkg = { 'validate:b': 'npx tsx scripts/check-b.ts' };
    expect(enumerateWiredScripts(runner, pkg)).toEqual([
      'scripts/check-a.ts',
      'scripts/check-b.ts',
      'scripts/check-c.ts',
    ]);
  });

  it('ignores npm run targets with no script-token resolution', () => {
    const runner = `{ command: 'npm run lint' }, { command: 'npm run missing' }`;
    expect(enumerateWiredScripts(runner, { lint: 'eslint .' })).toEqual([]);
  });

  it('dedupes a script wired through multiple steps', () => {
    const runner = `{ command: 'npx tsx scripts/check-a.ts' }, { command: 'npm run a2' }`;
    expect(enumerateWiredScripts(runner, { a2: 'npx tsx scripts/check-a.ts --fast' })).toEqual([
      'scripts/check-a.ts',
    ]);
  });

  it('expands npm lifecycle pre/post hooks (a hook-wired script must still be fenced)', () => {
    const runner = `{ command: 'npm run validate:x' }`;
    const pkg = {
      'prevalidate:x': 'npx tsx scripts/check-pre.ts',
      'validate:x': 'npx tsx scripts/check-x.ts',
      'postvalidate:x': 'npx tsx scripts/check-post.ts',
    };
    expect(enumerateWiredScripts(runner, pkg)).toEqual([
      'scripts/check-post.ts',
      'scripts/check-pre.ts',
      'scripts/check-x.ts',
    ]);
  });

  it('expands nested npm run transitively', () => {
    const runner = `{ command: 'npm run outer' }`;
    const pkg = {
      outer: 'npm run inner && npx tsx scripts/check-outer.ts',
      inner: 'npx tsx scripts/check-inner.ts',
    };
    expect(enumerateWiredScripts(runner, pkg)).toEqual([
      'scripts/check-inner.ts',
      'scripts/check-outer.ts',
    ]);
  });

  it('is cycle-safe when npm scripts reference each other', () => {
    const runner = `{ command: 'npm run a' }`;
    const pkg = { a: 'npm run b', b: 'npm run a && npx tsx scripts/check-z.ts' };
    expect(enumerateWiredScripts(runner, pkg)).toEqual(['scripts/check-z.ts']);
  });
});

describe('evaluateCoverage', () => {
  it('passes when every uncovered wired script is grandfathered', () => {
    const r = evaluateCoverage(
      ['scripts/a.ts', 'scripts/b.ts', 'scripts/c.ts'],
      new Set(['scripts/a.ts']), // a is covered
      ['scripts/b.ts', 'scripts/c.ts'], // b, c grandfathered
    );
    expect(r.uncovered).toEqual(['scripts/b.ts', 'scripts/c.ts']);
    expect(r.newlyUncovered).toEqual([]);
    expect(r.staleBaseline).toEqual([]);
  });

  it('flags a NEW uncovered wired script absent from the baseline (the recurrence guard)', () => {
    const r = evaluateCoverage(
      ['scripts/a.ts', 'scripts/new-gate.ts'],
      new Set(['scripts/a.ts']),
      [], // empty baseline
    );
    expect(r.newlyUncovered).toEqual(['scripts/new-gate.ts']);
  });

  it('flags a baseline entry that is now covered (ratchet-down)', () => {
    const r = evaluateCoverage(
      ['scripts/a.ts', 'scripts/b.ts'],
      new Set(['scripts/a.ts', 'scripts/b.ts']), // both now covered
      ['scripts/b.ts'], // b still grandfathered → stale
    );
    expect(r.newlyUncovered).toEqual([]);
    expect(r.staleBaseline).toEqual(['scripts/b.ts']);
  });

  it('flags a baseline entry that is no longer wired (stale config)', () => {
    const r = evaluateCoverage(
      ['scripts/a.ts'], // b removed from the wired set entirely
      new Set(['scripts/a.ts']),
      ['scripts/b.ts'],
    );
    expect(r.staleBaseline).toEqual(['scripts/b.ts']);
  });

  it('reports both newly-uncovered and stale-baseline simultaneously', () => {
    const r = evaluateCoverage(
      ['scripts/a.ts', 'scripts/new.ts'],
      new Set(['scripts/a.ts']), // a covered, new uncovered
      ['scripts/gone.ts'], // gone not in wired → stale
    );
    expect(r.newlyUncovered).toEqual(['scripts/new.ts']);
    expect(r.staleBaseline).toEqual(['scripts/gone.ts']);
  });

  it('sorts uncovered and staleBaseline deterministically', () => {
    const r = evaluateCoverage(
      ['scripts/z.ts', 'scripts/a.ts'],
      new Set(),
      ['scripts/z.ts', 'scripts/a.ts', 'scripts/gone-z.ts', 'scripts/gone-a.ts'],
    );
    expect(r.uncovered).toEqual(['scripts/a.ts', 'scripts/z.ts']);
    expect(r.staleBaseline).toEqual(['scripts/gone-a.ts', 'scripts/gone-z.ts']);
  });
});

describe('computeCoveredSet', () => {
  it('expands include globs minus exclude against the repo', () => {
    // This gate's own script is explicitly in tsconfig.node.json include.
    const covered = computeCoveredSet({
      include: ['scripts/check-typecheck-coverage.ts'],
      exclude: [],
    });
    expect(covered.has('scripts/check-typecheck-coverage.ts')).toBe(true);
  });

  it('honours exclude', () => {
    const covered = computeCoveredSet({
      include: ['scripts/check-typecheck-coverage.ts'],
      exclude: ['scripts/check-typecheck-coverage.ts'],
    });
    expect(covered.has('scripts/check-typecheck-coverage.ts')).toBe(false);
  });

  it('returns empty for an empty include', () => {
    expect(computeCoveredSet({ include: [], exclude: [] }).size).toBe(0);
  });
});
