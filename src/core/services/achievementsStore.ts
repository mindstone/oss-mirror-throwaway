/**
 * Achievements Store
 *
 * Persists streaks, badges, and evidence using electron-store.
 * Provides the foundation for the gamification system (Phase 1).
 */

import type { KeyValueStore } from '@core/store';
import { getBroadcastService } from '@core/broadcastService';
import { createScopedLogger } from '@core/logger';
import { migrateStore, shouldEnterReadOnlyMode, type VersionedData, type MigrationFn, type MigrationResult } from '../utils/storeMigration';
import { loadStoreSafely, isLoadFailedReadOnly, resolveConfStorePath, safeCreateStore } from '../utils/loadStoreSafely';

const log = createScopedLogger({ service: 'achievementsStore' });

let achievementsReadOnlyMode = false;

// Evidence signals for fluency tier progression
// Split into: Per-session (LLM-detected), Metric-based (instant), Cross-session (weekly)
export type EvidenceSignal =
  // Per-session LLM-detected signals
  | 'voice_interaction'
  | 'multi_turn_conversation'
  | 'skill_used'
  | 'memory_consulted'
  | 'context_provided'
  | 'correction_given'
  | 'delegation_success'
  | 'parallel_execution'
  // Metric-based signals (evaluated from counters/stores, no LLM needed)
  | 'streak_7'
  | 'streak_30'
  | 'voice_comfort'
  | 'tool_diversity'
  | 'workflow_adoption'
  | 'memory_usage'
  | 'automation_active'
  | 'time_saved_10h'
  // Cross-session signals (weekly assessment)
  | 'technique_consistency'
  | 'increasing_complexity'
  | 'high_efficiency_pattern';

// Fluency tiers (from the gamification plan)
export type FluencyTier = 'explorer' | 'practitioner' | 'collaborator' | 'orchestrator';

