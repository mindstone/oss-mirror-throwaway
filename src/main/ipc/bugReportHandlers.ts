import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as SentryMain from '@sentry/electron/main';
import { app } from 'electron';
import { bugReportChannels } from '@shared/ipc/channels/bugReport';
import type { DiagnosticSections } from '@shared/diagnostics/diagnosticBundleSections';
import { formatNavigationUrl } from '@shared/navigation/urlParser';
import { safeJsonParseFromModelText } from '@shared/utils/safeJsonParse';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { createScopedLogger } from '@core/logger';
import { parseUseToolEnvelopeJson } from '@core/rebelCore/superMcpEnvelope';
import { getSettings } from '@core/services/settingsStore';
import { superMcpHttpManager } from '../services/superMcpHttpManager';
import {
  attachUpdateForensicsToScope,
  gatherDeterministicDiagnostics,
  gatherUpdateForensics,
  type SentryScopeForAttachment,
} from '../services/bugReportDiagnosticService';
import {
  analyzeBugReport,
  buildFallbackDiagnosticSummary,
} from '../services/bugReportAnalysisService';
import { getMcpRegistrationStatus } from '../services/coreStartup';
import { sanitizeLogMessage } from '@core/utils/logFieldFilter';
import { getTracker } from '@core/tracking';
import { truncateWellFormed } from '@shared/utils/wellFormedUnicode';
import { exportRecentLogs } from '../services/logExportService';
import { isShuttingDown } from '../services/shutdownState';
import { broadcastToAllWindows } from '../utils/broadcastHelpers';
import { getBuildChannel } from '../utils/buildChannel';
import { getAppVersion } from '../utils/dataPaths';
import { getMainSentryDisabledReason, getSendOutcome, isMainSentryEnabled } from '../sentry';
import {
  BugReportOutbox,
  type BugReportRecord,
  type BugReportSubmitOutcome,
} from '../services/bugReportOutbox';
import { registerHandler } from './utils/registerHandler';

const log = createScopedLogger({ ipc: 'bugReport' });

/**
 * Payload for the `bug-report:status` broadcast. Local type (the channel is
 * NOT in the typed broadcast registry — see src/shared/ipc/broadcasts.ts);
 * keep in sync with the preload listener (src/preload/index.ts
 * onBugReportStatus), the renderer toast branching (src/renderer/App.tsx), and
 * the pure copy module (src/renderer/src/bugReportToastCopy.ts).
 *
 * Honest delivery-status vocabulary (Stage 5):
 * - 'queued'               → durably saved to the outbox (fires ONE positive
 *                            toast on submit). Broadcast by the handler after the
 *                            atomic+fsync write confirms.
 * - 'delivered'            → confirmed 2xx after flush. A SILENT upgrade (the
 *                            copy module returns null) — no second toast.
 * - 'delivery-unavailable' → Sentry off / no-DSN, OR dead-letter after retries
 *                            exhausted. Carries `reportText` so the renderer can
 *                            offer an environment-independent "Copy report"
 *                            action.
 * - 'failed'               → even the durable save failed (disk full). Error toast.
 */
interface BugReportStatusPayload {
  status: 'queued' | 'delivered' | 'delivery-unavailable' | 'failed';
  /** Present only for status 'delivery-unavailable': why the team is unreachable. */
  reason?: 'no-dsn' | 'env-disabled' | 'dead-letter';
  /**
   * The raw report text, forwarded ONLY for 'delivery-unavailable' so the
   * renderer can wire a "Copy report" toast action (the dialog has already
   * reset by toast time). Transient — not persisted anywhere beyond the outbox
   * record it is read from; carried in-memory through this one broadcast.
   */
  reportText?: string;
}

const broadcastBugReportStatus = (payload: BugReportStatusPayload): void => {
  broadcastToAllWindows('bug-report:status', payload);
};

// Self-heal budget for the in-flight guard: even if the background promise
// never settles (hung await with no timeout we anticipated), clear the flag so
// a single hung submit can't brick the feature for the rest of the session.
const BUG_REPORT_IN_FLIGHT_MAX_MS = 90_000;

/**
 * Guard against concurrent bug report submissions. Self-healing: a watchdog
 * timer clears the guard after a hard wall-clock budget so a single hung submit
 * (an enrichment await with no timeout we anticipated, a wedged transport)
 * cannot brick the feature for the rest of the session. The background task's
 * own `finally` also clears it on the happy path; both go through
 * `releaseBugReportInFlight`, which is idempotent and cancels the watchdog.
 */
let bugReportInFlight = false;
let bugReportInFlightWatchdog: ReturnType<typeof setTimeout> | null = null;
// Generation token so a watchdog-evicted task's late `.finally()` release can't
// clear a NEWER task's guard. Each acquire mints a fresh token; both the
// watchdog and `release` only clear state if the token they captured is still
// the current one. Without this, the sequence "A acquires → watchdog evicts A
// → B acquires → A finally settles" would release B's guard and let a third
// submit run concurrently with B.
let bugReportInFlightToken = 0;

/**
 * Acquire the in-flight guard, returning the generation token for this
 * acquisition. The caller must pass it back to `releaseBugReportInFlight` so a
 * stale (watchdog-evicted) task cannot release a newer task's guard.
 */
const acquireBugReportInFlight = (): number => {
  const token = ++bugReportInFlightToken;
  bugReportInFlight = true;
  if (bugReportInFlightWatchdog) {
    clearTimeout(bugReportInFlightWatchdog);
  }
  bugReportInFlightWatchdog = setTimeout(() => {
    // Only self-heal if THIS acquisition still owns the guard. A newer acquire
    // would have minted a higher token and armed its own watchdog.
    if (token !== bugReportInFlightToken) return;
    if (bugReportInFlight) {
      log.warn(
        { maxMs: BUG_REPORT_IN_FLIGHT_MAX_MS },
        'Bug report in-flight guard hit its hard deadline — self-healing so future submits are not blocked',
      );
    }
    bugReportInFlight = false;
    bugReportInFlightWatchdog = null;
  }, BUG_REPORT_IN_FLIGHT_MAX_MS);
  // Don't keep the event loop (or the process) alive just for the watchdog.
  bugReportInFlightWatchdog.unref?.();
  return token;
};

