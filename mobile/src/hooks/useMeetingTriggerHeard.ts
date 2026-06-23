import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  meetingEventEmitter,
  type TriggerDroppedReason,
  type TriggerSourceSpeaker,
} from '@rebel/cloud-client';

const PULSE_DURATION_MS = 3_000;
const AWAITING_TURN_DELAY_MS = 30_000;
const DROP_NOTICE_DURATION_MS = 8_000;

export interface MeetingTriggerHeardState {
  pulsing: boolean;
  lastTriggerAt: number | null;
  lastSpeaker: TriggerSourceSpeaker | null;
  rateLimited: boolean;
  rateLimitResetsAt: number | null;
  awaitingTurn: boolean;
  lastDropReason: TriggerDroppedReason | null;
}

export function useMeetingTriggerHeard(meetingSessionId: string | null): MeetingTriggerHeardState {
  const [state, setState] = useState<MeetingTriggerHeardState>({
    pulsing: false,
    lastTriggerAt: null,
    lastSpeaker: null,
    rateLimited: false,
    rateLimitResetsAt: null,
    awaitingTurn: false,
    lastDropReason: null,
  });

  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awaitingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rateLimitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTriggerAtRef = useRef<number | null>(null);

  useEffect(() => {
    const clearTimer = (timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    clearTimer(pulseTimerRef);
    clearTimer(awaitingTimerRef);
    clearTimer(rateLimitTimerRef);
    clearTimer(dropTimerRef);
    activeTriggerAtRef.current = null;

    setState({
      pulsing: false,
      lastTriggerAt: null,
      lastSpeaker: null,
      rateLimited: false,
      rateLimitResetsAt: null,
      awaitingTurn: false,
      lastDropReason: null,
    });

    if (!meetingSessionId) return undefined;

    const stopPulseAfterWindow = () => {
      clearTimer(pulseTimerRef);
      pulseTimerRef.current = setTimeout(() => {
        setState((prev) => ({ ...prev, pulsing: false }));
      }, PULSE_DURATION_MS);
    };

    const startAwaitingTimer = (triggeredAt: number) => {
      clearTimer(awaitingTimerRef);
      awaitingTimerRef.current = setTimeout(() => {
        if (activeTriggerAtRef.current !== triggeredAt) return;
        setState((prev) => ({ ...prev, awaitingTurn: true }));
      }, AWAITING_TURN_DELAY_MS);
    };

    const clearDropAfterWindow = () => {
      clearTimer(dropTimerRef);
      dropTimerRef.current = setTimeout(() => {
        setState((prev) => ({ ...prev, lastDropReason: null }));
      }, DROP_NOTICE_DURATION_MS);
    };

    const unsubscribeHeard = meetingEventEmitter.on('trigger-heard', (event) => {
      if (event.sessionId !== meetingSessionId) return;
      activeTriggerAtRef.current = event.triggeredAt;
      clearTimer(dropTimerRef);
      setState((prev) => ({
        ...prev,
        pulsing: true,
        lastTriggerAt: event.triggeredAt,
        lastSpeaker: event.triggerSourceSpeaker,
        rateLimited: false,
        rateLimitResetsAt: null,
        awaitingTurn: false,
        lastDropReason: null,
      }));
      stopPulseAfterWindow();
      startAwaitingTimer(event.triggeredAt);
    });

    const unsubscribeStarted = meetingEventEmitter.on('companion-turn-started', (event) => {
      if (event.sessionId !== meetingSessionId) return;
      if (activeTriggerAtRef.current === event.triggeredAt) {
        activeTriggerAtRef.current = null;
      }
      clearTimer(awaitingTimerRef);
      clearTimer(dropTimerRef);
      setState((prev) => ({
        ...prev,
        awaitingTurn: false,
        lastDropReason: null,
      }));
    });

    const unsubscribeRateLimit = meetingEventEmitter.on('trigger-rate-limit-exceeded', (event) => {
      if (event.sessionId !== meetingSessionId) return;
      activeTriggerAtRef.current = null;
      clearTimer(awaitingTimerRef);
      clearTimer(dropTimerRef);
      const delayMs = Math.max(0, event.resetsAt - Date.now());
      clearTimer(rateLimitTimerRef);
      rateLimitTimerRef.current = setTimeout(() => {
        setState((prev) => ({
          ...prev,
          rateLimited: false,
          rateLimitResetsAt: null,
        }));
      }, delayMs);
      setState((prev) => ({
        ...prev,
        pulsing: false,
        rateLimited: true,
        rateLimitResetsAt: event.resetsAt,
        awaitingTurn: false,
        lastDropReason: null,
      }));
    });

    const unsubscribeDropped = meetingEventEmitter.on('trigger-dropped', (event) => {
      if (event.sessionId !== meetingSessionId) return;
      activeTriggerAtRef.current = null;
      clearTimer(awaitingTimerRef);
      if (event.reason === 'coalesced') {
        setState((prev) => ({
          ...prev,
          awaitingTurn: false,
          lastDropReason: null,
        }));
        return;
      }
      setState((prev) => ({
        ...prev,
        awaitingTurn: false,
        lastDropReason: event.reason,
      }));
      clearDropAfterWindow();
    });

    return () => {
      unsubscribeHeard();
      unsubscribeStarted();
      unsubscribeRateLimit();
      unsubscribeDropped();
      clearTimer(pulseTimerRef);
      clearTimer(awaitingTimerRef);
      clearTimer(rateLimitTimerRef);
      clearTimer(dropTimerRef);
    };
  }, [meetingSessionId]);

  return state;
}
