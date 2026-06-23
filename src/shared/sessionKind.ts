export type SessionKind =
  | 'conversation'
  | 'meeting-companion'
  | 'automation'
  | 'automation-insight'
  | 'meeting-analysis'
  | 'use-case-discovery'
  | 'cli-chat'
  | 'memory-update'
  | 'meeting-qa'
  | 'error-eval'
  | 'calendar-sync';

type SessionKindHints = {
  isCompanion?: boolean;
};

const CALENDAR_SYNC_SESSION_ID = 'calendar-sync';
const MEMORY_UPDATE_PREFIX = 'memory-update-';
const MEETING_QA_PREFIX = 'meeting-qa-';
const AUTOMATION_INSIGHT_PREFIX = 'automation-insight-';
const AUTOMATION_PREFIX = 'automation-';
const MEETING_ANALYSIS_PREFIX = 'meeting-analysis-';
const USE_CASE_DISCOVERY_PREFIX = 'use-case-discovery-';
const CLI_CHAT_PREFIX = 'cli-chat-';
const LEGACY_ERROR_EVAL_PREFIX = 'error-eval-';

/**
 * The placeholder title minted when a session is first persisted and has no
 * meaningful title yet. Kept in sync with `DEFAULT_SESSION_TITLES` in
 * conversationTitleService so auto-titling treats it as overwritable.
 */
export const DEFAULT_NEW_SESSION_TITLE = 'New Agent Run';

/**
 * Fixed, human-readable titles for known background/agent-run kinds whose
 * purpose is fixed and whose content is a poor source for a generated title
 * (e.g. use-case discovery synthesizes the user's own private data). Kinds with
 * a fixed title are excluded from auto-titling entirely (see `hasFixedTitle`),
 * so the Haiku titler never runs on them — predictable, no extra model call, no
 * private-data leakage. Kinds not listed get content-based auto-titling.
 */
const FIXED_TITLE_BY_KIND: Partial<Record<SessionKind, string>> = {
  'use-case-discovery': 'Use-case ideas',
};

/**
 * The fixed descriptive title for a kind, or `undefined` if the kind has no
 * fixed title (and should fall back to the caller's surface-specific placeholder
 * — 'New Agent Run' on desktop, 'New conversation' on cloud).
 */
export function fixedTitleForKind(kind: SessionKind): string | undefined {
  return FIXED_TITLE_BY_KIND[kind];
}

/**
 * Whether a kind has a fixed title and therefore must NOT be content-auto-titled.
 * This is the robust guard the auto-title call sites gate on — independent of any
 * title-string comparison or first-write/checkpoint timing race. See
 * `agentEventDispatcher` (desktop) and `agentTurnSubmissionService` (cloud).
 */
export function hasFixedTitle(kind: SessionKind): boolean {
  return fixedTitleForKind(kind) !== undefined;
}

/**
 * Desktop convenience: title to stamp at first-write. Fixed title for known
 * kinds, else the desktop placeholder. See `mergeTurnIntoSession`.
 */
export function defaultTitleForKind(kind: SessionKind): string {
  return fixedTitleForKind(kind) ?? DEFAULT_NEW_SESSION_TITLE;
}

/**
 * Once-per-process dedupe set for the malformed-id warning below, so a corrupt
 * corpus can't log-storm a rebuild/list over thousands of sessions.
 */
const MALFORMED_ID_WARNED = new Set<string>();

export function classifySessionKind(
  sessionId: string,
  hints?: SessionKindHints,
): SessionKind {
  if (hints?.isCompanion) return 'meeting-companion';
  // Tolerant boundary (260617 crash containment): a non-string / empty id used
  // to throw on `sessionId.startsWith(...)`, aborting every caller —
  // `listSessions()` (sidebar/folders), the time-saved backfill, agent turns.
  // The precise trigger was a non-session sidecar (`cloud-tombstone-quarantine.json`)
  // that slipped past the name denylist and hydrated as an id-less "session"; the
  // load chokepoint (loadSessionFileStrict / acceptHydratedSession) now skips such
  // records *observably*, and the index-write layer in incrementalSessionStore stops
  // undefined ids entering the index. This is the last-resort belt-and-braces backstop:
  // degrade to 'conversation' instead of throwing. If a non-companion path ever feeds
  // us a bad id, surface it once (deduped) so a real upstream regression stays
  // observable rather than silently swallowed. See
  // docs-private/investigations/260617_classifysessionkind_undefined_crash_handoff.md.
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    const key = `${typeof sessionId}:${String(sessionId)}`;
    if (!MALFORMED_ID_WARNED.has(key)) {
      MALFORMED_ID_WARNED.add(key);
      // No logger dependency in this shared, platform-agnostic module; a console
      // warn is captured in renderer/main log files ([Renderer] prefix) and is
      // sufficient for a should-never-fire belt-and-braces path.
      console.warn(
        `[sessionKind] classifySessionKind received a malformed id (${typeof sessionId}); defaulting to 'conversation'`,
      );
    }
    return 'conversation';
  }
  if (sessionId === CALENDAR_SYNC_SESSION_ID) return 'calendar-sync';
  if (sessionId.startsWith(MEMORY_UPDATE_PREFIX)) return 'memory-update';
  if (sessionId.startsWith(MEETING_QA_PREFIX)) return 'meeting-qa';
  if (sessionId.startsWith(LEGACY_ERROR_EVAL_PREFIX)) return 'error-eval';
  if (sessionId.startsWith(AUTOMATION_INSIGHT_PREFIX)) return 'automation-insight';
  if (sessionId.startsWith(AUTOMATION_PREFIX)) return 'automation';
  if (sessionId.startsWith(MEETING_ANALYSIS_PREFIX)) return 'meeting-analysis';
  if (sessionId.startsWith(USE_CASE_DISCOVERY_PREFIX)) return 'use-case-discovery';
  if (sessionId.startsWith(CLI_CHAT_PREFIX)) return 'cli-chat';
  return 'conversation';
}

