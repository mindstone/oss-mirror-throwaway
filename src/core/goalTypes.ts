/**
 * Goal Types (Focus Surface)
 *
 * Core types for the Focus strategic planning surface's goals system.
 * Models the WOOP framework (Wish, Outcome, Obstacle, Plan) with
 * lifecycle tracking and quarterly tagging.
 *
 * Phase 1: types only — store, IPC, and service come in Phase 2.
 *
 * @see docs/plans/260405_focus_phase1_feature_flag_goals_foundation.md
 * @see docs/plans/260405_focus_surface_strategic_planning.md
 */

/** Lifecycle status of a goal */
export type GoalStatus = 'active' | 'completed' | 'dropped';

/** A single goal with optional WOOP fields and lifecycle tracking */
export interface Goal {
  /** Unique identifier (UUID) */
  id: string;
  /** The goal itself — what the user wants to achieve */
  text: string;
  /** Why this goal matters (motivation / purpose) */
  why?: string;
  /** WOOP: what success looks like */
  outcome?: string;
  /** WOOP: what's most likely to prevent this */
  obstacle?: string;
  /** WOOP: what to do when the obstacle appears */
  plan?: string;
  /** Current lifecycle status */
  status: GoalStatus;
  /** Epoch ms when the goal was created */
  createdAt: number;
  /** Epoch ms when the goal was last modified */
  updatedAt: number;
  /** Epoch ms when the goal was last explicitly reviewed */
  lastReviewedAt?: number;
  /** Quarter tag, e.g. "2026-Q2" */
  quarterTag?: string;
}

/** Persisted store shape for the goals system */
export interface GoalsStoreData {
  [key: string]: unknown;
  /** All goals (active, completed, dropped) */
  goals: Goal[];
  /** Epoch ms of the last weekly review, or null if never reviewed */
  lastWeeklyReview: number | null;
  /** Epoch ms of the last monthly review, or null if never reviewed */
  lastMonthlyReview: number | null;
  /** Epoch ms when goals were migrated from frontmatter, or null if not yet migrated */
  migratedFromFrontmatterAt: number | null;
}

/** Input for creating a new goal — no id, status, or timestamps */
export interface CreateGoalInput {
  /** The goal text (required) */
  text: string;
  /** Why this goal matters */
  why?: string;
  /** WOOP: what success looks like */
  outcome?: string;
  /** WOOP: what's most likely to prevent this */
  obstacle?: string;
  /** WOOP: what to do when the obstacle appears */
  plan?: string;
  /** Quarter tag, e.g. "2026-Q2" */
  quarterTag?: string;
}

/** Input for updating an existing goal — all mutable fields optional, excludes id and createdAt */
export interface UpdateGoalInput {
  /** Updated goal text */
  text?: string;
  /** Updated motivation */
  why?: string;
  /** Updated outcome vision */
  outcome?: string;
  /** Updated obstacle */
  obstacle?: string;
  /** Updated plan for handling the obstacle */
  plan?: string;
  /** Updated lifecycle status */
  status?: GoalStatus;
  /** Updated quarter tag */
  quarterTag?: string;
}
