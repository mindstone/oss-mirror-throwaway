/**
 * Pure field derivation for session summaries.
 *
 * Extracts preview snippets, usage stats, draft metadata, and meeting companion
 * from a normalized AgentSession. Does NOT handle normalization, fingerprinting,
 * or busy-state logic -- those remain in incrementalSessionStore.createSummary().
 */

import type { AgentSession } from '@shared/types';
import { aggregateSessionUsage } from '@shared/utils/usageAggregator';

const PREVIEW_MAX_LENGTH = 80;
const TOOLTIP_PREVIEW_MAX_LENGTH = 200;
const DRAFT_PREVIEW_MAX_LENGTH = 50;

export function createMessageSnippet(
  text: string | null | undefined,
  maxLength = PREVIEW_MAX_LENGTH,
): string {
  if (!text) return '';
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength).trim()}\u2026` : trimmed;
}

export interface SessionSummaryFieldProjection {
  preview: string;
  firstMessagePreview: string;
  messageCount: number;
  hasUserMessages: boolean;
  hasDraft: boolean;
  hasAnnotations?: boolean;
  draftPreview: string | null;
  draftUpdatedAt: number | null;
  usage: {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    turnCount: number;
  };
  meetingCompanion?: {
    meetingUrl: string;
    botId?: string;
    startedAt?: number;
  };
}

export function projectSessionSummaryFields(session: AgentSession): SessionSummaryFieldProjection {
  const messages = session.messages ?? [];
  const firstMsg = messages[0];
  const lastMsg = messages[messages.length - 1];

  const draftText = session.draft?.text;
  const hasDraft = Boolean(draftText?.trim());

  const usage = aggregateSessionUsage(session.eventsByTurn ?? {});

  return {
    preview: createMessageSnippet(lastMsg?.text, PREVIEW_MAX_LENGTH),
    firstMessagePreview: createMessageSnippet(firstMsg?.text, TOOLTIP_PREVIEW_MAX_LENGTH),
    messageCount: messages.length,
    hasUserMessages: messages.some((m) => m.role === 'user'),
    hasDraft,
    hasAnnotations: Boolean(session.annotations?.length),
    draftPreview: hasDraft ? createMessageSnippet(draftText, DRAFT_PREVIEW_MAX_LENGTH) : null,
    draftUpdatedAt: hasDraft ? (session.draft?.updatedAt ?? null) : null,
    usage: {
      costUsd: usage.costUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      turnCount: usage.turnCount,
    },
    ...(session.meetingCompanion?.meetingUrl ? {
      meetingCompanion: {
        meetingUrl: session.meetingCompanion.meetingUrl,
        botId: session.meetingCompanion.botId,
        startedAt: session.meetingCompanion.startedAt,
      },
    } : {}),
  };
}
