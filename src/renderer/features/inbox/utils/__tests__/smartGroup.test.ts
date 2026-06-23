import { describe, it, expect } from 'vitest';
import { groupBySource } from '../smartGroup';
import type { InboxItem } from '@shared/types';

const makeItem = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: crypto.randomUUID(),
  title: 'Test item',
  text: 'Body',
  addedAt: Date.now(),
  archived: false,
  references: [],
  ...overrides,
});

describe('groupBySource', () => {
  it('returns all items ungrouped when below threshold (8)', () => {
    const items = Array.from({ length: 7 }, () => makeItem());
    const result = groupBySource(items);
    expect(result.ungrouped).toHaveLength(7);
    expect(result.groups).toHaveLength(0);
  });

  it('groups items by automation source when at threshold', () => {
    const automationItems = Array.from({ length: 5 }, (_, i) =>
      makeItem({
        title: `Action ${i}`,
        source: { kind: 'automation', automationId: 'a1', automationName: 'Weekly Standup' },
      }),
    );
    const otherItems = Array.from({ length: 4 }, (_, i) => makeItem({ title: `Other ${i}` }));
    const items = [...automationItems, ...otherItems];

    const result = groupBySource(items);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].label).toBe('5 from Weekly Standup');
    expect(result.groups[0].items).toHaveLength(5);
    expect(result.ungrouped).toHaveLength(4);
  });

  it('groups items by meeting title', () => {
    const meetingItems = Array.from({ length: 3 }, (_, i) =>
      makeItem({
        title: `Action ${i}`,
        source: { kind: 'meeting', meetingTitle: 'Sprint Review' },
      }),
    );
    const items = [...meetingItems, ...Array.from({ length: 6 }, () => makeItem())];

    const result = groupBySource(items);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].label).toBe('3 from Sprint Review');
  });

  it('keeps singletons ungrouped even above threshold', () => {
    const items = Array.from({ length: 9 }, (_, i) =>
      makeItem({
        title: `Item ${i}`,
        source: { kind: 'automation', automationId: `a${i}`, automationName: `Auto ${i}` },
      }),
    );
    const result = groupBySource(items);
    expect(result.groups).toHaveLength(0);
    expect(result.ungrouped).toHaveLength(9);
  });

  it('creates multiple groups for different sources', () => {
    const autoA = Array.from({ length: 3 }, () =>
      makeItem({ source: { kind: 'automation', automationId: 'a', automationName: 'Alpha' } }),
    );
    const autoB = Array.from({ length: 2 }, () =>
      makeItem({ source: { kind: 'automation', automationId: 'b', automationName: 'Beta' } }),
    );
    const noSource = Array.from({ length: 4 }, () => makeItem());
    const items = [...autoA, ...autoB, ...noSource];

    const result = groupBySource(items);
    expect(result.groups).toHaveLength(2);
    expect(result.ungrouped).toHaveLength(4);
  });

  it('items without source go to ungrouped', () => {
    const items = Array.from({ length: 10 }, () => makeItem());
    const result = groupBySource(items);
    expect(result.ungrouped).toHaveLength(10);
    expect(result.groups).toHaveLength(0);
  });
});
