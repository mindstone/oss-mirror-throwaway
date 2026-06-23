import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assessMergeIntegrity,
  loadDefaultAllowlist,
  type MergeFacts,
} from '../lib/merge-integrity';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'merge-integrity-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

function makeFacts(overrides: Partial<MergeFacts> = {}): MergeFacts {
  return {
    mergeCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    parent1: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    parent2: 'cccccccccccccccccccccccccccccccccccccccc',
    mergeTree: 'merge-tree',
    parent1Tree: 'parent1-tree',
    theirsFiles: [],
    mergeChangedFiles: [],
    convergentFiles: [],
    isMerge: true,
    isOctopus: false,
    ...overrides,
  };
}

function namedFiles(count: number): string[] {
  return Array.from({ length: count }, (_value, index) => `src/incoming-${index}.ts`);
}

describe('assessMergeIntegrity', () => {
  it('short-circuits an injected synthetic allowlist entry before failing suspicious facts', () => {
    const facts = makeFacts({
      mergeCommit: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      mergeTree: 'same-tree',
      parent1Tree: 'same-tree',
      theirsFiles: ['src/dropped.ts'],
      convergentFiles: [],
    });

    const result = assessMergeIntegrity(facts, {
      allowlist: [
        {
          sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          reason: 'synthetic recovered merge fixture',
          recovered_in: 'dddddddddddddddddddddddddddddddddddddddd',
        },
      ],
    });

    expect(result.status).toBe('pass');
    expect(result.reason).toBe('Allowlisted: synthetic recovered merge fixture');
    expect(result.incorporationRatio).toBe(1);
  });

  it('amends the stale 260429 case 2 expectation: tree-equal theirs files fail only when non-convergent', () => {
    const nonConvergent = assessMergeIntegrity(
      makeFacts({
        mergeTree: 'same-tree',
        parent1Tree: 'same-tree',
        theirsFiles: ['src/dropped.ts'],
        convergentFiles: [],
      }),
      { allowlist: [] },
    );

    const allConvergent = assessMergeIntegrity(
      makeFacts({
        mergeTree: 'same-tree',
        parent1Tree: 'same-tree',
        theirsFiles: ['coding-agent-instructions', 'super-mcp'],
        convergentFiles: ['coding-agent-instructions', 'super-mcp'],
      }),
      { allowlist: [] },
    );

    expect(nonConvergent.status).toBe('fail');
    expect(nonConvergent.suspiciousFiles).toEqual(['src/dropped.ts']);
    expect(allConvergent.status).toBe('pass');
    expect(allConvergent.reason).toContain('convergent');
  });

  it('fails zero incorporation at the minTheirsFiles boundary', () => {
    const theirsFiles = namedFiles(5);

    const result = assessMergeIntegrity(
      makeFacts({
        theirsFiles,
        mergeChangedFiles: [],
      }),
      { allowlist: [], minTheirsFiles: 5, threshold: 0.4 },
    );

    expect(result.status).toBe('fail');
    expect(result.reason).toContain('Zero incorporation');
    expect(result.suspiciousFiles).toEqual(theirsFiles);
  });

  it('does not fire the ratio gate just below the minTheirsFiles boundary', () => {
    const result = assessMergeIntegrity(
      makeFacts({
        theirsFiles: namedFiles(4),
        mergeChangedFiles: [],
      }),
      { allowlist: [], minTheirsFiles: 5, threshold: 0.4 },
    );

    expect(result.status).toBe('pass');
    expect(result.incorporationRatio).toBe(0);
  });

  it('pins the ratio threshold boundary: below warns, at and above pass', () => {
    const theirsFiles = namedFiles(5);
    const baseFacts = makeFacts({ theirsFiles });

    const below = assessMergeIntegrity(
      { ...baseFacts, mergeChangedFiles: theirsFiles.slice(0, 1) },
      { allowlist: [], minTheirsFiles: 5, threshold: 0.4 },
    );
    const at = assessMergeIntegrity(
      { ...baseFacts, mergeChangedFiles: theirsFiles.slice(0, 2) },
      { allowlist: [], minTheirsFiles: 5, threshold: 0.4 },
    );
    const above = assessMergeIntegrity(
      { ...baseFacts, mergeChangedFiles: theirsFiles.slice(0, 3) },
      { allowlist: [], minTheirsFiles: 5, threshold: 0.4 },
    );

    expect(below.status).toBe('warn');
    expect(below.incorporationRatio).toBe(0.2);
    expect(at.status).toBe('pass');
    expect(at.incorporationRatio).toBe(0.4);
    expect(above.status).toBe('pass');
    expect(above.incorporationRatio).toBe(0.6);
  });

  it('enforces the all-convergent invariant across primary, secondary, and no-theirs shapes', () => {
    const cases: Array<{ name: string; facts: MergeFacts }> = [
      {
        name: 'primary-tree-equality',
        facts: makeFacts({
          mergeTree: 'same-tree',
          parent1Tree: 'same-tree',
          theirsFiles: ['coding-agent-instructions', 'super-mcp'],
          convergentFiles: ['coding-agent-instructions', 'super-mcp'],
        }),
      },
      {
        name: 'secondary-ratio',
        facts: makeFacts({
          theirsFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
          mergeChangedFiles: [],
          convergentFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
        }),
      },
      {
        name: 'no-theirs',
        facts: makeFacts({
          mergeTree: 'same-tree',
          parent1Tree: 'same-tree',
          theirsFiles: [],
          convergentFiles: [],
        }),
      },
    ];

    for (const { name, facts } of cases) {
      const result = assessMergeIntegrity(facts, {
        allowlist: [],
        minTheirsFiles: 1,
        threshold: 0.99,
      });

      expect(result.status, name).not.toBe('fail');
    }
  });
});

describe('loadDefaultAllowlist', () => {
  it('fails soft to an empty list when the allowlist file is missing', () => {
    const missingPath = join(createTempRoot(), 'missing-allowlist.json');

    expect(loadDefaultAllowlist(missingPath)).toEqual([]);
  });

  it('fails soft to an empty list when the allowlist file is malformed', () => {
    const malformedPath = join(createTempRoot(), 'malformed-allowlist.json');
    writeFileSync(malformedPath, '{ nope', 'utf8');

    expect(loadDefaultAllowlist(malformedPath)).toEqual([]);
  });

  it('fails soft to an empty list when the allowlist shape is missing exempted_merges', () => {
    const malformedShapePath = join(createTempRoot(), 'malformed-shape-allowlist.json');
    writeFileSync(malformedShapePath, '{"exempted_merges": "not-an-array"}', 'utf8');

    expect(loadDefaultAllowlist(malformedShapePath)).toEqual([]);
  });

  it('filters malformed allowlist entries instead of returning crashable rows', () => {
    const malformedEntryPath = join(createTempRoot(), 'malformed-entry-allowlist.json');
    writeFileSync(
      malformedEntryPath,
      JSON.stringify({
        exempted_merges: [
          { reason: 'missing sha' },
          {
            sha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            reason: 'valid synthetic row',
          },
        ],
      }),
      'utf8',
    );

    expect(loadDefaultAllowlist(malformedEntryPath)).toEqual([
      {
        sha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        reason: 'valid synthetic row',
      },
    ]);
  });
});
