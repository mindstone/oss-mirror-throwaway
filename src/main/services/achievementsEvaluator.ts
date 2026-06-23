/**
 * Achievements Evaluator
 *
 * Evaluates badge criteria and unlocks badges when thresholds are met.
 * Called at turn completion with aggregated context - single evaluation point.
 */

import { createScopedLogger } from '@core/logger';
import {
  unlockBadge,
  broadcastBadgeUnlocked,
  broadcastTierUnlocked,
  getBadges,
  getCounters,
  incrementSessionCount,
  incrementVoiceSessionCount,
  incrementNightSessionCount,
  incrementMemoryWriteCount,
  incrementSkillInvocationCount,
  incrementAutomationCreatedCount,
  addTimeSaved,
  markJourneyDayComplete,
  getOnboardingJourney,
  getStreakData,
  getEvidenceCounts,
  getCurrentTier,
  advanceTier,
  recordEvidence,
  getLocalDateString,
  type FluencyTier,
  type EvidenceSignal
} from './achievementsStore';
import { getAllToolUsage } from './toolUsageStore';
import { type BadgeId, BADGE_DEFINITIONS } from '@shared/badges';
import { getSettings } from '@core/services/settingsStore';

const log = createScopedLogger({ service: 'achievementsEvaluator' });

// In-memory session tool counts (cleared on session complete)
const sessionToolCounts = new Map<string, Set<string>>();

// Track which sessions have already been counted (prevent overcounting on multi-turn conversations)
// Bounded to prevent memory leak - stores only timestamp, not full session data
const countedSessions = new Map<string, number>(); // sessionId -> timestamp
const MAX_COUNTED_SESSIONS = 500;

/**
 * Cleanup old session IDs from countedSessions to prevent memory leak.
 * Called periodically by the scheduler.
 */
export function pruneCountedSessions(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  const now = Date.now();
  let pruned = 0;
  
  for (const [sessionId, timestamp] of countedSessions.entries()) {
    if (now - timestamp > maxAgeMs) {
      countedSessions.delete(sessionId);
      pruned++;
    }
  }
  
  // Also enforce size limit
  if (countedSessions.size > MAX_COUNTED_SESSIONS) {
    const entries = Array.from(countedSessions.entries())
      .sort((a, b) => a[1] - b[1]); // Sort by timestamp ascending (oldest first)
    const toRemove = entries.slice(0, countedSessions.size - MAX_COUNTED_SESSIONS);
    for (const [sessionId] of toRemove) {
      countedSessions.delete(sessionId);
      pruned++;
    }
  }
  
  if (pruned > 0) {
    log.debug({ pruned, remaining: countedSessions.size }, 'Pruned old session IDs');
  }
  
  return pruned;
}

export interface TurnContext {
  sessionId: string;
  /** True if this turn had meaningful activity (tools used). Used for first_words badge. */
  hadMeaningfulActivity: boolean;
  toolsUsedThisTurn: string[];
  memoryWriteOccurred: boolean;
  skillInvoked: boolean;
  /** The skill name if a skill was invoked (e.g., "meeting-prep" from @meeting-prep) */
  skillNameInvoked?: string;
  voiceUsed: boolean;
  automationCreated: boolean;
  timeSavedMinutes: number;
  sessionDurationMinutes?: number;
}

/**
 * Calculate current journey day from onboarding completion timestamp.
 * Day 1 is the day onboarding completed, Day 2 is the next calendar day, etc.
 * 
 * When the calendar window (14 days) has passed, falls back to the first
 * incomplete day so users who fell behind can still make progress.
 * Returns null only if journey not started or all 14 days are complete.
 */
