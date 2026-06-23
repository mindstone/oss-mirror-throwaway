/**
 * Shared internal agent turn submission service.
 *
 * Canonical turn-submission/persistence flow used by cloud callers and
 * future cross-surface submitters.
 */

import { createId } from '@shared/utils/id';
import type {
  AgentEvent,
  AgentSession,
  AgentTurnMessage,
  AgentTurnRequest,
  AppSettings,
} from '@shared/types';
import { updateConversationWithEvent, type ConversationStateShape } from '@shared/utils/conversationState';
import { deduplicateMessages } from '@core/services/sessionMergeUtils';
import { processAutoTitle, isDefaultOrFallbackTitle } from '@core/services/conversationTitleService';
import { classifySessionKind, fixedTitleForKind, hasFixedTitle } from '@shared/sessionKind';
import { markSessionAsCloudActive } from '@core/services/cloudContinuityStateService';
import { buildConversationPush } from '@shared/schemas/pushNotifications';
import { getMaxSeqFromSession, getSessionSeqIndex, stampEventSeq } from '@core/services/continuity/sessionSeqIndex';
import { getSessionTombstoneStore } from '@core/services/continuity/sessionTombstoneStore';
import { stampCloudUpdatedAt } from '@core/services/continuity/serverClock';
import { getSessionMutex, SessionMutexDeadlockError } from '@core/services/sessionMutex';
import { TRANSCRIPT_UNAVAILABLE_INSTRUCTION } from '@shared/constants/meetingTranscriptDisclaimer';
import { hashSessionId } from '@shared/trackingTypes';
import { createScopedLogger } from '@core/logger';
import { getBroadcastService } from '@core/broadcastService';
import { getPushNotificationSink } from '@core/pushNotificationSink';
import type { EventWindow } from '@core/types';
import type { AgentTurnServiceDeps, StartAgentTurnResult } from '@core/services/agentTurnService';
import { getOriginForExternalContext } from '@rebel/shared';
import { fireAndForget } from '@shared/utils/fireAndForget';

const scopedLogger = createScopedLogger({ service: 'agentTurnSubmissionService' });

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function log(entry: { level: LogLevel; msg: string; [key: string]: unknown }): void {
  const { level, msg, ...data } = entry;
  switch (level) {
    case 'debug':
      scopedLogger.debug(data, msg);
      break;
    case 'info':
      scopedLogger.info(data, msg);
      break;
    case 'warn':
      scopedLogger.warn(data, msg);
      break;
    case 'error':
      scopedLogger.error(data, msg);
      break;
    default: {
      const exhaustive: never = level;
      void exhaustive;
    }
  }
}

export const TURN_CHECKPOINT_INTERVAL_MS = 30_000;
export const TURN_CHECKPOINT_TOOL_RESULT_THRESHOLD = 20;

const TRANSCRIPT_UNAVAILABLE_LOG_WINDOW_MS = 5 * 60 * 1000;
const transcriptUnavailableLogRateLimit = new Map<string, number>();
const sessionMutex = getSessionMutex();

export type TranscriptContextResult =
  | { kind: 'context'; text: string }
  | { kind: 'unknown-session'; reason: 'no-meeting-id' | 'no-engine-state' }
  | { kind: 'empty-transcript' };

export interface BuildMeetingTranscriptContextArgs {
  meetingSessionId?: string;
  recordingActive?: boolean;
}

type BuildMeetingTranscriptContext = (
  args: BuildMeetingTranscriptContextArgs,
) => TranscriptContextResult | null;

export interface AgentTurnSubmissionEnvironment {
  eventWindow: EventWindow | null;
  getConnectedClientCount: () => number;
  buildMeetingTranscriptContext: BuildMeetingTranscriptContext;
}

const defaultAgentTurnSubmissionEnvironment: AgentTurnSubmissionEnvironment = {
  eventWindow: null,
  getConnectedClientCount: () => 0,
  buildMeetingTranscriptContext: () => null,
};

let agentTurnSubmissionEnvironment: AgentTurnSubmissionEnvironment = defaultAgentTurnSubmissionEnvironment;

