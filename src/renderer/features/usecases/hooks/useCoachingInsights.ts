/**
 * useCoachingInsights - Fetches full coaching evaluations with session context
 *
 * Takes coaching session IDs and returns full evaluations with session titles.
 * Used by The Spark to display pending coaching insights.
 *
 * Uses sessionSummaries for title/timestamp lookup (lazy loading Stage 7).
 */

import { useEffect, useState, useRef } from 'react';
import type { SessionCoachingEvaluation } from '@shared/types';
import { isOtherPersonTask } from '@shared/utils/inboxQualityPatterns';
import { classifySessionKind } from '@shared/sessionKind';
import { getSessionStoreState } from '../../agent-session/store';

// Keep in sync with sessionCoachingScheduler.ts (authoritative source)
const COACHING_INSIGHT_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const WINS_LEARNINGS_EXTENDED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_FRESH_BEFORE_BACKFILL = 3;
const WIN_LEARNING_PREFIXES = ['win:', 'learning:', 'insight:', '🏆', '💡'];

function isWinOrLearning(title: string): boolean {
  const lower = title.toLowerCase().trim();
  const stripped = lower.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f]+\s*/gu, '').trim();
  return WIN_LEARNING_PREFIXES.some(p => stripped.startsWith(p) || lower.startsWith(p));
}

export interface CoachingInsightWithContext {
  evaluation: SessionCoachingEvaluation;
  sessionTitle: string;
  sessionTimestamp: number;
}

const getSessionTitle = (sessionId: string, evaluation?: SessionCoachingEvaluation): string => {
  if (classifySessionKind(sessionId) === 'automation-insight' && evaluation) {
    return evaluation.primaryInsight.insight;
  }
  const summaries = getSessionStoreState().sessionSummaries;
  const summary = summaries.find(s => s.id === sessionId);
  return summary?.title ?? 'Untitled conversation';
};

const getSessionTimestamp = (sessionId: string): number => {
  // Use sessionSummaries for lazy loading (Stage 7) - lighter weight than full sessions
  const summaries = getSessionStoreState().sessionSummaries;
  const summary = summaries.find(s => s.id === sessionId);
  return summary?.createdAt ?? Date.now();
};

export function useCoachingInsights(sessionIds: Set<string>): {
  insights: CoachingInsightWithContext[];
  isLoading: boolean;
} {
  const [insights, setInsights] = useState<CoachingInsightWithContext[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const fetchIdRef = useRef(0);

  useEffect(() => {
    const ids = Array.from(sessionIds);
    
    if (ids.length === 0) {
      setInsights([]);
      setIsLoading(false);
      return;
    }

    const currentFetchId = ++fetchIdRef.current;
    setIsLoading(true);

    const fetchInsights = async () => {
      const results: CoachingInsightWithContext[] = [];

      await Promise.all(
        ids.map(async (sessionId) => {
          try {
            const { evaluation } = await window.api.getCoachingForSession(sessionId);
            if (evaluation && currentFetchId === fetchIdRef.current) {
              const typed = evaluation as SessionCoachingEvaluation;
              const ageMs = Date.now() - typed.evaluatedAt;

              if (typed.state === 'pending' && Number.isFinite(ageMs) && ageMs <= WINS_LEARNINGS_EXTENDED_TTL_MS) {
                const title = getSessionTitle(sessionId, typed);
                if (isOtherPersonTask(title) || isOtherPersonTask(typed.primaryInsight.insight)) {
                  return;
                }
                results.push({
                  evaluation: typed,
                  sessionTitle: title,
                  sessionTimestamp: getSessionTimestamp(sessionId),
                });
              }
            }
          } catch (err) {
            console.error(`Failed to fetch coaching for session ${sessionId}:`, err);
          }
        })
      );

      if (currentFetchId === fetchIdRef.current) {
        // Two-tier: prefer fresh items (2-day TTL). If sparse, backfill with
        // older wins/learnings (up to 7 days) that haven't been shown yet.
        const fresh = results.filter(r => {
          const age = Date.now() - r.evaluation.evaluatedAt;
          return age <= COACHING_INSIGHT_TTL_MS;
        });
        const backfill = fresh.length < MIN_FRESH_BEFORE_BACKFILL
          ? results.filter(r => {
              const age = Date.now() - r.evaluation.evaluatedAt;
              return age > COACHING_INSIGHT_TTL_MS && isWinOrLearning(r.evaluation.primaryInsight.insight);
            })
          : [];

        const combined = [...fresh, ...backfill];
        combined.sort((a, b) => b.evaluation.evaluatedAt - a.evaluation.evaluatedAt);
        setInsights(combined);
        setIsLoading(false);
      }
    };

    fetchInsights();
  }, [sessionIds]);

  return { insights, isLoading };
}
