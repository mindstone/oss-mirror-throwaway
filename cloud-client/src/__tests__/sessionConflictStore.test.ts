import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionConflictStore } from '../stores/sessionConflictStore';

describe('useSessionConflictStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    useSessionConflictStore.getState().resetSessionConflicts();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records active conflict entries', () => {
    useSessionConflictStore.getState().markSessionConflict({
      sessionId: 'session-a',
      conflictType: 'concurrent-edit',
      fields: ['title'],
      detectedAt: 100,
    });

    expect(useSessionConflictStore.getState().conflictsBySessionId['session-a']).toMatchObject({
      sessionId: 'session-a',
      conflictType: 'concurrent-edit',
      fields: ['title'],
      detectedAt: 100,
      dismissedAt: null,
    });
  });

  it('dismisses and reopens on newer conflict signal', () => {
    const store = useSessionConflictStore.getState();
    store.markSessionConflict({ sessionId: 'session-a', conflictType: 'stale-metadata', fields: ['title'], detectedAt: 200 });
    store.dismissSessionConflict('session-a');
    expect(useSessionConflictStore.getState().conflictsBySessionId['session-a']?.dismissedAt).toBe(1_700_000_000_000);

    store.markSessionConflict({ sessionId: 'session-a', conflictType: 'stale-metadata', fields: ['doneAt'], detectedAt: 300 });
    expect(useSessionConflictStore.getState().conflictsBySessionId['session-a']).toMatchObject({
      dismissedAt: null,
      fields: ['doneAt'],
    });
  });

  it('does not reopen dismissed conflict on duplicate timestamp', () => {
    const store = useSessionConflictStore.getState();
    store.markSessionConflict({ sessionId: 'session-a', conflictType: 'stale-metadata', fields: ['title'], detectedAt: 250 });
    store.dismissSessionConflict('session-a');
    const dismissedAt = useSessionConflictStore.getState().conflictsBySessionId['session-a']?.dismissedAt;

    store.markSessionConflict({ sessionId: 'session-a', conflictType: 'stale-metadata', fields: ['doneAt'], detectedAt: 250 });
    expect(useSessionConflictStore.getState().conflictsBySessionId['session-a']).toMatchObject({
      dismissedAt,
      fields: ['doneAt'],
    });
  });

  it('clears conflict entries', () => {
    const store = useSessionConflictStore.getState();
    store.markSessionConflict({ sessionId: 'session-a', conflictType: 'concurrent-edit', fields: ['title'], detectedAt: 500 });
    store.clearSessionConflict('session-a');

    expect(useSessionConflictStore.getState().conflictsBySessionId['session-a']).toBeUndefined();
  });
});