export function setAgentTurnSubmissionEnvironment(
  updates: Partial<AgentTurnSubmissionEnvironment>,
): void {
  agentTurnSubmissionEnvironment = {
    ...agentTurnSubmissionEnvironment,
    ...updates,
  };
}

export function resetAgentTurnSubmissionEnvironmentForTesting(): void {
  agentTurnSubmissionEnvironment = defaultAgentTurnSubmissionEnvironment;
}

function getAgentTurnSubmissionEnvironment(): AgentTurnSubmissionEnvironment {
  return agentTurnSubmissionEnvironment;
}

type TurnEventListener = (event: AgentEvent) => void | Promise<void>;

function invokeTurnEventListener(
  listener: TurnEventListener,
  event: AgentEvent,
): void {
  try {
    const result = listener(event);
    if (result && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).catch((err) => {
        log({
          level: 'warn',
          msg: 'Turn event listener rejected',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch (err) {
    log({
      level: 'warn',
      msg: 'Turn event listener threw',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface AgentTurnSubmissionDeps {
  startAgentTurn: (
    deps: AgentTurnServiceDeps,
    request: AgentTurnRequest,
    win: EventWindow | null,
  ) => StartAgentTurnResult;
  subscribeTurnEvents: (turnId: string, listener: (event: AgentEvent) => void) => () => void;
  agentTurnServiceDeps: AgentTurnServiceDeps;
  getSession: (id: string) => Promise<AgentSession | null>;
  upsertSession: (session: AgentSession) => Promise<void>;
  getSettings: () => AppSettings;
}

export interface SubmitAgentTurnInternalInput {
  deps: AgentTurnSubmissionDeps;
  request: AgentTurnRequest;
}

export interface SubmitAgentTurnInternalCompletion {
  outcome: 'result' | 'error';
  persisted: boolean;
  persistenceError?: string;
}

export interface SubmitAgentTurnInternalResult {
  turnId: string;
  sessionId: string;
  startup: Promise<void>;
  completion: Promise<SubmitAgentTurnInternalCompletion>;
  subscribe: (
    listener: TurnEventListener,
    options?: { replayBuffered?: boolean },
  ) => () => void;
}

/**
 * Thrown by {@link submitAgentTurnInternal} when a turn is submitted to a
 * session id the server has tombstoned (deleted). Mirrors the session-events
 * append/PUT tombstone gate (`runUnderSessionMutexWithTombstoneGate` →
 * `{ kind: 'tombstoned' }` → HTTP 410): a turn to a deleted id must NOT
 * silently create-and-persist a session, because session reads/lists filter
 * tombstoned ids — the persisted turn would be invisible to every client
 * (silent loss). Callers (the agent-turn WS route) surface this distinctly so
 * the client can recreate the conversation under a fresh, visible id.
 */
export class SessionTombstonedError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session "${sessionId}" has been deleted`);
    this.name = 'SessionTombstonedError';
    this.sessionId = sessionId;
  }
}

export function _resetTranscriptUnavailableRateLimitForTesting(): void {
  transcriptUnavailableLogRateLimit.clear();
}

function isCheckpointToolResultEvent(event: AgentEvent): boolean {
  if (event.type !== 'tool') return false;
  const stage = (event as { stage?: string }).stage;
  return stage === 'end' || stage === 'result';
}

function shouldLogTranscriptUnavailable(
  sessionIdHash: string,
  kind: TranscriptContextResult['kind'],
): boolean {
  const now = Date.now();
  const key = `${sessionIdHash}:${kind}`;
  const lastLoggedAt = transcriptUnavailableLogRateLimit.get(key);
  if (typeof lastLoggedAt === 'number' && now - lastLoggedAt < TRANSCRIPT_UNAVAILABLE_LOG_WINDOW_MS) {
    return false;
  }

  transcriptUnavailableLogRateLimit.set(key, now);

  for (const [cachedKey, loggedAt] of transcriptUnavailableLogRateLimit.entries()) {
    if (now - loggedAt > TRANSCRIPT_UNAVAILABLE_LOG_WINDOW_MS) {
      transcriptUnavailableLogRateLimit.delete(cachedKey);
    }
  }

  return true;
}

function stampSessionForPersistence(session: AgentSession): AgentSession {
  return stampCloudUpdatedAt({
    ...session,
    updatedAt: Date.now(),
    cloudUpdatedAt: undefined,
  });
}

function buildTriggerMessageFields(
  triggerMeta: AgentTurnRequest['triggerMeta'],
): Pick<AgentTurnMessage, 'triggerSource' | 'triggerSourceSpeaker' | 'triggeredAt' | 'triggerExtracted'> {
  if (!triggerMeta) return {};

  return {
    triggerSource: triggerMeta.triggerSource,
    triggerSourceSpeaker: triggerMeta.triggerSourceSpeaker,
    triggeredAt: triggerMeta.triggeredAt,
    ...(triggerMeta.triggerExtracted ? { triggerExtracted: triggerMeta.triggerExtracted } : {}),
  };
}

function getConnectedClientCountSafe(env: AgentTurnSubmissionEnvironment): number {
  try {
    const count = env.getConnectedClientCount();
    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
}

function broadcastCloudSessionChanged(sessionId: string): void {
  try {
    getBroadcastService().sendToAllWindows('cloud:session-changed', {
      sessionId,
      action: 'upserted',
    });
  } catch (error) {
    log({
      level: 'warn',
      msg: 'Failed to broadcast cloud session change',
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function submitAgentTurnInternal(
  input: SubmitAgentTurnInternalInput,
): Promise<SubmitAgentTurnInternalResult> {
  const { deps, request } = input;

  // Tombstone gate (mirrors the session-events append/PUT gate): refuse to run a
  // turn against a deleted session. Without this, an absent-from-store id is
  // created on first turn (below) and persisted, but session reads/lists filter
  // tombstoned ids — so the turn would burn a model call and vanish from every
  // client (silent loss). Throwing here lets the WS route signal the client to
  // recreate the conversation under a fresh, visible id.
  // See docs/plans/260622_mobile-record-recreated-session/PLAN.md (Stage 1b).
  if (getSessionTombstoneStore().hasTombstone(request.sessionId)) {
    log({
      level: 'warn',
      msg: 'Rejected agent turn for tombstoned session',
      sessionIdHash: hashSessionId(request.sessionId),
    });
    throw new SessionTombstonedError(request.sessionId);
  }

  const sessionSeqIndex = getSessionSeqIndex();
  const environment = getAgentTurnSubmissionEnvironment();
  const pushNotificationSink = getPushNotificationSink();
  const canSendPushNotifications = pushNotificationSink.canSendPushNotifications();

  const sendPushNotification = (payload: Parameters<typeof pushNotificationSink.sendPushNotification>[1]): void => {
    if (!canSendPushNotifications) return;
    void pushNotificationSink.sendPushNotification(null, payload).catch(() => {});
  };

  const streamListeners = new Set<TurnEventListener>();
  const bufferedEvents: AgentEvent[] = [];

  const publishStreamEvent = (event: AgentEvent) => {
    bufferedEvents.push(event);
    for (const listener of streamListeners) {
      invokeTurnEventListener(listener, event);
    }
  };

  const subscribe = (
    listener: TurnEventListener,
    options?: { replayBuffered?: boolean },
  ): (() => void) => {
    streamListeners.add(listener);

    if (options?.replayBuffered !== false) {
      for (const event of bufferedEvents) {
        invokeTurnEventListener(listener, event);
      }
    }

    return () => {
      streamListeners.delete(listener);
    };
  };

  let completionSettled = false;
  let resolveCompletionPromise!: (value: SubmitAgentTurnInternalCompletion) => void;
  const completion = new Promise<SubmitAgentTurnInternalCompletion>((resolve) => {
    resolveCompletionPromise = resolve;
  });
  const settleCompletion = (value: SubmitAgentTurnInternalCompletion): void => {
    if (completionSettled) return;
    completionSettled = true;
    resolveCompletionPromise(value);
  };

  // Inject meeting transcript context/disclaimer when recording context is present.
  // Context is kept separate from the user prompt — only the execution prompt is enriched,
  // not the persisted user message (avoids polluting companion session history).
  let executionPrompt = request.prompt;
  const recordingActive = request.recordingActive ?? false;
  if (recordingActive || request.meetingSessionId) {
    const transcriptResult = environment.buildMeetingTranscriptContext({
      meetingSessionId: request.meetingSessionId,
      recordingActive,
    });

    if (transcriptResult) {
      switch (transcriptResult.kind) {
        case 'context': {
          executionPrompt = `${transcriptResult.text}\n\n${executionPrompt}`;
          log({
            level: 'info',
            msg: 'Injected meeting transcript context into prompt',
            sessionIdHash: hashSessionId(request.sessionId),
            meetingSessionIdHash: request.meetingSessionId
              ? hashSessionId(request.meetingSessionId)
              : undefined,
          });
          break;
        }

        case 'unknown-session':
        case 'empty-transcript': {
          executionPrompt = `${TRANSCRIPT_UNAVAILABLE_INSTRUCTION}\n\n${executionPrompt}`;

          const safeSessionIdHash = hashSessionId(request.sessionId);
          if (shouldLogTranscriptUnavailable(safeSessionIdHash, transcriptResult.kind)) {
            if (transcriptResult.kind === 'empty-transcript' && request.meetingSessionId) {
              log({
                level: 'warn',
                msg: 'early-window-race',
                sessionIdHash: safeSessionIdHash,
                meetingSessionIdHash: hashSessionId(request.meetingSessionId),
                triggerSource: request.triggerMeta?.triggerSource,
                triggeredAt: request.triggerMeta?.triggeredAt,
              });
            }
            log({
              level: 'warn',
              msg: 'transcript-unavailable',
              sessionIdHash: safeSessionIdHash,
              meetingSessionIdHash: request.meetingSessionId ? hashSessionId(request.meetingSessionId) : undefined,
              reason: transcriptResult.kind === 'unknown-session' ? transcriptResult.reason : 'empty-transcript',
              triggerSource: request.triggerMeta?.triggerSource,
              triggeredAt: request.triggerMeta?.triggeredAt,
            });
          }
          break;
        }

        default: {
          const _exhaustive: never = transcriptResult;
          void _exhaustive;
        }
      }
    }
  }

  // Load existing session or create a new one
  let session: AgentSession;
  const existing = await deps.getSession(request.sessionId);
  if (existing) {
    session = existing;
    if (request.externalContext && !existing.externalContext) {
      session = { ...session, externalContext: request.externalContext };
    }
  } else {
    const now = Date.now();
    const externalOrigin = request.externalContext
      ? getOriginForExternalContext(request.externalContext)
      : undefined;
    const inferredOrigin = request.origin ?? externalOrigin ?? 'manual';
    session = {
      id: request.sessionId,
      // Kind-aware default: fixed title for known kinds (e.g. use-case discovery),
      // else the cloud placeholder. Mirrors the desktop first-write
      // (mergeTurnIntoSession) so both surfaces title these sessions identically.
      title: fixedTitleForKind(classifySessionKind(request.sessionId)) ?? 'New conversation',
      createdAt: now,
      updatedAt: now,
      messages: [],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
      // New sessions are Active (doneAt null = Active).
      doneAt: null,
      origin: inferredOrigin,
      ...(request.externalContext ? { externalContext: request.externalContext } : {}),
    };
  }
  sessionSeqIndex.setSeqFromStorage(request.sessionId, getMaxSeqFromSession(session));

  const turnRequest = executionPrompt !== request.prompt
    ? { ...request, prompt: executionPrompt }
    : request;
  const result = deps.startAgentTurn(
    deps.agentTurnServiceDeps,
    turnRequest,
    environment.eventWindow,
  );
  const turnId = result.turnId;

  // Add user message to session
  const userMessage = {
    id: createId(),
    turnId,
    role: 'user' as const,
    text: request.prompt,
    createdAt: Date.now(),
    ...buildTriggerMessageFields(request.triggerMeta),
  };
  session.messages = [...session.messages, userMessage];

  // Track conversation state for this turn using the shared reducer
  let convState: ConversationStateShape = {
    messages: session.messages,
    eventsByTurn: { ...session.eventsByTurn, [turnId]: session.eventsByTurn[turnId] ?? [] },
    activeTurnId: turnId,
    focusedTurnId: null,
    isBusy: true,
    lastError: null,
    lastErrorSource: null,
    terminatedTurnIds: new Set(),
  };

  let turnCompleted = false;
  let checkpointActive = false;
  let checkpointTimer: NodeJS.Timeout | null = null;
  let toolResultEventsSinceCheckpoint = 0;
  let unsubscribeRouteListener: (() => void) | null = null;

  const clearCheckpointTimer = () => {
    if (!checkpointTimer) return;
    clearTimeout(checkpointTimer);
    checkpointTimer = null;
  };

  function scheduleCheckpointTimer(): void {
    clearCheckpointTimer();
    if (!checkpointActive) return;
    checkpointTimer = setTimeout(() => {
      fireAndForget(persistCheckpoint('timer'), 'agentTurnSubmissionService.persistCheckpoint.timer');
    }, TURN_CHECKPOINT_INTERVAL_MS);
    checkpointTimer.unref?.();
  }

  async function persistCheckpoint(trigger: 'timer' | 'tool_result_threshold'): Promise<void> {
    if (!checkpointActive) return;

    const toolResultEventCount = toolResultEventsSinceCheckpoint;
    toolResultEventsSinceCheckpoint = 0;
    scheduleCheckpointTimer();

    void sessionMutex.withLock(request.sessionId, async () => {
      const freshForCheckpoint = await deps.getSession(request.sessionId) || session;
      if (!checkpointActive) return false;

      const checkpointSession: AgentSession = {
        ...freshForCheckpoint,
        messages: convState.messages,
        eventsByTurn: convState.eventsByTurn,
        activeTurnId: turnId,
        isBusy: true,
        maxSeq: Math.max(freshForCheckpoint.maxSeq ?? 0, sessionSeqIndex.getCurrentSeq(request.sessionId)),
      };

      await deps.upsertSession(stampSessionForPersistence(checkpointSession));
      return true;
    }, { label: 'agent.persist-checkpoint' })
      .then((persisted) => {
        if (!persisted) return;
        log({
          level: 'info',
          msg: 'Persisted turn checkpoint',
          turnId,
          sessionId: request.sessionId,
          trigger,
          toolResultEventCount,
        });
      })
      .catch((err) => {
        const message = (err as Error).message;
        const level = err instanceof SessionMutexDeadlockError ? 'error' : 'warn';
        log({
          level,
          msg: 'Failed to persist turn checkpoint',
          turnId,
          sessionId: request.sessionId,
          trigger,
          error: message,
        });
      });
  }

  const listenerFn = async (event: AgentEvent) => {
    const stampedEvent = stampEventSeq(request.sessionId, event);

    if (stampedEvent.type === 'result' || stampedEvent.type === 'error') {
      turnCompleted = true;
      checkpointActive = false;
      clearCheckpointTimer();
    }

    // Accumulate event into conversation state. thinking_delta stays transient:
    // stamp + live-stream it, but do not fold into persisted eventsByTurn.
    if (stampedEvent.type !== 'thinking_delta') {
      convState = updateConversationWithEvent(convState, turnId, stampedEvent);
    }

    if (checkpointActive && isCheckpointToolResultEvent(stampedEvent)) {
      toolResultEventsSinceCheckpoint += 1;
      if (toolResultEventsSinceCheckpoint >= TURN_CHECKPOINT_TOOL_RESULT_THRESHOLD) {
        fireAndForget(
          persistCheckpoint('tool_result_threshold'),
          'agentTurnSubmissionService.persistCheckpoint.toolResultThreshold',
        );
      }
    }

    publishStreamEvent(stampedEvent);

    // Push notification for agent questions (only when no WS clients)
    if (
      stampedEvent.type === 'tool'
      && (stampedEvent as Record<string, unknown>).toolName === 'AskUserQuestion'
      && (stampedEvent as Record<string, unknown>).stage === 'start'
    ) {
      if (getConnectedClientCountSafe(environment) === 0) {
        sendPushNotification({
          title: 'Rebel has a question',
          body: session.title || 'New conversation',
          data: buildConversationPush({ kind: 'question', sessionId: request.sessionId }),
        });
      }
    }

    // On completion, persist the session.
    // Re-read from store to pick up metadata changes made during the turn
    // (e.g. doneAt/starredAt changed by a concurrent desktop mark-as-done).
    // IMPORTANT: merge messages/events instead of overwriting to prevent
    // data loss when concurrent turns run on the same session.
    if (stampedEvent.type === 'result' || stampedEvent.type === 'error') {
      const outcome = stampedEvent.type === 'result' ? 'result' : 'error';
      fireAndForget((async () => {
        try {
          const updatedSession = await sessionMutex.withLock(request.sessionId, async () => {
            const freshForResult = await deps.getSession(request.sessionId) || session;

            // Merge messages: keep all from fresh session, add any from convState
            // that aren't already present (dedup by id, sort by createdAt).
            const mergedMessages = deduplicateMessages(
              freshForResult.messages ?? [], convState.messages ?? [], 'secondary-wins',
            );

            // Merge eventsByTurn: overlay this turn's events, keep all others.
            const mergedEvents = {
              ...(freshForResult.eventsByTurn ?? {}),
              ...(convState.eventsByTurn ?? {}),
            };

            const updated: AgentSession = {
              ...freshForResult,
              messages: mergedMessages,
              eventsByTurn: mergedEvents,
              activeTurnId: null,
              isBusy: false,
              lastError: convState.lastError,
              maxSeq: Math.max(freshForResult.maxSeq ?? 0, sessionSeqIndex.getCurrentSeq(request.sessionId)),
            };

            await deps.upsertSession(stampSessionForPersistence(updated));
            return updated;
          }, { label: 'agent.persist-result' });

          log({ level: 'info', msg: 'Session persisted after turn', turnId, sessionId: request.sessionId });
          broadcastCloudSessionChanged(request.sessionId);

          if (stampedEvent.type === 'result') {
            const hasNoClients = getConnectedClientCountSafe(environment) === 0;
            if (hasNoClients) {
              const title = updatedSession.title || 'New conversation';
              const rawBody = typeof stampedEvent.text === 'string' ? stampedEvent.text : '';
              const body = rawBody.length > 100 ? rawBody.slice(0, 97) + '...' : (rawBody || 'Turn completed');
              sendPushNotification({
                title,
                body,
                data: buildConversationPush({ kind: 'turn-complete', sessionId: request.sessionId }),
              });
            }
          }

          if (stampedEvent.type === 'error') {
            const hasNoClients = getConnectedClientCountSafe(environment) === 0;
            if (hasNoClients) {
              const errorText = typeof (stampedEvent as Record<string, unknown>).error === 'string'
                ? ((stampedEvent as Record<string, unknown>).error as string).slice(0, 100)
                : '';
              sendPushNotification({
                title: 'Something went wrong',
                body: errorText || (updatedSession.title || 'New conversation'),
                data: buildConversationPush({ kind: 'turn-error', sessionId: request.sessionId }),
              });
            }
          }

          // Auto-generate title (fire-and-forget). Skip kinds that carry a fixed
          // title (e.g. use-case discovery) — they must never be content-titled.
          if (stampedEvent.type === 'result' && !hasFixedTitle(classifySessionKind(request.sessionId))) {
            fireAndForget((async () => {
              try {
                const autoTitleResult = await processAutoTitle(updatedSession, {
                  getSettings: deps.getSettings,
                  getCurrentSession: async () => {
                    const fresh = await deps.getSession(request.sessionId);
                    return fresh ? { title: fresh.title, messages: fresh.messages } : null;
                  },
                });
                if (!autoTitleResult) return;

                // Lock only for the re-read + verify + upsert (NOT during LLM call)
                const applied = await sessionMutex.withLock(request.sessionId, async () => {
                  const current = await deps.getSession(request.sessionId);
                  if (!current) return false;
                  if (autoTitleResult.reason === 'initial' && !isDefaultOrFallbackTitle(current.title, current.messages)) return false;
                  if (autoTitleResult.reason === 'retitle' && current.autoTitleGeneratedAt == null) return false;
                  await deps.upsertSession(stampSessionForPersistence({
                    ...current,
                    title: autoTitleResult.title,
                    autoTitleGeneratedAt: Date.now(),
                    autoTitleTurnCount: autoTitleResult.turnCount,
                  }));
                  return true;
                }, { label: 'agent.auto-title' });

                if (!applied) return;
                broadcastCloudSessionChanged(request.sessionId);
                log({
                  level: 'info',
                  msg: 'Auto-generated session title',
                  sessionId: request.sessionId,
                  title: autoTitleResult.title,
                  reason: autoTitleResult.reason,
                });
              } catch (err) {
                log({ level: 'warn', msg: 'Auto-title generation failed', error: (err as Error).message });
              }
            })(), 'agentTurnSubmissionService.autoTitleOnResult');
          }

          log({ level: 'info', msg: 'Agent turn completed', turnId, eventType: stampedEvent.type });
          settleCompletion({ outcome, persisted: true });
        } catch (err) {
          const message = (err as Error).message;
          log({ level: 'error', msg: 'Failed to persist session', turnId, error: message });
          settleCompletion({
            outcome,
            persisted: false,
            persistenceError: message,
          });
        } finally {
          unsubscribeRouteListener?.();
          unsubscribeRouteListener = null;
        }
      })(), 'agentTurnSubmissionService.persistCompletion');
    }
  };

  // Register event listener: stream to caller + accumulate in session.
  // Must happen before the first await so queued executor events can't fire
  // before this listener exists.
  // INTENT: subscribeTurnEvents (multi-subscriber) is required for the cloud
  // route because cloudEventBroadcaster.EXCLUDED_CHANNELS excludes 'agent:event',
  // so this WS is the sole egress channel. setEventListener (single-slot) is
  // owned by cloudRecoveryAdapter for context_overflow gating; using it here
  // would be silently overwritten on recovery setup. See
  // docs/plans/260504_fix_ci_failures.md § Stage 2.
  unsubscribeRouteListener = deps.subscribeTurnEvents(turnId, (event) => {
    fireAndForget(listenerFn(event), 'agentTurnSubmissionService.subscribeTurnEvents');
  });

  const startup = (async () => {
    // Persist session with isBusy immediately so reconnecting clients can see
    // the turn is in progress (even if the WS drops before any events arrive).
    // Re-read from store to pick up metadata changes (e.g. doneAt from a
    // concurrent desktop mark-as-done) instead of using the stale initial snapshot.
    // Merge messages to avoid clobbering concurrent turn data.
    // Await persistence so the session exists in the store before turn_started
    // is sent. This ensures activeOnly queries can find it immediately.
    if (!turnCompleted) {
      try {
        await sessionMutex.withLock(request.sessionId, async () => {
          const freshForBusy = await deps.getSession(request.sessionId) || session;
          const busyMergedMessages = deduplicateMessages(
            freshForBusy.messages ?? [], convState.messages ?? [], 'secondary-wins',
          );

          const busySession: AgentSession = {
            ...freshForBusy,
            messages: busyMergedMessages,
            eventsByTurn: { ...(freshForBusy.eventsByTurn ?? {}), ...(convState.eventsByTurn ?? {}) },
            activeTurnId: turnId,
            isBusy: true,
            lastError: null,
            maxSeq: Math.max(freshForBusy.maxSeq ?? 0, sessionSeqIndex.getCurrentSeq(request.sessionId)),
          };

          await deps.upsertSession(stampSessionForPersistence(busySession));
        }, { label: 'agent.persist-busy' });
        broadcastCloudSessionChanged(request.sessionId);
      } catch (err) {
        log({ level: 'warn', msg: 'Failed to persist busy session at turn start', turnId, error: (err as Error).message });
      }
    }

    if (!turnCompleted) {
      checkpointActive = true;
      scheduleCheckpointTimer();
    }

    // Mark session as cloud_active so it appears in activeOnly queries.
    // Await to ensure it's visible before clients see turn_started.
    await markSessionAsCloudActive(request.sessionId);
  })();

  return {
    turnId,
    sessionId: request.sessionId,
    startup,
    completion,
    subscribe,
  };
}
