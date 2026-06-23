import { describe, expect, it } from 'vitest';
import {
  classifySessionSummaryWrite,
  declareSessionRestore,
  declareSoftDelete,
  isReattachableTrashRow,
  recordSessionRemoval,
} from '../sessionDeleteAuthority';

// ---------------------------------------------------------------------------
// Unit tests for the typed session delete-authority classifier
// (postmortem 260607_tombstone_ledger_f1_f2_block_renderer — rec
// fc1cf49aacb85c33: write paths must classify a session write as
// create / update / soft-delete / restore / stale-write-after-delete BEFORE
// mutating).
//
// The ledger is MODULE-scoped, so every test uses UNIQUE session ids to avoid
// cross-test pollution (same convention as sessionStore.resurrectionGuard).
// ---------------------------------------------------------------------------

describe('classifySessionSummaryWrite', () => {
  it('classifies an unknown id with no existing row as create', () => {
    const decision = classifySessionSummaryWrite({
      sessionId: 'authority-create',
      hasExistingRow: false,
    });
    expect(decision).toEqual({ kind: 'create' });
  });

  it('classifies an unknown id with an existing row as update', () => {
    const decision = classifySessionSummaryWrite({
      sessionId: 'authority-update',
      hasExistingRow: true,
    });
    expect(decision).toEqual({ kind: 'update' });
  });

  it('classifies any write for a hard-removed id as stale-write-after-delete', () => {
    const id = 'authority-hard-removed';
    recordSessionRemoval('hard-delete', [id]);

    const asCreate = classifySessionSummaryWrite({ sessionId: id, hasExistingRow: false });
    const asUpdate = classifySessionSummaryWrite({ sessionId: id, hasExistingRow: true });

    expect(asCreate.kind).toBe('stale-write-after-delete');
    expect(asUpdate.kind).toBe('stale-write-after-delete');
    if (asCreate.kind === 'stale-write-after-delete') {
      expect(typeof asCreate.removedAt).toBe('number');
    }
  });

  it('classifies writes after empty-trash and e2e-clear removals as stale', () => {
    recordSessionRemoval('empty-trash', ['authority-trash-emptied']);
    recordSessionRemoval('e2e-clear', ['authority-e2e-cleared']);

    expect(
      classifySessionSummaryWrite({ sessionId: 'authority-trash-emptied', hasExistingRow: false }).kind,
    ).toBe('stale-write-after-delete');
    expect(
      classifySessionSummaryWrite({ sessionId: 'authority-e2e-cleared', hasExistingRow: false }).kind,
    ).toBe('stale-write-after-delete');
  });

  it('ignores empty-string ids in bulk removals (no global tombstone)', () => {
    recordSessionRemoval('hard-delete', ['']);
    expect(
      classifySessionSummaryWrite({ sessionId: '', hasExistingRow: false }).kind,
    ).toBe('create');
  });
});

describe('declareSoftDelete / declareSessionRestore', () => {
  it('declareSoftDelete returns the typed soft-delete leg and tombstones the id', () => {
    const id = 'authority-soft-delete';
    const declared = declareSoftDelete(id);
    expect(declared).toEqual({ kind: 'soft-delete' });

    expect(
      classifySessionSummaryWrite({ sessionId: id, hasExistingRow: true }).kind,
    ).toBe('stale-write-after-delete');
  });

  it('declareSessionRestore returns the typed restore leg and re-admits writes', () => {
    const id = 'authority-restore';
    declareSoftDelete(id);

    const restored = declareSessionRestore(id);
    expect(restored).toEqual({ kind: 'restore' });

    expect(
      classifySessionSummaryWrite({ sessionId: id, hasExistingRow: true }).kind,
    ).toBe('update');
    expect(
      classifySessionSummaryWrite({ sessionId: id, hasExistingRow: false }).kind,
    ).toBe('create');
  });
});

describe('isReattachableTrashRow', () => {
  it('is true for any present-with-deletedAt row, ledger entry or not', () => {
    const trashedId = 'authority-reattach-trashed';
    const restartLoadedId = 'authority-reattach-restart-loaded';
    declareSoftDelete(trashedId);

    // Tombstoned + deletedAt set → reattachable Trash row.
    expect(isReattachableTrashRow({ id: trashedId, deletedAt: 123 })).toBe(true);
    // deletedAt set but NO ledger entry (a Trash row loaded from disk after a
    // renderer restart) → still authoritative Trash, still reattachable —
    // otherwise the row would be lost from the Trash view on the next reload
    // (review F1, round 2).
    expect(isReattachableTrashRow({ id: restartLoadedId, deletedAt: 123 })).toBe(true);
    // No deletedAt (a live row) → never reattachable, even if tombstoned.
    expect(isReattachableTrashRow({ id: trashedId, deletedAt: null })).toBe(false);
  });
});

describe('classifySessionSummaryWrite — state-derived authority (restart soundness)', () => {
  it('rejects a write over an existing deletedAt row even with NO ledger entry', () => {
    // Restart scenario: the trash row came from disk; this module's ledger
    // never saw the soft delete. The existing row's deletedAt is the
    // authority input.
    const decision = classifySessionSummaryWrite({
      sessionId: 'authority-restart-trash-row',
      hasExistingRow: true,
      existingRowDeletedAt: 1_700_000_111_000,
    });
    expect(decision).toEqual({
      kind: 'stale-write-after-delete',
      removedAt: 1_700_000_111_000,
    });
  });

  it('classifies normally when the existing row is live (deletedAt null)', () => {
    expect(
      classifySessionSummaryWrite({
        sessionId: 'authority-restart-live-row',
        hasExistingRow: true,
        existingRowDeletedAt: null,
      }).kind,
    ).toBe('update');
  });
});
