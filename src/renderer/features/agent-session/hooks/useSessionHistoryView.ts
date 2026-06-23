import { useCallback, useDeferredValue, useMemo, useRef } from "react";
import type {
  AgentTurnMessage,
  AgentEvent,
  AgentSessionSummary,
} from "@shared/types";
import type { AgentSessionSidebarEntry } from "../types";
import type { AgentSessionSidebarStatus } from "@renderer/constants";
import { createMessageSnippet } from "@renderer/utils/formatters";
import { deriveInteractionTimestamp } from "../utils/conversationState";
import { aggregateSessionUsage } from "@shared/utils/usageAggregator";
import { selectVisibleMessages, useSessionStore } from "../store";
import { isStaleEmptySession } from "../utils/filterSessionList";
import { isSessionActive } from "@rebel/shared";
import {
  classifySessionKind,
  isAutomationSession,
  isBackgroundConversationSession,
  isSidebarHiddenKind,
} from "@shared/sessionKind";
import { STALE_TURN_THRESHOLD_MS } from "@core/services/agentTurnReducer/runtime";

// Note: deriveInteractionTimestamp, aggregateSessionUsage, selectVisibleMessages are still used
// for the CURRENT session entry (which uses full session data, not summary)

export type UnresolvedSessionPill = {
  id: string;
  title: string;
  timestamp: number;
  isHistory: boolean;
};

import type { SessionTypeFilter } from "@shared/types";

type UseSessionHistoryViewOptions = {
  currentSessionId: string;
  currentSessionTitle: string;
  currentSessionResolvedAt: number | null;
  currentSessionDoneAt: number | null;
  currentSessionStarredAt: number | null;
  messages: AgentTurnMessage[];
  currentSessionOrigin:
    | "manual"
    | "automation"
    | "role"
    | "mcp-tool"
    | "inbound-trigger"
    | "plugin"
    | "focus"
    | "browser-extension"
    | "operator-personalisation";
  /** Lightweight session summaries for sidebar display (replaces full agentSessions) */
  sessionSummaries: AgentSessionSummary[];
  eventsByTurn: Record<string, AgentEvent[]>;
  activeTurnId: string | null;
  isBusy: boolean;
  error: string | null;
  /** Session type filter: 'all' (both), 'conversations' (manual only), 'automations' (automation only) */
  sessionTypeFilter: SessionTypeFilter;
  /** Time saved by session ID (in minutes) - optional for sidebar display */
  timeSavedBySession?: Record<string, number>;
  /** Session IDs that have pending coaching insights */
  coachingSessionIds?: Set<string>;
  /** Session IDs that have pending memory approval requests */
  memoryApprovalSessionIds?: Set<string>;
  /** Meeting companion metadata for current session (Bug 12 fix - show video icon) */
  currentSessionMeetingCompanion?: {
    meetingUrl: string;
    meetingTitle: string;
  } | null;
  /** Session IDs that have an unread response (completed while user wasn't viewing) */
  unreadSessionIds?: Set<string>;
};

export type SessionSections = {
  starredSessions: AgentSessionSidebarEntry[];
  activeSessions: AgentSessionSidebarEntry[];
  doneSessions: AgentSessionSidebarEntry[];
  deletedSessions: AgentSessionSidebarEntry[];
};

type UseSessionHistoryViewResult = {
  currentSessionSidebarEntry: AgentSessionSidebarEntry;
  sidebarEntries: AgentSessionSidebarEntry[];
  sections: SessionSections;
  unresolvedSessionPills: UnresolvedSessionPill[];
};

// Summary-tier liveness must use the same stale boundary as the projection.
export const SUMMARY_STALE_TURN_THRESHOLD_MS = STALE_TURN_THRESHOLD_MS;

const normalizeSessionOrigin = (
  origin: AgentSessionSummary["origin"] | undefined,
  sessionId: string,
): "manual" | "automation" | "focus" | "browser-extension" => {
  if (isAutomationSession(sessionId)) {
    return "automation";
  }
  if (origin === "focus") {
    return "focus";
  }
  if (origin === "browser-extension") {
    return "browser-extension";
  }

  return "manual";
};

