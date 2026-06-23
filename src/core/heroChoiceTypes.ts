/**
 * Hero Choice Types
 *
 * Core types for the daily Hero Choice system — a single LLM call that
 * produces ranked recommendations based on cross-session analysis.
 *
 * @see docs/plans/260315_spark_redesign.md
 */

/** Candidate types the LLM can produce */
export type HeroChoiceCandidateType =
  | 'meeting_prep'
  | 'coaching'
  | 'improvement'
  | 'use_case'
  | 'insight';

/** A single recommendation candidate produced by the Hero Choice LLM call */
export interface HeroChoiceCandidate {
  /** Generated UUID */
  id: string;
  /** Type of recommendation */
  type: HeroChoiceCandidateType;
  /** Short, punchy headline (max ~80 chars) */
  headline: string;
  /** Supporting context (1-2 sentences) */
  body: string;
  /** Button text, e.g. "Prepare now", "Try this" */
  actionLabel: string;
  /** Pre-filled prompt if user clicks action */
  actionPrompt: string;
  /** 1 = highest priority, assigned by LLM */
  priority: number;
  /** Epoch ms of the associated meeting start time (meeting_prep only) */
  meetingStartTime?: number;
  /** Which session triggered this (if applicable) */
  sourceSessionId?: string;
  /** Related skill name (if applicable) */
  sourceSkill?: string;
}

/** Result of a single Hero Choice LLM call */
export interface HeroChoiceResult {
  /** Ranked list of recommendation candidates */
  candidates: HeroChoiceCandidate[];
  /** One-liner about the user's week (for ProgressCard) */
  weekSummary: string;
  /** When this result was generated */
  generatedAt: number;
  /** Which model produced this */
  modelUsed: string;
}

/** Lifecycle state of a candidate */
export type HeroChoiceCandidateState = 'pending' | 'acted' | 'dismissed';

/** A stored hero choice entry with user interaction state */
export interface HeroChoiceEntry {
  /** The LLM-generated result */
  result: HeroChoiceResult;
  /** candidateId -> lifecycle state */
  candidateStates: Record<string, HeroChoiceCandidateState>;
  /** candidateId -> user feedback */
  feedback: Record<string, 'helpful' | 'not_helpful'>;
}

/** Store state for the hero-choice store */
export interface HeroChoiceStoreState {
  [key: string]: unknown;
  /** Entries newest first, max 10 */
  entries: HeroChoiceEntry[];
}

// ── Staleness logic (shared by scheduler + renderer) ──────

const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12 hours
const DAILY_REFRESH_HOUR = 8; // 8 AM local time

/**
 * Returns true when a hero choice result is stale and should be regenerated.
 * Used by the scheduler (to decide whether to auto-generate) and by the
 * renderer (to decide whether "ask" mode should show the prompt card).
 *
 * Stale when:
 * - Never generated (`null`)
 * - Generated before today's 8 AM and it's now past 8 AM (daily refresh)
 * - Older than 12 hours (catch-up for apps closed overnight)
 */
export function isHeroChoiceStale(lastGeneratedAt: number | null): boolean {
  if (lastGeneratedAt === null) return true;

  const now = new Date();
  const todayRefresh = new Date(now);
  todayRefresh.setHours(DAILY_REFRESH_HOUR, 0, 0, 0);

  if (now >= todayRefresh && lastGeneratedAt < todayRefresh.getTime()) return true;
  if (Date.now() - lastGeneratedAt > STALE_THRESHOLD_MS) return true;

  return false;
}
