/**
 * Time Saved Backfill Service
 *
 * Bounded, idempotent recovery path for time-saved entries that were missed
 * while the live BTS estimator was silently failing (see
 * `docs-private/investigations/260520_time_saved_zero_or_missing.md`). Walks the
 * user's local session store, identifies user-visible assistant turns that
 * have no corresponding `time-saved.json` entry, and replays the estimator
 * against each candidate — preserving the original turn timestamp so weekly
 * and monthly aggregates land in the correct bucket.
 *
 * Design notes
 * ------------
 * - **Privacy:** Never logs message content. Only metadata (sessionId, turnId,
 *   timestamps, week bucket, counts) appears in structured logs.
 * - **Bounded:** Caps the number of turns processed per run (default
 *   `DEFAULT_MAX_TURNS`). Re-runs are safe because the store-level dedup in
 *   `addTimeSavedEntryAt()` and the pre-check in
 *   `recoverTimeSavedEntryForTurn()` make every recovered turn idempotent.
 * - **Conservative:** Re-uses the live estimator path verbatim — same
 *   prompt, same schema-invalid retry, same skepticism. We do not synthesise
 *   estimates. If the estimator returns no result, no entry is written.
 * - **Two-phase API:** `scanTimeSavedBackfillCandidates()` is metadata-only
 *   and safe to run without auth (the script wrapper uses it for dry-run).
 *   `runTimeSavedBackfill()` actually calls the estimator and writes entries.
 */

import type { AgentSession, AgentSessionSummary } from '@shared/types';
import { classifySessionKind, shouldSkipTimeSaved } from '@shared/sessionKind';
import { createScopedLogger } from '@core/logger';
import { getIncrementalSessionStore } from './incrementalSessionStore';
import {
  getLatestEntryTimestamp,
  hasTimeSavedEntryForTurn,
} from './timeSavedStore';
import {
  recoverTimeSavedEntryForTurn,
  type RecoverTimeSavedOutcome,
  type TurnContextForTimeSaved,
} from './timeSavedService';

const log = createScopedLogger({ service: 'timeSavedBackfill' });

const MIN_TURN_DURATION_SECONDS = 30; // Mirrors timeSavedService MIN_TURN_DURATION_MS / 1000
const MAX_USER_PROMPT_CHARS = 4000; // Match the live trigger path (no full prompt expansion)
const MAX_FINAL_SUMMARY_CHARS = 2000; // Matches agentMessageHandler's slice(0, 2000)
const SUMMARY_UPDATED_AT_PREFILTER_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_TURNS = 10;

/**
 * Minimal session-store interface the backfill service needs. The default
 * implementation defers to `getIncrementalSessionStore()`; tests substitute
 * an in-memory stub so they don't have to bootstrap the full store.
 */
export interface BackfillSessionSource {
  listSessionSummaries(): AgentSessionSummary[];
  getSession(id: string): Promise<AgentSession | null>;
}

/**
 * Default source backed by the production incremental session store. The
 * `includeInternal: true` flag is necessary because some sidebar-hidden
 * kinds (memory-update, meeting-qa, …) still have to be enumerated so the
 * `shouldSkipTimeSaved` filter can do its job; the filter itself is the
 * real gatekeeper.
 */
const defaultSessionSource: BackfillSessionSource = {
  listSessionSummaries: () => getIncrementalSessionStore().listSessions({ includeInternal: true }),
  getSession: (id) => getIncrementalSessionStore().getSession(id),
};

export interface BackfillCandidate {
  /** Owning session id. */
  sessionId: string;
  /** Turn id (matches `turnId` on `AgentTurnMessage` / `eventsByTurn`). */
  turnId: string;
  /** Epoch milliseconds of the original turn (typically result.createdAt). */
  timestamp: number;
  /** Duration of the turn in seconds (used for MIN_TURN_DURATION gate). */
  durationSeconds: number;
  /** ISO date (YYYY-MM-DD, local time) of the week start for grouping. */
  weekStartDate: string;
  /** Tool event count in the turn (no content, count only). */
  toolEventCount: number;
}

