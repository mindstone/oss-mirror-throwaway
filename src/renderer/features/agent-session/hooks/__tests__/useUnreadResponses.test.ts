// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, setupFakeTimers, cleanupFakeTimers } from '@renderer/test-utils';
import { useUnreadResponses, UNREAD_RESPONSE_GRACE_MS } from '../useUnreadResponses';
import type { AgentSessionSummary } from '@shared/types';

/** Minimal valid AgentSessionSummary for testing. */
function makeSummary(overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary {
  return {
    id: 'session-1',
    title: 'Test Session',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resolvedAt: null,
    doneAt: null,
    starredAt: null,
    deletedAt: null,
    origin: 'manual',
    isCorrupted: false,
    preview: '',
    messageCount: 1,
    hasDraft: false,
    draftPreview: null,
    draftUpdatedAt: null,
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    ...overrides,
  };
}

describe('useUnreadResponses', () => {
  beforeEach(() => {
    setupFakeTimers();
  });

  afterEach(() => {
    cleanupFakeTimers();
  });

  it('does NOT mark unread immediately on busy→idle transition (grace period)', () => {
    const busySummary = makeSummary({ id: 'bg-1', isBusy: true, activeTurnId: 'turn-1' });
    const idleSummary = makeSummary({ id: 'bg-1', isBusy: false, activeTurnId: null });

    const { result, rerender, unmount } = renderHook(
      ({ summaries, currentId }: { summaries: AgentSessionSummary[]; currentId: string }) =>
        useUnreadResponses(summaries, currentId),
      { initialProps: { summaries: [busySummary], currentId: 'current-session' } },
    );

    // Transition busy→idle
    rerender({ summaries: [idleSummary], currentId: 'current-session' });

    // Should NOT be marked unread immediately
    expect(result.current.unreadSessionIds.has('bg-1')).toBe(false);
    unmount();
  });

  it('marks unread after grace period expires for genuine completion', () => {
    const busySummary = makeSummary({ id: 'bg-1', isBusy: true, activeTurnId: 'turn-1' });
    const idleSummary = makeSummary({ id: 'bg-1', isBusy: false, activeTurnId: null });

    const { result, rerender, unmount } = renderHook(
      ({ summaries, currentId }: { summaries: AgentSessionSummary[]; currentId: string }) =>
        useUnreadResponses(summaries, currentId),
      { initialProps: { summaries: [busySummary], currentId: 'current-session' } },
    );

    // Transition busy→idle
    rerender({ summaries: [idleSummary], currentId: 'current-session' });
    expect(result.current.unreadSessionIds.has('bg-1')).toBe(false);

    // Advance past the grace period
    act(() => {
      vi.advanceTimersByTime(UNREAD_RESPONSE_GRACE_MS + 10);
    });

    expect(result.current.unreadSessionIds.has('bg-1')).toBe(true);
    unmount();
  });

  it('cancels pending unread when session becomes busy again within grace period', () => {
    const busySummary = makeSummary({ id: 'bg-1', isBusy: true, activeTurnId: 'turn-1' });
    const idleSummary = makeSummary({ id: 'bg-1', isBusy: false, activeTurnId: null });
    const busyAgainSummary = makeSummary({ id: 'bg-1', isBusy: true, activeTurnId: 'turn-2' });

    const { result, rerender, unmount } = renderHook(
      ({ summaries, currentId }: { summaries: AgentSessionSummary[]; currentId: string }) =>
        useUnreadResponses(summaries, currentId),
      { initialProps: { summaries: [busySummary], currentId: 'current-session' } },
    );

    // busy→idle
    rerender({ summaries: [idleSummary], currentId: 'current-session' });

    // Advance partway (but not past grace period)
    act(() => {
      vi.advanceTimersByTime(UNREAD_RESPONSE_GRACE_MS / 2);
    });
    expect(result.current.unreadSessionIds.has('bg-1')).toBe(false);

    // Session becomes busy again (new turn started)
    rerender({ summaries: [busyAgainSummary], currentId: 'current-session' });

    // Advance past original grace period — should still NOT be unread
    act(() => {
      vi.advanceTimersByTime(UNREAD_RESPONSE_GRACE_MS);
    });
    expect(result.current.unreadSessionIds.has('bg-1')).toBe(false);
    unmount();
  });

  it('does not mark current session unread if user opens it before timer fires', () => {
    const busySummary = makeSummary({ id: 'bg-1', isBusy: true, activeTurnId: 'turn-1' });
    const idleSummary = makeSummary({ id: 'bg-1', isBusy: false, activeTurnId: null });

    const { result, rerender, unmount } = renderHook(
      ({ summaries, currentId }: { summaries: AgentSessionSummary[]; currentId: string }) =>
        useUnreadResponses(summaries, currentId),
      { initialProps: { summaries: [busySummary], currentId: 'current-session' } },
    );

    // busy→idle
    rerender({ summaries: [idleSummary], currentId: 'current-session' });

    // User opens the session before grace period expires
    rerender({ summaries: [idleSummary], currentId: 'bg-1' });

    // Advance past grace period
    act(() => {
      vi.advanceTimersByTime(UNREAD_RESPONSE_GRACE_MS + 10);
    });

    // Should NOT be marked unread — user already opened it
    expect(result.current.unreadSessionIds.has('bg-1')).toBe(false);
    unmount();
  });

  it('cleans up timers on unmount', () => {
    const busySummary = makeSummary({ id: 'bg-1', isBusy: true, activeTurnId: 'turn-1' });
    const idleSummary = makeSummary({ id: 'bg-1', isBusy: false, activeTurnId: null });

    const { rerender, unmount } = renderHook(
      ({ summaries, currentId }: { summaries: AgentSessionSummary[]; currentId: string }) =>
        useUnreadResponses(summaries, currentId),
      { initialProps: { summaries: [busySummary], currentId: 'current-session' } },
    );

    // busy→idle — starts a timer
    rerender({ summaries: [idleSummary], currentId: 'current-session' });

    // Unmount before timer fires
    unmount();

    // Advance time — should not throw or cause "state update on unmounted component"
    // (If timers weren't cleaned up, the setTimeout callback would fire)
    expect(() => {
      vi.advanceTimersByTime(UNREAD_RESPONSE_GRACE_MS + 100);
    }).not.toThrow();
  });

  it('excludes background kinds from unread while preserving foreground conversations and insights', () => {
    const busySummaries = [
      makeSummary({ id: 'automation-source-capture--manual-origin', origin: 'manual', isBusy: true, activeTurnId: 'turn-1' }),
      makeSummary({ id: 'meeting-analysis-1', origin: 'manual', isBusy: true, activeTurnId: 'turn-2' }),
      makeSummary({ id: 'use-case-discovery-1', origin: 'manual', isBusy: true, activeTurnId: 'turn-3' }),
      makeSummary({ id: 'conversation-1', origin: 'manual', isBusy: true, activeTurnId: 'turn-4' }),
      makeSummary({ id: 'automation-insight-1', origin: 'automation', isBusy: true, activeTurnId: 'turn-5' }),
    ];
    const idleSummaries = busySummaries.map((summary) => ({
      ...summary,
      isBusy: false,
      activeTurnId: null,
    }));

    const { result, rerender, unmount } = renderHook(
      ({ summaries, currentId }: { summaries: AgentSessionSummary[]; currentId: string }) =>
        useUnreadResponses(summaries, currentId),
      {
        initialProps: {
          summaries: busySummaries,
          currentId: 'current-session',
        },
      },
    );

    rerender({
      summaries: idleSummaries,
      currentId: 'current-session',
    });

    act(() => {
      vi.advanceTimersByTime(UNREAD_RESPONSE_GRACE_MS + 10);
    });

    expect(result.current.unreadSessionIds.has('automation-source-capture--manual-origin')).toBe(false);
    expect(result.current.unreadSessionIds.has('meeting-analysis-1')).toBe(false);
    expect(result.current.unreadSessionIds.has('use-case-discovery-1')).toBe(false);
    expect(result.current.unreadSessionIds.has('conversation-1')).toBe(true);
    expect(result.current.unreadSessionIds.has('automation-insight-1')).toBe(true);
    unmount();
  });

  it('cancels pending timer when session disappears from summaries', () => {
    const busySummary = makeSummary({ id: 'bg-1', isBusy: true, activeTurnId: 'turn-1' });
    const idleSummary = makeSummary({ id: 'bg-1', isBusy: false, activeTurnId: null });

    const { result, rerender, unmount } = renderHook(
      ({ summaries, currentId }: { summaries: AgentSessionSummary[]; currentId: string }) =>
        useUnreadResponses(summaries, currentId),
      { initialProps: { summaries: [busySummary], currentId: 'current-session' } },
    );

    // busy→idle
    rerender({ summaries: [idleSummary], currentId: 'current-session' });

    // Session disappears from summaries (deleted)
    rerender({ summaries: [], currentId: 'current-session' });

    // Advance past grace period
    act(() => {
      vi.advanceTimersByTime(UNREAD_RESPONSE_GRACE_MS + 10);
    });

    // Should NOT be marked unread — session is gone
    expect(result.current.unreadSessionIds.has('bg-1')).toBe(false);
    unmount();
  });

  it('clearUnread cancels pending timer and removes from unread set', () => {
    const busySummary = makeSummary({ id: 'bg-1', isBusy: true, activeTurnId: 'turn-1' });
    const idleSummary = makeSummary({ id: 'bg-1', isBusy: false, activeTurnId: null });

    const { result, rerender, unmount } = renderHook(
      ({ summaries, currentId }: { summaries: AgentSessionSummary[]; currentId: string }) =>
        useUnreadResponses(summaries, currentId),
      { initialProps: { summaries: [busySummary], currentId: 'current-session' } },
    );

    // busy→idle, then wait for grace period
    rerender({ summaries: [idleSummary], currentId: 'current-session' });
    act(() => {
      vi.advanceTimersByTime(UNREAD_RESPONSE_GRACE_MS + 10);
    });
    expect(result.current.unreadSessionIds.has('bg-1')).toBe(true);

    // Clear it
    act(() => {
      result.current.clearUnread('bg-1');
    });
    expect(result.current.unreadSessionIds.has('bg-1')).toBe(false);
    unmount();
  });
});
