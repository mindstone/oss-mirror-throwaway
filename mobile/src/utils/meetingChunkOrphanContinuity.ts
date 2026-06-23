import { hashForBreadcrumb, type ContinuityTransitionEvent } from '@rebel/cloud-client';

export function resolveMeetingChunkOrphanSignal(args: {
  meetingSessionId: string;
  companionSessionId?: string;
  knownSessionIds: Set<string>;
  currentSessionId?: string | null;
  emittedKeys: Set<string>;
}): { dedupeKey: string; normalizedCompanionSessionId: string } | null {
  if (!args.companionSessionId) return null;
  const normalizedCompanionSessionId = args.companionSessionId.trim();
  if (!normalizedCompanionSessionId) return null;

  const dedupeKey = `${args.meetingSessionId}:${normalizedCompanionSessionId}`;
  if (args.emittedKeys.has(dedupeKey)) return null;
  if (args.knownSessionIds.has(normalizedCompanionSessionId)) return null;
  if (args.currentSessionId === normalizedCompanionSessionId) return null;

  return { dedupeKey, normalizedCompanionSessionId };
}

export function buildMeetingChunkOrphanBreadcrumb(companionSessionId: string): ContinuityTransitionEvent {
  return {
    family: 'continuity-state',
    message: 'transition',
    level: 'warning',
    data: {
      sessionIdHash: hashForBreadcrumb(companionSessionId),
      from: 'cloud_active',
      to: 'cloud_active',
      reason: 'attachment-orphan-detected',
      direction: 'meeting-chunk-drain',
      label: 'missing-companion-session',
    },
  };
}
