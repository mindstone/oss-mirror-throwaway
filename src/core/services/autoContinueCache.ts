/**
 * Auto-Continue Cache
 *
 * Extracted from autoContinueHook.ts to break the circular dependency
 * between agentTurnRegistry and autoContinueHook.
 *
 * Stores per-turn message hashes used by the auto-continue hook to avoid
 * re-evaluating the same assistant message multiple times within a single turn.
 */

// Cache to avoid re-evaluating the same message multiple times per turn
// Key: turnId, Value: hash of last evaluated message
const lastEvaluatedMessageByTurn = new Map<string, string>();

/**
 * Get the last evaluated message hash for a turn.
 */
export function getLastEvaluatedHash(turnId: string): string | undefined {
  return lastEvaluatedMessageByTurn.get(turnId);
}

/**
 * Set the last evaluated message hash for a turn.
 */
export function setLastEvaluatedHash(turnId: string, hash: string): void {
  lastEvaluatedMessageByTurn.set(turnId, hash);
}

/**
 * Clean up the message cache for a turn. Should be called when turn ends.
 */
export function cleanupAutoContinueCache(turnId: string): void {
  lastEvaluatedMessageByTurn.delete(turnId);
}
