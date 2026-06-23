import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { highlightText, findMatchingKeyword } from '../components/SettingsSearch';
import type { SearchEntry } from '../searchIndex';

describe('highlightText', () => {
  it('returns plain text when query is empty', () => {
    expect(highlightText('Cloud Sync', '')).toBe('Cloud Sync');
  });

  it('returns plain text when query does not match', () => {
    expect(highlightText('Cloud Sync', 'zebra')).toBe('Cloud Sync');
  });

  it('wraps matching substring in <mark>', () => {
    const node = highlightText('Cloud Sync', 'sync');
    const html = renderToString(createElement('span', null, node));
    expect(html).toMatch(/<mark[^>]*>Sync<\/mark>/);
  });

  it('preserves original casing in the highlighted text', () => {
    const node = highlightText('Font Size', 'font');
    const html = renderToString(createElement('span', null, node));
    expect(html).toMatch(/<mark[^>]*>Font<\/mark>/);
    expect(html).toContain(' Size');
  });

  it('highlights case-insensitively', () => {
    const node = highlightText('Rebel Core', 'REBEL');
    const html = renderToString(createElement('span', null, node));
    expect(html).toMatch(/<mark[^>]*>Rebel<\/mark>/);
  });

  it('highlights mid-word match', () => {
    const node = highlightText('Notifications', 'ific');
    const html = renderToString(createElement('span', null, node));
    expect(html).toContain('Not');
    expect(html).toMatch(/<mark[^>]*>ific<\/mark>/);
    expect(html).toContain('ations');
  });

  it('highlights only the first occurrence', () => {
    const node = highlightText('test test test', 'test');
    const html = renderToString(createElement('span', null, node));
    const markCount = (html.match(/<mark/g) ?? []).length;
    expect(markCount).toBe(1);
  });

  it('handles query matching entire text', () => {
    const node = highlightText('Theme', 'theme');
    const html = renderToString(createElement('span', null, node));
    expect(html).toMatch(/<mark[^>]*>Theme<\/mark>/);
  });
});

describe('findMatchingKeyword', () => {
  const entry: SearchEntry = {
    tab: 'system',
    section: 'appearance',
    label: 'Font Size',
    keywords: ['text too small', 'make text bigger', 'zoom'],
  };

  it('returns null when label contains the query', () => {
    expect(findMatchingKeyword(entry, 'font')).toBeNull();
  });

  it('returns null when label contains the query (case-insensitive)', () => {
    expect(findMatchingKeyword(entry, 'SIZE')).toBeNull();
  });

  it('returns matching keyword when label does not contain query', () => {
    expect(findMatchingKeyword(entry, 'too small')).toBe('text too small');
  });

  it('returns first matching keyword when multiple match', () => {
    expect(findMatchingKeyword(entry, 'text')).toBe('text too small');
  });

  it('returns null when nothing matches', () => {
    expect(findMatchingKeyword(entry, 'dark mode')).toBeNull();
  });

  it('handles entry with no keywords', () => {
    const bare: SearchEntry = { tab: 'system', label: 'Theme', keywords: [] };
    expect(findMatchingKeyword(bare, 'color')).toBeNull();
  });

  it('matches keyword substring', () => {
    expect(findMatchingKeyword(entry, 'zoom')).toBe('zoom');
  });

  it('is case-insensitive on keywords', () => {
    expect(findMatchingKeyword(entry, 'ZOOM')).toBe('zoom');
  });
});
