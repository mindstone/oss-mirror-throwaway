import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getTemporalGroup, groupByTemporal, TEMPORAL_GROUP_ORDER, TEMPORAL_GROUP_META } from '../temporalGroup';
import type { InboxItem } from '@shared/types';

const makeItem = (overrides: {
  dueBy?: number;
  addedAt: number;
  urgent?: boolean;
  important?: boolean;
  actions?: InboxItem['actions'];
  category?: InboxItem['category'];
  draft?: string;
  clarifyingQuestion?: string;
  relevantDate?: number;
}): typeof overrides => overrides;

const makeFullItem = (overrides: Partial<InboxItem> & { addedAt: number }): InboxItem => ({
  id: 'test-id',
  title: 'Test',
  text: 'Test text',
  references: [],
  ...overrides,
});

describe('getTemporalGroup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 10, 14, 0, 0)); // 2026-03-10 14:00
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('item with dueBy today → due-today', () => {
    const todayEvening = new Date(2026, 2, 10, 20, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ dueBy: todayEvening, addedAt: Date.now() }))).toBe('due-today');
  });

  it('item with dueBy overdue (yesterday) → due-today', () => {
    const yesterday = new Date(2026, 2, 9, 12, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ dueBy: yesterday, addedAt: Date.now() }))).toBe('due-today');
  });

  it('item with dueBy in 3 days → due-this-week', () => {
    const threeDays = new Date(2026, 2, 13, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ dueBy: threeDays, addedAt: Date.now() }))).toBe('due-this-week');
  });

  it('item with dueBy in 10 days → upcoming', () => {
    const tenDays = new Date(2026, 2, 20, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ dueBy: tenDays, addedAt: Date.now() }))).toBe('upcoming');
  });

  it('item without dueBy, addedAt today → due-today', () => {
    expect(getTemporalGroup(makeItem({ addedAt: Date.now() }))).toBe('due-today');
  });

  it('item without dueBy, addedAt yesterday (Monday) → due-this-week (arrival-based fallback)', () => {
    const yesterday = new Date(2026, 2, 9, 10, 0, 0).getTime(); // Monday, within current week
    expect(getTemporalGroup(makeItem({ addedAt: yesterday }))).toBe('due-this-week');
  });

  it('item without dueBy, addedAt 2 weeks ago → upcoming (arrival-based fallback)', () => {
    const twoWeeksAgo = new Date(2026, 1, 24, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: twoWeeksAgo }))).toBe('upcoming');
  });

  it('dueBy at exactly end of today → due-this-week (exclusive boundary)', () => {
    const todayEnd = new Date(2026, 2, 11, 0, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ dueBy: todayEnd, addedAt: Date.now() }))).toBe('due-this-week');
  });

  it('dueBy at end of week boundary → upcoming', () => {
    // Week ends at midnight Saturday (end of Friday March 13)
    const weekEnd = new Date(2026, 2, 14, 0, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ dueBy: weekEnd, addedAt: Date.now() }))).toBe('upcoming');
  });

  // --- Urgent (always Today) ---

  it('urgent item added 2 weeks ago → due-today', () => {
    const twoWeeksAgo = new Date(2026, 1, 24, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: twoWeeksAgo, urgent: true }))).toBe('due-today');
  });

  it('urgent overrides distant dueBy', () => {
    const tenDays = new Date(2026, 2, 20, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: Date.now(), dueBy: tenDays, urgent: true }))).toBe('due-today');
  });

  it('medium priority respects explicit dueBy instead of pinning to Today', () => {
    const friday = new Date(2026, 2, 13, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: Date.now(), dueBy: friday, urgent: true, important: false }))).toBe('due-this-week');
  });

  // --- Fresh action signals (≤ 7 days → Today) ---

  it('fresh draft (5 days old) → due-today', () => {
    const fiveDaysAgo = new Date(2026, 2, 5, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: fiveDaysAgo, draft: 'Hello team,' }))).toBe('due-today');
  });

  it('fresh clarifyingQuestion (3 days old) → due-today', () => {
    const threeDaysAgo = new Date(2026, 2, 7, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: threeDaysAgo, clarifyingQuestion: 'Need approval?' }))).toBe('due-today');
  });

  // --- Old action signals (> 7 days → This Week nudge) ---

  it('old draft (10 days, no deadline) → due-this-week (nudge)', () => {
    const tenDaysAgo = new Date(2026, 2, 1, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: tenDaysAgo, draft: 'Hello team,' }))).toBe('due-this-week');
  });

  it('old clarifyingQuestion (10 days, no deadline) → due-this-week (nudge)', () => {
    const tenDaysAgo = new Date(2026, 2, 1, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: tenDaysAgo, clarifyingQuestion: 'Need approval?' }))).toBe('due-this-week');
  });

  it('old CQ with dueBy tomorrow → due-today (deadline wins over age)', () => {
    const tenDaysAgo = new Date(2026, 2, 1, 10, 0, 0).getTime();
    const tomorrow = new Date(2026, 2, 10, 20, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: tenDaysAgo, clarifyingQuestion: 'Need approval?', dueBy: tomorrow }))).toBe('due-today');
  });

  it('old draft with relevantDate tomorrow → due-today (relevantDate wins over age)', () => {
    const tenDaysAgo = new Date(2026, 2, 1, 10, 0, 0).getTime();
    const tomorrow = new Date(2026, 2, 10, 20, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: tenDaysAgo, draft: 'Proposal...', relevantDate: tomorrow }))).toBe('due-today');
  });

  // --- Whitespace edge cases ---

  it('whitespace-only draft does not trigger action signal', () => {
    const twoWeeksAgo = new Date(2026, 1, 24, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: twoWeeksAgo, draft: '   ' }))).toBe('upcoming');
  });

  it('whitespace-only clarifyingQuestion does not trigger action signal', () => {
    const twoWeeksAgo = new Date(2026, 1, 24, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: twoWeeksAgo, clarifyingQuestion: '   ' }))).toBe('upcoming');
  });

  // --- relevantDate as deadline proxy ---

  it('relevantDate tonight → due-today', () => {
    const tonight = new Date(2026, 2, 10, 22, 0, 0).getTime();
    const twoWeeksAgo = new Date(2026, 1, 24, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: twoWeeksAgo, relevantDate: tonight }))).toBe('due-today');
  });

  it('relevantDate in 3 days (within work week) → due-this-week', () => {
    const threeDays = new Date(2026, 2, 13, 10, 0, 0).getTime(); // Friday, before weekEnd
    const twoWeeksAgo = new Date(2026, 1, 24, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: twoWeeksAgo, relevantDate: threeDays }))).toBe('due-this-week');
  });

  it('relevantDate in 10 days → upcoming', () => {
    const tenDays = new Date(2026, 2, 20, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: Date.now(), relevantDate: tenDays }))).toBe('upcoming');
  });

  it('relevantDate yesterday (overdue) → due-today', () => {
    const yesterday = new Date(2026, 2, 9, 12, 0, 0).getTime();
    const twoWeeksAgo = new Date(2026, 1, 24, 10, 0, 0).getTime();
    expect(getTemporalGroup(makeItem({ addedAt: twoWeeksAgo, relevantDate: yesterday }))).toBe('due-today');
  });

  it('item with no signals falls through to addedAt', () => {
    const yesterday = new Date(2026, 2, 9, 10, 0, 0).getTime(); // Monday, within current week
    expect(getTemporalGroup(makeItem({ addedAt: yesterday }))).toBe('due-this-week');
  });
});