const releaseBugReportInFlight = (token: number): void => {
  // A stale task (already evicted by its watchdog, with a newer task now
  // holding the guard) must NOT release the current holder. Only the owner of
  // the current generation may clear the guard and cancel its watchdog.
  if (token !== bugReportInFlightToken) return;
  bugReportInFlight = false;
  if (bugReportInFlightWatchdog) {
    clearTimeout(bugReportInFlightWatchdog);
    bugReportInFlightWatchdog = null;
  }
};

const FEEDBACK_CATEGORY_ID = 7;
const MCP_TOOL_TIMEOUT_MS = 30_000;
const BUG_REPORT_SENTRY_FLUSH_TIMEOUT_MS = 5_000;
const BUG_REPORT_SENTRY_SHUTDOWN_FLUSH_TIMEOUT_MS = 1_500;

// Hard wall-clock budgets so the raw report is ALWAYS captured, regardless of
// what any best-effort enrichment step does. Each enrichment await is a
// best-effort embellishment; none of them may gate or indefinitely delay the
// one artifact we must never lose (the user's report).
//
// The LLM analysis budget is a TOTAL deadline around `analyzeBugReport`: the
// BTS client's internal per-fetch 60s timeout is NOT a global cap (retries +
// operational-fallback re-dispatch can stack), so we bound the whole call here.
const BUG_REPORT_DIAGNOSTICS_TIMEOUT_MS = 5_000;
const BUG_REPORT_RAW_LOG_TIMEOUT_MS = 5_000;
const BUG_REPORT_FORENSICS_TIMEOUT_MS = 5_000;
const BUG_REPORT_LLM_ANALYSIS_TIMEOUT_MS = 20_000;
// (BUG_REPORT_IN_FLIGHT_MAX_MS is declared above, next to the in-flight guard.)

/**
 * Race a promise against a wall-clock timeout, resolving to `fallback` if the
 * deadline wins. The timer always loses to a settled promise (cleared on
 * settle), so a fast enrichment step incurs no extra latency.
 *
 * If the timeout wins and the underlying `promise` later REJECTS, that late
 * rejection is swallowed to `fallback` (`.catch(() => fallback)`) rather than
 * surfacing as an unhandledRejection. This matters precisely in the
 * broken-environment scenario this stage targets: an enrichment step that hits
 * its own internal timeout/retry boundary and rejects AFTER our deadline has
 * already won would otherwise produce process-level telemetry noise with no
 * handler. The raced value is unaffected — the race already resolved to
 * `fallback` on the deadline. If `promise` rejects BEFORE the deadline, that
 * rejection still propagates to the caller (callers wrap enrichment in
 * try/catch); only a post-deadline rejection is absorbed.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(fallback);
    }, ms);
  });
  return Promise.race([
    promise
      .finally(() => {
        if (timer) clearTimeout(timer);
      })
      // Absorb a LATE rejection (one that lands after the timeout already won
      // the race) so it can't become an unhandledRejection — precisely the
      // broken-environment case this stage targets. A rejection that lands
      // BEFORE the deadline still rejects the race and propagates to the
      // caller (which wraps enrichment in try/catch).
      .catch((err) => {
        if (timedOut) return fallback;
        throw err;
      }),
    timeout,
  ]);
}
const MCP_CLIENT_INFO = {
  name: 'mindstone-rebel',
  version: process.env['npm_package_version'] ?? '0.0.0-dev',
};

const REBELS_COMMUNITY_WRITE_PACKAGE_ID = 'RebelsCommunityWrite';
const DISCOURSE_CREATE_TOPIC_TOOL_ID = 'RebelsCommunityWrite__discourse_create_topic';
const URL_PATTERN = /https?:\/\/[^\s"'<>`]+/i;

const getSuperMcpHttpState = () => superMcpHttpManager.getState();

const getSafeAppVersion = (): string => {
  try {
    return getAppVersion();
  } catch {
    return 'unknown';
  }
};

/**
 * Resolve the macOS bundle identifier with a defensive fallback.
 *
 * `app.getBundleId()` is the canonical Electron API for the macOS bundle ID
 * (the method is macOS-only, so it isn't on `Electron.App`'s type — we cast).
 * We keep the dynamic-call shape (`?.()`) so this code stays loadable in unit
 * tests where `app` is mocked. The fallback string `com.mindstone.rebel`
 * matches `package.json`'s `build.appId` for stable builds — beta builds will
 * have `app.getBundleId()` return `com.mindstone.rebel.beta` correctly, so the
 * fallback is only ever exercised on non-darwin or test environments where
 * the path lookup is moot anyway (no ShipIt cache to read).
 */
const resolveBundleId = (): string => {
  try {
    const getBundleId = (app as unknown as { getBundleId?: () => string }).getBundleId;
    const bundleId = typeof getBundleId === 'function' ? getBundleId.call(app) : undefined;
    if (typeof bundleId === 'string' && bundleId.length > 0) return bundleId;
  } catch {
    // Fall through to the static fallback.
  }
  return 'com.mindstone.rebel';
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }
  }
  return 'Unknown error';
};

const isMcpUnavailableError = (error: unknown): boolean => {
  const message = toErrorMessage(error);
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';

  if (code === '-33004' || code === '-32004') {
    return true;
  }

  return /super-mcp is not running|-3[23]004|package.*(not found|unavailable)|server.*not found/i.test(
    message
  );
};

const buildFeedbackFallbackUrl = (title: string): string =>
  `https://rebels.mindstone.com/new-topic?title=${encodeURIComponent(title)}&category_id=${FEEDBACK_CATEGORY_ID}`;