export interface BackfillScanCounts {
  /** Total candidate turns that match the selection criteria. */
  candidates: number;
  /** Sessions visited during the scan. */
  sessionsScanned: number;
  /** Sessions skipped because they were soft-deleted. */
  sessionsSkippedDeleted: number;
  /** Sessions skipped because they were not time-saved-eligible kinds. */
  sessionsSkippedKind: number;
  /** Sessions skipped because they were missing/unreadable on disk. */
  sessionsSkippedMissing: number;
  /** Sessions skipped because summary.updatedAt is safely before the cutoff margin. */
  sessionsSkippedPrefiltered: number;
  /** Turns skipped because an entry already exists for them. */
  turnsSkippedDuplicate: number;
  /** Turns skipped because their duration was under the threshold. */
  turnsSkippedShort: number;
  /** Turns skipped because there was no usable user prompt / result text. */
  turnsSkippedNoContext: number;
  /** Turns skipped because their timestamp was on/before the cutoff. */
  turnsSkippedBeforeCutoff: number;
}

export interface BackfillScanResult {
  /** Cutoff used for filtering (turns at or before this are skipped). */
  cutoffMs: number;
  /** All candidates (capped at `limit` if provided). */
  candidates: BackfillCandidate[];
  /** Candidate count grouped by week start date. */
  candidatesByWeek: Record<string, number>;
  counts: BackfillScanCounts;
}

export interface BackfillScanOptions {
  /** Lower-bound exclusive cutoff for `result.createdAt`. */
  cutoffMs?: number;
  /** Hard cap on candidates returned. */
  limit?: number;
  /** Override the session source (tests inject an in-memory stub). */
  sessionSource?: BackfillSessionSource;
}

export interface BackfillRunOptions {
  /** Lower-bound exclusive cutoff for `result.createdAt`. */
  cutoffMs?: number;
  /** Hard cap on turns to estimate per run. */
  maxTurns?: number;
  /** Max number of estimator calls in flight. Defaults to 1 for conservative repair. */
  concurrency?: number;
  /** Override the session source (tests inject an in-memory stub). */
  sessionSource?: BackfillSessionSource;
  /** Optional progress hook called after each turn is processed. */
  onProgress?: (progress: BackfillProgress) => void;
  /**
   * Optional pre-scanned candidate list. Used by bounded multi-batch repair
   * loops to avoid rehydrating the corpus for every batch.
   */
  preScannedCandidates?: BackfillCandidate[];
  /**
   * Optional injected recovery function — exists so tests can avoid running
   * the real BTS estimator. Defaults to {@link recoverTimeSavedEntryForTurn}.
   */
  recoverFn?: (
    context: TurnContextForTimeSaved,
    originalTimestamp: number,
  ) => Promise<RecoverTimeSavedOutcome>;
}

export interface BackfillProgress {
  index: number;
  total: number;
  sessionId: string;
  turnId: string;
  outcome: RecoverTimeSavedOutcome['status'];
}

export interface BackfillRunOutcome {
  candidate: BackfillCandidate;
  outcome: RecoverTimeSavedOutcome;
}

export interface BackfillRunSummary {
  cutoffMs: number;
  maxTurns: number;
  /** Total candidates the scan produced (before maxTurns cap). */
  candidatesFound: number;
  /** Number of candidates the run actually attempted (≤ maxTurns). */
  attempted: number;
  persistedCount: number;
  persistedMinutesTotal: number;
  /** Persisted minutes grouped by week start. */
  persistedMinutesByWeek: Record<string, number>;
  outcomes: BackfillRunOutcome[];
  outcomeCounts: Record<RecoverTimeSavedOutcome['status'], number>;
}

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------

const getWeekStartDate = (date: Date): string => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start (matches timeSavedStore)
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

interface TurnReconstruction {
  turnId: string;
  userText: string;
  resultText: string;
  toolEventCount: number;
  userTimestamp: number;
  resultTimestamp: number;
  durationSeconds: number;
}