export interface EvidenceRecord {
  signal: EvidenceSignal;
  timestamp: number;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface BadgeRecord {
  unlockedAt: number;
  notified: boolean;
}

export interface StreakData {
  current: number;
  longest: number;
  lastActiveDate: string; // YYYY-MM-DD in local time
  freezesUsedThisWeek: number;
  weekStartDate: string; // For resetting freezes weekly
}

export interface OnboardingJourneyState {
  completedDays: number[];
  journeyStartedAt?: number;
  graduationModalShown?: boolean;
}

export type AchievementsStoreState = {
  version: number;
  
  // Streaks
  streaks: StreakData;
  
  // Badges (badgeId -> record)
  badges: Record<string, BadgeRecord>;
  
  // Evidence for tier progression
  evidence: {
    collected: EvidenceRecord[];
    bySignal: Record<string, EvidenceRecord[]>;
  };
  
  // Fluency tier
  tier: {
    current: FluencyTier;
    unlockedAt: number;
    progressEvidence: EvidenceRecord[];
  };
  
  // 14-day onboarding journey progress
  onboarding: OnboardingJourneyState;
  
  // Cumulative counters for badge evaluation
  counters: {
    totalSessions: number;
    voiceSessions: number;
    weekendSessions: number;
    totalTimeSavedMinutes: number;
    // New counters for badge expansion
    nightSessions: number;
    totalMemoryWrites: number;
    totalSkillInvocations: number;
    totalAutomationsCreated: number;
  };
};

// Helper: Get local date string (YYYY-MM-DD)
export const getLocalDateString = (timestamp: number = Date.now()): string => {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Helper: Get week start date (Monday)
const getWeekStartDate = (date: Date = new Date()): string => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return getLocalDateString(d.getTime());
};

const CURRENT_STORE_VERSION = 3;

const createDefaultState = (): AchievementsStoreState => ({
  version: CURRENT_STORE_VERSION,
  streaks: {
    current: 0,
    longest: 0,
    lastActiveDate: '',
    freezesUsedThisWeek: 0,
    weekStartDate: getWeekStartDate()
  },
  badges: {},
  evidence: {
    collected: [],
    bySignal: {}
  },
  tier: {
    current: 'explorer',
    unlockedAt: Date.now(),
    progressEvidence: []
  },
  onboarding: {
    completedDays: [],
    journeyStartedAt: undefined
  },
  counters: {
    totalSessions: 0,
    voiceSessions: 0,
    weekendSessions: 0,
    totalTimeSavedMinutes: 0,
    nightSessions: 0,
    totalMemoryWrites: 0,
    totalSkillInvocations: 0,
    totalAutomationsCreated: 0
  }
});

// NOTE: keys are the FROM version. `runMigrations` looks up `migrations[v]` for
// each step `v -> v+1`, so to migrate v1->v3 it needs keys {1, 2}. These were
// previously mis-keyed {2, 3} (an off-by-one): a v1 store threw "Missing
// migration from v1 to v2" (silently reset pre-fix; read-only post-fix) and a
// v2 store ran the v1->v2 fn instead of v2->v3. Corrected to {1, 2}.
const ACHIEVEMENTS_MIGRATIONS: Record<number, MigrationFn<VersionedData>> = {
  // v1 -> v2: Add onboarding and counters fields
  1: (data: VersionedData) => {
    const state = data as unknown as AchievementsStoreState;
    return {
      ...state,
      version: 2,
      onboarding: state.onboarding ?? { completedDays: [], journeyStartedAt: undefined },
      counters: state.counters ?? {
        totalSessions: 0,
        voiceSessions: 0,
        weekendSessions: 0,
        totalTimeSavedMinutes: 0
      }
    } as unknown as VersionedData;
  },
  // v2 -> v3: Add new counters for badge expansion
  2: (data: VersionedData) => {
    const state = data as unknown as AchievementsStoreState;
    return {
      ...state,
      version: 3,
      counters: {
        ...state.counters,
        nightSessions: (state.counters as Record<string, number>).nightSessions ?? 0,
        totalMemoryWrites: (state.counters as Record<string, number>).totalMemoryWrites ?? 0,
        totalSkillInvocations: (state.counters as Record<string, number>).totalSkillInvocations ?? 0,
        totalAutomationsCreated: (state.counters as Record<string, number>).totalAutomationsCreated ?? 0
      }
    } as unknown as VersionedData;
  }
};

let _store: KeyValueStore<AchievementsStoreState> | null = null;
let _initialized = false;
const getStore = () => {
  if (!_store) {
    // Guard CONSTRUCTION: conf throws at construct time when the backing file is
    // corrupt. `safeCreateStore` preserves+backs up the raw file, latches an
    // ephemeral read-only store, and never crashes init.
    const created = safeCreateStore<AchievementsStoreState>(
      { name: 'achievements', defaults: createDefaultState() },
      createDefaultState(),
    );
    _store = created.store;
    if (created.loadFailed) {
      achievementsReadOnlyMode = true;
      _initialized = true; // construction itself failed; no further migrate.
    }
  }
  if (!_initialized) {
    _initialized = true;
    const store = _store;
    // Guard the `.store` read + migrate: a thrown load (corrupt JSON / schema /
    // decrypt / transient IO) must NEVER reset+persist over real data — and must
    // not crash init. Classify ENOENT (fresh init) vs existing-but-unreadable
    // (preserve raw + back up + latch read-only).
    const guarded = loadStoreSafely<MigrationResult<VersionedData>>(
      'achievements',
      resolveConfStorePath('achievements'),
      () =>
        migrateStore(store.store as unknown as VersionedData, {
          storeName: 'achievements',
          currentVersion: CURRENT_STORE_VERSION,
          migrations: ACHIEVEMENTS_MIGRATIONS,
          createDefault: createDefaultState as unknown as () => VersionedData
        }),
      // Consumed only on `absent` (genuine fresh init → writable); `load-failed`
      // short-circuits before reading shouldPersist.
      () => ({
        data: createDefaultState() as unknown as VersionedData,
        status: 'fresh' as const,
        fromVersion: null,
        toVersion: CURRENT_STORE_VERSION,
        backupPath: null,
        shouldPersist: true,
      }),
    );

    if (isLoadFailedReadOnly(guarded)) {
      achievementsReadOnlyMode = true;
    } else {
      const migrationResult = guarded.data;
      if (migrationResult.shouldPersist && migrationResult.status !== 'future_version') {
        store.store = migrationResult.data as unknown as AchievementsStoreState;
        log.info(
          { status: migrationResult.status, fromVersion: migrationResult.fromVersion, toVersion: migrationResult.toVersion },
          'Achievements store initialized'
        );
      }
      // Read-only on future_version AND corrupted: a corrupted migration runs on
      // in-memory defaults while the real data stays on disk; later writes must be
      // blocked so they can't clobber it with defaults.
      achievementsReadOnlyMode = shouldEnterReadOnlyMode(migrationResult);
      if (migrationResult.status === 'future_version') {
        log.warn(
          { dataVersion: migrationResult.fromVersion, currentVersion: CURRENT_STORE_VERSION },
          'Achievements data from newer version, entering read-only mode'
        );
      }
    }
  }
  return _store;
};

/**
 * Read-only check that GUARANTEES the store has been loaded/migrated first.
 *
 * `achievementsReadOnlyMode` defaults to `false` and is only set during
 * `getStore()`'s one-time init. A writer that checks the bare flag as the FIRST
 * touch (no prior read) would see a stale `false` and bypass the
 * corrupted/future-version guard — wiping a real on-disk store. Calling
 * `getStore()` here forces init (which sets the flag) before we read it, making
 * every guard first-touch-safe by construction.
 */
const isAchievementsReadOnly = (): boolean => {
  getStore();
  return achievementsReadOnlyMode;
};

// ============================================================================
// Getters
// ============================================================================

export function getStreakData(): StreakData {
  return getStore().store.streaks;
}

export function getBadges(): Record<string, BadgeRecord> {
  return getStore().store.badges;
}

export function getCurrentTier(): { tier: FluencyTier; unlockedAt: number } {
  const { current, unlockedAt } = getStore().store.tier;
  return { tier: current, unlockedAt };
}

/**
 * Get current tier with evidence that contributed to it.
 * Used by Evidence Gallery UI to show "why you earned this tier".
 */
export function getTierEvidence(): { tier: FluencyTier; unlockedAt: number; evidence: EvidenceRecord[] } {
  const { current, unlockedAt, progressEvidence } = getStore().store.tier;
  return { tier: current, unlockedAt, evidence: progressEvidence };
}

// ============================================================================
// Streak Management
// ============================================================================

/**
 * Update streak based on activity.
 * Called when a session is completed.
 * Returns the new streak value and whether a milestone was reached.
 */
export function updateStreak(activeDate: string): { newStreak: number; milestone: number | null } {
  if (isAchievementsReadOnly()) {
    log.warn('Achievements store is in read-only mode, skipping streak update');
    return { newStreak: getStreakData().current, milestone: null };
  }

  const state = getStore().store;
  const { lastActiveDate, current, longest, freezesUsedThisWeek, weekStartDate } = state.streaks;
  
  // Already counted today
  if (lastActiveDate === activeDate) {
    return { newStreak: current, milestone: null };
  }
  
  // Check if we need to reset weekly freeze counter
  const currentWeekStart = getWeekStartDate();
  const shouldResetFreezes = weekStartDate !== currentWeekStart;
  
  // Calculate yesterday's date (DST-safe using calendar math, not milliseconds)
  const getYesterdayDateString = (): string => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return getLocalDateString(d.getTime());
  };
  const yesterday = getYesterdayDateString();
  const isConsecutive = lastActiveDate === yesterday;
  