export function getCurrentJourneyDay(): number | null {
  const settings = getSettings();
  const completedAt = settings.onboardingFirstCompletedAt ?? settings.onboardingCompletedAt;
  
  if (!completedAt) return null;
  
  const completedDate = new Date(completedAt);
  const today = new Date();
  
  // Use UTC-normalized calendar dates to avoid DST off-by-one errors.
  // setHours(0,0,0,0) + timestamp division fails when a DST transition
  // falls between the two dates (e.g., spring-forward makes the day 23h).
  const completedDay = Date.UTC(completedDate.getFullYear(), completedDate.getMonth(), completedDate.getDate());
  const todayDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysSinceCompletion = Math.round((todayDay - completedDay) / msPerDay);
  const calendarDay = daysSinceCompletion + 1;
  
  // Guard against clock skew (system clock behind onboarding timestamp)
  if (calendarDay < 1) return 1;
  if (calendarDay <= 14) return calendarDay;
  
  // Past the 14-day window: fall back to the first incomplete day
  // so users who fell behind can still progress.
  const journey = getOnboardingJourney();
  const completedSet = new Set(journey.completedDays);
  if (completedSet.size >= 14) return null;
  
  for (let d = 1; d <= 14; d++) {
    if (!completedSet.has(d)) return d;
  }
  return null;
}

/**
 * Check if a badge is already unlocked.
 */
function hasBadge(badgeId: BadgeId): boolean {
  const badges = getBadges();
  return !!badges[badgeId];
}

/**
 * Unlock a badge and broadcast if newly unlocked.
 */
function tryUnlockBadge(badgeId: BadgeId): boolean {
  if (hasBadge(badgeId)) return false;
  
  const unlocked = unlockBadge(badgeId);
  if (unlocked) {
    broadcastBadgeUnlocked(badgeId);
    log.info({ badgeId, name: BADGE_DEFINITIONS[badgeId].name }, 'Badge unlocked');
  }
  return unlocked;
}

/**
 * Track tool usage for a session.
 */
export function recordToolUseForSession(sessionId: string, toolName: string): void {
  if (!sessionToolCounts.has(sessionId)) {
    sessionToolCounts.set(sessionId, new Set());
  }
  sessionToolCounts.get(sessionId)?.add(toolName);
}

/**
 * Get tool count for a session.
 */
export function getSessionToolCount(sessionId: string): number {
  return sessionToolCounts.get(sessionId)?.size ?? 0;
}

/**
 * Clear session tool tracking (call on session complete).
 */
export function clearSessionToolCount(sessionId: string): void {
  sessionToolCounts.delete(sessionId);
}

/**
 * Check if current time is within a time range (for fun badges).
 */
function isInTimeRange(startHour: number, endHour: number): boolean {
  const hour = new Date().getHours();
  if (startHour <= endHour) {
    return hour >= startHour && hour < endHour;
  }
  // Handle wrap around midnight (e.g., 22-6)
  return hour >= startHour || hour < endHour;
}

/**
 * Check if today is a weekend.
 */
function isWeekend(): boolean {
  const day = new Date().getDay();
  return day === 0 || day === 6;
}

/**
 * Main evaluation function - called at turn completion.
 * Single entry point for all badge evaluation.
 */
