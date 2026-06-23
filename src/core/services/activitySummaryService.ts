/**
 * Activity Summary Service
 *
 * Generates ONE grounded, plain sentence summarising what the agent did during
 * a single turn (e.g. "Pulled your Q3 numbers from Slack and drafted the
 * update."), then persists it per-turn on `AgentSession.activitySummaryByTurn`.
 *
 * Modelled on `conversationTitleService.ts`: cheap behind-the-scenes Haiku call
 * via `callBehindTheScenesWithAuth`, a 15s timeout with abort-vs-timeout
 * discrimination, a `hasValidAuth` gate, sanitisation to a single sentence, and
 * graceful `null`/no-write on failure (the renderer's deterministic count-line
 * recap is the fallback — see `turnActivityRecap.ts`).
 *
 * Cross-surface: lives in `@core` so desktop AND cloud generate it. Because the
 * shared agent-event dispatcher is the SINGLE call site and cloud traverses the
 * same path, generation must be IDEMPOTENT (Failure Mode F1). Idempotency is
 * enforced three ways:
 *   1. a module-level in-flight `Set` keyed `${sessionId}:${turnId}` (collapses
 *      concurrent invocations within a process),
 *   2. a persisted preflight — read `activitySummaryByTurn[turnId]` BEFORE the
 *      LLM call and skip if already present, and
 *   3. an apply-time recheck inside the queued read-modify-write before writing.
 *
 * @see docs/plans/260618_show-more-activity/PLAN.md (Stage 2)
 */

import type { AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { callBehindTheScenesWithAuth } from './behindTheScenesClient';
import { hasValidAuth } from '../utils/authEnvUtils';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

const log = createScopedLogger({ service: 'activitySummary' });

const ACTIVITY_SUMMARY_TIMEOUT_MS = 15_000;
/** Output budget — one short sentence; generous to avoid mid-sentence truncation. */
const ACTIVITY_SUMMARY_MAX_TOKENS = 64;
/** Hard cap on the rendered sentence length (chars) after sanitisation. */
const ACTIVITY_SUMMARY_MAX_CHARS = 200;
/** Trim bounds for the grounding inputs (keep the prompt cheap + bounded). */
const REQUEST_SNIPPET_LIMIT = 600;
const ANSWER_SNIPPET_LIMIT = 600;
const ACTIVITY_LOG_LINE_LIMIT = 40;
const ACTIVITY_LOG_LINE_CHARS = 120;

/**
 * Gating thresholds (Failure Mode "extra Haiku call per turn → cost"; DA
 * NICE-6, tightened by the Phase-7 final review — F2). Generate only for turns
 * that did real, summarisable work: >= 2 tool calls OR >= 1 file touched. The
 * duration-only arm was DROPPED: a long but tool-free / file-free turn has no
 * renderable recap host and would only produce a weak sentence grounded on
 * "no tool activity recorded"; such turns get the deterministic "Took 18s"
 * count-line path instead, never a generated sentence.
 */
const MIN_TOOL_CALLS = 2;

/**
 * The clean "real work" signal, taken from the `result` event's `toolMetrics`
 * (NOT the UI-deduped step counts). See `src/shared/types/agent.ts` (the
 * `result` event `toolMetrics` shape).
 */
export interface ActivitySummaryToolMetrics {
  totalToolCalls: number;
  filesCreated: number;
  filesEdited: number;
}

export interface ActivitySummaryInput {
  sessionId: string;
  turnId: string;
  /** Clean real-work signal from the result event. May be undefined (legacy/empty turn). */
  toolMetrics?: ActivitySummaryToolMetrics;
  /** Best-effort turn duration in ms (first-event → result). Used only for gating. */
  durationMs?: number;
  /**
   * Grounding activity lines describing exactly the tools/files/connectors used
   * this turn. The model must not claim anything outside this set. Caller builds
   * these from the turn's accumulated tool events (captured synchronously before
   * registry cleanup).
   */
  activityLines: string[];
  /** The user's request for this turn (raw text; XML wrappers stripped by caller). */
  turnRequest?: string;
  /** A trimmed snippet of the answer the agent gave this turn. */
  answerSnippet?: string;
}

export interface ActivitySummaryDeps {
  getSettings: () => AppSettings;
  /** Read the latest persisted summary map for the session (idempotency preflight). */
  getPersistedSummary: (sessionId: string, turnId: string) => Promise<string | null>;
  /**
   * Persist the generated sentence under `activitySummaryByTurn[turnId]` using a
   * queued read-modify-write. The mutator MUST re-check the apply-time guard
   * (return null to abort if a summary already exists for the turn) so a racing
   * invocation cannot double-write. Returns true if the write persisted.
   */
  persistSummary: (sessionId: string, turnId: string, sentence: string) => Promise<boolean>;
}

/** Module-level in-flight guard — collapses concurrent invocations within a process. */
const inFlight = new Set<string>();

const inFlightKey = (sessionId: string, turnId: string): string => `${sessionId}:${turnId}`;

/** @internal Test-only — reset the in-flight guard between tests. */
export function _resetActivitySummaryInFlightForTests(): void {
  inFlight.clear();
}

/**
 * True when the turn did enough real work to justify a generated summary.
 * Pure + exported for unit tests.
 */
export function shouldGenerateActivitySummary(input: {
  toolMetrics?: ActivitySummaryToolMetrics;
  /** Accepted for call-site shape compatibility; no longer gates (F2). */
  durationMs?: number;
}): boolean {
  const totalToolCalls = input.toolMetrics?.totalToolCalls ?? 0;
  const filesTouched = (input.toolMetrics?.filesCreated ?? 0) + (input.toolMetrics?.filesEdited ?? 0);
  return totalToolCalls >= MIN_TOOL_CALLS || filesTouched >= 1;
}

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit).trim()}…`;

const normalizeWhitespace = (value: string): string => value.trim().replace(/\s+/g, ' ');

/**
 * Collapse the model's reply to ONE clean sentence:
 * - strip code fences, surrounding quotes, and a leading label ("Summary:")
 * - take the first non-empty line
 * - collapse whitespace, drop a trailing em/en dash, cap length
 *
 * Returns '' when nothing usable remains (caller treats '' as failure → no write).
 * Pure + exported for unit tests.
 */
export function sanitizeActivitySummary(raw: string): string {
  if (!raw) return '';

  const withoutFence = raw.replace(/```/g, '');
  const firstLine =
    withoutFence
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? withoutFence.trim();

  const withoutLabel = firstLine.replace(/^\s*(summary|recap|activity)\s*[:\-]+\s*/i, '');
  const strippedQuotes = withoutLabel.replace(/^["'`\s]+|["'`\s]+$/g, '');
  const collapsed = normalizeWhitespace(strippedQuotes);
  if (!collapsed) return '';

  // Enforce the one-sentence contract even if the model returns multiple
  // sentences on a single line (the first-line split above only handles
  // multi-line output). Keep the text up to and including the first sentence
  // terminator; if the model put several sentences on one line we drop the
  // rest so the calm single-line label never grows into a paragraph.
  const firstSentence = takeFirstSentence(collapsed);
  const cleaned = firstSentence.replace(/\s*[–—-]+\s*$/g, '').trim();
  if (!cleaned) return '';

  return cleaned.length <= ACTIVITY_SUMMARY_MAX_CHARS
    ? cleaned
    : truncate(cleaned, ACTIVITY_SUMMARY_MAX_CHARS);
}

/**
 * Return the first sentence of a single-line string, including its terminating
 * `.`/`!`/`?`. If there is no sentence terminator (or it is the very last
 * char), the whole string is returned. Abbreviation handling is intentionally
 * simple — this is a calm one-line label, not prose parsing.
 */
function takeFirstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](?=\s|$)/);
  if (!match) return text;
  const sentence = match[0].trim();
  // Guard against a leading terminator-only match producing an empty sentence.
  return sentence.length > 0 ? sentence : text;
}

