// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@renderer/test-utils';
import { useSessionHistoryView } from '../useSessionHistoryView';
import { useSessionStore } from '../../store';
import type { AgentSessionSummary, AgentTurnMessage } from '@shared/types';

beforeEach(() => {
  vi.stubGlobal('window', {
    sessionsApi: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    agentApi: {
      stopTurn: vi.fn().mockResolvedValue(undefined),
    },
  });
  // Reset draft state so the hook reads no current draft.
  useSessionStore.setState({ draftsBySessionId: {} });
});

function makeSummary(overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary {
  return {
    id: 'sess-1',
    title: 'Test',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    resolvedAt: null,
    doneAt: null,
    starredAt: null,
    deletedAt: null,
    origin: 'manual',
    isCorrupted: false,
    preview: '',
    messageCount: 0,
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

function makeMessage(text: string, createdAt: number): AgentTurnMessage {
  return {
    id: `msg-${createdAt}`,
    turnId: 'turn-1',
    role: 'assistant',
    text,
    createdAt,
  };
}

function baseProps(overrides: {
  currentSessionId: string;
  messages: AgentTurnMessage[];
  sessionSummaries: AgentSessionSummary[];
}) {
  return {
    currentSessionTitle: 'Current',
    currentSessionResolvedAt: null,
    currentSessionDoneAt: null,
    currentSessionStarredAt: null,
    currentSessionOrigin: 'manual' as const,
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    error: null,
    sessionTypeFilter: 'all' as const,
    ...overrides,
  };
}

/**
 * Regression for docs-private/investigations/260424_sidebar_reorders_on_selection.md.
 *
 * The current entry's sort timestamp must equal the same session's history
 * sort timestamp (`summary.updatedAt`, possibly bumped by event handlers and
 * Math.max-guarded by addOrUpdateHistorySession). Otherwise selecting a
 * conversation visibly shifts its position.
 */
describe('useSessionHistoryView — current entry timestamp stability', () => {
  it('uses summary.updatedAt for the current entry when summary exists', () => {
    const summaryUpdatedAt = 1_700_000_500_000;
    const lastMessageAt = summaryUpdatedAt - 60_000; // older than the summary bump
    const sessionId = 'sess-A';

    const { result } = renderHook(() =>
      useSessionHistoryView(
        baseProps({
          currentSessionId: sessionId,
          messages: [makeMessage('hello', lastMessageAt)],
          sessionSummaries: [
            makeSummary({ id: sessionId, updatedAt: summaryUpdatedAt, messageCount: 1 }),
          ],
        }),
      ),
    );

    expect(result.current.currentSessionSidebarEntry.timestamp).toBe(summaryUpdatedAt);
  });

  it('falls back to message-derived timestamp when no summary exists yet', () => {
    const lastMessageAt = 1_700_000_700_000;
    const sessionId = 'sess-fresh';

    const { result } = renderHook(() =>
      useSessionHistoryView(
        baseProps({
          currentSessionId: sessionId,
          messages: [makeMessage('first', lastMessageAt)],
          sessionSummaries: [], // no summary yet (newly-created session)
        }),
      ),
    );

    expect(result.current.currentSessionSidebarEntry.timestamp).toBe(lastMessageAt);
  });

  it('prefers the newer of summary.updatedAt and last message timestamp', () => {
    // Scenario: a fresh message arrives mid-turn, AFTER processHistoryEvent's
    // turn-start summary bump. The current entry must reflect the newer
    // message so the active session bubbles up immediately, even though the
    // summary timestamp would otherwise lag.
    const summaryUpdatedAt = 1_700_000_500_000;
    const lastMessageAt = summaryUpdatedAt + 10_000;
    const sessionId = 'sess-mid-turn';

    const { result } = renderHook(() =>
      useSessionHistoryView(
        baseProps({
          currentSessionId: sessionId,
          messages: [makeMessage('streamed reply', lastMessageAt)],
          sessionSummaries: [
            makeSummary({ id: sessionId, updatedAt: summaryUpdatedAt, messageCount: 1 }),
          ],
        }),
      ),
    );

    expect(result.current.currentSessionSidebarEntry.timestamp).toBe(lastMessageAt);
  });

  it('excludes background-kind entries from active sections without changing done or user-initiated insight entries', () => {
    const currentMessageAt = 1_700_000_700_000;

    const { result } = renderHook(() =>
      useSessionHistoryView(
        baseProps({
          currentSessionId: 'current-session',
          messages: [makeMessage('current', currentMessageAt)],
          sessionSummaries: [
            makeSummary({
              id: 'automation-source-capture--abc123',
              title: 'Source Capture',
              updatedAt: 1_700_000_600_000,
              messageCount: 1,
              origin: 'automation',
              doneAt: null,
            }),
            makeSummary({
              id: 'automation-done--abc123',
              title: 'Done automation',
              updatedAt: 1_700_000_500_000,
              messageCount: 1,
              origin: 'automation',
              doneAt: 1_700_000_510_000,
            }),
            makeSummary({
              id: 'automation-insight-abc123',
              title: 'Automation insight',
              updatedAt: 1_700_000_400_000,
              messageCount: 1,
              origin: 'automation',
              doneAt: null,
            }),
          ],
        }),
      ),
    );

    expect(result.current.sections.activeSessions.map((entry) => entry.id))
      .toContain('automation-insight-abc123');
    expect(result.current.sections.activeSessions.map((entry) => entry.id))
      .not.toContain('automation-source-capture--abc123');
    expect(result.current.sections.doneSessions.map((entry) => entry.id))
      .toContain('automation-done--abc123');
  });
});