export function evaluateBadgesOnTurnComplete(context: TurnContext): BadgeId[] {
  const unlockedBadges: BadgeId[] = [];
  const counters = getCounters();
  const sessionToolCount = getSessionToolCount(context.sessionId);
  
  try {
    // ========================================================================
    // Exploration Badges (first-time usage)
    // ========================================================================
    
    // First Words - first meaningful conversation completed (one with tool usage)
    if (context.hadMeaningfulActivity && tryUnlockBadge('first_words')) {
      unlockedBadges.push('first_words');
    }
    
    // Voice Activated - first voice message
    if (context.voiceUsed && tryUnlockBadge('voice_activated')) {
      unlockedBadges.push('voice_activated');
    }
    
    // Tool Time - first MCP tool used
    if (context.toolsUsedThisTurn.length > 0 && tryUnlockBadge('tool_time')) {
      unlockedBadges.push('tool_time');
    }
    
    // Memory Keeper - first memory write
    if (context.memoryWriteOccurred && tryUnlockBadge('memory_keeper')) {
      unlockedBadges.push('memory_keeper');
    }
    
    // Skill Hunter - first skill invoked
    if (context.skillInvoked && tryUnlockBadge('skill_hunter')) {
      unlockedBadges.push('skill_hunter');
    }
    
    // Automator - first automation created
    if (context.automationCreated && tryUnlockBadge('automator')) {
      unlockedBadges.push('automator');
    }
    
    // ========================================================================
    // Mastery Badges (skill demonstration)
    // ========================================================================
    
    // Orchestrator - 5+ tools in one session
    if (sessionToolCount >= 5 && tryUnlockBadge('orchestrator')) {
      unlockedBadges.push('orchestrator');
    }
    
    // Deep Diver - 10+ tool calls in one session
    if (sessionToolCount >= 10 && tryUnlockBadge('deep_diver')) {
      unlockedBadges.push('deep_diver');
    }
    
    // Conductor - 15+ unique tools in one session
    if (sessionToolCount >= 15 && tryUnlockBadge('conductor')) {
      unlockedBadges.push('conductor');
    }
    
    // Speed Demon - 30+ min saved in one session
    if (context.timeSavedMinutes >= 30 && tryUnlockBadge('speed_demon')) {
      unlockedBadges.push('speed_demon');
    }
    
    // Hour Thief - 60+ min saved in one session
    if (context.timeSavedMinutes >= 60 && tryUnlockBadge('hour_thief')) {
      unlockedBadges.push('hour_thief');
    }
    
    // Day Reclaimed - 120+ min saved in one session
    if (context.timeSavedMinutes >= 120 && tryUnlockBadge('day_reclaimed')) {
      unlockedBadges.push('day_reclaimed');
    }
    
    // Voice Native - 10+ sessions with voice
    if (counters.voiceSessions >= 10 && tryUnlockBadge('voice_native')) {
      unlockedBadges.push('voice_native');
    }
    
    // Voice Virtuoso - 50+ sessions with voice
    if (counters.voiceSessions >= 50 && tryUnlockBadge('voice_virtuoso')) {
      unlockedBadges.push('voice_virtuoso');
    }
    
    // Voice Maestro - 100+ sessions with voice
    if (counters.voiceSessions >= 100 && tryUnlockBadge('voice_maestro')) {
      unlockedBadges.push('voice_maestro');
    }
    
    // Tool diversity badges (lifetime unique tools)
    const uniqueToolCount = getAllToolUsage().length;
    if (uniqueToolCount >= 25 && tryUnlockBadge('tool_collector')) {
      unlockedBadges.push('tool_collector');
    }
    if (uniqueToolCount >= 50 && tryUnlockBadge('tool_connoisseur')) {
      unlockedBadges.push('tool_connoisseur');
    }
    if (uniqueToolCount >= 100 && tryUnlockBadge('tool_savant')) {
      unlockedBadges.push('tool_savant');
    }
    
    // ========================================================================
    // Cumulative Badges (milestones)
    // ========================================================================
    
    // Session milestones
    if (counters.totalSessions >= 10 && tryUnlockBadge('getting_started')) {
      unlockedBadges.push('getting_started');
    }
    if (counters.totalSessions >= 50 && tryUnlockBadge('regular')) {
      unlockedBadges.push('regular');
    }
    if (counters.totalSessions >= 100 && tryUnlockBadge('power_user')) {
      unlockedBadges.push('power_user');
    }
    if (counters.totalSessions >= 250 && tryUnlockBadge('centurion')) {
      unlockedBadges.push('centurion');
    }
    if (counters.totalSessions >= 500 && tryUnlockBadge('veteran')) {
      unlockedBadges.push('veteran');
    }
    if (counters.totalSessions >= 1000 && tryUnlockBadge('thousand_stories')) {
      unlockedBadges.push('thousand_stories');
    }
    
    // Time saved milestones
    if (counters.totalTimeSavedMinutes >= 600 && tryUnlockBadge('time_wizard')) {
      unlockedBadges.push('time_wizard');
    }
    if (counters.totalTimeSavedMinutes >= 2400 && tryUnlockBadge('time_lord')) {
      unlockedBadges.push('time_lord');
    }
    if (counters.totalTimeSavedMinutes >= 6000 && tryUnlockBadge('time_architect')) {
      unlockedBadges.push('time_architect');
    }
    if (counters.totalTimeSavedMinutes >= 15000 && tryUnlockBadge('time_baron')) {
      unlockedBadges.push('time_baron');
    }
    if (counters.totalTimeSavedMinutes >= 30000 && tryUnlockBadge('time_sovereign')) {
      unlockedBadges.push('time_sovereign');
    }
    if (counters.totalTimeSavedMinutes >= 60000 && tryUnlockBadge('epoch')) {
      unlockedBadges.push('epoch');
    }
    
    // Streak milestones (check current streak)
    const streak = getStreakData();
    if (streak.current >= 7 && tryUnlockBadge('consistent')) {
      unlockedBadges.push('consistent');
    }
    if (streak.current >= 14 && tryUnlockBadge('committed')) {
      unlockedBadges.push('committed');
    }
    if (streak.current >= 30 && tryUnlockBadge('relentless')) {
      unlockedBadges.push('relentless');
    }
    if (streak.current >= 60 && tryUnlockBadge('iron_will')) {
      unlockedBadges.push('iron_will');
    }
    if (streak.current >= 100 && tryUnlockBadge('unstoppable')) {
      unlockedBadges.push('unstoppable');
    }
    if (streak.current >= 365 && tryUnlockBadge('eternal_flame')) {
      unlockedBadges.push('eternal_flame');
    }
    
    // Memory, skill, and automation badges
    if (counters.totalMemoryWrites >= 25 && tryUnlockBadge('archivist')) {
      unlockedBadges.push('archivist');
    }
    if (counters.totalMemoryWrites >= 100 && tryUnlockBadge('curator')) {
      unlockedBadges.push('curator');
    }
    if (counters.totalSkillInvocations >= 25 && tryUnlockBadge('skill_practitioner')) {
      unlockedBadges.push('skill_practitioner');
    }
    if (counters.totalSkillInvocations >= 100 && tryUnlockBadge('skill_master')) {
      unlockedBadges.push('skill_master');
    }
    if (counters.totalAutomationsCreated >= 10 && tryUnlockBadge('automation_architect')) {
      unlockedBadges.push('automation_architect');
    }
    if (counters.totalAutomationsCreated >= 25 && tryUnlockBadge('automation_empire')) {
      unlockedBadges.push('automation_empire');
    }
    
    // ========================================================================
    // Fun Badges (engagement)
    // ========================================================================
    
    // Night Owl - session between 12am-4am
    if (isInTimeRange(0, 4) && tryUnlockBadge('night_owl')) {
      unlockedBadges.push('night_owl');
    }
    
    // Early Bird - session between 5am-7am
    if (isInTimeRange(5, 7) && tryUnlockBadge('early_bird')) {
      unlockedBadges.push('early_bird');
    }
    
    // Weekend Warrior - 4+ weekend sessions
    if (counters.weekendSessions >= 4 && tryUnlockBadge('weekend_warrior')) {
      unlockedBadges.push('weekend_warrior');
    }
    
    // Marathon - single session 60+ minutes
    if (context.sessionDurationMinutes && context.sessionDurationMinutes >= 60 && tryUnlockBadge('marathon')) {
      unlockedBadges.push('marathon');
    }
    
    // Ultramarathon - single session 120+ minutes
    if (context.sessionDurationMinutes && context.sessionDurationMinutes >= 120 && tryUnlockBadge('ultramarathon')) {
      unlockedBadges.push('ultramarathon');
    }
    
    // ========================================================================
    // Secret Badges
    // ========================================================================
    
    // Night Shift - 10+ sessions between midnight-4am (uses nightSessions counter)
    if (counters.nightSessions >= 10 && tryUnlockBadge('night_shift')) {
      unlockedBadges.push('night_shift');
    }
    
    // Reunion - return after 30+ days inactive (checked separately at session start)
    // This is handled in evaluateReunionBadge() called at session initialization
    
    if (unlockedBadges.length > 0) {
      log.info({ unlockedBadges }, 'Badges unlocked this turn');
    }
  } catch (error) {
    log.error({ err: error }, 'Error evaluating badges');
  }
  
  return unlockedBadges;
}

