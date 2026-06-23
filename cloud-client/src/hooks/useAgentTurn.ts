// cloud-client/src/hooks/useAgentTurn.ts
// Shared hook for managing an agent turn's WebSocket lifecycle, streaming, and state.

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Item #5 intentionally centralises the cloud live reducer under src/core/services/agentTurnReducer.
import {
  createInitialLiveTurnState,
  createStartedLiveTurnState,
  reduceLiveTurnState,
  shouldSuppressStatus,
  type CompletedStep,
  type LiveTurnState,
  type TurnReducerEffect,
} from '@core/services/agentTurnReducer';
import { createAgentTurnSocket, stopTurn as apiStopTurn } from '../cloudClient';
import { useSessionStore } from '../stores/sessionStore';
import { createLogger } from '../utils/logger';
import { getProcessingQuip, humanizeAgentError, HUMANIZER_OWNED_KINDS } from '@rebel/shared';
import type { AgentEvent } from '@shared/types';
import type { MeetingCompanionTriggerMeta } from '@shared/types';
import type { AgentErrorKind } from '@shared/utils/agentErrorCatalog';
import type { SessionMessage, WebFileAttachment } from '../types';
import type { CloudMeetingSessionId } from '../types/liveMeetingIds';
import type { MissionContext, TaskProgressItem } from '../utils/missionTaskExtraction';
import type { SubAgentItem } from '../utils/subAgentExtraction';

// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Item #5 preserves this public cloud-client export via the new core reducer module.
export { shouldSuppressStatus } from '@core/services/agentTurnReducer';
export type { CompletedStep } from '@core/services/agentTurnReducer';

const QUIP_ROTATION_MS = 5000;
const SEQ_TRACKED_EVENT_TYPES = new Set([
  'status',
  'assistant',
  'assistant_delta',
  'thinking_delta',
  'tool',
  'result',
  'error',
  'warning',
  'user_question',
  'user_question_answered',
  'context_overflow',
  'compaction_started',
  'compaction_summary_ready',
  'compaction_retrying',
  'compaction_completed',
  'compaction_failed',
  'recovery:started',
  'recovery:fallback_attempting',
  'recovery:fallback_succeeded',
  'recovery:compacting',
  'recovery:summary_ready',
  'recovery:retrying',
  'recovery:skeleton_attempting',
  'recovery:depth4_attempting',
  'recovery:succeeded',
  'recovery:failed',
  'recovery:last_resort_skipped',
  'turn_superseded',
  'user_message',
]);

// Kinds whose copy is authored upstream (server dispatcher may attach a bespoke
// `humanizedOverride`, e.g. mobile missing-cred via turnAdmission). The client
// must trust the server-authored `rawMessage` rather than re-running the
// shared humanizer, which would clobber that override with generic copy.
// See docs-private/investigations/260515_mobile_api_key_warning_REBEL-526.md.
const CLIENT_PASSTHROUGH_ERROR_KINDS: ReadonlySet<AgentErrorKind> = new Set<AgentErrorKind>([
  'auth',
  'connection-not-configured',
]);

// Recovery polling: when the turn WS drops and the session is still busy,
// poll the server as a fallback in case the event channel is also impaired.
const RECOVERY_POLL_INTERVAL_MS = 5_000;
const RECOVERY_POLL_MAX = 12; // 60s total
const RECOVERY_EXHAUSTION_ERROR = 'Lost connection to Rebel. Your work is saved — check back shortly.';
const STOP_TURN_ERROR = 'Couldn\'t stop Rebel — it may still be working.';

const log = createLogger('useAgentTurn');

