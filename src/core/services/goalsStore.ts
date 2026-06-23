/**
 * Goals Store (Focus Surface)
 *
 * Persists goals with CRUD operations, frontmatter migration, and
 * write-through projection. The store is the source of truth;
 * frontmatter is a derived view for backward compatibility with agent prompts.
 *
 * Key design decisions:
 * - CRUD mutations do NOT update lastReviewedAt — only markGoalsReviewed() does
 * - Frontmatter projection writes only active goals (not completed/dropped)
 * - WOOP fields are not projected to frontmatter (simplified view: {goal, why?})
 * - Async mutex serializes migration and write-through operations
 * - writeFileAtomic is injected (lives in src/main/) to keep core platform-agnostic
 *
 * @see docs/plans/260406_focus_phase2_surface_shell.md
 * @see src/core/goalTypes.ts
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import type { Goal, GoalsStoreData, CreateGoalInput, UpdateGoalInput } from '@core/goalTypes';
import { randomUUID } from 'node:crypto';
// TODO: node:fs/path usage matches existing core services (mcpConfigManager, bulkExportCore, etc.)
// but should eventually be injected for mobile/cloud surface compatibility.
import fs from 'node:fs/promises';
import path from 'node:path';
import fm from 'front-matter';

const log = createScopedLogger({ service: 'goalsStore' });

const STORE_DEFAULTS: GoalsStoreData = {
  goals: [],
  lastWeeklyReview: null,
  lastMonthlyReview: null,
  migratedFromFrontmatterAt: null,
};

let _store: KeyValueStore<GoalsStoreData> | null = null;
let _writeMutex: Promise<void> = Promise.resolve();

function getStore(): KeyValueStore<GoalsStoreData> {
  if (!_store) {
    _store = createStore<GoalsStoreData>({
      name: 'focus-goals',
      defaults: STORE_DEFAULTS,
    });
  }
  return _store;
}

// ─── CRUD ──────────────────────────────────────────────────────────────

/**
 * Returns all goals (active, completed, and dropped).
 * @deprecated Use spaceGoalsReader instead. Goals now live in space README frontmatter.
 * @see src/core/services/spaceGoalsReader.ts
 * @see docs/plans/260407_focus_goals_redesign.md
 */
export function getGoals(): Goal[] {
  return getStore().get('goals') ?? [];
}

/**
 * Returns store-level metadata (review timestamps, migration status).
 * @deprecated Use spaceGoalsReader instead. Goals now live in space README frontmatter.
 */
export function getStoreMetadata(): Pick<GoalsStoreData, 'lastWeeklyReview' | 'lastMonthlyReview' | 'migratedFromFrontmatterAt'> {
  const store = getStore();
  return {
    lastWeeklyReview: store.get('lastWeeklyReview') ?? null,
    lastMonthlyReview: store.get('lastMonthlyReview') ?? null,
    migratedFromFrontmatterAt: store.get('migratedFromFrontmatterAt') ?? null,
  };
}

/**
 * Creates a new goal with UUID, 'active' status, and timestamps.
 * @deprecated Goals are now edited via conversation. Use spaceGoalsReader for reads.
 */
export function createGoal(input: CreateGoalInput): Goal {
  const store = getStore();
  const now = Date.now();
  const goal: Goal = {
    id: randomUUID(),
    text: input.text,
    why: input.why,
    outcome: input.outcome,
    obstacle: input.obstacle,
    plan: input.plan,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    quarterTag: input.quarterTag,
  };

  const goals = [...(store.get('goals') ?? []), goal];
  store.set('goals', goals);
  log.info({ goalId: goal.id }, 'Created goal');
  return goal;
}

/**
 * Updates mutable fields on a goal and bumps updatedAt.
 * Does NOT update lastReviewedAt — use markGoalsReviewed() for that.
 * @deprecated Goals are now edited via conversation. Use spaceGoalsReader for reads.
 */
export function updateGoal(id: string, input: UpdateGoalInput): Goal | null {
  const store = getStore();
  const goals = [...(store.get('goals') ?? [])];
  const index = goals.findIndex(g => g.id === id);
  if (index === -1) {
    log.warn({ goalId: id }, 'Goal not found for update');
    return null;
  }

  const existing = goals[index];
  const updated: Goal = {
    ...existing,
    ...input,
    id: existing.id,                         // immutable
    createdAt: existing.createdAt,           // immutable
    updatedAt: Date.now(),
    lastReviewedAt: existing.lastReviewedAt, // only markGoalsReviewed() updates this
  };

  goals[index] = updated;
  store.set('goals', goals);
  log.info({ goalId: id }, 'Updated goal');
  return updated;
}

/**
 * Removes a goal by id. Returns true if found and deleted.
 * @deprecated Goals are now edited via conversation. Use spaceGoalsReader for reads.
 */