const extractMimeExtension = (mimeType?: string): string => {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case undefined:
    default:
      return 'png';
  }
};

const decodeBase64 = (value: string): Uint8Array => {
  const raw = value.includes(',') ? value.split(',').pop() ?? '' : value;
  return Uint8Array.from(Buffer.from(raw, 'base64'));
};

type SentryAttachment = Parameters<SentryScopeForAttachment['addAttachment']>[0];

const addAttachmentAndCountBytes = (
  scope: SentryScopeForAttachment,
  attachment: SentryAttachment
): number => {
  scope.addAttachment(attachment);
  return attachment.data.length;
};

const buildConversationLink = (conversationId?: string): string | null => {
  const trimmed = conversationId?.trim();
  return trimmed ? formatNavigationUrl({ type: 'sessions', sessionId: trimmed }) : null;
};

const MAX_TITLE_LENGTH = 120;

const buildBugReportTitle = (description: string): string => {
  const firstLine = description.trim().split('\n')[0].trim();
  if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine;
  return truncateWellFormed(firstLine, MAX_TITLE_LENGTH - 1) + '\u2026';
};

const buildBugReportBody = (request: {
  description: string;
  stepsToReproduce?: string;
  expectedBehavior?: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  conversationId?: string;
}): string => {
  const sections: string[] = [
    `**Urgency:** ${request.urgency}`,
    '',
    '### Description',
    request.description.trim(),
  ];

  const steps = request.stepsToReproduce?.trim();
  if (steps) {
    sections.push('', '### Steps to Reproduce', steps);
  }

  const expectedBehavior = request.expectedBehavior?.trim();
  if (expectedBehavior) {
    sections.push('', '### Expected Behavior', expectedBehavior);
  }

  const conversationLink = buildConversationLink(request.conversationId ?? undefined);
  if (conversationLink) {
    sections.push('', '### Conversation', conversationLink);
  }

  return sections.join('\n');
};

const unwrapUseToolEnvelope = (text: string): string => {
  // Super-MCP may append "\n\n[...]" suffixes after the JSON envelope.
  // parseUseToolEnvelopeJson strips these before parsing.
  const parsed = parseUseToolEnvelopeJson<{
    package_id?: string;
    tool_id?: string;
    result?: {
      content?: Array<{ type?: string; text?: string }>;
    };
  }>(text);

  if (parsed?.package_id && parsed.tool_id && Array.isArray(parsed.result?.content)) {
    const innerText = parsed.result.content.find(
      (entry) => entry?.type === 'text' && typeof entry.text === 'string'
    );
    if (innerText?.text) {
      return innerText.text;
    }
  }

  return text;
};

const findUrlInValue = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const match = value.match(URL_PATTERN);
    return match?.[0] ?? null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const url = findUrlInValue(item);
      if (url) {
        return url;
      }
    }
    return null;
  }

  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      const url = findUrlInValue(nested);
      if (url) {
        return url;
      }
    }
  }

  return null;
};

const DISCOURSE_BASE_URL = 'https://rebels.mindstone.com';

const extractDiscourseTopicUrl = (toolText: string): string | null => {
  const parsed = safeJsonParseFromModelText<unknown>(toolText, 'bugReportHandlers', log);

  // Discourse create_topic returns {id, topic_slug, ...} — construct URL from those
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const topicId = obj.id ?? obj.topic_id;
    const slug = obj.topic_slug ?? obj.slug;
    if (typeof topicId === 'number' && typeof slug === 'string') {
      return `${DISCOURSE_BASE_URL}/t/${slug}/${topicId}`;
    }
    if (typeof topicId === 'number') {
      return `${DISCOURSE_BASE_URL}/t/${topicId}`;
    }
  }

  // Fallback: find any URL in the parsed object or raw text
  const parsedUrl = parsed ? findUrlInValue(parsed) : null;
  if (parsedUrl) {
    return parsedUrl;
  }

  const textUrl = toolText.match(URL_PATTERN);
  return textUrl?.[0] ?? null;
};

async function callMcpTool(params: {
  packageId: string;
  toolId: string;
  args: Record<string, unknown>;
}): Promise<string> {
  const state = getSuperMcpHttpState();
  if (!state.isRunning || !state.url) {
    throw new Error('Super-MCP is not running');
  }

  const client = new Client(MCP_CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(state.url));
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), MCP_TOOL_TIMEOUT_MS);

  try {
    await client.connect(transport);

    const toolCallPromise = client.callTool({
      name: 'use_tool',
      arguments: {
        package_id: params.packageId,
        tool_id: params.toolId,
        args: params.args,
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutController.signal.addEventListener(
        'abort',
        () => reject(new Error(`MCP tool call timed out after ${MCP_TOOL_TIMEOUT_MS / 1000} seconds`)),
        { once: true }
      );
    });

    const result = (await Promise.race([toolCallPromise, timeoutPromise])) as Awaited<
      typeof toolCallPromise
    >;

    const textEntry = (result.content as Array<Record<string, unknown>> | undefined)?.find(
      (entry: Record<string, unknown>): entry is { type: string; text: string } =>
        entry?.type === 'text' && typeof entry.text === 'string'
    );

    if (!textEntry) {
      throw new Error('No text response from MCP tool');
    }

    return unwrapUseToolEnvelope(textEntry.text);
  } finally {
    clearTimeout(timeoutId);
    try { await transport.terminateSession(); } catch { /* ignore */ }
    try {
      await client.close();
    } catch {
      // Ignore cleanup failures.
    }
  }
}

/**
 * Background task that gathers diagnostics, runs LLM analysis, and submits to Sentry.
 * Broadcasts status updates to the renderer for toast notifications.
 */
/**
 * Stable per-report identifiers, minted once at submit time and reused for the
 * lifetime of the report. `eventId` is a 32-char lowercase hex string (NOT a
 * dashed UUID) so it is a valid Sentry `event_id`; passing it into the capture
 * means a later retry (e.g. the Stage 4 outbox) can re-submit with the same id
 * and Sentry dedups server-side. `reportId` is a UUID used for fingerprint
 * entropy (Stage 3), the outbox filename (Stage 4), and a tag.
 */
