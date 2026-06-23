/**
 * Session Tool Decision Cache
 *
 * Session-scoped, semantically-keyed cache that short-circuits the LLM safety
 * evaluator for repeat (toolId, normalized args) pairs that were previously
 * allowed in the same session. Block decisions are NEVER cached — only
 * confident, non-fail-closed allows.
 *
 * Tombstones: when `clearSession` runs, the sessionId is added to a short-
 * lived tombstone set so a delayed `recordAllow` (e.g. an in-flight LLM eval
 * that resolves after the user revoked or the session was deleted) cannot
 * resurrect the session map. Tombstones expire after `SESSION_TOMBSTONE_TTL_MS`
 * — long enough to cover any in-flight eval but short enough that a brand-new
 * session reusing the same id (very unlikely with UUIDs) eventually proceeds
 * normally.
 *
 * @see docs/plans/260526_safety_eval_context_completeness.md (Stage 1, Lever E / P0.4)
 * @see toolNormalizationKeys.ts — per-tool-family canonical-args keying
 */

import { createScopedLogger } from '@core/logger';
import type { SafetyEvalResult } from '@core/safetyPromptTypes';
import type { CoarseToolFamily } from '@core/services/safety/toolNormalizationKeys';

const log = createScopedLogger({ service: 'safetyDecisionCache' });

export const SESSION_TOOL_CACHE_TTL_MS = 30 * 60_000;
export const SESSION_TOMBSTONE_TTL_MS = 5 * 60_000;

interface Entry {
  decision: 'allow';
  reason: string;
  confidence: SafetyEvalResult['confidence'];
  promptVersion: number;
  storedAtMs: number;
  toolFamily: CoarseToolFamily;
}

const cache = new Map<string /* sessionId */, Map<string /* normalizedKey */, Entry>>();
const tombstones = new Map<string /* sessionId */, number /* tombstonedAtMs */>();

function isTombstoned(sessionId: string): boolean {
  const ts = tombstones.get(sessionId);
  if (ts === undefined) return false;
  if (Date.now() - ts > SESSION_TOMBSTONE_TTL_MS) {
    tombstones.delete(sessionId);
    return false;
  }
  return true;
}

interface GetCachedAllowArgs {
  sessionId: string;
  normalizedKey: string;
  currentPromptVersion: number;
}

export function getCachedAllow(args: GetCachedAllowArgs): Entry | null {
  const { sessionId, normalizedKey, currentPromptVersion } = args;
  if (isTombstoned(sessionId)) return null;
  const sessionMap = cache.get(sessionId);
  if (!sessionMap) return null;
  const entry = sessionMap.get(normalizedKey);
  if (!entry) return null;

  if (entry.promptVersion !== currentPromptVersion) {
    sessionMap.delete(normalizedKey);
    if (sessionMap.size === 0) cache.delete(sessionId);
    log.info(
      {
        event: 'safety.session_decision_cache_evicted',
        reason: 'prompt_version',
        sessionId,
        normalizedKey,
        entryPromptVersion: entry.promptVersion,
        currentPromptVersion,
      },
      'Evicted session decision cache entry on prompt-version change',
    );
    return null;
  }

  const ageMs = Date.now() - entry.storedAtMs;
  if (ageMs > SESSION_TOOL_CACHE_TTL_MS) {
    sessionMap.delete(normalizedKey);
    if (sessionMap.size === 0) cache.delete(sessionId);
    log.info(
      {
        event: 'safety.session_decision_cache_evicted',
        reason: 'ttl',
        sessionId,
        normalizedKey,
        ageMs,
      },
      'Evicted session decision cache entry on TTL',
    );
    return null;
  }

  return entry;
}

interface RecordAllowArgs {
  sessionId: string;
  normalizedKey: string;
  result: SafetyEvalResult;
  promptVersion: number;
  toolFamily: CoarseToolFamily;
}

export function recordAllow(args: RecordAllowArgs): void {
  const { sessionId, normalizedKey, result, promptVersion, toolFamily } = args;
  if (result.decision !== 'allow') return;
  if (result.failClosed === true) return;
  if (isTombstoned(sessionId)) return;

  let sessionMap = cache.get(sessionId);
  if (!sessionMap) {
    sessionMap = new Map();
    cache.set(sessionId, sessionMap);
  }
  sessionMap.set(normalizedKey, {
    decision: 'allow',
    reason: result.reason,
    confidence: result.confidence,
    promptVersion,
    storedAtMs: Date.now(),
    toolFamily,
  });
}

export function clearSession(sessionId: string): void {
  tombstones.set(sessionId, Date.now());
  const sessionMap = cache.get(sessionId);
  if (!sessionMap || sessionMap.size === 0) {
    cache.delete(sessionId);
    return;
  }
  const entryCount = sessionMap.size;
  cache.delete(sessionId);
  log.info(
    {
      event: 'safety.session_decision_cache_evicted',
      reason: 'session_clear',
      sessionId,
      entryCount,
    },
    'Evicted all session decision cache entries on session clear',
  );
}

/**
 * Drop every cached allow for the given session whose `toolFamily` matches.
 * Used when the user issues a negation/cancellation against a tool family so
 * subsequent calls in the same family re-trigger the safety eval rather than
 * silently short-circuiting on a stale allow. Cache writes resume normally
 * after invalidation — invalidation does NOT tombstone the session.
 *
 * @see docs/plans/260526_safety_eval_context_completeness.md (Phase 4, Fix 5)
 */
export function invalidateByToolFamily(sessionId: string, toolFamily: CoarseToolFamily): number {
  const sessionMap = cache.get(sessionId);
  if (!sessionMap || sessionMap.size === 0) return 0;
  let removed = 0;
  for (const [key, entry] of sessionMap) {
    if (entry.toolFamily === toolFamily) {
      sessionMap.delete(key);
      removed += 1;
    }
  }
  if (sessionMap.size === 0) cache.delete(sessionId);
  if (removed > 0) {
    log.info(
      {
        event: 'safety.session_decision_cache_evicted',
        reason: 'negation',
        sessionId,
        toolFamily,
        removedCount: removed,
      },
      'Evicted session decision cache entries on user negation',
    );
  }
  return removed;
}

export function clearAll(): void {
  cache.clear();
  tombstones.clear();
}
