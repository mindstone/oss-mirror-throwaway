import { extractMeetingId } from '@rebel/shared';
import type { AgentSessionSummary } from '@shared/types';

export const COMPANION_REUSE_WINDOW_MS = 8 * 60 * 60 * 1000;

export interface ResolveCompanionInput {
  currentBotId: string | undefined;
  currentMeetingKey: string;
  summaries: AgentSessionSummary[];
  now: number;
  recencyWindowMs?: number;
}

function getMeetingKey(url: string): string {
  return extractMeetingId(url) ?? url;
}

function getCompanionStartedAt(summary: AgentSessionSummary): number {
  return summary.meetingCompanion?.startedAt ?? summary.createdAt;
}

function newestFirst(a: AgentSessionSummary, b: AgentSessionSummary): number {
  return getCompanionStartedAt(b) - getCompanionStartedAt(a);
}

function hasBotIdentity(botId: string | undefined): botId is string {
  return typeof botId === 'string' && botId.length > 0;
}

export function resolveReusableCompanion(input: ResolveCompanionInput): AgentSessionSummary | null {
  const {
    currentBotId,
    currentMeetingKey,
    summaries,
    now,
    recencyWindowMs = COMPANION_REUSE_WINDOW_MS,
  } = input;

  const meetingKeyCandidates = summaries.filter((summary) => {
    if (summary.deletedAt != null) return false;
    const meetingUrl = summary.meetingCompanion?.meetingUrl;
    if (!meetingUrl) return false;
    return getMeetingKey(meetingUrl) === currentMeetingKey;
  });

  const matchingBotCandidates = meetingKeyCandidates
    .filter((summary) => {
      const summaryBotId = summary.meetingCompanion?.botId;
      return hasBotIdentity(summaryBotId) && hasBotIdentity(currentBotId) && summaryBotId === currentBotId;
    })
    .sort(newestFirst);

  if (matchingBotCandidates.length > 0) {
    return matchingBotCandidates[0];
  }

  const legacyCandidates = meetingKeyCandidates
    .filter((summary) => summary.meetingCompanion?.botId == null)
    .filter((summary) => Math.max(0, now - getCompanionStartedAt(summary)) <= recencyWindowMs)
    .sort(newestFirst);

  return legacyCandidates[0] ?? null;
}
