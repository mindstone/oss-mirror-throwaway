/**
 * CoachingInsightsSection - Hero coaching insights
 *
 * Displays pending coaching insights from completed conversations.
 * Shows at top of The Spark when insights exist.
 * Design: Quote-style cards with insight as hero, hover-reveal actions.
 */

import { useState } from 'react';
import { ChevronRight, ChevronDown, X, ThumbsUp, ThumbsDown } from 'lucide-react';
import { useCoachingInsights, type CoachingInsightWithContext } from './hooks/useCoachingInsights';
import { updateCoachingState } from '../agent-session/hooks/useSessionCoaching';
import { tracking } from '@renderer/src/tracking';
import { formatHistoryTimestamp } from '@renderer/utils/formatters';
import styles from './CoachingInsightsSection.module.css';

const MAX_VISIBLE = 2;

interface CoachingInsightsSectionProps {
  coachingSessionIds: Set<string>;
  onAct: (prompt: string) => void;
  onDismiss: (sessionId: string) => void;
}

export function CoachingInsightsSection({
  coachingSessionIds,
  onAct,
  onDismiss,
}: CoachingInsightsSectionProps) {
  const { insights, isLoading } = useCoachingInsights(coachingSessionIds);
  const [expanded, setExpanded] = useState(false);

  if (isLoading || insights.length === 0) {
    return null;
  }

  const visibleInsights = expanded ? insights : insights.slice(0, MAX_VISIBLE);
  const hiddenCount = insights.length - MAX_VISIBLE;

  const getInsightAgeHours = (insight: CoachingInsightWithContext): number =>
    Math.round((Date.now() - insight.evaluation.evaluatedAt) / (60 * 60 * 1000) * 10) / 10;

  const handleAct = (insight: CoachingInsightWithContext) => {
    tracking.spark.coachingInsightActed(
      insight.evaluation.sessionId,
      insight.evaluation.primaryInsight.category,
      getInsightAgeHours(insight)
    );
    void updateCoachingState(insight.evaluation.sessionId, 'acted');
    onDismiss(insight.evaluation.sessionId);
    onAct(insight.evaluation.primaryInsight.continuationPrompt);
  };

  const handleDismiss = (insight: CoachingInsightWithContext) => {
    tracking.spark.coachingInsightDismissed(
      insight.evaluation.sessionId,
      insight.evaluation.primaryInsight.category,
      getInsightAgeHours(insight)
    );
    void updateCoachingState(insight.evaluation.sessionId, 'dismissed');
    onDismiss(insight.evaluation.sessionId);
  };

  const handleThumbsUp = (insight: CoachingInsightWithContext) => {
    tracking.spark.coachingFeedback(
      insight.evaluation.sessionId,
      insight.evaluation.primaryInsight.category,
      'helpful',
      getInsightAgeHours(insight)
    );
  };

  const handleThumbsDown = (insight: CoachingInsightWithContext) => {
    tracking.spark.coachingFeedback(
      insight.evaluation.sessionId,
      insight.evaluation.primaryInsight.category,
      'not_helpful',
      getInsightAgeHours(insight)
    );
    // Thumbs down also dismisses the card
    void updateCoachingState(insight.evaluation.sessionId, 'dismissed');
    onDismiss(insight.evaluation.sessionId);
  };

  return (
    <section className={styles.section}>
      <header className={styles.sectionHeader}>
        <h3 className={styles.sectionTitle}>Upon reflection</h3>
        <p className={styles.sectionSubtitle}>
          Things from our recent conversations that might deserve a second look.
        </p>
      </header>

      <div className={styles.insightsList}>
        {visibleInsights.map((insight) => (
          <div key={insight.evaluation.sessionId} className={styles.insightCard} tabIndex={0}>
            <p className={styles.insightText}>{insight.evaluation.primaryInsight.insight}</p>
            
            <div className={styles.source}>
              <span className={styles.sessionTitle}>from {insight.sessionTitle}</span>
              <span className={styles.separator}>·</span>
              <span className={styles.timestamp}>
                {formatHistoryTimestamp(insight.sessionTimestamp)}
              </span>
            </div>

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primaryAction}
                onClick={() => handleAct(insight)}
              >
                {insight.evaluation.primaryInsight.category === 'skill_opportunity' 
                  ? 'Try this skill' 
                  : insight.evaluation.primaryInsight.category === 'skill_personalization_opportunity'
                  ? 'Personalize this skill'
                  : 'Explore this'}
                <ChevronRight size={14} />
              </button>
              <button
                type="button"
                className={styles.dismissAction}
                onClick={() => handleDismiss(insight)}
                aria-label="Not now"
              >
                <X size={14} />
              </button>
              <div className={styles.feedbackActions}>
                <button
                  type="button"
                  className={styles.thumbsButton}
                  onClick={() => handleThumbsUp(insight)}
                  aria-label="This was helpful"
                >
                  <ThumbsUp size={12} />
                </button>
                <button
                  type="button"
                  className={styles.thumbsButton}
                  onClick={() => handleThumbsDown(insight)}
                  aria-label="Not helpful"
                >
                  <ThumbsDown size={12} />
                </button>
              </div>
            </div>
          </div>
        ))}

        {hiddenCount > 0 && !expanded && (
          <button
            type="button"
            className={styles.expandButton}
            onClick={() => setExpanded(true)}
          >
            <ChevronDown size={14} />
            {hiddenCount} more reflection{hiddenCount > 1 ? 's' : ''}
          </button>
        )}
      </div>
    </section>
  );
}
