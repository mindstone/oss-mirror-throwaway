/**
 * WebSearch — built-in tool for web search via DuckDuckGo HTML scraping.
 *
 * Provides zero-config web search as a fallback when no MCP search provider
 * (Perplexity, Tavily, Brave) is configured. Includes rate limiting,
 * CAPTCHA detection, and parser drift detection.
 *
 * @see docs/plans/260411_restore_web_and_search_builtin_tools.md
 */

import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { scrapeDdgResults } from './webSearchScraper';
import type { BuiltinToolContext, ToolExecutionResult } from '../types';
import type { ToolDefinition } from '../modelTypes';

const log = createScopedLogger({ service: 'webSearchTool' });

/**
 * Failure-mode tag values reported to Sentry so we can aggregate how often
 * each mode is hit in the wild. Previously these returned `isError: true`
 * as soft tool errors and were therefore invisible to centralised telemetry —
 * pino logs become Sentry breadcrumbs only, which never persist unless an
 * unrelated exception is captured in the same scope.
 *
 * Sentry-searchable: these tag values are load-bearing for dashboards/alerts,
 * do not rename without updating any saved Sentry queries.
 */
type WebSearchFailureMode =
  | 'captcha'
  | 'parserDrift'
  | 'rateLimit'
  | 'timeout'
  | 'networkError'
  | 'httpError';

/**
 * Per-task dedupe state. Keyed weakly on the task's rateLimitState Map so that
 * when the task ends and that Map is discarded, the Set is GC'd too. This
 * guarantees each (task, failureMode) pair emits at most one Sentry event,
 * which prevents retry-loop amplification (e.g. an agent that keeps retrying
 * after a rateLimit response would otherwise emit one event per retry).
 */
const reportedPerTask = new WeakMap<Map<string, number>, Set<WebSearchFailureMode>>();

/**
 * Report a WebSearch failure as a Sentry warning so the rate of each failure
 * mode is observable. Query text is NEVER included — we send query length
 * only, matching the existing privacy convention in this file.
 *
 * Dedupes per task when `rateLimitState` is provided: the same failureMode
 * will only fire once per task.
 */
function reportFailure(
  failureMode: WebSearchFailureMode,
  summary: string,
  extra: Record<string, unknown>,
  rateLimitState: Map<string, number> | undefined,
): void {
  if (rateLimitState) {
    let reported = reportedPerTask.get(rateLimitState);
    if (!reported) {
      reported = new Set();
      reportedPerTask.set(rateLimitState, reported);
    }
    if (reported.has(failureMode)) {
      return;
    }
    reported.add(failureMode);
  }

  try {
    getErrorReporter().captureMessage('WebSearch failure', {
      level: 'warning',
      tags: { area: 'tool', tool: 'WebSearch', failureMode, condition: 'web_search_failure' },
      fingerprint: ['web-search-failure', failureMode],
      extra: { summary, ...extra },
    });
  } catch {
    // Silent: telemetry failure must never affect tool behaviour.
  }
}

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS_CAP = 20;
const MAX_RATE_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';

/**
 * How long to short-circuit WebSearch after observing a CAPTCHA from DDG.
 *
 * DuckDuckGo's anti-bot blocks are IP-sticky ~30 min (empirically observed
 * in prior postmortems). Retrying from the same IP during that window is
 * guaranteed to fail — each failed attempt costs ~1.3s of wall time and
 * emits a fresh Sentry event (the existing WeakMap dedupe is per-turn, so
 * it does not cover task-N+1). We pick a conservative 10 min: if the block
 * clears early we miss one retry; if it stays longer the next observed
 * CAPTCHA re-arms the cooldown.
 *
 * The cooldown is **process-wide** (not per-task, per-session, or
 * per-renderer-window) because DDG's block is keyed on the app's outbound
 * IP, which is shared across every turn and sub-agent in the process.
 *
 * Origin: Sentry issue REBEL-1GG (9 users / 23 "CAPTCHA detected" events
 * in 8h on 0.4.32). See docs-private/investigations/260422_websearch_captcha_sentry_noise.md.
 */
