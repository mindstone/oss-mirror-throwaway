import { describe, it, expect } from 'vitest';
import { classifyInboxTier, compareInboxPriority, looksLikeFyi, stripLeadingEmoji } from '../inboxTiers';
import type { InboxItem } from '@shared/types';

const makeItem = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: 'test-id',
  title: 'Quarterly review follow-up',
  text: '',
  addedAt: Date.now(),
  references: [],
  ...overrides,
});

// ─── classifyInboxTier ───────────────────────────────────────────────────────

describe('classifyInboxTier', () => {
  it('returns "act" when item has a non-empty draft', () => {
    expect(classifyInboxTier(makeItem({ draft: 'Here is my draft email' }))).toBe('act');
  });

  it('does NOT return "act" when draft is whitespace-only', () => {
    const tier = classifyInboxTier(makeItem({ draft: '   \n\t  ' }));
    expect(tier).not.toBe('act');
  });

  it('returns "act" when item has a clarifyingQuestion', () => {
    expect(classifyInboxTier(makeItem({ clarifyingQuestion: 'Which budget?' }))).toBe('act');
  });

  it('returns "act" when item is urgent', () => {
    expect(classifyInboxTier(makeItem({ urgent: true }))).toBe('act');
  });

  it('returns "act" when urgent even with FYI title (urgent escapes FYI)', () => {
    expect(classifyInboxTier(makeItem({ title: 'FYI: server status', urgent: true }))).toBe('act');
  });

  it('returns "act" when draft present even with FYI title (draft escapes FYI)', () => {
    expect(classifyInboxTier(makeItem({ title: 'FYI: weekly update', draft: 'Draft reply' }))).toBe('act');
  });

  it('returns "fyi" when important is explicitly false (low-importance items are informational)', () => {
    expect(classifyInboxTier(makeItem({ important: false }))).toBe('fyi');
  });

  it('returns "fyi" when title has FYI prefix', () => {
    expect(classifyInboxTier(makeItem({ title: 'FYI: new policy changes' }))).toBe('fyi');
  });

  it('returns "fyi" when title contains "context if needed"', () => {
    expect(classifyInboxTier(makeItem({ title: 'Budget context if needed for Q3' }))).toBe('fyi');
  });

  it('returns "fyi" for "heads up:" prefix', () => {
    expect(classifyInboxTier(makeItem({ title: 'Heads up: office closure' }))).toBe('fyi');
  });

  it('returns "fyi" for "no action needed" phrase', () => {
    expect(classifyInboxTier(makeItem({ title: 'Deployment complete — no action needed' }))).toBe('fyi');
  });

  it('returns "review" for a regular important item', () => {
    expect(classifyInboxTier(makeItem({ important: true }))).toBe('review');
  });

  it('returns "review" when important is undefined (default)', () => {
    expect(classifyInboxTier(makeItem({}))).toBe('review');
  });

  it('returns "fyi" for title with leading emoji followed by FYI phrase', () => {
    expect(classifyInboxTier(makeItem({ title: '📋 FYI: team schedule' }))).toBe('fyi');
  });
});

// ─── stripLeadingEmoji ───────────────────────────────────────────────────────

describe('stripLeadingEmoji', () => {
  it('strips leading emoji from a string', () => {
    expect(stripLeadingEmoji('📋 Team schedule')).toBe('Team schedule');
  });

  it('returns the string unchanged when no leading emoji', () => {
    expect(stripLeadingEmoji('Team schedule')).toBe('Team schedule');
  });

  it('handles empty string', () => {
    expect(stripLeadingEmoji('')).toBe('');
  });
});

// ─── looksLikeFyi ────────────────────────────────────────────────────────────

describe('looksLikeFyi', () => {
  it('returns true for FYI prefix', () => {
    expect(looksLikeFyi('fyi: status update', makeItem())).toBe(true);
  });

  it('returns false when item has a draft (action signal escapes)', () => {
    expect(looksLikeFyi('fyi: update', makeItem({ draft: 'reply' }))).toBe(false);
  });

  it('returns false when item is urgent (action signal escapes)', () => {
    expect(looksLikeFyi('fyi: update', makeItem({ urgent: true }))).toBe(false);
  });

  it('returns false when item has clarifyingQuestion', () => {
    expect(looksLikeFyi('fyi: update', makeItem({ clarifyingQuestion: 'Confirm?' }))).toBe(false);
  });

  it('returns false for a normal title with no FYI signals', () => {
    expect(looksLikeFyi('quarterly review follow-up', makeItem())).toBe(false);
  });
});

// ─── compareInboxPriority ────────────────────────────────────────────────────

describe('compareInboxPriority', () => {
  const NOW = 1_700_000_000_000;

  it('overdue dueBy sorts before future dueBy', () => {
    const overdue = makeItem({ dueBy: NOW - 3600_000 });
    const future = makeItem({ dueBy: NOW + 3600_000 });
    expect(compareInboxPriority(overdue, future, NOW)).toBeLessThan(0);
  });

  it('sooner future dueBy sorts before later future dueBy', () => {
    const sooner = makeItem({ dueBy: NOW + 1_000_000 });
    const later = makeItem({ dueBy: NOW + 5_000_000 });
    expect(compareInboxPriority(sooner, later, NOW)).toBeLessThan(0);
  });

  it('item with dueBy sorts before item with only relevantDate', () => {
    const withDueBy = makeItem({ dueBy: NOW + 3600_000 });
    const withRelevant = makeItem({ relevantDate: NOW + 3600_000 });
    expect(compareInboxPriority(withDueBy, withRelevant, NOW)).toBeLessThan(0);
  });

  it('future relevantDate sorts before past relevantDate', () => {
    const futureRelevant = makeItem({ relevantDate: NOW + 3600_000 });
    const pastRelevant = makeItem({ relevantDate: NOW - 3600_000 });
    expect(compareInboxPriority(futureRelevant, pastRelevant, NOW)).toBeLessThan(0);
  });

  it('past relevantDate sorts before item with only addedAt', () => {
    const pastRelevant = makeItem({ relevantDate: NOW - 3600_000 });
    const addedOnly = makeItem({ addedAt: NOW - 1000 });
    expect(compareInboxPriority(pastRelevant, addedOnly, NOW)).toBeLessThan(0);
  });

  it('more recent addedAt sorts before older addedAt', () => {
    const recent = makeItem({ addedAt: NOW - 1000 });
    const old = makeItem({ addedAt: NOW - 100_000 });
    expect(compareInboxPriority(recent, old, NOW)).toBeLessThan(0);
  });

  it('item with no dates (no addedAt) sorts last', () => {
    const withDate = makeItem({ addedAt: NOW - 5000 });
    const noDate = makeItem({ addedAt: 0 });
    expect(compareInboxPriority(withDate, noDate, NOW)).toBeLessThan(0);
  });

  it('recently overdue sorts before long-overdue (lower ms = higher priority)', () => {
    const recentlyOverdue = makeItem({ dueBy: NOW - 3600_000 });
    const longOverdue = makeItem({ dueBy: NOW - 7200_000 });
    expect(compareInboxPriority(recentlyOverdue, longOverdue, NOW)).toBeLessThan(0);
  });
});
