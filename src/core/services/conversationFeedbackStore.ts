/**
 * Conversation Feedback Store
 *
 * Persists per-conversation star-rating votes and dismissals.
 * Primary use is UX: avoid re-prompting after the user has rated or dismissed.
 */

import { randomUUID } from 'node:crypto';
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { CONVERSATION_FEEDBACK_VERSION } from '@core/constants';
import { PER_SESSION_VOTE_CAP } from '@shared/data/conversationFeedbackChips';
import type { ConversationVote } from '@shared/ipc/schemas';
import { migrateStore, shouldEnterReadOnlyMode, type MigrationFn, type VersionedData } from '../utils/storeMigration';
import { loadStoreSafely, isLoadFailedReadOnly, resolveConfStorePath } from '../utils/loadStoreSafely';

const log = createScopedLogger({ service: 'conversationFeedback' });

interface LegacyConversationRatingRecord {
  sessionId: string;
  rating: 'positive' | 'negative';
  ratedAt: number;
}

export interface ConversationDismissalRecord {
  sessionId: string;
  dismissedAt: number;
}

interface ConversationFeedbackStoreShape extends VersionedData {
  version: number;
  votes: ConversationVote[];
  dismissals: ConversationDismissalRecord[];
}

interface ConversationFeedbackMigrationShape extends VersionedData {
  version: number;
  ratings?: LegacyConversationRatingRecord[];
  votes?: ConversationVote[];
  dismissals: ConversationDismissalRecord[];
}

const CONVERSATION_FEEDBACK_MIGRATIONS: Record<number, MigrationFn<ConversationFeedbackMigrationShape>> = {
  1: (data) => ({
    version: 2,
    votes: Array.isArray(data.ratings)
      ? data.ratings.map((record) => ({
          voteId: `legacy-${record.sessionId}-${record.ratedAt}`,
          sessionId: record.sessionId,
          rating: record.rating === 'positive' ? 5 : 1,
          comment: '(migrated from thumbs rating)',
          chips: [],
          ratedAt: record.ratedAt,
          includeDiagnostics: false,
        }))
      : [],
    dismissals: Array.isArray(data.dismissals) ? data.dismissals : [],
  }),
};

const createDefaultState = (): ConversationFeedbackStoreShape => ({
  version: CONVERSATION_FEEDBACK_VERSION,
  votes: [],
  dismissals: [],
});

let _store: KeyValueStore<ConversationFeedbackMigrationShape> | null = null;
const getStore = () => _store ??= createStore<ConversationFeedbackMigrationShape>({
  name: 'conversation-feedback',
  defaults: createDefaultState(),
});

let readOnlyMode = false;
// Set true once load/migration has run, so the read-only flag is authoritative.
let _conversationFeedbackMigrationRan = false;

const loadInternal = (): ConversationFeedbackStoreShape => {
  // Guard the `.store` read + migrate: a thrown load (corrupt JSON / schema /
  // decrypt / transient IO) must NEVER reset+persist over real on-disk data.
  // The guard classifies ENOENT (fresh init) vs existing-but-unreadable
  // (preserve raw + read-only).
  // `getStore()` (conf construction) is INSIDE the thunk — conf throws at
  // construction when the file is already corrupt. Path derived independently.
  const result = loadStoreSafely(
    'conversation-feedback',
    resolveConfStorePath('conversation-feedback'),
    () =>
      migrateStore(getStore().store, {
        storeName: 'conversation-feedback',
        currentVersion: CONVERSATION_FEEDBACK_VERSION,
        migrations: CONVERSATION_FEEDBACK_MIGRATIONS,
        createDefault: createDefaultState,
      }),
    // Consumed only on `absent` (genuine fresh init → writable); `load-failed`
    // short-circuits before reading shouldPersist.
    () => ({
      data: createDefaultState(),
      status: 'fresh' as const,
      fromVersion: null,
      toVersion: CONVERSATION_FEEDBACK_VERSION,
      backupPath: null,
      shouldPersist: true,
    }),
  );

  _conversationFeedbackMigrationRan = true;

  if (isLoadFailedReadOnly(result)) {
    readOnlyMode = true;
    // Ephemeral defaults in memory; never persisted (read-only latch).
    return createDefaultState();
  }

  const migrationResult = result.data;
  readOnlyMode = shouldEnterReadOnlyMode(migrationResult);
  if (migrationResult.status === 'future_version') {
    log.warn(
      {
        storedVersion: migrationResult.fromVersion,
        currentVersion: CONVERSATION_FEEDBACK_VERSION,
      },
      'Conversation feedback store from newer app version - operating in read-only mode',
    );
  }

  const normalized: ConversationFeedbackStoreShape = {
    version: CONVERSATION_FEEDBACK_VERSION,
    votes: Array.isArray(migrationResult.data.votes) ? migrationResult.data.votes : [],
    dismissals: Array.isArray(migrationResult.data.dismissals) ? migrationResult.data.dismissals : [],
  };

  if (migrationResult.shouldPersist) {
    getStore().store = normalized;
  }

  return normalized;
};

