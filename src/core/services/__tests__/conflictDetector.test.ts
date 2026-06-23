import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentSession } from '@shared/types';
import {
  getConflictDetector,
  resetConflictDetectorForTests,
} from '../conflictDetector';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1',
    title: 'Title',
    createdAt: 1_000,
    updatedAt: 2_000,
    cloudUpdatedAt: 2_000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  resetConflictDetectorForTests();
});

describe('conflictDetector', () => {
  it('detects stale metadata updates using cloudUpdatedAt ordering', () => {
    const detector = getConflictDetector();
    const existing = makeSession({ title: 'Server title', cloudUpdatedAt: 5_000 });
    const incoming = makeSession({ title: 'Client title', cloudUpdatedAt: 4_000 });

    const result = detector.detectStaleMetadataConflict({
      existing,
      incoming,
      clientCloudUpdatedAt: 4_000,
      clientSeq: 10,
      serverSeq: 12,
    });

    expect(result.stale).toBe(true);
    expect(result.staleBy).toBe('cloudUpdatedAt');
    expect(result.changedFields).toContain('title');
    expect(result.reportedFields).toContain('title');
  });

  it('preserves stale metadata fields from existing session', () => {
    const detector = getConflictDetector();
    const existing = makeSession({ title: 'Server title', doneAt: 111 });
    const merged = makeSession({ title: 'Client title', doneAt: 222 });

    const preserved = detector.preserveStaleMetadataFields({
      merged,
      existing,
      changedFields: ['title', 'doneAt'],
    });

    expect(preserved.title).toBe('Server title');
    expect(preserved.doneAt).toBe(111);
  });

  it('does not revert local annotations when preserving stale metadata fields', () => {
    const detector = getConflictDetector();
    const existing = makeSession({
      annotations: [{
        id: 'ann-server',
        messageId: 'msg-1',
        text: 'old selection',
        comment: 'old comment',
        createdAt: 1_000,
        startOffset: 0,
        endOffset: 13,
      }],
    });
    const merged = makeSession({
      annotations: [{
        id: 'ann-local',
        messageId: 'msg-1',
        text: 'new selection',
        comment: 'new comment',
        createdAt: 2_000,
        startOffset: 4,
        endOffset: 17,
      }],
    });

    const preserved = detector.preserveStaleMetadataFields({
      merged,
      existing,
      changedFields: ['annotations'],
    });

    expect(preserved.annotations).toEqual(merged.annotations);
  });

  it('detects concurrent metadata edits from different sources within 10 seconds', () => {
    const detector = getConflictDetector();
    const baseline = makeSession({ title: 'Original' });
    const desktop = makeSession({ title: 'Desktop change' });
    const mobile = makeSession({ title: 'Mobile change' });

    const first = detector.recordWriteAndDetectConcurrentConflict({
      sessionId: 'session-1',
      source: 'desktop',
      surface: 'desktop',
      changedFields: ['title'],
      previous: baseline,
      next: desktop,
      now: 1_000,
    });
    expect(first.hasConflict).toBe(false);

    const second = detector.recordWriteAndDetectConcurrentConflict({
      sessionId: 'session-1',
      source: 'mobile',
      surface: 'mobile',
      changedFields: ['title'],
      previous: desktop,
      next: mobile,
      now: 6_000,
    });
    expect(second.hasConflict).toBe(true);
    expect(second.reportedFields).toContain('title');
    expect(second.fieldConflicts[0]).toMatchObject({
      field: 'title',
      previousValue: 'Desktop change',
      newValue: 'Mobile change',
    });
  });

  it('does not detect concurrent conflict outside the 10 second window', () => {
    const detector = getConflictDetector();
    const baseline = makeSession({ title: 'Original' });
    const desktop = makeSession({ title: 'Desktop change' });
    const mobile = makeSession({ title: 'Mobile change' });

    detector.recordWriteAndDetectConcurrentConflict({
      sessionId: 'session-1',
      source: 'desktop',
      surface: 'desktop',
      changedFields: ['title'],
      previous: baseline,
      next: desktop,
      now: 1_000,
    });

    const second = detector.recordWriteAndDetectConcurrentConflict({
      sessionId: 'session-1',
      source: 'mobile',
      surface: 'mobile',
      changedFields: ['title'],
      previous: desktop,
      next: mobile,
      now: 12_000,
    });
    expect(second.hasConflict).toBe(false);
  });

  it('excludes turn-progress fields (usage, memoryUpdateStatusByTurn) from metadata change detection', () => {
    const detector = getConflictDetector();
    const existing = makeSession({
      cloudUpdatedAt: 5_000,
    }) as AgentSession & { usage: unknown; memoryUpdateStatusByTurn: unknown };
    (existing as unknown as Record<string, unknown>).usage = { costUsd: 0.01, inputTokens: 100, outputTokens: 50, turnCount: 1 };
    (existing as unknown as Record<string, unknown>).memoryUpdateStatusByTurn = { 'turn-1': 'completed' };

    const incoming = makeSession({
      cloudUpdatedAt: 4_000,
    }) as AgentSession & { usage: unknown; memoryUpdateStatusByTurn: unknown };
    (incoming as unknown as Record<string, unknown>).usage = { costUsd: 0.05, inputTokens: 500, outputTokens: 200, turnCount: 2 };
    (incoming as unknown as Record<string, unknown>).memoryUpdateStatusByTurn = { 'turn-1': 'completed', 'turn-2': 'completed' };

    const result = detector.detectStaleMetadataConflict({
      existing,
      incoming,
      clientCloudUpdatedAt: 4_000,
      clientSeq: null,
      serverSeq: 0,
    });

    // Usage-only changes should not trigger stale conflict
    expect(result.stale).toBe(false);
    expect(result.changedFields).toHaveLength(0);
  });
});