  let newStreak: number;
  if (isConsecutive) {
    newStreak = current + 1;
  } else if (lastActiveDate === '') {
    // First ever activity
    newStreak = 1;
  } else {
    // Streak broken - start fresh
    newStreak = 1;
  }
  
  const newLongest = Math.max(newStreak, longest);
  
  getStore().set('streaks', {
    current: newStreak,
    longest: newLongest,
    lastActiveDate: activeDate,
    freezesUsedThisWeek: shouldResetFreezes ? 0 : freezesUsedThisWeek,
    weekStartDate: currentWeekStart
  });
  
  log.info({ newStreak, newLongest, activeDate }, 'Streak updated');
  
  // Check for milestone
  const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100, 365];
  const milestone = STREAK_MILESTONES.includes(newStreak) ? newStreak : null;
  
  return { newStreak, milestone };
}

// ============================================================================
// Badge Management
// ============================================================================

// Valid badge ID pattern - alphanumeric, underscores, hyphens only
const VALID_BADGE_ID_PATTERN = /^[a-z0-9_-]+$/i;

function isValidBadgeId(badgeId: string): boolean {
  return VALID_BADGE_ID_PATTERN.test(badgeId) && badgeId.length > 0 && badgeId.length <= 64;
}

/**
 * Unlock a badge. Returns true if newly unlocked, false if already had.
 */
