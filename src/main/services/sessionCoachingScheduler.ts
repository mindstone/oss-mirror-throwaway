/**
 * Session Coaching Scheduler
 *
 * Periodically scans sessions for post-session processing.
 * Persists state to electron-store so it survives app restarts.
 * 
 * Eligibility criteria:
 * - Session resolved > 1 hour ago
 * - Has 3+ user messages
 * - User hasn't resumed the session since resolution
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import type { AppSettings, SessionCoachingEvaluation, AgentSession, AgentSessionSummary } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { collectSessionEvidence } from './evidenceCollectionService';
import { runWeeklyAssessment } from './weeklyAssessmentService';
import { evaluateTierOnSessionComplete, pruneCountedSessions } from './achievementsEvaluator';
import { createPausableInterval } from './visibilityAwareScheduler';
import {
  clearSessionData as clearShareData,
} from './communityShareStore';
import { extractSkillsUsed as _extractSkillsUsed, processSkillUsageForSessions } from './skillUsageRecorder';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'sessionCoachingScheduler' });

const COACHING_DELAY_MS = 60 * 60 * 1000; // 1 hour before eligible
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // Check every 15 minutes
const MAX_EVIDENCE_PER_DAY = 5; // Evidence collection has separate limit
const MIN_USER_MESSAGES = 3;
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000; // Only consider sessions resolved in last 24h
const MAX_SESSION_CREATION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // Skip sessions created >7 days ago (even if recently resumed)
// Keep in sync with useCoachingInsights.ts renderer-side safety net
const COACHING_INSIGHT_TTL_MS = 2 * 24 * 60 * 60 * 1000; // Auto-dismiss insights older than 2 days
const WEEKLY_ASSESSMENT_DAY = 0; // Sunday
const WEEKLY_ASSESSMENT_HOUR = 9; // 9 AM

// TODO: Migrate addAutomationInsight to hero choice store. Then this scheduler can be renamed to postSessionProcessor.
type CoachingStoreState = {
  evaluations: Record<string, SessionCoachingEvaluation>;
  evaluatedSessionIds: string[]; // Sessions we've already evaluated (even if no insight)
  usageRecordedSessionIds: string[]; // Sessions we've already recorded skill usage for
  evidenceEvaluatedSessionIds: string[]; // Sessions evaluated for evidence (separate from coaching)
  evidenceDailyCount: number;
  evidenceDailyCountDate: string;
  lastWeeklyAssessmentDate: string; // YYYY-MM-DD of last weekly assessment
}

interface SessionCoachingSchedulerDeps {
  getSettings: () => AppSettings;
  listSessionSummaries: () => AgentSessionSummary[];
  getSessionAsync: (id: string) => Promise<AgentSession | null>;
  broadcastCoachingReflection: (sessionId: string, evaluation: SessionCoachingEvaluation) => void;
  broadcastSkillImprovementComplete?: (data: { skillName: string; skillPath: string; scoreAfter: number; bandAfter: string; lastSessionId?: string }) => void;
  getWorkspacePath: () => string | null;
}

class SessionCoachingSchedulerImpl {
  private deps: SessionCoachingSchedulerDeps | null = null;
  private store: KeyValueStore<CoachingStoreState> | null = null;
  private checkIntervalCleanup: (() => void) | null = null;
  private isRunning = false;

  initialize(deps: SessionCoachingSchedulerDeps): void {
    this.deps = deps;
    
    // Initialize persistent store
    this.store = createStore<CoachingStoreState>({
      name: 'session-coaching',
      defaults: {
        evaluations: {},
        evaluatedSessionIds: [],
        usageRecordedSessionIds: [],
        evidenceEvaluatedSessionIds: [],
        evidenceDailyCount: 0,
        evidenceDailyCountDate: '',
        lastWeeklyAssessmentDate: ''
      }
    });

    log.info('Session coaching scheduler initialized');

    // Run initial check after a short delay (let app fully start)
    setTimeout(() => {
      fireAndForget(this.checkEligibleSessions(), 'sessionCoachingScheduler.line86');
    }, 10000); // 10 seconds after startup

    // Start periodic checks using visibility-aware scheduling
    // (background post-session processing, safe to pause when app is hidden)
    this.checkIntervalCleanup = createPausableInterval(
      () => this.checkEligibleSessions(),
      CHECK_INTERVAL_MS,
      { pauseOnBlur: true, catchUpPriority: 5 }
    );
  }

  shutdown(): void {
    if (this.checkIntervalCleanup) {
      this.checkIntervalCleanup();
      this.checkIntervalCleanup = null;
    }
  }

  private isUsageRecorded(sessionId: string): boolean {
    if (!this.store) return false;
    const recorded = this.store.get('usageRecordedSessionIds') ?? [];
    return recorded.includes(sessionId);
  }

  private markUsageRecorded(sessionId: string): void {
    if (!this.store) return;
    const recorded = this.store.get('usageRecordedSessionIds') ?? [];
    if (!recorded.includes(sessionId)) {
      const updated = [...recorded, sessionId].slice(-200);
      this.store.set('usageRecordedSessionIds', updated);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Evidence Collection Tracking (separate from coaching)
  // ─────────────────────────────────────────────────────────────────────────

  private getEvidenceDailyCount(): number {
    if (!this.store) return 0;
    
    const today = new Date().toDateString();
    const storedDate = this.store.get('evidenceDailyCountDate');
    
    if (storedDate !== today) {
      this.store.set('evidenceDailyCount', 0);
      this.store.set('evidenceDailyCountDate', today);
      log.debug({ date: today }, 'Reset daily evidence count');
      return 0;
    }
    
    return this.store.get('evidenceDailyCount', 0);
  }

  private incrementEvidenceDailyCount(): void {
    if (!this.store) return;
    const current = this.getEvidenceDailyCount();
    this.store.set('evidenceDailyCount', current + 1);
  }

  private isSessionEvidenceEvaluated(sessionId: string): boolean {
    if (!this.store) return false;
    const evaluated = this.store.get('evidenceEvaluatedSessionIds') ?? [];
    return evaluated.includes(sessionId);
  }

  private markSessionEvidenceEvaluated(sessionId: string): void {
    if (!this.store) return;
    const evaluated = this.store.get('evidenceEvaluatedSessionIds') ?? [];
    if (!evaluated.includes(sessionId)) {
      const updated = [...evaluated, sessionId].slice(-100);
      this.store.set('evidenceEvaluatedSessionIds', updated);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Weekly Assessment Tracking
  // ─────────────────────────────────────────────────────────────────────────

  private shouldRunWeeklyAssessment(): boolean {
    if (!this.store) return false;
    
    const now = new Date();
    const today = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const lastRun = this.store.get('lastWeeklyAssessmentDate');
    
    // Already ran today
    if (lastRun === today) return false;
    
    // Check if it's the right day and time
    if (now.getDay() !== WEEKLY_ASSESSMENT_DAY) return false;
    if (now.getHours() < WEEKLY_ASSESSMENT_HOUR) return false;
    
    return true;
  }

  private markWeeklyAssessmentRun(): void {
    if (!this.store) return;
    const today = new Date().toISOString().split('T')[0];
    this.store.set('lastWeeklyAssessmentDate', today);
  }

  /**
   * Called when user starts a new turn - marks session as "active" so we don't evaluate it
   */
  markSessionActive(sessionId: string): void {
    // If there's a pending evaluation result, don't show it
    // The session is being resumed, so coaching wouldn't be relevant
    if (this.store) {
      const evaluations = this.store.get('evaluations') ?? {};
      if (evaluations[sessionId]) {
        delete evaluations[sessionId];
        this.store.set('evaluations', evaluations);
        log.debug({ sessionId }, 'Cleared coaching for resumed session');
      }
    }

    // Clear any pending community share for the resumed session
    clearShareData(sessionId);
  }

  private async checkEligibleSessions(): Promise<void> {
    if (this.isRunning || !this.deps || !this.store) {
      return;
    }

    this.isRunning = true;
    const now = Date.now();

    try {
      const settings = this.deps.getSettings();

      // Periodic cleanup of in-memory session tracking
      pruneCountedSessions();

      // ─────────────────────────────────────────────────────────────────────
      // Weekly Assessment (runs once per week on Sunday 9AM+)
      // ─────────────────────────────────────────────────────────────────────
      if (this.shouldRunWeeklyAssessment()) {
        log.info('Running weekly assessment');
        try {
          await runWeeklyAssessment(settings);
          this.markWeeklyAssessmentRun();
          // Also evaluate tier progression after weekly assessment
          evaluateTierOnSessionComplete();
        } catch (error) {
          log.error({ error }, 'Weekly assessment failed');
        }
      }

      const summaries = this.deps.listSessionSummaries();

      // Resolve eligible summaries (resolved 1h-24h ago, created <7d ago, 3+ messages),
      // then load full sessions only for those candidates.
      const eligibleSummaries = summaries.filter(summary => {
        if (!summary.resolvedAt) return false;
        const timeSinceResolved = now - summary.resolvedAt;
        if (timeSinceResolved < COACHING_DELAY_MS) return false;
        if (timeSinceResolved > MAX_SESSION_AGE_MS) return false;
        if (now - summary.createdAt > MAX_SESSION_CREATION_AGE_MS) return false;
        if ((summary.messageCount ?? 0) < MIN_USER_MESSAGES) return false;
        return true;
      });

      const getSession = this.deps.getSessionAsync;
      const eligibleSessions = await Promise.all(
        eligibleSummaries.map(summary => getSession(summary.id))
      );

      // Resolve eligible sessions (exact user-message check after async load)
      const resolvedSessions = eligibleSessions
        .filter((session): session is AgentSession => session !== null)
        .filter(session => {
          const userMessages = session.messages.filter(m => m.role === 'user');
          if (userMessages.length < MIN_USER_MESSAGES) return false;
          return true;
        });

      // ─────────────────────────────────────────────────────────────────────
      // Skill Usage Recording (runs for ALL eligible sessions, independent of evidence limits)
      // ─────────────────────────────────────────────────────────────────────
      await processSkillUsageForSessions(resolvedSessions, {
        isUsageRecorded: (id) => this.isUsageRecorded(id),
        markUsageRecorded: (id) => this.markUsageRecorded(id),
        broadcastSkillImprovementComplete: this.deps.broadcastSkillImprovementComplete,
        getWorkspacePath: () => this.deps?.getWorkspacePath() ?? '',
      });

      // ─────────────────────────────────────────────────────────────────────
      // Evidence Collection (separate daily limit)
      // ─────────────────────────────────────────────────────────────────────
      if (this.getEvidenceDailyCount() < MAX_EVIDENCE_PER_DAY) {
        for (const session of resolvedSessions) {
          if (this.getEvidenceDailyCount() >= MAX_EVIDENCE_PER_DAY) {
            break;
          }
          if (this.isSessionEvidenceEvaluated(session.id)) {
            continue;
          }

          const sessionId = session.id;
          this.markSessionEvidenceEvaluated(sessionId);

          try {
            log.info({ sessionId }, 'Running evidence collection');
            await collectSessionEvidence(session, settings);
            this.incrementEvidenceDailyCount();

            // Evaluate tier progression after collecting evidence
            const newTier = evaluateTierOnSessionComplete();
            if (newTier) {
              log.info({ sessionId, newTier }, 'Tier advanced after evidence collection');
            }
          } catch (error) {
            log.error({ sessionId, error }, 'Evidence collection failed');
          }
        }
      } else {
        log.debug('Daily evidence limit reached, skipping evidence collection');
      }

    } catch (error) {
      log.error({ error }, 'Error checking eligible sessions');
    } finally {
      this.isRunning = false;
    }
  }

  /** @deprecated TODO: Remove after Hero Choice fully replaces coaching IPC consumers. */
  getCoachingForSession(sessionId: string): SessionCoachingEvaluation | null {
    if (!this.store) return null;
    const evaluations = this.store.get('evaluations') ?? {};
    return evaluations[sessionId] ?? null;
  }

  /** @deprecated TODO: Remove after Hero Choice fully replaces coaching IPC consumers. */
  getAllPendingCoaching(): SessionCoachingEvaluation[] {
    if (!this.store) {
      log.warn('getAllPendingCoaching called but store is not initialized');
      return [];
    }
    const evaluations = this.store.get('evaluations') ?? {};
    const now = Date.now();
    let mutated = false;

    const WINS_LEARNINGS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const HIGHLIGHT_PREFIXES = ['win:', 'learning:', 'insight:', '🏆', '💡'];

    const pending: SessionCoachingEvaluation[] = [];
    for (const evaluation of Object.values(evaluations)) {
      if (evaluation.state !== 'pending') continue;

      const ageMs = now - evaluation.evaluatedAt;
      const title = evaluation.primaryInsight.insight.toLowerCase().trim();
      const stripped = title.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\ufe0f]+\s*/gu, '').trim();
      const isWinOrLearning = HIGHLIGHT_PREFIXES.some(p => stripped.startsWith(p) || title.startsWith(p));
      const ttl = isWinOrLearning ? WINS_LEARNINGS_TTL_MS : COACHING_INSIGHT_TTL_MS;

      if (!Number.isFinite(ageMs) || ageMs > ttl) {
        evaluations[evaluation.sessionId] = { ...evaluation, state: 'dismissed' };
        mutated = true;
        log.info({ sessionId: evaluation.sessionId, ageMs, ttl }, 'Auto-dismissed stale coaching insight');
        continue;
      }
      pending.push(evaluation);
    }

    if (mutated) {
      this.store.set('evaluations', evaluations);
    }

    log.debug({ totalEvaluations: Object.keys(evaluations).length, pendingCount: pending.length }, 'getAllPendingCoaching');
    return pending;
  }

  /**
   * @deprecated TODO: Remove after Hero Choice fully replaces coaching IPC consumers.
   * Get all skill suggestions from coaching history (skill_opportunity insights).
   * Returns skills ranked by frequency (most suggested first).
   * Useful for "Skills for you" personalization.
   */
  getAllSuggestedSkills(): Array<{ skillName: string; count: number; lastSuggestedAt: number }> {
    if (!this.store) return [];
    
    const evaluations = this.store.get('evaluations') ?? {};
    const skillCounts = new Map<string, { count: number; lastSuggestedAt: number }>();
    
    for (const evaluation of Object.values(evaluations)) {
      if (!Number.isFinite(evaluation.evaluatedAt)) continue;
      const insight = evaluation.primaryInsight;
      if (insight?.category === 'skill_opportunity' && insight.suggestedSkill) {
        const existing = skillCounts.get(insight.suggestedSkill);
        if (existing) {
          existing.count++;
          existing.lastSuggestedAt = Math.max(existing.lastSuggestedAt, evaluation.evaluatedAt);
        } else {
          skillCounts.set(insight.suggestedSkill, {
            count: 1,
            lastSuggestedAt: evaluation.evaluatedAt
          });
        }
      }
    }
    
    // Convert to array and sort by count (descending)
    return Array.from(skillCounts.entries())
      .map(([skillName, data]) => ({ skillName, ...data }))
      .sort((a, b) => b.count - a.count);
  }

  /** @deprecated TODO: Remove after Hero Choice fully replaces coaching IPC consumers. */
  updateCoachingState(
    sessionId: string,
    state: SessionCoachingEvaluation['state'],
    dismissalReason?: SessionCoachingEvaluation['dismissalReason']
  ): void {
    if (!this.store) return;
    
    const evaluations = this.store.get('evaluations') ?? {};
    if (evaluations[sessionId]) {
      evaluations[sessionId] = {
        ...evaluations[sessionId],
        state,
        ...(dismissalReason && { dismissalReason })
      };
      this.store.set('evaluations', evaluations);
    }
  }

  /** Force an immediate check (useful for testing) */
  async forceCheck(): Promise<void> {
    await this.checkEligibleSessions();
  }

  /**
   * Persist a redirected inbox item as an automation insight in the Coach carousel.
   * Called when write-time filtering redirects non-actionable content (insights, wins,
   * recaps) from the inbox to the Coach section.
   */
  addAutomationInsight(params: {
    insightId: string;
    title: string;
    text?: string;
    sourceLabel?: string;
  }): void {
    if (!this.store || !this.deps) {
      log.warn('Cannot add automation insight — coaching scheduler not initialized');
      return;
    }

    const syntheticSessionId = `automation-insight-${params.insightId}`;

    const promptParts = [`I'd like to explore this insight further: "${params.title}"`];
    if (params.text) promptParts.push(`Context: ${params.text}`);
    if (params.sourceLabel) promptParts.push(`Source: ${params.sourceLabel}`);
    promptParts.push('What should I know about this, and are there any actions I should take?');
    const continuationPrompt = promptParts.join('\n\n');

    const evaluation: SessionCoachingEvaluation = {
      sessionId: syntheticSessionId,
      evaluatedAt: Date.now(),
      primaryInsight: {
        id: params.insightId,
        insight: params.title,
        context: params.text,
        continuationPrompt,
        category: 'automation_insight',
        ...(params.sourceLabel ? { sources: [params.sourceLabel] } : {}),
      },
      state: 'pending',
    };

    const evaluations = this.store.get('evaluations') ?? {};
    evaluations[syntheticSessionId] = evaluation;
    this.store.set('evaluations', evaluations);

    const sessionIds = this.store.get('evaluatedSessionIds') ?? [];
    if (!sessionIds.includes(syntheticSessionId)) {
      const updated = [...sessionIds, syntheticSessionId];
      this.store.set('evaluatedSessionIds', updated.slice(-100));
    }

    this.deps.broadcastCoachingReflection(syntheticSessionId, evaluation);
    log.info({ insightId: params.insightId, title: params.title }, 'Automation insight added to Coach');
  }

  seedEvaluationForTesting(evaluation: SessionCoachingEvaluation): void {
    if (!this.store || !this.deps) return;

    const evaluations = this.store.get('evaluations') ?? {};
    evaluations[evaluation.sessionId] = evaluation;
    this.store.set('evaluations', evaluations);

    const sessionIds = this.store.get('evaluatedSessionIds') ?? [];
    if (!sessionIds.includes(evaluation.sessionId)) {
      this.store.set('evaluatedSessionIds', [...sessionIds, evaluation.sessionId].slice(-100));
    }

    this.deps.broadcastCoachingReflection(evaluation.sessionId, evaluation);
  }
}

export const sessionCoachingScheduler = new SessionCoachingSchedulerImpl();

export { _extractSkillsUsed as extractSkillsUsed };
