import { deriveContextPlaceholder, extractShortTopic } from '../deriveContextPlaceholder';
import type { DeriveContextPlaceholderItem } from '../deriveContextPlaceholder';

const base = (overrides: Partial<DeriveContextPlaceholderItem> = {}): DeriveContextPlaceholderItem => ({
  title: 'Test item',
  ...overrides,
});

describe('extractShortTopic', () => {
  it('strips "Meeting:" prefix', () => {
    expect(extractShortTopic('Meeting: Q2 planning session')).toBe('Q2 planning session');
  });

  it('strips "Meeting —" prefix (em-dash variant)', () => {
    expect(extractShortTopic('Meeting \u2014 Q2 roadmap')).toBe('Q2 roadmap');
  });

  it('strips "Follow up:" prefix', () => {
    expect(extractShortTopic('Follow up: vendor contract renewal')).toBe('vendor contract renewal');
  });

  it('takes text before a colon separator', () => {
    expect(extractShortTopic('Community events: Manchester, Newcastle, Leeds'))
      .toBe('Community events');
  });

  it('takes text before an em-dash separator', () => {
    expect(extractShortTopic('Liam iterating on approvals \u2014 review against your UX copy study'))
      .toBe('Liam iterating on approvals');
  });

  it('takes text before an en-dash separator', () => {
    expect(extractShortTopic('Budget review \u2013 Q3 forecast'))
      .toBe('Budget review');
  });

  it('truncates long titles at word boundary', () => {
    const long = 'Acme Corp partnership needs product brainstorm with Jordan';
    const result = extractShortTopic(long);
    expect(result.length).toBeLessThanOrEqual(28);
    expect(long.startsWith(result)).toBe(true);
    expect(result).not.toMatch(/\s$/);
  });

  it('returns short titles as-is', () => {
    expect(extractShortTopic('Fix login bug')).toBe('Fix login bug');
  });

  it('handles single-word titles', () => {
    expect(extractShortTopic('Hiring')).toBe('Hiring');
  });

  it('returns empty string for prefix-only titles', () => {
    expect(extractShortTopic('Meeting:')).toBe('');
  });
});

describe('deriveContextPlaceholder', () => {
  // ── Priority 1: clarifyingQuestion ────────────────────────────────────
  it('returns clarifyingQuestion when present', () => {
    expect(deriveContextPlaceholder(base({
      clarifyingQuestion: 'Should I include enterprise pricing?',
    }))).toBe('Should I include enterprise pricing?');
  });

  it('trims clarifyingQuestion whitespace', () => {
    expect(deriveContextPlaceholder(base({
      clarifyingQuestion: '  Formal or friendly tone?  ',
    }))).toBe('Formal or friendly tone?');
  });

  it('ignores whitespace-only clarifyingQuestion', () => {
    const result = deriveContextPlaceholder(base({ clarifyingQuestion: '   ' }));
    expect(result).not.toBe('');
    expect(result).toContain('\u201cTest item\u201d');
  });

  // ── Priority 2: draft items ───────────────────────────────────────────
  it('returns draft placeholder for items with drafts', () => {
    expect(deriveContextPlaceholder(base({
      draft: 'Dear Sarah, following up on our call...',
    }))).toBe('Any changes?');
  });

  it('ignores whitespace-only drafts', () => {
    const result = deriveContextPlaceholder(base({ draft: '  ' }));
    expect(result).not.toBe('Any changes?');
  });

  // ── Priority 3: universal topic-based placeholder ──────────────────────
  it('references topic for email items', () => {
    expect(deriveContextPlaceholder(base({
      title: 'Reply to Sarah about Q1 pricing',
      references: [{ kind: 'email' }],
    }))).toBe('Anything to add about \u201cReply to Sarah about Q1\u201d?');
  });

  it('references topic for meeting-action items', () => {
    expect(deriveContextPlaceholder(base({
      title: 'Community events: Manchester secured',
      category: 'meeting-action',
    }))).toBe('Anything to add about \u201cCommunity events\u201d?');
  });

  it('references topic for meeting source items', () => {
    expect(deriveContextPlaceholder(base({
      title: 'Discuss Q2 roadmap with team',
      source: { kind: 'meeting' },
    }))).toBe('Anything to add about \u201cDiscuss Q2 roadmap with team\u201d?');
  });

  it('references topic for follow-up items', () => {
    expect(deriveContextPlaceholder(base({
      title: 'Check in with design team',
      category: 'follow-up',
    }))).toBe('Anything to add about \u201cCheck in with design team\u201d?');
  });

  it('references topic for automation items', () => {
    expect(deriveContextPlaceholder(base({
      title: 'Weekly report generation',
      source: { kind: 'automation' },
    }))).toBe('Anything to add about \u201cWeekly report generation\u201d?');
  });

  it('references topic for uncategorized items', () => {
    expect(deriveContextPlaceholder(base({
      title: 'Prepare board deck for Friday',
    }))).toBe('Anything to add about \u201cPrepare board deck for\u201d?');
  });

  // ── Empty topic fallback ───────────────────────────────────────────────
  it('returns generic placeholder when topic extraction yields empty string', () => {
    const result = deriveContextPlaceholder(base({ title: 'Meeting:' }));
    expect(result).toBe('Anything Rebel should know?');
    expect(result).not.toContain('\u201c');
  });

  // ── Topic inclusion in all paths ──────────────────────────────────────
  it('includes quoted topic reference from title', () => {
    expect(deriveContextPlaceholder(base({
      title: 'Budget review: Q3 numbers',
      category: 'meeting-action',
    }))).toBe('Anything to add about \u201cBudget review\u201d?');
  });

  // ── clarifyingQuestion takes precedence over everything ───────────────
  it('prefers clarifyingQuestion over category/source hints', () => {
    expect(deriveContextPlaceholder(base({
      clarifyingQuestion: 'Include enterprise tier?',
      category: 'meeting-action',
      source: { kind: 'meeting' },
      references: [{ kind: 'email' }],
    }))).toBe('Include enterprise tier?');
  });

  it('prefers clarifyingQuestion over draft', () => {
    expect(deriveContextPlaceholder(base({
      clarifyingQuestion: 'Formal or casual?',
      draft: 'some draft content',
    }))).toBe('Formal or casual?');
  });
});