export function unlockBadge(badgeId: string): boolean {
  if (isAchievementsReadOnly()) return false;
  
  if (!isValidBadgeId(badgeId)) {
    log.warn({ badgeId }, 'Invalid badge ID rejected');
    return false;
  }
  
  const badges = getStore().store.badges;
  if (badges[badgeId]) {
    return false; // Already unlocked
  }
  
  getStore().set('badges', {
    ...badges,
    [badgeId]: {
      unlockedAt: Date.now(),
      notified: false,
    },
  });
  
  log.info({ badgeId }, 'Badge unlocked');
  return true;
}

/**
 * Mark a badge as notified (user has seen the toast).
 */
export function markBadgeNotified(badgeId: string): void {
  if (isAchievementsReadOnly()) return;
  
  if (!isValidBadgeId(badgeId)) {
    log.warn({ badgeId }, 'Invalid badge ID rejected');
    return;
  }
  
  const badges = getStore().store.badges;
  if (badges[badgeId]) {
    getStore().set('badges', {
      ...badges,
      [badgeId]: {
        ...badges[badgeId],
        notified: true,
      },
    });
  }
}

/**
 * Get the next badge that hasn't been notified yet.
 */
export function getNextUnnotifiedBadge(): string | null {
  const badges = getStore().store.badges;
  for (const [badgeId, record] of Object.entries(badges)) {
    if (!record.notified) {
      return badgeId;
    }
  }
  return null;
}

// ============================================================================
// Evidence & Tier Management
// ============================================================================

/**
 * Record evidence of AI fluency behavior.
 */
export function recordEvidence(signal: EvidenceSignal, sessionId?: string, metadata?: Record<string, unknown>): void {
  if (isAchievementsReadOnly()) return;
  
  const record: EvidenceRecord = {
    signal,
    timestamp: Date.now(),
    sessionId,
    metadata
  };
  
  const state = getStore().store;
  
  // Max evidence records to prevent unbounded growth (similar to timeSavedStore pattern)
  const MAX_EVIDENCE_RECORDS = 5000;
  const MAX_PER_SIGNAL = 1000;
  
  // Add to collected (with pruning)
  const collected = [...state.evidence.collected, record].slice(-MAX_EVIDENCE_RECORDS);
  
  // Add to bySignal index (with per-signal pruning)
  const bySignal = { ...state.evidence.bySignal };
  bySignal[signal] = [...(bySignal[signal] ?? []), record].slice(-MAX_PER_SIGNAL);
  
  getStore().set('evidence', { collected, bySignal });
  
  log.debug({ signal, sessionId }, 'Evidence recorded');
}

/**
 * Get evidence counts by signal type.
 */
export function getEvidenceCounts(): Record<EvidenceSignal, number> {
  const bySignal = getStore().store.evidence.bySignal;
  const counts: Record<string, number> = {};
  
  for (const [signal, records] of Object.entries(bySignal)) {
    counts[signal] = records.length;
  }
  
  return counts as Record<EvidenceSignal, number>;
}

/**
 * Advance to the next fluency tier.
 */
export function advanceTier(newTier: FluencyTier): boolean {
  if (isAchievementsReadOnly()) return false;
  
  const TIER_ORDER: FluencyTier[] = ['explorer', 'practitioner', 'collaborator', 'orchestrator'];
  const currentTier = getStore().store.tier.current;
  const currentIndex = TIER_ORDER.indexOf(currentTier);
  const newIndex = TIER_ORDER.indexOf(newTier);
  
  if (newIndex <= currentIndex) {
    return false; // Can't go backwards
  }
  
  getStore().set('tier', {
    current: newTier,
    unlockedAt: Date.now(),
    progressEvidence: getStore().store.evidence.collected.slice(-50) // Keep last 50 as context
  });
  
  log.info({ from: currentTier, to: newTier }, 'Tier advanced');
  return true;
}

// ============================================================================
// Session Completion Hook
// ============================================================================

