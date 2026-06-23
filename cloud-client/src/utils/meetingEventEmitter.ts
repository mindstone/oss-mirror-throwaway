/**
 * Meeting Event Emitter — Typed event emitter for meeting events
 *
 * EventBridge forwards coaching card events from the WS event channel
 * to this emitter. The mobile recording screen subscribes via the emitter
 * to receive coaching cards without needing a Zustand store (F16).
 *
 * Events are ephemeral and meeting-scoped — no persistence.
 */

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface CoachingCardEvent {
  sessionId: string;
  tip: string;
  skillName: string;
  timestamp: number;
  cardId: string;
}

export type TriggerSource = 'voice-trigger' | 'quick-ask-button';
export type TriggerSourceSpeaker = 'unknown' | 'user' | string;
export type TriggerDroppedReason =
  | 'missing-companion-id'
  | 'action-timeout'
  | 'session-ended'
  | 'service-restart'
  | 'coalesced'
  | 'action-failed'
  | 'rate-limited';

export interface TriggerHeardEvent {
  sessionId: string;
  triggerSource: TriggerSource;
  triggerSourceSpeaker: TriggerSourceSpeaker;
  triggeredAt: number;
  triggerExtracted: string;
}

export interface CompanionTurnStartedEvent extends TriggerHeardEvent {
  turnId: string;
  companionSessionId: string;
}

export interface TriggerRateLimitExceededEvent {
  sessionId: string;
  resetsAt: number;
}

export interface TriggerDroppedEvent extends TriggerHeardEvent {
  reason: TriggerDroppedReason;
}

export interface QuickAskSubmittedEvent {
  sessionId: string;
  prompt: string;
  label: string;
}

export interface MeetingEventMap {
  'coaching-card': CoachingCardEvent;
  'trigger-heard': TriggerHeardEvent;
  'companion-turn-started': CompanionTurnStartedEvent;
  'trigger-rate-limit-exceeded': TriggerRateLimitExceededEvent;
  'trigger-dropped': TriggerDroppedEvent;
  'quick-ask-submitted': QuickAskSubmittedEvent;
}

type EventKey = keyof MeetingEventMap;
type EventHandler<K extends EventKey> = (event: MeetingEventMap[K]) => void;

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

class MeetingEventEmitter {
  private listeners = new Map<EventKey, Set<EventHandler<any>>>();

  on<K extends EventKey>(event: K, handler: EventHandler<K>): () => void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler);

    // Return unsubscribe function
    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  emit<K extends EventKey>(event: K, payload: MeetingEventMap[K]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch {
        // Never throw from event delivery
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}

/** Singleton meeting event emitter — shared between EventBridge and recording screen. */
export const meetingEventEmitter = new MeetingEventEmitter();
