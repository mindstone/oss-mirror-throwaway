/**
 * Lifecycle Diff Utility
 *
 * Pure function that compares previous and next session summaries to detect
 * lifecycle events: updated, deleted, restored. Created events are handled
 * separately (existing conversation:created detection in App.tsx).
 *
 * Only fires `conversation:updated` for meaningful metadata changes:
 * title, doneAt, starredAt, resolvedAt. Does NOT fire for updatedAt-only
 * or isBusy transitions (those have turn:started/completed events).
 *
 * @see docs/plans/260408_plugin_conversation_api_expansion.md (SH2, D2)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * BREAKING CHANGE (v0.2, 2026-06): the lifecycle field reported here is now
 * `'doneAt'` (was `'pinnedAt'`), with INVERTED polarity:
 *   OLD `pinnedAt != null` = Active  →  NEW `doneAt == null` = Active
 *   OLD `pinnedAt == null` = Done    →  NEW `doneAt != null` = Done
 * Plugins that filter the `changes` array for `'pinnedAt'` (or read
 * `conversation.pinnedAt`) must switch to `'doneAt'`/`conversation.doneAt`
 * and flip their polarity logic. Full guide:
 *   docs/project/PLUGINS_API_REFERENCE.md ("Breaking change: pinnedAt → doneAt").
 * ──────────────────────────────────────────────────────────────────────────
 */

import type { AgentSessionSummary } from '@shared/ipc/schemas/sessions';
import type { RebelEventType } from './types';

export interface LifecycleEvent {
  type: Extract<RebelEventType, 'conversation:updated' | 'conversation:deleted' | 'conversation:restored'>;
  sessionId: string;
  payload: Record<string, unknown>;
}

/**
 * Detect lifecycle changes between two snapshots of session summaries.
 *
 * Returns an array of lifecycle events to emit. Does NOT detect new sessions
 * (conversation:created is handled separately by existing App.tsx logic).
 *
 * Pure function — no side effects, no store access.
 */
export function diffSessionLifecycle(
  prev: AgentSessionSummary[],
  next: AgentSessionSummary[],
): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];
  const prevMap = new Map(prev.map(s => [s.id, s]));

  for (const nextSummary of next) {
    const prevSummary = prevMap.get(nextSummary.id);
    if (!prevSummary) continue; // New session — handled by conversation:created

    // Detect soft-delete: deletedAt changed from null/undefined to non-null
    const prevDeleted = prevSummary.deletedAt != null;
    const nextDeleted = nextSummary.deletedAt != null;

    if (!prevDeleted && nextDeleted) {
      events.push({
        type: 'conversation:deleted',
        sessionId: nextSummary.id,
        payload: { sessionId: nextSummary.id, title: nextSummary.title },
      });
      continue; // Don't also fire updated for deletion
    }

    // Detect restore: deletedAt changed from non-null to null/undefined
    if (prevDeleted && !nextDeleted) {
      events.push({
        type: 'conversation:restored',
        sessionId: nextSummary.id,
        payload: { sessionId: nextSummary.id, title: nextSummary.title },
      });
      continue; // Don't also fire updated for restoration
    }

    // Detect meaningful metadata changes (not updatedAt-only or isBusy transitions)
    const changes: string[] = [];

    if (prevSummary.title !== nextSummary.title) {
      changes.push('title');
    }
    if (prevSummary.doneAt !== nextSummary.doneAt) {
      changes.push('doneAt');
    }
    if (prevSummary.starredAt !== nextSummary.starredAt) {
      changes.push('starredAt');
    }
    if (prevSummary.resolvedAt !== nextSummary.resolvedAt) {
      changes.push('resolvedAt');
    }

    if (changes.length > 0) {
      events.push({
        type: 'conversation:updated',
        sessionId: nextSummary.id,
        payload: { sessionId: nextSummary.id, title: nextSummary.title, changes },
      });
    }
  }

  return events;
}
