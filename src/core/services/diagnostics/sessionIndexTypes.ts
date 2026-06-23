import { fnvHashBase36, fnvHashHex, isSessionActive } from '@rebel/shared';
import type { AgentSession } from '@shared/types';
import { redactSensitiveData } from './redaction';
import {
  MAX_MESSAGES_PER_SESSION,
  MOBILE_MAX_SESSION_INDEX_ENTRIES,
  type DiagnosticSessionSummary,
  type SessionExcerpt,
  type SessionMessageExcerpt,
} from './manifest';

export { fnvHashBase36, fnvHashHex };

export type DesktopSessionIndexEntry = SessionExcerpt;

export interface CloudSessionIndexEntry {
  sessionIdHash: string;
  updatedAt: number;
  cloudUpdatedAt?: number;
  maxSeq?: number;
  continuityState?: 'local_only' | 'cloud_active';
  hasTombstone: boolean;
}

export interface MobileSessionIndexEntry {
  sessionIdHash: string;
  updatedAt: number;
  cloudUpdatedAt?: number;
  /** True when the session is Active (doneAt null/absent). Renamed from `isPinned`. */
  isActive: boolean;
  isDeleted: boolean;
}

export interface MobileSessionLike {
  id: string;
  updatedAt: number;
  cloudUpdatedAt?: number;
  /** Canonical lifecycle field (non-null = Done). */
  doneAt?: number | null;
  deletedAt: number | null;
}

export function buildDesktopSessionExcerpt(session: AgentSession): DesktopSessionIndexEntry {
  const messages = session.messages || [];
  const recentMessages = messages.slice(-MAX_MESSAGES_PER_SESSION);
  const messageExcerpts: SessionMessageExcerpt[] = recentMessages.map((msg) => {
    const text = msg.text || '';
    const MAX_PREVIEW_LENGTH = 500;
    const contentPreview = text.length > MAX_PREVIEW_LENGTH
      ? redactSensitiveData(text.slice(0, MAX_PREVIEW_LENGTH))
      : redactSensitiveData(text);
    return {
      id: msg.id,
      role: msg.role as 'user' | 'assistant',
      contentPreview,
      truncated: text.length > MAX_PREVIEW_LENGTH,
      originalLength: text.length,
      timestamp: msg.createdAt,
      turnId: msg.turnId,
    };
  });

  const turnCount = Object.keys(session.eventsByTurn || {}).length;
  let costUsd = 0;
  if (session.eventsByTurn) {
    for (const events of Object.values(session.eventsByTurn)) {
      for (const event of events) {
        if (event.type === 'result' && typeof event.usage?.costUsd === 'number') {
          costUsd += event.usage.costUsd;
        }
      }
    }
  }

  return {
    id: session.id,
    title: session.title || null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    origin: session.origin || 'manual',
    totalMessageCount: messages.length,
    turnCount,
    costUsd: costUsd > 0 ? costUsd : undefined,
    recentMessages: messageExcerpts,
  };
}

export function normalizeCloudSessionSummaries(raw: unknown): DiagnosticSessionSummary[] {
  if (!Array.isArray(raw)) return [];
  const summaries: DiagnosticSessionSummary[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) continue;
    if (typeof candidate.updatedAt !== 'number' || !Number.isFinite(candidate.updatedAt)) continue;
    summaries.push({
      id: candidate.id,
      updatedAt: candidate.updatedAt,
      ...(typeof candidate.cloudUpdatedAt === 'number' && Number.isFinite(candidate.cloudUpdatedAt)
        ? { cloudUpdatedAt: candidate.cloudUpdatedAt }
        : {}),
      ...(typeof candidate.maxSeq === 'number' && Number.isFinite(candidate.maxSeq)
        ? { maxSeq: candidate.maxSeq }
        : {}),
    });
  }
  return summaries;
}

export function getMobileSessionSortTimestamp(session: MobileSessionLike): number {
  return typeof session.cloudUpdatedAt === 'number' ? session.cloudUpdatedAt : session.updatedAt;
}

export function buildMobileSessionsIndex(
  sessionsInput: MobileSessionLike[] | undefined,
  maxEntries = MOBILE_MAX_SESSION_INDEX_ENTRIES,
): { count: number; totalInHistory: number; sessions: MobileSessionIndexEntry[] } {
  const allSessions = sessionsInput ?? [];
  const sessions = [...allSessions]
    .sort((a, b) => getMobileSessionSortTimestamp(b) - getMobileSessionSortTimestamp(a))
    .slice(0, maxEntries)
    .map((session) => ({
      sessionIdHash: fnvHashBase36(session.id),
      updatedAt: session.updatedAt,
      ...(typeof session.cloudUpdatedAt === 'number' ? { cloudUpdatedAt: session.cloudUpdatedAt } : {}),
      isActive: isSessionActive(session),
      isDeleted: session.deletedAt !== null,
    }));
  return { count: sessions.length, totalInHistory: allSessions.length, sessions };
}
