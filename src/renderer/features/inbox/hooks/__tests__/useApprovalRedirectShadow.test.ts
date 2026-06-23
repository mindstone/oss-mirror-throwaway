import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingApprovalItem } from '../usePendingApprovals';
import {
  DEFAULT_REDIRECT_AUTO_DISMISS_MS,
  _getApprovalRedirectShadowSnapshotForTests,
  _hasPendingAutoDismissTimerForTests,
  _resetApprovalRedirectShadowStore,
  beginApprovalRedirectSingleFlight,
  clearApprovalRedirectEntry,
  endApprovalRedirectSingleFlight,
  setApprovalRedirectEntry,
  type RedirectShadowItem,
} from '../useApprovalRedirectShadow';

function buildApproval(overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem {
  return {
    id: 'tool:shadow-test',
    type: 'tool',
    title: 'Session S',
    description: 'Rebel wants to run a tool',
    timestamp: Date.UTC(2026, 3, 18),
    sessionId: 'session-s',
    toolApproval: {
      toolUseID: 'tool-use-shadow',
      turnId: 'turn-shadow',
      toolName: 'browser_navigate',
      input: {},
    },
    ...overrides,
  };
}

function buildShadowItem(id: string, sessionId: string | null = 'session-s'): RedirectShadowItem {
  const approval = buildApproval({ id, sessionId });
  return {
    kind: 'approval',
    id: approval.id,
    timestamp: approval.timestamp,
    sessionId: approval.sessionId,
    groupTitle: approval.title,
    approval,
  };
}

describe('useApprovalRedirectShadow — module-scoped state helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetApprovalRedirectShadowStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetApprovalRedirectShadowStore();
  });

  it('stores a sent entry and auto-dismisses it after the default window (FM #15 / FM #20)', () => {
    const item = buildShadowItem('tool:auto-dismiss');

    setApprovalRedirectEntry(item, { status: 'sent', sessionId: 'session-s', at: Date.now() });

    // Entry is present before auto-dismiss fires
    expect(_getApprovalRedirectShadowSnapshotForTests().has(item.id)).toBe(true);
    expect(_hasPendingAutoDismissTimerForTests(item.id)).toBe(true);

    // Just before the dismiss window — still present
    vi.advanceTimersByTime(DEFAULT_REDIRECT_AUTO_DISMISS_MS - 1);
    expect(_getApprovalRedirectShadowSnapshotForTests().has(item.id)).toBe(true);

    // At the dismiss boundary — entry removed, timer cleared
    vi.advanceTimersByTime(1);
    expect(_getApprovalRedirectShadowSnapshotForTests().has(item.id)).toBe(false);
    expect(_hasPendingAutoDismissTimerForTests(item.id)).toBe(false);
  });

  it('preserves the shadow entry across the auto-dismiss window (simulated drawer unmount/remount)', () => {
    // The module-scoped Map is the mechanism that lets the drawer unmount and remount without
    // losing in-flight redirect state. Verifies plan FM #15.
    const item = buildShadowItem('tool:survives-remount');

    setApprovalRedirectEntry(item, { status: 'sent', sessionId: 'session-s', at: Date.now() });

    // Midway through the auto-dismiss window, the entry persists — a remount (new subscriber)
    // would read the same Map.
    vi.advanceTimersByTime(DEFAULT_REDIRECT_AUTO_DISMISS_MS / 2);
    const midSnapshot = _getApprovalRedirectShadowSnapshotForTests();
    expect(midSnapshot.has(item.id)).toBe(true);
    expect(midSnapshot.get(item.id)?.entry.status).toBe('sent');
  });

  it('does NOT schedule auto-dismiss for error entries (they stay until manually cleared)', () => {
    const item = buildShadowItem('tool:error-persists');

    setApprovalRedirectEntry(item, {
      status: 'error',
      sessionId: 'session-s',
      at: Date.now(),
      instruction: 'please retry',
      error: 'network',
    });

    expect(_getApprovalRedirectShadowSnapshotForTests().has(item.id)).toBe(true);
    expect(_hasPendingAutoDismissTimerForTests(item.id)).toBe(false);

    // Advance well beyond the default auto-dismiss window — error entry persists
    vi.advanceTimersByTime(DEFAULT_REDIRECT_AUTO_DISMISS_MS * 3);
    expect(_getApprovalRedirectShadowSnapshotForTests().has(item.id)).toBe(true);
    expect(_getApprovalRedirectShadowSnapshotForTests().get(item.id)?.entry.status).toBe('error');
  });

  it('does NOT schedule auto-dismiss for sending entries', () => {
    const item = buildShadowItem('tool:sending-persists');

    setApprovalRedirectEntry(item, { status: 'sending' });

    expect(_hasPendingAutoDismissTimerForTests(item.id)).toBe(false);

    vi.advanceTimersByTime(DEFAULT_REDIRECT_AUTO_DISMISS_MS * 2);
    expect(_getApprovalRedirectShadowSnapshotForTests().has(item.id)).toBe(true);
  });

  it('cancels a previous auto-dismiss timer when a new entry is set for the same id', () => {
    const item = buildShadowItem('tool:timer-reset');

    setApprovalRedirectEntry(item, { status: 'sent', sessionId: 'session-s', at: 1000 });
    expect(_hasPendingAutoDismissTimerForTests(item.id)).toBe(true);

    // Advance halfway, then replace the entry with a fresh sent entry. The original timer should be cancelled.
    vi.advanceTimersByTime(DEFAULT_REDIRECT_AUTO_DISMISS_MS / 2);
    setApprovalRedirectEntry(item, { status: 'sent', sessionId: 'session-s', at: 2000 });
    expect(_hasPendingAutoDismissTimerForTests(item.id)).toBe(true);

    // Advance to what WOULD have been the original expiry — new timer still pending, entry present
    vi.advanceTimersByTime(DEFAULT_REDIRECT_AUTO_DISMISS_MS / 2);
    expect(_getApprovalRedirectShadowSnapshotForTests().has(item.id)).toBe(true);

    // Advance the remaining time to fire the NEW timer
    vi.advanceTimersByTime(DEFAULT_REDIRECT_AUTO_DISMISS_MS / 2);
    expect(_getApprovalRedirectShadowSnapshotForTests().has(item.id)).toBe(false);
  });

  it('error-to-sent transition cancels the error persistence (replaces with a new sent timer)', () => {
    const item = buildShadowItem('tool:error-then-retry');

    setApprovalRedirectEntry(item, {
      status: 'error',
      sessionId: 'session-s',
      at: Date.now(),
      instruction: 'retry',
      error: 'net',
    });
    expect(_hasPendingAutoDismissTimerForTests(item.id)).toBe(false);

    // User clicks Retry; the result posts successfully → new sent entry
    setApprovalRedirectEntry(item, { status: 'sent', sessionId: 'session-s', at: Date.now() });
    expect(_hasPendingAutoDismissTimerForTests(item.id)).toBe(true);

    vi.advanceTimersByTime(DEFAULT_REDIRECT_AUTO_DISMISS_MS);
    expect(_getApprovalRedirectShadowSnapshotForTests().has(item.id)).toBe(false);
  });

  it('clearApprovalRedirectEntry removes the entry and cancels its auto-dismiss timer', () => {
    const item = buildShadowItem('tool:manual-clear');
    setApprovalRedirectEntry(item, { status: 'sent', sessionId: 'session-s', at: Date.now() });

    clearApprovalRedirectEntry(item.id);

    expect(_getApprovalRedirectShadowSnapshotForTests().has(item.id)).toBe(false);
    expect(_hasPendingAutoDismissTimerForTests(item.id)).toBe(false);

    // Auto-dismiss should not fire after manual clear
    vi.advanceTimersByTime(DEFAULT_REDIRECT_AUTO_DISMISS_MS * 2);
    expect(_getApprovalRedirectShadowSnapshotForTests().has(item.id)).toBe(false);
  });

  it('clearApprovalRedirectEntry for a missing id is a safe no-op', () => {
    expect(() => clearApprovalRedirectEntry('never-set-id')).not.toThrow();
    expect(_getApprovalRedirectShadowSnapshotForTests().size).toBe(0);
  });

  it('accepts a custom autoDismissMs option', () => {
    const item = buildShadowItem('tool:custom-dismiss');
    setApprovalRedirectEntry(
      item,
      { status: 'sent', sessionId: 'session-s', at: Date.now() },
      { autoDismissMs: 250 },
    );

    vi.advanceTimersByTime(249);
    expect(_getApprovalRedirectShadowSnapshotForTests().has(item.id)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(_getApprovalRedirectShadowSnapshotForTests().has(item.id)).toBe(false);
  });

  it('beginApprovalRedirectSingleFlight returns false for an in-flight id and true otherwise', () => {
    expect(beginApprovalRedirectSingleFlight('tool:busy')).toBe(true);
    expect(beginApprovalRedirectSingleFlight('tool:busy')).toBe(false);
    expect(beginApprovalRedirectSingleFlight('tool:other')).toBe(true);

    endApprovalRedirectSingleFlight('tool:busy');
    expect(beginApprovalRedirectSingleFlight('tool:busy')).toBe(true);

    endApprovalRedirectSingleFlight('tool:busy');
    endApprovalRedirectSingleFlight('tool:other');
  });

  it('_resetApprovalRedirectShadowStore clears entries, timers, and single-flight ids', () => {
    const item = buildShadowItem('tool:reset');
    setApprovalRedirectEntry(item, { status: 'sent', sessionId: 'session-s', at: Date.now() });
    beginApprovalRedirectSingleFlight(item.id);

    expect(_getApprovalRedirectShadowSnapshotForTests().has(item.id)).toBe(true);
    expect(_hasPendingAutoDismissTimerForTests(item.id)).toBe(true);

    _resetApprovalRedirectShadowStore();

    expect(_getApprovalRedirectShadowSnapshotForTests().size).toBe(0);
    expect(_hasPendingAutoDismissTimerForTests(item.id)).toBe(false);
    expect(beginApprovalRedirectSingleFlight(item.id)).toBe(true);
    endApprovalRedirectSingleFlight(item.id);

    // Advancing timers must not fire a stale callback on reset state
    vi.advanceTimersByTime(DEFAULT_REDIRECT_AUTO_DISMISS_MS * 2);
    expect(_getApprovalRedirectShadowSnapshotForTests().size).toBe(0);
  });

  it('produces a new Map reference on each mutation so useSyncExternalStore consumers detect change', () => {
    const item = buildShadowItem('tool:ref-change');

    const before = _getApprovalRedirectShadowSnapshotForTests();
    setApprovalRedirectEntry(item, { status: 'sent', sessionId: 'session-s', at: Date.now() });
    const afterSet = _getApprovalRedirectShadowSnapshotForTests();
    expect(afterSet).not.toBe(before);

    clearApprovalRedirectEntry(item.id);
    const afterClear = _getApprovalRedirectShadowSnapshotForTests();
    expect(afterClear).not.toBe(afterSet);
  });
});