const CAPTCHA_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Timestamp (ms epoch) until which WebSearch should short-circuit with the
 * CAPTCHA message without touching DDG. `null` means "not in cooldown".
 *
 * Module-level on purpose: the whole point is to share this across turns,
 * tasks, sessions, sub-agents, and renderer windows in one process.
 */
let captchaCooldownUntilMs: number | null = null;

/**
 * Clock indirection so tests can drive the cooldown deterministically
 * without waiting 10 real minutes or fighting fake timers (which also
 * freeze `fetch`). Defaults to `Date.now` in production.
 */
let nowMs: () => number = () => Date.now();

/**
 * Test-only: reset the cooldown state between tests. The `__` prefix is a
 * load-bearing convention signalling "test-only escape hatch" — production
 * callers should not reach for this.
 */
export function __resetWebSearchCaptchaCooldownForTests(): void {
  captchaCooldownUntilMs = null;
}

/** Test-only: override the clock. Pass `null` to restore `Date.now`. */
export function __setWebSearchClockForTests(clock: (() => number) | null): void {
  nowMs = clock ?? (() => Date.now());
}

/**
 * Maximum number of WebSearch requests that may be in-flight against
 * DuckDuckGo at once, process-wide. Empirically, bursts of 6+ concurrent
 * requests from a single IP reliably trip DDG's anomaly classifier (see
 * session `a49f7390-f831` where 10 parallel searches dropped ~4 at the
 * tripwire). Serialising to 3 concurrent lets larger batches complete
 * sequentially under DDG's tolerance. The cap is process-wide (not
 * per-task) because DDG's rate limit is keyed on the app's IP, which is
 * shared across all turns.
 */
const MAX_CONCURRENT_SEARCHES = 3;

/**
 * Minimal FIFO semaphore: acquire() resolves immediately if a slot is free,
 * otherwise queues the caller; release() frees one slot and wakes the
 * longest-waiting caller. Every acquire() MUST be paired with a release()
 * in a `finally` block; otherwise slots leak and subsequent searches hang.
 *
 * The semaphore is process-wide because the constraint it enforces (DDG's
 * IP-based anti-bot limit) is also process-wide. Sub-agents, parallel
 * turns, and concurrent renderer sessions all share the same instance.
 */
class WebSearchSemaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = capacity;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.available -= 1;
        resolve();
      });
    });
  }

  release(): void {
    this.available += 1;
    const next = this.waiters.shift();
    if (next) {
      // Note: `next()` decrements `available` synchronously inside the
      // arrow we pushed in acquire(), so capacity stays balanced across
      // wakeups without racing the microtask queue.
      next();
    }
  }
}

const webSearchSemaphore = new WebSearchSemaphore(MAX_CONCURRENT_SEARCHES);

// Request-shape note: we send an honest, identifiable `Rebel/1.0` UA with a
// minimal header set. An earlier investigation tested expanding to a full
// browser-navigation fingerprint (Chrome UA + Accept + Referer + Origin +
// Sec-Fetch-*); it was empirically COUNTERPRODUCTIVE in Node's undici runtime
// (3/3 requests blocked vs 2/3 on minimal), because undici cannot coherently
// emit `Sec-Fetch-Mode: navigate` — the resulting fingerprint is visibly
// inconsistent to DDG's anomaly classifier. DDG's block is behavioural/IP-
// based at the session level, not header-based; no fetch-side header change
// reliably defeats it. See docs-private/postmortems/260421_websearch_ddg_captcha_postmortem.md
// before re-attempting header-spoofing.
const USER_AGENT = 'Rebel/1.0 (https://mindstone.com)';

// Copy notes: these messages are consumed by the agent (an LLM) as tool output,
// so they must be both honest AND action-guiding on two dimensions:
//
// 1. Don't read as transient → agent retries.
//    "Temporarily unavailable due to high usage" caused the retry loop fixed in
//    commit a8dc33720. Wording now tells the agent explicitly not to retry.
//
// 2. Don't leave the failure mode ambiguous → agent invents a plausible-but-
//    wrong user story.
//    Session `d434dc09-...` showed the agent paraphrasing the prior
//    "session-sticky block" copy into the false claim "Rebel caps at 5 queries
//    per session" (no such cap existed). The agent collapsed the upstream
//    DuckDuckGo IP-level anti-bot limit into a fake Rebel product quota.
//    Both messages below therefore name the responsible party explicitly —
//    CAPTCHA_MESSAGE attributes the block to DuckDuckGo; RATE_LIMIT_MESSAGE
//    attributes the 5-per-task cap to Rebel — so the agent has no slack to
//    invent a different story when it re-narrates to the user.
//
// See docs-private/postmortems/260421_websearch_ddg_captcha_postmortem.md.

