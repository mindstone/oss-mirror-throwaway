/**
 * Hero Choice Store
 *
 * Persists daily hero choice results and user interaction state.
 * Capped at 10 entries (most recent). Uses lazy getStore() pattern.
 *
 * @see docs/plans/260315_spark_redesign.md
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import type {
  HeroChoiceStoreState,
  HeroChoiceResult,
  HeroChoiceEntry,
  HeroChoiceCandidate,
  HeroChoiceCandidateState,
} from '@core/heroChoiceTypes';

const log = createScopedLogger({ service: 'heroChoiceStore' });

const MAX_ENTRIES = 10;

const createDefaultState = (): HeroChoiceStoreState => ({
  entries: [],
});

let _store: KeyValueStore<HeroChoiceStoreState> | null = null;

function getStore(): KeyValueStore<HeroChoiceStoreState> {
  if (!_store) {
    _store = createStore<HeroChoiceStoreState>({
      name: 'hero-choice',
      defaults: createDefaultState(),
    });
  }
  return _store;
}

/**
 * Returns the best hero choice entry to show.
 * Prefers the newest entry, but falls through to older entries if the newest
 * has no actionable (pending + non-expired) candidates remaining.
 * Returns null if no entries exist or all are exhausted.
 */
export function getCurrentHeroChoice(): HeroChoiceEntry | null {
  const entries = getStore().get('entries') ?? [];
  const now = Date.now();

  for (const entry of entries) {
    const hasPending = entry.result.candidates.some((c) => {
      if (entry.candidateStates[c.id] !== 'pending') return false;
      // Skip expired meeting_prep
      if (c.type === 'meeting_prep' && c.meetingStartTime != null && c.meetingStartTime <= now) return false;
      return true;
    });
    if (hasPending) return entry;
  }

  // All entries exhausted — return newest for "all caught up" state
  return entries.length > 0 ? entries[0] : null;
}

/** Adds a new hero choice result. Caps at MAX_ENTRIES (removes oldest). */
export function addHeroChoiceEntry(result: HeroChoiceResult): void {
  const store = getStore();
  const existing = store.get('entries') ?? [];

  // Initialize candidate states to 'pending'
  const candidateStates: Record<string, HeroChoiceCandidateState> = {};
  for (const candidate of result.candidates) {
    candidateStates[candidate.id] = 'pending';
  }

  const entry: HeroChoiceEntry = {
    result,
    candidateStates,
    feedback: {},
  };

  // Prepend new entry, cap at MAX_ENTRIES
  const updated = [entry, ...existing].slice(0, MAX_ENTRIES);
  store.set('entries', updated);

  log.info(
    { candidateCount: result.candidates.length, totalEntries: updated.length },
    'Added hero choice entry',
  );
}

/** Updates the state of a candidate, searching across all entries */
export function updateCandidateState(
  candidateId: string,
  state: HeroChoiceCandidateState,
): boolean {
  const store = getStore();
  const entries = [...(store.get('entries') ?? [])];

  for (let i = 0; i < entries.length; i++) {
    if (candidateId in entries[i].candidateStates) {
      entries[i] = {
        ...entries[i],
        candidateStates: {
          ...entries[i].candidateStates,
          [candidateId]: state,
        },
      };
      store.set('entries', entries);
      log.info({ candidateId, state }, 'Updated candidate state');
      return true;
    }
  }

  return false;
}

/** Sets user feedback on a candidate, searching across all entries */
export function setCandidateFeedback(
  candidateId: string,
  feedback: 'helpful' | 'not_helpful',
): boolean {
  const store = getStore();
  const entries = [...(store.get('entries') ?? [])];

  for (let i = 0; i < entries.length; i++) {
    if (candidateId in entries[i].candidateStates) {
      entries[i] = {
        ...entries[i],
        feedback: {
          ...entries[i].feedback,
          [candidateId]: feedback,
        },
      };
      store.set('entries', entries);
      log.info({ candidateId, feedback }, 'Set candidate feedback');
      return true;
    }
  }

  return false;
}

/**
 * Auto-dismiss meeting_prep candidates whose meeting has already started.
 * Returns the number of candidates dismissed.
 */
export function dismissExpiredMeetingPrep(): number {
  const store = getStore();
  const entries = [...(store.get('entries') ?? [])];
  if (entries.length === 0) return 0;

  const current = entries[0];
  const now = Date.now();
  let dismissedCount = 0;

  const updatedStates = { ...current.candidateStates };

  for (const candidate of current.result.candidates) {
    if (
      candidate.type === 'meeting_prep' &&
      candidate.meetingStartTime != null &&
      candidate.meetingStartTime <= now &&
      updatedStates[candidate.id] === 'pending'
    ) {
      updatedStates[candidate.id] = 'dismissed';
      dismissedCount++;
    }
  }

  if (dismissedCount > 0) {
    entries[0] = { ...current, candidateStates: updatedStates };
    store.set('entries', entries);
    log.info({ dismissedCount }, 'Auto-dismissed expired meeting_prep candidates');
  }

  return dismissedCount;
}

/** Returns past candidates from all entries (for "don't repeat" context) */
export function getPastCandidates(limit = 30): HeroChoiceCandidate[] {
  const entries = getStore().get('entries') ?? [];
  const candidates: HeroChoiceCandidate[] = [];

  for (const entry of entries) {
    for (const candidate of entry.result.candidates) {
      candidates.push(candidate);
      if (candidates.length >= limit) return candidates;
    }
  }

  return candidates;
}

/** Reset store for testing */
export function _resetStore(): void {
  _store = null;
}