interface BugReportIdentifiers {
  reportId: string;
  /** 32-char lowercase hex; a valid Sentry event_id. */
  eventId: string;
}

function mintBugReportIdentifiers(): BugReportIdentifiers {
  return {
    reportId: randomUUID(),
    eventId: randomBytes(16).toString('hex'),
  };
}

/**
 * Attempt ONE delivery of a bug report to Sentry: gather best-effort enrichment
 * under hard timeouts, then capture a SINGLE event with the record's fixed
 * `eventId` (so retries dedup server-side). This is the outbox's per-record
 * submit function — both the immediate attempt and every retry go through it.
 *
 * Returns a structured {@link BugReportSubmitOutcome} the outbox uses to decide
 * delete (delivered) vs keep-and-backoff (retry) vs pause (circuit-open). Toast
 * status (`queued`/`delivered`/`delivery-unavailable`/`failed`) is owned by the
 * enqueue path and the outbox callbacks (Stage 5 honest status); the transient
 * retry/circuit-open outcomes here are background and do NOT toast — only a
 * terminal dead-letter surfaces `delivery-unavailable`.
 *
 * The `diagnosticSections` (a small per-section boolean toggle map) ARE
 * persisted in the outbox record and threaded back in here via `extra` on both
 * the immediate attempt and every retry, so the user's CONSENT choice — an
 * explicit `false` means "do not gather this section" — is always honored
 * (Stage-4 review F3). They drive the freshly-gathered diagnostics' inclusion;
 * the diagnostic CONTENT itself is re-gathered, never stored.
 */