export function deleteGoal(id: string): boolean {
  const store = getStore();
  const goals = store.get('goals') ?? [];
  const filtered = goals.filter(g => g.id !== id);
  if (filtered.length === goals.length) {
    log.warn({ goalId: id }, 'Goal not found for deletion');
    return false;
  }
  store.set('goals', filtered);
  log.info({ goalId: id }, 'Deleted goal');
  return true;
}

// ─── Review Action ─────────────────────────────────────────────────────

/**
 * Explicit review action — updates lastReviewedAt on all active goals
 * and lastWeeklyReview on the store. This is the ONLY method that
 * touches lastReviewedAt (Phase 1 deferred requirement).
 * @deprecated Use spaceGoalsReader instead. Goals now live in space README frontmatter.
 */
export function markGoalsReviewed(): void {
  const store = getStore();
  const now = Date.now();

  const goals = (store.get('goals') ?? []).map(g =>
    g.status === 'active' ? { ...g, lastReviewedAt: now } : g,
  );
  store.set('goals', goals);
  store.set('lastWeeklyReview', now);

  const activeCount = goals.filter(g => g.status === 'active').length;
  log.info({ activeGoalCount: activeCount }, 'Marked goals reviewed');
}

// ─── Frontmatter Migration ────────────────────────────────────────────

/**
 * Chief-of-Staff README paths to try (canonical first, then lowercase for demo mode).
 */
function getChiefOfStaffPaths(coreDirectory: string): string[] {
  return [
    path.join(coreDirectory, 'Chief-of-Staff', 'README.md'),
    path.join(coreDirectory, 'chief-of-staff', 'README.md'),
  ];
}

/**
 * One-time migration from Chief-of-Staff frontmatter to goals store.
 * Checks migratedFromFrontmatterAt to prevent re-migration.
 * Uses parsing pattern from dashboardHandlers.ts readPersonalGoals().
 * @deprecated Goals now live in space README frontmatter. No migration needed.
 */
export async function migrateFromFrontmatter(
  coreDirectory: string,
): Promise<{ migrated: boolean; goalCount: number }> {
  return serializeFrontmatterOp(async () => {
    const store = getStore();

    // Already migrated — skip
    if (store.get('migratedFromFrontmatterAt') != null) {
      log.debug('Frontmatter already migrated, skipping');
      return { migrated: false, goalCount: 0 };
    }

    // Store already has goals (manual creation before migration) — mark migrated
    const existingGoals = store.get('goals') ?? [];
    if (existingGoals.length > 0) {
      log.debug({ existingCount: existingGoals.length }, 'Store already has goals, marking as migrated');
      store.set('migratedFromFrontmatterAt', Date.now());
      return { migrated: false, goalCount: existingGoals.length };
    }

    // Try to read Chief-of-Staff README
    let content: string | null = null;
    for (const readmePath of getChiefOfStaffPaths(coreDirectory)) {
      try {
        content = await fs.readFile(readmePath, 'utf-8');
        break;
      } catch (err) {
        const isNotFound = err instanceof Error && 'code' in err &&
          (err as NodeJS.ErrnoException).code === 'ENOENT';
        if (!isNotFound) {
          log.warn({ err, path: readmePath }, 'Unexpected error reading Chief-of-Staff README');
        }
      }
    }

    if (!content) {
      log.debug('No Chief-of-Staff README found for migration');
      store.set('migratedFromFrontmatterAt', Date.now());
      return { migrated: true, goalCount: 0 };
    }

    try {
      const parsed = fm<Record<string, unknown>>(content);
      const attrs = parsed.attributes;

      const personalGoals = attrs.personal_goals;
      if (!personalGoals || typeof personalGoals !== 'object') {
        store.set('migratedFromFrontmatterAt', Date.now());
        return { migrated: true, goalCount: 0 };
      }

      const goalsObj = personalGoals as Record<string, unknown>;
      const thisQuarterRaw = goalsObj.this_quarter;

      if (!Array.isArray(thisQuarterRaw) || thisQuarterRaw.length === 0) {
        store.set('migratedFromFrontmatterAt', Date.now());
        return { migrated: true, goalCount: 0 };
      }

      // Parse goals — same filtering as readPersonalGoals in dashboardHandlers.ts
      const now = Date.now();
      const migratedGoals: Goal[] = thisQuarterRaw
        .filter((item): item is Record<string, unknown> =>
          item !== null &&
          typeof item === 'object' &&
          'goal' in item &&
          typeof item.goal === 'string' &&
          (item.goal as string).trim().length > 0,
        )
        .map(item => ({
          id: randomUUID(),
          text: (item.goal as string).trim(),
          why: typeof item.why === 'string' ? item.why.trim() : undefined,
          status: 'active' as const,
          createdAt: now,
          updatedAt: now,
        }));

      if (migratedGoals.length > 0) {
        store.set('goals', migratedGoals);
      }

      // Extract lastReviewed from frontmatter (handle string and Date)
      const lastReviewedRaw = attrs.personal_goals_last_reviewed;
      if (lastReviewedRaw != null) {
        const ts = lastReviewedRaw instanceof Date
          ? lastReviewedRaw.getTime()
          : typeof lastReviewedRaw === 'string'
            ? new Date(lastReviewedRaw).getTime()
            : null;
        if (ts != null && !isNaN(ts)) {
          store.set('lastWeeklyReview', ts);
        }
      }

      store.set('migratedFromFrontmatterAt', Date.now());
      log.info({ goalCount: migratedGoals.length }, 'Migrated goals from frontmatter');
      return { migrated: true, goalCount: migratedGoals.length };
    } catch (error) {
      log.error({ err: error }, 'Failed to parse frontmatter during migration');
      store.set('migratedFromFrontmatterAt', Date.now());
      return { migrated: true, goalCount: 0 };
    }
  });
}

