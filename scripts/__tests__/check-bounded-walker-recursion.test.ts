import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOUNDED_WALKER_EXEMPT_BASELINE,
  BOUNDED_WALKER_PENDING_BASELINE,
  SCAN_ROOTS,
  classifyResults,
  findWalkerViolations,
  findWalkerViolationsInSource,
} from '../check-bounded-walker-recursion';

const fixtureDir = join(__dirname, 'fixtures', 'bounded-walker');

function analyzeFixture(fileName: string) {
  const filePath = join(fixtureDir, fileName);
  return findWalkerViolationsInSource(readFileSync(filePath, 'utf8'), filePath);
}

describe('check-bounded-walker-recursion', () => {
  it('scans all production roots guarded by the bounded-walker ratchet', () => {
    expect(SCAN_ROOTS).toEqual([
      'src/core',
      'src/main',
      'src/renderer',
      'private/mindstone/src',
      'cloud-service/src',
    ]);
  });

  it('flags self-recursive fs.readdir walkers', () => {
    const violations = analyzeFixture('positive-recursive-walker.ts');

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      functionName: 'walk',
      classification: 'error',
    });
  });

  it('flags stack/queue walkers with readdir inside while loops', () => {
    const violations = analyzeFixture('positive-queue-walker.ts');

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      functionName: 'walkWithQueue',
      classification: 'error',
    });
  });

  it('does not flag flat directory reads', () => {
    expect(analyzeFixture('negative-flat-read.ts')).toEqual([]);
  });

  it('does not flag functions that use safeWalkDirectory', () => {
    expect(analyzeFixture('negative-safe-walk-directory.ts')).toEqual([]);
  });

  it('classifies annotated pending walkers as pending', () => {
    const violations = analyzeFixture('annotation-pending.ts');

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      functionName: 'walk',
      classification: 'pending',
      reason: 'legacy walker',
    });
  });

  it('classifies annotated exempt walkers as exempt', () => {
    const violations = analyzeFixture('annotation-exempt.ts');

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      functionName: 'walk',
      classification: 'exempt',
      reason: 'bounded by depth=3',
    });
  });

  it('keeps the real-repo walker counts at or below the ratchet baselines', () => {
    const violations = findWalkerViolations(SCAN_ROOTS);
    const { errors, pending, exempt } = classifyResults(violations);

    expect(errors).toEqual([]);
    expect(pending).toHaveLength(BOUNDED_WALKER_PENDING_BASELINE);
    expect(exempt).toHaveLength(BOUNDED_WALKER_EXEMPT_BASELINE);
  });
});
