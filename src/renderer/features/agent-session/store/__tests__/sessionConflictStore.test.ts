import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionConflictStore } from '../sessionConflictStore';

describe('useSessionConflictStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    useSessionConflictStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores a new active conflict by session id', () => {
    useSessionConflictStore.getState().markConflict({
      sessionId: 'session-1',
      conflictType: 'concurrent-edit',
      fields: ['title'],
      detectedAt: 100,
    });

    const entry = useSessionConflictStore.getState().conflictsBySessionId['session-1'];
    expect(entry).toMatchObject({
      sessionId: 'session-1',
      conflictType: 'concurrent-edit',
      fields: ['title'],
      detectedAt: 100,
      dismissedAt: null,
    });
  });

  it('dismisses an active conflict', () => {
    const store = useSessionConflictStore.getState();
    store.markConflict({ sessionId: 'session-1', conflictType: 'stale-metadata', fields: ['title'], detectedAt: 200 });
    store.dismissConflict('session-1');

    const entry = useSessionConflictStore.getState().conflictsBySessionId['session-1'];
    expect(entry?.dismissedAt).toBe(1_700_000_000_000);
  });

  it('does not reopen a dismissed conflict for duplicate/older signal', () => {
    const store = useSessionConflictStore.getState();
    store.markConflict({ sessionId: 'session-1', conflictType: 'stale-metadata', fields: ['title'], detectedAt: 300 });
    store.dismissConflict('session-1');
    const dismissedAt = useSessionConflictStore.getState().conflictsBySessionId['session-1']?.dismissedAt;

    store.markConflict({ sessionId: 'session-1', conflictType: 'stale-metadata', fields: ['doneAt'], detectedAt: 300 });
    const entry = useSessionConflictStore.getState().conflictsBySessionId['session-1'];

    expect(entry?.dismissedAt).toBe(dismissedAt);
    expect(entry?.fields).toEqual(['doneAt']);
  });

  it('reopens a dismissed conflict when a newer signal arrives', () => {
    const store = useSessionConflictStore.getState();
    store.markConflict({ sessionId: 'session-1', conflictType: 'stale-metadata', fields: ['title'], detectedAt: 300 });
    store.dismissConflict('session-1');

    store.markConflict({ sessionId: 'session-1', conflictType: 'stale-metadata', fields: ['doneAt'], detectedAt: 450 });
    const entry = useSessionConflictStore.getState().conflictsBySessionId['session-1'];

    expect(entry?.detectedAt).toBe(450);
    expect(entry?.dismissedAt).toBeNull();
    expect(entry?.fields).toEqual(['doneAt']);
  });

  it('clears conflicts for a session', () => {
    const store = useSessionConflictStore.getState();
    store.markConflict({ sessionId: 'session-1', conflictType: 'concurrent-edit', fields: ['title'], detectedAt: 500 });
    store.clearConflict('session-1');

    expect(useSessionConflictStore.getState().conflictsBySessionId['session-1']).toBeUndefined();
  });
});
