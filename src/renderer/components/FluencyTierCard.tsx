/**
 * Fluency Tier Card
 * 
 * Displays current AI fluency tier with evidence preview.
 * Shows "why you earned this" quotes from evidence and next tier progress.
 * 
 * Used in:
 * - Achievement Hub overview
 * - Graduation modal
 * - (Future) Dashboard widget
 */

import { useEffect, useState, useMemo } from 'react';
import { Check, ChevronRight, Sparkles, Circle } from 'lucide-react';
import './FluencyTierCard.css';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface EvidenceRecord {
  signal: string;
  timestamp: number;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

interface TierEvidenceData {
  tier: string;
  unlockedAt: number;
  evidence: EvidenceRecord[];
}

interface TierProgressData {
  currentTier: string;
  nextTier: string | null;
  requiredSignals: string[];
  earnedSignals: string[];
  signalsNeeded: number;
  minCount: number;
}

interface FluencyTierCardProps {
  /** Compact mode for embedding in other components */
  compact?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier Configuration
// ─────────────────────────────────────────────────────────────────────────────

// Map code tier values to display names
// Plan: Explorer → Practitioner → Strategist → Architect
// Code: explorer → practitioner → collaborator → orchestrator
const TIER_INFO: Record<string, { name: string; description: string; icon: string; color: string }> = {
  explorer: {
    name: 'Explorer',
    description: 'Finding your footing',
    icon: '🔍',
    color: 'var(--color-tier-explorer)'
  },
  practitioner: {
    name: 'Practitioner',
    description: 'Building the habit',
    icon: '🌱',
    color: 'var(--color-tier-practitioner)'
  },
  collaborator: {
    name: 'Strategist',
    description: 'Compound returns',
    icon: '🎯',
    color: 'var(--color-tier-strategist)'
  },
  orchestrator: {
    name: 'Architect',
    description: 'Building systems',
    icon: '🏗️',
    color: 'var(--color-tier-architect)'
  }
};

const TIER_ORDER = ['explorer', 'practitioner', 'collaborator', 'orchestrator'];

// Human-readable signal names
const SIGNAL_LABELS: Record<string, string> = {
  multi_turn_conversation: 'Deep conversation',
  skill_used: 'Skill mastery',
  memory_consulted: 'Context awareness',
  context_provided: 'Clear communication',
  correction_given: 'Iterative refinement',
  delegation_success: 'Effective delegation',
  parallel_execution: 'Multi-tasking',
  streak_7: '7-day streak',
  streak_30: '30-day streak',
  voice_comfort: 'Voice fluency',
  tool_diversity: 'Tool exploration',
  workflow_adoption: 'Regular usage',
  memory_usage: 'Memory utilization',
  automation_active: 'Automation pioneer',
  time_saved_10h: '10+ hours saved',
  technique_consistency: 'Consistent technique',
  increasing_complexity: 'Growing sophistication',
  high_efficiency_pattern: 'High efficiency'
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function FluencyTierCard({ compact = false }: FluencyTierCardProps) {
  const [tierData, setTierData] = useState<TierEvidenceData | null>(null);
  const [progressData, setProgressData] = useState<TierProgressData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function loadTierData() {
      try {
        const [evidenceData, progress] = await Promise.all([
          window.api.getTierEvidence?.(),
          window.api.getTierProgress?.()
        ]);
        if (mounted) {
          if (evidenceData) setTierData(evidenceData);
          if (progress) setProgressData(progress);
        }
      } catch (error) {
        console.error('Failed to load tier data:', error);
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    }

    loadTierData();
    return () => { mounted = false; };
  }, []);

  const tierInfo = useMemo(() => {
    if (!tierData) return null;
    return TIER_INFO[tierData.tier] ?? TIER_INFO.explorer;
  }, [tierData]);

  const nextTier = useMemo(() => {
    if (!tierData) return null;
    const currentIndex = TIER_ORDER.indexOf(tierData.tier);
    if (currentIndex < 0 || currentIndex >= TIER_ORDER.length - 1) return null;
    return TIER_ORDER[currentIndex + 1];
  }, [tierData]);

  const nextTierInfo = useMemo(() => {
    if (!nextTier) return null;
    return TIER_INFO[nextTier];
  }, [nextTier]);

  // Get up to 3 unique evidence signals for display
  const evidenceHighlights = useMemo(() => {
    if (!tierData?.evidence) return [];
    const seenSignals = new Set<string>();
    const highlights: { signal: string; proof?: string }[] = [];
    
    for (const e of tierData.evidence) {
      if (seenSignals.has(e.signal)) continue;
      seenSignals.add(e.signal);
      highlights.push({
        signal: e.signal,
        proof: (e.metadata?.proof as string) ?? undefined
      });
      if (highlights.length >= 3) break;
    }
    
    return highlights;
  }, [tierData]);

  if (isLoading) {
    return (
      <div className={`fluency-tier-card ${compact ? 'fluency-tier-card--compact' : ''}`}>
        <div className="fluency-tier-card__loading">Loading...</div>
      </div>
    );
  }

  if (!tierData || !tierInfo) {
    return null;
  }

  return (
    <div className={`fluency-tier-card ${compact ? 'fluency-tier-card--compact' : ''}`}>
      {/* Header with tier icon and name */}
      <div className="fluency-tier-card__header">
        <span className="fluency-tier-card__icon">{tierInfo.icon}</span>
        <div className="fluency-tier-card__title-group">
          <h3 className="fluency-tier-card__tier-name">{tierInfo.name}</h3>
          <p className="fluency-tier-card__description">{tierInfo.description}</p>
        </div>
        {!compact && nextTierInfo && (
          <div className="fluency-tier-card__next-hint">
            <ChevronRight size={16} />
            <span>{nextTierInfo.name}</span>
          </div>
        )}
      </div>

      {/* Evidence highlights */}
      {!compact && evidenceHighlights.length > 0 && (
        <div className="fluency-tier-card__evidence">
          <h4 className="fluency-tier-card__evidence-title">
            <Sparkles size={14} />
            Why you earned this
          </h4>
          <ul className="fluency-tier-card__evidence-list">
            {evidenceHighlights.map((e, i) => (
              <li key={i} className="fluency-tier-card__evidence-item">
                <Check size={14} className="fluency-tier-card__check" />
                <span className="fluency-tier-card__signal-name">
                  {SIGNAL_LABELS[e.signal] ?? e.signal}
                </span>
                {e.proof && (
                  <span className="fluency-tier-card__proof">"{e.proof}"</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Next tier progress with gap analysis */}
      {!compact && progressData && nextTierInfo && (
        <div className="fluency-tier-card__progress">
          <div className="fluency-tier-card__progress-header">
            <span className="fluency-tier-card__progress-label">
              Next: {nextTierInfo.name}
            </span>
            <span className="fluency-tier-card__progress-count">
              {progressData.earnedSignals.length} of {progressData.minCount} signals
            </span>
          </div>
          
          {/* Signal checklist */}
          <ul className="fluency-tier-card__signal-list">
            {progressData.requiredSignals.map((signal) => {
              const isEarned = progressData.earnedSignals.includes(signal);
              return (
                <li 
                  key={signal} 
                  className={`fluency-tier-card__signal-item ${isEarned ? 'fluency-tier-card__signal-item--earned' : ''}`}
                >
                  {isEarned ? (
                    <Check size={12} className="fluency-tier-card__signal-check" />
                  ) : (
                    <Circle size={12} className="fluency-tier-card__signal-circle" />
                  )}
                  <span>{SIGNAL_LABELS[signal] ?? signal}</span>
                </li>
              );
            })}
          </ul>
          
          {progressData.signalsNeeded > 0 && (
            <p className="fluency-tier-card__progress-hint">
              {progressData.signalsNeeded} more signal{progressData.signalsNeeded !== 1 ? 's' : ''} to unlock
            </p>
          )}
        </div>
      )}

      {/* Max tier reached */}
      {!compact && !progressData && tierData?.tier === 'orchestrator' && (
        <div className="fluency-tier-card__max-tier">
          <Sparkles size={14} />
          <span>You've reached the highest tier</span>
        </div>
      )}
    </div>
  );
}