const reconstructTurnsForSession = (session: AgentSession): TurnReconstruction[] => {
  const userByTurn = new Map<string, { text: string; createdAt: number }>();
  const resultByTurn = new Map<string, { text: string; createdAt: number }>();

  for (const message of session.messages ?? []) {
    if (!message?.turnId) continue;
    if (message.deletedAt) continue;
    if (message.role === 'user') {
      // Prefer the first user message recorded for the turn; later "user_question_answered"
      // injections share the same turnId in some flows.
      if (!userByTurn.has(message.turnId)) {
        userByTurn.set(message.turnId, { text: message.text ?? '', createdAt: message.createdAt });
      }
    } else if (message.role === 'result') {
      // Prefer the latest result if for some reason there are multiple.
      const existing = resultByTurn.get(message.turnId);
      if (!existing || (message.createdAt ?? 0) > existing.createdAt) {
        resultByTurn.set(message.turnId, { text: message.text ?? '', createdAt: message.createdAt });
      }
    }
  }

  const reconstructed: TurnReconstruction[] = [];
  for (const [turnId, result] of resultByTurn) {
    // Note: we keep turns with missing user/result text in the reconstruction
    // and let the scan/run loop count them under `turnsSkippedNoContext` so
    // metadata reporting reflects the real shape of the user's data.
    const user = userByTurn.get(turnId) ?? { text: '', createdAt: result.createdAt };

    const events = session.eventsByTurn?.[turnId] ?? [];
    const toolStartEvents = events.filter((e) => e.type === 'tool' && (e as { stage?: string }).stage === 'start');
    const toolEventCount = toolStartEvents.length > 0
      ? toolStartEvents.length
      : events.filter((e) => e.type === 'tool').length;

    const durationMs = Math.max(0, (result.createdAt ?? 0) - (user.createdAt ?? 0));
    const durationSeconds = Math.round(durationMs / 1000);

    reconstructed.push({
      turnId,
      userText: user.text,
      resultText: result.text,
      toolEventCount,
      userTimestamp: user.createdAt,
      resultTimestamp: result.createdAt,
      durationSeconds,
    });
  }

  // Sort oldest-first so cutoff filtering and bounded runs process turns in
  // chronological order. Re-runs after a partial completion therefore pick up
  // from where the previous run left off naturally.
  reconstructed.sort((a, b) => a.resultTimestamp - b.resultTimestamp);
  return reconstructed;
};

const buildTimeSavedContext = (
  sessionId: string,
  turn: TurnReconstruction,
): TurnContextForTimeSaved => {
  const toolSummary = turn.toolEventCount > 0 ? `${turn.toolEventCount} tool calls` : 'No tools used';
  return {
    turnId: turn.turnId,
    sessionId,
    userPrompt: turn.userText.slice(0, MAX_USER_PROMPT_CHARS),
    finalSummary: turn.resultText.slice(0, MAX_FINAL_SUMMARY_CHARS),
    toolSummary,
    durationSeconds: turn.durationSeconds,
  };
};

const emptyCounts = (): BackfillScanCounts => ({
  candidates: 0,
  sessionsScanned: 0,
  sessionsSkippedDeleted: 0,
  sessionsSkippedKind: 0,
  sessionsSkippedMissing: 0,
  sessionsSkippedPrefiltered: 0,
  turnsSkippedDuplicate: 0,
  turnsSkippedShort: 0,
  turnsSkippedNoContext: 0,
  turnsSkippedBeforeCutoff: 0,
});

const emptyOutcomeCounts = (): Record<RecoverTimeSavedOutcome['status'], number> => ({
  persisted: 0,
  skipped_disabled: 0,
  skipped_short: 0,
  skipped_no_auth: 0,
  skipped_duplicate: 0,
  parse_failure: 0,
  invalid_structure: 0,
  error: 0,
  not_initialized: 0,
});

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * Default cutoff used when no explicit `cutoffMs` is provided: the timestamp
 * of the most recent persisted entry (so re-runs naturally narrow), falling
 * back to the previous 90 days if the store is empty.
 */
export const defaultBackfillCutoffMs = (): number => {
  const latest = getLatestEntryTimestamp();
  if (latest != null) return latest;
  return Date.now() - 90 * 24 * 60 * 60 * 1000;
};

/**
 * Metadata-only scan. Safe to run without auth — never calls the LLM. Returns
 * counts and per-week candidate breakdowns plus the (capped) candidate list.
 */
