// Stage 7 — membership-integrity / merge / version-skew coverage for the
// folders restore reconcile policy (Amendments A2 + A7; F1/F2/F4/F6/F7).
//
// These exercise the PURE `reconcileRestoredFolders` helper plus the shared
// parse helper (`parseFolderStoreData`) directly — no cloud client / IPC, so
// they pin the policy independently of the pull-path plumbing covered by
// cloudRouter.foldersRestore.test.ts.

import { describe, expect, it } from 'vitest';
import { reconcileRestoredFolders } from '../cloudRouter';
import { parseFolderStoreData, type FolderStoreData } from '@shared/ipc/schemas/folders';

function doc(partial: Partial<FolderStoreData> = {}): FolderStoreData {
  return { version: 1, folders: [], membership: {}, ...partial };
}

const EMPTY = doc();

describe('reconcileRestoredFolders — restore policy (Stage 7)', () => {
  it('F6 fresh machine: local trivial ⇒ takes cloud verbatim (folders + membership)', () => {
    const cloud = doc({
      folders: [
        { id: 'fldr_house', name: 'house', createdAt: 1, updatedAt: 2 },
        { id: 'fldr_empty', name: 'Empty', createdAt: 3, updatedAt: 3 },
      ],
      membership: { s1: 'fldr_house' },
    });

    const out = reconcileRestoredFolders({
      cloud,
      local: EMPTY,
      presentSessionIds: new Set(['s1']),
    });

    expect(out.folders.map((f) => f.id)).toEqual(['fldr_house', 'fldr_empty']);
    expect(out.membership).toEqual({ s1: 'fldr_house' });
  });

  it('F2 empty folder survives the restore (folder defs independent of membership)', () => {
    const cloud = doc({
      folders: [{ id: 'fldr_empty', name: 'Empty', createdAt: 1, updatedAt: 1 }],
      membership: {},
    });
    const out = reconcileRestoredFolders({ cloud, local: EMPTY, presentSessionIds: new Set() });
    expect(out.folders.map((f) => f.id)).toContain('fldr_empty');
  });

  it('F6 local non-empty: union by id, cloud authoritative on conflict, local-only preserved', () => {
    const cloud = doc({
      folders: [
        { id: 'shared', name: 'CloudName', createdAt: 10, updatedAt: 20 },
        { id: 'cloudOnly', name: 'Cloud Only', createdAt: 5, updatedAt: 5 },
      ],
      membership: { s1: 'shared' },
    });
    const local = doc({
      folders: [
        { id: 'shared', name: 'LocalName', createdAt: 1, updatedAt: 1 },
        { id: 'localOnly', name: 'Local Only', createdAt: 2, updatedAt: 2 },
      ],
      membership: { s2: 'localOnly' },
    });

    const out = reconcileRestoredFolders({
      cloud,
      local,
      presentSessionIds: new Set(['s1', 's2']),
    });

    const byId = new Map(out.folders.map((f) => [f.id, f]));
    // Cloud authoritative on the conflicting id.
    expect(byId.get('shared')?.name).toBe('CloudName');
    // Local-only folder NOT dropped.
    expect(byId.get('localOnly')).toBeDefined();
    // Cloud-only folder present.
    expect(byId.get('cloudOnly')).toBeDefined();
    // Both memberships preserved (their sessions are present).
    expect(out.membership).toEqual({ s1: 'shared', s2: 'localOnly' });
  });

  it('F1/F7 prunes dangling membership (session absent locally) but KEEPS folder defs', () => {
    const cloud = doc({
      folders: [{ id: 'fldr_house', name: 'house', createdAt: 1, updatedAt: 2 }],
      membership: { present: 'fldr_house', ghost: 'fldr_house' },
    });

    const out = reconcileRestoredFolders({
      cloud,
      local: EMPTY,
      presentSessionIds: new Set(['present']), // 'ghost' is absent
    });

    // Dangling membership dropped.
    expect(out.membership).toEqual({ present: 'fldr_house' });
    // Folder definition KEPT even though it would otherwise have only a ghost.
    expect(out.folders.map((f) => f.id)).toContain('fldr_house');
  });

  it('F7 partial migration: membership for a session that never uploaded is pruned', () => {
    // Folders PUT succeeded but session "s_failed" never reached the cloud /
    // never arrived locally → its membership row must not create a ghost.
    const cloud = doc({
      folders: [{ id: 'f1', name: 'F1', createdAt: 1, updatedAt: 1 }],
      membership: { s_ok: 'f1', s_failed: 'f1' },
    });
    const out = reconcileRestoredFolders({
      cloud,
      local: EMPTY,
      presentSessionIds: new Set(['s_ok']),
    });
    expect(out.membership).toEqual({ s_ok: 'f1' });
    expect(out.folders).toHaveLength(1);
  });
});

describe('parseFolderStoreData — wire contract (A2, F4/F5)', () => {
  it('parses a valid v1 document', () => {
    const parsed = parseFolderStoreData(doc({
      folders: [{ id: 'a', name: 'A', createdAt: 1, updatedAt: 1 }],
    }));
    expect(parsed).not.toBeNull();
    expect(parsed?.folders).toHaveLength(1);
  });

  it('F4 newer-cloud version (version:2) ⇒ null (desktop no-op, never clobber local)', () => {
    const future = { version: 2, folders: [], membership: {} };
    expect(parseFolderStoreData(future)).toBeNull();
  });

  it('F5 404 / malformed / null ⇒ null (no-op)', () => {
    expect(parseFolderStoreData(null)).toBeNull();
    expect(parseFolderStoreData(undefined)).toBeNull();
    expect(parseFolderStoreData({ nope: true })).toBeNull();
    expect(parseFolderStoreData('not-an-object')).toBeNull();
  });
});
