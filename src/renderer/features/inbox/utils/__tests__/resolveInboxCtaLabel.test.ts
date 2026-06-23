import { describe, expect, it } from 'vitest';
import { resolveInboxCtaLabel } from '../resolveInboxCtaLabel';
import type { InboxItem } from '@shared/types';

const createMockItem = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: 'test-id',
  title: 'Review quarterly results',
  text: 'Review the Q3 results from the finance team',
  references: [],
  addedAt: Date.now(),
  ...overrides,
});

describe('resolveInboxCtaLabel (renderer integration)', () => {
  it('uses Review regardless of draft presence', () => {
    const item = createMockItem({
      title: 'Draft reply to Sandra',
      draft: 'Follow-up email to Sarah',
    });
    expect(resolveInboxCtaLabel(item)).toBe('Review');
  });

  it('uses Review regardless of clarifyingQuestion', () => {
    const item = createMockItem({
      title: 'Prepare onboarding checklist',
      clarifyingQuestion: 'Formal or casual tone?',
    });
    expect(resolveInboxCtaLabel(item)).toBe('Review');
  });

  it('extracts verb from default mock title', () => {
    const item = createMockItem();
    expect(resolveInboxCtaLabel(item)).toBe('Review');
  });

  it('uses Review when title has no extractable verb', () => {
    const item = createMockItem({ title: 'Quarterly results overview' });
    expect(resolveInboxCtaLabel(item)).toBe('Review');
  });

  it('uses Review for noun-first title despite transcript source', () => {
    const item = createMockItem({
      title: 'Standup recording from Monday',
      source: { kind: 'text', label: 'transcript-analysis' },
    });
    expect(resolveInboxCtaLabel(item)).toBe('Review');
  });

  it('uses Review regardless of source kind', () => {
    const item = createMockItem({
      title: 'Fix the authentication bug',
      source: { kind: 'text', label: 'Onboarding Discovery' },
    });
    expect(resolveInboxCtaLabel(item)).toBe('Review');
  });

  it('uses Review when email references are present', () => {
    const item = createMockItem({
      title: 'Reply to James about Q3 results',
      references: [{ kind: 'email', threadId: 't1' }],
      draft: 'Re: meeting notes',
    });
    expect(resolveInboxCtaLabel(item)).toBe('Review');
  });

  it('uses Review for send-like titles', () => {
    const item = createMockItem({
      title: 'Send proposal to the client',
      references: [{ kind: 'email', threadId: 't1' }],
    });
    expect(resolveInboxCtaLabel(item)).toBe('Review');
  });

  it('uses Review for meeting-sourced items', () => {
    const item = createMockItem({
      title: 'Write follow-up notes',
      source: { kind: 'meeting', meetingTitle: 'Weekly standup' },
    });
    expect(resolveInboxCtaLabel(item)).toBe('Review');
  });

  it('extracts verb from title — automation source does not override', () => {
    const item = createMockItem({
      title: 'Review daily digest results',
      source: { kind: 'automation', automationId: 'a1', automationName: 'Daily digest' },
    });
    expect(resolveInboxCtaLabel(item)).toBe('Review');
  });

  it('returns actionLabel when set (automation override)', () => {
    const item = createMockItem({ actionLabel: 'Approve expense' });
    expect(resolveInboxCtaLabel(item)).toBe('Review');
  });
});