// ─── Frontmatter Write-Through ────────────────────────────────────────

/**
 * Injected dependencies for frontmatter write operations.
 * writeFileAtomic lives in src/main/utils/atomicFs.ts, so it must be
 * injected to keep src/core/ free of Electron-side imports.
 */
export interface FrontmatterWriteDeps {
  writeFileAtomic: (filePath: string, content: string) => Promise<void>;
}

/**
 * Write-through of active-only goals to frontmatter.
 * Only projects active goals (not completed/dropped).
 * Does NOT project WOOP fields (frontmatter is simplified view: {goal, why?}).
 * @deprecated Frontmatter is now the source of truth. No write-through needed.
 */
export async function projectToFrontmatter(
  coreDirectory: string,
  deps: FrontmatterWriteDeps,
): Promise<void> {
  return serializeFrontmatterOp(async () => {
    const activeGoals = getGoals().filter(g => g.status === 'active');

    // Build simplified frontmatter goals (no WOOP fields)
    const frontmatterGoals = activeGoals.map(g => {
      const item: { goal: string; why?: string } = { goal: g.text };
      if (g.why) item.why = g.why;
      return item;
    });

    // Find existing README (or default to canonical path)
    let existingContent: string | null = null;
    let targetPath: string | null = null;

    for (const readmePath of getChiefOfStaffPaths(coreDirectory)) {
      try {
        existingContent = await fs.readFile(readmePath, 'utf-8');
        targetPath = readmePath;
        break;
      } catch {
        // Try next path
      }
    }

    if (!targetPath) {
      targetPath = getChiefOfStaffPaths(coreDirectory)[0];
    }

    // Parse existing frontmatter or start fresh
    let attrs: Record<string, unknown> = {};
    let body = '';

    if (existingContent) {
      try {
        const parsed = fm<Record<string, unknown>>(existingContent);
        attrs = { ...parsed.attributes };
        body = parsed.body;
      } catch {
        // If parse fails, preserve raw content as body
        body = existingContent;
      }
    }

    // Update personal_goals.this_quarter
    const personalGoals = (typeof attrs.personal_goals === 'object' && attrs.personal_goals !== null)
      ? { ...(attrs.personal_goals as Record<string, unknown>) }
      : {};
    personalGoals.this_quarter = frontmatterGoals;
    attrs.personal_goals = personalGoals;

    // Serialize and write (same YAML pattern as dashboardHandlers.ts)
    const yamlContent = serializeAttrsToYaml(attrs);
    const newContent = `---\n${yamlContent}\n---\n${body}`;

    await deps.writeFileAtomic(targetPath, newContent);
    log.info({ goalCount: frontmatterGoals.length, path: targetPath }, 'Projected goals to frontmatter');
  });
}

// ─── Internal Utilities ───────────────────────────────────────────────

/**
 * Serialize frontmatter attributes to YAML-compatible string.
 * Uses JSON.stringify for values to ensure proper escaping.
 * Same pattern as serializeFrontmatterToYaml in dashboardHandlers.ts.
 */
function serializeAttrsToYaml(attrs: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value, null, 2)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Serializes async frontmatter operations via a simple mutex.
 * Prevents concurrent migration and write-through from interleaving.
 */
async function serializeFrontmatterOp<T>(fn: () => Promise<T>): Promise<T> {
  const prevMutex = _writeMutex;
  let release: (() => void) | undefined;
  _writeMutex = new Promise<void>(r => { release = r; });

  try {
    await prevMutex;
    return await fn();
  } finally {
    if (release) release();
  }
}

/** Reset store for testing. */
export function _resetStore(): void {
  _store = null;
  _writeMutex = Promise.resolve();
}