const RATE_LIMIT_MESSAGE =
  "I've reached my built-in search limit for this task: Rebel caps built-in WebSearch " +
  "at 5 searches per task as a self-imposed safeguard against triggering DuckDuckGo's " +
  'IP-level anti-bot rate limiter. This is a Rebel-side cap, not an external quota. ' +
  'Do not retry WebSearch — instead, tell the user that for unlimited, faster, more ' +
  'reliable search they can enable Brave Search in Settings → Connectors.';

const CAPTCHA_MESSAGE =
  'The built-in web search is currently blocked by the upstream search provider: ' +
  "DuckDuckGo has returned an anti-bot challenge because this app's IP has tripped " +
  "DuckDuckGo's rate limiter. This is an upstream limit enforced by DuckDuckGo at the " +
  'IP level — NOT a Rebel-imposed quota, session cap, or per-task limit. Further ' +
  'WebSearch calls from this app will fail for the same reason until the upstream ' +
  'limit clears (typically within a few minutes). Do not retry WebSearch. Tell the user ' +
  'that for reliable, unlimited search, they can enable Brave Search in ' +
  'Settings → Connectors.';

const PARSER_DRIFT_MESSAGE =
  'Search results could not be parsed — the upstream search provider may have ' +
  'changed its response format. Do not retry WebSearch for this turn. ' +
  'For reliable search, tell the user they can enable Brave Search ' +
  'in Settings → Connectors.';

// ── Tool Definition ────────────────────────────────────────────────────

export const WEB_SEARCH_TOOL_DEFINITION: ToolDefinition = {
  name: 'WebSearch',
  description:
    'Search the web using a text query. Returns a list of results with titles, URLs, and snippets. ' +
    'Use this when you need to find information online.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query.',
      },
      maxResults: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_RESULTS_CAP,
        description: `Maximum number of results to return (default ${DEFAULT_MAX_RESULTS}, max ${MAX_RESULTS_CAP}).`,
      },
    },
    required: ['query'],
  },
};

// ── Helpers ────────────────────────────────────────────────────────────

/** Format search results as a numbered markdown list. */
function formatResults(results: Array<{ title: string; url: string; snippet: string }>): string {
  const header = `Found ${results.length} result${results.length === 1 ? '' : 's'}:\n`;
  const items = results.map(
    (r, i) => `${i + 1}. **${r.title}** — ${r.url}\n   ${r.snippet}`,
  );
  return header + '\n' + items.join('\n\n');
}

// ── Executor ───────────────────────────────────────────────────────────