/**
 * Check for reunion badge on session start.
 * Should be called early in session initialization before streak is updated.
 */
export function evaluateReunionBadge(): boolean {
  try {
    const streak = getStreakData();
    const lastActiveDate = streak.lastActiveDate;
    
    // No previous activity - can't be a reunion
    if (!lastActiveDate) return false;
    
    // Already have the badge
    if (hasBadge('reunion')) return false;
    
    // Calculate days since last activity using local dates (not UTC)
    const today = getLocalDateString();
    
    // Parse YYYY-MM-DD as local date components to avoid UTC timezone issues
    const [lastYear, lastMonth, lastDay] = lastActiveDate.split('-').map(Number);
    const [todayYear, todayMonth, todayDay] = today.split('-').map(Number);
    const lastActiveLocal = new Date(lastYear, lastMonth - 1, lastDay);
    const todayLocal = new Date(todayYear, todayMonth - 1, todayDay);
    
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysSinceActive = Math.floor((todayLocal.getTime() - lastActiveLocal.getTime()) / msPerDay);
    
    if (daysSinceActive >= 30 && tryUnlockBadge('reunion')) {
      log.info({ daysSinceActive }, 'Reunion badge unlocked');
      return true;
    }
    
    return false;
  } catch (error) {
    log.error({ err: error }, 'Error evaluating reunion badge');
    return false;
  }
}

