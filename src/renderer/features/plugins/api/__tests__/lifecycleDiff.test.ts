import { describe, it, expect } from 'vitest';
import { diffSessionLifecycle } from '../lifecycleDiff';
import type { AgentSessionSummary } from '@shared/ipc/schemas/sessions';

/** Minimal valid summary for testing — only fields the diff cares about */
function makeSummary(overrides: Partial<AgentSessionSummary> & { id: string }): AgentSessionSummary {
  return {
    title: 'Test Session',
    createdAt: 1000,
    updatedAt: 2000,
    resolvedAt: null,
    doneAt: null,
    starredAt: null,
    deletedAt: null,
    origin: 'manual',
    isCorrupted: false,
    preview: 'hello',
    messageCount: 1,
    isBusy: false,
    activeTurnId: null,
    lastError: null,
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
    hasDraft: false,
    draftPreview: null,
    draftUpdatedAt: null,
    ...overrides,
  };
}

describe('diffSessionLifecycle', () => {
  it('returns empty array when summaries are identical', () => {
    const summaries = [makeSummary({ id: 's1' }), makeSummary({ id: 's2' })];
    expect(diffSessionLifecycle(summaries, summaries)).toEqual([]);
  });

  it('returns empty array for both empty arrays', () => {
    expect(diffSessionLifecycle([], [])).toEqual([]);
  });

  it('ignores new sessions (handled by conversation:created)', () => {
    const prev = [makeSummary({ id: 's1' })];
    const next = [makeSummary({ id: 's1' }), makeSummary({ id: 's2' })];
    expect(diffSessionLifecycle(prev, next)).toEqual([]);
  });

  it('ignores removed sessions (no event for sessions disappearing)', () => {
    const prev = [makeSummary({ id: 's1' }), makeSummary({ id: 's2' })];
    const next = [makeSummary({ id: 's1' })];
    expect(diffSessionLifecycle(prev, next)).toEqual([]);
  });

  describe('conversation:deleted', () => {
    it('fires when deletedAt changes from null to non-null', () => {
      const prev = [makeSummary({ id: 's1', deletedAt: null })];
      const next = [makeSummary({ id: 's1', deletedAt: 9999 })];
      const events = diffSessionLifecycle(prev, next);
      expect(events).toEqual([{
        type: 'conversation:deleted',
        sessionId: 's1',
        payload: { sessionId: 's1', title: 'Test Session' },
      }]);
    });

    it('does NOT also fire conversation:updated for deletion', () => {
      const prev = [makeSummary({ id: 's1', deletedAt: null, title: 'A' })];
      const next = [makeSummary({ id: 's1', deletedAt: 9999, title: 'B' })];
      const events = diffSessionLifecycle(prev, next);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('conversation:deleted');
    });
  });

  describe('conversation:restored', () => {
    it('fires when deletedAt changes from non-null to null', () => {
      const prev = [makeSummary({ id: 's1', deletedAt: 9999 })];
      const next = [makeSummary({ id: 's1', deletedAt: null })];
      const events = diffSessionLifecycle(prev, next);
      expect(events).toEqual([{
        type: 'conversation:restored',
        sessionId: 's1',
        payload: { sessionId: 's1', title: 'Test Session' },
      }]);
    });

    it('does NOT also fire conversation:updated for restoration', () => {
      const prev = [makeSummary({ id: 's1', deletedAt: 9999, title: 'A' })];
      const next = [makeSummary({ id: 's1', deletedAt: null, title: 'B' })];
      const events = diffSessionLifecycle(prev, next);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('conversation:restored');
    });
  });

  describe('conversation:updated', () => {
    it('fires when title changes', () => {
      const prev = [makeSummary({ id: 's1', title: 'Old Title' })];
      const next = [makeSummary({ id: 's1', title: 'New Title' })];
      const events = diffSessionLifecycle(prev, next);
      expect(events).toEqual([{
        type: 'conversation:updated',
        sessionId: 's1',
        payload: { sessionId: 's1', title: 'New Title', changes: ['title'] },
      }]);
    });

    it('fires when doneAt changes', () => {
      const prev = [makeSummary({ id: 's1', doneAt: null })];
      const next = [makeSummary({ id: 's1', doneAt: 5000 })];
      const events = diffSessionLifecycle(prev, next);
      expect(events).toEqual([{
        type: 'conversation:updated',
        sessionId: 's1',
        payload: { sessionId: 's1', title: 'Test Session', changes: ['doneAt'] },
      }]);
    });

    it('fires when starredAt changes', () => {
      const prev = [makeSummary({ id: 's1', starredAt: null })];
      const next = [makeSummary({ id: 's1', starredAt: 6000 })];
      const events = diffSessionLifecycle(prev, next);
      expect(events).toEqual([{
        type: 'conversation:updated',
        sessionId: 's1',
        payload: { sessionId: 's1', title: 'Test Session', changes: ['starredAt'] },
      }]);
    });

    it('fires when resolvedAt changes', () => {
      const prev = [makeSummary({ id: 's1', resolvedAt: null })];
      const next = [makeSummary({ id: 's1', resolvedAt: 7000 })];
      const events = diffSessionLifecycle(prev, next);
      expect(events).toEqual([{
        type: 'conversation:updated',
        sessionId: 's1',
        payload: { sessionId: 's1', title: 'Test Session', changes: ['resolvedAt'] },
      }]);
    });

    it('includes multiple changed fields in changes array', () => {
      const prev = [makeSummary({ id: 's1', title: 'Old', doneAt: null, starredAt: null })];
      const next = [makeSummary({ id: 's1', title: 'New', doneAt: 5000, starredAt: 6000 })];
      const events = diffSessionLifecycle(prev, next);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({
        sessionId: 's1',
        title: 'New',
        changes: ['title', 'doneAt', 'starredAt'],
      });
    });

    it('does NOT fire for updatedAt-only changes', () => {
      const prev = [makeSummary({ id: 's1', updatedAt: 1000 })];
      const next = [makeSummary({ id: 's1', updatedAt: 2000 })];
      expect(diffSessionLifecycle(prev, next)).toEqual([]);
    });

    it('does NOT fire for isBusy transitions', () => {
      const prev = [makeSummary({ id: 's1', isBusy: false })];
      const next = [makeSummary({ id: 's1', isBusy: true })];
      expect(diffSessionLifecycle(prev, next)).toEqual([]);
    });

    it('does NOT fire for activeTurnId changes', () => {
      const prev = [makeSummary({ id: 's1', activeTurnId: null })];
      const next = [makeSummary({ id: 's1', activeTurnId: 'turn-1' })];
      expect(diffSessionLifecycle(prev, next)).toEqual([]);
    });

    it('does NOT fire for messageCount changes', () => {
      const prev = [makeSummary({ id: 's1', messageCount: 5 })];
      const next = [makeSummary({ id: 's1', messageCount: 10 })];
      expect(diffSessionLifecycle(prev, next)).toEqual([]);
    });

    it('does NOT fire for preview changes', () => {
      const prev = [makeSummary({ id: 's1', preview: 'old preview' })];
      const next = [makeSummary({ id: 's1', preview: 'new preview' })];
      expect(diffSessionLifecycle(prev, next)).toEqual([]);
    });

    it('does NOT fire for lastError changes', () => {
      const prev = [makeSummary({ id: 's1', lastError: null })];
      const next = [makeSummary({ id: 's1', lastError: 'Some error' })];
      expect(diffSessionLifecycle(prev, next)).toEqual([]);
    });
  });

  describe('multiple sessions', () => {
    it('emits events for multiple sessions changing simultaneously', () => {
      const prev = [
        makeSummary({ id: 's1', title: 'A' }),
        makeSummary({ id: 's2', deletedAt: null }),
        makeSummary({ id: 's3', deletedAt: 8000 }),
      ];
      const next = [
        makeSummary({ id: 's1', title: 'B' }),
        makeSummary({ id: 's2', deletedAt: 9000 }),
        makeSummary({ id: 's3', deletedAt: null }),
      ];
      const events = diffSessionLifecycle(prev, next);
      expect(events).toHaveLength(3);
      expect(events[0]).toEqual({
        type: 'conversation:updated',
        sessionId: 's1',
        payload: { sessionId: 's1', title: 'B', changes: ['title'] },
      });
      expect(events[1]).toEqual({
        type: 'conversation:deleted',
        sessionId: 's2',
        payload: { sessionId: 's2', title: 'Test Session' },
      });
      expect(events[2]).toEqual({
        type: 'conversation:restored',
        sessionId: 's3',
        payload: { sessionId: 's3', title: 'Test Session' },
      });
    });
  });

  describe('edge cases', () => {
    it('handles title changing to null', () => {
      const prev = [makeSummary({ id: 's1', title: 'Has Title' })];
      const next = [makeSummary({ id: 's1', title: null })];
      const events = diffSessionLifecycle(prev, next);
      expect(events).toEqual([{
        type: 'conversation:updated',
        sessionId: 's1',
        payload: { sessionId: 's1', title: null, changes: ['title'] },
      }]);
    });

    it('handles title changing from null to string', () => {
      const prev = [makeSummary({ id: 's1', title: null })];
      const next = [makeSummary({ id: 's1', title: 'New Title' })];
      const events = diffSessionLifecycle(prev, next);
      expect(events).toEqual([{
        type: 'conversation:updated',
        sessionId: 's1',
        payload: { sessionId: 's1', title: 'New Title', changes: ['title'] },
      }]);
    });

    it('handles reopening (doneAt going from value to null)', () => {
      const prev = [makeSummary({ id: 's1', doneAt: 5000 })];
      const next = [makeSummary({ id: 's1', doneAt: null })];
      const events = diffSessionLifecycle(prev, next);
      expect(events[0].payload).toEqual({
        sessionId: 's1',
        title: 'Test Session',
        changes: ['doneAt'],
      });
    });
  });
});