/**
 * Broadcast a streak update to all renderer windows.
 * @param milestone - If set, this is a milestone achievement
 */
function broadcastStreakUpdate(milestone: number | null): void {
  getBroadcastService().sendToAllWindows('achievements:streak-updated', getStreakData());
  if (milestone !== null) {
    getBroadcastService().sendToAllWindows('achievements:streak-milestone', milestone);
    log.info({ milestone }, 'Streak milestone broadcast');
  }
}

/**
 * Called when a session/turn completes to update streak.
 * Broadcasts update to renderer (and milestone toast if applicable).
 */
export function updateStreakOnSessionComplete(): void {
  try {
    const today = getLocalDateString();
    const { milestone } = updateStreak(today);
    broadcastStreakUpdate(milestone);
  } catch (error) {
    // Don't let achievements errors disrupt the turn pipeline
    log.error({ err: error }, 'Failed to update streak on session complete');
  }
}

// ============================================================================
// Onboarding Journey Management
// ============================================================================

const DEFAULT_ONBOARDING: OnboardingJourneyState = { completedDays: [], journeyStartedAt: undefined };

function getSafeOnboarding(): OnboardingJourneyState {
  const onboarding = getStore().store.onboarding;
  if (!onboarding || !Array.isArray(onboarding.completedDays)) {
    log.warn('Onboarding state missing or malformed, returning default');
    return DEFAULT_ONBOARDING;
  }
  return onboarding;
}

/**
 * Get onboarding journey state.
 */
export function getOnboardingJourney(): OnboardingJourneyState {
  return getSafeOnboarding();
}

/**
 * Start the 14-day onboarding journey.
 */
export function startOnboardingJourney(): void {
  if (isAchievementsReadOnly()) return;
  
  const onboarding = getSafeOnboarding();
  if (onboarding.journeyStartedAt) {
    log.debug('Onboarding journey already started');
    return;
  }
  
  getStore().set('onboarding', {
    ...onboarding,
    journeyStartedAt: Date.now(),
  });
  log.info('Onboarding journey started');
}

/**
 * Mark a journey day as complete.
 * Returns true if newly completed, false if already completed.
 */
export function markJourneyDayComplete(day: number): boolean {
  if (isAchievementsReadOnly()) return false;
  
  if (day < 1 || day > 14) {
    log.warn({ day }, 'Invalid journey day');
    return false;
  }
  
  const onboarding = getSafeOnboarding();
  if (onboarding.completedDays.includes(day)) {
    return false; // Already completed
  }
  
  const completedDays = [...onboarding.completedDays, day].sort((a, b) => a - b);
  getStore().set('onboarding', {
    ...onboarding,
    completedDays,
  });
  
  log.info({ day, completedDays }, 'Journey day marked complete');
  broadcastJourneyUpdate(day);
  return true;
}

/**
 * Check if a journey day is completed.
 */
export function isJourneyDayComplete(day: number): boolean {
  return getSafeOnboarding().completedDays.includes(day);
}

/**
 * Check if graduation modal should be shown.
 * True if day 14 is complete and modal hasn't been shown yet.
 */
export function shouldShowGraduation(): boolean {
  const onboarding = getSafeOnboarding();
  return onboarding.completedDays.includes(14) && !onboarding.graduationModalShown;
}

/**
 * Mark graduation modal as shown.
 */
export function markGraduationShown(): void {
  if (isAchievementsReadOnly()) return;
  
  const onboarding = getSafeOnboarding();
  getStore().set('onboarding', {
    ...onboarding,
    graduationModalShown: true,
  });
  log.info('Graduation modal marked as shown');
}

/**
 * Broadcast journey day completion to renderer.
 */
function broadcastJourneyUpdate(day: number): void {
  getBroadcastService().sendToAllWindows('achievements:journey-day-completed', day);
}

// ============================================================================
// Counter Management (for badge evaluation)
// ============================================================================

/**
 * Get current counters.
 */
export function getCounters(): AchievementsStoreState['counters'] {
  return getStore().store.counters;
}

/**
 * Increment session counter and check for session-based badges.
 */