/**
 * Update counters on session complete.
 * Called separately from badge evaluation to track cumulative stats.
 * 
 * Note: Session counting is idempotent per sessionId - calling this multiple times
 * for the same session (e.g., multi-turn conversations) will only count once.
 * Time saved is additive and can be called multiple times.
 */
export function updateCountersOnSessionComplete(
  sessionId: string,
  voiceUsed: boolean,
  timeSavedMinutes: number,
  memoryWriteOccurred?: boolean,
  skillInvoked?: boolean,
  automationCreated?: boolean
): void {
  try {
    // Only count each session once (prevent overcounting on multi-turn conversations)
    if (!countedSessions.has(sessionId)) {
      countedSessions.set(sessionId, Date.now());
      const weekend = isWeekend();
      incrementSessionCount(weekend);
      
      if (voiceUsed) {
        incrementVoiceSessionCount();
      }
      
      // Track night sessions (midnight-4am) for night_shift badge
      if (isInTimeRange(0, 4)) {
        incrementNightSessionCount();
      }
    }
    
    // Time saved is additive - each turn can contribute
    if (timeSavedMinutes > 0) {
      addTimeSaved(timeSavedMinutes);
    }
    
    // Increment counters for memory/skill/automation badges
    if (memoryWriteOccurred) {
      incrementMemoryWriteCount();
    }
    if (skillInvoked) {
      incrementSkillInvocationCount();
    }
    if (automationCreated) {
      incrementAutomationCreatedCount();
    }
    
    // Clear session tool tracking
    clearSessionToolCount(sessionId);
  } catch (error) {
    log.error({ err: error }, 'Error updating counters on session complete');
  }
}

/**
 * Evaluate journey day completion based on context.
 * Returns the day number if completed, null otherwise.
 */
