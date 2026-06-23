/**
 * Canonical Conversation Mapper
 *
 * Pure function that maps an internal `AgentSessionSummary` to the
 * plugin-facing `ConversationSummary` shape. Single source of truth
 * for all plugin read APIs — prevents field drift across hooks.
 *
 * @see docs/plans/260408_plugin_conversation_api_expansion.md (SH1)
 */

import type { AgentSessionSummary } from '@shared/ipc/schemas/sessions';
import type { ConversationSummary } from './types';

/**
 * Map an internal session summary to the plugin-visible conversation shape.
 *
 * This is a pure function — no side effects, no store access.
 * All plugin read APIs should use this instead of inline field mapping.
 */
export function mapSummaryToConversation(summary: AgentSessionSummary): ConversationSummary {
  return {
    id: summary.id,
    title: summary.title,
    updatedAt: summary.updatedAt,
    createdAt: summary.createdAt,
    isBusy: summary.isBusy,
    messageCount: summary.messageCount,
    preview: summary.preview,
    // doneAt is the canonical lifecycle field (non-null = Done). Renamed from
    // pinnedAt (polarity inverted) — see the BREAKING header in lifecycleDiff.ts.
    doneAt: summary.doneAt ?? null,
    starredAt: summary.starredAt,
    origin: summary.origin,
    deletedAt: summary.deletedAt,
    resolvedAt: summary.resolvedAt,
  };
}
