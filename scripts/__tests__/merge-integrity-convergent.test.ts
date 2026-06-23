import { describe, expect, it } from 'vitest';

import { assessMergeIntegrity, type MergeFacts } from '../lib/merge-integrity';

/**
 * Convergent no-op merge vs genuine "ours"-merge discrimination.
 *
 * Replays the 260611 incident topology exactly (per the Pathologist
 * replay-the-incident-topology closure rule): two agents advanced the same
 * submodule pointers to the same commits (one side pushed the other's
 * submodule work), then merged. theirsFiles = the two gitlinks, both
 * convergent; merge tree == parent1 tree. The primary tree-equality check
 * used to FAIL this as an "ours"-style merge (incident: merge 4eedb846d
 * blocked a push with "all incoming changes were dropped" at 0.0%
 * incorporation) without consulting the convergence facts that
 * collectMergeFacts had already computed.
 */

function makeFacts(overrides: Partial<MergeFacts>): MergeFacts {
  return {
    mergeCommit: 'merge000',
    parent1: 'ours0000',
    parent2: 'theirs00',
    mergeTree: 'tree-ours',
    parent1Tree: 'tree-ours', // tree equality — the suspicious shape
    theirsFiles: [],
    mergeChangedFiles: [],
    convergentFiles: [],
    isMerge: true,
    isOctopus: false,
    ...overrides,
  };
}

describe('assessMergeIntegrity — convergent no-op merges (260611 incident shape)', () => {
  it('passes a tree-identical merge when EVERY theirs file is convergent (gitlink pointers both sides advanced to the same commits)', () => {
    const result = assessMergeIntegrity(
      makeFacts({
        theirsFiles: ['coding-agent-instructions', 'super-mcp'],
        convergentFiles: ['coding-agent-instructions', 'super-mcp'],
      }),
    );

    expect(result.status).toBe('pass');
    expect(result.reason).toContain('convergent');
    expect(result.incorporationRatio).toBe(1);
  });

  it('still FAILS a genuine ours-merge: tree-identical with non-convergent theirs files', () => {
    const result = assessMergeIntegrity(
      makeFacts({
        theirsFiles: ['src/real-change.ts', 'docs/incoming.md'],
        convergentFiles: [],
      }),
    );

    expect(result.status).toBe('fail');
    expect(result.reason).toContain('all incoming changes were dropped');
    expect(result.suspiciousFiles).toEqual(['src/real-change.ts', 'docs/incoming.md']);
  });

  it('still FAILS when only SOME theirs files are convergent — the rest were really dropped', () => {
    const result = assessMergeIntegrity(
      makeFacts({
        theirsFiles: ['super-mcp', 'src/dropped-feature.ts'],
        convergentFiles: ['super-mcp'],
      }),
    );

    expect(result.status).toBe('fail');
    // Diagnostics name only the genuinely non-convergent file
    expect(result.suspiciousFiles).toEqual(['src/dropped-feature.ts']);
  });

  it('keeps the pre-existing no-op exemption: tree-identical with zero theirs files is not flagged', () => {
    const result = assessMergeIntegrity(makeFacts({ theirsFiles: [] }));

    expect(result.status).not.toBe('fail');
  });
});
