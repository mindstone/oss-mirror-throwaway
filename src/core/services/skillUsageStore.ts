/**
 * Skill Usage Store
 *
 * Tracks which skills each user uses most frequently.
 * Used for:
 * - "Skills for you" personalization
 * - skill_personalization_opportunity coaching (3+ uses threshold)
 * - Thank you board (skill contributors)
 *
 * Key features:
 * - Persistent tracking via electron-store
 * - Demo mode support
 * - Session-level tracking (which skills used per session)
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import {
  SKILL_USAGE_STORE_VERSION,
  MAX_TRACKED_SKILLS,
  SKILL_STALENESS_DAYS
} from '../constants';
import { migrateStore, shouldEnterReadOnlyMode, type VersionedData, type MigrationFn } from '../utils/storeMigration';
import { classifyLoadFailure, resolveConfStorePath } from '../utils/loadStoreSafely';

const log = createScopedLogger({ service: 'skillUsage' });

// ============================================================================
// Types
// ============================================================================

/**
 * Individual skill usage record
 */
export interface SkillUsageRecord {
  /** Skill name (e.g., "meeting-external-prep") */
  skillName: string;
  /** Number of times skill was invoked */
  usageCount: number;
  /** Timestamp of last usage */
  lastUsedAt: number;
  /** Timestamp of first usage */
  firstUsedAt: number;
  /** Session IDs where skill was used (for context) */
  recentSessionIds: string[];
  /** Timestamp when the last improvement nudge was shown (for throttling) */
  lastNudgeShownAt?: number;
}

/**
 * Store shape for electron-store
 */
interface SkillUsageStoreShape extends VersionedData {
  version: number;
  skills: SkillUsageRecord[];
  lastUpdatedAt: number;
  /** Version of the backfill that has completed (bumped when extraction logic changes) */
  backfillVersion?: number;
}

// ============================================================================
// Default State
// ============================================================================

const createDefaultSkillUsageState = (): SkillUsageStoreShape => ({
  version: SKILL_USAGE_STORE_VERSION,
  skills: [],
  lastUpdatedAt: Date.now()
});

// ============================================================================
// Migrations
// ============================================================================

// NOTE: keys are the FROM version. `runMigrations` looks up `migrations[v]` for
// each step `v -> v+1`, so the v1->v2 step must be keyed `1` (not `2`). This was
// previously mis-keyed `2` (the same off-by-one as achievements): a v1 store
// threw "Missing migration from v1 to v2". Corrected to `1`. The migration also
// now bumps `version` so the framework's post-step version check is satisfied.
const SKILL_USAGE_MIGRATIONS: Record<number, MigrationFn<SkillUsageStoreShape>> = {
  // v1 -> v2: Add lastNudgeShownAt field to each skill record
  1: (data) => {
    const skills = (data as { skills?: unknown[] }).skills;
    if (Array.isArray(skills)) {
      for (const skill of skills) {
        if (skill && typeof skill === 'object' && !('lastNudgeShownAt' in skill)) {
          (skill as Record<string, unknown>).lastNudgeShownAt = undefined;
        }
      }
    }
    return { ...data, version: 2 };
  },
};

// ============================================================================
// Data Normalization
// ============================================================================

const normalizeSkillRecord = (record: unknown): SkillUsageRecord | null => {
  if (!record || typeof record !== 'object') return null;

  const r = record as Record<string, unknown>;
  if (typeof r.skillName !== 'string' || r.skillName.trim().length === 0) return null;
  if (typeof r.usageCount !== 'number' || r.usageCount < 0) return null;

  let recentSessionIds: string[] = [];
  if (Array.isArray(r.recentSessionIds)) {
    recentSessionIds = r.recentSessionIds
      .filter((s): s is string => typeof s === 'string')
      .slice(-10); // Keep only last 10 sessions
  }

  return {
    skillName: r.skillName.trim(),
    usageCount: Math.floor(r.usageCount),
    lastUsedAt: typeof r.lastUsedAt === 'number' ? r.lastUsedAt : Date.now(),
    firstUsedAt: typeof r.firstUsedAt === 'number' ? r.firstUsedAt : Date.now(),
    recentSessionIds,
    lastNudgeShownAt: typeof r.lastNudgeShownAt === 'number' ? r.lastNudgeShownAt : undefined,
  };
};

const normalizeStoreShape = (data: unknown): SkillUsageStoreShape => {
  if (!data || typeof data !== 'object') {
    return createDefaultSkillUsageState();
  }

  const d = data as Record<string, unknown>;
  const skills = Array.isArray(d.skills)
    ? d.skills.map(normalizeSkillRecord).filter((s): s is SkillUsageRecord => s !== null)
    : [];

  return {
    version: typeof d.version === 'number' ? d.version : SKILL_USAGE_STORE_VERSION,
    skills,
    lastUpdatedAt: typeof d.lastUpdatedAt === 'number' ? d.lastUpdatedAt : Date.now(),
    ...(typeof d.backfillVersion === 'number' ? { backfillVersion: d.backfillVersion } : {})
  };
};

// ============================================================================
// Store Instance
// ============================================================================

