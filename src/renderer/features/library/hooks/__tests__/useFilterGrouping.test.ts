import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFilterGrouping } from '../useFilterGrouping';

describe('useFilterGrouping helpers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('groups skills by source', () => {
    const groups = getFilterGrouping('skills', [
      { id: '1', source: 'user' },
      { id: '2', source: 'built-in' },
      { id: '3', source: 'user' },
    ]);

    expect(groups.map((group) => group.label)).toEqual(['Your skills', 'Built-in']);
    expect(groups[0]?.entries).toHaveLength(2);
    expect(groups[1]?.entries).toHaveLength(1);
  });

  it('groups memory entries into today, this week, and earlier buckets', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-20T12:00:00.000Z'));
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const twoDays = 2 * 24 * oneHour;
    const tenDays = 10 * 24 * oneHour;
    const groups = getFilterGrouping('memory', [
      { id: 'today', createdAt: now - oneHour },
      { id: 'week', createdAt: now - twoDays },
      { id: 'earlier', createdAt: now - tenDays },
    ]);

    expect(groups.map((group) => group.label)).toEqual(['Today', 'This week', 'Earlier']);
    expect(groups[0]?.entries[0]?.id).toBe('today');
    expect(groups[1]?.entries[0]?.id).toBe('week');
    expect(groups[2]?.entries[0]?.id).toBe('earlier');
  });

  it('returns a flat group for spaces and everything', () => {
    const spacesGroups = getFilterGrouping('spaces', [{ id: 'space-1' }]);
    const everythingGroups = getFilterGrouping('everything', [{ id: 'file-1' }]);

    expect(spacesGroups).toHaveLength(1);
    expect(spacesGroups[0]?.collapsible).toBe(false);
    expect(everythingGroups).toHaveLength(1);
    expect(everythingGroups[0]?.collapsible).toBe(false);
  });
});
