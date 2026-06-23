/**
 * useMeetingCoachingCards — Local subscription for coaching card events
 *
 * Subscribes to `meeting:coaching-card` events via the meetingEventEmitter.
 * Cards are ephemeral and meeting-scoped (cleared on unmount).
 * Max 2 visible cards; oldest auto-dismissed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { meetingEventEmitter, type CoachingCardEvent, createLogger } from '@rebel/cloud-client';

const log = createLogger('meetingCoachingCards');

const MAX_VISIBLE_CARDS = 2;
const AUTO_DISMISS_MS = 45_000;

export interface CoachingCardState extends CoachingCardEvent {
  dismissed: boolean;
}

export function useMeetingCoachingCards(meetingSessionId: string | null) {
  log.info('useMeetingCoachingCards called', { meetingSessionId });
  const [cards, setCards] = useState<CoachingCardState[]>([]);
  const timersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Dismiss a card by ID
  const dismissCard = useCallback((cardId: string) => {
    setCards((prev) => prev.map((c) =>
      c.cardId === cardId ? { ...c, dismissed: true } : c,
    ));

    // Clear auto-dismiss timer
    const timer = timersRef.current.get(cardId);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(cardId);
    }
  }, []);

  // Subscribe to coaching events
  useEffect(() => {
    if (!meetingSessionId) return;

    const unsubscribe = meetingEventEmitter.on('coaching-card', (event) => {
      // Only accept cards for this meeting session
      if (event.sessionId !== meetingSessionId) return;

      setCards((prev) => {
        const newCard: CoachingCardState = { ...event, dismissed: false };
        const visible = prev.filter((c) => !c.dismissed);

        // If at max visible, auto-dismiss the oldest
        if (visible.length >= MAX_VISIBLE_CARDS) {
          const oldest = visible[0];
          if (oldest) {
            const timer = timersRef.current.get(oldest.cardId);
            if (timer) {
              clearTimeout(timer);
              timersRef.current.delete(oldest.cardId);
            }
            return [
              ...prev.map((c) =>
                c.cardId === oldest.cardId ? { ...c, dismissed: true } : c,
              ),
              newCard,
            ];
          }
        }

        return [...prev, newCard];
      });

      // Set auto-dismiss timer
      const timer = setTimeout(() => {
        dismissCard(event.cardId);
      }, AUTO_DISMISS_MS);
      timersRef.current.set(event.cardId, timer);
    });

    return () => {
      unsubscribe();
      // Clear all timers on unmount
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
      timersRef.current.clear();
    };
  }, [meetingSessionId, dismissCard]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      setCards([]);
    };
  }, []);

  const visibleCards = cards.filter((c) => !c.dismissed);

  return {
    cards: visibleCards,
    dismissCard,
  };
}
