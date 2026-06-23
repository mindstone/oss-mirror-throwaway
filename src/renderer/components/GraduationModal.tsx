/**
 * Graduation Modal
 * 
 * Shown when user completes Day 14 of the onboarding journey.
 * Celebrates completion and offers to create a personal AI playbook.
 */

import { useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/Dialog';
import { Button } from '@renderer/components/ui/Button';
import { Sparkles, Trophy, Clock, Calendar } from 'lucide-react';
import { FluencyTierCard } from './FluencyTierCard';
import { BADGE_DEFINITIONS } from '@shared/badges';
import { tracking } from '@renderer/src/tracking';
import './GraduationModal.css';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface GraduationModalProps {
  open: boolean;
  onClose: () => void;
  /** List of unlocked badge IDs */
  badgesEarned: string[];
  /** Journey statistics */
  journeyStats: {
    daysCompleted: number;
    totalMinutesSaved: number;
  };
  /** Callback to start a new conversation with a prompt */
  onStartConversation: (prompt: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PLAYBOOK_PROMPT = `Help me create my Personal AI Playbook. Based on our conversations over the past 14 days, capture:

1. **My Top 5 Workflows** - The most valuable ways I've used you
2. **Skills I've Built** - Any custom skills or automations I created
3. **My AI Working Style** - Am I more Centaur (clear delegation) or Cyborg (fluid collaboration)?
4. **90-Day Goals** - What I want to achieve with AI in the next quarter

Make this a living document I can reference and update. Use my actual usage patterns, not generic advice.`;

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function GraduationModal({
  open,
  onClose,
  badgesEarned,
  journeyStats,
  onStartConversation
}: GraduationModalProps) {
  
  const handleCreatePlaybook = () => {
    tracking.journey.graduationCelebrated(badgesEarned.length, journeyStats.totalMinutesSaved);
    onStartConversation(PLAYBOOK_PROMPT);
    onClose();
  };

  const handleClose = () => {
    onClose();
  };

  // Format time saved
  const timeSavedDisplay = useMemo(() => {
    const hours = Math.round(journeyStats.totalMinutesSaved / 60);
    if (hours === 0) return 'some';
    if (hours === 1) return '1 hour';
    return `${hours} hours`;
  }, [journeyStats.totalMinutesSaved]);

  // Get badge icons for display
  const badgeIcons = useMemo(() => {
    return badgesEarned
      .slice(0, 8)
      .map(id => BADGE_DEFINITIONS[id as keyof typeof BADGE_DEFINITIONS])
      .filter(Boolean);
  }, [badgesEarned]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="graduation-modal">
        <DialogHeader>
          <DialogTitle className="graduation-modal__title">
            <Sparkles className="graduation-modal__sparkle" size={20} />
            Journey Complete
            <Sparkles className="graduation-modal__sparkle" size={20} />
          </DialogTitle>
        </DialogHeader>
        
        <div className="graduation-modal__content">
          <p className="graduation-modal__intro">
            You've completed the 14-day AI fluency journey. 
            The compound returns start now.
          </p>
          
          {/* Tier achievement */}
          <div className="graduation-modal__section">
            <h3 className="graduation-modal__section-title">You've reached</h3>
            <FluencyTierCard compact />
          </div>
          
          {/* Badges earned */}
          {badgeIcons.length > 0 && (
            <div className="graduation-modal__section">
              <h3 className="graduation-modal__section-title">
                <Trophy size={16} />
                {badgesEarned.length} badge{badgesEarned.length !== 1 ? 's' : ''} earned
              </h3>
              <div className="graduation-modal__badge-grid">
                {badgeIcons.map((badge, i) => (
                  <div key={i} className="graduation-modal__badge" title={badge.name}>
                    <span className="graduation-modal__badge-icon">{badge.icon}</span>
                  </div>
                ))}
                {badgesEarned.length > 8 && (
                  <div className="graduation-modal__badge graduation-modal__badge--more">
                    +{badgesEarned.length - 8}
                  </div>
                )}
              </div>
            </div>
          )}
          
          {/* Stats */}
          <div className="graduation-modal__stats">
            <div className="graduation-modal__stat">
              <Calendar size={16} className="graduation-modal__stat-icon" />
              <span className="graduation-modal__stat-value">{journeyStats.daysCompleted}</span>
              <span className="graduation-modal__stat-label">days active</span>
            </div>
            <div className="graduation-modal__stat">
              <Clock size={16} className="graduation-modal__stat-icon" />
              <span className="graduation-modal__stat-value">{timeSavedDisplay}</span>
              <span className="graduation-modal__stat-label">time saved</span>
            </div>
          </div>
          
          {/* CTA */}
          <Button 
            onClick={handleCreatePlaybook} 
            className="graduation-modal__cta"
            size="lg"
          >
            Create My AI Playbook
          </Button>
          
          <p className="graduation-modal__footer">
            This creates a document capturing your best workflows 
            and your plan for the next 90 days.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
