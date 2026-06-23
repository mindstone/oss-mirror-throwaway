import { describe, it, expect } from 'vitest';
import { buildFolderAwareList, type SidebarListEntry } from '../buildFolderAwareList';
import type { AgentSessionSidebarEntry } from '../../types';
import type { ConversationFolder } from '@shared/ipc/schemas/folders';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeEntry = (
  id: string,
  overrides: Partial<AgentSessionSidebarEntry> = {},
): AgentSessionSidebarEntry => ({
  id,
  title: `Session ${id}`,
  preview: 'Preview',
  timestamp: 2000,
  status: 'ready',
  isHistory: true,
  isCorrupted: false,
  isResolved: true,
  resolvedAt: 1000,
  isActive: false,
  isStarred: false,
  isDeleted: false,
  messageCount: 3,
  ...overrides,
});

const makeFolder = (
  id: string,
  name: string,
  createdAt: number,
): ConversationFolder => ({
  id,
  name,
  createdAt,
  updatedAt: createdAt,
});

const ids = (result: SidebarListEntry[]) => result.map((r) => r.id);
const types = (result: SidebarListEntry[]) => result.map((r) => r.type);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildFolderAwareList', () => {
  // Active (pinned) sessions — mirror how the Active tab pre-filters input.
  const s1 = makeEntry('s1', { timestamp: 4000, isActive: true });
  const s2 = makeEntry('s2', { timestamp: 3000, isActive: true });
  const s3 = makeEntry('s3', { timestamp: 2000, isActive: true });
  const s4 = makeEntry('s4', { timestamp: 1000, isActive: true, isStarred: true });

  it('returns all entries as unfiled sessions when no folders exist', () => {
    const result = buildFolderAwareList([s1, s2, s3], [], {});
    expect(ids(result)).toEqual(['s1', 's2', 's3']);
    expect(types(result)).toEqual(['session', 'session', 'session']);
  });

  it('shows folder header + children for populated folder', () => {
    const folder = makeFolder('f1', 'Work', 1000);
    const membership = { s1: 'f1', s2: 'f1' };

    const result = buildFolderAwareList([s1, s2, s3], [folder], membership);

    expect(ids(result)).toEqual(['folder:f1', 's1', 's2', 's3']);
    expect(types(result)).toEqual(['folder-header', 'session', 'session', 'session']);

    const header = result[0] as Extract<SidebarListEntry, { type: 'folder-header' }>;
    expect(header.childCount).toBe(2);
    expect(header.isCollapsed).toBe(false);
  });

  it('hides children when folder is collapsed', () => {
    const folder = makeFolder('f1', 'Work', 1000);
    const membership = { s1: 'f1', s2: 'f1' };
    const collapseState = { f1: true };

    const result = buildFolderAwareList([s1, s2, s3], [folder], membership, { collapseState });

    expect(ids(result)).toEqual(['folder:f1', 's3']);
    expect(types(result)).toEqual(['folder-header', 'session']);

    const header = result[0] as Extract<SidebarListEntry, { type: 'folder-header' }>;
    expect(header.childCount).toBe(2);
    expect(header.isCollapsed).toBe(true);
  });

  it('shows empty folder header with childCount 0', () => {
    const folder = makeFolder('f1', 'Empty', 1000);

    const result = buildFolderAwareList([s1], [folder], {});

    expect(ids(result)).toEqual(['folder:f1', 's1']);
    const header = result[0] as Extract<SidebarListEntry, { type: 'folder-header' }>;
    expect(header.childCount).toBe(0);
    expect(header.isCollapsed).toBe(false);
  });

  it('hides folders that have live members outside the current filter', () => {
    const folder = makeFolder('f1', 'Work', 1000);
    const membership = { s1: 'f1' };

    const result = buildFolderAwareList([], [folder], membership, { allEntries: [s1] });

    expect(result).toEqual([]);
  });

  it('sorts starred sessions first within folders', () => {
    const folder = makeFolder('f1', 'Work', 1000);
    const starred = makeEntry('ss', { timestamp: 1000, isActive: true, isStarred: true });
    const normal = makeEntry('sn', { timestamp: 5000, isActive: true });
    const membership = { ss: 'f1', sn: 'f1' };

    const result = buildFolderAwareList([normal, starred], [folder], membership);

    // Starred should come first among folder children
    const childIds = result.filter((r) => r.type === 'session').map((r) => r.id);
    expect(childIds).toEqual(['ss', 'sn']);
  });

  it('sorts starred unfiled sessions before folders and non-starred unfiled', () => {
    const folder = makeFolder('f1', 'Work', 1000);
    const membership = { s2: 'f1' };
    // s4 is starred + unfiled, s1 and s3 are unfiled non-starred
    const result = buildFolderAwareList([s1, s2, s3, s4], [folder], membership);

    // Order: starred unfiled → folder headers + children → non-starred unfiled
    expect(ids(result)).toEqual(['s4', 'folder:f1', 's2', 's1', 's3']);
  });

  // The currentSessionId param was removed from buildFolderAwareList's signature —
  // auto-expand is reveal-only (currentSessionId auto-expand is handled by the sidebar useEffect).

  it('auto-expands collapsed folder containing revealSessionId', () => {
    const folder = makeFolder('f1', 'Work', 1000);
    const membership = { s1: 'f1' };
    const collapseState = { f1: true };

    const result = buildFolderAwareList([s1, s2], [folder], membership, {
      collapseState,
      revealSessionId: 's1',
    });

    expect(ids(result)).toEqual(['folder:f1', 's1', 's2']);
    const header = result[0] as Extract<SidebarListEntry, { type: 'folder-header' }>;
    expect(header.isCollapsed).toBe(false);
  });

  it('treats orphaned membership (unknown folderId) as unfiled', () => {
    const folder = makeFolder('f1', 'Work', 1000);
    const membership = { s1: 'f1', s2: 'nonexistent' };

    const result = buildFolderAwareList([s1, s2, s3], [folder], membership);

    // s2 should appear as unfiled since its folder doesn't exist
    expect(ids(result)).toEqual(['folder:f1', 's1', 's2', 's3']);
  });

  it('sorts multiple folders by createdAt ascending', () => {
    const f1 = makeFolder('f1', 'Older', 1000);
    const f2 = makeFolder('f2', 'Newer', 2000);
    const f3 = makeFolder('f3', 'Newest', 3000);
    const membership = { s1: 'f3', s2: 'f1', s3: 'f2' };

    const result = buildFolderAwareList([s1, s2, s3], [f2, f3, f1], membership);

    // Folders should appear in createdAt order regardless of input order
    const folderOrder = result
      .filter((r) => r.type === 'folder-header')
      .map((r) => r.id);
    expect(folderOrder).toEqual(['folder:f1', 'folder:f2', 'folder:f3']);
  });

  it('only includes sessions that are in filteredEntries (pre-filtered input)', () => {
    const folder = makeFolder('f1', 'Work', 1000);
    // s1 and s2 are in the folder, but only s1 is in the filtered entries.
    // allEntries defaults to filteredEntries, so s2 is invisible to the builder.
    const membership = { s1: 'f1', s2: 'f1' };

    const result = buildFolderAwareList([s1], [folder], membership);

    const header = result[0] as Extract<SidebarListEntry, { type: 'folder-header' }>;
    expect(header.childCount).toBe(1);
    expect(ids(result)).toEqual(['folder:f1', 's1']);
  });

  it('preserves each session entry in the output wrapper', () => {
    const result = buildFolderAwareList([s1], [], {});
    const sessionEntry = result[0] as Extract<SidebarListEntry, { type: 'session' }>;
    expect(sessionEntry.entry).toBe(s1);
    expect(sessionEntry.id).toBe('s1');
  });

  it('handles empty input gracefully', () => {
    const folder = makeFolder('f1', 'Work', 1000);
    const result = buildFolderAwareList([], [folder], {});

    expect(result.length).toBe(1);
    const header = result[0] as Extract<SidebarListEntry, { type: 'folder-header' }>;
    expect(header.childCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Done(N) subsection
  // -------------------------------------------------------------------------

  describe('Done(N) subsection', () => {
    // Done conversations: in a folder, not pinned, not starred, not deleted.
    const d1 = makeEntry('d1', { timestamp: 9000, isActive: false });
    const d2 = makeEntry('d2', { timestamp: 8000, isActive: false });

    it('emits done-subheader (collapsed by default) after active children, no done rows', () => {
      const folder = makeFolder('f1', 'Work', 1000);
      const active = makeEntry('a1', { timestamp: 5000, isActive: true });
      const membership = { a1: 'f1', d1: 'f1', d2: 'f1' };
      const allEntries = [active, d1, d2];

      const result = buildFolderAwareList([active], [folder], membership, {
        // doneCollapseState absent → collapsed by default
        allEntries,
        includeDoneSubsection: true, // Active tab
      });

      // header → active child → done-subheader (collapsed, no children below)
      expect(ids(result)).toEqual(['folder:f1', 'a1', 'done:f1']);
      expect(types(result)).toEqual(['folder-header', 'session', 'done-subheader']);

      const sub = result[2] as Extract<SidebarListEntry, { type: 'done-subheader' }>;
      expect(sub.folderId).toBe('f1');
      expect(sub.folderName).toBe('Work');
      expect(sub.doneCount).toBe(2);
      expect(sub.isCollapsed).toBe(true);

      // folder-header childCount stays active-only
      const header = result[0] as Extract<SidebarListEntry, { type: 'folder-header' }>;
      expect(header.childCount).toBe(1);
    });

    it('emits done rows (timestamp desc, isMutedDone) when done subsection expanded', () => {
      const folder = makeFolder('f1', 'Work', 1000);
      const active = makeEntry('a1', { timestamp: 5000, isActive: true });
      // d2 newer than d1 here to assert desc sort
      const dOlder = makeEntry('dOlder', { timestamp: 100, isActive: false });
      const dNewer = makeEntry('dNewer', { timestamp: 900, isActive: false });
      const membership = { a1: 'f1', dOlder: 'f1', dNewer: 'f1' };
      const allEntries = [active, dOlder, dNewer];

      const result = buildFolderAwareList([active], [folder], membership, {
        doneCollapseState: { f1: false }, // done expanded
        allEntries,
        includeDoneSubsection: true, // Active tab
      });

      expect(ids(result)).toEqual(['folder:f1', 'a1', 'done:f1', 'dNewer', 'dOlder']);
      const doneRow = result[3] as Extract<SidebarListEntry, { type: 'session' }>;
      expect(doneRow.isMutedDone).toBe(true);
      const sub = result[2] as Extract<SidebarListEntry, { type: 'done-subheader' }>;
      expect(sub.isCollapsed).toBe(false);
    });

    it('renders no done-subheader when the folder has zero done conversations', () => {
      const folder = makeFolder('f1', 'Work', 1000);
      const active = makeEntry('a1', { timestamp: 5000, isActive: true });
      const membership = { a1: 'f1' };

      const result = buildFolderAwareList([active], [folder], membership, {
        allEntries: [active],
        includeDoneSubsection: true, // Active tab
      });

      expect(ids(result)).toEqual(['folder:f1', 'a1']);
      expect(types(result)).toEqual(['folder-header', 'session']);
    });

    it('does NOT emit a done-subheader on non-Active tabs (Starred/Archived path, includeDoneSubsection=false)', () => {
      // Reproduces the bug where the Done subsection leaked into the Starred tab
      // and double-rendered in the Done/Archived tab. The shared builder runs for
      // those tabs too; with includeDoneSubsection=false it must emit folder
      // children only — no done-subheader, no muted done rows.
      const folder = makeFolder('f1', 'Work', 1000);
      const active = makeEntry('a1', { timestamp: 5000, isActive: true });
      const membership = { a1: 'f1', d1: 'f1', d2: 'f1' };
      const allEntries = [active, d1, d2];

      const result = buildFolderAwareList([active], [folder], membership, {
        doneCollapseState: { f1: false }, // even with done "expanded", nothing should emit
        allEntries,
        includeDoneSubsection: false, // non-Active tab
      });

      expect(types(result)).not.toContain('done-subheader');
      expect(result.some((r) => r.type === 'session' && r.isMutedDone)).toBe(false);
      expect(ids(result)).toEqual(['folder:f1', 'a1']);
    });

    it('all-done folder still auto-drops from Active (existing guard preserved)', () => {
      const folder = makeFolder('f1', 'Work', 1000);
      // No active members; two done members exist in allEntries.
      const membership = { d1: 'f1', d2: 'f1' };
      const allEntries = [d1, d2];

      const result = buildFolderAwareList(
        [], // no active children for this folder
        [folder],
        membership,
        {
          allEntries,
          includeDoneSubsection: true, // Active tab
        },
      );

      // Folder drops out entirely (children.length === 0 && totalLiveChildren > 0).
      expect(result).toEqual([]);
    });

    it('excludes starred-and-done from the done bucket (no double-count)', () => {
      const folder = makeFolder('f1', 'Work', 1000);
      const active = makeEntry('a1', { timestamp: 5000, isActive: true });
      const starredDone = makeEntry('sd', { timestamp: 7000, isActive: false, isStarred: true });
      const membership = { a1: 'f1', sd: 'f1', d1: 'f1' };
      const allEntries = [active, starredDone, d1];

      const result = buildFolderAwareList([active], [folder], membership, {
        doneCollapseState: { f1: false }, // expanded so we can inspect the rows
        allEntries,
        includeDoneSubsection: true, // Active tab
      });

      // Only d1 in the done bucket; starredDone excluded.
      const sub = result.find((r) => r.type === 'done-subheader') as
        | Extract<SidebarListEntry, { type: 'done-subheader' }>
        | undefined;
      expect(sub?.doneCount).toBe(1);
      const doneRowIds = result
        .filter((r): r is Extract<SidebarListEntry, { type: 'session' }> => r.type === 'session' && Boolean(r.isMutedDone))
        .map((r) => r.id);
      expect(doneRowIds).toEqual(['d1']);
    });

    it('reveal-on-navigate to a done child expands both the folder AND its done subsection without mutating input maps', () => {
      const folder = makeFolder('f1', 'Work', 1000);
      const active = makeEntry('a1', { timestamp: 5000, isActive: true });
      const membership = { a1: 'f1', d1: 'f1' };
      const allEntries = [active, d1];
      const collapseState = { f1: true }; // folder collapsed
      const doneCollapseState = { f1: true }; // done collapsed

      const result = buildFolderAwareList([active], [folder], membership, {
        collapseState,
        doneCollapseState,
        revealSessionId: 'd1', // → a done child
        allEntries,
        includeDoneSubsection: true, // Active tab
      });

      // Folder forced open, done subsection forced open, done child visible.
      expect(ids(result)).toEqual(['folder:f1', 'a1', 'done:f1', 'd1']);
      const header = result[0] as Extract<SidebarListEntry, { type: 'folder-header' }>;
      expect(header.isCollapsed).toBe(false);
      const sub = result[2] as Extract<SidebarListEntry, { type: 'done-subheader' }>;
      expect(sub.isCollapsed).toBe(false);

      // Persisted maps must NOT be mutated.
      expect(collapseState).toEqual({ f1: true });
      expect(doneCollapseState).toEqual({ f1: true });
    });

    it('does NOT force-open the done subsection on plain currentSessionId', () => {
      const folder = makeFolder('f1', 'Work', 1000);
      const active = makeEntry('a1', { timestamp: 5000, isActive: true });
      const membership = { a1: 'f1', d1: 'f1' };
      const allEntries = [active, d1];

      const result = buildFolderAwareList([active], [folder], membership, {
        // doneCollapseState absent → collapsed by default
        // currentSessionId 'd1' is NOT a param — passing it as revealSessionId would
        // force-open; here we omit it so the done subsection must stay collapsed.
        allEntries,
        includeDoneSubsection: true, // Active tab
      });

      // Done subsection stays collapsed; no done rows emitted.
      expect(ids(result)).toEqual(['folder:f1', 'a1', 'done:f1']);
      const sub = result[2] as Extract<SidebarListEntry, { type: 'done-subheader' }>;
      expect(sub.isCollapsed).toBe(true);
    });

    it('defaults to collapsed when doneCollapseState has no entry for the folder', () => {
      const folder = makeFolder('f1', 'Work', 1000);
      const active = makeEntry('a1', { timestamp: 5000, isActive: true });
      const membership = { a1: 'f1', d1: 'f1' };
      const allEntries = [active, d1];

      const result = buildFolderAwareList([active], [folder], membership, {
        doneCollapseState: { someOtherFolder: false }, // no entry for f1
        allEntries,
        includeDoneSubsection: true, // Active tab
      });

      const sub = result[2] as Extract<SidebarListEntry, { type: 'done-subheader' }>;
      expect(sub.isCollapsed).toBe(true);
    });

    it('emits nothing below the folder header when the folder is collapsed even if done is expanded', () => {
      const folder = makeFolder('f1', 'Work', 1000);
      const active = makeEntry('a1', { timestamp: 5000, isActive: true });
      const membership = { a1: 'f1', d1: 'f1' };
      const allEntries = [active, d1];
      const collapseState = { f1: true }; // folder collapsed
      const doneCollapseState = { f1: false }; // done expanded — must not leak out

      const result = buildFolderAwareList([active], [folder], membership, {
        collapseState,
        doneCollapseState,
        allEntries,
        includeDoneSubsection: true, // Active tab
      });

      // Only the folder header — no active children, no done-subheader, no done rows.
      expect(ids(result)).toEqual(['folder:f1']);
      expect(types(result)).toEqual(['folder-header']);
    });
  });
});