export const deriveStatus = (
  isBusy: boolean,
  hasMessages: boolean,
  lastActivityAt?: number | null,
): AgentSessionSidebarStatus => {
  if (isBusy) {
    if (
      typeof lastActivityAt === "number" &&
      Date.now() - lastActivityAt > SUMMARY_STALE_TURN_THRESHOLD_MS
    ) {
      return hasMessages ? "ready" : "idle";
    }
    return "thinking";
  }
  if (hasMessages) {
    return "ready";
  }
  return "idle";
};

export const useSessionHistoryView = ({
  currentSessionId,
  currentSessionTitle,
  currentSessionResolvedAt,
  currentSessionDoneAt,
  currentSessionStarredAt,
  currentSessionOrigin,
  messages,
  sessionSummaries,
  eventsByTurn,
  activeTurnId,
  isBusy,
  error,
  sessionTypeFilter,
  timeSavedBySession,
  coachingSessionIds,
  memoryApprovalSessionIds,
  currentSessionMeetingCompanion,
  unreadSessionIds,
}: UseSessionHistoryViewOptions): UseSessionHistoryViewResult => {
  // Drafts are now persisted into AgentSessionSummary (hasDraft/draftPreview/draftUpdatedAt),
  // so history sidebar entries can be derived purely from sessionSummaries.
  //
  // For the CURRENT session, we still read the live draft so the preview updates while typing
  // without waiting for persistence.
  const currentDraftRaw = useSessionStore(
    (s) => s.draftsBySessionId[currentSessionId] ?? null,
  );
  const currentDraftDeferred = useDeferredValue(currentDraftRaw);

  /** Check if origin matches the current session type filter */
  const originMatchesFilter = useCallback(
    (
      sessionId: string,
      origin: "automation" | "manual" | "focus" | "browser-extension",
    ) => {
      if (sessionTypeFilter === "all") return true;
      if (sessionTypeFilter === "automations")
        return isAutomationSession(sessionId);
      return origin === "manual" || origin === "focus" || origin === "browser-extension"; // 'conversations'
    },
    [sessionTypeFilter],
  );

  const currentEntry = useMemo<AgentSessionSidebarEntry>(() => {
    const visibleMessages = selectVisibleMessages(messages);
    const lastMessage = visibleMessages[visibleMessages.length - 1];
    const firstMessage = visibleMessages[0];
    const hasMessages = visibleMessages.length > 0;
    const title = currentSessionTitle;
    const origin = normalizeSessionOrigin(currentSessionOrigin, currentSessionId);

    const hasDraft = Boolean(currentDraftRaw?.text?.trim());
    const isDraftOnly = !hasMessages && hasDraft;

    // For draft-only sessions, show draft preview; otherwise use normal preview logic
    const preview = error
      ? `Error: ${createMessageSnippet(error, 56)}`
      : hasMessages && lastMessage
        ? createMessageSnippet(lastMessage.text)
        : isDraftOnly && currentDraftDeferred?.text
          ? `Draft: ${createMessageSnippet(currentDraftDeferred.text, 50)}`
          : isBusy
            ? "Agent turn in progress…"
            : "Ready to help";

    const lastEventTimestamp =
      eventsByTurn[activeTurnId ?? ""]?.slice(-1)[0]?.timestamp;
    // Use Math.max(summary.updatedAt, message-derived) so the current entry's
    // sort key never lags either source. This keeps the current entry stable
    // across the current↔history transition (matching the value used when the
    // same session is in history, which is summary.updatedAt — possibly
    // event-bumped by processHistoryEvent and Math.max-guarded in
    // addOrUpdateHistorySession), while still bubbling the active session up
    // immediately when a fresher message arrives mid-turn.
    // See docs-private/investigations/260424_sidebar_reorders_on_selection.md.
    const messageDerivedTimestamp = deriveInteractionTimestamp(
      visibleMessages,
      typeof lastEventTimestamp === "number" ? lastEventTimestamp : Date.now(),
    );
    const currentSummary = sessionSummaries.find((s) => s.id === currentSessionId);
    const timestamp = currentSummary
      ? Math.max(currentSummary.updatedAt, messageDerivedTimestamp)
      : messageDerivedTimestamp;

    const currentCost = aggregateSessionUsage(eventsByTurn)?.costUsd;

    // For tooltip: first and last message previews (longer than inline preview)
    const firstMessagePreview = firstMessage
      ? createMessageSnippet(firstMessage.text, 200)
      : undefined;
    const lastMessagePreview =
      lastMessage && visibleMessages.length > 1
        ? createMessageSnippet(lastMessage.text, 200)
        : undefined;

    const timeSavedMinutes = timeSavedBySession?.[currentSessionId] ?? null;
    const hasCoaching = coachingSessionIds?.has(currentSessionId) ?? false;
    const hasPendingMemoryApproval =
      memoryApprovalSessionIds?.has(currentSessionId) ?? false;

    return {
      id: currentSessionId,
      title,
      preview,
      timestamp,
      status: deriveStatus(isBusy, hasMessages),
      isHistory: false,
      isCorrupted: false,
      isResolved: Boolean(currentSessionResolvedAt),
      resolvedAt: currentSessionResolvedAt,
      // Storage is `doneAt`; derived bool `isActive = doneAt == null` (deliberate
      // single inversion of the negative-state field, like `deletedAt`).
      // See docs/plans/260614_done-state-rename/PLAN.md.
      isActive: isSessionActive({ doneAt: currentSessionDoneAt }),
      isStarred: Boolean(currentSessionStarredAt),
      sortRank: -1,
      origin,
      totalCostUsd: currentCost || null,
      messageCount: messages.length,
      firstMessagePreview,
      lastMessagePreview,
      timeSavedMinutes,
      hasCoaching,
      hasPendingMemoryApproval,
      hasDraft,
      draftPreview:
        isDraftOnly && currentDraftDeferred?.text
          ? createMessageSnippet(currentDraftDeferred.text, 50)
          : undefined,
      isMeetingCompanion: Boolean(currentSessionMeetingCompanion), // Bug 12 fix
      hasUnreadResponse: false, // current session is always "read"
    } satisfies AgentSessionSidebarEntry;
  }, [
    activeTurnId,
    currentSessionId,
    currentSessionResolvedAt,
    currentSessionDoneAt,
    currentSessionStarredAt,
    currentSessionTitle,
    currentSessionOrigin,
    currentDraftRaw,
    currentDraftDeferred,
    error,
    eventsByTurn,
    isBusy,
    messages,
    sessionSummaries,
    timeSavedBySession,
    coachingSessionIds,
    memoryApprovalSessionIds,
    currentSessionMeetingCompanion,
  ]);

  const currentSessionKind = useMemo(
    () =>
      classifySessionKind(currentSessionId, {
        isCompanion: Boolean(currentSessionMeetingCompanion),
      }),
    [currentSessionId, currentSessionMeetingCompanion],
  );

  // Ref to hold latest sessionSummaries - updated on every render but doesn't trigger useMemo
  const sessionSummariesRef = useRef(sessionSummaries);
  sessionSummariesRef.current = sessionSummaries;

  // Stable signature for history sessions - includes most metadata fields so the
  // sidebar refreshes when they change, but elides per-event content. During an
  // active background turn, summary.updatedAt advances at most once per
  // SUMMARY_UPDATED_AT_THROTTLE_MS (~30s, see sessionStore.ts) — frequent enough
  // to keep deriveStatus's staleness check honest, infrequent enough
  // to avoid recomputation on every streaming event.
  // Draft presence is captured via draftPresenceSignature (primitive), not the full drafts map.
  const historySignature = useMemo(
    () =>
      sessionSummaries
        .map((s) => {
          return `${s.id}|${s.isBusy}|${s.activeTurnId ?? ""}|${s.lastActivityAt ?? 0}|${s.resolvedAt ?? 0}|${s.doneAt ?? 0}|${s.starredAt ?? 0}|${s.deletedAt ?? 0}|${s.title}|${s.lastError ?? ""}|${s.hasDraft ? 1 : 0}|${s.draftUpdatedAt ?? 0}|${s.updatedAt ?? 0}`;
        })
        .join("::"),
    [sessionSummaries],
  );

  const historySummaries = useMemo(() => {
    historySignature.length;
    return sessionSummariesRef.current;
  }, [historySignature]);

  const sidebarEntries = useMemo<AgentSessionSidebarEntry[]>(() => {
    const historyOrderMap = new Map<string, number>();
    historySummaries.forEach((summary, index) => {
      historyOrderMap.set(summary.id, index);
    });

    const entries: AgentSessionSidebarEntry[] = [];
    const currentOrigin = currentEntry.origin ?? "manual";
    const isCurrentEmpty =
      currentEntry.messageCount === 0 &&
      !currentEntry.hasDraft &&
      currentEntry.status !== "thinking";
    if (
      !isSidebarHiddenKind(currentSessionKind) &&
      originMatchesFilter(currentEntry.id, currentOrigin) &&
      !isCurrentEmpty
    ) {
      entries.push(currentEntry);
    }

    for (const summary of historySummaries) {
      if (summary.id === currentSessionId) {
        continue;
      }

      const normalizedOrigin = normalizeSessionOrigin(
        summary.origin,
        summary.id,
      );
      const summaryKind = classifySessionKind(summary.id, {
        isCompanion: Boolean(summary.meetingCompanion),
      });
      if (isSidebarHiddenKind(summaryKind)) {
        continue;
      }
      if (!originMatchesFilter(summary.id, normalizedOrigin)) {
        continue;
      }

      const historyHasMessages = summary.messageCount > 0;
      const status = deriveStatus(
        summary.isBusy,
        historyHasMessages,
        summary.lastActivityAt,
      );

      const hasDraft = summary.hasDraft;
      const isDraftOnly = !historyHasMessages && hasDraft;

      // For draft-only sessions, show draft preview; otherwise use summary's pre-computed preview
      const preview = summary.isCorrupted
        ? "Conversation data is corrupted"
        : summary.lastError
          ? `Error: ${createMessageSnippet(summary.lastError, 56)}`
          : isDraftOnly && summary.draftPreview
            ? `Draft: ${summary.draftPreview}`
            : summary.preview ||
              (status === "thinking"
                ? "Agent turn in progress…"
                : "No messages yet");

      // Use updatedAt from summary - it's already the most recent timestamp
      const timestamp = summary.updatedAt;

      entries.push({
        id: summary.id,
        title: summary.title ?? "Untitled",
        preview,
        timestamp,
        status,
        isHistory: true,
        isCorrupted: summary.isCorrupted,
        isResolved: Boolean(summary.resolvedAt),
        resolvedAt: summary.resolvedAt,
        // Single derivation point: storage is `doneAt`, derived `isActive`.
        isActive: isSessionActive(summary),
        isStarred: Boolean(summary.starredAt),
        isDeleted: Boolean(summary.deletedAt),
        deletedAt: summary.deletedAt,
        sortRank: historyOrderMap.get(summary.id) ?? Number.MAX_SAFE_INTEGER,
        origin: normalizedOrigin,
        totalCostUsd: summary.usage?.costUsd || null,
        messageCount: summary.messageCount,
        firstMessagePreview: summary.firstMessagePreview,
        lastMessagePreview: summary.lastMessagePreview,
        timeSavedMinutes: timeSavedBySession?.[summary.id] ?? null,
        hasCoaching: coachingSessionIds?.has(summary.id) ?? false,
        hasPendingMemoryApproval:
          memoryApprovalSessionIds?.has(summary.id) ?? false,
        hasDraft,
        draftPreview:
          isDraftOnly && summary.draftPreview
            ? summary.draftPreview
            : undefined,
        isMeetingCompanion: Boolean(summary.meetingCompanion),
        hasUnreadResponse: unreadSessionIds?.has(summary.id) ?? false,
      });
    }

    return entries
      .slice()
      .sort((a, b) => {
        // Active sessions first
        const aActive = Boolean(a.isActive);
        const bActive = Boolean(b.isActive);
        if (aActive !== bActive) {
          return aActive ? -1 : 1;
        }
        if (b.timestamp !== a.timestamp) {
          return b.timestamp - a.timestamp;
        }
        if ((a.sortRank ?? 0) !== (b.sortRank ?? 0)) {
          return (a.sortRank ?? 0) - (b.sortRank ?? 0);
        }
        return a.title.localeCompare(b.title);
      })
      .map(({ sortRank: _sortRank, ...rest }) => rest);
    // Note: historySignature replaces sessionSummaries as dependency - it only changes at turn
    // boundaries (isBusy, resolvedAt, doneAt, title, lastError, hasDraft changes), not during streaming tokens.
  }, [
    currentEntry,
    currentSessionKind,
    currentSessionId,
    timeSavedBySession,
    coachingSessionIds,
    memoryApprovalSessionIds,
    historySummaries,
    originMatchesFilter,
    unreadSessionIds,
  ]);

  const unresolvedPills = useMemo<UnresolvedSessionPill[]>(() => {
    const pills: UnresolvedSessionPill[] = [];

    const currentOrigin = currentEntry.origin ?? "manual";
    const isCurrentEmptyForPills =
      currentEntry.messageCount === 0 &&
      !currentEntry.hasDraft &&
      currentEntry.status !== "thinking";
    if (
      !isSidebarHiddenKind(currentSessionKind) &&
      !currentEntry.isResolved &&
      originMatchesFilter(currentEntry.id, currentOrigin) &&
      !isCurrentEmptyForPills
    ) {
      pills.push({
        id: currentEntry.id,
        title: currentEntry.title,
        timestamp: currentEntry.timestamp,
        isHistory: false,
      });
    }

    for (const summary of historySummaries) {
      const normalizedOrigin = normalizeSessionOrigin(
        summary.origin,
        summary.id,
      );
      const summaryKind = classifySessionKind(summary.id, {
        isCompanion: Boolean(summary.meetingCompanion),
      });
      if (isSidebarHiddenKind(summaryKind)) {
        continue;
      }
      if (!originMatchesFilter(summary.id, normalizedOrigin)) {
        continue;
      }
      // Skip resolved, corrupted, or deleted sessions
      if (
        summary.resolvedAt ||
        summary.isCorrupted ||
        summary.deletedAt != null
      ) {
        continue;
      }
      pills.push({
        id: summary.id,
        title: summary.title ?? "Untitled",
        timestamp: summary.updatedAt,
        isHistory: true,
      });
    }

    return pills.sort((a, b) => b.timestamp - a.timestamp);
    // Note: historySignature replaces sessionSummaries - resolvedAt and title are captured in signature
  }, [currentEntry, currentSessionKind, historySummaries, originMatchesFilter]);

  const sections = useMemo<SessionSections>(() => {
    // Filter out deleted sessions from main sections
    const nonDeleted = sidebarEntries.filter((entry) => !entry.isDeleted);
    // Active and Starred are mutually exclusive: starred conversations live
    // exclusively in the starred list, not in active (even though they're active, i.e. doneAt == null).
    const starredSessions = nonDeleted.filter((entry) => entry.isStarred);
    const activeSessions = nonDeleted.filter(
      (entry) =>
        entry.isActive &&
        !entry.isStarred &&
        !isStaleEmptySession(entry) &&
        !isBackgroundConversationSession(entry.id),
    );
    const doneSessions = nonDeleted.filter((entry) => !entry.isActive);
    // Deleted sessions go to trash
    const deletedSessions = sidebarEntries.filter((entry) => entry.isDeleted);
    return { starredSessions, activeSessions, doneSessions, deletedSessions };
  }, [sidebarEntries]);

  return useMemo(
    () => ({
      currentSessionSidebarEntry: currentEntry,
      sidebarEntries,
      sections,
      unresolvedSessionPills: unresolvedPills,
    }),
    [currentEntry, sidebarEntries, sections, unresolvedPills],
  );
};