async function attemptBugReportDelivery(
  record: BugReportRecord,
  extra: { diagnosticSections?: DiagnosticSections } = {},
): Promise<BugReportSubmitOutcome> {
  // The downstream builders + scope logic were written against the validated
  // IPC request shape. Reconstruct that shape from the persisted record plus the
  // non-persisted (re-gathered) `diagnosticSections`, so the Stage-1/2/3 capture
  // logic below is reused verbatim — both the immediate attempt and retries run
  // through exactly this path.
  const validated = {
    description: record.description,
    stepsToReproduce: record.stepsToReproduce,
    expectedBehavior: record.expectedBehavior,
    urgency: record.urgency,
    screenshotBase64: record.screenshotBase64,
    screenshotMimeType: record.screenshotMimeType,
    includeEnrichedDiagnostics: record.includeEnrichedDiagnostics,
    attachContinuityDiagnostics: record.attachContinuityDiagnostics,
    diagnosticSections: extra.diagnosticSections,
    conversationId: record.conversationId,
    reportId: record.reportId,
    eventId: record.eventId,
  };
  try {
    // Guard: Sentry may be disabled (no DSN in this build, or SENTRY_ENABLED
    // turned it off — the dev default). Check early to avoid wasted
    // diagnostics/LLM work, and tell the user the TRUTHFUL reason: a packaged
    // build missing its DSN is not "development mode" (2026-06 beta outage).
    if (!isMainSentryEnabled()) {
      const reason = getMainSentryDisabledReason() ?? 'env-disabled';
      if (reason === 'no-dsn') {
        log.warn('Bug report not sent — Sentry is disabled: no DSN configured in this build.');
      } else {
        log.warn('Bug report not sent — Sentry is disabled via SENTRY_ENABLED (dev default). Set SENTRY_ENABLED=1 to enable.');
      }
      // No status broadcast here: the outbox's `onSentryDisabledWithPending`
      // owns the single user-facing `delivery-unavailable` toast for the
      // disabled case (it has the report text for the Copy-report action and
      // de-dupes to at most one per skipped drain). The record stays in the
      // outbox; if Sentry is enabled later it delivers.
      return { kind: 'circuit-open', error: `sentry-disabled:${reason}` };
    }

    const title = buildBugReportTitle(validated.description);
    const body = buildBugReportBody(validated);
    const conversationLink = buildConversationLink(validated.conversationId);
    const appVersion = getSafeAppVersion();
    const fullMessage = `${title}\n\n${body}`;

    const includeEnriched = validated.includeEnrichedDiagnostics !== false
      || validated.attachContinuityDiagnostics === true;

    let diagnostics: Awaited<ReturnType<typeof gatherDeterministicDiagnostics>> | null = null;
    let rawLogsNdjson: string | undefined;
    let analysisSummary: string | null = null;

    if (includeEnriched) {
      const settings = getSettings();

      // Phase A: Deterministic diagnostic gathering.
      // Hard-bounded: this gather is file I/O (logs, continuity stores) and can
      // hang on a locked disk / EMFILE just like the other enrichment steps. A
      // hang here must NOT gate the raw capture — on the deadline we proceed
      // with `diagnostics = null`, which flows into exactly the same downstream
      // null/fallback paths as the catch below (fallback summary, Phase B
      // skipped when `diagnostics` is null).
      try {
        diagnostics = await withTimeout(
          gatherDeterministicDiagnostics(settings, {
            includeEnrichedDiagnostics: validated.includeEnrichedDiagnostics,
            attachContinuityDiagnostics: validated.attachContinuityDiagnostics,
            diagnosticSections: validated.diagnosticSections,
          }),
          BUG_REPORT_DIAGNOSTICS_TIMEOUT_MS,
          null,
        );
        if (diagnostics === null) {
          log.warn('Phase A diagnostic gathering timed out; continuing without deterministic diagnostics');
        }
      } catch (err) {
        log.warn({ err }, 'Phase A diagnostic gathering failed');
      }

      // Also export raw unfiltered logs for the LLM to analyze.
      // Hard-bounded: a hung/locked-disk log export must NOT delay capture.
      try {
        const rawLogs = await withTimeout(
          exportRecentLogs({ logWindowMinutes: 15 }),
          BUG_REPORT_RAW_LOG_TIMEOUT_MS,
          null,
        );
        if (rawLogs === null) {
          log.warn('Raw log export for LLM analysis timed out; continuing without raw logs');
        }
        const fullLogs = (rawLogs?.files ?? []).map((f) => f.content).join('\n');
        // Cap raw logs to ~50KB (~12k tokens) to bound LLM cost/latency
        const MAX_RAW_LOG_CHARS = 50_000;
        rawLogsNdjson = fullLogs.length > MAX_RAW_LOG_CHARS
          ? fullLogs.slice(-MAX_RAW_LOG_CHARS) // Keep the most recent entries (end of logs)
          : fullLogs;
      } catch (err) {
        log.warn({ err }, 'Raw log export for LLM analysis failed');
      }

      // Phase B: LLM analysis (skip if shutting down).
      // Hard TOTAL wall-clock deadline: the BTS client's per-fetch 60s timeout
      // is NOT a global cap (retries + operational-fallback re-dispatch can
      // stack), so we bound the whole call here. On the deadline we proceed
      // with the deterministic fallback summary built below.
      if (!isShuttingDown() && diagnostics) {
        try {
          analysisSummary = await withTimeout(
            analyzeBugReport({
              bugDescription: validated.description,
              stepsToReproduce: validated.stepsToReproduce,
              expectedBehavior: validated.expectedBehavior,
              urgency: validated.urgency,
              rawDiagnostics: diagnostics,
              rawLogs: rawLogsNdjson,
              settings,
            }),
            BUG_REPORT_LLM_ANALYSIS_TIMEOUT_MS,
            null,
          );
          if (analysisSummary === null) {
            log.warn('Phase B LLM analysis timed out; falling back to deterministic summary');
          }
        } catch (err) {
          log.warn({ err }, 'Phase B LLM analysis failed');
        }
      }
    }

    // Gather auto-update forensic attachments BEFORE entering Sentry scope.
    // The gather step is async (file I/O); the scope callback is sync. Splitting
    // the two ensures the attachments are added before `captureMessage` flushes
    // the event to the Sentry transport. See planning doc Stage 3 / critique C3.
    //
    // Runs unconditionally of LLM success/failure: the original incident
    // (REBEL-52C) had Phase B fail at 09:24:31 which silently dropped the
    // forensics. The whole point of this attachment path is to be independent
    // of the LLM analysis.
    let updateForensicsBundle: Awaited<ReturnType<typeof gatherUpdateForensics>> | null = null;
    try {
      const userDataPath = app?.getPath?.('userData');
      if (typeof userDataPath === 'string' && userDataPath.length > 0) {
        // Hard-bounded: a hung forensics gather (locked plist, EMFILE) must NOT
        // delay capture — proceed without forensics on the deadline.
        updateForensicsBundle = await withTimeout(
          gatherUpdateForensics({
            userDataPath,
            bundleId: resolveBundleId(),
          }),
          BUG_REPORT_FORENSICS_TIMEOUT_MS,
          null,
        );
        if (updateForensicsBundle === null) {
          log.warn('Update forensics gather timed out; continuing without forensics');
        }
      } else {
        log.warn('userData path unavailable; skipping update forensics gather');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to gather update forensics');
    }

    // Submit to Sentry. We capture a SINGLE event with a caller-supplied,
    // stable `event_id` (32-char hex, minted at submit time). All attachments
    // are assembled inside the scope BEFORE capture — Sentry finalizes the
    // event at capture time, so post-capture attach is a no-op. The stable id
    // lets a later retry (Stage 4 outbox) re-submit and dedup server-side.
    const eventId: string = validated.eventId;
    let totalAttachmentBytes = 0;
    SentryMain.withScope((scope) => {
      scope.setTag('source', 'user-bug-report');
      scope.setTag('report_id', validated.reportId);
      scope.setTag('urgency', validated.urgency);
      scope.setTag('feedback_type', 'bug_report');
      scope.setTag('app_version', appVersion);
      scope.setTag('platform', process.platform);
      if (validated.attachContinuityDiagnostics) {
        scope.setTag('attach_continuity_diagnostics', 'true');
      }

      if (conversationLink) {
        scope.setExtra('conversation_link', conversationLink);
      }

      // Structured extras from Phase A diagnostics
      if (diagnostics?.health) {
        scope.setExtra('health_status', diagnostics.health.status);
        scope.setExtra('health_failed_checks', diagnostics.health.failedChecks);
        scope.setExtra('health_warn_checks', diagnostics.health.warnChecks);
      }
      if (diagnostics?.errorPatterns) {
        scope.setExtra('error_pattern_count', diagnostics.errorPatterns.length);
      }
      if (diagnostics?.costStats) {
        scope.setExtra('cost_stats', diagnostics.costStats);
      }
      if (diagnostics?.sectionStates) {
        scope.setExtra('diagnostic_section_states', diagnostics.sectionStates);
      }

      // MCP registration status for diagnostic visibility
      try {
        const mcpStatus = getMcpRegistrationStatus();
        scope.setExtra('mcp_registration_lifecycle', mcpStatus.lifecycle);
        scope.setExtra('mcp_registration_gated', JSON.stringify(mcpStatus.gated));
        scope.setExtra('mcp_registration_failed', JSON.stringify(mcpStatus.failed));
      } catch {
        // Non-fatal — MCP status unavailable
      }

      // Feature gates for diagnostic visibility
      try {
        const currentSettings = getSettings();
        scope.setExtra('feature_gates', JSON.stringify({
          meetingBotUnlocked: currentSettings.meetingBotUnlocked ?? null,
          managedCloudEnabled: currentSettings.managedCloudEnabled ?? null,
          mcpServerEnabled: currentSettings.mcpServerEnabled ?? null,
          onboardingCompleted: currentSettings.onboardingCompleted ?? null,
          indexingEnabled: currentSettings.indexingEnabled ?? null,
        }));
      } catch {
        // Non-fatal — settings unavailable
      }

      if (validated.screenshotBase64) {
        const screenshotMimeType = validated.screenshotMimeType ?? 'image/png';
        totalAttachmentBytes += addAttachmentAndCountBytes(scope, {
          filename: `screenshot.${extractMimeExtension(screenshotMimeType)}`,
          data: decodeBase64(validated.screenshotBase64),
          contentType: screenshotMimeType,
        });
      }

      // Attach diagnostic-summary.md unconditionally when Phase A diagnostics
      // are available. LLM analysis (Phase B) is preferred when it succeeded;
      // otherwise we build a deterministic Markdown stub from the Phase A
      // payload so triage is never blocked by Phase B failure (REBEL-4GH /
      // FOX-3152). Apply the same defense-in-depth log-message sanitiser to
      // both paths.
      if (analysisSummary) {
        const sanitizedSummary = sanitizeLogMessage(analysisSummary);
        totalAttachmentBytes += addAttachmentAndCountBytes(scope, {
          filename: 'diagnostic-summary.md',
          data: new TextEncoder().encode(sanitizedSummary),
          contentType: 'text/markdown',
        });
      } else if (diagnostics) {
        const fallbackReason: 'llm_failed' | 'llm_skipped_shutdown' | 'llm_not_attempted' =
          isShuttingDown()
            ? 'llm_skipped_shutdown'
            : includeEnriched
              ? 'llm_failed'
              : 'llm_not_attempted';
        const fallbackSummary = buildFallbackDiagnosticSummary({
          bugDescription: validated.description,
          stepsToReproduce: validated.stepsToReproduce,
          expectedBehavior: validated.expectedBehavior,
          urgency: validated.urgency,
          rawDiagnostics: diagnostics,
          reason: fallbackReason,
        });
        const sanitizedSummary = sanitizeLogMessage(fallbackSummary);
        totalAttachmentBytes += addAttachmentAndCountBytes(scope, {
          filename: 'diagnostic-summary.md',
          data: new TextEncoder().encode(sanitizedSummary),
          contentType: 'text/markdown',
        });
      }

      // Attach update-forensics bundle (auto-update state, watchdog telemetry,
      // install marker, and macOS ShipIt log/plist) — runs UNCONDITIONALLY of
      // LLM success/failure, by design (planning doc Stage 3 / critique C3+I8).
      if (updateForensicsBundle) {
        try {
          attachUpdateForensicsToScope({
            addAttachment: (attachment) => {
              totalAttachmentBytes += addAttachmentAndCountBytes(scope, attachment);
            },
          }, updateForensicsBundle);
        } catch (err) {
          log.warn({ err }, 'Failed to attach update forensics to scope');
        }
      }

      // Attach filtered logs (Phase A) if available
      if (diagnostics?.filteredLogs && diagnostics.filteredLogs.length > 0) {
        const filteredNdjson = diagnostics.filteredLogs
          .map((f) => f.filteredContent)
          .join('\n');
        totalAttachmentBytes += addAttachmentAndCountBytes(scope, {
          filename: 'filtered-logs.ndjson',
          data: new TextEncoder().encode(filteredNdjson),
          contentType: 'application/x-ndjson',
        });
      }

      scope.setLevel('error');
      // Per-report fingerprint entropy: include the stable `reportId` so each
      // submission becomes its own Sentry issue (and the external Sentry->Linear
      // automation fires per report). `title` is kept as readable grouping
      // metadata. Previously `['user-bug-report', title]` collapsed identical/
      // generic first lines into one issue (confirmed REBEL-692: 'harry test'
      // x2 -> a single issue, no second Linear ticket). Each user report is a
      // distinct human signal, so we deliberately drop dup-grouping here.
      scope.setFingerprint(['user-bug-report', title, validated.reportId]);
      // Capture via the SCOPE so the caller-supplied event_id is honored:
      // SentryMain.captureMessage(msg, { event_id }) does NOT honor it (the
      // top-level helper treats the 2nd arg as captureContext, not a hint),
      // whereas scope.captureMessage(msg, level, hint) passes event_id through.
      scope.captureMessage(fullMessage, 'error', { event_id: eventId });
    });

    const flushTimeoutMs = isShuttingDown()
      ? BUG_REPORT_SENTRY_SHUTDOWN_FLUSH_TIMEOUT_MS
      : BUG_REPORT_SENTRY_FLUSH_TIMEOUT_MS;
    const flushed = await SentryMain.flush(flushTimeoutMs);
    const outcome = flushed ? getSendOutcome(eventId) : undefined;
    const statusCode = outcome?.statusCode;

    if (flushed && typeof statusCode === 'number' && statusCode >= 200 && statusCode < 300) {
      // Confirmed 2xx → a SILENT upgrade (the copy module returns null for
      // 'delivered'); the user already saw the positive 'queued' toast on submit.
      broadcastBugReportStatus({ status: 'delivered' });
      try {
        getTracker().track('Bug Report Submitted', { sentry_event_id: eventId ?? null, app_version: appVersion, channel: getBuildChannel() });
      } catch (error) {
        // Never let analytics failures affect bug report delivery status.
        ignoreBestEffortCleanup(error, {
          operation: 'bugReport.submit.trackAccepted',
          reason: 'analytics failure must not affect sent status',
          owner: 'main.ipc.bugReportHandlers',
        });
      }
      log.info(
        { eventId, statusCode, totalAttachmentBytes },
        'Bug report accepted by Sentry transport (2xx — delivery not confirmed; processing may still reject)'
      );
      // Confirmed 2xx → the outbox deletes the record (delivered).
      return { kind: 'delivered' };
    }

    if (flushed && statusCode === 429) {
      // Rate-limited / quota. Pause the whole drain; honour Retry-After when the
      // transport surfaced it (widened SentrySendOutcome). This is NOT a per-
      // record failure (no attempt is counted) — it's server-side capacity. No
      // toast: this is a transient background condition the outbox retries
      // silently; only terminal dead-letter surfaces 'delivery-unavailable'.
      const retryAfterMs = typeof outcome?.retryAfterSeconds === 'number'
        ? outcome.retryAfterSeconds * 1000
        : undefined;
      log.warn(
        { eventId, statusCode, totalAttachmentBytes, retryAfterMs, reason: 'rate-limited' },
        'Bug report rate-limited by Sentry transport — pausing drain'
      );
      return { kind: 'circuit-open', error: 'sentry-429', retryAfterMs };
    }

    if (flushed && typeof statusCode === 'number') {
      // Other non-2xx → transient from the outbox's perspective; keep + backoff.
      // No toast: a transient retry is background work; only terminal
      // dead-letter (retries exhausted) surfaces 'delivery-unavailable'.
      log.warn(
        { eventId, statusCode, totalAttachmentBytes, reason: 'transport-rejected' },
        'Bug report rejected by Sentry transport'
      );
      return { kind: 'retry', error: `transport-${statusCode}` };
    }

    log.warn(
      { eventId, totalAttachmentBytes, reason: 'transport-outcome-unknown' },
      'Bug report Sentry transport outcome unknown'
    );
    return { kind: 'retry', error: 'transport-outcome-unknown' };
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    log.error({ err: errorMessage }, 'Failed to submit bug report in background');
    // No toast on a transient delivery error: the outbox retries; only terminal
    // dead-letter surfaces 'delivery-unavailable'.
    return { kind: 'retry', error: errorMessage };
  }
}

// ---------------------------------------------------------------------------
// Durable outbox wiring (Stage 4)
// ---------------------------------------------------------------------------

let bugReportOutbox: BugReportOutbox | null = null;

/**
 * Whether a drain `trigger` corresponds to the user's CURRENT submit, so a
 * `delivery-unavailable` outcome should surface a toast. The immediate
 * `'enqueue'` drain is the only one tied to a fresh user action; boot,
 * power-resume, the backoff-timer, and quit drains are proactive/background and
 * must not pop an unsolicited toast for a stranded prior-session record (Phase 7
 * SHOULD-3 / Native F2). Those outcomes are still logged (observable).
 */
function isUserInitiatedDrain(trigger: string): boolean {
  return trigger === 'enqueue';
}

/**
 * Lazily construct the singleton outbox. The per-record submit fn is
 * `attemptBugReportDelivery`; Sentry-enabled state is read live so enabling
 * Sentry later resumes delivery of records persisted while it was off.
 */
function getBugReportOutbox(): BugReportOutbox {
  if (!bugReportOutbox) {
    bugReportOutbox = new BugReportOutbox({
      // Thread the user's persisted granular section toggles into delivery so an
      // explicit `false` (consent: "do not gather this section") is honored on
      // the immediate attempt AND every retry (Stage-4 review F3).
      submit: (record) =>
        attemptBugReportDelivery(record, { diagnosticSections: record.diagnosticSections }),
      isSentryEnabled: () => isMainSentryEnabled(),
      // When Sentry is off and a report is waiting, keep the toast honest: the
      // report is saved (persisted) but can't be delivered right now. The record
      // stays on disk and delivers if Sentry is enabled later. We forward the
      // report text so the renderer can offer an environment-independent
      // "Copy report" action (the dialog has already reset by toast time).
      onSentryDisabledWithPending: (oldestPending, trigger) => {
        const reason = getMainSentryDisabledReason() ?? 'env-disabled';
        if (reason === 'no-dsn') {
          log.warn({ trigger }, 'Bug report not sent — Sentry is disabled: no DSN configured in this build.');
        } else {
          log.warn({ trigger }, 'Bug report not sent — Sentry is disabled via SENTRY_ENABLED (dev default). Set SENTRY_ENABLED=1 to enable.');
        }
        // SHOULD-3 (Phase 7, Native F2): only toast in response to the user's
        // CURRENT submit (`enqueue`). A stranded prior-session record replayed by a
        // boot/proactive/background drain must NOT pop an unsolicited startup
        // warning toast unrelated to any current action — the no-op is already
        // logged above (observable), which is the right surface for it.
        if (!isUserInitiatedDrain(trigger)) return;
        broadcastBugReportStatus({
          status: 'delivery-unavailable',
          reason,
          reportText: oldestPending.description,
        });
      },
      // When a report exhausts its retries (dead-letter), tell the user honestly:
      // saved, but we couldn't reach the team. Forward the report text for the
      // Copy-report action so a permanently-undeliverable report isn't lost to them.
      // Same suppression as above: a dead-letter reached during a boot/background
      // drain is not the user's current action, so it is logged (the dead-letter
      // also emits its own Sentry event) but not toasted (Phase 7 SHOULD-3).
      onDeadLetter: (record, trigger) => {
        if (!isUserInitiatedDrain(trigger)) {
          log.warn({ trigger, reportId: record.reportId }, 'Bug report dead-lettered during a background drain — not toasting (no current user action)');
          return;
        }
        broadcastBugReportStatus({
          status: 'delivery-unavailable',
          reason: 'dead-letter',
          reportText: record.description,
        });
      },
    });
  }
  return bugReportOutbox;
}

/** Start the outbox (boot dir-scan + immediate drain). Wired from bootstrap. */
export async function startBugReportOutbox(): Promise<void> {
  await getBugReportOutbox().start();
}

/** Drain + stop the outbox during quit, bounded by `timeoutMs`. */
export async function stopBugReportOutbox(timeoutMs?: number): Promise<void> {
  if (!bugReportOutbox) return;
  await bugReportOutbox.stop({ timeoutMs });
}

/** Test-only reset so each test gets a fresh singleton. */
export function resetBugReportOutboxForTest(): void {
  bugReportOutbox = null;
}

/**
 * Test-only accessor so a test can `await` the in-flight (or trigger a) drain
 * deterministically — the handler intentionally does NOT await delivery, so
 * tests that assert on delivery side-effects need a handle to the drain.
 */
export function getBugReportOutboxForTest(): BugReportOutbox {
  return getBugReportOutbox();
}

export function registerBugReportHandlers(): void {
  const submitBugChannel = bugReportChannels['bug-report:submit-bug'];
  registerHandler(submitBugChannel.channel, async (_event, request: unknown) => {
    const validated = submitBugChannel.request.parse(request);

    // Guard against concurrent submissions
    if (bugReportInFlight) {
      return {
        outcome: 'failed' as const,
        error: 'Bug report already in progress',
      };
    }

    // Acquire the guard with a self-healing watchdog (clears the flag on a hard
    // deadline even if the durable enqueue hangs). The token scopes the matching
    // release to THIS acquisition so a watchdog-evicted task's late settle can't
    // release a newer task's guard. With Stage 4 the guard wraps the (fast)
    // durable write, not the whole delivery — delivery is owned by the outbox
    // and serialized there (concurrency 1), so it cannot race.
    const inFlightToken = acquireBugReportInFlight();

    // Mint stable identifiers once, up front. The 32-char-hex `event_id` is
    // passed into the Sentry capture so retries dedup server-side; `report_id`
    // is reused for fingerprint entropy (Stage 3), the outbox filename (Stage 4),
    // and a tag. The SAME event_id is reused across every retry so a re-delivery
    // after a pre-delete crash dedups server-side (idempotency invariant).
    const identifiers = mintBugReportIdentifiers();

    try {
      // DURABILITY CONTRACT: persist the raw report to disk (atomic + fsync)
      // BEFORE returning `accepted`. Only once the durable write confirms do we
      // tell the renderer the report is safe. The outbox's immediate-on-enqueue
      // drain runs the first delivery attempt; retries (offline/quit/power-loss)
      // replay from disk until Sentry confirms a 2xx. The granular
      // `diagnosticSections` toggle map IS persisted (small boolean map) so the
      // user's consent choice is honored on every attempt; the diagnostic
      // CONTENT is re-gathered fresh each attempt, never stored.
      await getBugReportOutbox().enqueue({
        reportId: identifiers.reportId,
        eventId: identifiers.eventId,
        description: validated.description,
        stepsToReproduce: validated.stepsToReproduce,
        expectedBehavior: validated.expectedBehavior,
        urgency: validated.urgency,
        conversationId: validated.conversationId,
        screenshotBase64: validated.screenshotBase64,
        screenshotMimeType: validated.screenshotMimeType,
        includeEnrichedDiagnostics: validated.includeEnrichedDiagnostics,
        attachContinuityDiagnostics: validated.attachContinuityDiagnostics,
        // Persist the user's granular section toggles (small boolean map) so an
        // explicit `false` consent choice is honored on the immediate attempt
        // and every retry — not silently re-gathered (Stage-4 review F3).
        diagnosticSections: validated.diagnosticSections,
      });
      // Honest positive status: the report is durably saved (not "sent" — that
      // would over-claim transport). ONE positive toast on submit; confirmed
      // delivery later is a silent upgrade. The dialog has already closed on
      // `accepted`, so this toast is the user's receipt.
      broadcastBugReportStatus({ status: 'queued' });
      return { outcome: 'accepted' as const };
    } catch (err) {
      // The durable write itself failed (e.g. disk full). Be honest: do NOT
      // return a false `accepted`. (Near-impossible in practice; Stage 5 gives
      // this its own user-facing copy.)
      log.error({ err }, 'Failed to durably persist bug report to outbox');
      return {
        outcome: 'failed' as const,
        error: 'Could not save your report. Please try again.',
      };
    } finally {
      releaseBugReportInFlight(inFlightToken);
    }
  });

  const submitFeedbackChannel = bugReportChannels['bug-report:submit-feedback'];
  registerHandler(submitFeedbackChannel.channel, async (_event, request: unknown) => {
    const validated = submitFeedbackChannel.request.parse(request);
    const fallbackUrl = buildFeedbackFallbackUrl(validated.title);

    try {
      const toolText = await callMcpTool({
        packageId: REBELS_COMMUNITY_WRITE_PACKAGE_ID,
        toolId: DISCOURSE_CREATE_TOPIC_TOOL_ID,
        args: {
          title: validated.title,
          raw: validated.description,
          category_id: FEEDBACK_CATEGORY_ID,
        },
      });

      log.info(
        { toolTextLength: toolText.length, toolTextPreview: truncateWellFormed(toolText, 500) },
        'Discourse MCP tool response received'
      );

      // Detect Discourse API errors returned as tool text
      if (/^(Failed to|Error:?)\b/i.test(toolText) || /HTTP [45]\d\d/.test(toolText)) {
        log.error({ toolText: truncateWellFormed(toolText, 500) }, 'Discourse API returned an error');
        throw new Error(toolText.length > 200 ? `${truncateWellFormed(toolText, 200)}...` : toolText);
      }

      const discourseTopicUrl = extractDiscourseTopicUrl(toolText);
      if (!discourseTopicUrl) {
        log.error(
          { toolText: truncateWellFormed(toolText, 2000) },
          'Failed to extract Discourse topic URL from MCP response'
        );
        throw new Error('Unexpected response from Discourse. Please try posting directly on the community.');
      }

      return {
        outcome: 'submitted' as const,
        discourseTopicUrl,
      };
    } catch (error) {
      if (isMcpUnavailableError(error)) {
        return {
          outcome: 'fallback' as const,
          fallbackUrl,
        };
      }

      const errorMessage = toErrorMessage(error);
      log.error({ err: errorMessage }, 'Failed to submit feedback to Discourse');
      return {
        outcome: 'failed' as const,
        error: errorMessage,
      };
    }
  });

  log.info('Bug report IPC handlers registered');
}