let _store: KeyValueStore<SkillUsageStoreShape> | null = null;
const getStore = () => _store ??= createStore<SkillUsageStoreShape>({
  name: 'skill-usage',
  defaults: createDefaultSkillUsageState()
});

let skillUsageReadOnlyMode = false;
// Set true once load/migration has run, so the read-only flag is known to be
// authoritative. Lets `isSkillUsageReadOnly()` force a one-time load on a
// first-touch write without re-migrating on every subsequent save.
let _skillUsageMigrationRan = false;

// ============================================================================
// Internal Load/Save
// ============================================================================

const loadSkillUsageInternal = (): SkillUsageStoreShape => {
  try {
    // Pass the RAW store data to `migrateStore` — do NOT normalize/manufacture a
    // version first. Normalizing ahead of migration would stamp the current
    // version onto present-but-unversioned REAL data, hiding it from the
    // hardened Case 2 (which classifies empty `{}` as fresh-init vs. non-empty
    // version-less data as corrupted/read-only) and leaving it writable so a
    // later save could overwrite it. Let migrateStore classify, then normalize.
    const raw = getStore().store;

    const migrationResult = migrateStore(raw as VersionedData, {
      storeName: 'skill-usage',
      currentVersion: SKILL_USAGE_STORE_VERSION,
      migrations: SKILL_USAGE_MIGRATIONS as unknown as Record<number, MigrationFn<VersionedData>>,
      createDefault: createDefaultSkillUsageState as () => VersionedData
    });

    skillUsageReadOnlyMode = shouldEnterReadOnlyMode(migrationResult);
    _skillUsageMigrationRan = true;

    const normalized = normalizeStoreShape(migrationResult.data);

    // Persist the normalized/migrated shape only when safe (never for
    // future_version or corrupted — those preserve the on-disk data).
    if (migrationResult.shouldPersist && !skillUsageReadOnlyMode) {
      getStore().store = normalized;
    }

    return normalized;
  } catch (err) {
    // NEVER reset+persist over real on-disk data. Classify ENOENT (fresh init)
    // vs existing-but-unreadable (preserve raw + back up + latch read-only).
    // Set the migration-ran flag so the read-only latch is authoritative for
    // first-touch writers.
    _skillUsageMigrationRan = true;
    const classified = classifyLoadFailure('skill-usage', resolveConfStorePath('skill-usage'), err);
    if (classified.outcome === 'load-failed') {
      skillUsageReadOnlyMode = true;
    }
    return createDefaultSkillUsageState();
  }
};

/**
 * Read-only check that GUARANTEES load/migration has run first. A writer that
 * read the raw `skillUsageReadOnlyMode` as the FIRST touch (no prior read) would
 * see a stale `false` and clobber real, un-migrated data. Use in EVERY writer.
 */
const isSkillUsageReadOnly = (): boolean => {
  if (!_skillUsageMigrationRan) {
    loadSkillUsageInternal();
  }
  return skillUsageReadOnlyMode;
};

const saveSkillUsageInternal = (state: SkillUsageStoreShape): boolean => {
  // Ensure load/migration has run so the read-only flag is authoritative before
  // we check it (first-touch-safe by construction; no recursion — load never
  // calls save).
  if (isSkillUsageReadOnly()) {
    log.debug('Skill usage store in read-only mode, skipping save');
    return false;
  }

  try {
    getStore().store = state;
    return true;
  } catch (err) {
    log.error({ error: err }, 'Failed to save skill usage store');
    return false;
  }
};

// ============================================================================
// Pruning
// ============================================================================

