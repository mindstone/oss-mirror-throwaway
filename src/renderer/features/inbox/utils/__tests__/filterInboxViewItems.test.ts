import { describe, it, expect } from 'vitest';
import { filterInboxViewItems } from '../filterInboxViewItems';
import type { InboxItem } from '@shared/types';

const makeItem = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: crypto.randomUUID(),
  title: 'Test item',
  text: 'Some body text',
  addedAt: Date.now(),
  archived: false,
  references: [],
  ...overrides,
});

describe('filterInboxViewItems', () => {
  it('returns active (non-archived) items for active view', () => {
    const items = [
      makeItem({ archived: false }),
      makeItem({ archived: true }),
      makeItem({ status: 'executing', executingSessionId: crypto.randomUUID() }),
      makeItem({ archived: false }),
    ];
    const result = filterInboxViewItems(items, 'active', '', new Set());
    expect(result).toHaveLength(3);
    expect(result.every(i => !i.archived)).toBe(true);
  });

  it('returns archived items for archived view', () => {
    const items = [
      makeItem({ archived: false }),
      makeItem({ archived: true }),
    ];
    const result = filterInboxViewItems(items, 'archived', '', new Set());
    expect(result).toHaveLength(1);
    expect(result[0].archived).toBe(true);
  });

  it('excludes autoCompleted items in active view', () => {
    const items = [
      makeItem({ autoCompleted: true }),
      makeItem({ autoCompleted: false }),
      makeItem(),
    ];
    const result = filterInboxViewItems(items, 'active', '', new Set());
    expect(result).toHaveLength(2);
    expect(result.every(i => !i.autoCompleted)).toBe(true);
  });

  it('filters by search query across title, text, draft, and tags', () => {
    const items = [
      makeItem({ title: 'Send email to Alice' }),
      makeItem({ title: 'Other', text: 'contact Alice' }),
      makeItem({ title: 'Other', draft: 'Dear Alice' }),
      makeItem({ title: 'Other', tags: ['alice-related'] }),
      makeItem({ title: 'Unrelated item' }),
    ];
    const result = filterInboxViewItems(items, 'active', 'alice', new Set());
    expect(result).toHaveLength(4);
  });

  it('filters by selected tags', () => {
    const items = [
      makeItem({ tags: ['urgent', 'work'] }),
      makeItem({ tags: ['personal'] }),
      makeItem({ tags: undefined }),
    ];
    const result = filterInboxViewItems(items, 'active', '', new Set(['urgent']));
    expect(result).toHaveLength(1);
    expect(result[0].tags).toContain('urgent');
  });

  it('filters out wins/learnings items', () => {
    const items = [
      makeItem({ title: 'win: Closed a big deal' }),
      makeItem({ title: '🏆 Win: Another victory' }),
      makeItem({ title: 'learning: New insight' }),
      makeItem({ title: '🧠 Learning: Something useful' }),
      makeItem({ title: 'Regular item' }),
    ];
    const result = filterInboxViewItems(items, 'active', '', new Set());
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Regular item');
  });

  it('filters out coach-redirect prefixed items (insight, recap, summary, etc.)', () => {
    const items = [
      makeItem({ title: 'Insight: Team velocity increased 20%' }),
      makeItem({ title: 'Recap: Weekly standup highlights' }),
      makeItem({ title: 'Summary: Q1 performance review' }),
      makeItem({ title: 'Note: Design decision on dark mode' }),
      makeItem({ title: 'Context: Why we chose React over Vue' }),
      makeItem({ title: 'Highlight: Best demo of the quarter' }),
      makeItem({ title: 'Takeaway: Customer feedback session' }),
      makeItem({ title: 'Reflection: Sprint retrospective' }),
      makeItem({ title: 'Decision: Moving to TypeScript 5.5' }),
      makeItem({ title: 'Reply to Greg on Linear — versioning approach' }),
    ];
    const result = filterInboxViewItems(items, 'active', '', new Set());
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Reply to Greg on Linear — versioning approach');
  });

  it('filters out FYI items based on content patterns', () => {
    const items = [
      makeItem({ title: 'FYI: New office hours schedule' }),
      makeItem({ title: 'Heads up: Server maintenance tonight' }),
      makeItem({ title: 'Release notes — no action needed' }),
      makeItem({ title: 'Reply to Peter — check newsletter preview tab' }),
    ];
    const result = filterInboxViewItems(items, 'active', '', new Set());
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Reply to Peter — check newsletter preview tab');
  });

  it('keeps FYI items with prepared content (draft or clarifyingQuestion) but filters urgent-only FYIs', () => {
    const items = [
      makeItem({ title: 'FYI: Budget report attached', draft: 'Please review the attached budget report.' }),
      makeItem({ title: 'Heads up: Need your input', clarifyingQuestion: 'What do you think?' }),
      makeItem({ title: 'Just so you know — pipeline change', urgent: true }),
      makeItem({ title: 'FYI: Server migration completed', urgent: true }),
    ];
    const result = filterInboxViewItems(items, 'active', '', new Set());
    expect(result).toHaveLength(2);
    expect(result.map(i => i.title)).toEqual([
      'FYI: Budget report attached',
      'Heads up: Need your input',
    ]);
  });

  it('filters out non-actionable emoji items (celebrations and insights) without prepared content', () => {
    const items = [
      makeItem({ title: '🏆 8 issues closed in a single day — biggest clearance of the quarter' }),
      makeItem({ title: '🎉 Team hit 100% sprint completion' }),
      makeItem({ title: '⭐ Outstanding customer review' }),
      makeItem({ title: '💡 A fake progress bar creates more anxiety than an honest one' }),
      makeItem({ title: 'Fix skill versioning bug — creator name not showing' }),
    ];
    const result = filterInboxViewItems(items, 'active', '', new Set());
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Fix skill versioning bug — creator name not showing');
  });

  it('keeps trophy-emoji items that have prepared content (draft or clarifying question)', () => {
    const items = [
      makeItem({ title: '🏆 Celebrate team win — send congratulations', draft: 'Great work team!' }),
      makeItem({ title: '🏆 Pure celebration item' }),
    ];
    const result = filterInboxViewItems(items, 'active', '', new Set());
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('🏆 Celebrate team win — send congratulations');
  });

  it('filters trophy-emoji items even when marked urgent (urgency alone is not an action signal for wins)', () => {
    const items = [
      makeItem({ title: '🏆 8 issues closed in a single day', urgent: true }),
      makeItem({ title: '🏆 Team record with urgent draft', urgent: true, draft: 'Send congrats' }),
      makeItem({ title: 'Fix critical bug', urgent: true }),
    ];
    const result = filterInboxViewItems(items, 'active', '', new Set());
    expect(result).toHaveLength(2);
    expect(result.map(i => i.title)).toEqual([
      '🏆 Team record with urgent draft',
      'Fix critical bug',
    ]);
  });

  it('filters informational prefixes (look ahead, product idea, new, watch for)', () => {
    const items = [
      makeItem({ title: 'Look Ahead: Josh building custom Rebel core' }),
      makeItem({ title: 'Product idea: Surface colleague attribution in results' }),
      makeItem({ title: 'New: one-off automation requests now work in conversation' }),
      makeItem({ title: 'Watch for: June Swarm Week UK — hold dates' }),
      makeItem({ title: 'Fix critical production bug' }),
    ];
    const result = filterInboxViewItems(items, 'active', '', new Set());
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Fix critical production bug');
  });

  it('filters non-actionable items from done and archived views too', () => {
    const items = [
      makeItem({ title: 'Win: Big deal closed', status: 'completed' }),
      makeItem({ title: '🏆 Team record broken', status: 'completed' }),
      makeItem({ title: 'FYI: Office hours changed', status: 'dismissed' }),
      makeItem({ title: 'Completed real task', status: 'completed' }),
      makeItem({ title: 'Dismissed real task', status: 'dismissed' }),
    ];
    const done = filterInboxViewItems(items, 'done', '', new Set());
    expect(done).toHaveLength(1);
    expect(done[0].title).toBe('Completed real task');
    const dismissed = filterInboxViewItems(items, 'dismissed', '', new Set());
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0].title).toBe('Dismissed real task');
  });

  it('filters out wins-learnings automation sources', () => {
    const items = [
      makeItem({
        title: 'Weekly summary',
        source: { kind: 'automation', automationId: 'wl', automationName: 'wins-learnings' },
      }),
      makeItem({
        title: 'Share ROI alpha customer-comms leverage win',
        source: {
          kind: 'automation',
          automationId: 'automation-wins-learnings-uncover',
          automationName: 'Wins & Learnings Coach',
          label: 'Exec coach scan — 2026-05-18',
        },
      }),
      makeItem({
        title: 'Share learning: readiness trust blocks rollouts',
        source: {
          kind: 'automation',
          automationId: 'automation-wins-learnings-uncover--run',
          automationName: 'Wins and Learnings Uncover',
          label: 'Daily wins/learnings automation',
        },
      }),
      makeItem({ title: 'Keep this' }),
    ];
    const result = filterInboxViewItems(items, 'active', '', new Set());
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Keep this');
  });

  it('filters out wins-learnings text sources', () => {
    const items = [
      makeItem({
        title: 'Daily digest',
        source: { kind: 'text', label: 'wins and learnings digest' },
      }),
      makeItem({ title: 'Actionable item' }),
    ];
    const result = filterInboxViewItems(items, 'active', '', new Set());
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Actionable item');
  });

  it('uses status field when present (status takes precedence over archived)', () => {
    const items = [
      makeItem({ status: 'active' }),
      makeItem({ status: 'executing' }),
      makeItem({ status: 'completed' }),
      makeItem({ status: 'dismissed' }),
    ];
    const active = filterInboxViewItems(items, 'active', '', new Set());
    expect(active).toHaveLength(2);
    const archived = filterInboxViewItems(items, 'archived', '', new Set());
    expect(archived).toHaveLength(2);
  });

  it('filters done view (completed only)', () => {
    const items = [
      makeItem({ status: 'completed' }),
      makeItem({ status: 'dismissed' }),
      makeItem({ status: 'active' }),
    ];
    const done = filterInboxViewItems(items, 'done', '', new Set());
    expect(done).toHaveLength(1);
    expect(done[0].status).toBe('completed');
  });

  it('filters dismissed view (dismissed only)', () => {
    const items = [
      makeItem({ status: 'completed' }),
      makeItem({ status: 'dismissed' }),
      makeItem({ status: 'active' }),
    ];
    const dismissed = filterInboxViewItems(items, 'dismissed', '', new Set());
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0].status).toBe('dismissed');
  });

  it('falls back to archived boolean when status is absent', () => {
    const items = [
      makeItem({ archived: false }),
      makeItem({ archived: true }),
    ];
    const active = filterInboxViewItems(items, 'active', '', new Set());
    expect(active).toHaveLength(1);
    const archived = filterInboxViewItems(items, 'archived', '', new Set());
    expect(archived).toHaveLength(1);
  });

  it('combines search and tag filters', () => {
    const items = [
      makeItem({ title: 'Email Alice', tags: ['urgent'] }),
      makeItem({ title: 'Email Bob', tags: ['urgent'] }),
      makeItem({ title: 'Email Alice', tags: ['personal'] }),
    ];
    const result = filterInboxViewItems(items, 'active', 'alice', new Set(['urgent']));
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Email Alice');
    expect(result[0].tags).toContain('urgent');
  });
});
