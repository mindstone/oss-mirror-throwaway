import { describe, expect, it } from 'vitest';

import {
  deriveImmediateParentRelPath,
  planConflictCopyCleanup,
  type CleanupPlan,
  type ConflictSnapshotEntry,
} from '../conflictCopyCleanup';

function entry(relPath: string, hash: string | null, size = 10): ConflictSnapshotEntry {
  return { relPath, hash, size };
}

function plan(snapshot: readonly ConflictSnapshotEntry[]): CleanupPlan {
  return planConflictCopyCleanup(snapshot);
}

describe('conflictCopyCleanup', () => {
  it('quarantines numbered-copy files identical to parent and reviews differing copies', () => {
    expect(
      plan([
        entry('notes.md', 'hash-a'),
        entry('notes (1).md', 'hash-a'),
        entry('todo.md', 'hash-b'),
        entry('todo (1).md', 'hash-c'),
      ]),
    ).toEqual({
      toQuarantine: [
        {
          relPath: 'notes (1).md',
          immediateParentRelPath: 'notes.md',
          label: 'numbered-copy',
          provider: 'google-drive',
          hash: 'hash-a',
        },
      ],
      needsReview: [
        {
          relPath: 'todo (1).md',
          label: 'numbered-copy',
          provider: 'google-drive',
          immediateParentRelPath: 'todo.md',
          reason: 'differing-from-parent',
        },
      ],
    });
  });

  it('peels only one suffix for nested numbered copies', () => {
    expect(
      plan([
        entry('foo.md', 'base'),
        entry('foo (1).md', 'nested-parent'),
        entry('foo (1) (1).md', 'nested-parent'),
      ]),
    ).toEqual({
      toQuarantine: [
        {
          relPath: 'foo (1) (1).md',
          immediateParentRelPath: 'foo (1).md',
          label: 'numbered-copy',
          provider: 'google-drive',
          hash: 'nested-parent',
        },
      ],
      needsReview: [
        {
          relPath: 'foo (1).md',
          label: 'numbered-copy',
          provider: 'google-drive',
          immediateParentRelPath: 'foo.md',
          reason: 'differing-from-parent',
        },
      ],
    });
  });

  it('keeps DA D1 copy-suffix parents in review and only quarantines their numbered children', () => {
    expect(
      plan([
        entry('budget.md', 'same'),
        entry('budget copy.md', 'same'),
        entry('budget copy (1).md', 'same'),
      ]),
    ).toEqual({
      toQuarantine: [
        {
          relPath: 'budget copy (1).md',
          immediateParentRelPath: 'budget copy.md',
          label: 'numbered-copy',
          provider: 'google-drive',
          hash: 'same',
        },
      ],
      needsReview: [
        {
          relPath: 'budget copy.md',
          label: 'copy-suffix-duplicate',
          provider: 'generic',
          immediateParentRelPath: 'budget.md',
          reason: 'detect-only-label',
        },
      ],
    });
  });

  it('always sends copy-of and copy-suffix labels to review', () => {
    expect(
      plan([
        entry('notes.md', 'same'),
        entry('Copy of notes.md', 'same'),
        entry('notes copy.md', 'same'),
      ]),
    ).toEqual({
      toQuarantine: [],
      needsReview: [
        {
          relPath: 'Copy of notes.md',
          label: 'copy-of-duplicate',
          provider: 'generic',
          immediateParentRelPath: 'notes.md',
          reason: 'detect-only-label',
        },
        {
          relPath: 'notes copy.md',
          label: 'copy-suffix-duplicate',
          provider: 'generic',
          immediateParentRelPath: 'notes.md',
          reason: 'detect-only-label',
        },
      ],
    });
  });

  it('reviews empty, unreadable, and empty-parent cases with explicit reasons', () => {
    expect(
      plan([
        entry('empty.md', 'parent'),
        entry('empty (1).md', 'child', 0),
        entry('unreadable.md', 'parent'),
        entry('unreadable (1).md', null),
        entry('parent-empty.md', 'parent', 0),
        entry('parent-empty (1).md', 'child'),
      ]),
    ).toEqual({
      toQuarantine: [],
      needsReview: [
        {
          relPath: 'empty (1).md',
          label: 'numbered-copy',
          provider: 'google-drive',
          immediateParentRelPath: 'empty.md',
          reason: 'empty-or-placeholder',
        },
        {
          relPath: 'parent-empty (1).md',
          label: 'numbered-copy',
          provider: 'google-drive',
          immediateParentRelPath: 'parent-empty.md',
          reason: 'parent-empty-or-unreadable',
        },
        {
          relPath: 'unreadable (1).md',
          label: 'numbered-copy',
          provider: 'google-drive',
          immediateParentRelPath: 'unreadable.md',
          reason: 'empty-or-placeholder',
        },
      ],
    });
  });

  it('reviews conflicts whose immediate parent is missing', () => {
    expect(plan([entry('missing-parent (1).md', 'hash')])).toEqual({
      toQuarantine: [],
      needsReview: [
        {
          relPath: 'missing-parent (1).md',
          label: 'numbered-copy',
          provider: 'google-drive',
          immediateParentRelPath: 'missing-parent.md',
          reason: 'parent-missing',
        },
      ],
    });
  });

  it('quarantines identical Dropbox and generic sync conflict files', () => {
    expect(
      plan([
        entry('docs/report.md', 'same'),
        entry('docs/report (conflicted copy 2026-06-01).md', 'same'),
        entry('data/state.json', 'same-json'),
        entry('data/state-conflict-202606010001.json', 'same-json'),
      ]),
    ).toEqual({
      toQuarantine: [
        {
          relPath: 'data/state-conflict-202606010001.json',
          immediateParentRelPath: 'data/state.json',
          label: 'sync-conflict',
          provider: 'generic',
          hash: 'same-json',
        },
        {
          relPath: 'docs/report (conflicted copy 2026-06-01).md',
          immediateParentRelPath: 'docs/report.md',
          label: 'dropbox-conflict',
          provider: 'dropbox',
          hash: 'same',
        },
      ],
      needsReview: [],
    });
  });

  it('is independent of snapshot ordering', () => {
    const snapshot = [
      entry('b.md', 'b'),
      entry('b (1).md', 'different'),
      entry('a.md', 'a'),
      entry('a (1).md', 'a'),
      entry('Copy of c.md', 'c'),
      entry('c.md', 'c'),
    ];

    const shuffled = [snapshot[4], snapshot[1], snapshot[3], snapshot[0], snapshot[5], snapshot[2]];

    expect(plan(shuffled)).toEqual(plan(snapshot));
  });

  it('ignores multi-dot numbered-looking names that do not match the current numbered-copy pattern', () => {
    // conflictPatterns.ts:127-129 currently says `data (2).tar.gz` strips to
    // `data.tar.gz`, but the numbered-copy regex only matches `(<digits>).<word>`
    // at end of name.
    expect(deriveImmediateParentRelPath('data (2).tar.gz')).toBeNull();
    expect(plan([entry('data.tar.gz', 'same'), entry('data (2).tar.gz', 'same')])).toEqual({
      toQuarantine: [],
      needsReview: [],
    });
  });
});