/**
 * Build the grounded user prompt fed to the BTS model.
 *
 * Exported so the eval harness (`evals/activity-summary.ts`) drives the EXACT
 * production prompt-assembly path (trimming, activity-log fencing, the
 * "never claim anything not listed here" instruction) rather than a divergent
 * copy. Pure — no side effects.
 */
export function buildActivitySummaryPrompt(input: ActivitySummaryInput): string {
  const sections: string[] = [];

  if (input.turnRequest) {
    sections.push(`User request:\n${truncate(normalizeWhitespace(input.turnRequest), REQUEST_SNIPPET_LIMIT)}`);
  }

  const lines = input.activityLines
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line.length > 0)
    .slice(0, ACTIVITY_LOG_LINE_LIMIT)
    .map((line) => `- ${truncate(line, ACTIVITY_LOG_LINE_CHARS)}`);
  sections.push(
    lines.length > 0
      ? `Activity log (the only tools, files, and connectors used this turn — never claim anything not listed here):\n${lines.join('\n')}`
      : 'Activity log: (no tool activity recorded)',
  );

  if (input.answerSnippet) {
    sections.push(`Answer snippet:\n${truncate(normalizeWhitespace(input.answerSnippet), ANSWER_SNIPPET_LIMIT)}`);
  }

  sections.push(
    'Write one calm, plain sentence summarising what was done, grounded only in the activity log above.',
  );

  return sections.join('\n\n');
}

type SummaryOutcome =
  | { kind: 'success'; sentence: string }
  | { kind: 'aborted' }
  | { kind: 'timeout' }
  | { kind: 'failed' };

/**
 * Single BTS attempt with abort-vs-timeout discrimination (mirrors the title
 * service). Returns a rich outcome; never throws.
 */
