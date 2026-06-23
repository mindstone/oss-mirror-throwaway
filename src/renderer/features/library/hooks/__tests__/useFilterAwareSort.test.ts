import { describe, expect, it } from 'vitest';
import {
  getDefaultSortForFilter,
  getSortOptionsForFilter,
  normalizeSortForFilter,
} from '../useFilterAwareSort';

describe('useFilterAwareSort helpers', () => {
  it('returns skills-specific sort options in cards view', () => {
    const options = getSortOptionsForFilter('skills', 'cards');
    expect(options.map((option) => option.value)).toEqual([
      'skill-suggested',
      'skill-most-used',
      'skill-most-polished',
      'name',
    ]);
    expect(getDefaultSortForFilter('skills', 'cards')).toBe('skill-suggested');
  });

  it('returns memory-specific sort options in cards view without search', () => {
    const options = getSortOptionsForFilter('memory', 'cards');
    expect(options.map((option) => option.value)).toEqual([
      'recent',
      'created',
      'name',
    ]);
    expect(getDefaultSortForFilter('memory', 'cards')).toBe('recent');
  });

  it('adds Most relevant for memory when a search query is active', () => {
    const options = getSortOptionsForFilter('memory', 'cards', 'invoice');
    expect(options.map((option) => option.value)).toEqual([
      'memory-relevance',
      'recent',
      'created',
      'name',
    ]);
  });

  it('returns file-level sort options in folders view', () => {
    const options = getSortOptionsForFilter('spaces', 'folders');
    expect(options.map((option) => option.value)).toEqual(['name', 'modified']);
  });

  it('normalizes unsupported sort values to the filter default', () => {
    expect(normalizeSortForFilter('recent', 'skills', 'cards')).toBe('skill-suggested');
    expect(normalizeSortForFilter('name', 'skills', 'cards')).toBe('name');
    expect(normalizeSortForFilter('memory-relevance', 'memory', 'cards')).toBe('recent');
    expect(normalizeSortForFilter('memory-relevance', 'memory', 'cards', 'invoice')).toBe(
      'memory-relevance',
    );
  });
});
