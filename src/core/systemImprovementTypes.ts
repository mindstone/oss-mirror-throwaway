/**
 * System Self-Improvement Loop Types
 *
 * Defines core types for the closed-loop system where Rebel detects
 * opportunities to improve itself (skills, memories, preferences) based
 * on conversation outcomes and proposes changes to the user.
 *
 * @see docs/plans/partway/260310_system_improvement_loop.md
 */

export type ImprovementTargetType = 'skill' | 'memory' | 'preference';

export interface ImprovementTarget {
  type: ImprovementTargetType;
  /** e.g., skill name, memory space, preference key */
  name: string;
  /** Filesystem path for skills */
  path?: string;
}

export type SuggestionState = 'pending' | 'acted' | 'rejected' | 'dismissed';

export interface SystemImprovementSuggestion {
  id: string;
  sessionId: string;
  evaluatedAt: number;
  /** What was observed in the conversation */
  observation: string;
  target: ImprovementTarget;
  /** Human-readable summary of the proposed change */
  proposedChange: string;
  /** High-level intent for assembling the continuation prompt at click-time */
  intent: string;
  /** Confidence score 0-100, only show >= 85 */
  confidence: number;
  state: SuggestionState;
  /** Deduplication fingerprint: hash of targetType + targetName + normalized observation */
  fingerprint: string;
  stateUpdatedAt?: number;
}

export interface SystemImprovementStoreState {
  [key: string]: unknown;
  version: number;
  suggestions: Record<string, SystemImprovementSuggestion>;
  evaluatedSessionIds: string[];
  dailyCount: number;
  dailyCountDate: string;
}

/** Raw evaluator output before store enrichment */
export interface SystemImprovementEvaluatorResult {
  hasSuggestion: boolean;
  confidence?: number;
  observation?: string;
  targetType?: ImprovementTargetType;
  targetName?: string;
  targetPath?: string;
  proposedChange?: string;
  intent?: string;
  reason?: string;
}
