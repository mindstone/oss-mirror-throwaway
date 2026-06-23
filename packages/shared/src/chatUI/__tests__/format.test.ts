import { describe, expect, it, vi } from 'vitest';
import { SHARED_CHAT_UI_COPY } from '../copy';
import {
  buildContextChipViewModel,
  buildEmptyStateViewModel,
  buildTimestampViewModel,
  formatRelativeTime,
  formatTimestampTitle,
  hostFromUrl,
} from '../format';

describe('chatUI format helpers', () => {
  it('derives compact relative timestamps for recent messages', () => {
    const now = 1_000_000;

    expect(formatRelativeTime(now - 30_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe('3h ago');
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago');
  });

  it('falls back to a locale date for older timestamps', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleDateString').mockReturnValue('Jan 8');

    expect(formatRelativeTime(0, 8 * 24 * 60 * 60_000)).toBe('Jan 8');

    spy.mockRestore();
  });

  it('formats timestamp titles through an injectable formatter and guards formatter failures', () => {
    expect(formatTimestampTitle(42, (date) => `stamp:${date.getTime()}`)).toBe('stamp:42');
    expect(
      formatTimestampTitle(42, () => {
        throw new Error('boom');
      }),
    ).toBe('');
  });

  it('builds timestamp view models with both relative and title labels', () => {
    expect(
      buildTimestampViewModel(60_000, 6 * 60_000, (date) => `title:${date.getTime()}`),
    ).toEqual({
      value: 60_000,
      relativeLabel: '5m ago',
      title: 'title:60000',
    });
  });

  it('matches the extension context-chip semantics for a titled page', () => {
    expect(
      buildContextChipViewModel({
        pageTitle: 'Quarterly planning',
        pageUrl: 'https://example.com/docs/quarterly-plan',
      }),
    ).toEqual({
      primaryText: 'Quarterly planning',
      secondaryText: 'https://example.com/docs/quarterly-plan',
      tooltip: 'https://example.com/docs/quarterly-plan',
      host: 'example.com',
      pageTitle: 'Quarterly planning',
      pageUrl: 'https://example.com/docs/quarterly-plan',
    });
  });

  it('matches the Office taskpane semantics for document fallback context', () => {
    expect(
      buildContextChipViewModel({
        fallbackTitle: 'This document',
      }),
    ).toEqual({
      primaryText: 'This document',
      tooltip: 'This document',
      host: '',
    });
  });

  it('builds shared empty-state models without forcing a single surface subtitle', () => {
    expect(
      buildEmptyStateViewModel({
        subtitle: "Ask about this document, ask me to draft something, or ask me anything else.",
        pageTitle: 'Quarterly Plan.docx',
        pageUrl: 'file:///Quarterly%20Plan.docx',
      }),
    ).toEqual({
      title: SHARED_CHAT_UI_COPY.emptyStateTitle,
      subtitle: "Ask about this document, ask me to draft something, or ask me anything else.",
      context: {
        primaryText: 'Quarterly Plan.docx',
        secondaryText: 'file:///Quarterly%20Plan.docx',
        tooltip: 'file:///Quarterly%20Plan.docx',
        host: '',
        pageTitle: 'Quarterly Plan.docx',
        pageUrl: 'file:///Quarterly%20Plan.docx',
      },
    });
  });

  it('extracts host labels from valid URLs and returns empty strings for invalid ones', () => {
    expect(hostFromUrl('https://sub.example.com/path')).toBe('sub.example.com');
    expect(hostFromUrl('not-a-url')).toBe('');
  });
});
