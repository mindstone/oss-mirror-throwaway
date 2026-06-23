/**
 * Badge Unlock Checker
 * 
 * Invisible component that listens for badge unlock events
 * and shows celebratory toasts with Rebel's voice.
 * Pattern follows StreakMilestoneChecker.
 */

import { useEffect, useCallback, useRef } from 'react';
import { useAppContext } from '@renderer/contexts/AppContext';
import { getBadgeDefinition } from '@shared/badges';
import { tracking } from '@renderer/src/tracking';

// Queue for rate limiting toasts when multiple badges unlock quickly
const TOAST_DELAY_MS = 2000;

export const BadgeUnlockChecker = () => {
  const { showToast } = useAppContext();
  const toastQueueRef = useRef<string[]>([]);
  const processingRef = useRef(false);

  const processQueue = useCallback(() => {
    if (processingRef.current || toastQueueRef.current.length === 0) {
      return;
    }

    processingRef.current = true;
    const badgeId = toastQueueRef.current.shift();
    if (!badgeId) {
      processingRef.current = false;
      return;
    }
    const badge = getBadgeDefinition(badgeId);

    if (badge) {
      // Track the badge unlock
      tracking.gamification.badgeUnlocked(badgeId, badge.name, badge.category);

      showToast({
        title: `${badge.icon} ${badge.name}`,
        description: badge.rebelVoice
      });

      // Mark as notified
      void window.api.markBadgeNotified?.(badgeId);
    }

    // Process next badge after delay
    setTimeout(() => {
      processingRef.current = false;
      processQueue();
    }, TOAST_DELAY_MS);
  }, [showToast]);

  const handleBadgeUnlocked = useCallback((badgeId: string) => {
    // Add to queue
    toastQueueRef.current.push(badgeId);
    processQueue();
  }, [processQueue]);

  useEffect(() => {
    const cleanup = window.api.onBadgeUnlocked?.((badgeId: string) => {
      handleBadgeUnlocked(badgeId);
    });
    return cleanup;
  }, [handleBadgeUnlocked]);

  return null;
};
