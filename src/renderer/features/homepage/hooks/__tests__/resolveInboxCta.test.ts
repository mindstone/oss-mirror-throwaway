import { describe, expect, it } from 'vitest';
import { resolveInboxCta } from '../useTodayStream';
import { isTranscriptSource } from '@rebel/shared';
import type { InboxItem } from '@shared/types';

const createMockItem = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: 'test-id',
  title: 'Test Item',
  text: 'Test description',
  references: [],
  addedAt: Date.now(),
  ...overrides,
});

describe('resolveInboxCta', () => {
  // ------- Drafts still use the main "Review" CTA -------

  it('returns "Review" when item has a draft', () => {
    const item = createMockItem({ draft: 'Follow-up email to Sarah re: Q2 targets' });
    const result = resolveInboxCta(item);
    expect(result.label).toBe('Review');
    expect(result.prompt).toContain('draft');
  });

  it('returns "Review" when item has both draft and clarifyingQuestion', () => {
    const item = createMockItem({
      draft: 'Follow-up email draft',
      clarifyingQuestion: 'Formal or casual tone?',
    });
    expect(resolveInboxCta(item).label).toBe('Review');
  });

  it('returns "Review" when item has draft and transcript source', () => {
    const item = createMockItem({
      draft: 'Meeting summary draft',
      source: { kind: 'text', label: 'transcript-analysis' },
    });
    expect(resolveInboxCta(item).label).toBe('Review');
  });

  it('ignores whitespace-only drafts', () => {
    const item = createMockItem({ draft: '   ' });
    expect(resolveInboxCta(item).label).toBe('Review');
  });

  // ------- Clarifying questions still use the main "Review" CTA -------

  it('returns "Review" when item has a clarifyingQuestion', () => {
    const item = createMockItem({
      clarifyingQuestion: 'Want me to draft a proposal for analytics instrumentation?',
    });
    const result = resolveInboxCta(item);
    expect(result.label).toBe('Review');
    expect(result.prompt).toContain('Rebel\'s question');
  });

  it('returns "Review" for scope-type clarifying questions', () => {
    const item = createMockItem({
      clarifyingQuestion: 'Include enterprise tier pricing?',
    });
    expect(resolveInboxCta(item).label).toBe('Review');
  });

  it('returns "Review" for recipient-type clarifying questions', () => {
    const item = createMockItem({
      clarifyingQuestion: 'Send to ops-team Slack or email Sarah directly?',
    });
    expect(resolveInboxCta(item).label).toBe('Review');
  });

  it('returns "Review" even if source is a transcript', () => {
    const item = createMockItem({
      clarifyingQuestion: 'Formal or friendly tone?',
      source: { kind: 'text', label: 'transcript-analysis' },
    });
    expect(resolveInboxCta(item).label).toBe('Review');
  });

  // ------- Transcript sources still use the main "Review" CTA -------

  it('returns "Review" for transcript-analysis source', () => {
    const item = createMockItem({
      source: { kind: 'text', label: 'transcript-analysis' },
    });
    const result = resolveInboxCta(item);
    expect(result.label).toBe('Review');
    expect(result.prompt).toContain('Summarise');
  });

  it('returns "Review" for process-plaud-recording source', () => {
    const item = createMockItem({
      source: { kind: 'text', label: 'process-plaud-recording' },
    });
    expect(resolveInboxCta(item).label).toBe('Review');
  });

  it('returns "Review" for calendar-sync source (not a transcript)', () => {
    const item = createMockItem({
      source: { kind: 'text', label: 'calendar-sync' },
    });
    expect(resolveInboxCta(item).label).toBe('Review');
  });

  it('returns "Review" for Title Case variants of transcript sources', () => {
    const item = createMockItem({
      source: { kind: 'text', label: 'Transcript Analysis' },
    });
    expect(resolveInboxCta(item).label).toBe('Review');
  });

  // ------- Tier 4: Default → "Review" -------

  it('returns "Review" for a generic item with no special fields', () => {
    const item = createMockItem();
    const result = resolveInboxCta(item);
    expect(result.label).toBe('Review');
    expect(result.prompt).toContain('Review this action item');
  });

  it('returns "Review" for onboarding discovery items', () => {
    const item = createMockItem({
      source: { kind: 'text', label: 'Onboarding Discovery' },
    });
    expect(resolveInboxCta(item).label).toBe('Review');
  });

  it('returns "Review" for session coaching items', () => {
    const item = createMockItem({
      source: { kind: 'text', label: 'session-coaching-reflection' },
    });
    expect(resolveInboxCta(item).label).toBe('Review');
  });

  it('returns "Review" for wins-and-learnings items', () => {
    const item = createMockItem({
      source: { kind: 'text', label: 'wins-and-learnings-uncover' },
    });
    expect(resolveInboxCta(item).label).toBe('Review');
  });

  it('returns "Review" for items with workspace source', () => {
    const item = createMockItem({
      source: { kind: 'workspace', path: '/some/file.md' },
    });
    expect(resolveInboxCta(item).label).toBe('Review');
  });

  // ------- Prompt construction -------

  it('strips leading emoji from title in prompts', () => {
    const item = createMockItem({ title: '🔥 Urgent review needed' });
    const result = resolveInboxCta(item);
    expect(result.prompt).toContain('Urgent review needed');
    expect(result.prompt).not.toContain('🔥');
  });

  it('includes text snippet in prompt for non-draft items', () => {
    const item = createMockItem({ text: 'Greg raised the idea of adding more user feedback signals' });
    const result = resolveInboxCta(item);
    expect(result.prompt).toContain('Greg raised the idea');
  });
});

describe('isTranscriptSource', () => {
  it('returns true for transcript-analysis', () => {
    expect(isTranscriptSource('transcript-analysis')).toBe(true);
  });

  it('returns true for process-plaud-recording', () => {
    expect(isTranscriptSource('process-plaud-recording')).toBe(true);
  });

  it('is case-insensitive via slug normalisation', () => {
    expect(isTranscriptSource('Transcript Analysis')).toBe(true);
    expect(isTranscriptSource('PROCESS PLAUD RECORDING')).toBe(true);
  });

  it('returns false for non-transcript sources', () => {
    expect(isTranscriptSource('Onboarding Discovery')).toBe(false);
    expect(isTranscriptSource('wins-and-learnings-uncover')).toBe(false);
    expect(isTranscriptSource('session-coaching-reflection')).toBe(false);
    expect(isTranscriptSource('calendar-sync')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isTranscriptSource(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isTranscriptSource('')).toBe(false);
  });
});