function generateClientTurnId(): string {
  const globalCrypto = (globalThis as typeof globalThis & {
    crypto?: { randomUUID?: () => string };
  }).crypto;
  if (globalCrypto?.randomUUID) {
    return globalCrypto.randomUUID();
  }
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface AgentTurnState {
  isSending: boolean;
  streamingText: string;
  statusText: string | null;
  activeTurnId: string | null;
  optimisticMessages: SessionMessage[];
  completedSteps: CompletedStep[];
  missionContext: MissionContext | null;
  taskProgress: TaskProgressItem[];
  /** Live subagent items tracked from Task/Agent tool events during the turn */
  subAgentItems: SubAgentItem[];
  /** Headline to display while thinking -- rotates between quips and statusText */
  thinkingHeadline: string;
  /** Error message from the most recent turn failure, or null */
  error: string | null;
  /** Whether the current turn contains a MissionSet event */
  hasMissionSet: boolean;
  /** IDs of tasks created/updated in the current turn, in touch order */
  touchedTaskIds: string[];
  /**
   * Raw `user_question` and `user_question_answered` events observed on the
   * agent turn WebSocket, keyed by turnId. Used by `useUserQuestions` on
   * mobile to render inline question cards without a full session replay.
   *
   * Cleared on `startTurn()` (per-turn scope); entries persist across the
   * lifetime of the hook otherwise so answered-state stays visible after
   * the turn completes.
   */
  userQuestionEventsByTurn: Record<string, AgentEvent[]>;
}

export interface StartTurnOptions {
  councilMode?: boolean;
  isSystemContinuation?: boolean;
  /** Cloud meeting session id — injects rolling transcript context into the prompt
   *  server-side. Branded so a local recording id can never be passed here (rec #21). */
  meetingSessionId?: CloudMeetingSessionId;
  /** Signals that an active meeting recording exists even if cloudSessionId is not known yet. */
  recordingActive?: boolean;
  /** Persisted metadata for meeting companion voice/button-triggered turns. */
  triggerMeta?: MeetingCompanionTriggerMeta;
  /**
   * Stage 2 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md` (F3).
   * Forwarded by mobile/cloud `submitAnswer` flows when the user-question
   * response handler returned `continuationContext`. Threaded onto the
   * outgoing `agent:turn` so `agentTurnExecute` skips its proactive
   * `<prior_turns>` + `<conversation_history>` prepend.
   */
  continuationContext?: import('./useUserQuestions').UserQuestionContinuationContext;
}

export interface UseAgentTurnReturn extends AgentTurnState {
  startTurn: (sessionId: string, prompt: string, attachments?: WebFileAttachment[], options?: StartTurnOptions) => void;
  handleStop: () => void;
  closeSocket: () => void;
  /** Clear the current error state */
  clearError: () => void;
}

type LiveAction = { type: 'replace'; state: LiveTurnState };

const liveStateReducer = (_state: LiveTurnState, action: LiveAction): LiveTurnState => action.state;

export function useAgentTurn(): UseAgentTurnReturn {
  const [liveState, dispatchLiveState] = useReducer(liveStateReducer, undefined, createInitialLiveTurnState);
  const liveStateRef = useRef<LiveTurnState>(liveState);
  const [optimisticMessages, setOptimisticMessages] = useState<SessionMessage[]>([]);

  const socketRef = useRef<{ close: () => void } | null>(null);
  const activeTurnIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const receivedTerminalEventRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const awaitingEventChannelRef = useRef(false);
  const recoveryPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recoveryTurnIdRef = useRef<string | null>(null);
  const stopRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitLiveState = useCallback((nextState: LiveTurnState) => {
    liveStateRef.current = nextState;
    activeTurnIdRef.current = nextState.activeTurnId;
    receivedTerminalEventRef.current = nextState.receivedTerminal;
    dispatchLiveState({ type: 'replace', state: nextState });
  }, []);

  const patchLiveState = useCallback((updater: (prev: LiveTurnState) => LiveTurnState) => {
    commitLiveState(updater(liveStateRef.current));
  }, [commitLiveState]);

  const clearStopRetryTimer = useCallback(() => {
    if (stopRetryTimerRef.current) {
      clearTimeout(stopRetryTimerRef.current);
      stopRetryTimerRef.current = null;
    }
  }, []);

  const clearError = useCallback(() => {
    patchLiveState((prev) => prev.error === null ? prev : { ...prev, error: null });
  }, [patchLiveState]);

  const stopRecoveryPolling = useCallback(() => {
    if (recoveryPollRef.current) {
      clearInterval(recoveryPollRef.current);
      recoveryPollRef.current = null;
    }
    recoveryTurnIdRef.current = null;
  }, []);

  const applyReducerEffects = useCallback((effects: TurnReducerEffect[]) => {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'snapshot-completed-steps':
          useSessionStore.getState().snapshotCompletedSteps(effect.turnId, effect.steps);
          break;
        case 'snapshot-mission-task':
          useSessionStore.getState().snapshotMissionTask(
            effect.turnId,
            effect.mission,
            effect.tasks,
            { hasMissionSet: effect.hasMissionSet, touchedTaskIds: effect.touchedTaskIds },
          );
          break;
        case 'terminal-refresh':
          Promise.all([
            useSessionStore.getState().fetchSession(effect.sessionId),
            useSessionStore.getState().fetchSessions(),
          ]).finally(() => {
            patchLiveState((prev) => prev.streamingText === '' ? prev : { ...prev, streamingText: '' });
            if (effect.clearOptimisticMessagesIfStable) {
              const s = useSessionStore.getState();
              if (s.currentSession?.id === effect.sessionId && !s.error) {
                setOptimisticMessages([]);
              }
            }
          });
          break;
        case 'log': {
          const logger = log[effect.level] as (message: string, context?: Record<string, unknown>) => void;
          logger(effect.message, effect.context);
          break;
        }
      }
    }
  }, [patchLiveState]);

  // On unexpected WS close or error, check if turn is still running server-side
  const checkAndUpdateSessionStatus = useCallback(async (sessionId: string) => {
    try {
      await useSessionStore.getState().fetchSession(sessionId);
      if (!mountedRef.current) return;
      const session = useSessionStore.getState().currentSession;
      if (session?.isBusy) {
        awaitingEventChannelRef.current = true;
        activeTurnIdRef.current = session.activeTurnId ?? null;
        patchLiveState((prev) => ({
          ...prev,
          activeTurnId: session.activeTurnId ?? null,
          statusText: 'Rebel is still working...',
          streamingText: '',
        }));
        // Keep isSending true — the event channel will notify when done

        // Start bounded recovery polling as fallback in case event channel is also impaired.
        // Clear any existing poll BEFORE setting new turn ID to avoid clearing what we just set.
        stopRecoveryPolling();
        const pollingTurnId = session.activeTurnId ?? activeTurnIdRef.current;
        recoveryTurnIdRef.current = pollingTurnId;
        let pollCount = 0;
        let isPolling = false;
        log.info('Starting recovery polling', { sessionId, turnId: pollingTurnId });

        recoveryPollRef.current = setInterval(async () => {
          // Guard: stop if turn changed (new startTurn called) or component unmounted
          if (recoveryTurnIdRef.current !== pollingTurnId || !mountedRef.current) {
            stopRecoveryPolling();
            return;
          }

          // Prevent overlapping polls if previous fetch hasn't completed
          if (isPolling) return;
          isPolling = true;

          pollCount++;
          if (pollCount >= RECOVERY_POLL_MAX) {
            log.warn('Recovery polling exhausted — clearing local turn state', { sessionId, turnId: pollingTurnId, pollCount });
            stopRecoveryPolling();
            awaitingEventChannelRef.current = false;
            patchLiveState((prev) => ({
              ...prev,
              isSending: false,
              streamingText: '',
              statusText: null,
              activeTurnId: null,
              error: RECOVERY_EXHAUSTION_ERROR,
            }));
            isPolling = false;
            return;
          }

          try {
            await useSessionStore.getState().fetchSession(sessionId);
            const freshSession = useSessionStore.getState().currentSession;
            if (freshSession && !freshSession.isBusy) {
              stopRecoveryPolling();
            }
          } catch {
            // Network error during poll — continue polling, don't give up
          } finally {
            isPolling = false;
          }
        }, RECOVERY_POLL_INTERVAL_MS);
      } else {
        // Turn completed while WS was closing
        patchLiveState((prev) => ({
          ...prev,
          isSending: false,
          streamingText: '',
          statusText: null,
          activeTurnId: null,
        }));
        setOptimisticMessages([]);
      }
    } catch {
      // Network error — clear state, user can retry
      patchLiveState((prev) => ({
        ...prev,
        isSending: false,
        streamingText: '',
        statusText: null,
        activeTurnId: null,
      }));
    }
  }, [patchLiveState, stopRecoveryPolling]);

  const startTurn = useCallback((sessionId: string, prompt: string, attachments?: WebFileAttachment[], options?: StartTurnOptions) => {
    log.info('startTurn', { sessionId, promptLen: prompt.length, attachmentCount: attachments?.length ?? 0, councilMode: options?.councilMode });
    const clientTurnId = generateClientTurnId();
    mountedRef.current = true;
    awaitingEventChannelRef.current = false;
    sessionIdRef.current = sessionId;
    stopRecoveryPolling(); // Clear any active recovery polling from a previous turn
    clearStopRetryTimer();
    commitLiveState(createStartedLiveTurnState());

    const userMsg: SessionMessage = {
      id: `opt-${Date.now()}`,
      turnId: clientTurnId,
      role: 'user',
      text: prompt,
      createdAt: Date.now(),
      ...(options?.triggerMeta ?? {}),
    };
    setOptimisticMessages([userMsg]);

    // Close any existing socket before opening a new one. The actual close
    // is safe here because the new socket is created below, and the old one's
    // handlers have already been set to no-op via the close() wrapper.
    const oldSocket = socketRef.current;
    socketRef.current = null;
    if (oldSocket) {
      try { oldSocket.close(); } catch { /* already invalidated */ }
    }

    const turnRequest: {
      sessionId: string;
      prompt: string;
      clientTurnId: string;
      attachments?: WebFileAttachment[];
      councilMode?: boolean;
      isSystemContinuation?: boolean;
      meetingSessionId?: string;
      recordingActive?: boolean;
      triggerMeta?: MeetingCompanionTriggerMeta;
      continuationContext?: StartTurnOptions['continuationContext'];
    } = { sessionId, prompt, clientTurnId };
    if (attachments && attachments.length > 0) {
      turnRequest.attachments = attachments;
    }
    if (options?.councilMode) {
      turnRequest.councilMode = true;
    }
    if (options?.isSystemContinuation) {
      turnRequest.isSystemContinuation = true;
    }
    if (options?.meetingSessionId) {
      turnRequest.meetingSessionId = options.meetingSessionId;
    }
    if (options?.recordingActive === true) {
      turnRequest.recordingActive = true;
    }
    if (options?.triggerMeta) {
      turnRequest.triggerMeta = options.triggerMeta;
    }
    if (options?.continuationContext) {
      turnRequest.continuationContext = options.continuationContext;
    }

    try {
      socketRef.current = createAgentTurnSocket(
        turnRequest,
        (event: unknown) => {
          if (!mountedRef.current) return;
          const ev = event as AgentEvent & {
            type: string;
            seq?: number;
            turnId?: string;
            errorKind?: AgentErrorKind;
          };

          let shouldApplyEvent = true;
          if (SEQ_TRACKED_EVENT_TYPES.has(ev.type)) {
            shouldApplyEvent = useSessionStore.getState().applyEventIfNew(sessionId, ev);
          }
          if (!shouldApplyEvent) return;

          const { state, effects } = reduceLiveTurnState(
            liveStateRef.current,
            ev,
            { sessionId, turnId: activeTurnIdRef.current || ev.turnId || null, now: Date.now() },
            {
              shouldSuppressStatus,
              humanizeError: ({ errorKind, billingMeta, rateLimitMeta, provider, rawMessage }) => {
                const canHumanize =
                  errorKind &&
                  HUMANIZER_OWNED_KINDS.has(errorKind) &&
                  !CLIENT_PASSTHROUGH_ERROR_KINDS.has(errorKind);
                return canHumanize
                  ? humanizeAgentError({
                    kind: 'classified',
                    errorKind,
                    billingMeta,
                    rateLimitMeta,
                    provider,
                    upstreamProviderName: billingMeta?.upstreamProviderName,
                    rawMessage,
                  })
                  : errorKind
                    ? rawMessage
                    : humanizeAgentError({
                      kind: 'unclassified',
                      rawMessage,
                      provider,
                    });
              },
            },
          );
          commitLiveState(state);
          applyReducerEffects(effects);
        },
        (err) => {
          if (!mountedRef.current) return;
          log.error('turn WS onError', { message: err.message });
          // If we already received a terminal event, the turn is done — clear state
          if (receivedTerminalEventRef.current) {
            patchLiveState((prev) => ({
              ...prev,
              isSending: false,
              streamingText: '',
              statusText: null,
              activeTurnId: null,
            }));
            return;
          }
          // Turn may still be running server-side — check session status
          if (sessionIdRef.current) {
            checkAndUpdateSessionStatus(sessionIdRef.current);
          } else {
            patchLiveState((prev) => ({
              ...prev,
              isSending: false,
              streamingText: '',
              statusText: null,
              activeTurnId: null,
            }));
          }
        },
        (code, _reason) => {
          if (!mountedRef.current) return;
          // Normal close (1000) after terminal event — nothing to do
          if (code === 1000 || receivedTerminalEventRef.current) return;
          // Unexpected WS close mid-turn — check if turn is still running server-side
          log.info('turn WS closed unexpectedly mid-turn, checking session status', {
            sessionId: sessionIdRef.current,
            code,
          });
          if (sessionIdRef.current) {
            checkAndUpdateSessionStatus(sessionIdRef.current);
          }
        },
      );
    } catch (err) {
      log.error('Failed to create agent turn socket', { error: (err as Error).message });
      patchLiveState((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to start conversation',
        isSending: false,
        streamingText: '',
        statusText: null,
        activeTurnId: null,
        completedSteps: [],
        subAgentItems: [],
        missionContext: null,
        taskProgress: [],
      }));
      setOptimisticMessages([]);
    }
  }, [applyReducerEffects, checkAndUpdateSessionStatus, clearStopRetryTimer, commitLiveState, patchLiveState, stopRecoveryPolling]);

  // When the WS drops and we're in "still working" state (awaitingEventChannelRef
  // is true), the event channel will update the session store when the turn
  // completes. Watch for isBusy transitioning to false to clear local state.
  const currentSession = useSessionStore((s) => s.currentSession);
  const sessionIsBusy = currentSession?.isBusy;
  useEffect(() => {
    if (awaitingEventChannelRef.current && currentSession && !sessionIsBusy) {
      // Turn completed server-side while we had no WS — clear local sending state
      log.info('session isBusy cleared via event channel, clearing local sending state');
      awaitingEventChannelRef.current = false;
      stopRecoveryPolling();
      patchLiveState((prev) => ({
        ...prev,
        isSending: false,
        streamingText: '',
        statusText: null,
        activeTurnId: null,
      }));
      setOptimisticMessages([]);
    }
  }, [currentSession, sessionIsBusy, patchLiveState, stopRecoveryPolling]);

  // Auto-clear the recovery exhaustion error when the turn eventually completes
  // (e.g. event channel delivers isBusy=false after polling gave up).
  useEffect(() => {
    if (!currentSession?.isBusy && liveState.error === RECOVERY_EXHAUSTION_ERROR) {
      patchLiveState((prev) => ({ ...prev, error: null }));
    }
  }, [currentSession?.isBusy, liveState.error, patchLiveState]);

  useEffect(() => {
    if (!liveState.isSending) {
      clearStopRetryTimer();
    }
  }, [clearStopRetryTimer, liveState.isSending]);

  const handleStop = useCallback(async () => {
    if (!liveState.activeTurnId) return;
    log.info('stopping turn', { turnId: liveState.activeTurnId });
    try {
      await apiStopTurn(liveState.activeTurnId);
    } catch (err) {
      log.error('stop turn failed', { error: (err as Error).message });
      patchLiveState((prev) => ({ ...prev, error: STOP_TURN_ERROR }));
    }

    // Re-stop retry: if turn is still active after 10s, retry the stop request.
    // The server-side handler detects the already-aborted controller and escalates
    // to force-kill via Query.close() (SIGTERM → SIGKILL).
    clearStopRetryTimer();
    const turnIdForRetry = liveState.activeTurnId;
    stopRetryTimerRef.current = setTimeout(async () => {
      stopRetryTimerRef.current = null;
      if (!mountedRef.current) return;
      if (activeTurnIdRef.current !== turnIdForRetry) return;
      log.info('re-stop: retrying stop to trigger force-kill escalation', { turnId: turnIdForRetry });
      try {
        await apiStopTurn(turnIdForRetry);
      } catch {
        patchLiveState((prev) => ({ ...prev, error: STOP_TURN_ERROR }));
      }
    }, 10_000);
  }, [clearStopRetryTimer, liveState.activeTurnId, patchLiveState]);

  const closeSocket = useCallback(() => {
    mountedRef.current = false;
    stopRecoveryPolling();
    clearStopRetryTimer();
    const socket = socketRef.current;
    socketRef.current = null;
    // Defer the native WebSocket close to the next microtask to avoid
    // conflicting with in-flight native module operations during React's
    // synchronous unmount phase — prevents ObjC exceptions in TurboModules.
    if (socket) {
      queueMicrotask(() => {
        try { socket.close(); } catch { /* socket already invalidated */ }
      });
    }
  }, [clearStopRetryTimer, stopRecoveryPolling]);

  // Quip rotation while processing (mirrors desktop useWorkSurfaceView pattern)
  const [quip, setQuip] = useState(() => getProcessingQuip());
  useEffect(() => {
    if (!liveState.isSending || liveState.streamingText || liveState.statusText) return;
    const timer = setInterval(() => setQuip(getProcessingQuip()), QUIP_ROTATION_MS);
    return () => clearInterval(timer);
  }, [liveState.isSending, liveState.streamingText, liveState.statusText]);

  const isThinking = liveState.isSending && !liveState.streamingText;
  const thinkingHeadline = isThinking ? (liveState.statusText || quip) : '';

  return {
    isSending: liveState.isSending,
    streamingText: liveState.streamingText,
    statusText: liveState.statusText,
    activeTurnId: liveState.activeTurnId,
    optimisticMessages,
    completedSteps: liveState.completedSteps,
    missionContext: liveState.missionContext,
    taskProgress: liveState.taskProgress,
    subAgentItems: liveState.subAgentItems,
    thinkingHeadline,
    error: liveState.error,
    hasMissionSet: liveState.hasMissionSet,
    touchedTaskIds: liveState.touchedTaskIds,
    userQuestionEventsByTurn: liveState.userQuestionEventsByTurn,
    startTurn,
    handleStop,
    closeSocket,
    clearError,
  };
}