async function generateActivitySummaryOnce(
  settings: AppSettings,
  input: ActivitySummaryInput,
): Promise<SummaryOutcome> {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, ACTIVITY_SUMMARY_TIMEOUT_MS);

  try {
    const response = await callBehindTheScenesWithAuth(
      settings,
      {
        codexConnectivity: resolveCodexConnectivity(),
        messages: [{ role: 'user', content: buildActivitySummaryPrompt(input) }],
        system: getPrompt(PROMPT_IDS.UTILITY_ACTIVITY_SUMMARY),
        maxTokens: ACTIVITY_SUMMARY_MAX_TOKENS,
        signal: timeoutController.signal,
      },
      {
        category: 'activity-summary',
        sessionId: input.sessionId,
        turnId: input.turnId,
      },
    );

    const content = response.content?.[0];
    if (content?.type === 'text' && content.text) {
      const sentence = sanitizeActivitySummary(content.text);
      if (sentence) {
        return { kind: 'success', sentence };
      }
      log.warn(
        { sessionId: input.sessionId, turnId: input.turnId, raw: content.text.slice(0, 60) },
        'Activity summary returned text but sanitisation produced empty result',
      );
      return { kind: 'failed' };
    }

    log.warn(
      { sessionId: input.sessionId, turnId: input.turnId },
      'Activity summary generation returned empty or invalid response',
    );
    return { kind: 'failed' };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      if (timedOut) {
        log.warn({ sessionId: input.sessionId, turnId: input.turnId }, 'Activity summary generation timed out');
        return { kind: 'timeout' };
      }
      log.debug({ sessionId: input.sessionId, turnId: input.turnId }, 'Activity summary generation aborted by caller signal');
      return { kind: 'aborted' };
    }
    log.warn(
      { err: error instanceof Error ? error.message : String(error), sessionId: input.sessionId, turnId: input.turnId },
      'Activity summary generation failed',
    );
    return { kind: 'failed' };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Conditionally generate + persist a one-sentence activity summary for a turn.
 *
 * Fire-and-forget from the agent-event dispatcher's `result` handler. Never
 * throws and never blocks the turn result. Returns the persisted sentence, or
 * `null` when generation was gated out, skipped (idempotency), or failed.
 *
 * Idempotency (F1): in-flight Set + persisted preflight BEFORE the LLM call +
 * apply-time recheck (the latter inside `deps.persistSummary`'s mutator).
 */
export async function maybeGenerateActivitySummaryForTurn(
  input: ActivitySummaryInput,
  deps: ActivitySummaryDeps,
): Promise<string | null> {
  const { sessionId, turnId } = input;
  const key = inFlightKey(sessionId, turnId);

  // Guard 1: in-flight Set — collapse concurrent invocations within the process.
  if (inFlight.has(key)) {
    log.debug({ sessionId, turnId }, 'Activity summary skipped: generation already in flight for this turn');
    return null;
  }

  // Gate on real work BEFORE acquiring the in-flight slot or hitting the model.
  if (!shouldGenerateActivitySummary(input)) {
    log.debug(
      {
        sessionId,
        turnId,
        totalToolCalls: input.toolMetrics?.totalToolCalls ?? 0,
        durationMs: input.durationMs ?? 0,
      },
      'Activity summary skipped: turn did not do enough work to summarise',
    );
    return null;
  }

  inFlight.add(key);
  try {
    // Guard 2: persisted preflight — skip the LLM call entirely if a summary
    // already exists (e.g. a prior invocation on the shared dispatcher path).
    let alreadyPersisted: string | null;
    try {
      alreadyPersisted = await deps.getPersistedSummary(sessionId, turnId);
    } catch (err) {
      // Best-effort: a failed preflight read means we cannot rule out a prior
      // summary, so we skip rather than risk a duplicate write. Observable.
      log.warn(
        { err: err instanceof Error ? err.message : String(err), sessionId, turnId },
        'Activity summary preflight read failed — skipping to avoid a possible duplicate write',
      );
      ignoreBestEffortCleanup(err, {
        operation: 'activitySummary.preflightRead',
        reason: 'session read failed; skip generation to avoid a possible duplicate write',
      });
      return null;
    }
    if (alreadyPersisted) {
      log.debug({ sessionId, turnId }, 'Activity summary skipped: already persisted for this turn');
      return null;
    }

    const settings = deps.getSettings();
    if (!hasValidAuth(settings)) {
      log.debug({ sessionId, turnId }, 'Activity summary skipped: no valid auth available');
      return null;
    }

    const outcome = await generateActivitySummaryOnce(settings, input);
    if (outcome.kind !== 'success') {
      // timeout / failed / aborted all fall back to the deterministic count-line.
      return null;
    }

    // Guard 3: apply-time recheck lives inside persistSummary's mutator.
    const persisted = await deps.persistSummary(sessionId, turnId, outcome.sentence);
    if (!persisted) {
      log.debug({ sessionId, turnId }, 'Activity summary not persisted (apply-time guard or write declined)');
      return null;
    }

    log.debug({ sessionId, turnId }, 'Activity summary generated and persisted');
    return outcome.sentence;
  } finally {
    inFlight.delete(key);
  }
}