export function evaluateJourneyCompletion(context: TurnContext, currentDay: number): number | null {
  const journey = getOnboardingJourney();
  
  // Journey not started or day already completed
  if (!journey.journeyStartedAt || journey.completedDays.includes(currentDay)) {
    return null;
  }
  
  // Check completion criteria for current day
  let completed = false;
  
  switch (currentDay) {
    case 1: // Context matters — primarily tracked via UI click in OnboardingJourneyCard.
      // Backup auto-detection if user completes email/calendar tools from a non-journey conversation.
      completed = context.toolsUsedThisTurn.some(t => 
        t.includes('gmail') || t.includes('calendar') || t.includes('email')
      );
      break;
    case 2: // Invoked a skill
      completed = context.skillInvoked;
      break;
    case 3: // Memory write occurred
      completed = context.memoryWriteOccurred;
      break;
    case 4: // Ran a use case from The Spark (tracked via UI click)
      // This is detected in renderer when user clicks journey card button
      break;
    case 5: // Created a skill file
      completed = context.toolsUsedThisTurn.some(t => 
        (t.includes('create') || t.includes('write')) && 
        context.toolsUsedThisTurn.some(p => p.includes('skills/'))
      );
      break;
    case 6: // Viewed coaching insight (tracked via UI click)
      break;
    case 7: // Weekly review (explicit button click)
      break;
    case 8: // Created automation
      completed = context.automationCreated;
      break;
    case 9: // Voice session completed
      completed = context.voiceUsed;
      break;
    case 10: // Used 3+ tools in session
      completed = getSessionToolCount(context.sessionId) >= 3;
      break;
    case 11: // Ran automation discovery skill
      // Check for specific skill: interview-me-to-look-for-ai-automations
      completed = context.skillNameInvoked?.includes('interview-me-to-look-for-ai-automations') ?? false;
      break;
    case 12: // Created/modified space (tracked elsewhere)
      break;
    case 13: // Connected new MCP (tracked elsewhere)
      break;
    case 14: // Graduation (explicit button click)
      break;
  }
  
  if (completed) {
    markJourneyDayComplete(currentDay);
    return currentDay;
  }
  
  return null;
}

// ============================================================================
// Tier Progression Evaluation
// ============================================================================

/**
 * Tier requirements: signals needed and minimum count.
 * Plan name → code value mapping:
 * - Explorer → 'explorer'
 * - Practitioner → 'practitioner'
 * - Strategist → 'collaborator'
 * - Architect → 'orchestrator'
 */
const TIER_REQUIREMENTS: Record<FluencyTier, { signals: EvidenceSignal[]; minCount: number }> = {
  explorer: { signals: [], minCount: 0 }, // Automatic after onboarding
  practitioner: {
    // Metric-based signals (evaluated directly from counters)
    // Note: memory_usage removed - requires complex session event analysis
    signals: ['streak_7', 'voice_comfort', 'tool_diversity', 'workflow_adoption'],
    minCount: 3
  },
  collaborator: {
    // Mix of LLM-detected and metric signals (Plan name: "Strategist")
    // Note: automation_active removed - requires circular import to check scheduler
    signals: ['multi_turn_conversation', 'skill_used', 'context_provided', 'delegation_success', 'time_saved_10h'],
    minCount: 4
  },
  orchestrator: {
    // Requires cross-session signal + advanced patterns (Plan name: "Architect")
    signals: ['technique_consistency', 'increasing_complexity', 'high_efficiency_pattern', 'streak_30'],
    minCount: 4
  }
};

const TIER_ORDER: FluencyTier[] = ['explorer', 'practitioner', 'collaborator', 'orchestrator'];

/**
 * Evaluate metric-based signals and record them as evidence.
 * These signals are derived from counters/stores, not LLM analysis.
 */
export function evaluateMetricSignals(): EvidenceSignal[] {
  const counters = getCounters();
  const streak = getStreakData();
  const detectedSignals: EvidenceSignal[] = [];

  // streak_7: 7-day streak
  if (streak.current >= 7) {
    recordEvidence('streak_7', undefined, { streakLength: streak.current });
    detectedSignals.push('streak_7');
  }

  // streak_30: 30-day streak
  if (streak.current >= 30) {
    recordEvidence('streak_30', undefined, { streakLength: streak.current });
    detectedSignals.push('streak_30');
  }

  // voice_comfort: 5+ voice sessions
  if (counters.voiceSessions >= 5) {
    recordEvidence('voice_comfort', undefined, { voiceSessions: counters.voiceSessions });
    detectedSignals.push('voice_comfort');
  }

  // workflow_adoption: 10+ total sessions
  if (counters.totalSessions >= 10) {
    recordEvidence('workflow_adoption', undefined, { totalSessions: counters.totalSessions });
    detectedSignals.push('workflow_adoption');
  }

  // time_saved_10h: 600+ minutes saved
  if (counters.totalTimeSavedMinutes >= 600) {
    recordEvidence('time_saved_10h', undefined, { minutesSaved: counters.totalTimeSavedMinutes });
    detectedSignals.push('time_saved_10h');
  }

  // tool_diversity: 10+ unique tools used
  try {
    const toolUsage = getAllToolUsage();
    if (toolUsage.length >= 10) {
      recordEvidence('tool_diversity', undefined, { uniqueTools: toolUsage.length });
      detectedSignals.push('tool_diversity');
    }
  } catch (error) {
    log.warn({ error }, 'Failed to check tool diversity');
  }

  return detectedSignals;
}