export const scanTimeSavedBackfillCandidates = async (
  options: BackfillScanOptions = {},
): Promise<BackfillScanResult> => {
  const sessionSource = options.sessionSource ?? defaultSessionSource;
  const cutoffMs = options.cutoffMs ?? defaultBackfillCutoffMs();
  const limit = options.limit;
  const prefilterCutoffMs = cutoffMs - SUMMARY_UPDATED_AT_PREFILTER_MARGIN_MS;

  const summaries = sessionSource.listSessionSummaries();
  const counts = emptyCounts();
  const candidates: BackfillCandidate[] = [];

  for (const summary of summaries) {
    counts.sessionsScanned += 1;

    if (summary.deletedAt) {
      counts.sessionsSkippedDeleted += 1;
      continue;
    }

    const kind = classifySessionKind(summary.id);
    if (shouldSkipTimeSaved(kind)) {
      counts.sessionsSkippedKind += 1;
      continue;
    }

    // Deliberate safety margin: see docs/plans/260611_perf-idle-churn/PLAN.md Stage 5.
    if (summary.updatedAt <= prefilterCutoffMs) {
      counts.sessionsSkippedPrefiltered += 1;
      continue;
    }

    let session: AgentSession | null;
    try {
      session = await sessionSource.getSession(summary.id);
    } catch (err) {
      counts.sessionsSkippedMissing += 1;
      log.debug({ sessionId: summary.id, err: err instanceof Error ? err.message : String(err) }, 'Skipping session that failed to load');
      continue;
    }
    if (!session) {
      counts.sessionsSkippedMissing += 1;
      continue;
    }

    const turns = reconstructTurnsForSession(session);
    for (const turn of turns) {
      if (!turn.userText || !turn.resultText) {
        counts.turnsSkippedNoContext += 1;
        continue;
      }
      if (turn.durationSeconds < MIN_TURN_DURATION_SECONDS) {
        counts.turnsSkippedShort += 1;
        continue;
      }
      if (turn.resultTimestamp <= cutoffMs) {
        counts.turnsSkippedBeforeCutoff += 1;
        continue;
      }
      if (hasTimeSavedEntryForTurn(turn.turnId)) {
        counts.turnsSkippedDuplicate += 1;
        continue;
      }

      candidates.push({
        sessionId: summary.id,
        turnId: turn.turnId,
        timestamp: turn.resultTimestamp,
        durationSeconds: turn.durationSeconds,
        weekStartDate: getWeekStartDate(new Date(turn.resultTimestamp)),
        toolEventCount: turn.toolEventCount,
      });
    }
  }

  // Oldest first so bounded runs process in chronological order; aligns with
  // reconstructTurnsForSession() ordering and gives consistent re-run behaviour.
  candidates.sort((a, b) => a.timestamp - b.timestamp);

  const capped = typeof limit === 'number' && limit > 0 ? candidates.slice(0, limit) : candidates;
  counts.candidates = capped.length;

  const candidatesByWeek: Record<string, number> = {};
  for (const c of capped) {
    candidatesByWeek[c.weekStartDate] = (candidatesByWeek[c.weekStartDate] ?? 0) + 1;
  }

  log.info(
    {
      cutoffMs,
      prefilterCutoffMs,
      limit,
      candidatesFound: candidates.length,
      candidatesReturned: capped.length,
      counts,
    },
    'Completed time-saved backfill candidate scan',
  );

  return {
    cutoffMs,
    candidates: capped,
    candidatesByWeek,
    counts,
  };
};

/**
 * Run the bounded backfill: scan, take at most `maxTurns` oldest candidates,
 * call the recovery estimator for each, and aggregate outcomes.
 */
