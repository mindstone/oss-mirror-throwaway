import { createScopedLogger } from '@core/logger';
import {
  createMeetingTriggerDetector,
  type DetectorEvent,
  type MeetingTriggerDetector,
} from '@core/services/meetingTriggerDetector';
import { buildCompanionTurnPrompt } from '@core/services/meetingTriggerDetector/buildCompanionTurnPrompt';
import type {
  AgentTurnRequest,
  MeetingCompanionTriggerSource,
  MeetingCompanionTriggerSourceSpeaker,
} from '@shared/types';
import { hashSessionId } from '@shared/trackingTypes';
import type { MeetingSegmentAppendedPayload } from './transcription';

const log = createScopedLogger({ service: 'meeting-question-trigger-service' });

const ACTION_TIMEOUT_MS = 30_000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRIGGERS_PER_HOUR = 20;
const COALESCE_WINDOW_MS = 3_000;
const MAX_LATE_REPLAY_WORDS = 4_000;
const REPLAY_SEGMENT_GAP_MS = 1_000;

type TriggerSource = MeetingCompanionTriggerSource;
type TriggerSourceSpeaker = MeetingCompanionTriggerSourceSpeaker;

export type MeetingTriggerDroppedReason =
  | 'missing-companion-id'
  | 'action-timeout'
  | 'session-ended'
  | 'service-restart'
  | 'coalesced'
  | 'action-failed'
  | 'rate-limited';

export interface MeetingTriggerHeardPayload {
  sessionId: string;
  triggerSource: TriggerSource;
  triggerSourceSpeaker: TriggerSourceSpeaker;
  triggeredAt: number;
  triggerExtracted: string;
}

export interface MeetingCompanionTurnStartedPayload extends MeetingTriggerHeardPayload {
  turnId: string;
  companionSessionId: string;
}

export interface MeetingTriggerRateLimitExceededPayload {
  sessionId: string;
  resetsAt: number;
}

export interface MeetingTriggerDroppedPayload extends MeetingTriggerHeardPayload {
  reason: MeetingTriggerDroppedReason;
}

export interface SubmitCompanionTurnResult {
  turnId: string;
  completion: Promise<unknown>;
}

export interface MeetingQuestionTriggerServiceDeps {
  submitCompanionTurn: (request: AgentTurnRequest) => Promise<SubmitCompanionTurnResult>;
  getCompanionSessionId: (meetingSessionId: string) => string | null;
  getRollingTranscript: (meetingSessionId: string) => string | undefined;
  getTriggerPhrase: () => string | null | undefined;
  getOwnerName: () => string | null | undefined;
  broadcast: (channel: string, payload: unknown) => void;
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  createDetector?: (args: { ownerName: string; triggerPhrase: string | null }) => MeetingTriggerDetector;
  observabilitySink?: (event: { level: 'info' | 'warn' | 'error'; message: string; fields: Record<string, unknown> }) => void;
}

export interface MeetingQuestionTriggerService {
  onSegmentAppended(payload: MeetingSegmentAppendedPayload): void;
  onSessionEnded(sessionId: string, reason?: MeetingTriggerDroppedReason): Promise<void>;
  dispose(): Promise<void>;
}

interface TriggerAction {
  id: number;
  sessionId: string;
  triggerSource: 'voice-trigger';
  triggerSourceSpeaker: TriggerSourceSpeaker;
  triggeredAt: number;
  triggerExtracted: string;
  started: boolean;
  cancelled: boolean;
}

interface SessionState {
  sessionId: string;
  detector: MeetingTriggerDetector;
  detectorTriggerPhrase: string | null;
  pendingDetectorTriggerPhrase: string | null;
  queuedActions: TriggerAction[];
  actionQueue: Promise<void>;
  recentTriggerTimestamps: number[];
  lastActionTriggeredAt: number | null;
  ended: boolean;
}