/**
 * Evaluate tier progression based on accumulated evidence.
 * Returns the new tier if advanced, null otherwise.
 */
export function evaluateTierProgression(): FluencyTier | null {
  const { tier: currentTier } = getCurrentTier();
  const currentIndex = TIER_ORDER.indexOf(currentTier);
  
  // Already at max tier
  if (currentIndex >= TIER_ORDER.length - 1) {
    return null;
  }

  const nextTier = TIER_ORDER[currentIndex + 1];
  const requirements = TIER_REQUIREMENTS[nextTier];

  // Get all evidence counts (LLM-detected + metric-based + cross-session)
  const evidenceCounts = getEvidenceCounts();

  // Count how many required signals have evidence
  let metSignals = 0;
  for (const signal of requirements.signals) {
    if ((evidenceCounts[signal] ?? 0) > 0) {
      metSignals++;
    }
  }

  log.debug({ currentTier, nextTier, metSignals, required: requirements.minCount }, 'Evaluating tier progression');

  // Check if threshold met
  if (metSignals >= requirements.minCount) {
    const advanced = advanceTier(nextTier);
    if (advanced) {
      log.info({ from: currentTier, to: nextTier, metSignals }, 'Tier advanced');
      broadcastTierUnlocked(nextTier);
      return nextTier;
    }
  }

  return null;
}

/**
 * Full tier evaluation: evaluate metric signals, then check for tier advancement.
 * Called periodically (e.g., after session complete or on app startup).
 */
export function evaluateTierOnSessionComplete(): FluencyTier | null {
  try {
    // First, record any newly-met metric-based signals
    evaluateMetricSignals();
    
    // Then, check if we can advance to the next tier
    return evaluateTierProgression();
  } catch (error) {
    log.error({ err: error }, 'Error evaluating tier progression');
    return null;
  }
}

// ============================================================================
// Tier Progress for UI
// ============================================================================

export interface TierProgressData {
  currentTier: FluencyTier;
  nextTier: FluencyTier | null;
  /** Signals required for next tier */
  requiredSignals: EvidenceSignal[];
  /** Signals from next tier requirements that user has earned */
  earnedSignals: EvidenceSignal[];
  /** Number of signals still needed */
  signalsNeeded: number;
  /** Minimum count required for next tier */
  minCount: number;
}

/**
 * Get progress toward the next tier for UI display.
 * Returns null if already at max tier.
 */
export function getTierProgress(): TierProgressData | null {
  const { tier: currentTier } = getCurrentTier();
  const currentIndex = TIER_ORDER.indexOf(currentTier);
  
  // Already at max tier
  if (currentIndex < 0 || currentIndex >= TIER_ORDER.length - 1) {
    return null;
  }
  
  const nextTier = TIER_ORDER[currentIndex + 1];
  const requirements = TIER_REQUIREMENTS[nextTier];
  const evidenceCounts = getEvidenceCounts();
  
  // Find which required signals the user has earned
  const earnedSignals: EvidenceSignal[] = [];
  for (const signal of requirements.signals) {
    if ((evidenceCounts[signal] ?? 0) > 0) {
      earnedSignals.push(signal);
    }
  }
  
  const signalsNeeded = Math.max(0, requirements.minCount - earnedSignals.length);
  
  return {
    currentTier,
    nextTier,
    requiredSignals: requirements.signals,
    earnedSignals,
    signalsNeeded,
    minCount: requirements.minCount
  };
}