export const runTimeSavedBackfill = async (
  options: BackfillRunOptions = {},
): Promise<BackfillRunSummary> => {
  const sessionSource = options.sessionSource ?? defaultSessionSource;
  const cutoffMs = options.cutoffMs ?? defaultBackfillCutoffMs();
  const maxTurns = Math.max(1, options.maxTurns ?? DEFAULT_MAX_TURNS);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 1, maxTurns));
  const recoverFn = options.recoverFn ?? recoverTimeSavedEntryForTurn;

  const candidates = options.preScannedCandidates ?? (
    await scanTimeSavedBackfillCandidates({
      cutoffMs,
      sessionSource,
      // Intentionally do not pass `limit` to the scan: we want the full
      // candidate population for the summary, then cap the *run* below.
    })
  ).candidates;
  const candidatesFound = candidates.length;
  const toAttempt = candidates.slice(0, maxTurns);

  const candidatesByWeek: Record<string, number> = {};
  for (const c of candidates) {
    candidatesByWeek[c.weekStartDate] = (candidatesByWeek[c.weekStartDate] ?? 0) + 1;
  }

  log.info(
    {
      candidatesFound,
      attempting: toAttempt.length,
      cutoffMs,
      maxTurns,
      concurrency,
      candidatesByWeek,
    },
    'Starting time-saved backfill run',
  );

  const outcomes: BackfillRunOutcome[] = [];
  const outcomeCounts = emptyOutcomeCounts();
  const persistedMinutesByWeek: Record<string, number> = {};
  let persistedMinutesTotal = 0;
  let persistedCount = 0;

  const recordOutcome = (index: number, candidate: BackfillCandidate, outcome: RecoverTimeSavedOutcome): void => {
    outcomes.push({ candidate, outcome });
    outcomeCounts[outcome.status] += 1;

    if (outcome.status === 'persisted') {
      persistedCount += 1;
      const midpoint = (outcome.estimate.lowMinutes + outcome.estimate.highMinutes) / 2;
      persistedMinutesTotal += midpoint;
      persistedMinutesByWeek[candidate.weekStartDate] =
        (persistedMinutesByWeek[candidate.weekStartDate] ?? 0) + midpoint;
    }

    options.onProgress?.({
      index: index + 1,
      total: toAttempt.length,
      sessionId: candidate.sessionId,
      turnId: candidate.turnId,
      outcome: outcome.status,
    });
  };

  const processCandidate = async (index: number): Promise<void> => {
    const candidate = toAttempt[index];
    if (hasTimeSavedEntryForTurn(candidate.turnId)) {
      const outcome: RecoverTimeSavedOutcome = { status: 'skipped_duplicate' };
      recordOutcome(index, candidate, outcome);
      return;
    }

    let session: AgentSession | null;
    try {
      session = await sessionSource.getSession(candidate.sessionId);
    } catch (err) {
      log.warn(
        { sessionId: candidate.sessionId, turnId: candidate.turnId, err: err instanceof Error ? err.message : String(err) },
        'Failed to reload session for backfill — counting as error',
      );
      const outcome: RecoverTimeSavedOutcome = { status: 'error', detail: 'session_reload_failed' };
      recordOutcome(index, candidate, outcome);
      return;
    }
    if (!session) {
      const outcome: RecoverTimeSavedOutcome = { status: 'error', detail: 'session_missing' };
      recordOutcome(index, candidate, outcome);
      return;
    }

    const turns = reconstructTurnsForSession(session);
    const turn = turns.find((t) => t.turnId === candidate.turnId);
    if (!turn) {
      const outcome: RecoverTimeSavedOutcome = { status: 'error', detail: 'turn_missing' };
      recordOutcome(index, candidate, outcome);
      return;
    }

    const context = buildTimeSavedContext(candidate.sessionId, turn);
    const outcome = await recoverFn(context, candidate.timestamp);
    recordOutcome(index, candidate, outcome);
  };

  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, toAttempt.length) }, async () => {
    while (nextIndex < toAttempt.length) {
      const index = nextIndex;
      nextIndex += 1;
      await processCandidate(index);
    }
  });
  await Promise.all(workers);

  const summary: BackfillRunSummary = {
    cutoffMs,
    maxTurns,
    candidatesFound,
    attempted: toAttempt.length,
    persistedCount,
    persistedMinutesTotal,
    persistedMinutesByWeek,
    outcomes,
    outcomeCounts,
  };

  log.info(
    {
      candidatesFound,
      attempted: toAttempt.length,
      persistedCount,
      persistedMinutesTotal,
      outcomeCounts,
    },
    'Completed time-saved backfill run',
  );

  return summary;
};
