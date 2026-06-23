import { describe, it, expect } from 'vitest';
import { fnvHashBase36, fnvHashHex } from '@rebel/shared';
import { buildDesktopSessionExcerpt, buildMobileSessionsIndex, normalizeCloudSessionSummaries } from '../sessionIndexTypes';

describe('diagnostics session index helpers', () => {
  it('builds desktop excerpts with raw ids and titles preserved', () => {
    const excerpt = buildDesktopSessionExcerpt({ id: 'raw-session', title: 'Raw Title', createdAt: 1, updatedAt: 2, messages: [], eventsByTurn: {} } as any);
    expect(excerpt.id).toBe('raw-session');
    expect(excerpt.title).toBe('Raw Title');
  });
  it('truncates and redacts desktop message previews', () => {
    const excerpt = buildDesktopSessionExcerpt({ id: 's', title: null, createdAt: 1, updatedAt: 2, messages: [{ id: 'm', role: 'user', text: `sk-ant-${'a'.repeat(30)}`, createdAt: 3 }], eventsByTurn: {} } as any);
    expect(excerpt.recentMessages[0].contentPreview).toContain('REDACTED');
    expect(excerpt.recentMessages[0].role).toBe('user');
  });
  it('aggregates desktop turn count and cost', () => {
    const excerpt = buildDesktopSessionExcerpt({ id: 's', title: null, createdAt: 1, updatedAt: 2, messages: [], eventsByTurn: { a: [{ type: 'result', usage: { costUsd: 0.5 } }], b: [{ type: 'result', usage: { costUsd: 0.25 } }] } } as any);
    expect(excerpt.turnCount).toBe(2);
    expect(excerpt.costUsd).toBe(0.75);
  });
  it('normalizes cloud session summaries and drops invalid entries', () => {
    expect(normalizeCloudSessionSummaries([{ id: 'a', updatedAt: 1, cloudUpdatedAt: 2, maxSeq: 3 }, { id: '', updatedAt: 1 }, { id: 'b', updatedAt: 'bad' }])).toEqual([{ id: 'a', updatedAt: 1, cloudUpdatedAt: 2, maxSeq: 3 }]);
  });
  it('sorts and hashes mobile sessions using base36 and derives isActive from doneAt', () => {
    // Active = doneAt null/absent; Done = doneAt non-null.
    const index = buildMobileSessionsIndex([
      { id: 'done', updatedAt: 1, doneAt: 5, deletedAt: null },
      { id: 'active', updatedAt: 2, cloudUpdatedAt: 3, doneAt: null, deletedAt: null },
    ]);
    // Sorted by (cloudUpdatedAt ?? updatedAt) desc → active first.
    expect(index.sessions[0]).toEqual(expect.objectContaining({ sessionIdHash: fnvHashBase36('active'), isActive: true, cloudUpdatedAt: 3 }));
    expect(index.sessions[1]).toEqual(expect.objectContaining({ sessionIdHash: fnvHashBase36('done'), isActive: false }));
  });
  it('limits mobile session index entries', () => {
    expect(buildMobileSessionsIndex(Array.from({ length: 60 }, (_, i) => ({ id: `s-${i}`, updatedAt: i, doneAt: null, deletedAt: null }))).sessions).toHaveLength(50);
  });
  it('exposes both hash variants without forcing parity', () => {
    expect(fnvHashHex('same-session')).toMatch(/^[a-f0-9]{8}$/);
    expect(fnvHashBase36('same-session')).not.toBe(fnvHashHex('same-session'));
  });
});
