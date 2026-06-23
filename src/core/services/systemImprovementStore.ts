/**
 * System Improvement Store
 *
 * Persists improvement suggestions, evaluation tracking, and daily budget.
 * Follows the coaching store pattern: simple createStore with lazy getStore().
 *
 * @see docs/plans/partway/260310_system_improvement_loop.md
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import type {
  SystemImprovementStoreState,
  SystemImprovementSuggestion,
  SuggestionState,
} from '@core/systemImprovementTypes';
import { SYSTEM_IMPROVEMENT_STORE_VERSION } from '@core/constants';

const log = createScopedLogger({ service: 'systemImprovementStore' });

const SUGGESTION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_EVALUATED_SESSION_IDS = 200;

const createDefaultState = (): SystemImprovementStoreState => ({
  version: SYSTEM_IMPROVEMENT_STORE_VERSION,
  suggestions: {},
  evaluatedSessionIds: [],
  dailyCount: 0,
  dailyCountDate: '',
});

let _store: KeyValueStore<SystemImprovementStoreState> | null = null;

function getStore(): KeyValueStore<SystemImprovementStoreState> {
  if (!_store) {
    _store = createStore<SystemImprovementStoreState>({
      name: 'system-improvement',
      defaults: createDefaultState(),
    });
  }
  return _store;
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getDailyCount(): number {
  const store = getStore();
  const today = todayString();
  if (store.get('dailyCountDate') !== today) return 0;
  return store.get('dailyCount') ?? 0;
}

export function incrementDailyCount(): void {
  const store = getStore();
  const today = todayString();
  if (store.get('dailyCountDate') !== today) {
    store.set('dailyCountDate', today);
    store.set('dailyCount', 1);
  } else {
    store.set('dailyCount', (store.get('dailyCount') ?? 0) + 1);
  }
}

export function isSessionEvaluated(sessionId: string): boolean {
  const ids = getStore().get('evaluatedSessionIds') ?? [];
  return ids.includes(sessionId);
}

export function markSessionEvaluated(sessionId: string): void {
  const store = getStore();
  const ids = store.get('evaluatedSessionIds') ?? [];
  if (!ids.includes(sessionId)) {
    const updated = [...ids, sessionId].slice(-MAX_EVALUATED_SESSION_IDS);
    store.set('evaluatedSessionIds', updated);
  }
}

export function getPendingSuggestions(): SystemImprovementSuggestion[] {
  const suggestions = getStore().get('suggestions') ?? {};
  const now = Date.now();
  return Object.values(suggestions)
    .filter((s) => s.state === 'pending' && now - s.evaluatedAt < SUGGESTION_TTL_MS)
    .sort((a, b) => b.evaluatedAt - a.evaluatedAt);
}

export function updateSuggestionState(
  id: string,
  state: SuggestionState
): boolean {
  const store = getStore();
  const suggestions = { ...store.get('suggestions') };
  const suggestion = suggestions[id];
  if (!suggestion) return false;

  suggestions[id] = { ...suggestion, state, stateUpdatedAt: Date.now() };
  store.set('suggestions', suggestions);
  log.info({ id, state }, 'Updated suggestion state');
  return true;
}

/** Reset store for testing */
export function _resetStore(): void {
  _store = null;
}