/**
 * Read-only check that GUARANTEES load/migration has run first. A writer that
 * read the raw `readOnlyMode` as the FIRST touch (no prior read) would see a
 * stale `false` and clobber real, un-migrated data. Use in EVERY writer.
 */
const isConversationFeedbackReadOnly = (): boolean => {
  if (!_conversationFeedbackMigrationRan) {
    loadInternal();
  }
  return readOnlyMode;
};

const saveInternal = (state: ConversationFeedbackStoreShape): void => {
  // Ensure load/migration has run so the flag is authoritative (first-touch-safe;
  // no recursion — load never calls save).
  if (isConversationFeedbackReadOnly()) {
    log.warn('Skipping conversation feedback save - operating in read-only mode');
    return;
  }

  getStore().store = state;
};

const RETENTION_DAYS = 90;
const MAX_VOTES = 5000;
const MAX_DISMISSALS = 5000;

function pruneState(state: ConversationFeedbackStoreShape): ConversationFeedbackStoreShape {
  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const votes = state.votes.filter((vote) => vote.ratedAt > cutoffMs);
  const dismissals = state.dismissals.filter((d) => d.dismissedAt > cutoffMs);

  // Keep most recent entries under the cap
  const cappedVotes = votes
    .slice()
    .sort((a, b) => b.ratedAt - a.ratedAt)
    .slice(0, MAX_VOTES);
  const cappedDismissals = dismissals
    .slice()
    .sort((a, b) => b.dismissedAt - a.dismissedAt)
    .slice(0, MAX_DISMISSALS);

  return { ...state, votes: cappedVotes, dismissals: cappedDismissals };
}

export const appendConversationVote = (
  input: Omit<ConversationVote, 'voteId' | 'ratedAt'> & { ratedAt?: number },
): ConversationVote => {
  const normalizedSessionId = input.sessionId.trim();
  const state = loadInternal();
  const ratedAt = input.ratedAt ?? Date.now();

  const vote: ConversationVote = {
    ...input,
    chips: input.chips ?? [],
    includeDiagnostics: input.includeDiagnostics ?? false,
    voteId: randomUUID(),
    sessionId: normalizedSessionId,
    ratedAt,
  };

  const otherSessionVotes = state.votes.filter((existing) => existing.sessionId !== normalizedSessionId);
  const sessionVotes = state.votes
    .filter((existing) => existing.sessionId === normalizedSessionId)
    .concat(vote)
    .sort((a, b) => a.ratedAt - b.ratedAt)
    .slice(-PER_SESSION_VOTE_CAP);

  const nextState = pruneState({
    ...state,
    votes: [...otherSessionVotes, ...sessionVotes],
  });
  saveInternal(nextState);

  log.info({ sessionId: normalizedSessionId, voteId: vote.voteId, rating: vote.rating }, 'Conversation vote recorded');

  return vote;
};

export const dismissConversationFeedback = (sessionId: string): void => {
  const normalizedSessionId = sessionId.trim();
  const state = loadInternal();

  // If already rated, do not overwrite with dismissal
  if (state.votes.some((vote) => vote.sessionId === normalizedSessionId)) {
    return;
  }

  const dismissals = state.dismissals.filter((d) => d.sessionId !== normalizedSessionId);
  const record: ConversationDismissalRecord = {
    sessionId: normalizedSessionId,
    dismissedAt: Date.now(),
  };

  const nextState = pruneState({
    ...state,
    dismissals: [...dismissals, record],
  });
  saveInternal(nextState);

  log.info({ sessionId: normalizedSessionId }, 'Conversation feedback dismissed');
};

export const getConversationFeedback = (
  sessionId: string
): { votes: ConversationVote[]; dismissedAt: number | null } => {
  const normalizedSessionId = sessionId.trim();
  const state = loadInternal();

  const votes = state.votes
    .filter((vote) => vote.sessionId === normalizedSessionId)
    .slice()
    .sort((a, b) => b.ratedAt - a.ratedAt);
  const dismissalRecord = state.dismissals.find((d) => d.sessionId === normalizedSessionId) ?? null;

  return {
    votes,
    dismissedAt: dismissalRecord?.dismissedAt ?? null,
  };
};

export const hasConversationFeedback = (sessionId: string): boolean => {
  const result = getConversationFeedback(sessionId);
  return result.votes.length > 0 || Boolean(result.dismissedAt);
};

export const writeBackSentryEventId = (voteId: string, sentryEventId: string): void => {
  const state = loadInternal();
  const voteIndex = state.votes.findIndex((vote) => vote.voteId === voteId);
  if (voteIndex === -1) {
    log.warn({ voteId }, 'Conversation vote not found for Sentry event writeback');
    return;
  }

  const nextVotes = state.votes.slice();
  nextVotes[voteIndex] = {
    ...nextVotes[voteIndex],
    sentryEventId,
  };
  saveInternal({
    ...state,
    votes: nextVotes,
  });
};

