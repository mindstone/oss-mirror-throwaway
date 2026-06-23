/**
 * Tier Unlock Checker
 * 
 * Invisible component that listens for tier unlock events
 * and shows celebratory toasts.
 * Pattern follows BadgeUnlockChecker.
 */

import { useEffect, useCallback, useRef } from 'react';
import { useAppContext } from '@renderer/contexts/AppContext';
import { tracking } from '@renderer/src/tracking';

// Fluency tier type (matches achievementsStore.ts)
type FluencyTier = 'explorer' | 'practitioner' | 'collaborator' | 'orchestrator';

// Map code tier values to display names and celebration messages
const TIER_CELEBRATIONS: Record<FluencyTier, { name: string; icon: string; message: string }> = {
  explorer: {
    name: 'Explorer',
    icon: '🔍',
    message: 'Your AI journey begins.'
  },
  practitioner: {
    name: 'Practitioner',
    icon: '🌱',
    message: 'The habit is forming. Compound returns ahead.'
  },
  collaborator: {
    name: 'Strategist',
    icon: '🎯',
    message: 'You\'re getting compound returns now.'
  },
  orchestrator: {
    name: 'Architect',
    icon: '🏗️',
    message: 'You\'ve mastered the art of AI collaboration.'
  }
};

export function TierUnlockChecker() {
  const { showToast } = useAppContext();
  const previousTierRef = useRef<string | null>(null);

  const handleTierUnlocked = useCallback((tier: string) => {
    // Type guard to ensure tier is valid
    if (!(tier in TIER_CELEBRATIONS)) return;
    
    const celebration = TIER_CELEBRATIONS[tier as FluencyTier];
    
    // Track the tier unlock
    tracking.gamification.tierUnlocked(tier, celebration.name, previousTierRef.current ?? undefined);
    previousTierRef.current = tier;

    showToast({
      title: `${celebration.icon} ${celebration.name} Tier Unlocked`,
      description: celebration.message
    });
  }, [showToast]);

  useEffect(() => {
    const cleanup = window.api.onTierUnlocked?.((tier: string) => {
      handleTierUnlocked(tier);
    });
    return cleanup;
  }, [handleTierUnlocked]);

  return null;
}