export const SIDEBAR_HIDDEN_KINDS: ReadonlySet<SessionKind> = new Set([
  'memory-update',
  'meeting-qa',
  'error-eval',
  'calendar-sync',
]);

/**
 * Active = conversations the user is personally working on. A kind is excluded
 * from Active iff the session is created WITHOUT an explicit user action that
 * initiates a conversation (a schedule firing / the app analysing a meeting /
 * the app synthesising the user's data → excluded; clicking "explore", opening
 * the CLI, sending a message → kept).
 */
export const EXCLUDED_FROM_ACTIVE_KINDS: ReadonlySet<SessionKind> = new Set([
  'automation',
  'meeting-analysis',
  'use-case-discovery',
]);

export const DELETE_ELIGIBLE_KINDS: ReadonlySet<SessionKind> = new Set([
  'memory-update',
  'meeting-qa',
  'error-eval',
  'calendar-sync',
]);

export const SKIP_CHECKPOINTING_KINDS: ReadonlySet<SessionKind> = DELETE_ELIGIBLE_KINDS;

/** Sessions where memory writes should be SKIPPED (no memory persistence). */
export const SKIP_MEMORY_UPDATE_KINDS: ReadonlySet<SessionKind> = new Set([
  'memory-update',
  'use-case-discovery',
  'cli-chat',
]);

/** Sessions where time-saved tracking should be SKIPPED. */
export const SKIP_TIME_SAVED_KINDS: ReadonlySet<SessionKind> = new Set([
  'memory-update',
  'automation',
  'automation-insight',
  'meeting-analysis',
  'meeting-qa',
  'calendar-sync',
  'use-case-discovery',
  'cli-chat',
]);

/** Sessions classified as "internal" for cost-ledger reporting. */
export const INTERNAL_LEDGER_KINDS: ReadonlySet<SessionKind> = new Set([
  'memory-update',
  'meeting-qa',
  'calendar-sync',
  'automation',
  'automation-insight',
  'meeting-analysis',
  'use-case-discovery',
  'cli-chat',
]);

export function isSidebarHiddenKind(kind: SessionKind): boolean {
  return SIDEBAR_HIDDEN_KINDS.has(kind);
}

export function isBackgroundConversationKind(kind: SessionKind): boolean {
  return EXCLUDED_FROM_ACTIVE_KINDS.has(kind);
}

export function isDeleteEligibleKind(kind: SessionKind): boolean {
  return DELETE_ELIGIBLE_KINDS.has(kind);
}

export function shouldSkipCheckpointing(kind: SessionKind): boolean {
  return SKIP_CHECKPOINTING_KINDS.has(kind);
}

export function shouldSkipMemoryUpdate(kind: SessionKind): boolean {
  return SKIP_MEMORY_UPDATE_KINDS.has(kind);
}

export function shouldSkipTimeSaved(kind: SessionKind): boolean {
  return SKIP_TIME_SAVED_KINDS.has(kind);
}

export function isInternalLedgerKind(kind: SessionKind): boolean {
  return INTERNAL_LEDGER_KINDS.has(kind);
}

export function isSidebarHiddenSession(
  sessionId: string,
  hints?: SessionKindHints,
): boolean {
  return isSidebarHiddenKind(classifySessionKind(sessionId, hints));
}

export function isBackgroundConversationSession(
  sessionId: string,
  hints?: SessionKindHints,
): boolean {
  return isBackgroundConversationKind(classifySessionKind(sessionId, hints));
}

/**
 * Reliable ID-prefix replacement for `origin === 'automation'` classification.
 * Scope is the automation kind only; adjacent background kinds stay separate.
 */
export function isAutomationSession(
  sessionId: string,
  hints?: SessionKindHints,
): boolean {
  return classifySessionKind(sessionId, hints) === 'automation';
}

export function isDeleteEligibleSession(
  sessionId: string,
  hints?: SessionKindHints,
): boolean {
  return isDeleteEligibleKind(classifySessionKind(sessionId, hints));
}
