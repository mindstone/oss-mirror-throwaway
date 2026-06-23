import { useMemo } from 'react';
import {
  buildQuestionBatchStates,
  extractAnsweredBatches,
  extractQuestionBatches,
  isQuestionBatchStale,
  type QuestionBatchState,
} from '@rebel/cloud-client';
import type { AgentEvent, AgentSession, AgentSessionSummary } from '@shared/types';
import { classifySessionKind, isAutomationSession } from '@shared/sessionKind';
import {
  getCurrentSessionEvents,
  useSessionStore,
  type PendingQuestionEventSnapshot,
} from '@renderer/features/agent-session/store/sessionStore';

export interface QuestionWaitingSessionSnapshot {
  id: string;
  title: string;
  origin?: AgentSession['origin'];
  eventsByTurn: Record<string, AgentEvent[]>;
}

export interface QuestionWaitingItem {
  id: string;
  timestamp: number;
  sessionId: string;
  groupTitle: string;
  sourceLabel: string;
  batch: QuestionBatchState['batch'];
  questionText: string;
}

function normalizeQuestionText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function resolveQuestionWaitingSourceLabel(
  sessionId: string,
  origin?: AgentSession['origin'],
): string {
  const kind = classifySessionKind(sessionId);
  if (isAutomationSession(sessionId) || kind === 'automation-insight') {
    return 'Automation';
  }
  if (origin === 'focus') {
    return 'Focus';
  }
  return 'Conversation';
}

export function buildQuestionWaitingItems(
  sessions: readonly QuestionWaitingSessionSnapshot[],
  dismissedQuestionBatchIdsBySessionId: Readonly<Record<string, readonly string[]>> = {},
): QuestionWaitingItem[] {
  const items: QuestionWaitingItem[] = [];

  for (const session of sessions) {
    const questionBatches = extractQuestionBatches(session.eventsByTurn, session.id);
    const answeredBatches = extractAnsweredBatches(session.eventsByTurn, session.id);
    const dismissedBatchIds = dismissedQuestionBatchIdsBySessionId[session.id];
    const states = buildQuestionBatchStates(questionBatches, answeredBatches, {
      dismissedBatchIds: dismissedBatchIds ? new Set(dismissedBatchIds) : undefined,
    });

    for (const state of states) {
      if (state.isAnswered || state.dismissed || !state.isApprovalClarification) {
        continue;
      }
      if (isQuestionBatchStale(state.batch, session.eventsByTurn)) {
        continue;
      }

      const firstQuestion = state.batch.questions[0];
      const questionText = firstQuestion
        ? normalizeQuestionText(firstQuestion.question)
        : 'Rebel needs one detail before continuing.';

      items.push({
        id: `question:${session.id}:${state.batch.turnId}:${state.batch.batchId}`,
        timestamp: state.batch.timestamp,
        sessionId: session.id,
        groupTitle: session.title,
        sourceLabel: resolveQuestionWaitingSourceLabel(session.id, session.origin),
        batch: state.batch,
        questionText,
      });
    }
  }

  return items.sort((first, second) => second.timestamp - first.timestamp);
}

function buildSessionSnapshots(args: {
  currentSessionId: string;
  currentSessionTitle: string;
  currentSessionOrigin: AgentSession['origin'] | undefined;
  currentEventsByTurn: Record<string, AgentEvent[]>;
  loadedSessions: ReadonlyMap<string, AgentSession>;
  pendingQuestionEventsBySessionId: Record<string, PendingQuestionEventSnapshot[]>;
  sessionSummaries: AgentSessionSummary[];
}): QuestionWaitingSessionSnapshot[] {
  const {
    currentSessionId,
    currentSessionTitle,
    currentSessionOrigin,
    currentEventsByTurn,
    loadedSessions,
    pendingQuestionEventsBySessionId,
    sessionSummaries,
  } = args;
  const summariesById = new Map(sessionSummaries.map((summary) => [summary.id, summary]));
  const snapshots: QuestionWaitingSessionSnapshot[] = [];

  if (currentSessionId) {
    snapshots.push({
      id: currentSessionId,
      title: currentSessionTitle,
      origin: currentSessionOrigin,
      eventsByTurn: currentEventsByTurn,
    });
  }

  for (const [sessionId, session] of loadedSessions) {
    if (sessionId === currentSessionId) {
      continue;
    }
    if (summariesById.get(sessionId)?.deletedAt != null) {
      continue;
    }

    snapshots.push({
      id: sessionId,
      title: session.title,
      origin: session.origin,
      eventsByTurn: session.eventsByTurn,
    });
  }

  for (const [sessionId, pendingEvents] of Object.entries(pendingQuestionEventsBySessionId)) {
    if (sessionId === currentSessionId || loadedSessions.has(sessionId)) {
      continue;
    }
    const summary = summariesById.get(sessionId);
    if (!summary || summary.deletedAt != null) {
      continue;
    }

    const eventsByTurn: Record<string, AgentEvent[]> = {};
    for (const { turnId, event } of pendingEvents) {
      eventsByTurn[turnId] = [...(eventsByTurn[turnId] ?? []), event];
    }

    snapshots.push({
      id: sessionId,
      title: summary.title ?? 'Untitled conversation',
      origin: summary.origin,
      eventsByTurn,
    });
  }

  return snapshots;
}

export function usePendingQuestionWaitingItems(): QuestionWaitingItem[] {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentSessionTitle = useSessionStore((state) => state.currentSessionTitle);
  const currentSessionOrigin = useSessionStore((state) => state.currentSessionOrigin);
  const eventsByTurnVersion = useSessionStore((state) => state.eventsByTurnVersion);
  const loadedSessions = useSessionStore((state) => state.loadedSessions);
  const pendingQuestionEventsBySessionId = useSessionStore((state) => state.pendingQuestionEventsBySessionId);
  const sessionSummaries = useSessionStore((state) => state.sessionSummaries);
  const dismissedQuestionBatchIdsBySessionId = useSessionStore(
    (state) => state.dismissedQuestionBatchIdsBySessionId,
  );

  const currentEventsByTurn = useMemo(() => {
    void eventsByTurnVersion;
    return getCurrentSessionEvents();
  }, [eventsByTurnVersion]);

  return useMemo(() => {
    const snapshots = buildSessionSnapshots({
      currentSessionId,
      currentSessionTitle,
      currentSessionOrigin,
      currentEventsByTurn,
      loadedSessions,
      pendingQuestionEventsBySessionId,
      sessionSummaries,
    });
    return buildQuestionWaitingItems(snapshots, dismissedQuestionBatchIdsBySessionId);
  }, [
    currentEventsByTurn,
    currentSessionId,
    currentSessionOrigin,
    currentSessionTitle,
    dismissedQuestionBatchIdsBySessionId,
    loadedSessions,
    pendingQuestionEventsBySessionId,
    sessionSummaries,
  ]);
}

export function usePendingQuestionWaitingCount(): number {
  return usePendingQuestionWaitingItems().length;
}