export async function executeWebSearch(
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { output: 'WebSearch requires a valid input object.', isError: true };
  }
  const params = input as Record<string, unknown>;
  const startTime = Date.now();

  // ── Validate input ─────────────────────────────────────────────────
  const query = params.query;
  if (typeof query !== 'string' || query.trim().length === 0) {
    return { output: 'WebSearch requires a non-empty search query.', isError: true };
  }

  const rawMaxResults = typeof params.maxResults === 'number' && Number.isFinite(params.maxResults)
    ? Math.min(Math.max(1, Math.round(params.maxResults)), MAX_RESULTS_CAP)
    : DEFAULT_MAX_RESULTS;

  // ── Process-wide CAPTCHA cooldown short-circuit ────────────────────
  // If any prior turn observed a CAPTCHA within the last CAPTCHA_COOLDOWN_MS,
  // skip the fetch entirely: DDG's block is IP-sticky and will keep failing,
  // so re-fetching only costs wall time, burns a concurrency slot, and emits
  // a fresh Sentry event for telemetry we already have.
  //
  // Deliberately runs BEFORE the semaphore acquire and BEFORE the per-task
  // rate-limit reservation — a short-circuited call should neither consume
  // a concurrency slot nor count against the 5/task budget (failed searches
  // have never counted against that budget).
  //
  // Sentry: we do NOT emit a new warning here. The first CAPTCHA that armed
  // the cooldown was already reported; additional events during the cooldown
  // are not new information. Collapsing them is the whole point — see
  // Sentry issue REBEL-1GG and the investigation doc referenced above.
  if (captchaCooldownUntilMs !== null) {
    if (nowMs() < captchaCooldownUntilMs) {
      return { output: CAPTCHA_MESSAGE, isError: true };
    }
    // Cooldown has elapsed — clear the marker so the next CAPTCHA can
    // re-arm it with a fresh window.
    captchaCooldownUntilMs = null;
  }

  // ── Concurrency gate ───────────────────────────────────────────────
  // Serialise to MAX_CONCURRENT_SEARCHES against DDG's anomaly classifier.
  // Acquired BEFORE the rate-limit check + fetch and released in the outer
  // `finally` below so every path (early return, success, exception) frees
  // the slot exactly once. Input validation above does NOT consume a slot.
  await webSearchSemaphore.acquire();

  // ── Rate-limit reservation tracking ────────────────────────────────
  // We use a reservation pattern (reserve-before-fetch, un-reserve on
  // failure) instead of increment-on-success so that the 5/task cap is a
  // HARD cap even under concurrency. Without reservation, 3 concurrent
  // callers in the critical section could each observe counter=4 (pre-
  // increment), all pass the check, all fetch successfully, and overshoot
  // to counter=7. Reservation closes this TOCTOU window because the
  // check-and-reserve block between acquire() and the next await is
  // synchronous and therefore atomic on JS's single-threaded event loop.
  //
  // `reservedPreviousValue` is captured so un-reservation can EXACTLY
  // restore the prior state, including the "no key set" case (which the
  // existing "does not increment on CAPTCHA" test relies on).
  let reserved = false;
  let reservedPreviousValue: number | undefined;
  let reservedPreviousKeyExisted = false;
  let searchSucceeded = false;

  try {
    // ── Rate limit check + reserve ─────────────────────────────────
    // The get-check-set sequence below has no `await` between its
    // statements, so it is atomic relative to other calls in the same
    // critical section. This is the load-bearing property that makes the
    // cap hard, not advisory.
    if (context.rateLimitState) {
      const current = context.rateLimitState.get('WebSearch') ?? 0;
      if (current >= MAX_RATE_LIMIT) {
        reportFailure(
          'rateLimit',
          'per-task rate limit exceeded',
          { queryLength: query.length, limit: MAX_RATE_LIMIT },
          context.rateLimitState,
        );
        return { output: RATE_LIMIT_MESSAGE, isError: true };
      }
      reservedPreviousKeyExisted = context.rateLimitState.has('WebSearch');
      reservedPreviousValue = current;
      context.rateLimitState.set('WebSearch', current + 1);
      reserved = true;
    }

    // ── Fetch from DDG ─────────────────────────────────────────────
    // Keep the existing try/catch for fetch-level errors; its returns are
    // also wrapped by the outer finally so the semaphore always releases.
    try {
      const response = await fetch(DDG_ENDPOINT, {
        method: 'POST',
        body: new URLSearchParams({ q: query.trim(), kl: '' }),
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'follow',
      });

      // ── Handle non-2xx HTTP responses ───────────────────────────
      // Without this check, DDG 5xx/4xx pages flow into scrapeDdgResults.
      // Small error bodies get parsed as "zero results" (silent success),
      // large ones look like parser drift. Principle #6 of the originating
      // plan doc: a failed web request must return a clear error, never
      // silently succeed with empty results.
      if (!response.ok) {
        reportFailure(
          'httpError',
          `HTTP ${response.status}`,
          {
            queryLength: query.length,
            durationMs: Date.now() - startTime,
            httpStatus: response.status,
          },
          context.rateLimitState,
        );
        return {
          output: `Search is temporarily unavailable (HTTP ${response.status}). The search service may be rate-limiting or unreachable.`,
          isError: true,
        };
      }

      const html = await response.text();

      // ── Parse results ────────────────────────────────────────────
      const scrapeResult = scrapeDdgResults(html);

      // Log query length (NEVER log query text — privacy)
      log.info(
        {
          queryLength: query.length,
          resultCount: scrapeResult.results.length,
          captchaDetected: scrapeResult.captchaDetected,
          parserDrift: scrapeResult.parserDrift,
          ...(scrapeResult.driftSnippet != null && { driftSnippet: scrapeResult.driftSnippet }),
          durationMs: Date.now() - startTime,
        },
        'WebSearch: search completed',
      );

      // ── Handle CAPTCHA ───────────────────────────────────────────
      if (scrapeResult.captchaDetected) {
        // Arm the process-wide cooldown so subsequent turns short-circuit
        // without re-fetching DDG (see `CAPTCHA_COOLDOWN_MS` above).
        captchaCooldownUntilMs = nowMs() + CAPTCHA_COOLDOWN_MS;
        reportFailure(
          'captcha',
          'CAPTCHA detected',
          {
            queryLength: query.length,
            durationMs: Date.now() - startTime,
            httpStatus: response.status,
          },
          context.rateLimitState,
        );
        return { output: CAPTCHA_MESSAGE, isError: true };
      }

      // ── Handle parser drift ──────────────────────────────────────
      if (scrapeResult.parserDrift) {
        reportFailure(
          'parserDrift',
          'parser drift detected',
          {
            queryLength: query.length,
            durationMs: Date.now() - startTime,
            httpStatus: response.status,
            ...(scrapeResult.driftSnippet != null && { driftSnippet: scrapeResult.driftSnippet }),
          },
          context.rateLimitState,
        );
        return { output: PARSER_DRIFT_MESSAGE, isError: true };
      }

      // ── Handle empty results ─────────────────────────────────────
      if (scrapeResult.results.length === 0) {
        return { output: `No results found for: ${query.trim()}`, isError: false };
      }

      // ── Format and return results ────────────────────────────────
      // Rate-limit counter was already incremented at reservation above;
      // `reserved` stays true (and `searchSucceeded` becomes true) so the
      // outer finally keeps the reservation in place.
      const truncated = scrapeResult.results.slice(0, rawMaxResults);
      searchSucceeded = true;
      return { output: formatResults(truncated), isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startTime;

      log.warn(
        { queryLength: query.length, durationMs, error: message },
        'WebSearch: request failed',
      );

      // ── User-friendly error messages ───────────────────────────
      const isTimeout =
        message.includes('aborted') ||
        message.includes('abort') ||
        message.includes('timeout') ||
        message.includes('timed out');

      reportFailure(
        isTimeout ? 'timeout' : 'networkError',
        isTimeout ? 'request timed out' : 'request failed',
        {
          queryLength: query.length,
          durationMs,
          errorMessage: message,
        },
        context.rateLimitState,
      );

      if (isTimeout) {
        return {
          output: 'The search request timed out. The search service may be temporarily unavailable.',
          isError: true,
        };
      }

      return {
        output: `Search failed: ${message}`,
        isError: true,
      };
    }
  } finally {
    // Un-reserve the rate-limit slot if the search did not actually
    // succeed (CAPTCHA, parser drift, empty results, HTTP error, timeout,
    // network error, or an unexpected throw). Reservation is restored to
    // its EXACT prior state — including the "key never set" case — so
    // existing tests asserting `get('WebSearch') === undefined` after
    // failure continue to hold.
    if (reserved && !searchSucceeded && context.rateLimitState) {
      if (reservedPreviousKeyExisted) {
        context.rateLimitState.set('WebSearch', reservedPreviousValue ?? 0);
      } else {
        context.rateLimitState.delete('WebSearch');
      }
    }
    // Release on EVERY exit path: successful return, rate-limit early-return
    // (before reservation), fetch error caught and converted to user-facing
    // error, or an unexpected exception propagating out. Input-validation
    // returns above this point never acquired the slot, so they do not
    // reach this finally.
    webSearchSemaphore.release();
  }
}