describe('groupByTemporal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 10, 14, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('distributes items into correct groups', () => {
    const items: InboxItem[] = [
      makeFullItem({ id: 'a', addedAt: Date.now(), dueBy: new Date(2026, 2, 10, 18, 0, 0).getTime() }),
      makeFullItem({ id: 'b', addedAt: Date.now(), dueBy: new Date(2026, 2, 12, 10, 0, 0).getTime() }),
      makeFullItem({ id: 'c', addedAt: Date.now(), dueBy: new Date(2026, 2, 25, 10, 0, 0).getTime() }),
      makeFullItem({ id: 'd', addedAt: Date.now() }),
    ];

    const groups = groupByTemporal(items);
    expect(groups.get('due-today')!.map(i => i.id)).toEqual(['a', 'd']);
    expect(groups.get('due-this-week')!.map(i => i.id)).toEqual(['b']);
    expect(groups.get('upcoming')!.map(i => i.id)).toEqual(['c']);
  });

  it('returns empty arrays for groups with no items', () => {
    const groups = groupByTemporal([]);
    expect(groups.get('due-today')).toEqual([]);
    expect(groups.get('due-this-week')).toEqual([]);
    expect(groups.get('upcoming')).toEqual([]);
  });
});

describe('constants', () => {
  it('TEMPORAL_GROUP_ORDER has all groups', () => {
    expect(TEMPORAL_GROUP_ORDER).toEqual(['due-today', 'due-this-week', 'upcoming', 'all']);
  });

  it('TEMPORAL_GROUP_META has labels for all groups', () => {
    for (const group of TEMPORAL_GROUP_ORDER) {
      expect(TEMPORAL_GROUP_META[group]).toBeDefined();
      expect(TEMPORAL_GROUP_META[group].label).toBeTruthy();
    }
  });
});