interface HeardTriggerMonitor {
  sessionId: string;
  triggeredAt: number;
  triggerSource: TriggerSource;
  timeoutHandle: ReturnType<typeof setTimeout>;
  heardAt: number;
}

function normalizeTriggerPhrase(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOwnerName(value: string | null | undefined): string {
  if (typeof value !== 'string') return 'User';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'User';
}

function normalizeSpeaker(value: string | null | undefined): TriggerSourceSpeaker {
  if (typeof value !== 'string') return 'unknown';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'unknown';
}

function toHeardPayload(action: TriggerAction): MeetingTriggerHeardPayload {
  return {
    sessionId: action.sessionId,
    triggerSource: action.triggerSource,
    triggerSourceSpeaker: action.triggerSourceSpeaker,
    triggeredAt: action.triggeredAt,
    triggerExtracted: action.triggerExtracted,
  };
}

export function createMeetingQuestionTriggerService(
  deps: MeetingQuestionTriggerServiceDeps,
): MeetingQuestionTriggerService {
  const now = deps.now ?? (() => Date.now());
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? clearTimeout;

  const createDetector = deps.createDetector ?? ((args: { ownerName: string; triggerPhrase: string | null }) =>
    createMeetingTriggerDetector({
      ownerName: args.ownerName,
      triggerPhrase: args.triggerPhrase,
      mode: 'cloud-mobile',
      // Stage 3 ships regex-triggered companion turns without the bot's expensive
      // semantic completion model call. This resolver keeps detector latency low.
      semanticCompletionCheck: async () => true,
    }));

  const sessionStates = new Map<string, SessionState>();
  const heardTriggerMonitors = new Map<string, HeardTriggerMonitor>();
  let nextActionId = 1;
  let disposed = false;

  const monitorKey = (sessionId: string, triggeredAt: number): string => `${sessionId}:${triggeredAt}`;

  const clearHeardMonitor = (sessionId: string, triggeredAt: number): void => {
    const key = monitorKey(sessionId, triggeredAt);
    const monitor = heardTriggerMonitors.get(key);
    if (!monitor) return;
    clearTimeoutImpl(monitor.timeoutHandle);
    heardTriggerMonitors.delete(key);
  };

  const startHeardMonitor = (payload: MeetingTriggerHeardPayload): void => {
    const key = monitorKey(payload.sessionId, payload.triggeredAt);
    clearHeardMonitor(payload.sessionId, payload.triggeredAt);
    const heardAt = now();
    const timeoutHandle = setTimeoutImpl(() => {
      heardTriggerMonitors.delete(key);
      const fields = {
        sessionIdHash: hashSessionId(payload.sessionId),
        triggerSource: payload.triggerSource,
        triggerSourceSpeaker: payload.triggerSourceSpeaker,
        triggeredAt: payload.triggeredAt,
        triggerExtractedLength: payload.triggerExtracted.length,
        latencyMs: now() - heardAt,
        timeoutMs: ACTION_TIMEOUT_MS,
      };
      log.warn(fields, 'trigger-action-stuck');
      deps.observabilitySink?.({ level: 'warn', message: 'trigger-action-stuck', fields });
    }, ACTION_TIMEOUT_MS);
    heardTriggerMonitors.set(key, {
      sessionId: payload.sessionId,
      triggeredAt: payload.triggeredAt,
      triggerSource: payload.triggerSource,
      timeoutHandle,
      heardAt,
    });
  };

  // Cloud restart fallback (v1): we do not persist in-flight trigger actions yet.
  // Log the explicit no-op so restart behavior remains observable.
  log.info(
    { recoveredSessions: 0 },
    'trigger-restart-recovery-noop: no persisted in-flight trigger metadata found',
  );

  const buildDetector = (
    sessionId: string,
    triggerPhrase: string | null,
    stateRef: () => SessionState | undefined,
  ): MeetingTriggerDetector => {
    const detector = createDetector({
      ownerName: normalizeOwnerName(deps.getOwnerName()),
      triggerPhrase,
    });

    detector.on('trigger', (event: Extract<DetectorEvent, { kind: 'trigger' }>) => {
      const state = stateRef();
      if (!state || state.ended) return;
      handleDetectorTrigger(state, event);
    });

    return detector;
  };

  const replaceDetector = (
    state: SessionState,
    nextTriggerPhrase: string | null,
  ): void => {
    state.detector.dispose();
    state.detector = buildDetector(state.sessionId, nextTriggerPhrase, () => sessionStates.get(state.sessionId));
    state.detectorTriggerPhrase = nextTriggerPhrase;
    state.pendingDetectorTriggerPhrase = null;
  };

  const maybeRefreshDetectorTriggerPhrase = (state: SessionState): void => {
    const nextTriggerPhrase = normalizeTriggerPhrase(deps.getTriggerPhrase());
    if (nextTriggerPhrase === state.detectorTriggerPhrase) return;

    if (state.detector.hasPendingAccumulation()) {
      state.pendingDetectorTriggerPhrase = nextTriggerPhrase;
      log.info(
        {
          sessionIdHash: hashSessionId(state.sessionId),
          previousTriggerPhraseSet: state.detectorTriggerPhrase !== null,
          nextTriggerPhraseSet: nextTriggerPhrase !== null,
        },
        'trigger-phrase-changed-mid-session',
      );
      return;
    }

    replaceDetector(state, nextTriggerPhrase);
  };

  const maybeApplyPendingDetectorTriggerPhrase = (state: SessionState): void => {
    if (state.pendingDetectorTriggerPhrase === state.detectorTriggerPhrase) {
      state.pendingDetectorTriggerPhrase = null;
      return;
    }
    if (!state.pendingDetectorTriggerPhrase) return;
    if (state.detector.hasPendingAccumulation()) return;
    replaceDetector(state, state.pendingDetectorTriggerPhrase);
  };

  const broadcastDropped = (action: TriggerAction, reason: MeetingTriggerDroppedReason): void => {
    const payload: MeetingTriggerDroppedPayload = {
      ...toHeardPayload(action),
      reason,
    };
    deps.broadcast('meeting:trigger-dropped', payload);
  };

  const waitForCompletionWithTimeout = async (
    completion: Promise<unknown>,
  ): Promise<'completed' | 'timeout'> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeoutImpl(() => {
        resolve('timeout');
      }, ACTION_TIMEOUT_MS);
    });

    try {
      const result = await Promise.race([
        completion.then(() => 'completed' as const),
        timeoutPromise,
      ]);
      return result;
    } finally {
      if (timeoutHandle) {
        clearTimeoutImpl(timeoutHandle);
      }
    }
  };

  const runAction = async (state: SessionState, action: TriggerAction): Promise<void> => {
    if (action.cancelled) return;
    if (state.ended) {
      action.cancelled = true;
      broadcastDropped(action, 'session-ended');
      return;
    }

    if (
      state.lastActionTriggeredAt !== null
      && action.triggeredAt - state.lastActionTriggeredAt <= COALESCE_WINDOW_MS
    ) {
      action.cancelled = true;
      log.info(
        {
          sessionIdHash: hashSessionId(action.sessionId),
          actionId: action.id,
          triggeredAt: action.triggeredAt,
          lastActionTriggeredAt: state.lastActionTriggeredAt,
          triggerSource: action.triggerSource,
          triggerSourceSpeaker: action.triggerSourceSpeaker,
          segmentTimestamp: action.triggeredAt,
          reason: 'coalesced',
        },
        'trigger-coalesced',
      );
      broadcastDropped(action, 'coalesced');
      return;
    }

    const companionSessionId = deps.getCompanionSessionId(action.sessionId);
    if (!companionSessionId) {
      action.cancelled = true;
      log.warn(
        {
          sessionIdHash: hashSessionId(action.sessionId),
          actionId: action.id,
          triggerSource: action.triggerSource,
          triggerSourceSpeaker: action.triggerSourceSpeaker,
          segmentTimestamp: action.triggeredAt,
          reason: 'missing-companion-id',
        },
        'trigger-dropped: missing-companion-id',
      );
      broadcastDropped(action, 'missing-companion-id');
      return;
    }

    state.lastActionTriggeredAt = action.triggeredAt;
    const companionTurn = buildCompanionTurnPrompt({
      triggerSource: action.triggerSource,
      triggerSourceSpeaker: action.triggerSourceSpeaker,
      triggeredAt: action.triggeredAt,
      triggerExtracted: action.triggerExtracted,
    });

    let submission: SubmitCompanionTurnResult;
    try {
      submission = await deps.submitCompanionTurn({
        sessionId: companionSessionId,
        prompt: companionTurn.prompt,
        meetingSessionId: action.sessionId,
        recordingActive: true,
        triggerMeta: companionTurn.meta,
        origin: 'inbound-trigger',
      });
    } catch (error) {
      action.cancelled = true;
      log.error(
        {
          sessionIdHash: hashSessionId(action.sessionId),
          actionId: action.id,
          triggerSource: action.triggerSource,
          triggerSourceSpeaker: action.triggerSourceSpeaker,
          segmentTimestamp: action.triggeredAt,
          error: error instanceof Error ? error.message : String(error),
        },
        'trigger-action-submit-failed',
      );
      broadcastDropped(action, 'action-failed');
      return;
    }

    if (state.ended) {
      action.cancelled = true;
      broadcastDropped(action, 'session-ended');
      return;
    }

    const startedPayload: MeetingCompanionTurnStartedPayload = {
      ...toHeardPayload(action),
      turnId: submission.turnId,
      companionSessionId,
    };
    deps.broadcast('meeting:companion-turn-started', startedPayload);
    clearHeardMonitor(action.sessionId, action.triggeredAt);
    log.info(
      {
        sessionIdHash: hashSessionId(action.sessionId),
        companionSessionIdHash: hashSessionId(companionSessionId),
        turnIdHash: hashSessionId(submission.turnId),
        triggerSource: action.triggerSource,
        triggerSourceSpeaker: action.triggerSourceSpeaker,
        triggeredAt: action.triggeredAt,
        triggerExtractedLength: action.triggerExtracted.length,
        latencyMs: now() - action.triggeredAt,
      },
      'companion-turn-submitted-from-trigger',
    );

    try {
      const completion = await waitForCompletionWithTimeout(submission.completion);
      if (completion === 'timeout') {
        log.warn(
          {
            sessionIdHash: hashSessionId(action.sessionId),
            actionId: action.id,
            timeoutMs: ACTION_TIMEOUT_MS,
            triggerSource: action.triggerSource,
            triggerSourceSpeaker: action.triggerSourceSpeaker,
            segmentTimestamp: action.triggeredAt,
            reason: 'action-timeout',
          },
          'trigger-action-timeout',
        );
        broadcastDropped(action, 'action-timeout');
      }
    } catch (error) {
      action.cancelled = true;
      log.warn(
        {
          sessionIdHash: hashSessionId(action.sessionId),
          actionId: action.id,
          triggerSource: action.triggerSource,
          triggerSourceSpeaker: action.triggerSourceSpeaker,
          segmentTimestamp: action.triggeredAt,
          error: error instanceof Error ? error.message : String(error),
        },
        'trigger-action-completion-failed',
      );
      broadcastDropped(action, 'action-failed');
    }
  };

  const enqueueAction = (state: SessionState, action: TriggerAction): void => {
    state.queuedActions.push(action);

    state.actionQueue = state.actionQueue
      .then(async () => {
        if (action.cancelled) return;
        action.started = true;
        state.queuedActions = state.queuedActions.filter((queuedAction) => queuedAction.id !== action.id);
        await runAction(state, action);
      })
      .catch((error) => {
        log.error(
          {
            sessionIdHash: hashSessionId(state.sessionId),
            actionId: action.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'trigger-action-chain-error',
        );
      });
  };

  const registerRateLimitedTrigger = (
    state: SessionState,
    triggeredAt: number,
  ): { limited: false } | { limited: true; resetsAt: number } => {
    const windowStart = triggeredAt - RATE_LIMIT_WINDOW_MS;
    state.recentTriggerTimestamps = state.recentTriggerTimestamps.filter((timestamp) => timestamp > windowStart);

    if (state.recentTriggerTimestamps.length >= MAX_TRIGGERS_PER_HOUR) {
      const resetsAt = state.recentTriggerTimestamps[0] + RATE_LIMIT_WINDOW_MS;
      return { limited: true, resetsAt };
    }

    state.recentTriggerTimestamps.push(triggeredAt);
    return { limited: false };
  };

  function handleDetectorTrigger(
    state: SessionState,
    event: Extract<DetectorEvent, { kind: 'trigger' }>,
  ): void {
    const heardPayload: MeetingTriggerHeardPayload = {
      sessionId: state.sessionId,
      triggerSource: 'voice-trigger',
      triggerSourceSpeaker: normalizeSpeaker(event.speaker),
      triggeredAt: event.timestamp,
      triggerExtracted: event.extracted,
    };

    const rateLimitResult = registerRateLimitedTrigger(state, heardPayload.triggeredAt);
    if (rateLimitResult.limited) {
      const rateLimitPayload: MeetingTriggerRateLimitExceededPayload = {
        sessionId: state.sessionId,
        resetsAt: rateLimitResult.resetsAt,
      };
      log.warn(
        {
          sessionIdHash: hashSessionId(state.sessionId),
          resetsAt: rateLimitResult.resetsAt,
          triggerSource: heardPayload.triggerSource,
          triggerSourceSpeaker: heardPayload.triggerSourceSpeaker,
          triggerExtractedLength: heardPayload.triggerExtracted.length,
          segmentTimestamp: heardPayload.triggeredAt,
          reason: 'rate-limited',
        },
        'trigger-rate-limited',
      );
      deps.broadcast('meeting:trigger-rate-limit-exceeded', rateLimitPayload);
      return;
    }

    deps.broadcast('meeting:trigger-heard', heardPayload);
    startHeardMonitor(heardPayload);
    log.info(
      {
        sessionIdHash: hashSessionId(state.sessionId),
        triggerSource: heardPayload.triggerSource,
        triggerSourceSpeaker: heardPayload.triggerSourceSpeaker,
        triggeredAt: heardPayload.triggeredAt,
        segmentTimestamp: heardPayload.triggeredAt,
        triggerExtractedLength: heardPayload.triggerExtracted.length,
      },
      'trigger-detected',
    );
    log.info(
      {
        sessionIdHash: hashSessionId(state.sessionId),
        triggerSource: heardPayload.triggerSource,
        triggerSourceSpeaker: heardPayload.triggerSourceSpeaker,
        segmentTimestamp: heardPayload.triggeredAt,
      },
      'trigger-source-speaker',
    );

    const action: TriggerAction = {
      id: nextActionId++,
      sessionId: heardPayload.sessionId,
      triggerSource: 'voice-trigger',
      triggerSourceSpeaker: heardPayload.triggerSourceSpeaker,
      triggeredAt: heardPayload.triggeredAt,
      triggerExtracted: heardPayload.triggerExtracted,
      started: false,
      cancelled: false,
    };
    enqueueAction(state, action);
  }

  const replayTranscriptForLateRegistration = (
    state: SessionState,
    currentPayload: MeetingSegmentAppendedPayload | null,
  ): void => {
    const rollingTranscript = deps.getRollingTranscript(state.sessionId);
    if (!rollingTranscript || rollingTranscript.trim().length === 0) return;

    const words = rollingTranscript.trim().split(/\s+/).filter(Boolean);
    if (words.length > MAX_LATE_REPLAY_WORDS) {
      log.info(
        {
          sessionIdHash: hashSessionId(state.sessionId),
          wordCount: words.length,
          maxWords: MAX_LATE_REPLAY_WORDS,
          reason: 'transcript-too-long',
        },
        'trigger-detection-late-registration-skipped: transcript-too-long',
      );
      return;
    }

    const segments = rollingTranscript
      .split(/\n{2,}/)
      .map((segment) => segment.trim())
      .filter(Boolean);

    if (segments.length === 0) return;

    const currentText = currentPayload?.text.trim();
    if (
      currentText
      && segments.length > 0
      && segments[segments.length - 1] === currentText
    ) {
      segments.pop();
    }

    if (segments.length === 0) return;

    const startTimestamp = Math.max(
      (currentPayload?.segmentTimestamp ?? now()) - (segments.length * REPLAY_SEGMENT_GAP_MS),
      0,
    );

    segments.forEach((segment, index) => {
      state.detector.ingestSegment({
        speaker: 'unknown',
        text: segment,
        timestamp: startTimestamp + (index * REPLAY_SEGMENT_GAP_MS),
        isFinal: true,
      });
    });
  };

  const getOrCreateSessionState = (
    sessionId: string,
    currentPayload: MeetingSegmentAppendedPayload | null,
  ): SessionState => {
    const existing = sessionStates.get(sessionId);
    if (existing) return existing;

    const initialTriggerPhrase = normalizeTriggerPhrase(deps.getTriggerPhrase());
    const state: SessionState = {
      sessionId,
      detector: null as unknown as MeetingTriggerDetector,
      detectorTriggerPhrase: initialTriggerPhrase,
      pendingDetectorTriggerPhrase: null,
      queuedActions: [],
      actionQueue: Promise.resolve(),
      recentTriggerTimestamps: [],
      lastActionTriggeredAt: null,
      ended: false,
    };

    state.detector = buildDetector(sessionId, initialTriggerPhrase, () => sessionStates.get(sessionId));
    sessionStates.set(sessionId, state);
    replayTranscriptForLateRegistration(state, currentPayload);
    return state;
  };

  const onSegmentAppended = (payload: MeetingSegmentAppendedPayload): void => {
    if (disposed) return;
    if (payload.isFinal === false) return;

    const state = getOrCreateSessionState(payload.sessionId, payload);
    if (state.ended) return;

    maybeRefreshDetectorTriggerPhrase(state);
    state.detector.ingestSegment({
      speaker: 'unknown',
      text: payload.text,
      timestamp: payload.segmentTimestamp,
      isFinal: payload.isFinal,
    });
    maybeApplyPendingDetectorTriggerPhrase(state);
  };

  const onSessionEnded = async (
    sessionId: string,
    reason: MeetingTriggerDroppedReason = 'session-ended',
  ): Promise<void> => {
    const state = sessionStates.get(sessionId);
    if (!state) return;

    state.ended = true;
    state.detector.dispose();

    for (const action of state.queuedActions) {
      if (action.started || action.cancelled) continue;
      action.cancelled = true;
      clearHeardMonitor(action.sessionId, action.triggeredAt);
      broadcastDropped(action, reason);
    }
    state.queuedActions = [];
    sessionStates.delete(sessionId);
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;

    await Promise.all(
      Array.from(sessionStates.keys()).map((sessionId) => onSessionEnded(sessionId, 'session-ended')),
    );
    for (const monitor of heardTriggerMonitors.values()) {
      clearTimeoutImpl(monitor.timeoutHandle);
    }
    heardTriggerMonitors.clear();
  };

  return {
    onSegmentAppended,
    onSessionEnded,
    dispose,
  };
}
