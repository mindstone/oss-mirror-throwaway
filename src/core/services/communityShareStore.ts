/**
 * Community Share Store
 *
 * Persists state for the community share wins feature.
 * Tracks which sessions have been evaluated, eligibility results, composed
 * previews, daily limits, and opt-out preference.
 */

import type { KeyValueStore } from '@core/store';
import { safeCreateStore } from '@core/utils/loadStoreSafely';
import type { CommunityShareEligibility, CommunitySharePreview } from '@shared/types';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'communityShareStore' });

const COMMUNITY_SHARE_STORE_VERSION = 1;
const MAX_EVALUATED_SESSION_IDS = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Store Shape
// ─────────────────────────────────────────────────────────────────────────────

type CommunityShareStoreState = {
  version: number;
  optedOut: boolean;
  evaluatedSessionIds: string[];
  eligibleSessions: Record<string, CommunityShareEligibility>;
  previews: Record<string, CommunitySharePreview>;
  dailyCount: number;
  dailyCountDate: string;
};

let communityShareReadOnlyMode = false;

const createDefaultState = (): CommunityShareStoreState => ({
  version: COMMUNITY_SHARE_STORE_VERSION,
  optedOut: false,
  evaluatedSessionIds: [],
  eligibleSessions: {},
  previews: {},
  dailyCount: 0,
  dailyCountDate: '',
});

let _store: KeyValueStore<CommunityShareStoreState> | null = null;
let _initialized = false;
const getStore = () => {
  if (!_store) {
    // Guard CONSTRUCTION: conf (and now the cloud shim) throws at construct time
    // when the backing `community-share.json` is present-but-unreadable (corrupt
    // JSON / schema / transient IO). `safeCreateStore` preserves + backs up the
    // raw file, latches an ephemeral read-only store, and never crashes init —
    // so a corrupt-construct can't wipe real user data (optedOut, eligibility,
    // previews). Read-only-until-restart by design.
    const created = safeCreateStore<CommunityShareStoreState>(
      { name: 'community-share', defaults: createDefaultState() },
      createDefaultState(),
    );
    _store = created.store;
    if (created.loadFailed) {
      communityShareReadOnlyMode = true;
    }
  }
  if (!_initialized) {
    _initialized = true;
    const storedVersion = _store.store.version;
    if (storedVersion > COMMUNITY_SHARE_STORE_VERSION) {
      log.warn(
        { dataVersion: storedVersion, currentVersion: COMMUNITY_SHARE_STORE_VERSION },
        'Community share data from newer version, entering read-only mode'
      );
      communityShareReadOnlyMode = true;
    }
  }
  return _store;
};

/**
 * Read-only check that GUARANTEES the store has been loaded first.
 *
 * `communityShareReadOnlyMode` defaults to `false` and is only set during
 * `getStore()`'s one-time init — either a corrupt-construct load failure
 * (`safeCreateStore` → `loadFailed`) or future-version detection. A writer that
 * checks the bare flag as the FIRST touch (no prior read) would see a stale
 * `false` and bypass the guard — writing over a real on-disk store that's
 * corrupt or from a newer app version. Calling `getStore()` here forces init
 * (which sets the flag) before we read it, making every guard first-touch-safe
 * by construction.
 */
const isCommunityShareReadOnly = (): boolean => {
  getStore();
  return communityShareReadOnlyMode;
};

