import { describe, it, expect } from 'vitest';
import { filterSessionList, resolveSidebarFilter, DEFAULT_SIDEBAR_FILTER, isActiveNavEntry } from '../filterSessionList';
import type { AgentSessionSidebarEntry } from '../../types';

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

describe('filterSessionList', () => {
  const pinnedStarred = makeEntry('ps', { isActive: true, isStarred: true, timestamp: 4000 });
  const pinned = makeEntry('p', { isActive: true, timestamp: 3000 });
  const doneStarred = makeEntry('as', { isStarred: true, timestamp: 2000 });
  const done = makeEntry('a', { timestamp: 1000 });
  const deleted = makeEntry('d', { isDeleted: true, timestamp: 500 });

  const all = [pinnedStarred, pinned, doneStarred, done, deleted];

  describe('filter: all', () => {
    it('returns non-deleted entries sorted by recency', () => {
      const result = filterSessionList(all, 'all');
      expect(result.entries.map((e) => e.id)).toEqual(['ps', 'p', 'as', 'a']);
      expect(result.starredCount).toBe(2);
    });
  });

  describe('filter: active', () => {
    it('returns only pinned non-deleted non-starred entries', () => {
      const result = filterSessionList(all, 'active');
      expect(result.entries.map((e) => e.id)).toEqual(['p']);
      expect(result.starredCount).toBe(0);
    });

    it('excludes app-initiated background entries from active but keeps them in all', () => {
      const automation = makeEntry('automation-source-capture--abc123', { isActive: true });
      const manual = makeEntry('conversation-abc123', { isActive: true });

      expect(filterSessionList([automation, manual], 'active').entries.map((e) => e.id))
        .toEqual(['conversation-abc123']);
      expect(filterSessionList([automation, manual], 'all').entries.map((e) => e.id))
        .toEqual(['automation-source-capture--abc123', 'conversation-abc123']);
    });

    it('keeps user-initiated automation insight entries in active', () => {
      const insight = makeEntry('automation-insight-abc123', { isActive: true });
      const result = filterSessionList([insight], 'active');
      expect(result.entries.map((e) => e.id)).toEqual(['automation-insight-abc123']);
    });
  });

  describe('filter: done', () => {
    it('returns only Done non-deleted entries, starred first', () => {
      const result = filterSessionList(all, 'done');
      expect(result.entries.map((e) => e.id)).toEqual(['as', 'a']);
      expect(result.starredCount).toBe(1);
    });
  });

  describe('filter: starred', () => {
    it('returns only starred non-deleted entries', () => {
      const result = filterSessionList(all, 'starred');
      expect(result.entries.map((e) => e.id)).toEqual(['ps', 'as']);
      expect(result.starredCount).toBe(2);
    });
  });

  describe('filter: trash', () => {
    it('returns only deleted entries', () => {
      const result = filterSessionList(all, 'trash');
      expect(result.entries.map((e) => e.id)).toEqual(['d']);
      expect(result.starredCount).toBe(0);
    });

    it('sorts by deletedAt descending (most recently deleted first)', () => {
      // Note: timestamp (updatedAt) order is deliberately the reverse of
      // deletedAt order, to prove the sort keys off deletedAt rather than updatedAt.
      const oldDelete = makeEntry('old', { isDeleted: true, deletedAt: 100, timestamp: 9000 });
      const newDelete = makeEntry('new', { isDeleted: true, deletedAt: 900, timestamp: 1000 });
      const midDelete = makeEntry('mid', { isDeleted: true, deletedAt: 500, timestamp: 5000 });
      const result = filterSessionList([oldDelete, newDelete, midDelete], 'trash');
      expect(result.entries.map((e) => e.id)).toEqual(['new', 'mid', 'old']);
    });

    it('does not float starred deleted entries to the top of trash', () => {
      const starredOld = makeEntry('s', { isDeleted: true, isStarred: true, deletedAt: 100 });
      const plainNew = makeEntry('n', { isDeleted: true, deletedAt: 900 });
      const result = filterSessionList([starredOld, plainNew], 'trash');
      expect(result.entries.map((e) => e.id)).toEqual(['n', 's']);
    });
  });

  describe('recency cutoff', () => {
    it('excludes entries older than cutoff', () => {
      const result = filterSessionList(all, 'all', 2500);
      expect(result.entries.map((e) => e.id)).toEqual(['ps', 'p']);
    });

    it('is ignored for trash filter', () => {
      const result = filterSessionList(all, 'trash', 9999);
      expect(result.entries.map((e) => e.id)).toEqual(['d']);
    });

    it('null cutoff applies no filtering', () => {
      const result = filterSessionList(all, 'all', null);
      expect(result.entries).toHaveLength(4);
    });
  });

  describe('starred floating', () => {
    it('does not float starred entries in all because all is chronological', () => {
      const s1 = makeEntry('s1', { isStarred: true, isActive: true, timestamp: 5000 });
      const s2 = makeEntry('s2', { isStarred: true, isActive: false, timestamp: 3000 });
      const n1 = makeEntry('n1', { isActive: true, timestamp: 4000 });
      const n2 = makeEntry('n2', { isActive: false, timestamp: 2000 });
      const entries = [s1, n1, s2, n2];

      const result = filterSessionList(entries, 'all');
      expect(result.entries.map((e) => e.id)).toEqual(['s1', 'n1', 's2', 'n2']);
      expect(result.starredCount).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('returns empty result for empty input', () => {
      const result = filterSessionList([], 'all');
      expect(result.entries).toEqual([]);
      expect(result.starredCount).toBe(0);
    });

    it('handles all entries being deleted with non-trash filter', () => {
      const d1 = makeEntry('d1', { isDeleted: true });
      const d2 = makeEntry('d2', { isDeleted: true });
      const result = filterSessionList([d1, d2], 'all');
      expect(result.entries).toEqual([]);
      expect(result.starredCount).toBe(0);
    });

    it('entries with same timestamp maintain stable insertion order', () => {
      const a = makeEntry('a', { timestamp: 1000 });
      const b = makeEntry('b', { timestamp: 1000 });
      const c = makeEntry('c', { timestamp: 1000 });
      const result = filterSessionList([a, b, c], 'all');
      expect(result.entries.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    });

    it('starredCount is correct when no starred entries exist', () => {
      const e1 = makeEntry('e1', { isActive: true });
      const e2 = makeEntry('e2');
      const result = filterSessionList([e1, e2], 'all');
      expect(result.starredCount).toBe(0);
    });

    it('starredCount is correct when all entries are starred', () => {
      const e1 = makeEntry('e1', { isStarred: true, isActive: true });
      const e2 = makeEntry('e2', { isStarred: true });
      const result = filterSessionList([e1, e2], 'all');
      expect(result.starredCount).toBe(2);
      expect(result.entries).toHaveLength(2);
    });
  });

  describe('empty history sessions in active filter', () => {
    it('excludes empty history sessions from active', () => {
      const empty = makeEntry('empty', { isActive: true, messageCount: 0, isHistory: true });
      const withMessages = makeEntry('full', { isActive: true, messageCount: 5, isHistory: true });
      const result = filterSessionList([empty, withMessages], 'active');
      expect(result.entries.map((e) => e.id)).toEqual(['full']);
    });

    it('keeps the current (non-history) session even if empty', () => {
      const current = makeEntry('current', { isActive: true, messageCount: 0, isHistory: false });
      const result = filterSessionList([current], 'active');
      expect(result.entries.map((e) => e.id)).toEqual(['current']);
    });

    it('keeps empty history sessions that have a draft', () => {
      const draft = makeEntry('draft', { isActive: true, messageCount: 0, isHistory: true, hasDraft: true });
      const result = filterSessionList([draft], 'active');
      expect(result.entries.map((e) => e.id)).toEqual(['draft']);
    });

    it('keeps empty history sessions that are currently thinking', () => {
      const busy = makeEntry('busy', { isActive: true, messageCount: 0, isHistory: true, status: 'thinking' });
      const result = filterSessionList([busy], 'active');
      expect(result.entries.map((e) => e.id)).toEqual(['busy']);
    });

    it('still shows empty history sessions in all filter', () => {
      const empty = makeEntry('empty', { isActive: true, messageCount: 0, isHistory: true });
      const result = filterSessionList([empty], 'all');
      expect(result.entries.map((e) => e.id)).toEqual(['empty']);
    });
  });

  describe('alwaysIncludeId', () => {
    it('does not force a Done entry into active filter (category mismatch)', () => {
      const doneEntry = makeEntry('current', { isActive: false, timestamp: 5000 });
      const activeEntry = makeEntry('p', { isActive: true, timestamp: 3000 });
      const result = filterSessionList([doneEntry, activeEntry], 'active', null, 'current');
      expect(result.entries.map((e) => e.id)).not.toContain('current');
    });

    it('does not force a background entry into active filter', () => {
      const automation = makeEntry('automation-source-capture--abc123', {
        isActive: true,
        timestamp: 100,
      });
      const recent = makeEntry('recent', { isActive: true, timestamp: 5000 });
      const result = filterSessionList(
        [automation, recent],
        'active',
        3000,
        'automation-source-capture--abc123',
      );
      expect(result.entries.map((e) => e.id)).toEqual(['recent']);
    });

    it('includes an entry excluded by recency cutoff', () => {
      const old = makeEntry('old', { isActive: true, timestamp: 100 });
      const recent = makeEntry('recent', { isActive: true, timestamp: 5000 });
      const result = filterSessionList([old, recent], 'active', 3000, 'old');
      expect(result.entries.map((e) => e.id)).toContain('old');
    });

    it('does not include a deleted entry in non-trash filter', () => {
      const del = makeEntry('del', { isDeleted: true });
      const result = filterSessionList([del], 'all', null, 'del');
      expect(result.entries).toHaveLength(0);
    });

    it('is a no-op when the entry already passes the filter', () => {
      const entry = makeEntry('ok', { isActive: true, timestamp: 5000 });
      const result = filterSessionList([entry], 'active', null, 'ok');
      expect(result.entries).toHaveLength(1);
    });
  });
});

describe('resolveSidebarFilter (localStorage read-time migration)', () => {
  it("migrates the legacy 'archived' value to 'done'", () => {
    expect(resolveSidebarFilter('archived')).toBe('done');
  });

  it.each(['active', 'done', 'starred', 'trash', 'all'] as const)(
    "passes through the valid value '%s'",
    (value) => {
      expect(resolveSidebarFilter(value)).toBe(value);
    },
  );

  it('falls back to the default for an unrecognised value', () => {
    expect(resolveSidebarFilter('bogus')).toBe(DEFAULT_SIDEBAR_FILTER);
  });

  it('falls back to the default for null/empty input', () => {
    expect(resolveSidebarFilter(null)).toBe(DEFAULT_SIDEBAR_FILTER);
    expect(resolveSidebarFilter(undefined)).toBe(DEFAULT_SIDEBAR_FILTER);
    expect(resolveSidebarFilter('')).toBe(DEFAULT_SIDEBAR_FILTER);
  });

  it('uses the current default tab (active)', () => {
    expect(DEFAULT_SIDEBAR_FILTER).toBe('active');
  });
});

describe('isActiveNavEntry (collapsed pinned-tabs strip + mark-done auto-switch)', () => {
  const navEntry = (
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
    isResolved: false,
    resolvedAt: null,
    isActive: true,
    isStarred: false,
    isDeleted: false,
    messageCount: 3,
    ...overrides,
  });

  it('includes active, non-deleted manual conversations (starred ones too)', () => {
    expect(isActiveNavEntry(navEntry('conversation-abc'))).toBe(true);
    expect(isActiveNavEntry(navEntry('conversation-abc', { isStarred: true }))).toBe(true);
  });

  it('excludes app-initiated background kinds even when active', () => {
    expect(isActiveNavEntry(navEntry('automation-source-capture--abc123'))).toBe(false);
    expect(isActiveNavEntry(navEntry('meeting-analysis-abc123'))).toBe(false);
    expect(isActiveNavEntry(navEntry('use-case-discovery-abc123'))).toBe(false);
  });

  it('keeps user-initiated automation-insight and cli-chat in the active nav surfaces', () => {
    expect(isActiveNavEntry(navEntry('automation-insight-abc123'))).toBe(true);
    expect(isActiveNavEntry(navEntry('cli-chat-abc123'))).toBe(true);
  });

  it('excludes Done and deleted entries', () => {
    expect(isActiveNavEntry(navEntry('conversation-done', { isActive: false }))).toBe(false);
    expect(isActiveNavEntry(navEntry('conversation-del', { isDeleted: true }))).toBe(false);
  });
});