const pruneSkills = (skills: SkillUsageRecord[]): SkillUsageRecord[] => {
  if (skills.length <= MAX_TRACKED_SKILLS) {
    return skills;
  }

  const sorted = [...skills].sort((a, b) => {
    if (b.usageCount !== a.usageCount) {
      return b.usageCount - a.usageCount;
    }
    return b.lastUsedAt - a.lastUsedAt;
  });

  const pruned = sorted.slice(0, MAX_TRACKED_SKILLS);
  log.debug({ before: skills.length, after: pruned.length }, 'Pruned skill usage store');
  return pruned;
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Record a skill usage event.
 *
 * @param skillName - Name of the skill (e.g., "meeting-external-prep")
 * @param sessionId - Optional session ID where skill was used
 */
export const recordSkillUsage = (skillName: string, sessionId?: string): void => {
  if (!skillName || typeof skillName !== 'string' || skillName.trim().length === 0) {
    log.warn({ skillName }, 'Invalid skill name, skipping usage recording');
    return;
  }

  const normalizedName = skillName.trim().toLowerCase();
  const now = Date.now();

  const state = loadSkillUsageInternal();
  const existingIndex = state.skills.findIndex(s => s.skillName === normalizedName);

  let nextSkills: SkillUsageRecord[];

  if (existingIndex >= 0) {
    const existing = state.skills[existingIndex];
    const sessionIds = sessionId
      ? [...new Set([...existing.recentSessionIds, sessionId])].slice(-10)
      : existing.recentSessionIds;

    const updated: SkillUsageRecord = {
      ...existing,
      usageCount: existing.usageCount + 1,
      lastUsedAt: now,
      recentSessionIds: sessionIds
    };
    nextSkills = [...state.skills];
    nextSkills[existingIndex] = updated;
    log.debug({ skillName: normalizedName, newCount: updated.usageCount }, 'Updated skill usage count');
  } else {
    const newRecord: SkillUsageRecord = {
      skillName: normalizedName,
      usageCount: 1,
      firstUsedAt: now,
      lastUsedAt: now,
      recentSessionIds: sessionId ? [sessionId] : []
    };
    nextSkills = [...state.skills, newRecord];
    log.debug({ skillName: normalizedName }, 'Added new skill to usage tracking');
  }

  nextSkills = pruneSkills(nextSkills);

  const currentState = loadSkillUsageInternal();
  const nextState: SkillUsageStoreShape = {
    ...currentState,
    version: SKILL_USAGE_STORE_VERSION,
    skills: nextSkills,
    lastUpdatedAt: now
  };

  saveSkillUsageInternal(nextState);
};

/**
 * Get all skill usage records, sorted by usage count (descending).
 */
export const getAllSkillUsage = (): SkillUsageRecord[] => {
  const state = loadSkillUsageInternal();
  return [...state.skills].sort((a, b) => b.usageCount - a.usageCount);
};

/**
 * Get frequently used skills (not stale).
 */
export const getFrequentSkills = (limit: number = 10): SkillUsageRecord[] => {
  const state = loadSkillUsageInternal();
  const staleThreshold = Date.now() - SKILL_STALENESS_DAYS * 24 * 60 * 60 * 1000;

  const activeSkills = state.skills
    .filter(s => s.lastUsedAt > staleThreshold)
    .sort((a, b) => b.usageCount - a.usageCount);

  return activeSkills.slice(0, limit);
};

/**
 * Mark a skill as having been nudged (for throttling improvement nudges).
 */
export const markSkillNudged = (skillName: string): void => {
  if (!skillName || typeof skillName !== 'string') return;
  const normalizedName = skillName.trim().toLowerCase();
  const state = loadSkillUsageInternal();
  const index = state.skills.findIndex(s => s.skillName === normalizedName);
  if (index < 0) return;

  const nextSkills = [...state.skills];
  nextSkills[index] = { ...nextSkills[index], lastNudgeShownAt: Date.now() };
  saveSkillUsageInternal({ ...state, skills: nextSkills, lastUpdatedAt: Date.now() });
};

/** Bump this when extractSkillsUsed logic changes to force re-backfill */
const BACKFILL_VERSION = 2;

/**
 * Check if backfill has been completed at the current version.
 */
export const isSkillUsageBackfillCompleted = (): boolean => {
  const state = loadSkillUsageInternal();
  return (state.backfillVersion ?? 0) >= BACKFILL_VERSION;
};

/**
 * One-time backfill: scan historical sessions and record skill usage.
 * Uses extractSkillsUsed to find skills from messages and tool events.
 * Returns the number of skills whose usage count was updated.
 */
export const backfillSkillUsageFromSessions = (
  sessions: { id: string; messages: unknown[]; eventsByTurn?: Record<string, unknown[]> }[],
  extractSkillsUsed: (session: { id: string; messages: unknown[]; eventsByTurn?: Record<string, unknown[]> }) => string[]
): number => {
  if (isSkillUsageBackfillCompleted()) return 0;

  const state = loadSkillUsageInternal();
  const now = Date.now();
  const skillMap = new Map<string, SkillUsageRecord>();
  for (const s of state.skills) {
    skillMap.set(s.skillName, s);
  }

  let updatedCount = 0;
  for (const session of sessions) {
    const skillsUsed = extractSkillsUsed(session);
    for (const rawName of skillsUsed) {
      if (!rawName || typeof rawName !== 'string' || rawName.trim().length === 0) continue;
      const normalizedName = rawName.trim().toLowerCase();
      const existing = skillMap.get(normalizedName);
      if (existing) {
        const sessionIds = session.id
          ? [...new Set([...existing.recentSessionIds, session.id])].slice(-10)
          : existing.recentSessionIds;
        skillMap.set(normalizedName, {
          ...existing,
          usageCount: existing.usageCount + 1,
          lastUsedAt: now,
          recentSessionIds: sessionIds,
        });
      } else {
        skillMap.set(normalizedName, {
          skillName: normalizedName,
          usageCount: 1,
          firstUsedAt: now,
          lastUsedAt: now,
          recentSessionIds: session.id ? [session.id] : [],
        });
      }
      updatedCount++;
    }
  }

  const nextSkills = pruneSkills([...skillMap.values()]);
  saveSkillUsageInternal({
    ...state,
    version: SKILL_USAGE_STORE_VERSION,
    skills: nextSkills,
    lastUpdatedAt: now,
    backfillVersion: BACKFILL_VERSION,
  });

  if (updatedCount > 0) {
    log.info({ updatedCount, sessionCount: sessions.length }, 'Backfilled skill usage from historical sessions');
  }
  return updatedCount;
};