const requireStoreValue = <K extends keyof CommunityShareStoreState>(
  key: K
): NonNullable<CommunityShareStoreState[K]> => {
  const value = getStore().get(key);
  if (value === undefined || value === null) {
    throw new Error(`communityShareStore invariant violation: ${String(key)} is missing`);
  }
  return value as NonNullable<CommunityShareStoreState[K]>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Opt-Out
// ─────────────────────────────────────────────────────────────────────────────

export const isOptedOut = (): boolean => {
  return getStore().get('optedOut', false);
};

export const setOptedOut = (value: boolean): void => {
  if (isCommunityShareReadOnly()) return;
  getStore().set('optedOut', value);
  log.info({ optedOut: value }, 'Community share opt-out updated');
};

// ─────────────────────────────────────────────────────────────────────────────
// Session Evaluation Tracking
// ─────────────────────────────────────────────────────────────────────────────

export const isSessionEvaluated = (sessionId: string): boolean => {
  const ids = requireStoreValue('evaluatedSessionIds');
  return ids.includes(sessionId);
};

export const markSessionEvaluated = (sessionId: string): void => {
  if (isCommunityShareReadOnly()) return;
  const ids = requireStoreValue('evaluatedSessionIds');
  if (ids.includes(sessionId)) return;

  // Bounded list: keep only the last MAX_EVALUATED_SESSION_IDS
  const updated = [...ids, sessionId].slice(-MAX_EVALUATED_SESSION_IDS);
  getStore().set('evaluatedSessionIds', updated);
  log.debug({ sessionId }, 'Session marked as evaluated for community share');
};

// ─────────────────────────────────────────────────────────────────────────────
// Daily Count (with date-based reset)
// ─────────────────────────────────────────────────────────────────────────────

export const getDailyCount = (): number => {
  const today = new Date().toDateString();
  const storedDate = getStore().get('dailyCountDate');

  if (storedDate !== today) {
    // Reset for new day
    if (!isCommunityShareReadOnly()) {
      getStore().set('dailyCount', 0);
      getStore().set('dailyCountDate', today);
    }
    log.debug({ date: today }, 'Reset daily community share count');
    return 0;
  }

  return getStore().get('dailyCount', 0);
};

export const incrementDailyCount = (): void => {
  if (isCommunityShareReadOnly()) return;

  // Ensure date is current before incrementing
  const today = new Date().toDateString();
  const storedDate = getStore().get('dailyCountDate');

  if (storedDate !== today) {
    getStore().set('dailyCount', 1);
    getStore().set('dailyCountDate', today);
  } else {
    const current = requireStoreValue('dailyCount');
    getStore().set('dailyCount', current + 1);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility Storage
// ─────────────────────────────────────────────────────────────────────────────

export const storeEligibility = (eligibility: CommunityShareEligibility): void => {
  if (isCommunityShareReadOnly()) return;
  const sessions = getStore().get('eligibleSessions');
  getStore().set('eligibleSessions', {
    ...sessions,
    [eligibility.sessionId]: eligibility,
  });
  log.debug({ sessionId: eligibility.sessionId }, 'Stored community share eligibility');
};

export const getEligibility = (sessionId: string): CommunityShareEligibility | undefined => {
  const sessions = requireStoreValue('eligibleSessions');
  return sessions[sessionId];
};

export const getAllPendingEligible = (): CommunityShareEligibility[] => {
  const sessions = requireStoreValue('eligibleSessions');
  return Object.values(sessions);
};

export const dismissEligibility = (sessionId: string): void => {
  if (isCommunityShareReadOnly()) return;
  const sessions = requireStoreValue('eligibleSessions');
  const { [sessionId]: _removed, ...remaining } = sessions;
  getStore().set('eligibleSessions', remaining);
  log.debug({ sessionId }, 'Dismissed community share eligibility');
};

// ─────────────────────────────────────────────────────────────────────────────
// Preview Storage
// ─────────────────────────────────────────────────────────────────────────────

export const storePreview = (preview: CommunitySharePreview): void => {
  if (isCommunityShareReadOnly()) return;
  const previews = getStore().get('previews');
  getStore().set('previews', {
    ...previews,
    [preview.sessionId]: preview,
  });
  log.debug({ sessionId: preview.sessionId }, 'Stored community share preview');
};

export const getPreview = (sessionId: string): CommunitySharePreview | undefined => {
  const previews = requireStoreValue('previews');
  return previews[sessionId];
};

// ─────────────────────────────────────────────────────────────────────────────
// Session Data Cleanup (e.g., when session is resumed)
// ─────────────────────────────────────────────────────────────────────────────

export const clearSessionData = (sessionId: string): void => {
  if (isCommunityShareReadOnly()) return;

  const eligibleSessions = requireStoreValue('eligibleSessions');
  const previews = requireStoreValue('previews');

  const { [sessionId]: _eligibility, ...remainingEligible } = eligibleSessions;
  const { [sessionId]: _preview, ...remainingPreviews } = previews;

  getStore().set('eligibleSessions', remainingEligible);
  getStore().set('previews', remainingPreviews);

  // Also remove from evaluatedSessionIds so the session can be
  // re-evaluated after resume (new turns may cross the threshold again)
  const ids = requireStoreValue('evaluatedSessionIds');
  const updatedIds = ids.filter((id: string) => id !== sessionId);
  if (updatedIds.length !== ids.length) {
    getStore().set('evaluatedSessionIds', updatedIds);
  }

  log.debug({ sessionId }, 'Cleared community share data for session');
};
