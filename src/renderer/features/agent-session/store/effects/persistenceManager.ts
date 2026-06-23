import type { AgentSession, AgentSessionSummary } from '@shared/types';
import type { AgentSessionWithRuntime } from '../../types';
import { aggregateSessionUsage } from '@shared/utils/usageAggregator';
import { isMessageHidden } from '../selectors';
import {
  stripSessionForEgress,
  type EgressSession,
} from '../rendererLocalEventEgress';
import { deriveTurnLiveness, toPersistedBusyScalars } from '@core/services/conversationState';

const DEBOUNCE_DELAY_MS = 300;

/**
 * Fields that indicate a metadata-only change (no content change).
 * Used to detect when to use incremental save vs full save.
 */
export const METADATA_FIELDS = ['doneAt', 'starredAt', 'deletedAt', 'title'] as const;
export type MetadataField = (typeof METADATA_FIELDS)[number];

let saveTimeoutId: number | null = null;

const savePersistableSessions = (
  sessions: EgressSession[],
)=>
  window.sessionsApi.save(
    sessions as Parameters<typeof window.sessionsApi.save>[0],
  );

const savePersistableSessionsSync = (
  sessions: EgressSession[],
)=>
  window.sessionsApi.saveSync(
    sessions as Parameters<typeof window.sessionsApi.saveSync>[0],
  );

const upsertPersistableSession = async (
  session: EgressSession,
)=>
  window.sessionsApi.upsert(session);

export const saveAgentSessions = (sessions: AgentSessionWithRuntime[]): void => {
  if (saveTimeoutId !== null) {
    window.clearTimeout(saveTimeoutId);
  }

  saveTimeoutId = window.setTimeout(() => {
    saveTimeoutId = null;
    if (sessions.length === 0) return;

    const persistable = sessions.map((session) => stripSessionForEgress(session));
    savePersistableSessions(persistable).catch((error) => {
      console.error('[persistenceManager] Failed to save sessions:', error);
    });
  }, DEBOUNCE_DELAY_MS);
};

export const loadAgentSessions = async (): Promise<AgentSession[]> => {
  try {
    const loaded = await window.sessionsApi.load();
    return loaded ?? [];
  } catch (error) {
    console.error('[persistenceManager] Failed to load sessions:', error);
    return [];
  }
};

/**
 * Load lightweight session summaries for sidebar display.
 * Uses sessions:list IPC which returns AgentSessionSummary[] from the index.
 * Much faster than loadAgentSessions() since it doesn't load full session content.
 */
export const loadSessionSummaries = async (): Promise<AgentSessionSummary[]> => {
  try {
    const summaries = await window.sessionsApi.list();
    return summaries ?? [];
  } catch (error) {
    console.error('[persistenceManager] Failed to load session summaries:', error);
    return [];
  }
};

/**
 * Synchronous save for beforeunload handler.
 * Uses sendSync IPC to ensure data is written before window closes.
 * The async invoke-based save doesn't complete in dev mode (especially with HMR),
 * causing session loss on restart.
 */
export const saveSessionsSync = (sessions: AgentSessionWithRuntime[]): void => {
  if (sessions.length === 0) return;
  const persistable = sessions.map((session) => stripSessionForEgress(session));
  try {
    const result = savePersistableSessionsSync(persistable);
    if (!result.success) {
      console.error('[persistenceManager] saveSessionsSync failed:', result.error);
    }
  } catch (error) {
    console.error('[persistenceManager] saveSessionsSync threw:', error);
  }
};

/**
 * Save a single session incrementally using sessions:upsert.
 * This is much faster than saving the full session list for metadata-only changes
 * (pin, star, done, rename) because it only sends 1 session instead of N.
 * See docs/plans/partway/260123_cpu_performance_polling_fixes.md Stage 6.
 *
 * Returns a Promise that resolves to true on success, false on failure.
 * Callers should use createSummaryFromSession() to update sessionSummaries optimistically.
 */
export const saveSession = async (session: AgentSessionWithRuntime): Promise<boolean> => {
  const persistable = stripSessionForEgress(session);
  try {
    const result = await upsertPersistableSession(persistable);
    return result.success;
  } catch (error) {
    console.error('[persistenceManager] Failed to upsert session:', error);
    return false;
  }
};

/**
 * Create an AgentSessionSummary from a full session.
 * This mirrors the main process's createSummary() logic for consistency.
 * Used to optimistically update sessionSummaries after saving.
 */
export const createSummaryFromSession = (session: AgentSessionWithRuntime): AgentSessionSummary => {
  const messages = session.messages ?? [];
  const visibleMessages = messages.filter(m => !isMessageHidden(m));
  const firstMsg = visibleMessages[0];
  const lastMsg = visibleMessages[visibleMessages.length - 1];

  // Create preview snippets (same lengths as main process)
  const PREVIEW_LENGTH = 80;
  const TOOLTIP_PREVIEW_LENGTH = 200;

  const createSnippet = (text: string | undefined, maxLength: number): string => {
    if (!text) return '';
    const trimmed = text.trim().replace(/\s+/g, ' ');
    return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength).trim()}…` : trimmed;
  };

  const draftText = session.draft?.text;
  const hasDraft = Boolean(draftText?.trim());

  // Aggregate usage from events
  const usage = aggregateSessionUsage(session.eventsByTurn ?? {});
  const derivedLiveness = deriveTurnLiveness(session.eventsByTurn ?? {}, Date.now(), {
    declaredActiveTurnId: session.activeTurnId ?? null,
  });
  const summaryScalars = toPersistedBusyScalars(derivedLiveness);
  const summaryLastActivityAt = derivedLiveness.lastActivityAt ?? derivedLiveness.startedAt;

  return {
    id: session.id,
    title: session.title ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt ?? session.createdAt,
    resolvedAt: session.resolvedAt ?? null,
    // Canonical lifecycle field (non-null = Done).
    doneAt: session.doneAt ?? null,
    starredAt: session.starredAt ?? null,
    deletedAt: session.deletedAt ?? null,
    origin: session.origin ?? 'manual',
    isCorrupted: session.isCorrupted ?? false,
    privateMode: session.privateMode,
    interruptedTurnId: session.interruptedTurnId ?? null,
    preview: createSnippet(lastMsg?.text, PREVIEW_LENGTH),
    firstMessagePreview: createSnippet(firstMsg?.text, TOOLTIP_PREVIEW_LENGTH),
    lastMessagePreview: visibleMessages.length > 1 ? createSnippet(lastMsg?.text, TOOLTIP_PREVIEW_LENGTH) : undefined,
    messageCount: visibleMessages.length,
    hasUserMessages: visibleMessages.some((m) => m.role === 'user'),

    hasDraft,
    hasAnnotations: Boolean(session.annotations?.length),
    draftPreview: hasDraft ? createSnippet(draftText, 50) : null,
    draftUpdatedAt: hasDraft ? (session.draft?.updatedAt ?? null) : null,

    usage: {
      costUsd: usage.costUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      turnCount: usage.turnCount,
    },
    activeTurnId: summaryScalars.activeTurnId,
    isBusy: summaryScalars.isBusy,
    lastActivityAt: summaryLastActivityAt ?? null,
    lastError: session.lastError ?? null,
    // Meeting companion metadata (only if present)
    ...(session.meetingCompanion?.meetingUrl ? {
      meetingCompanion: {
        meetingUrl: session.meetingCompanion.meetingUrl,
        botId: session.meetingCompanion.botId,
        startedAt: session.meetingCompanion.startedAt,
      },
    } : {}),
  };
};