export function incrementSessionCount(isWeekend: boolean): void {
  if (isAchievementsReadOnly()) return;
  
  const counters = getStore().store.counters;
  const newTotal = counters.totalSessions + 1;
  const newWeekend = isWeekend ? counters.weekendSessions + 1 : counters.weekendSessions;
  
  getStore().set('counters', {
    ...counters,
    totalSessions: newTotal,
    ...(isWeekend ? { weekendSessions: newWeekend } : {}),
  });
  
  log.debug({ totalSessions: newTotal, weekendSessions: newWeekend }, 'Session counter incremented');
}

/**
 * Increment voice session counter.
 */
export function incrementVoiceSessionCount(): void {
  if (isAchievementsReadOnly()) return;
  
  const counters = getStore().store.counters;
  const newCount = counters.voiceSessions + 1;
  getStore().set('counters', {
    ...counters,
    voiceSessions: newCount,
  });
  log.debug({ voiceSessions: newCount }, 'Voice session counter incremented');
}

/**
 * Add to total time saved.
 */
export function addTimeSaved(minutes: number): void {
  if (isAchievementsReadOnly()) return;
  
  const counters = getStore().store.counters;
  const newTotal = counters.totalTimeSavedMinutes + minutes;
  getStore().set('counters', {
    ...counters,
    totalTimeSavedMinutes: newTotal,
  });
  log.debug({ totalTimeSavedMinutes: newTotal, added: minutes }, 'Time saved updated');
}

/**
 * Increment night session counter (for sessions between midnight-4am).
 */
export function incrementNightSessionCount(): void {
  if (isAchievementsReadOnly()) return;
  
  const counters = getStore().store.counters;
  const newCount = counters.nightSessions + 1;
  getStore().set('counters', {
    ...counters,
    nightSessions: newCount,
  });
  log.debug({ nightSessions: newCount }, 'Night session counter incremented');
}

/**
 * Increment memory write counter.
 */
export function incrementMemoryWriteCount(): void {
  if (isAchievementsReadOnly()) return;
  
  const counters = getStore().store.counters;
  const newCount = counters.totalMemoryWrites + 1;
  getStore().set('counters', {
    ...counters,
    totalMemoryWrites: newCount,
  });
  log.debug({ totalMemoryWrites: newCount }, 'Memory write counter incremented');
}

/**
 * Increment skill invocation counter.
 */
export function incrementSkillInvocationCount(): void {
  if (isAchievementsReadOnly()) return;
  
  const counters = getStore().store.counters;
  const newCount = counters.totalSkillInvocations + 1;
  getStore().set('counters', {
    ...counters,
    totalSkillInvocations: newCount,
  });
  log.debug({ totalSkillInvocations: newCount }, 'Skill invocation counter incremented');
}

/**
 * Increment automation created counter.
 */
export function incrementAutomationCreatedCount(): void {
  if (isAchievementsReadOnly()) return;
  
  const counters = getStore().store.counters;
  const newCount = counters.totalAutomationsCreated + 1;
  getStore().set('counters', {
    ...counters,
    totalAutomationsCreated: newCount,
  });
  log.debug({ totalAutomationsCreated: newCount }, 'Automation created counter incremented');
}

// ============================================================================
// Badge Broadcasting
// ============================================================================

/**
 * Broadcast badge unlock to renderer for toast notification.
 */
export function broadcastBadgeUnlocked(badgeId: string): void {
  getBroadcastService().sendToAllWindows('achievements:badge-unlocked', badgeId);
  log.info({ badgeId }, 'Badge unlock broadcast');
}

// ============================================================================
// Tier Broadcasting
// ============================================================================

/**
 * Broadcast tier unlock to renderer for UI update/celebration.
 */
export function broadcastTierUnlocked(tier: FluencyTier): void {
  getBroadcastService().sendToAllWindows('achievements:tier-unlocked', tier);
  log.info({ tier }, 'Tier unlock broadcast');
}

/**
 * Reset only the onboarding journey state.
 * Used by Settings > "Restart full onboarding" to clear journey progress
 * without losing badges, streaks, or other achievements.
 */
export function resetOnboardingJourney(): void {
  if (isAchievementsReadOnly()) return;
  
  getStore().set('onboarding', {
    completedDays: [],
    journeyStartedAt: undefined,
    graduationModalShown: undefined
  });
  log.info('Onboarding journey reset');
}
