/**
 * Canonical renderer session store that centralizes conversation state rules so
 * all UI surfaces observe one source of truth under concurrent updates.
 *
 * @see ../../../../../docs/project/UI_CONVERSATIONS.md — transcript/sidebar state model + Turn-liveness projection (Intent & Design Rationale)
 * @see ../../../../../docs/project/ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md — renderer-store architecture
 * @see ../hooks/useAgentSessionEngine.ts — turn engine integration points
 */
import { create } from "zustand";
import { devtools, subscribeWithSelector } from "zustand/middleware";
import type {
  AgentEvent,
  AgentSession,
  AgentSessionSummary,
  AgentTurnMessage,
  CompactionBoundary,
} from "@shared/types";
import { createId } from "@shared/utils/id";
import { isBackgroundConversationSession } from "@shared/sessionKind";
import { isSessionActive, isSessionDone } from "@rebel/shared";
import type { AgentSessionWithRuntime } from "../types";
import {
  conversationReducer,
  runtimeReducer,
  type ConversationStateShape,
} from "./reducers";
import { TURN_ID_FALLBACK } from "@renderer/constants";
import { MAX_DRAFT_ONLY_SESSIONS } from "@core/constants";
import { createSummaryFromSession } from "./effects/persistenceManager";
import { compactCompletedTurns } from "@shared/utils/eventCompaction";
import { persistRetry, clearPersistedRetry, clearAllPersistedRetries } from '../../../../core/services/pendingRetryStore';
import {
  sanitiseCorruptedDraftText,
  detectCorruptionMarkers,
} from '../../composer/utils/draftSanitisation';
import {
  markSessionSanitised,
  wasSessionSanitised,
} from '../../composer/utils/draftSanitisationState';
import { toComposerWireMarkdown } from '../../composer/utils/composerMarkdown';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { beginValidatedSessionWrite } from '@shared/utils/eventSessionValidation';
import { recordRendererBreadcrumb } from '@renderer/src/sentry';
import { useRouteLabelCacheStore } from '@renderer/features/settings/store/routeLabelCacheStore';
import {
  classifySessionSummaryWrite,
  declareSessionRestore,
  declareSoftDelete,
  isReattachableTrashRow,
  recordSessionRemoval,
} from './sessionDeleteAuthority';
import { normalizeFinishLine } from '@core/utils/finishLine';
import { toPersistedBusyScalars } from '@core/services/conversationState';
import { guardActiveIngestRegression } from '@core/services/sessionIngestGuard';
import {
  type EgressSession,
  isRendererLocalTerminalEvent,
  isRendererOptimisticTurnStartedEvent,
} from './rendererLocalEventEgress';
import type {
  SummaryMetadataFields,
  DraftContent,
  BufferedEvent,
  SessionStoreState,
  SessionStore,
} from './sessionStoreTypes';

// Behavior-preserving Stage 1: the store's type declarations now live in
// ./sessionStoreTypes. Re-exported here so the 49 non-test importers + 84 test
// import-sites keep resolving the externally-consumed types from the canonical
// .../store/sessionStore path.
export type {
  ExhaustedReason,
  CompactionPhase,
  CompactionState,
  PendingNetworkRetryTurn,
  BufferedEvent,
  PendingQuestionEventSnapshot,
  EventsVersionCounters,
  EventIngressProvenance,
  SessionStore,
} from './sessionStoreTypes';
import {
  omit,
  hasOwn,
  getLiveOrPersistedAnnotations,
  createDraftPreviewSnippet,
  getDraftOnlySessionsToCleanup,
  stripRuntime,
  normalizeCurrentSessionOrigin,
  deriveSummaryLivenessFromProjection,
  applySummaryBusyStaleness,
  createInitialCompactionState,
  buildRuntimeFromSnapshot,
  createInitialState,
} from './sessionStoreHelpers';

// Behavior-preserving Stage 2: the store's pure stateless utilities now live in
// ./sessionStoreHelpers. Re-exported here (the 3 with external importers) so the
// canonical .../store/sessionStore import path keeps resolving.
export {
  stripRuntime,
  normalizeCurrentSessionOrigin,
  buildRuntimeFromSnapshot,
} from './sessionStoreHelpers';
import {
  accumulateThinkingDelta,
  discardPendingThinkingDelta,
  scheduleThinkingFlush,
  cancelPendingThinkingDeltas,
} from './thinkingDeltaScheduler';

// Behavior-preserving Stage 3: the thinking-delta batching subsystem now lives
// in ./thinkingDeltaScheduler (Map + flush scheduler behind accessors).
// Re-exported here so the canonical .../store/sessionStore import path keeps
// resolving cancelPendingThinkingDeltas.
export { cancelPendingThinkingDeltas } from './thinkingDeltaScheduler';
import {
  shouldDropForeignIngressEvent,
  __resetValidationOutcomeReportingForTest,
} from './validationTelemetry';

// Behavior-preserving Stage 4: the cross-session ingress validation guard and
// its outcome-telemetry reporter now live in ./validationTelemetry.
// Re-exported here so the canonical .../store/sessionStore import path keeps
// resolving __resetValidationOutcomeReportingForTest.
export { __resetValidationOutcomeReportingForTest } from './validationTelemetry';
import {
  bumpVersion,
  registerEventsVersionNotifier,
  flushPendingEventsVersionNotification,
  appendEventToCurrentSession,
  removeAllRendererOptimisticTurnStartedEvents,
  getCurrentSessionEvents,
  getCurrentSessionEventsForTurn,
  getCurrentSessionEventsVersion,
  getCurrentSessionProjectedLiveness,
  getCurrentSessionEventsForEgress,
  setCurrentSessionEvents,
  clearCurrentSessionEvents,
  removeCurrentSessionEventTurn,
  initCurrentSessionEventTurn,
  hasCurrentSessionEvents,
} from './currentSessionEvents';

// Behavior-preserving Stage 5: the currentSessionEvents Map + version-counter
// subsystem (kept co-located — bumpVersion is co-mutated with the counter) +
// all event accessors now live in ./currentSessionEvents. The action closure
// imports bumpVersion / registerEventsVersionNotifier / the accessors directly;
// the previously-private getCurrentSessionEventsForEgress is imported (not
// re-exported); the Map is read for leak diagnostics via the encapsulated
// getCurrentSessionEventsMapForDiagnostics accessor. The 19 externally-consumed
// accessors are re-exported so the canonical .../store/sessionStore import path
// keeps resolving.
export {
  getEventsVersionCounters,
  resetEventsVersionCounters,
  setEventsVersionPerfCountersEnabled,
  flushPendingEventsVersionNotification,
  appendEventToCurrentSession,
  appendRendererOptimisticTurnStartedEvent,
  appendRendererLocalTerminalEvent,
  removeRendererOptimisticTurnStartedEvent,
  removeAllRendererOptimisticTurnStartedEvents,
  getCurrentSessionEvents,
  getCurrentSessionEventsForTurn,
  getCurrentSessionEventsVersion,
  subscribeToCurrentSessionEventsVersion,
  getCurrentSessionProjectedLiveness,
  setCurrentSessionEvents,
  clearCurrentSessionEvents,
  removeCurrentSessionEventTurn,
  initCurrentSessionEventTurn,
  hasCurrentSessionEvents,
} from './currentSessionEvents';

import {
  updatePendingQuestionEventSnapshots,
  bufferBackgroundEvent,
  takeBackgroundEventBuffer,
  applyBufferedEventUnionToSession,
  persistBufferedEventUnionForSession,
} from './backgroundEventBuffer';

// Behavior-preserving Stage 6: the background-session event buffering subsystem
// (backgroundEventBuffers Map + buffering/union/persist helpers + breadcrumb
// recorders) now lives in ./backgroundEventBuffer. The action closure imports
// the helpers it calls directly; updatePendingQuestionEventSnapshots and
// bufferBackgroundEvent were previously module-private (imported, not
// re-exported); the Map is read for leak diagnostics (Stage 7) via the
// encapsulated getBackgroundEventBuffersForDiagnostics accessor. The
// externally-consumed helpers are re-exported so the canonical
// .../store/sessionStore import path keeps resolving.
export {
  takeBackgroundEventBuffer,
  groupBufferedEventsByTurn,
  unionEventsForTurnInSession,
  applyBufferedEventUnionToSession,
  persistTurnEventUnionForSession,
  persistBufferedEventUnionForSession,
} from './backgroundEventBuffer';

// Behavior-preserving Stage 7: the memory-leak / byte-attribution diagnostics
// readers now live in ./leakDiagnostics. They have no store-closure coupling
// (inputs are passed as parameters or read via the three encapsulated Map
// diagnostics accessors), so nothing is imported back; the six reader functions
// are re-exported so the canonical .../store/sessionStore import path keeps
// resolving.
export {
  getCheapLeakCounters,
  getLeakDiagnostics,
  getToolArchiveDiagnostics,
  getLoadedSessionsPayloadDiagnostics,
  getSessionSummariesPayloadDiagnostics,
  getStateMapsByteDiagnostics,
} from './leakDiagnostics';

import {
  maybeAssertShadowBusyReflipForCurrentSession,
  maybeAssertShadowBusyReflipForLoadedSessions,
} from './shadowBusyProbes';

// Behavior-preserving Stage 8: the shadow-busy reflip dev-assertion probes now
// live in ./shadowBusyProbes (the warning-key Set + the terminal-evidence
// detector + the two assert entry points). The dev-assertion subscriber imports
// the two maybeAssert* entry points directly; the test-only reset is re-exported
// so the canonical .../store/sessionStore import path keeps resolving.
export { __resetShadowBusyReflipWarningsForTest } from './shadowBusyProbes';

// C-lite (2026-04): focusedTurnId is renderer-only/ephemeral; stripRuntime removes it on persist.
// See docs/tutorials/260430_isbusy_dual_id_state_machine_and_c_lite_fix.html.

type IpcSessionArg = Parameters<typeof window.sessionsApi.upsert>[0];
const asIpcSession = (session: EgressSession) => session as IpcSessionArg;

const memoryStatusSetterWarningsByTurn = new Set<string>();
const timeSavedStatusSetterWarningsByTurn = new Set<string>();
const legacyBusyReadWarningKeys = new Set<string>();

export { isRendererOptimisticTurnStartedEvent, isRendererLocalTerminalEvent };

function warnIgnoredIdleCompactionError(params: {
  turnId?: string;
  currentTurnId: string | null;
  currentSessionId: string;
  originalSessionId?: string;
  error: string;
}): void {
  const data = {
    incomingTurnIdHash: params.turnId ? hashSessionIdForBreadcrumb(params.turnId) : null,
    compactionTurnIdHash: params.currentTurnId ? hashSessionIdForBreadcrumb(params.currentTurnId) : null,
    currentSessionIdHash: hashSessionIdForBreadcrumb(params.currentSessionId),
    originalSessionIdHash: params.originalSessionId ? hashSessionIdForBreadcrumb(params.originalSessionId) : null,
    error: params.error,
  };
  recordRendererBreadcrumb({
    category: 'compaction-error-rejected-from-idle',
    level: 'warning',
    data,
  });
  console.warn('[sessionStore] Ignored compaction error while compaction was idle', data);
}

function invalidateMcpAppConversationNonces(conversationId: string): void {
  if (!conversationId) return;
  void globalThis.window?.mcpAppsApi?.invalidateConversationNonces?.({ conversationId });
}

function warnCrossSessionStatusSetterOnce(params: {
  kind: 'memory-update' | 'time-saved';
  turnId: string;
  currentSessionId: string;
  originalSessionId: string;
}): void {
  const warnedSet = params.kind === 'memory-update'
    ? memoryStatusSetterWarningsByTurn
    : timeSavedStatusSetterWarningsByTurn;
  const warningKey = `${params.kind}:${params.turnId}`;
  if (warnedSet.has(warningKey)) {
    return;
  }
  warnedSet.add(warningKey);

  console.warn(`[sessionStore] Ignored cross-session ${params.kind} status setter call`, {
    kind: params.kind,
    turnIdHash: hashSessionIdForBreadcrumb(params.turnId),
    currentSessionIdHash: hashSessionIdForBreadcrumb(params.currentSessionId),
    originalSessionIdHash: hashSessionIdForBreadcrumb(params.originalSessionId),
    stack: new Error('cross-session-status-setter').stack,
  });
}

/**
 * Persist metadata changes for a non-current session.
 *
 * This helper centralizes the async persistence pattern used by:
 * - togglePinSession, toggleStarSession, softDeleteSession, restoreSession, renameSession
 *
 * It handles:
 * 1. Loading session from cache or IPC if not loaded
 * 2. Applying metadata updates to the full session
 * 3. Updating loadedSessions cache (single atomic set)
 * 4. Syncing updatedAt to sessionSummaries for consistency
 * 5. Stripping runtime before persisting
 * 6. Error logging on failure
 *
 * Note: The synchronous sessionSummaries update (with actual metadata fields) must be done
 * by the caller BEFORE calling this helper, as that provides immediate UI feedback.
 * This helper only syncs updatedAt and handles the async cache/persist operations.
 */
const persistNonCurrentSessionMetadata = async (
  sessionId: string,
  updates: Partial<AgentSession> & Partial<SummaryMetadataFields>,
  get: () => SessionStoreState,
  set: (fn: (state: SessionStoreState) => Partial<SessionStoreState>) => void,
): Promise<void> => {
  try {
    const state = get();

    // Guard: this helper is only for non-current sessions
    if (sessionId === state.currentSessionId) {
      console.warn(
        "[sessionStore] persistNonCurrentSessionMetadata called for current session, ignoring",
      );
      return;
    }

    // Load session from cache or IPC
    let session = state.loadedSessions.get(sessionId);
    if (!session) {
      const loaded = await window.sessionsApi.get({ id: sessionId });
      if (!loaded) return;
      session = loaded as AgentSessionWithRuntime;
    }

    // Metadata-only changes (pin, star, rename, delete) should NOT bump
    // updatedAt — it reflects when the session's content last changed (messages,
    // turns). Bumping it here causes the session to jump to the top of the
    // sidebar and poisons the cloud copy via the Math.max merge ratchet.
    const updated: AgentSessionWithRuntime = {
      ...session,
      ...updates,
    };

    // Single atomic update: cache + summary sync (preserves existing updatedAt)
    set((s) => {
      const nextLoadedSessions = s.loadedSessions.has(sessionId)
        ? new Map(s.loadedSessions).set(sessionId, updated)
        : s.loadedSessions;

      const nextSummaries = s.sessionSummaries.map((sum) =>
        sum.id === sessionId ? { ...sum, ...updates } : sum,
      );

      return {
        loadedSessions: nextLoadedSessions,
        // delete-authority: update-only (map over existing rows by id; deletedAt-bearing updates come only from declared soft-delete/restore callers)
        sessionSummaries: nextSummaries,
      };
    });

    await window.sessionsApi.upsert(asIpcSession(stripRuntime(updated)));
  } catch (err) {
    console.warn(
      `[sessionStore] Failed to persist metadata for session ${sessionId}:`,
      err,
    );
  }
};

/** Maximum number of pending network retry turns to track */
const MAX_PENDING_NETWORK_RETRY_TURNS = 10;

/** Maximum number of fully-loaded sessions to keep in LRU cache */
const MAX_LOADED_SESSIONS = 10;

/** Maximum number of tool detail archive entries per session (most recent kept) */
const MAX_TOOL_ARCHIVE_ENTRIES_PER_SESSION = 50;

/** Maximum character length for individual tool archive input/output strings */
const MAX_TOOL_ARCHIVE_VALUE_SIZE = 10_000;

// Behavior-preserving Stage 6: the background-session event buffering subsystem
// (the `backgroundEventBuffers` Map + buffering/union/persist helpers + the
// history-reducer breadcrumb recorders) now lives in ./backgroundEventBuffer.
// See the import + re-export blocks near the top of this file.

// ---------------------------------------------------------------------------
// History event revision tracking — guards against stale async writes
// ---------------------------------------------------------------------------
// When a terminal event arrives for a background session, processHistoryEvent
// fires an async disk-load + rebuild. If a NEW turn starts before that async
// completes, the stale async can overwrite newer summary/cache state (e.g.
// setting isBusy: false when T2 already set isBusy: true). The revision
// counter lets the async block detect that a newer event has arrived and skip
// the stale write.
// ---------------------------------------------------------------------------
const historyEventRevision = new Map<string, number>();

// ---------------------------------------------------------------------------
// Session-removal generation — guards against RESURRECTION of a cleared/deleted
// session by a late, in-flight async re-add.
// ---------------------------------------------------------------------------
// processHistoryEvent's terminal branch fires an async disk-load + rebuild that
// ends in updateSessionSummary(newSummary). updateSessionSummary ADDS the
// summary if it's missing. If a clear/delete path (clearAllSessionsForE2E,
// removeHistorySession, softDeleteSession, emptyTrash) runs SYNCHRONOUSLY while
// that async block is in flight, the re-add lands AFTER the removal and
// RESURRECTS the just-removed session (the "deleted sessions reappear" bug).
//
// The historyEventRevision guard does NOT protect this: the same late terminal
// event re-bumps the revision, so the captured/re-checked revisions still match.
//
// This monotonic counter is bumped by EVERY clear/delete path. The async block
// captures it at the START of its work and re-checks it right before the re-add;
// if it has advanced, a clear/delete intervened and the block BAILS instead of
// resurrecting. The counter only advances on clear/delete, so a genuinely-new
// background session (no intervening removal) is never falsely bailed.
// ---------------------------------------------------------------------------
let sessionRemovalGeneration = 0;

function bumpSessionRemovalGeneration(): number {
  sessionRemovalGeneration += 1;
  return sessionRemovalGeneration;
}

function getSessionRemovalGeneration(): number {
  return sessionRemovalGeneration;
}

// Decide whether re-adding `sessionId` would RESURRECT a session that was
// cleared/deleted while an async terminal block was in flight.
//
// Bails ONLY when BOTH:
//   (1) a clear/delete advanced the removal generation since the block started, AND
//   (2) the session is no longer "live" in summaries — i.e. it's absent from
//       sessionSummaries (cleared / hard-removed / emptied from trash) OR present
//       but soft-deleted (deletedAt set).
//
// A genuinely-new background session (e.g. MCP rebel_conversations_start) never
// triggers a clear/delete, so condition (1) is false and the add proceeds. Even
// if an UNRELATED session is deleted during a new session's async add, the new
// session is still present-and-not-deleted in summaries, so condition (2) is
// false and the add proceeds. Thus the guard fires only for true resurrection.
function wouldResurrectClearedSession(
  state: Pick<SessionStore, 'sessionSummaries'>,
  sessionId: string,
  capturedRemovalGeneration: number,
): boolean {
  if (getSessionRemovalGeneration() === capturedRemovalGeneration) {
    return false;
  }
  const existing = state.sessionSummaries.find((s) => s.id === sessionId);
  return existing == null || existing.deletedAt != null;
}

// ---------------------------------------------------------------------------
// Tombstone ledger / delete authority — id-based, by-construction protection
// against RESURRECTION of a removed/deleted session from ANY summary-insertion
// path.
// ---------------------------------------------------------------------------
// The generation guard above is a cheap in-flight invalidation check scoped to
// the processHistoryEvent terminal block. It is NOT sufficient on its own:
// other async paths can re-add a fully-formed summary after a removal —
//   (1) stale persistence saves (saveSessionAndUpdateSummary /
//       saveSessionByIdAndUpdateSummary) snapshot a session, await
//       persistenceManager.saveSession(), then call updateSessionSummary()
//       (add-if-missing). A save started before a clear/delete resolves after
//       and re-adds the prior session.
//   (2) disk→store reconciliation (setSessionSummaries via reloadSessionSummaries
//       / startup load) replaces the list with a disk snapshot captured before a
//       deletion, re-populating the removed id.
//   (3) cloud/automation ingest (ingestExternalSessions) re-adds a history row.
//   (4) approval-receipt appends (addReceiptMessageToSession) re-add or
//       un-delete the target session's row after its delete resolved.
//
// The ledger + the typed write classification now live in
// ./sessionDeleteAuthority.ts (postmortem 260607_tombstone_ledger_f1_f2):
// every producer path classifies its write via classifySessionSummaryWrite()
// BEFORE mutating and refuses the 'stale-write-after-delete' leg; removal /
// restore paths declare intent via recordSessionRemoval() / declareSoftDelete()
// / declareSessionRestore(). The enumeration harness
// (__tests__/sessionStore.deleteAuthority.harness.test.ts) pins every
// `sessionSummaries:` write site in this file to a `delete-authority:` marker
// so a new producer cannot silently bypass the seam.
//
// Generation guard sits UNDERNEATH this rule (kept as a cheap fast-path bail in
// processHistoryEvent); the delete authority is the authoritative line of
// defense.
//
// SCOPE: the ledger is RENDERER-ONLY. It prevents a removed session from
// re-entering the sidebar / renderer summary state from any async path. It does
// NOT stop an already-started `sessions:upsert` from writing an old session
// back to DISK after a real delete (persistenceManager.saveSession ->
// src/main/ipc/sessionsHandlers.ts upsert handler).
// FOLLOW-UP (main-side delete-wins, GPT review F3 / Chief question): add a
// main-process delete tombstone or compare-and-merge rule so a stale upsert
// cannot rewrite a hard-deleted (or newer soft-deleted) session to disk after
// deletion. That is a separate, deeper hardening tracked for the Chief; it is
// intentionally NOT implemented here.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SUMMARY_UPDATED_AT_THROTTLE_MS — minimum interval between summary.updatedAt
// bumps for a session that's already marked busy with the same turn.
//
// Background: processHistoryEvent originally SKIPPED summary updates entirely
// for redundant non-terminal events on already-busy sessions (perf optimization
// to avoid sessionSummaries array-ref churn → App.tsx re-renders). But that
// caused summary metadata (`updatedAt` / `lastActivityAt`) to freeze on long
// background turns, which in turn could misclassify staleness in the
// events-absent sidebar tier.
//
// Throttling (rather than skipping) lets metadata advance often enough while
// still avoiding per-event re-renders. 30s is rare enough that re-render cost
// is negligible (max ~2/min per active background session).
// ---------------------------------------------------------------------------
const SUMMARY_UPDATED_AT_THROTTLE_MS = 30_000;

function bumpHistoryRevision(sessionId: string): number {
  const next = (historyEventRevision.get(sessionId) ?? 0) + 1;
  historyEventRevision.set(sessionId, next);
  return next;
}

function getHistoryRevision(sessionId: string): number {
  return historyEventRevision.get(sessionId) ?? 0;
}

// Behavior-preserving Stage 8: the shadow-busy reflip dev-assertion probes
// (shadowBusyReflipWarningKeys Set, isTerminalTurnEvent, maybeWarnShadowBusyReflip,
// maybeAssertShadowBusyReflipForCurrentSession/ForLoadedSessions,
// __resetShadowBusyReflipWarningsForTest) now live in ./shadowBusyProbes. See the
// import + re-export blocks near the top of this file.

// Behavior-preserving Stage 7: the memory-leak / byte-attribution diagnostics
// (estimateValueBytes, measureEventPayloadBytes, getCheapLeakCounters,
// getLeakDiagnostics, getToolArchiveDiagnostics, getLoadedSessionsPayloadDiagnostics,
// getSessionSummariesPayloadDiagnostics, getStateMapsByteDiagnostics) now live in
// ./leakDiagnostics. See the re-export block near the top of this file.

/**
 * Strip eventsByTurn from a ConversationStateShape result.
 * Used by store actions that call conversation reducers — prevents writing
 * the discarded eventsByTurn back into Zustand state.
 */
const extractConversationFields = (result: ConversationStateShape) => {
  const { eventsByTurn: _discard, ...fields } = result;
  return fields;
};

let sessionCounter = 1;

export const createSessionStore = () => {
  const store = create<SessionStore>()(
    devtools(
      subscribeWithSelector((set, get) => ({
        ...createInitialState(),

        processEvent: (turnId, event, eventSessionId) => {
          // Stage 19a: fail-closed cross-session guard on the foreground live
          // append (W2/W3). The engine routes this turn to the foreground
          // (`sessionId === activeSessionId`), but `resolveSessionId` can
          // mis-attribute a turn whose session is unknown to the foreground —
          // so a foreign event can still reach here. We validate the event's
          // authoritative provenance (`eventSessionId` envelope, falling back
          // to `event.sessionId`) against the current foreground session and
          // DROP + telemeter a foreign one before it lands in the shared Map.
          // The validator never throws; a dropped foreign event still must
          // not run the reducer below (it would mutate foreground state).
          const currentSessionId = get().currentSessionId;
          if (
            currentSessionId &&
            shouldDropForeignIngressEvent(turnId, event, {
              scope: beginValidatedSessionWrite(currentSessionId, 'ipc-agent-event'),
              eventSessionId,
            })
          ) {
            return;
          }

          // For terminal events (result/error) the shared reducer needs the
          // events that arrived BEFORE this terminal so it can run trajectory
          // recovery (`mergeErrorMessage` Tier 3) and question-pause detection
          // (`mergeResultMessage`). Snapshot here BEFORE the in-place append
          // bumps the live array. For non-terminal events, eventsByTurn stays
          // `{}` — the live path already uses `terminatedTurnIds` for the
          // post-terminal isBusy guard, so the eventsForTurn scan is unused.
          // See docs/plans/260503_turn_error_trajectory_preservation.md (F6).
          const isTerminalEvent = event.type === 'result' || event.type === 'error';
          const priorTurnEventsForReducer: AgentEvent[] | undefined = isTerminalEvent
            ? [...getCurrentSessionEventsForTurn(turnId)]
            : undefined;

          // Write to external Map first (O(1) amortized, no Zustand spread).
          // Validation already ran above (it would be redundant to re-run it
          // inside the append), so we pass no provenance here.
          appendEventToCurrentSession(turnId, event);

          set((state) => {
            // Pass the snapshotted prior events for terminals; empty for the
            // common path. `extractConversationFields` discards eventsByTurn
            // after the reducer runs, so no leak into Zustand state.
            const nextConversation = conversationReducer.processEvent(
              {
                messages: state.messages,
                eventsByTurn: priorTurnEventsForReducer
                  ? { [turnId]: priorTurnEventsForReducer }
                  : {},
                activeTurnId: state.activeTurnId,
                focusedTurnId: state.focusedTurnId,
                isBusy: state.isBusy,
                lastError: state.lastError,
                lastErrorSource: state.lastErrorSource,
                terminatedTurnIds: state.terminatedTurnIds ?? new Set(),
              },
              turnId,
              event,
            );
            const nextRuntime = runtimeReducer.processEvent(
              state.runtime,
              turnId,
              event,
            );

            // Mark session as resolved when turn completes
            const isTerminalEvent =
              event.type === "result" || event.type === "error";
            const currentSessionResolvedAt = isTerminalEvent
              ? event.timestamp
              : state.currentSessionResolvedAt;

            // Belt-and-braces: clear the safety-eval subline when a tool ends.
            // Normally the main-process `-complete` broadcast fires first, but
            // on event-drop edge cases (flaky IPC, process restart race) the
            // `tool` end event still gives us a reliable cleanup point keyed
            // by the same toolUseId.
            let nextSafetyEvalInFlight = state.safetyEvalInFlight;
            if (event.type === 'tool' && event.stage === 'end' && event.toolUseId && state.safetyEvalInFlight[event.toolUseId]) {
              const { [event.toolUseId]: _discard, ...rest } = state.safetyEvalInFlight;
              nextSafetyEvalInFlight = rest;
            }

            return {
              ...extractConversationFields(nextConversation),
              runtime: nextRuntime,
              showConversation: true,
              currentSessionResolvedAt,
              safetyEvalInFlight: nextSafetyEvalInFlight,
            };
          });
        },

        addUserMessage: (text, attachments, options) => {
          const sessionId = get().currentSessionId;
          const { state: nextConversation, message } =
            conversationReducer.addUserMessage(
              {
                messages: get().messages,
                eventsByTurn: {},
                activeTurnId: get().activeTurnId,
                focusedTurnId: get().focusedTurnId,
                isBusy: get().isBusy,
                lastError: get().lastError,
                lastErrorSource: get().lastErrorSource,
                terminatedTurnIds: get().terminatedTurnIds ?? new Set(),
              },
              text,
              attachments,
              options,
            );

          // Bump events version to force a fresh eventsByTurn snapshot.
          // addUserMessage doesn't add events, but the version bump ensures
          // downstream consumers (useTurnData, TurnStepsInline) see consistent
          // state during queue drain — where the previous turn's result event
          // may still be in the deferred pipeline. Stage 5: schedules a
          // microtask-coalesced Zustand notification.
          bumpVersion();

          // Stage 5 (F9 boundary flush): drain the pending notification before
          // queue drain so persistence subscribers see the trailing-edge counter
          // before this user message kicks off a new turn.
          flushPendingEventsVersionNotification();

          // Atomically update conversation state AND clear draft for this session
          set((state) => ({
            ...extractConversationFields(nextConversation),
            currentSessionResolvedAt: null,
            // Clear draft atomically when user sends a message
            draftsBySessionId: omit(state.draftsBySessionId, sessionId),
          }));

          return message;
        },

        addReceiptMessage: (text) => {
          set((state) => {
            const nextConversation = conversationReducer.addReceiptMessage(
              {
                messages: state.messages,
                eventsByTurn: {},
                activeTurnId: state.activeTurnId,
                focusedTurnId: state.focusedTurnId,
                isBusy: state.isBusy,
                lastError: state.lastError,
                lastErrorSource: state.lastErrorSource,
                terminatedTurnIds: state.terminatedTurnIds ?? new Set(),
              },
              text,
            );
            return extractConversationFields(nextConversation);
          });
        },

        addReceiptMessageToSession: async (sessionId, text) => {
          if (!sessionId) return false;

          if (sessionId === get().currentSessionId) {
            get().addReceiptMessage(text);
            return true;
          }


          const receipt: AgentTurnMessage = {
            id: createId(),
            turnId: createId(),
            role: "assistant",
            text,
            createdAt: Date.now(),
            isApprovalReceipt: true,
          };

          try {
            const cachedSession = get().loadedSessions.get(sessionId);
            const loadedSession = cachedSession
              ?? ((await window.sessionsApi.get({ id: sessionId })) as AgentSessionWithRuntime | null);

            if (sessionId === get().currentSessionId) {
              get().addReceiptMessage(text);
              return true;
            }

            if (!loadedSession) {
              console.warn("[sessionStore] Could not add receipt to missing session", {
                sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
              });
              return false;
            }

            // DELETE AUTHORITY: an approval receipt that lands after the target
            // session was deleted/trashed must not re-create or un-delete its
            // summary row (or rewrite the session to disk). This path was the
            // last add-if-missing producer that bypassed the tombstone ledger —
            // classify AFTER the async load (so a delete that landed while we
            // awaited still wins) and BEFORE mutating.
            const receiptExistingRow = get().sessionSummaries.find(
              (s) => s.id === sessionId,
            );
            const receiptDecision = classifySessionSummaryWrite({
              sessionId,
              hasExistingRow: receiptExistingRow !== undefined,
              existingRowDeletedAt: receiptExistingRow?.deletedAt ?? null,
            });
            if (receiptDecision.kind === 'stale-write-after-delete') {
              console.warn(
                '[sessionStore] Dropping approval receipt for removed session',
                { sessionIdHash: hashSessionIdForBreadcrumb(sessionId) },
              );
              return false;
            }

            const updatedSession: AgentSessionWithRuntime = {
              ...loadedSession,
              messages: [...(loadedSession.messages ?? []), receipt],
              updatedAt: Math.max(
                loadedSession.updatedAt ?? loadedSession.createdAt,
                receipt.createdAt,
              ),
            };
            const updatedSummary = createSummaryFromSession(updatedSession);

            set((state) => {
              const nextLoadedSessions = state.loadedSessions.has(sessionId)
                ? new Map(state.loadedSessions).set(sessionId, updatedSession)
                : state.loadedSessions;
              const hasSummary = state.sessionSummaries.some((summary) => summary.id === sessionId);
              const nextSummaries = hasSummary
                ? state.sessionSummaries.map((summary) =>
                    summary.id === sessionId ? updatedSummary : summary,
                  )
                : [updatedSummary, ...state.sessionSummaries];

              return {
                loadedSessions: nextLoadedSessions,
                // delete-authority: classified (classifySessionSummaryWrite above)
                sessionSummaries: nextSummaries,
              };
            });

            const result = await window.sessionsApi.upsert(asIpcSession(stripRuntime(updatedSession)));
            if (!result.success) {
              console.warn("[sessionStore] Failed to persist approval receipt", {
                sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
                error: result.error,
              });
              return false;
            }

            return true;
          } catch (err) {
            console.warn("[sessionStore] Failed to add approval receipt", {
              sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
              error: err instanceof Error ? err.message : String(err),
            });
            return false;
          }
        },

        assignTurnToMessage: (messageId, turnId, startedAt) => {
          initCurrentSessionEventTurn(turnId);
          set((state) => {
            const nextConversation = conversationReducer.assignTurnIdToMessage(
              {
                messages: state.messages,
                eventsByTurn: {},
                activeTurnId: state.activeTurnId,
                focusedTurnId: state.focusedTurnId,
                isBusy: state.isBusy,
                lastError: state.lastError,
                lastErrorSource: state.lastErrorSource,
                terminatedTurnIds: state.terminatedTurnIds ?? new Set(),
              },
              messageId,
              turnId,
            );
            const nextRuntime = runtimeReducer.primeTurn(turnId, startedAt);

            return {
              ...extractConversationFields(nextConversation),
              runtime: nextRuntime,
            };
          });
        },

        truncateToMessage: (targetMessageId, newText, attachments) => {
          cancelPendingThinkingDeltas();
          // Phase 6.5 remediation: drain pending notification before the
          // truncate boundary so persistence subscribers observe the
          // trailing-edge counter for the pre-truncate events before the
          // external Map is rewritten with the truncated set.
          flushPendingEventsVersionNotification();
          set((state) => {
            // Read events inside set() to ensure consistency with state snapshot
            const eventsForTruncate = getCurrentSessionEvents();
            const nextConversation = conversationReducer.truncateToMessage(
              {
                messages: state.messages,
                eventsByTurn: eventsForTruncate,
                activeTurnId: state.activeTurnId,
                focusedTurnId: state.focusedTurnId,
                isBusy: state.isBusy,
                lastError: state.lastError,
                lastErrorSource: state.lastErrorSource,
                terminatedTurnIds: state.terminatedTurnIds ?? new Set(),
              },
              targetMessageId,
              newText,
              attachments,
            );

            // Sync filtered events back to external Map
            setCurrentSessionEvents(nextConversation.eventsByTurn);

            // Filter out compaction boundaries that are now past the truncation point
            const newMessageCount = nextConversation.messages.length;
            const filteredBoundaries = state.compactionBoundaries.filter(
              (boundary) => boundary.afterMessageIndex < newMessageCount - 1,
            );
            const survivingMessageIds = new Set(
              nextConversation.messages.map((message) => message.id),
            );
            const currentAnnotations =
              state.annotationsBySessionId[state.currentSessionId] ?? [];
            const filteredAnnotations = currentAnnotations.filter((annotation) =>
              survivingMessageIds.has(annotation.messageId),
            );
            const nextAnnotationsBySessionId = filteredAnnotations.length > 0
              ? {
                  ...state.annotationsBySessionId,
                  [state.currentSessionId]: filteredAnnotations,
                }
              : omit(state.annotationsBySessionId, state.currentSessionId);

            return {
              ...extractConversationFields(nextConversation),
              runtime: runtimeReducer.resetRuntime(),
              currentSessionResolvedAt: null,
              // Phase 6.5 remediation: pair the post-truncate visible state
              // with the trailing-edge counter so subscribers see the
              // truncated messages and the new eventsByTurnVersion in the
              // same Zustand notification.
              eventsByTurnVersion: getCurrentSessionEventsVersion(),
              compactionBoundaries: filteredBoundaries,
              // Clear streaming state to prevent stale buffers after truncation
              thinkingTextByTurn: {},
              // Clear draft atomically when message is edited & re-run (same as addUserMessage)
              draftsBySessionId: omit(
                state.draftsBySessionId,
                state.currentSessionId,
              ),
              annotationsBySessionId: nextAnnotationsBySessionId,
            };
          });
          // Phase 6.5 remediation: drain the just-scheduled microtask so a
          // redundant setState does not fire after the atomic boundary.
          flushPendingEventsVersionNotification();
        },

        setError: (error) => {
          set((state) => ({
            ...extractConversationFields(
              conversationReducer.setError(
                {
                  messages: state.messages,
                  eventsByTurn: {},
                  activeTurnId: state.activeTurnId,
                  focusedTurnId: state.focusedTurnId,
                  isBusy: state.isBusy,
                  lastError: state.lastError,
                  lastErrorSource: state.lastErrorSource,
                  terminatedTurnIds: state.terminatedTurnIds ?? new Set(),
                },
                error,
              ),
            ),
            runtime: error ? runtimeReducer.resetRuntime() : state.runtime,
          }));
        },

        clearBusy: () => {
          removeAllRendererOptimisticTurnStartedEvents();
          set(() => ({
            runtime: runtimeReducer.resetRuntime(),
          }));
        },

        setFocusedTurnId: (turnId) => {
          set((state) => {
            if (state.focusedTurnId === turnId) {
              return {};
            }
            return { focusedTurnId: turnId };
          });
        },

        setIsStopping: (value) => set({ isStopping: value }),
        setShowConversation: (value) => set({ showConversation: value }),
        setEditingMessageId: (id) => set({ editingMessageId: id }),
        setPrivateMode: (value) => set({ privateMode: value }),
        setCouncilMode: (value) => set({ councilMode: value }),
        setFinishLine: (value) => {
          const normalized = value === null ? null : (normalizeFinishLine(value) ?? null);
          const state = get();
          if (state.currentSessionFinishLine === normalized) {
            return;
          }
          set({ currentSessionFinishLine: normalized });
          void (async () => {
            const snapshot = get().snapshotCurrentSession();
            if (!snapshot) return;
            try {
              const result = await window.sessionsApi.upsert(
                asIpcSession(stripRuntime(snapshot)),
              );
              if (result && !result.success) {
                console.warn(
                  `[sessionStore] finishLine persist failed for ${snapshot.id}`,
                  result?.error,
                );
              }
            } catch (err) {
              console.warn(
                `[sessionStore] finishLine persist rejected for ${state.currentSessionId}`,
                err,
              );
            }
          })();
        },
        setSessionModelOverrides: (overrides) =>
          set({
            sessionWorkingModel: overrides.workingModel,
            sessionThinkingModel: overrides.thinkingModel,
            sessionWorkingProfileId: overrides.workingProfileId,
            sessionThinkingProfileId: overrides.thinkingProfileId,
            sessionThinkingEffort: overrides.thinkingEffort,
          }),
        // FOX-3494 (round-2 M2): clear session model/thinking overrides and
        // persist, so a "Switch to GPT" recovery can't be undone by a stale
        // session-level Claude selection. Thinking effort is left untouched (it
        // is provider-agnostic and not part of the Claude-under-codex loop).
        clearSessionModelOverridesForRecovery: () => {
          const state = get();
          const alreadyClear =
            state.sessionWorkingModel === undefined &&
            state.sessionThinkingModel === undefined &&
            state.sessionWorkingProfileId === undefined &&
            state.sessionThinkingProfileId === undefined;
          if (alreadyClear) return;
          set({
            sessionWorkingModel: undefined,
            sessionThinkingModel: undefined,
            sessionWorkingProfileId: undefined,
            sessionThinkingProfileId: undefined,
          });
          void (async () => {
            const snapshot = get().snapshotCurrentSession();
            if (!snapshot) return;
            try {
              const result = await window.sessionsApi.upsert(
                asIpcSession(stripRuntime(snapshot)),
              );
              if (result && !result.success) {
                console.warn(
                  `[sessionStore] session-override clear persist failed for ${snapshot.id}`,
                  result?.error,
                );
              }
            } catch (err) {
              ignoreBestEffortCleanup(err, {
                operation: 'sessionStore.clearSessionModelOverridesForRecovery.persist',
                reason:
                  'Best-effort persist of the recovery session-override clear; on failure the in-memory clear still applies for the immediate retry and the session rehydrates from disk on next load, so the user can re-trigger the Switch-to-GPT recovery',
              });
            }
          })();
        },
        setAutoDoneEnabled: (value) => {
          const state = get();
          set({
            autoDoneEnabled: value,
            // Also store in per-session map so it survives session switches
            autoDoneBySessionId: {
              ...state.autoDoneBySessionId,
              [state.currentSessionId]: value,
            },
          });
        },
        setShowAllChecks: (value) => {
          const state = get();
          if (state.currentSessionMeetingCompanion?.coach) {
            set({
              currentSessionMeetingCompanion: {
                ...state.currentSessionMeetingCompanion,
                coach: {
                  ...state.currentSessionMeetingCompanion.coach,
                  showAllChecks: value,
                },
              },
            });
          }
        },

        setMeetingCompanion: (meta) => {
          set({ currentSessionMeetingCompanion: meta });
        },

        setMeetingCompanionCoach: (coach) => {
          const state = get();
          if (state.currentSessionMeetingCompanion) {
            set({
              currentSessionMeetingCompanion: {
                ...state.currentSessionMeetingCompanion,
                coach: coach ?? undefined,
              },
            });
          }
        },

        setSetupContext: (context) => {
          set({ currentSessionSetupContext: context });
        },

        setSetupContextForSession: (sessionId, context) => {
          const state = get();

          if (sessionId === state.currentSessionId) {
            // It's the active session, just use the existing state field
            if (state.currentSessionSetupContext !== context) {
              set({ currentSessionSetupContext: context });
            }
            return;
          }

          // Background session
          const normalized = context ?? undefined;
          const loadedSession = state.loadedSessions.get(sessionId);
          if (loadedSession && loadedSession.setupContext === normalized) {
            return; // Idempotent
          }

          // Use the async persistence helper for background sessions.
          // `Partial<AgentSession>` narrows setupContext to `AgentSession['setupContext']`,
          // which is optional-but-not-nullable, so map `null` → `undefined`.
          void persistNonCurrentSessionMetadata(
            sessionId,
            { setupContext: normalized },
            get,
            set
          );
        },

        setSetupContextPairSessionId: (pairSessionId) => {
          const state = get();
          if (state.currentSessionSetupContext?.kind !== "bundled-app-bridge") {
            return;
          }
          set({
            currentSessionSetupContext: {
              ...state.currentSessionSetupContext,
              pairSessionId,
            },
          });
        },

        resetSession: () => {
          cancelPendingThinkingDeltas();
          // Stage 5 (F9 boundary flush): drain pending notification before
          // snapshotting so persistence subscribers see the trailing-edge
          // counter before the external Map is cleared for the next session.
          flushPendingEventsVersionNotification();
          const state = get();
          invalidateMcpAppConversationNonces(state.currentSessionId);
          useRouteLabelCacheStore.getState().clearForSession(state.currentSessionId);
          const snapshot = get().snapshotCurrentSession();
          // Clear external Map AFTER snapshot captures events
          clearCurrentSessionEvents();

          if (snapshot) {
            // Stage 9: Use addOrUpdateHistorySession which now only updates sessionSummaries
            state.addOrUpdateHistorySession(snapshot, true);
            sessionCounter += 1;
          }

          const nextSessionId = createId();
          const creationTimestamp = Date.now();

          // Clean up old draft-only sessions that exceed the limit
          // This runs AFTER snapshotting the current session but BEFORE setting up the new session
          // Stage 9: Use sessionSummaries instead of agentSessions
          const afterSnapshot = get();
          const idsToCleanup = getDraftOnlySessionsToCleanup(
            afterSnapshot.sessionSummaries,
            nextSessionId, // Use new session ID as "current" since we're about to switch
            MAX_DRAFT_ONLY_SESSIONS,
          );

          // Remove old draft-only sessions from summaries and clean up drafts
          let cleanedSummaries = afterSnapshot.sessionSummaries;
          let cleanedDrafts = afterSnapshot.draftsBySessionId;
          let cleanedAnnotations = afterSnapshot.annotationsBySessionId;
          for (const idToDelete of idsToCleanup) {
            cleanedSummaries = cleanedSummaries.filter(
              (s) => s.id !== idToDelete,
            );
            cleanedDrafts = omit(cleanedDrafts, idToDelete);
            cleanedAnnotations = omit(cleanedAnnotations, idToDelete);
          }

          // Prune autoDoneBySessionId for sessions no longer in summaries.
          // Keep entries for loaded sessions (may have active background turns)
          // and for the new session being created.
          const validAutoDoneIds = new Set(cleanedSummaries.map(s => s.id));
          for (const id of afterSnapshot.loadedSessions.keys()) validAutoDoneIds.add(id);
          validAutoDoneIds.add(nextSessionId);
          const prunedAutoDone: Record<string, boolean> = {};
          for (const [id, val] of Object.entries(afterSnapshot.autoDoneBySessionId)) {
            if (validAutoDoneIds.has(id)) prunedAutoDone[id] = val;
          }

          set({
            ...extractConversationFields(
              conversationReducer.resetConversation(),
            ),
            runtime: runtimeReducer.resetRuntime(),
            // Phase 6 remediation: include the trailing-edge counter so
            // resetConversation's empty messages/eventsByTurn and the
            // post-clearCurrentSessionEvents version land on subscribers in
            // the same Zustand notification rather than racing the
            // microtask scheduled by the upstream bumpVersion().
            eventsByTurnVersion: getCurrentSessionEventsVersion(),
            currentSessionId: nextSessionId,
            currentSessionTitle: "New Agent Run",
            currentSessionOrigin: "manual",
            currentSessionResolvedAt: null,
            currentSessionDoneAt: null,
            currentSessionStarredAt: null,
            privateMode: false,
            councilMode: false,
            sessionWorkingModel: undefined,
            sessionThinkingModel: undefined,
            sessionWorkingProfileId: undefined,
            sessionThinkingProfileId: undefined,
            sessionThinkingEffort: undefined,
            autoDoneEnabled: false,
            currentSessionCreatedAt: creationTimestamp,
            currentSessionMeetingCompanion: null,
            currentSessionSetupContext: null,
            currentSessionFinishLine: null,
            isStopping: false,
            editingMessageId: null,
            memoryUpdateStatusByTurn: {},
            timeSavedStatusByTurn: {},
            activitySummaryByTurn: {},
            compactionBoundaries: [],
            // Clear streaming buffer on session reset (prevent stale data across sessions)
            thinkingTextByTurn: {},
            // Stage 9: Apply cleanup to sessionSummaries (not agentSessions)
            // delete-authority: exempt — draft-only session cleanup removes sidebar rows WITHOUT tombstoning: these sessions remain on disk (no sessions:delete here), so disk reconcile stays their source of truth; tombstoning would orphan the disk rows until restart
            sessionSummaries: cleanedSummaries,
            draftsBySessionId: cleanedDrafts,
            annotationsBySessionId: cleanedAnnotations,
            autoDoneBySessionId: prunedAutoDone,
          });
          // Phase 6 remediation: drain the just-scheduled microtask so it
          // does not fire a redundant setState after this atomic boundary.
          flushPendingEventsVersionNotification();

          return nextSessionId;
        },

        clearAllSessionsForE2E: (deletedSessionIds) => {
          cancelPendingThinkingDeltas();
          flushPendingEventsVersionNotification();
          clearCurrentSessionEvents();
          if (typeof localStorage !== 'undefined') {
            clearAllPersistedRetries(localStorage);
          }
          historyEventRevision.clear();
          // RESURRECTION GUARD: advance the removal generation so any in-flight
          // processHistoryEvent terminal re-add bails instead of resurrecting a
          // just-cleared session.
          bumpSessionRemovalGeneration();
          // TOMBSTONE LEDGER: tombstone every id the main process deleted from
          // disk (passed from the e2e:clear-all-sessions IPC) PLUS every id
          // currently in summaries. A stale save / disk-list reconciliation
          // started before this clear can resolve afterwards carrying a
          // fully-formed prior summary; tombstoning the full deleted set makes
          // any such late re-add a no-op by construction. Disk-deleted ids may
          // exceed the currently-visible summaries (internal/background sessions),
          // hence taking the explicit set rather than only summaries.
          //
          // F1 (GPT review): ALSO tombstone the CURRENT in-memory session id and
          // every loaded-session id BEFORE we replace those maps. A current
          // session can hold meaningful content with a pending
          // saveSessionAndUpdateSummary() snapshot before it has ever been added
          // to sessionSummaries or written to disk. In that case the main process
          // returns no deletedId for it and it is absent from summaries, so
          // neither set above tombstones it — and the pending save can resolve
          // after this clear and call updateSessionSummary(), RESURRECTING the
          // prior test's current session into the freshly-cleared sidebar. This
          // is the positional E2E failure (the 2nd session-creating Draft test).
          // Tombstoning currentSessionId + loadedSessions.keys() closes it by
          // construction. (The new post-clear currentSessionId is a fresh createId
          // below, never tombstoned, so the new blank session is unaffected.)
          {
            const clearState = get();
            recordSessionRemoval(
              'e2e-clear',
              clearState.sessionSummaries.map((s) => s.id),
            );
            if (clearState.currentSessionId) {
              recordSessionRemoval('e2e-clear', [clearState.currentSessionId]);
            }
            recordSessionRemoval('e2e-clear', clearState.loadedSessions.keys());
          }
          if (deletedSessionIds) {
            recordSessionRemoval('e2e-clear', deletedSessionIds);
          }
          useRouteLabelCacheStore.getState().clearAll();

          const nextSessionId = createId();
          const now = Date.now();

          set({
            ...extractConversationFields(
              conversationReducer.resetConversation(),
            ),
            runtime: runtimeReducer.resetRuntime(),
            eventsByTurnVersion: getCurrentSessionEventsVersion(),
            currentSessionId: nextSessionId,
            currentSessionTitle: "New Agent Run",
            currentSessionOrigin: "manual",
            currentSessionResolvedAt: null,
            currentSessionDoneAt: null,
            currentSessionStarredAt: null,
            privateMode: false,
            councilMode: false,
            sessionWorkingModel: undefined,
            sessionThinkingModel: undefined,
            sessionWorkingProfileId: undefined,
            sessionThinkingProfileId: undefined,
            sessionThinkingEffort: undefined,
            autoDoneEnabled: false,
            currentSessionCreatedAt: now,
            currentSessionMeetingCompanion: null,
            currentSessionSetupContext: null,
            currentSessionFinishLine: null,
            isStopping: false,
            editingMessageId: null,
            isLoadingSession: false,
            loadingSessionId: null,
            // delete-authority: removal (recordSessionRemoval 'e2e-clear' above)
            sessionSummaries: [],
            loadedSessions: new Map(),
            memoryUpdateStatusByTurn: {},
            timeSavedStatusByTurn: {},
            activitySummaryByTurn: {},
            compaction: createInitialCompactionState(),
            compactionBoundaries: [],
            draftsBySessionId: {},
            annotationsBySessionId: {},
            pendingQuestionEventsBySessionId: {},
            dismissedQuestionBatchIdsBySessionId: {},
            pendingRecordingSessionIds: new Set(),
            thinkingTextByTurn: {},
            answerStreamingTurnIds: new Set(),
            doneAfterTurnIds: new Set(),
            roleNotConfiguredToastKeys: new Set(),
            autoDoneBySessionId: {},
            pendingNetworkRetryTurns: {},
            isResuming: false,
            resumeModalSnoozed: false,
            safetyEvalInFlight: {},
          });
          flushPendingEventsVersionNotification();

          return nextSessionId;
        },

        createBackgroundSession: (sessionId, origin = "manual", externalContext, options) => {
          const state = get();
          const systemPromptPrefix = options?.systemPromptPrefix?.trim() || undefined;
          if (state.currentSessionId === sessionId) {
            return;
          }
          const existingSummary = state.sessionSummaries.find((s) => s.id === sessionId);
          if (existingSummary) {
            const shouldUpgradeOrigin = existingSummary.origin === 'manual' && origin !== 'manual';
            if (shouldUpgradeOrigin) {
              state.updateSessionSummary({
                ...existingSummary,
                origin,
              });

              const loadedSession = state.loadedSessions.get(sessionId);
              if (
                loadedSession
                && (
                  loadedSession.origin !== origin
                  || (externalContext && !loadedSession.externalContext)
                  || (systemPromptPrefix && !loadedSession.systemPromptPrefix)
                )
              ) {
                state.cacheSession({
                  ...loadedSession,
                  origin,
                  ...(externalContext ? { externalContext } : {}),
                  ...(systemPromptPrefix ? { systemPromptPrefix } : {}),
                });
                state.persistLoadedSession(sessionId);
              }
            }
            return;
          }
          const now = Date.now();
          const session: AgentSessionWithRuntime = {
            id: sessionId,
            title: "New Agent Run",
            createdAt: now,
            updatedAt: now,
            messages: [],
            eventsByTurn: {},
            activeTurnId: null,
            isBusy: false,
            lastError: null,
            resolvedAt: null,
            // New session is Active (doneAt null = Active).
            doneAt: null,
            starredAt: null,
            origin,
            ...(externalContext ? { externalContext } : {}),
            ...(systemPromptPrefix ? { systemPromptPrefix } : {}),
            runtime: runtimeReducer.resetRuntime(),
            memoryUpdateStatusByTurn: {},
            timeSavedStatusByTurn: {},
            activitySummaryByTurn: {},
            compactionBoundaries: [],
            privateMode: false,
          };
          state.addOrUpdateHistorySession(session, true);
          state.cacheSession(session);
        },

        clearSystemPromptPrefixForSession: (sessionId) => {
          const state = get();
          const loadedSession = state.loadedSessions.get(sessionId);
          if (loadedSession?.systemPromptPrefix) {
            const { systemPromptPrefix: _drop, ...rest } = loadedSession;
            state.cacheSession(rest as AgentSessionWithRuntime);
          }
          if (sessionId === state.currentSessionId) {
            const snapshot = state.snapshotCurrentSession();
            if (snapshot?.systemPromptPrefix) {
              const { systemPromptPrefix: _drop, ...rest } = snapshot;
              state.cacheSession(rest as AgentSessionWithRuntime);
            }
          }
        },

        snapshotCurrentSession: () => {
          // Stage 5 (F9 boundary flush): persistence-read boundary. Drain any
          // pending Zustand notification before composing the snapshot so the
          // version field on the resulting snapshot (and any concurrent
          // persistence subscriber) observes the trailing-edge counter for
          // the events being captured.
          flushPendingEventsVersionNotification();
          const state = get();
          const currentDraft = state.draftsBySessionId[state.currentSessionId];
          const currentAnnotations =
            state.annotationsBySessionId[state.currentSessionId] ?? [];
          const hasDraft = Boolean(currentDraft?.text?.trim());
          const hasAnnotations = currentAnnotations.length > 0;
          const hasMessages = state.messages.length > 0;
          const hasEvents = hasCurrentSessionEvents();
          const hasPendingRecording = state.pendingRecordingSessionIds.has(
            state.currentSessionId,
          );

          // Allow snapshot if ANY content exists (messages, events, draft, annotations, OR pending voice recording)
          if (!hasMessages && !hasEvents && !hasDraft && !hasAnnotations && !hasPendingRecording) {
            return null;
          }

          const snapshotMessages = state.messages;

          // Use stable currentSessionCreatedAt for empty sessions to prevent timestamp drift
          const createdAt =
            snapshotMessages[0]?.createdAt ?? state.currentSessionCreatedAt;

          // Fix updatedAt for draft-only sessions: use latest of lastMessage, draft, or creation time
          const lastMessageAt =
            snapshotMessages[snapshotMessages.length - 1]?.createdAt;
          const draftUpdatedAt = currentDraft?.updatedAt;
          const latestAnnotationCreatedAt = hasAnnotations
            ? Math.max(...currentAnnotations.map((annotation) => annotation.createdAt))
            : 0;
          const updatedAt = Math.max(
            lastMessageAt ?? createdAt,
            draftUpdatedAt ?? 0,
            latestAnnotationCreatedAt,
            createdAt,
          );

          // Preserve imageContent in snapshots so images render when revisiting sessions.
          // Image data is typically small (~100KB per image) and infrequent.
          const currentEvents = getCurrentSessionEventsForEgress();

          return {
            id: state.currentSessionId,
            title: state.currentSessionTitle,
            createdAt,
            updatedAt,
            messages: snapshotMessages,
            eventsByTurn: currentEvents,
            activeTurnId: state.activeTurnId,
            isBusy: state.isBusy,
            lastError: state.lastError,
            resolvedAt: state.currentSessionResolvedAt,
            // Canonical lifecycle field (non-null = Done).
            doneAt: state.currentSessionDoneAt,
            starredAt: state.currentSessionStarredAt,
            origin: state.currentSessionOrigin,
            runtime: runtimeReducer.cloneRuntimeState(state.runtime),
            memoryUpdateStatusByTurn: { ...state.memoryUpdateStatusByTurn },
            timeSavedStatusByTurn: { ...state.timeSavedStatusByTurn },
            activitySummaryByTurn: { ...state.activitySummaryByTurn },
            compactionBoundaries: [...state.compactionBoundaries],
            privateMode: state.privateMode,
            sessionWorkingModel: state.sessionWorkingModel,
            sessionThinkingModel: state.sessionThinkingModel,
            sessionWorkingProfileId: state.sessionWorkingProfileId,
            sessionThinkingProfileId: state.sessionThinkingProfileId,
            sessionThinkingEffort: state.sessionThinkingEffort,
            // Include draft in snapshot for persistence
            draft: currentDraft ? { ...currentDraft } : undefined,
            annotations: hasAnnotations ? [...currentAnnotations] : undefined,
            // Include meeting companion metadata for meeting-linked sessions
            meetingCompanion: state.currentSessionMeetingCompanion ?? undefined,
            setupContext: state.currentSessionSetupContext ?? undefined,
            finishLine: state.currentSessionFinishLine ?? undefined,
          };
        },

        processHistoryEvent: (sessionId, turnId, event, eventSessionId) => {
          // Stage 19a (W7 — history/background replay): the caller declares the
          // target `sessionId`, but nothing previously checked the event's own
          // provenance matched it. Drop + telemeter a foreign-stamped event
          // before it touches `loadedSessions` / buffers / disk persist for
          // the wrong session. Fail-closed; never throws.
          //
          // Stage 19c: thread the envelope `eventSessionId` provenance (the
          // engine's background routing sibling now passes it, mirroring the
          // foreground path). This is INDEPENDENT of the `sessionId` routing
          // target, so a foreign-routed event whose envelope origin disagrees
          // with the target is now REJECTED instead of falling to
          // `accepted-legacy`. When omitted, the validator falls back to the
          // event's own `sessionId` (legacy variants carry none → accepted).
          if (shouldDropForeignIngressEvent(turnId, event, {
            scope: beginValidatedSessionWrite(sessionId, 'history-replay'),
            eventSessionId,
          })) {
            return;
          }

          const state = get();
          const isTerminal = event.type === "result" || event.type === "error";

          // Bump revision on EVERY event — lets async terminal handlers detect stale writes
          bumpHistoryRevision(sessionId);

          if (event.type === 'user_question' || event.type === 'user_question_answered') {
            set((s) => ({
              pendingQuestionEventsBySessionId: updatePendingQuestionEventSnapshots(
                s.pendingQuestionEventsBySessionId,
                sessionId,
                turnId,
                event,
              ),
            }));
          }

          // Check if session is loaded in the LRU cache
          const loadedSession = state.loadedSessions.get(sessionId);

          if (loadedSession) {
            // LOADED SESSION: batch intermediate events, flush on terminal
            if (isTerminal) {
              // Terminal event: flush all buffered events + this one in a single update.
              // Load from disk to get full-fidelity events (LRU cache has compacted detail).
              const buffered = takeBackgroundEventBuffer(sessionId);
              const capturedRevision = getHistoryRevision(sessionId);
              // RESURRECTION GUARD: capture the removal generation at the START
              // of the async work. If a clear/delete path bumps it before the
              // re-add below, this stale block must NOT resurrect the session.
              const capturedRemovalGeneration = getSessionRemovalGeneration();
              void (async () => {
                try {
                  const diskSession = await window.sessionsApi.get({
                    id: sessionId,
                  });
                  let session: AgentSessionWithRuntime;
                  if (diskSession) {
                    // Merge messages: the LRU cache may contain recently-inserted messages
                    // (e.g., user message added by initiateAgentTurn's sessionChanged branch)
                    // that haven't been persisted to disk yet due to write/read race.
                    // Preserve cache messages that aren't in the disk version.
                    const diskMessageIds = new Set(
                      diskSession.messages.map((m) => m.id),
                    );
                    const cacheOnlyMessages = loadedSession.messages.filter(
                      (m) => !diskMessageIds.has(m.id),
                    );
                    const mergedMessages =
                      cacheOnlyMessages.length > 0
                        ? [...diskSession.messages, ...cacheOnlyMessages].sort(
                            (a, b) => a.createdAt - b.createdAt,
                          )
                        : diskSession.messages;
                    // Use live draft from draftsBySessionId, not the disk version.
                    // The disk read bypasses the write queue, so diskSession.draft
                    // can be stale (e.g., still present after addUserMessage cleared
                    // draftsBySessionId but the draft-clearing upsert hasn't flushed
                    // yet). Writing the stale draft back would create a persistent
                    // ghost draft that rehydrates on every session open.
                    const liveDraft = get().draftsBySessionId[sessionId];
                    const liveAnnotations = getLiveOrPersistedAnnotations(
                      get(),
                      sessionId,
                      diskSession,
                    );
                    session = {
                      ...diskSession,
                      draft: liveDraft ? { ...liveDraft } : undefined,
                      annotations:
                        liveAnnotations.length > 0 ? [...liveAnnotations] : undefined,
                      messages: mergedMessages,
                      runtime:
                        loadedSession.runtime ??
                        buildRuntimeFromSnapshot(
                          diskSession.activeTurnId ?? null,
                          diskSession.eventsByTurn,
                        ),
                    };
                  } else {
                    session = loadedSession;
                  }
                  const replayEvents: BufferedEvent[] = [
                    ...buffered,
                    { turnId, event },
                  ];
                  session = applyBufferedEventUnionToSession(session, replayEvents);
                  // Guard: skip cache/summary if a newer event has arrived.
                  // The disk persist always runs because takeBackgroundEventBuffer
                  // already consumed buffered events — skipping persist would lose
                  // terminal data. T2's handler will re-persist with correct metadata.
                  if (getHistoryRevision(sessionId) === capturedRevision) {
                    // RESURRECTION GUARD: if a clear/delete intervened and this
                    // session is gone/trashed, skip the cache + summary re-add so
                    // we don't resurrect it in the sidebar or LRU cache.
                    // (persist below still runs to avoid losing terminal data
                    // already consumed from the background event buffer; if the
                    // session was hard-deleted from disk the write is harmless.)
                    if (
                      !wouldResurrectClearedSession(
                        get(),
                        sessionId,
                        capturedRemovalGeneration,
                      )
                    ) {
                      get().cacheSession(session);
                      const newSummary = createSummaryFromSession(session);
                      get().updateSessionSummary(newSummary);
                    }
                  }
                  persistBufferedEventUnionForSession(sessionId, replayEvents);
                } catch {
                  // Fallback: use cached session (compacted but structurally complete)
                  // Override draft with live state (same rationale as primary path)
                  const fallbackDraft = get().draftsBySessionId[sessionId];
                  const fallbackAnnotations = getLiveOrPersistedAnnotations(
                    get(),
                    sessionId,
                    loadedSession,
                  );
                  let session: AgentSessionWithRuntime = {
                    ...loadedSession,
                    draft: fallbackDraft ? { ...fallbackDraft } : undefined,
                    annotations:
                      fallbackAnnotations.length > 0
                        ? [...fallbackAnnotations]
                        : undefined,
                  };
                  const replayEvents: BufferedEvent[] = [
                    ...buffered,
                    { turnId, event },
                  ];
                  session = applyBufferedEventUnionToSession(session, replayEvents);
                  // Guard: skip cache/summary if stale (same rationale as primary path)
                  if (getHistoryRevision(sessionId) === capturedRevision) {
                    // RESURRECTION GUARD: same rationale as primary path.
                    if (
                      !wouldResurrectClearedSession(
                        get(),
                        sessionId,
                        capturedRemovalGeneration,
                      )
                    ) {
                      get().cacheSession(session);
                      const newSummary = createSummaryFromSession(session);
                      get().updateSessionSummary(newSummary);
                    }
                  }
                  persistBufferedEventUnionForSession(sessionId, replayEvents);
                }
              })();
            } else {
              // Non-terminal: buffer the event with its turnId for correct attribution
              bufferBackgroundEvent(sessionId, turnId, event);

              const existingSummary = state.sessionSummaries.find(
                (s) => s.id === sessionId,
              );
              if (existingSummary) {
                // PERF: Throttle summary updates when the session is already busy with
                // this turn. The only field that would change is updatedAt, which triggers
                // a new sessionSummaries array ref → App.tsx re-render.
                //
                // We can't skip ENTIRELY (as a previous version did) because
                // summary metadata (`updatedAt`/`lastActivityAt`) still needs
                // periodic refreshes for staleness reconciliation in the
                // events-absent sidebar tier.
                // Throttling to one bump per SUMMARY_UPDATED_AT_THROTTLE_MS keeps the
                // staleness check honest while still avoiding per-event re-renders.
                // Math.max(0, ...) guards against future-dated updatedAt (e.g. clock
                // skew from cloud-synced summaries) which would otherwise throttle
                // indefinitely.
                const lastUpdate = existingSummary.updatedAt ?? 0;
                const sinceLastUpdate = Math.max(0, Date.now() - lastUpdate);
                if (
                  existingSummary.isBusy &&
                  existingSummary.activeTurnId === turnId &&
                  sinceLastUpdate < SUMMARY_UPDATED_AT_THROTTLE_MS
                ) {
                  return;
                }
                const newUpdatedAt = Date.now();
                const eventTimestamp =
                  typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
                    ? event.timestamp
                    : newUpdatedAt;
                const summaryUpdate: Partial<AgentSessionSummary> = {
                  updatedAt: newUpdatedAt,
                  lastActivityAt: eventTimestamp,
                };
                if (event.type === 'turn_started') {
                  summaryUpdate.activeTurnId = turnId;
                  summaryUpdate.isBusy = true;
                }
                state.updateSessionSummary({
                  ...existingSummary,
                  ...summaryUpdate,
                });
              }
            }
          } else {
            // NON-LOADED SESSION: Minimal summary update only
            const existingSummary = state.sessionSummaries.find(
              (s) => s.id === sessionId,
            );
            if (!existingSummary) return;

            // PERF: Throttle non-terminal updates on already-busy sessions
            // (same rationale and constant as the LOADED branch above — see comment there)
            const lastUpdate = existingSummary.updatedAt ?? 0;
            const sinceLastUpdate = Math.max(0, Date.now() - lastUpdate);
            if (
              !isTerminal &&
              existingSummary.isBusy &&
              existingSummary.activeTurnId === turnId &&
              sinceLastUpdate < SUMMARY_UPDATED_AT_THROTTLE_MS
            ) {
              return;
            }

            const newUpdatedAt = Date.now();
            const eventTimestamp =
              typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
                ? event.timestamp
                : newUpdatedAt;
            const summaryUpdate: Partial<AgentSessionSummary> = {
              updatedAt: newUpdatedAt,
              lastActivityAt: eventTimestamp,
            };

            if (event.type === 'turn_started') {
              summaryUpdate.activeTurnId = turnId;
              summaryUpdate.isBusy = true;
            }

            if (event.type === "result") {
              summaryUpdate.activeTurnId = null;
              summaryUpdate.isBusy = false;
            } else if (event.type === "error") {
              summaryUpdate.activeTurnId = null;
              summaryUpdate.isBusy = false;
              summaryUpdate.lastError = event.error ?? "Unknown error";
            }

            state.updateSessionSummary({
              ...existingSummary,
              ...summaryUpdate,
            });

            // CRITICAL: For terminal events on non-loaded sessions, load from disk,
            // apply buffered + terminal events, and persist back. Without this, the
            // result/error event is lost — the session file on disk stays stuck with
            // isBusy:true and no result message. This happens when the renderer reloads
            // (e.g. memory pressure) or the session is evicted from the LRU cache while
            // a background turn is still running.
            if (isTerminal) {
              const capturedRevision = getHistoryRevision(sessionId);
              // RESURRECTION GUARD: capture removal generation at async start.
              const capturedRemovalGeneration = getSessionRemovalGeneration();
              void (async () => {
                try {
                  const diskSession = await window.sessionsApi.get({
                    id: sessionId,
                  });
                  if (!diskSession) return;

                  const buffered = takeBackgroundEventBuffer(sessionId);
                  const liveAnnotations = getLiveOrPersistedAnnotations(
                    get(),
                    sessionId,
                    diskSession,
                  );
                  let updated: AgentSessionWithRuntime = {
                    ...diskSession,
                    annotations:
                      liveAnnotations.length > 0 ? [...liveAnnotations] : undefined,
                    runtime: buildRuntimeFromSnapshot(
                      diskSession.activeTurnId ?? null,
                      diskSession.eventsByTurn,
                    ),
                  };
                  const replayEvents: BufferedEvent[] = [
                    ...buffered,
                    { turnId, event },
                  ];
                  updated = applyBufferedEventUnionToSession(updated, replayEvents);

                  // Guard: skip cache/summary if stale (persist always runs — see loaded path)
                  if (getHistoryRevision(sessionId) === capturedRevision) {
                    // RESURRECTION GUARD: same rationale as the loaded path.
                    if (
                      !wouldResurrectClearedSession(
                        get(),
                        sessionId,
                        capturedRemovalGeneration,
                      )
                    ) {
                      get().cacheSession(updated);
                      const newSummary = createSummaryFromSession(updated);
                      get().updateSessionSummary(newSummary);
                    }
                  }
                  persistBufferedEventUnionForSession(sessionId, replayEvents);
                } catch (err) {
                  console.warn(
                    `[sessionStore] Failed to persist terminal event for non-loaded session ${sessionId}:`,
                    err,
                  );
                }
              })();
            }
          }
        },

        addOrUpdateHistorySession: (session, prepend = true) => {
          // DELETE AUTHORITY: refuse to re-create or un-delete a removed id from
          // this snapshot-demotion / background-add path. A genuinely-new
          // background session was never tombstoned (classifies as create), an
          // un-trashed session had its tombstone cleared by restoreSession.
          const existingRowForWrite = get().sessionSummaries.find(
            (s) => s.id === session.id,
          );
          const writeDecision = classifySessionSummaryWrite({
            sessionId: session.id,
            hasExistingRow: existingRowForWrite !== undefined,
            existingRowDeletedAt: existingRowForWrite?.deletedAt ?? null,
          });
          if (writeDecision.kind === 'stale-write-after-delete') {
            return;
          }
          // Create summary for sidebar display
          const summary = createSummaryFromSession(session);

          set((state) => {
            // Stage 9: Only update sessionSummaries (removed agentSessions)
            const existing = state.sessionSummaries.find(
              (s) => s.id === session.id,
            );
            // Preserve the higher updatedAt. createSummaryFromSession derives
            // updatedAt from session.updatedAt (ultimately Math.max of last
            // message / draft / createdAt in snapshotCurrentSession), but the
            // existing summary may carry a more recent value bumped by
            // processHistoryEvent on every turn event. Without this guard the
            // current→history demotion on session selection visibly downgrades
            // the timestamp and reorders the sidebar — see
            // docs-private/investigations/260424_sidebar_reorders_on_selection.md.
            const mergedSummary = existing
              ? { ...summary, updatedAt: Math.max(summary.updatedAt, existing.updatedAt) }
              : summary;
            const nextSummaries = existing
              ? state.sessionSummaries.map((s) =>
                  s.id === session.id ? mergedSummary : s,
                )
              : prepend
                ? [mergedSummary, ...state.sessionSummaries]
                : [...state.sessionSummaries, mergedSummary];

            return {
              // delete-authority: classified (classifySessionSummaryWrite above)
              sessionSummaries: nextSummaries,
            };
          });

          // BUG FIX: Cache session so processHistoryEvent can access it
          // Without this, background sessions receiving events via IPC would fall into
          // the "NON-LOADED SESSION" branch and lose data (see processHistoryEvent)
          get().cacheSession(session);

          // BUG FIX: Persist to disk so data survives app restart
          // Fire-and-forget - errors logged by main process
          window.sessionsApi.upsert(asIpcSession(stripRuntime(session)))
            .then((r) => { if (r && !r.success) console.warn(`[sessionStore] persist failed for ${session.id}`, r?.error); })
            .catch((err) => { console.warn(`[sessionStore] persist rejected for ${session.id}`, err); });
        },

        removeHistorySession: (sessionId) => {
          historyEventRevision.delete(sessionId);
          // RESURRECTION GUARD: see bumpSessionRemovalGeneration. A late
          // processHistoryEvent terminal re-add must not resurrect this session.
          bumpSessionRemovalGeneration();
          // DELETE AUTHORITY: hard delete — no summary-insertion path (stale
          // save, disk reconcile, ingest, terminal re-add) may re-create this id.
          recordSessionRemoval('hard-delete', [sessionId]);
          useRouteLabelCacheStore.getState().clearForSession(sessionId);
          set((state) => ({
            // Stage 9: Only update sessionSummaries (removed agentSessions)
            // delete-authority: removal (recordSessionRemoval 'hard-delete' above)
            sessionSummaries: state.sessionSummaries.filter(
              (s) => s.id !== sessionId,
            ),
            // RESURRECTION GUARD: this is a HARD delete (the engine also removes
            // the file from disk). Evict the LRU cache entry too — otherwise a
            // late terminal processHistoryEvent for this id would take the
            // "loaded" re-add path and resurrect the deleted session into the
            // sidebar (matches emptyTrash, which also clears loadedSessions).
            loadedSessions: state.loadedSessions.has(sessionId)
              ? new Map(
                  [...state.loadedSessions].filter(([id]) => id !== sessionId),
                )
              : state.loadedSessions,
            // Clean up draft for removed session
            draftsBySessionId: omit(state.draftsBySessionId, sessionId),
            annotationsBySessionId: omit(
              state.annotationsBySessionId,
              sessionId,
            ),
          }));
        },

        setSessionSummaries: (summaries) => {
          const state = get();
          const drafts = state.draftsBySessionId;
          const annotations = state.annotationsBySessionId;

          const prevById = new Map(state.sessionSummaries.map((s) => [s.id, s]));

          // DELETE AUTHORITY: this is a WHOLESALE disk→store reconciliation
          // (reloadSessionSummaries / startup load / cloud sync). A list request
          // that started before a deletion can carry a removed id; classify each
          // incoming row and drop the stale-write-after-delete ones by
          // construction so the disk snapshot can never re-populate a removed
          // session. We re-attach any existing row whose id is
          // tombstoned-but-soft-deleted below so the Trash view (a legitimate
          // present-with-deletedAt row) is not dropped by the replace.
          const filteredSummaries = summaries.filter(
            (s) =>
              classifySessionSummaryWrite({
                sessionId: s.id,
                hasExistingRow: prevById.has(s.id),
                existingRowDeletedAt: prevById.get(s.id)?.deletedAt ?? null,
              }).kind !== 'stale-write-after-delete',
          );

          // Layer A merge: incoming summary busy scalars are advisory. Whenever
          // this surface has the session event stream (current/open or loaded),
          // projection-derived liveness wins and incoming scalars cannot
          // resurrect a terminal/interrupted turn.
          const now = Date.now();
          const merged: AgentSessionSummary[] = filteredSummaries.map((next) => {
            const prev = prevById.get(next.id);
            const updatedAt = prev ? Math.max(prev.updatedAt, next.updatedAt) : next.updatedAt;
            const incomingWithFallbackActivity = {
              isBusy: next.isBusy,
              activeTurnId: next.activeTurnId,
              lastActivityAt: next.lastActivityAt ?? prev?.lastActivityAt ?? null,
            };

            let mergedLiveness = applySummaryBusyStaleness(
              incomingWithFallbackActivity,
              now,
            );
            let hasAuthoritativeProjection = false;

            if (next.id === state.currentSessionId) {
              const projected = getCurrentSessionProjectedLiveness(
                state.activeTurnId ?? null,
              );
              const projectedScalars = toPersistedBusyScalars(projected);
              hasAuthoritativeProjection = true;
              mergedLiveness = {
                ...projectedScalars,
                lastActivityAt:
                  projected.lastActivityAt ??
                  projected.startedAt ??
                  mergedLiveness.lastActivityAt,
              };
            } else {
              const loadedSession = state.loadedSessions.get(next.id);
              if (loadedSession) {
                hasAuthoritativeProjection = true;
                mergedLiveness = deriveSummaryLivenessFromProjection(
                  loadedSession.eventsByTurn,
                  loadedSession.activeTurnId ?? null,
                );
              }
            }

            if (prev && !hasAuthoritativeProjection && !prev.isBusy && mergedLiveness.isBusy) {
              const previousLastActivity =
                typeof prev.lastActivityAt === 'number'
                  ? prev.lastActivityAt
                  : Number.NEGATIVE_INFINITY;
              const incomingLastActivity =
                typeof mergedLiveness.lastActivityAt === 'number'
                  ? mergedLiveness.lastActivityAt
                  : Number.NEGATIVE_INFINITY;
              if (incomingLastActivity <= previousLastActivity) {
                mergedLiveness = {
                  ...mergedLiveness,
                  isBusy: false,
                  activeTurnId: null,
                };
              }
            }

            return {
              ...next,
              updatedAt,
              isBusy: mergedLiveness.isBusy,
              activeTurnId: mergedLiveness.activeTurnId,
              lastActivityAt: mergedLiveness.lastActivityAt,
            };
          });

          // DELETE AUTHORITY: a soft-deleted (trashed) session is tombstoned but
          // legitimately stays present in summaries with deletedAt set. The
          // wholesale replace above filtered it out of the incoming list, so
          // re-attach the existing trashed row to keep it in the Trash view.
          // (Hard-removed ids have no prior row, so they correctly stay gone.)
          const mergedIds = new Set(merged.map((s) => s.id));
          for (const prevSummary of state.sessionSummaries) {
            if (
              isReattachableTrashRow(prevSummary) &&
              !mergedIds.has(prevSummary.id)
            ) {
              merged.push(prevSummary);
            }
          }

          // Fast path: no per-session local state to prune
          if (
            Object.keys(drafts).length === 0 &&
            Object.keys(annotations).length === 0
          ) {
            // delete-authority: classified (per-row classifySessionSummaryWrite above)
            set({ sessionSummaries: merged });
            return;
          }

          // Prune orphaned drafts/annotations when summaries are replaced (e.g., from IPC sync)
          // Keep local state only for sessions that still exist in summaries or are current
          const validSessionIds = new Set(merged.map((s) => s.id));
          const currentId = state.currentSessionId;
          const prunedDrafts = Object.fromEntries(
            Object.entries(drafts).filter(
              ([id]) => validSessionIds.has(id) || id === currentId,
            ),
          );
          const prunedAnnotations = Object.fromEntries(
            Object.entries(annotations).filter(
              ([id]) => validSessionIds.has(id) || id === currentId,
            ),
          );
          set({
            // delete-authority: classified (per-row classifySessionSummaryWrite above)
            sessionSummaries: merged,
            draftsBySessionId: prunedDrafts,
            annotationsBySessionId: prunedAnnotations,
          });
        },

        updateSessionSummary: (summary) => {
          // DELETE AUTHORITY: a removed id must never be re-created OR un-deleted
          // from here. This is the single chokepoint that closes the stale-save
          // vector: saveSessionAndUpdateSummary / saveSessionByIdAndUpdateSummary
          // both end in this call after their async await, so a save started
          // before a clear/delete that resolves afterwards classifies as
          // stale-write-after-delete and lands here as a no-op.
          // (restoreSession clears the tombstone first, so un-trash still works.)
          const existingRowForSummary = get().sessionSummaries.find(
            (s) => s.id === summary.id,
          );
          const writeDecision = classifySessionSummaryWrite({
            sessionId: summary.id,
            hasExistingRow: existingRowForSummary !== undefined,
            existingRowDeletedAt: existingRowForSummary?.deletedAt ?? null,
          });
          if (writeDecision.kind === 'stale-write-after-delete') {
            return;
          }
          set((state) => {
            if (writeDecision.kind === 'update') {
              // Update existing summary
              return {
                // delete-authority: classified (classifySessionSummaryWrite above)
                sessionSummaries: state.sessionSummaries.map((s) =>
                  s.id === summary.id ? summary : s,
                ),
              };
            } else {
              // Add new summary (prepend for recency)
              return {
                // delete-authority: classified (classifySessionSummaryWrite above)
                sessionSummaries: [summary, ...state.sessionSummaries],
              };
            }
          });
        },

        cacheSession: (session) => {
          set((state) => {
            // PERF: Compact completed turns before caching in LRU.
            // Strips large detail/text strings from completed turns to reduce memory.
            // Full-fidelity events remain on disk (persistence runs before caching).
            const compactedEvents = compactCompletedTurns(
              session.eventsByTurn,
              session.activeTurnId,
            );

            // Archive tool details before compaction strips them.
            // This preserves full input/output text for diagnostics drill-down.
            // PERF: Bounded to prevent unbounded string retention (Stage 4).
            let cachedSession: AgentSessionWithRuntime;
            if (compactedEvents !== session.eventsByTurn) {
              const archive = { ...session.toolDetailArchive };
              for (const [, events] of Object.entries(session.eventsByTurn)) {
                const starts = new Map<string, string>();
                for (const event of events) {
                  if (event.type !== "tool") continue;
                  const id = event.toolUseId;
                  if (!id) continue;
                  if (event.stage === "start" && event.detail) {
                    starts.set(id, event.detail);
                  } else if (event.stage === "end") {
                    const inputDetail = starts.get(id) ?? "";
                    const outputDetail = event.detail ?? "";
                    // Only archive if there's meaningful content to preserve
                    if (
                      (inputDetail.length > 0 || outputDetail.length > 0) &&
                      !archive[id]
                    ) {
                      archive[id] = {
                        toolName: event.toolName,
                        input: inputDetail.length > MAX_TOOL_ARCHIVE_VALUE_SIZE
                          ? inputDetail.slice(0, MAX_TOOL_ARCHIVE_VALUE_SIZE) + '[…truncated]'
                          : inputDetail,
                        output: outputDetail.length > MAX_TOOL_ARCHIVE_VALUE_SIZE
                          ? outputDetail.slice(0, MAX_TOOL_ARCHIVE_VALUE_SIZE) + '[…truncated]'
                          : outputDetail,
                        outputChars: outputDetail.length,
                      };
                    }
                  }
                }
              }

              // Cap entries per session: keep only the most recent N entries
              const archiveKeys = Object.keys(archive);
              let boundedArchive = archive;
              if (archiveKeys.length > MAX_TOOL_ARCHIVE_ENTRIES_PER_SESSION) {
                const recentKeys = archiveKeys.slice(-MAX_TOOL_ARCHIVE_ENTRIES_PER_SESSION);
                boundedArchive = {};
                for (const key of recentKeys) {
                  boundedArchive[key] = archive[key];
                }
              }

              cachedSession = {
                ...session,
                eventsByTurn: compactedEvents,
                toolDetailArchive: boundedArchive,
              };
            } else {
              cachedSession = session;
            }

            // Create a new Map (Zustand requires immutable updates)
            const nextMap = new Map(state.loadedSessions);

            // "Touch" by delete+set to move to end (most recently used)
            nextMap.delete(session.id);
            nextMap.set(session.id, cachedSession);

            // Evict if over limit
            if (nextMap.size > MAX_LOADED_SESSIONS) {
              // Iterate in insertion order (oldest first)
              for (const [id, cachedSession] of nextMap) {
                // Skip protected entries:
                // - Current session (user is viewing it)
                // - Session currently being loaded (race condition prevention)
                // - Sessions with active turns (busy, shouldn't be evicted)
                if (id === state.currentSessionId) continue;
                if (id === state.loadingSessionId) continue;
                if (cachedSession.activeTurnId != null) continue;

                // Evict this one (oldest unprotected)
                nextMap.delete(id);
                if (nextMap.size <= MAX_LOADED_SESSIONS) break;
              }
              // If still over limit (all protected), allow temporary oversize
              // This is intentional - don't crash, just accept temporary growth
            }

            return { loadedSessions: nextMap };
          });
        },

        getLoadedSession: (id) => {
          const state = get();
          const session = state.loadedSessions.get(id);

          if (session) {
            // "Touch" the session to mark as recently used (move to end of Map)
            // This is done via cacheSession which handles the delete+set pattern
            // But since getLoadedSession is a pure getter, we just return without touching
            // The touch will happen when the caller uses the session (via cacheSession on update)
            // Note: To implement true LRU touch on read, we'd need to call set() here,
            // but that would cause unnecessary re-renders. Instead, we touch on write (cacheSession).
          }

          return session;
        },

        setLoadingSession: (sessionId) => {
          set({
            isLoadingSession: sessionId !== null,
            loadingSessionId: sessionId,
          });
        },

        togglePinSession: (sessionId) => {
          const state = get();
          if (sessionId === state.currentSessionId) {
            const timestamp = Date.now();
            // Read the canonical `doneAt` lifecycle state: Active = `doneAt == null`.
            const isMarkingDone = state.currentSessionDoneAt == null;
            const nextDoneAt = isMarkingDone ? timestamp : null;
            // When marking a starred conversation as done, also remove the star
            const nextStarredAt =
              isMarkingDone && state.currentSessionStarredAt
                ? null
                : state.currentSessionStarredAt;
            set((s) => ({
              currentSessionDoneAt: nextDoneAt,
              currentSessionStarredAt: nextStarredAt,
              // Update sessionSummaries so sidebar reflects change
              // delete-authority: update-only (map over existing rows by id; never creates a row, never touches deletedAt)
              sessionSummaries: s.sessionSummaries.map((sum) =>
                sum.id === sessionId
                  ? { ...sum, doneAt: nextDoneAt, starredAt: nextStarredAt }
                  : sum,
              ),
            }));

            // Stage 9: Persist current session metadata via async IPC upsert
            // Required because removing agentSessions updates means persistence subscription
            // no longer triggers on metadata-only changes
            void (async () => {
              const snapshot = get().snapshotCurrentSession();
              if (snapshot) {
                window.sessionsApi.upsert(asIpcSession(stripRuntime(snapshot)))
                  .then((r) => { if (r && !r.success) console.warn(`[sessionStore] persist failed for ${sessionId}`, r?.error); })
                  .catch((err) => { console.warn(`[sessionStore] persist rejected for ${sessionId}`, err); });
              }
            })();
          } else {
            // Find current pin/star state from summary to compute new values
            const existingSummary = state.sessionSummaries.find(
              (s) => s.id === sessionId,
            );
            const timestamp = Date.now();
            // Read canonical `doneAt` lifecycle via predicate. An absent summary
            // is treated as not-Active (preserves prior behaviour).
            const isMarkingDone = existingSummary
              ? isSessionActive(existingSummary)
              : false;
            const nextDoneAt = isMarkingDone ? timestamp : null;
            // When marking a starred conversation as done, also remove the star
            const nextStarredAt =
              isMarkingDone && existingSummary?.starredAt
                ? null
                : (existingSummary?.starredAt ?? null);

            // Immediate UI update
            set((s) => ({
              // delete-authority: update-only (map over existing rows by id; never creates a row, never touches deletedAt)
              sessionSummaries: s.sessionSummaries.map((sum) =>
                sum.id === sessionId
                  ? { ...sum, doneAt: nextDoneAt, starredAt: nextStarredAt }
                  : sum,
              ),
            }));

            // Async: cache update + persist
            void persistNonCurrentSessionMetadata(
              sessionId,
              { doneAt: nextDoneAt, starredAt: nextStarredAt },
              get,
              set,
            );
          }
        },

        toggleStarSession: (sessionId) => {
          const state = get();
          const isBackground = isBackgroundConversationSession(sessionId);
          if (sessionId === state.currentSessionId) {
            const timestamp = Date.now();
            const isStarring = !state.currentSessionStarredAt;
            const nextStarredAt = isStarring ? timestamp : null;
            // When starring a Done conversation, also reopen it (canonical read:
            // Done = `currentSessionDoneAt != null`).
            const isReopening = isStarring && state.currentSessionDoneAt != null && !isBackground;
            const nextDoneAt = isReopening ? null : state.currentSessionDoneAt;
            set((s) => ({
              currentSessionStarredAt: nextStarredAt,
              currentSessionDoneAt: nextDoneAt,
              // Update sessionSummaries so sidebar reflects change
              // delete-authority: update-only (map over existing rows by id; never creates a row, never touches deletedAt)
              sessionSummaries: s.sessionSummaries.map((sum) =>
                sum.id === sessionId
                  ? {
                      ...sum,
                      starredAt: nextStarredAt,
                      ...(isReopening ? { doneAt: null } : {}),
                    }
                  : sum,
              ),
            }));

            // Stage 9: Persist current session metadata via async IPC upsert
            void (async () => {
              const snapshot = get().snapshotCurrentSession();
              if (snapshot) {
                window.sessionsApi.upsert(asIpcSession(stripRuntime(snapshot)))
                  .then((r) => { if (r && !r.success) console.warn(`[sessionStore] persist failed for ${sessionId}`, r?.error); })
                  .catch((err) => { console.warn(`[sessionStore] persist rejected for ${sessionId}`, err); });
              }
            })();
          } else {
            // Find current pin/star state from summary to compute new values
            const existingSummary = state.sessionSummaries.find(
              (s) => s.id === sessionId,
            );
            const timestamp = Date.now();
            const isStarring = !existingSummary?.starredAt;
            const nextStarredAt = isStarring ? timestamp : null;
            // When starring a Done conversation, also reopen it (canonical read:
            // Done = `doneAt != null`). An absent summary is treated as Done →
            // reopen on star (preserves prior behaviour).
            const isReopening =
              isStarring && !isBackground && (existingSummary ? isSessionDone(existingSummary) : true);

            // Immediate UI update
            set((s) => ({
              // delete-authority: update-only (map over existing rows by id; never creates a row, never touches deletedAt)
              sessionSummaries: s.sessionSummaries.map((sum) =>
                sum.id === sessionId
                  ? {
                      ...sum,
                      starredAt: nextStarredAt,
                      ...(isReopening ? { doneAt: null } : {}),
                    }
                  : sum,
              ),
            }));

            // Async: cache update + persist
            void persistNonCurrentSessionMetadata(
              sessionId,
              {
                starredAt: nextStarredAt,
                ...(isReopening ? { doneAt: null } : {}),
              },
              get,
              set,
            );
          }
        },

        softDeleteSession: (sessionId) => {
          // Clean up revision tracking for deleted session
          historyEventRevision.delete(sessionId);
          // RESURRECTION GUARD: see bumpSessionRemovalGeneration. A late terminal
          // re-add would updateSessionSummary the existing row and clear its
          // deletedAt, silently un-trashing the session.
          bumpSessionRemovalGeneration();
          // DELETE AUTHORITY: soft delete — the row stays present in summaries
          // with deletedAt set (visible in Trash), but no summary-acceptance path
          // may CLEAR its deletedAt or re-create it. restoreSession() clears this
          // tombstone so an explicit un-trash works. The typed declaration also
          // classifies this action's own summary writes below as 'soft-delete'.
          declareSoftDelete(sessionId);
          useRouteLabelCacheStore.getState().clearForSession(sessionId);
          const state = get();
          const deletedAt = Date.now();
          if (sessionId === state.currentSessionId) {
            // Stage 5 (F9 boundary flush): drain pending notification before
            // snapshotting so the trailing-edge counter is observable to the
            // persistence subscription before the external Map is cleared.
            flushPendingEventsVersionNotification();
            // For current session: snapshot it to history with deletedAt set, then reset
            // Note: We can't call resetSession() because it would re-snapshot and overwrite deletedAt
            const snapshot = get().snapshotCurrentSession();
            // Check for meaningful content: messages, events, draft text, annotations, OR pending recording
            // Must match snapshotCurrentSession() criteria to avoid inconsistencies
            // (Draft-only sessions like "Recovered voice note" should be trashable)
            const hasPendingRecording =
              state.pendingRecordingSessionIds.has(sessionId);
            const hasMeaningfulContent =
              snapshot &&
              (snapshot.messages.length > 0 ||
                Object.keys(snapshot.eventsByTurn).length > 0 ||
                snapshot.draft?.text?.trim() ||
                (snapshot.annotations?.length ?? 0) > 0 ||
                hasPendingRecording);
            if (hasMeaningfulContent) {
              // Force clean state when deleting - turn is still stopped via fire-and-forget,
              // but the snapshot in Trash should not show as busy/active
              const deletedSnapshot = {
                ...snapshot,
                deletedAt,
                isBusy: false,
                activeTurnId: null,
                focusedTurnId: null,
              };
              // Stage 9: Only update sessionSummaries (removed agentSessions)
              set((s) => {
                const hasExistingSummary = s.sessionSummaries.some(
                  (sum) => sum.id === sessionId,
                );
                // F2 (GPT review): if the current session has meaningful content
                // but NO prior sessionSummaries row (e.g. a never-summarized
                // current session — content lives only in memory, not yet in the
                // sidebar list), the `.map()` below is a no-op and NO Trash row
                // is created in renderer state. The disk row IS persisted (with
                // deletedAt) just below, but because this id is now tombstoned, a
                // later setSessionSummaries() reload FILTERS the incoming disk row
                // out — and the reattach path only restores an EXISTING soft-
                // deleted row from state, which here does not exist. Result: the
                // legitimately soft-deleted session is LOST from Trash (data loss).
                // FIX: synthesize a present-with-deletedAt summary row from the
                // deleted snapshot so the Trash row exists in renderer state and
                // survives the tombstone-filtered reload (reattach path).
                const nextSummaries = hasExistingSummary
                  ? s.sessionSummaries.map((sum) =>
                      sum.id === sessionId
                        ? { ...sum, deletedAt, isBusy: false, activeTurnId: null }
                        : sum,
                    )
                  : [
                      ...s.sessionSummaries,
                      createSummaryFromSession(deletedSnapshot),
                    ];
                return {
                  // delete-authority: soft-delete (declareSoftDelete above; F2 Trash row)
                  sessionSummaries: nextSummaries,
                  // Clean up draft for deleted session
                  draftsBySessionId: omit(s.draftsBySessionId, sessionId),
                  annotationsBySessionId: omit(
                    s.annotationsBySessionId,
                    sessionId,
                  ),
                };
              });

              // Stage 9 fix: Persist deleted snapshot (identified by triple-review)
              // Without this, trashed sessions don't survive restart
              window.sessionsApi.upsert(asIpcSession(stripRuntime(deletedSnapshot)))
                .then((r) => { if (r && !r.success) console.warn(`[sessionStore] persist failed for ${sessionId}`, r?.error); })
                .catch((err) => { console.warn(`[sessionStore] persist rejected for ${sessionId}`, err); });
            }
            // Clear external event Map before setting up new session
            clearCurrentSessionEvents();
            // Reset current session state directly (without re-snapshotting)
            const nextSessionId = createId();
            const creationTimestamp = Date.now();
            set((s) => ({
              ...extractConversationFields(
                conversationReducer.resetConversation(),
              ),
              runtime: runtimeReducer.resetRuntime(),
              // Phase 6 remediation: pair the empty messages/eventsByTurn
              // with the trailing-edge counter so subscribers see the
              // active-session reset atomically.
              eventsByTurnVersion: getCurrentSessionEventsVersion(),
              currentSessionId: nextSessionId,
              currentSessionTitle: "New Agent Run",
              currentSessionOrigin: "manual",
              currentSessionResolvedAt: null,
              // Brand-new session is Active → `doneAt` null.
              currentSessionDoneAt: null,
              currentSessionStarredAt: null,
              privateMode: false,
              councilMode: false,
              sessionWorkingModel: undefined,
              sessionThinkingModel: undefined,
              sessionWorkingProfileId: undefined,
              sessionThinkingProfileId: undefined,
              sessionThinkingEffort: undefined,
              autoDoneEnabled: false,
              currentSessionCreatedAt: creationTimestamp,
              currentSessionFinishLine: null,
              isStopping: false,
              editingMessageId: null,
              memoryUpdateStatusByTurn: {},
              timeSavedStatusByTurn: {},
              activitySummaryByTurn: {},
              compactionBoundaries: [],
              // Clear draft for the old session being deleted
              draftsBySessionId: omit(s.draftsBySessionId, sessionId),
              annotationsBySessionId: omit(
                s.annotationsBySessionId,
                sessionId,
              ),
            }));
            // Phase 6 remediation: drain the just-scheduled microtask so a
            // redundant setState does not fire after the atomic boundary.
            flushPendingEventsVersionNotification();
          } else {
            // Immediate UI update
            set((s) => ({
              // delete-authority: soft-delete (declareSoftDelete above)
              sessionSummaries: s.sessionSummaries.map((sum) =>
                sum.id === sessionId
                  ? { ...sum, deletedAt, isBusy: false, activeTurnId: null }
                  : sum,
              ),
              // Clean up draft for deleted session
              draftsBySessionId: omit(s.draftsBySessionId, sessionId),
              annotationsBySessionId: omit(
                s.annotationsBySessionId,
                sessionId,
              ),
            }));

            // Async: cache update + persist
            void persistNonCurrentSessionMetadata(
              sessionId,
              { deletedAt, isBusy: false, activeTurnId: null },
              get,
              set,
            );
          }
        },

        restoreSession: (sessionId) => {
          // DELETE AUTHORITY: explicit un-trash — clear the tombstone so the
          // session can legitimately re-appear as live and accept future summary
          // updates / saves again.
          declareSessionRestore(sessionId);
          // Immediate UI update
          set((s) => ({
            // delete-authority: restore (declareSessionRestore above)
            sessionSummaries: s.sessionSummaries.map((sum) =>
              sum.id === sessionId ? { ...sum, deletedAt: null } : sum,
            ),
          }));

          // Async: cache update + persist
          void persistNonCurrentSessionMetadata(
            sessionId,
            { deletedAt: null },
            get,
            set,
          );
        },

        emptyTrash: () => {
          const state = get();

          // Use sessionSummaries as source of truth for deleted sessions
          const deletedIds = new Set(
            state.sessionSummaries
              .filter((summary) => summary.deletedAt != null)
              .map((summary) => summary.id),
          );

          if (deletedIds.size === 0) return;

          // RESURRECTION GUARD: see bumpSessionRemovalGeneration. Prevents a late
          // terminal re-add from resurrecting a permanently-deleted session.
          bumpSessionRemovalGeneration();
          // DELETE AUTHORITY: permanent delete — no summary-insertion path may
          // ever re-create these ids.
          recordSessionRemoval('empty-trash', deletedIds);

          // Clean up drafts, annotations, and revision tracking for all sessions being permanently deleted
          let updatedDrafts = state.draftsBySessionId;
          let updatedAnnotations = state.annotationsBySessionId;
          for (const id of deletedIds) {
            updatedDrafts = omit(updatedDrafts, id);
            updatedAnnotations = omit(updatedAnnotations, id);
            historyEventRevision.delete(id);
            useRouteLabelCacheStore.getState().clearForSession(id);
          }

          // Permanently delete from disk via IPC (fire-and-forget)
          for (const id of deletedIds) {
            void window.sessionsApi.delete({ id });
          }

          // Stage 9: Only update sessionSummaries (removed agentSessions)
          set({
            // delete-authority: removal (recordSessionRemoval 'empty-trash' above)
            sessionSummaries: state.sessionSummaries.filter(
              (sum) => !deletedIds.has(sum.id),
            ),
            // Remove from loadedSessions cache
            loadedSessions: new Map(
              [...state.loadedSessions].filter(([id]) => !deletedIds.has(id)),
            ),
            draftsBySessionId: updatedDrafts,
            annotationsBySessionId: updatedAnnotations,
          });
        },

        renameSession: (sessionId, newTitle) => {
          const state = get();
          if (sessionId === state.currentSessionId) {
            set((s) => ({
              currentSessionTitle: newTitle,
              // Update sessionSummaries so sidebar reflects change
              // delete-authority: update-only (map over existing rows by id; never creates a row, never touches deletedAt)
              sessionSummaries: s.sessionSummaries.map((sum) =>
                sum.id === sessionId ? { ...sum, title: newTitle } : sum,
              ),
            }));

            // Stage 9: Persist current session metadata via async IPC upsert
            void (async () => {
              const snapshot = get().snapshotCurrentSession();
              if (snapshot) {
                const renamedSession = stripRuntime({
                  ...snapshot,
                  autoTitleGeneratedAt: undefined,
                  autoTitleTurnCount: undefined,
                });

                window.sessionsApi.upsert(asIpcSession(renamedSession))
                  .then((r) => { if (r && !r.success) console.warn(`[sessionStore] persist failed for ${sessionId}`, r?.error); })
                  .catch((err) => { console.warn(`[sessionStore] persist rejected for ${sessionId}`, err); });
              }
            })();
          } else {
            // Immediate UI update
            set((s) => ({
              // delete-authority: update-only (map over existing rows by id; never creates a row, never touches deletedAt)
              sessionSummaries: s.sessionSummaries.map((sum) =>
                sum.id === sessionId ? { ...sum, title: newTitle } : sum,
              ),
            }));

            // Async: cache update + persist
            void persistNonCurrentSessionMetadata(
              sessionId,
              {
                title: newTitle,
                autoTitleGeneratedAt: undefined,
                autoTitleTurnCount: undefined,
              },
              get,
              set,
            );
          }
        },

        applyAutoGeneratedTitle: (sessionId, title, metadata) => {
          const state = get();

          if (sessionId === state.currentSessionId) {
            set((s) => {
              const loadedSession = s.loadedSessions.get(sessionId);
              const nextLoadedSessions = loadedSession
                ? new Map(s.loadedSessions).set(sessionId, {
                    ...loadedSession,
                    title,
                    autoTitleGeneratedAt: metadata.autoTitleGeneratedAt,
                    autoTitleTurnCount: metadata.autoTitleTurnCount,
                  })
                : s.loadedSessions;

              return {
                currentSessionTitle: title,
                // delete-authority: update-only (map over existing rows by id; never creates a row, never touches deletedAt)
                sessionSummaries: s.sessionSummaries.map((sum) =>
                  sum.id === sessionId ? { ...sum, title } : sum,
                ),
                loadedSessions: nextLoadedSessions,
              };
            });
            return;
          }

          set((s) => {
            const loadedSession = s.loadedSessions.get(sessionId);
            const nextLoadedSessions = loadedSession
              ? new Map(s.loadedSessions).set(sessionId, {
                  ...loadedSession,
                  title,
                  autoTitleGeneratedAt: metadata.autoTitleGeneratedAt,
                  autoTitleTurnCount: metadata.autoTitleTurnCount,
                })
              : s.loadedSessions;

            return {
              // delete-authority: update-only (map over existing rows by id; never creates a row, never touches deletedAt)
              sessionSummaries: s.sessionSummaries.map((sum) =>
                sum.id === sessionId ? { ...sum, title } : sum,
              ),
              loadedSessions: nextLoadedSessions,
            };
          });
        },

        openHistorySession: (sessionId, fullFidelityEvents) => {
          const state = get();

          // Stage 9: Only check loadedSessions (removed agentSessions fallback).
          // The async openHistorySession in useAgentSessionEngine always loads via IPC
          // and caches before calling this method, so session should be in loadedSessions.
          const selectedSession = state.loadedSessions.get(sessionId);
          if (!selectedSession) return null;

          if (selectedSession.isCorrupted) return null;
          // Deleted (soft-deleted) sessions open read-only rather than being
          // blocked here — the conversation surface enforces read-only via the
          // Trash banner + disabled composer. Restore is offered from that banner.

          // Session switch cleanup: clear transient thinking buffers from prior session.
          // This prevents stale progressive content from leaking across sessions.
          cancelPendingThinkingDeltas();
          // Stage 5 (F9 boundary flush): drain pending notification before
          // snapshotting the outgoing session and switching the external Map
          // to the next session's events. Persistence subscribers must observe
          // the trailing-edge counter for the outgoing session before the
          // events are replaced.
          flushPendingEventsVersionNotification();
          if (state.currentSessionId !== selectedSession.id) {
            invalidateMcpAppConversationNonces(state.currentSessionId);
            invalidateMcpAppConversationNonces(selectedSession.id);
          }

          const currentSnapshot = get().snapshotCurrentSession();

          // Stage 9: Update sessionSummaries (not agentSessions) when snapshotting
          if (currentSnapshot) {
            state.addOrUpdateHistorySession(currentSnapshot, true);
            sessionCounter += 1;
          }

          // Rebuild runtime state from events to verify if the turn is actually active.
          // This prevents stuck spinners when loading sessions with stale isBusy flags,
          // while preserving the spinner for sessions with genuinely active turns.
          // Reuse existing runtime if available (from LRU cache), otherwise rebuild.
          const sessionRuntime =
            selectedSession.runtime ??
            buildRuntimeFromSnapshot(
              selectedSession.activeTurnId ?? null,
              selectedSession.eventsByTurn,
            );
          const turnIsActuallyActive =
            sessionRuntime.startedAt !== null &&
            !runtimeReducer.isTurnStale(sessionRuntime);
          const effectiveRuntime = turnIsActuallyActive
            ? sessionRuntime
            : runtimeReducer.createRuntimeState();
          const effectiveActiveTurnId = turnIsActuallyActive
            ? (sessionRuntime.activeTurnId ?? null)
            : null;
          const sessionBusy = turnIsActuallyActive;

          // Fix B+C: If runtime check reveals stale isBusy, update sidebar summary + persist
          if (!turnIsActuallyActive && selectedSession.isBusy) {
            const staleSummary = state.sessionSummaries.find(
              (s) => s.id === sessionId,
            );
            if (staleSummary?.isBusy) {
              state.updateSessionSummary({
                ...staleSummary,
                isBusy: false,
                activeTurnId: null,
              });
            }
            // Persist correction to disk so it survives hot-reload
            window.sessionsApi.upsert(asIpcSession(stripRuntime({
              ...selectedSession,
              isBusy: false,
              activeTurnId: null,
              focusedTurnId: null,
            })))
              .then((r) => { if (r && !r.success) console.warn(`[sessionStore] persist failed for ${sessionId}`, r?.error); })
              .catch((err) => { console.warn(`[sessionStore] persist rejected for ${sessionId}`, err); });
          }

          // Rehydrate draft from persisted session if present and not already in memory.
          // This ensures draft-only sessions (e.g. "Recovered voice note") show context menu after app restart.
          let updatedDrafts = state.draftsBySessionId;
          const persistedDraft = selectedSession.draft;
          const existingDraft = state.draftsBySessionId[sessionId];
          if (persistedDraft?.text?.trim() && !existingDraft?.text?.trim()) {
            updatedDrafts = {
              ...state.draftsBySessionId,
              [sessionId]: {
                text: toComposerWireMarkdown(persistedDraft.text),
                updatedAt: persistedDraft.updatedAt ?? Date.now(),
              },
            };
          }

          let updatedAnnotations = state.annotationsBySessionId;
          if (!hasOwn(state.annotationsBySessionId, sessionId)) {
            const persistedAnnotations = selectedSession.annotations ?? [];
            if (persistedAnnotations.length > 0) {
              updatedAnnotations = {
                ...state.annotationsBySessionId,
                [sessionId]: [...persistedAnnotations],
              };
            }
          }

          // Load events into the external Map. Prefer full-fidelity events from disk
          // over the LRU cache copy, which has detail stripped by compactCompletedTurns.
          // Stage 19a: validate the hydrated set against the session being
          // opened so a foreign-stamped event in the cache/disk snapshot is
          // dropped at hydration (W11 — history-open).
          setCurrentSessionEvents(
            fullFidelityEvents ?? selectedSession.eventsByTurn,
            beginValidatedSessionWrite(sessionId, 'history-hydration'),
          );

          set({
            messages: selectedSession.messages,
            activeTurnId: effectiveActiveTurnId,
            focusedTurnId: effectiveActiveTurnId,
            isBusy: sessionBusy,
            lastError: selectedSession.lastError ?? null,
            lastErrorSource: null,
            runtime: effectiveRuntime,
            // Phase 6 remediation: include the trailing-edge counter so the
            // visible state (messages/currentSessionId) and eventsByTurnVersion
            // update atomically. Without this, Zustand subscribers see the
            // new session's messages with the previous microtask's stale
            // version for one tick.
            eventsByTurnVersion: getCurrentSessionEventsVersion(),
            currentSessionId: selectedSession.id,
            currentSessionTitle: selectedSession.title,
            currentSessionOrigin: normalizeCurrentSessionOrigin(
              selectedSession.origin,
              selectedSession.id,
            ),
            currentSessionResolvedAt:
              typeof selectedSession.resolvedAt === "number"
                ? selectedSession.resolvedAt
                : null,
            // Read canonical `doneAt` (S1 dual-writes + migration backfills it).
            currentSessionDoneAt:
              typeof selectedSession.doneAt === "number"
                ? selectedSession.doneAt
                : null,
            currentSessionStarredAt:
              typeof selectedSession.starredAt === "number"
                ? selectedSession.starredAt
                : null,
            privateMode: selectedSession.privateMode ?? false,
            councilMode: false,
            sessionWorkingModel:
              selectedSession.sessionWorkingModel ?? undefined,
            sessionThinkingModel:
              selectedSession.sessionThinkingModel ?? undefined,
            sessionWorkingProfileId:
              selectedSession.sessionWorkingProfileId ?? undefined,
            sessionThinkingProfileId:
              selectedSession.sessionThinkingProfileId ?? undefined,
            sessionThinkingEffort:
              selectedSession.sessionThinkingEffort ?? undefined,
            // Restore auto-done from per-session map (survives session switches)
            autoDoneEnabled:
              state.autoDoneBySessionId[selectedSession.id] ?? false,
            // Use session's createdAt for stable timestamp (draft-only sessions need this)
            currentSessionCreatedAt: selectedSession.createdAt,
            currentSessionMeetingCompanion:
              selectedSession.meetingCompanion ?? null,
            currentSessionSetupContext: selectedSession.setupContext ?? null,
            currentSessionFinishLine:
              normalizeFinishLine(selectedSession.finishLine) ?? null,
            // Stage 9: Removed agentSessions update
            showConversation: true,
            // Reset isStopping to prevent state leakage when switching sessions
            isStopping: false,
            editingMessageId: null,
            memoryUpdateStatusByTurn:
              selectedSession.memoryUpdateStatusByTurn ?? {},
            timeSavedStatusByTurn: selectedSession.timeSavedStatusByTurn ?? {},
            activitySummaryByTurn: selectedSession.activitySummaryByTurn ?? {},
            compactionBoundaries: selectedSession.compactionBoundaries ?? [],
            thinkingTextByTurn: {},
            draftsBySessionId: updatedDrafts,
            annotationsBySessionId: updatedAnnotations,
          });
          // Phase 6 remediation: drain the just-scheduled microtask. The
          // synchronous set above already wrote the latest counter, so this
          // flush is a no-op fan-out (subscribers see the same value) but
          // crucially clears `pendingEventsVersionNotification` so the
          // microtask body becomes a tail no-op rather than a redundant
          // setState call after the boundary.
          flushPendingEventsVersionNotification();

          return selectedSession;
        },

        ingestExternalSessions: (external) => {
          const state = get();

          // Stage 9: Process external sessions without using agentSessions.
          // Find the active session (current) and history sessions separately.
          let activeSnapshot: AgentSession | null = null;
          const historySnapshots: AgentSession[] = [];

          for (const session of external) {
            if (!session?.id) continue;
            if (session.id === state.currentSessionId) {
              activeSnapshot = session;
              continue;
            }
            historySnapshots.push(session);
          }

          if (activeSnapshot) {
            const origin = normalizeCurrentSessionOrigin(
              activeSnapshot.origin,
              activeSnapshot.id,
            );

            // REBEL-6C0 / REBEL-6BZ Stage 2 — defense-in-depth: refuse a
            // content-REGRESSING ingest of the active session. The wholesale
            // replace below would clobber the live transcript if `activeSnapshot`
            // is content-poorer than what is currently live (e.g. a stale disk
            // read that lost a just-finished turn's final answer). The guard keeps
            // the live content for any shared turn the snapshot would shrink
            // (fewer non-user messages OR lower max valid event seq — count-stable
            // in-place result promotion means count alone is NOT a safe signal),
            // while still adopting cloud-only/new turns and superset/equal updates.
            // See docs/plans/260622_fix-message-render-drop/PLAN.md Stage 2.
            const guard = guardActiveIngestRegression(
              { messages: state.messages, eventsByTurn: getCurrentSessionEvents() },
              { messages: activeSnapshot.messages, eventsByTurn: activeSnapshot.eventsByTurn },
            );
            if (guard.refused) {
              const guardData = {
                sessionIdHash: hashSessionIdForBreadcrumb(activeSnapshot.id),
                refusedTurnIdHashes: guard.refusedTurnIds.map(hashSessionIdForBreadcrumb),
                refusedTurnCount: guard.refusedTurnIds.length,
                liveMessageCount: state.messages.length,
                incomingMessageCount: activeSnapshot.messages?.length ?? 0,
              };
              recordRendererBreadcrumb({
                category: 'ingest-regression-refused',
                level: 'warning',
                data: guardData,
              });
              console.warn(
                '[sessionStore] Refused content-regressing active-session ingest; kept live transcript for shrinking turns',
                guardData,
              );
            }
            // Apply the guarded (non-regressing) view as the snapshot to ingest.
            activeSnapshot = {
              ...activeSnapshot,
              messages: guard.messages,
              eventsByTurn: guard.eventsByTurn,
            };

            const snapshotRuntime = buildRuntimeFromSnapshot(
              activeSnapshot.activeTurnId ?? null,
              activeSnapshot.eventsByTurn,
            );
            // If the runtime indicates the turn has completed (no startedAt) or is stale
            // (no events for >5 min), clear activeTurnId and isBusy to avoid stuck states
            const turnIsActuallyActive =
              snapshotRuntime.startedAt !== null &&
              !runtimeReducer.isTurnStale(snapshotRuntime);
            const effectiveRuntime = turnIsActuallyActive
              ? snapshotRuntime
              : runtimeReducer.createRuntimeState();
            const effectiveActiveTurnId = turnIsActuallyActive
              ? (snapshotRuntime.activeTurnId ?? null)
              : null;
            const snapshotBusy = turnIsActuallyActive;

            // Phase 6.5 remediation: drain pending notification before
            // swapping the external Map to the active snapshot's events so
            // persistence subscribers observe the trailing-edge counter for
            // the pre-ingest events before the Map is replaced.
            flushPendingEventsVersionNotification();
            // Stage 19a: the active snapshot's events belong to
            // `activeSnapshot.id` (=== currentSessionId, see L3876), so
            // validate the ingested set and drop any foreign-stamped event
            // (cloud merge path — W12).
            setCurrentSessionEvents(
              activeSnapshot.eventsByTurn ?? {},
              beginValidatedSessionWrite(activeSnapshot.id, 'ingest-external'),
            );
            set({
              messages: activeSnapshot.messages ?? [],
              activeTurnId: effectiveActiveTurnId,
              focusedTurnId: effectiveActiveTurnId,
              isBusy: snapshotBusy,
              lastError: activeSnapshot.lastError ?? null,
              lastErrorSource: null,
              // Phase 6.5 remediation: pair the ingested visible state with
              // the trailing-edge counter so subscribers see the new messages
              // and the new eventsByTurnVersion in the same notification.
              eventsByTurnVersion: getCurrentSessionEventsVersion(),
              currentSessionResolvedAt:
                typeof activeSnapshot.resolvedAt === "number"
                  ? activeSnapshot.resolvedAt
                  : null,
              currentSessionDoneAt:
                typeof activeSnapshot.doneAt === "number"
                  ? activeSnapshot.doneAt
                  : null,
              currentSessionStarredAt:
                typeof activeSnapshot.starredAt === "number"
                  ? activeSnapshot.starredAt
                  : null,
              privateMode: activeSnapshot.privateMode ?? false,
              councilMode: false,
              sessionWorkingModel:
                activeSnapshot.sessionWorkingModel ?? undefined,
              sessionThinkingModel:
                activeSnapshot.sessionThinkingModel ?? undefined,
              sessionWorkingProfileId:
                activeSnapshot.sessionWorkingProfileId ?? undefined,
              sessionThinkingProfileId:
                activeSnapshot.sessionThinkingProfileId ?? undefined,
              sessionThinkingEffort:
                activeSnapshot.sessionThinkingEffort ?? undefined,
              // Restore auto-done from per-session map (survives session switches)
              autoDoneEnabled:
                state.autoDoneBySessionId[activeSnapshot.id] ?? false,
              currentSessionTitle: activeSnapshot.title,
              currentSessionOrigin: origin,
              currentSessionFinishLine:
                normalizeFinishLine(activeSnapshot.finishLine) ?? null,
              showConversation:
                // eslint-disable-next-line no-restricted-syntax -- origin-classification-justified: restores the currently opened busy automation view state from the live snapshot, not history visibility.
                origin === "automation" && snapshotBusy
                  ? true
                  : state.showConversation,
              memoryUpdateStatusByTurn:
                activeSnapshot.memoryUpdateStatusByTurn ?? {},
              timeSavedStatusByTurn: activeSnapshot.timeSavedStatusByTurn ?? {},
              activitySummaryByTurn: activeSnapshot.activitySummaryByTurn ?? {},
              runtime: effectiveRuntime,
            });
            // Phase 6.5 remediation: drain the just-scheduled microtask so a
            // redundant setState does not fire after the atomic boundary.
            flushPendingEventsVersionNotification();
          }

          // Stage 9: Update sessionSummaries for history sessions (not agentSessions)
          if (historySnapshots.length > 0) {
            set((s) => {
              const summaryMap = new Map(
                s.sessionSummaries.map((sum) => [sum.id, sum]),
              );

              for (const session of historySnapshots) {
                // DELETE AUTHORITY: a cloud/automation ingest must not re-create
                // or un-delete a removed id. A genuinely-new background session
                // was never tombstoned (classifies as create) and ingests
                // normally.
                const ingestDecision = classifySessionSummaryWrite({
                  sessionId: session.id,
                  hasExistingRow: summaryMap.has(session.id),
                  existingRowDeletedAt:
                    summaryMap.get(session.id)?.deletedAt ?? null,
                });
                const ingestIsStaleAfterDelete =
                  ingestDecision.kind === 'stale-write-after-delete';
                const existingSummary = summaryMap.get(session.id);
                if (ingestIsStaleAfterDelete && !existingSummary) {
                  // Removed id with no surviving row (hard delete / empty
                  // trash / e2e clear): nothing may re-create it.
                  continue;
                }
                const sessionUpdatedAt = session.updatedAt ?? 0;
                const existingUpdatedAt = existingSummary?.updatedAt ?? 0;

                const summary = createSummaryFromSession(
                  session as AgentSessionWithRuntime,
                );

                // Wholesale REPLACE — adopts the incoming snapshot's
                // deletedAt, so it is the un-delete vector. A trashed row
                // (ledger-tombstoned or restart-loaded state) must never take
                // it; it may only fall through to the terminal-subset merge
                // below, which spreads onto the existing row and preserves
                // deletedAt by construction (shipped 4c7db336a contract:
                // terminal snapshots clear stale busy state without
                // overwriting user-owned metadata — trash state included).
                if (
                  !ingestIsStaleAfterDelete &&
                  (!existingSummary || sessionUpdatedAt > existingUpdatedAt)
                ) {
                  summaryMap.set(session.id, summary);
                  continue;
                }
                if (!existingSummary) {
                  continue;
                }

                const shouldMergeTerminalSnapshot =
                  summary.resolvedAt != null &&
                  (
                    existingSummary.resolvedAt == null ||
                    existingSummary.isBusy !== summary.isBusy ||
                    existingSummary.activeTurnId !== summary.activeTurnId ||
                    existingSummary.messageCount < summary.messageCount ||
                    existingSummary.preview !== summary.preview ||
                    existingSummary.lastError !== summary.lastError
                  );

                if (shouldMergeTerminalSnapshot) {
                  summaryMap.set(session.id, {
                    ...existingSummary,
                    resolvedAt: summary.resolvedAt,
                    // Canonical lifecycle field: adopt the incoming `doneAt` only
                    // when the existing row had no resolvedAt (terminal-snapshot merge).
                    doneAt: existingSummary.resolvedAt == null
                      ? summary.doneAt
                      : existingSummary.doneAt,
                    origin: summary.origin,
                    isCorrupted: summary.isCorrupted,
                    privateMode: summary.privateMode,
                    interruptedTurnId: summary.interruptedTurnId ?? existingSummary.interruptedTurnId,
                    preview: summary.preview,
                    firstMessagePreview: summary.firstMessagePreview,
                    lastMessagePreview: summary.lastMessagePreview,
                    messageCount: summary.messageCount,
                    hasUserMessages: summary.hasUserMessages,
                    usage: summary.usage,
                    activeTurnId: summary.activeTurnId,
                    isBusy: summary.isBusy,
                    lastError: summary.lastError,
                    meetingCompanion: summary.meetingCompanion ?? existingSummary.meetingCompanion,
                    updatedAt: Math.max(existingUpdatedAt, summary.updatedAt),
                  });
                }
              }

              return {
                // delete-authority: classified (per-snapshot classifySessionSummaryWrite above)
                sessionSummaries: Array.from(summaryMap.values()),
              };
            });
          }

          return activeSnapshot;
        },

        setCurrentSessionMeta: (meta) => set(meta),

        // Compaction actions
        startCompaction: (depth, originalSessionId, turnId) => {
          set((state) => {
            if (originalSessionId !== state.currentSessionId) {
              return state;
            }
            return {
            compaction: {
              phase: "compacting",
              statusMessage:
                depth === 1
                  ? "Hit the context ceiling. Packing our bags for a fresh start..."
                  : "Still too much to carry. Packing even lighter this time...",
              summary: null,
              depth,
              enhancedPrompt: null,
              originalSessionId,
              turnId: turnId ?? null,
              fallbackTarget: null,
              depth4ProfileName: null,
              revealDurationMs: null,
              reason: null,
            },
            showConversation: true,
            };
          });
        },

        setCompactionFallbackTarget: (targetLabel, turnId, originalSessionId) => {
          set((state) => {
            if (
              originalSessionId !== state.currentSessionId ||
              state.compaction.turnId !== turnId ||
              state.compaction.phase === "idle" ||
              state.compaction.phase === "continuing" ||
              state.compaction.phase === "error"
            ) {
              return state;
            }
            return {
              compaction: {
                ...state.compaction,
                fallbackTarget: targetLabel,
                statusMessage: `Trying ${targetLabel} before packing anything heavier...`,
              },
            };
          });
        },

        setCompactionSummary: (summary, enhancedPromptOrTurnId, originalSessionId, revealDurationMs) => {
          set((state) => ({
            ...(originalSessionId && originalSessionId !== state.currentSessionId
              ? {}
              : originalSessionId && state.compaction.turnId === null
                ? {}
                : state.compaction.turnId && originalSessionId && state.compaction.turnId !== enhancedPromptOrTurnId
                ? {}
                : state.compaction.phase === "continuing" || state.compaction.phase === "error"
                  ? {}
                  : {
                    compaction: {
                      ...state.compaction,
                      phase: "revealing",
                      statusMessage: "Memory crystal formed",
                      summary,
                      enhancedPrompt: originalSessionId ? null : enhancedPromptOrTurnId,
                      revealDurationMs: revealDurationMs ?? state.compaction.revealDurationMs,
                    },
                  }),
          }));
        },

        markCompactionRetrying: (turnId, originalSessionId) => {
          set((state) => {
            if (
              originalSessionId !== state.currentSessionId ||
              state.compaction.turnId !== turnId ||
              state.compaction.phase === "idle" ||
              state.compaction.phase === "continuing" ||
              state.compaction.phase === "error"
            ) {
              return state;
            }
            return {
              compaction: {
                ...state.compaction,
                phase: "continuing",
              },
            };
          });
        },

        setCompactionSkeleton: (turnId, originalSessionId) => {
          set((state) => {
            if (
              originalSessionId !== state.currentSessionId ||
              state.compaction.turnId !== turnId ||
              state.compaction.phase === "idle" ||
              state.compaction.phase === "continuing" ||
              state.compaction.phase === "error"
            ) {
              return state;
            }
            return {
              compaction: {
                ...state.compaction,
                phase: "skeleton",
                statusMessage: "Keeping the core thread.",
              },
            };
          });
        },

        setCompactionDepth4Attempt: (profileName, turnId, originalSessionId) => {
          set((state) => {
            if (
              originalSessionId !== state.currentSessionId ||
              state.compaction.turnId !== turnId ||
              state.compaction.phase === "idle" ||
              state.compaction.phase === "continuing" ||
              state.compaction.phase === "error"
            ) {
              return state;
            }
            return {
              compaction: {
                ...state.compaction,
                phase: "recovery_model",
                depth4ProfileName: profileName,
                statusMessage: `Using the recovery model (${profileName}).`,
              },
            };
          });
        },

        setCompactionUnavailable: (userFacingMessage, turnId, originalSessionId) => {
          set((state) => {
            if (
              originalSessionId !== state.currentSessionId ||
              (state.compaction.turnId !== null && state.compaction.turnId !== turnId) ||
              state.compaction.phase === "continuing"
            ) {
              return state;
            }
            return {
              compaction: {
                ...state.compaction,
                phase: "unavailable",
                statusMessage: userFacingMessage,
              },
            };
          });
        },

        setCompactionError: (error, turnId, originalSessionId, reason) => {
          set((state) => {
            if (state.compaction.phase === "idle") {
              warnIgnoredIdleCompactionError({
                turnId,
                currentTurnId: state.compaction.turnId,
                currentSessionId: state.currentSessionId,
                originalSessionId,
                error,
              });
              return state;
            }
            if (
              state.compaction.phase === "continuing" ||
              state.compaction.phase === "error" ||
              (originalSessionId && (
                originalSessionId !== state.currentSessionId ||
                (state.compaction.turnId !== null && state.compaction.turnId !== turnId)
              ))
            ) {
              return state;
            }
            return {
              compaction: {
                ...state.compaction,
                phase: "error",
                statusMessage: error,
                reason: reason ?? null,
              },
            };
          });
        },

        completeCompaction: (turnId, originalSessionId) => {
          set((state) => {
            if (
              originalSessionId &&
              (
                originalSessionId !== state.currentSessionId ||
                (state.compaction.turnId !== null && state.compaction.turnId !== turnId)
              )
            ) {
              return state;
            }
            return {
              compaction: {
                ...state.compaction,
                phase: "continuing",
              },
            };
          });
        },

        resetCompaction: () => {
          set({ compaction: createInitialCompactionState() });
        },

        performCompaction: (summary, depth, targetSessionId?) => {
          const state = get();
          const isBackground =
            targetSessionId != null &&
            targetSessionId !== state.currentSessionId;

          if (isBackground) {
            // SF5 durability gate: best-effort pre-compaction persist before clearing events.
            // Non-blocking — compaction proceeds even if persist fails (e.g., disk full)
            // to avoid memory overflow from context exhaustion.
            const preCompactionSession = state.loadedSessions.get(targetSessionId);
            if (preCompactionSession) {
              window.sessionsApi.upsert(asIpcSession(stripRuntime(preCompactionSession)))
                .then((r) => { if (r && !r.success) console.warn(`[sessionStore] SF5 pre-compaction persist failed for ${targetSessionId}`); })
                .catch((err) => { console.warn(`[sessionStore] SF5 pre-compaction persist rejected for ${targetSessionId}`, err); });
            }

            // Background session compaction: update loadedSessions instead of current session state.
            // Don't touch currentSessionEvents — those belong to the currently viewed session.
            // Also clear any buffered background events for the target session.
            takeBackgroundEventBuffer(targetSessionId);

            set((s) => {
              const loadedSession = s.loadedSessions.get(targetSessionId);
              if (!loadedSession) return s; // Session evicted — caller handles this

              const afterMessageIndex = loadedSession.messages.length - 1;
              const newBoundary: CompactionBoundary = {
                afterMessageIndex,
                summary,
                timestamp: Date.now(),
                depth,
              };

              const updatedSession: AgentSessionWithRuntime = {
                ...loadedSession,
                eventsByTurn: {},
                activeTurnId: null,
                isBusy: false,
                lastError: null,
                runtime: runtimeReducer.resetRuntime(),
                compactionBoundaries: [
                  ...(loadedSession.compactionBoundaries ?? []),
                  newBoundary,
                ],
                  };

              const nextMap = new Map(s.loadedSessions);
              nextMap.set(targetSessionId, updatedSession);
              return { loadedSessions: nextMap };
            });
          } else {
            // Foreground compaction: original behavior — clear current session events and state.
            // Stage 5 (F9 boundary flush): drain pending notification before
            // clearing so persistence subscribers observe the trailing-edge
            // counter for the pre-compaction events before the external Map
            // is wiped.
            flushPendingEventsVersionNotification();
            clearCurrentSessionEvents();
            set((s) => {
              const afterMessageIndex = s.messages.length - 1;
              const newBoundary: CompactionBoundary = {
                afterMessageIndex,
                summary,
                timestamp: Date.now(),
                depth,
              };

              return {
                activeTurnId: null,
                focusedTurnId: null,
                isBusy: false,
                lastError: null,
                lastErrorSource: null,
                // Reset runtime state
                runtime: runtimeReducer.resetRuntime(),
                // Phase 6 remediation: pair the post-clear state transition
                // with the trailing-edge counter so subscribers see the
                // foreground compaction boundary land atomically.
                eventsByTurnVersion: getCurrentSessionEventsVersion(),
                // Add the compaction boundary
                compactionBoundaries: [...s.compactionBoundaries, newBoundary],
              };
            });
            // Phase 6 remediation: drain the just-scheduled microtask so it
            // does not fire a redundant setState after the atomic boundary.
            flushPendingEventsVersionNotification();
          }
        },

        addUserMessageToLoadedSession: (sessionId, text) => {
          const loadedSession = get().loadedSessions.get(sessionId);
          if (!loadedSession) return null;

          const message: AgentTurnMessage = {
            id: createId(),
            turnId: TURN_ID_FALLBACK,
            role: "user",
            text,
            createdAt: Date.now(),
          };

          set((s) => {
            const session = s.loadedSessions.get(sessionId);
            if (!session) return s;

            const updatedSession: AgentSessionWithRuntime = {
              ...session,
              messages: [...session.messages, message],
              isBusy: true,
              lastError: null,
            };

            const nextMap = new Map(s.loadedSessions);
            nextMap.set(sessionId, updatedSession);
            return { loadedSessions: nextMap };
          });

          return message;
        },

        assignTurnToLoadedSessionMessage: (sessionId, messageId, turnId) => {
          set((s) => {
            const session = s.loadedSessions.get(sessionId);
            if (!session) return s;

            const updatedMessages = session.messages.map((msg) =>
              msg.id === messageId ? { ...msg, turnId } : msg,
            );

            const updatedSession: AgentSessionWithRuntime = {
              ...session,
              messages: updatedMessages,
              eventsByTurn: { ...session.eventsByTurn, [turnId]: [] },
              activeTurnId: turnId,
            };

            const nextMap = new Map(s.loadedSessions);
            nextMap.set(sessionId, updatedSession);
            return { loadedSessions: nextMap };
          });
        },

        clearLoadedSessionBusy: (sessionId) => {
          set((s) => {
            const session = s.loadedSessions.get(sessionId);
            if (!session || !session.isBusy) return s;
            const nextMap = new Map(s.loadedSessions);
            nextMap.set(sessionId, { ...session, isBusy: false });
            return { loadedSessions: nextMap };
          });
        },

        persistLoadedSession: (sessionId) => {
          const session = get().loadedSessions.get(sessionId);
          if (session) {
            window.sessionsApi.upsert(asIpcSession(stripRuntime(session)))
              .then((r) => { if (r && !r.success) console.warn(`[sessionStore] persist failed for ${sessionId}`, r?.error); })
              .catch((err) => { console.warn(`[sessionStore] persist rejected for ${sessionId}`, err); });
          }
        },

        setMemoryUpdateStatus: (status) => {
          set((state) => {
            if (status.originalSessionId && status.originalSessionId !== state.currentSessionId) {
              warnCrossSessionStatusSetterOnce({
                kind: 'memory-update',
                turnId: status.originalTurnId,
                currentSessionId: state.currentSessionId,
                originalSessionId: status.originalSessionId,
              });
              return state;
            }
            return {
              memoryUpdateStatusByTurn: {
                ...state.memoryUpdateStatusByTurn,
                [status.originalTurnId]: status,
              },
            };
          });
        },

        setMemoryUpdateStatusForSession: (sessionId, status) => {
          set((state) => {
            if (sessionId === state.currentSessionId) {
              return {
                memoryUpdateStatusByTurn: {
                  ...state.memoryUpdateStatusByTurn,
                  [status.originalTurnId]: status,
                },
              };
            }

            const loadedSession = state.loadedSessions.get(sessionId);
            if (!loadedSession) {
              return state;
            }

            const updatedLoadedSession: AgentSessionWithRuntime = {
              ...loadedSession,
              memoryUpdateStatusByTurn: {
                ...(loadedSession.memoryUpdateStatusByTurn ?? {}),
                [status.originalTurnId]: status,
              },
            };
            const loadedSessions = new Map(state.loadedSessions);
            loadedSessions.set(sessionId, updatedLoadedSession);
            return { loadedSessions };
          });
        },

        setSafetyEvalInFlight: (toolUseId, data) => {
          set((state) => ({
            safetyEvalInFlight: {
              ...state.safetyEvalInFlight,
              [toolUseId]: data,
            },
          }));
        },

        clearSafetyEvalInFlight: (toolUseId) => {
          set((state) => {
            if (!(toolUseId in state.safetyEvalInFlight)) return state;
            const { [toolUseId]: _, ...rest } = state.safetyEvalInFlight;
            return { safetyEvalInFlight: rest };
          });
        },

        setTimeSavedStatus: (status) => {
          set((state) => {
            if (status.originalSessionId && status.originalSessionId !== state.currentSessionId) {
              warnCrossSessionStatusSetterOnce({
                kind: 'time-saved',
                turnId: status.turnId,
                currentSessionId: state.currentSessionId,
                originalSessionId: status.originalSessionId,
              });
              return state;
            }
            return {
              timeSavedStatusByTurn: {
                ...state.timeSavedStatusByTurn,
                [status.turnId]: status,
              },
            };
          });
        },

        setTimeSavedStatusForSession: (sessionId, status) => {
          set((state) => {
            if (sessionId === state.currentSessionId) {
              return {
                timeSavedStatusByTurn: {
                  ...state.timeSavedStatusByTurn,
                  [status.turnId]: status,
                },
              };
            }

            const loadedSession = state.loadedSessions.get(sessionId);
            if (!loadedSession) {
              return state;
            }

            const updatedLoadedSession: AgentSessionWithRuntime = {
              ...loadedSession,
              timeSavedStatusByTurn: {
                ...(loadedSession.timeSavedStatusByTurn ?? {}),
                [status.turnId]: status,
              },
            };
            const loadedSessions = new Map(state.loadedSessions);
            loadedSessions.set(sessionId, updatedLoadedSession);
            return { loadedSessions };
          });
        },

        // Activity summary (260618 show-more-activity). Mirrors
        // setTimeSavedStatusForSession: write the top-level map when the summary
        // belongs to the current session (so the memoised MessageItem repaints),
        // else patch the loaded session map so it surfaces on next select. The
        // live broadcast carries an authoritative sessionId/turnId, so there is
        // no cross-session warning guard (unlike the status setters, whose
        // payload could be stale).
        setActivitySummaryForSession: (sessionId, turnId, summary) => {
          set((state) => {
            if (sessionId === state.currentSessionId) {
              return {
                activitySummaryByTurn: {
                  ...state.activitySummaryByTurn,
                  [turnId]: summary,
                },
              };
            }

            const loadedSession = state.loadedSessions.get(sessionId);
            if (!loadedSession) {
              return state;
            }

            const updatedLoadedSession: AgentSessionWithRuntime = {
              ...loadedSession,
              activitySummaryByTurn: {
                ...(loadedSession.activitySummaryByTurn ?? {}),
                [turnId]: summary,
              },
            };
            const loadedSessions = new Map(state.loadedSessions);
            loadedSessions.set(sessionId, updatedLoadedSession);
            return { loadedSessions };
          });
        },

        // Draft management actions
        setDraftForSession: (sessionId, text) => {
          // Belt-and-braces sanitiser at the write boundary. C1
          // single-source-of-truth for the NBSP-family corruption is in
          // `markdownToDoc`; this is defense in depth so a write that bypasses
          // hydration (e.g. picker insertion that bakes a paste payload, or
          // a future call site that hand-builds wire markdown) cannot land
          // corrupted text in the store. Logging is rate-limited per session
          // via `wasSessionSanitised` so a steady-state already-clean draft
          // does not log on every keystroke. See Stage 6 of
          // docs/plans/260501_composer_tiptap_atmention_bugfix.md.
          const sanitisedText = sanitiseCorruptedDraftText(text);
          if (sanitisedText !== text && !wasSessionSanitised(sessionId)) {
            console.warn(
              '[setDraftForSession] Sanitised corrupted composer draft on write',
              {
                sessionId,
                corruptionMarkers: detectCorruptionMarkers(text),
                originalLength: text.length,
                sanitisedLength: sanitisedText.length,
              },
            );
            markSessionSanitised(sessionId);
          }
          set((state) => {
            // Defensive check: don't write to deleted/soft-deleted sessions (Appendix C.5)
            // NOTE: We intentionally allow writes to sessions that don't have a summary yet.
            // This handles the race where debounced draft writes arrive after session switch
            // but before snapshotCurrentSession() created the summary. If we blocked those,
            // drafts typed just before switching would be silently lost.
            const summaryInHistory = state.sessionSummaries.find(
              (s) => s.id === sessionId,
            );
            const isDeleted = summaryInHistory?.deletedAt != null;
            if (isDeleted) {
              // No-op for deleted/soft-deleted sessions (throttled call after deletion)
              return state;
            }

            const now = Date.now();
            const prevDraftText = state.draftsBySessionId[sessionId]?.text;
            const prevHasDraft = Boolean(prevDraftText?.trim());
            const nextHasDraft = Boolean(sanitisedText.trim());

            // If text is empty, remove draft entry; otherwise update it
            const nextDrafts = nextHasDraft
              ? {
                  ...state.draftsBySessionId,
                  [sessionId]: { text: sanitisedText, updatedAt: now },
                }
              : omit(state.draftsBySessionId, sessionId);

            // When clearing a draft, also clear the stale draft from the LRU cache.
            // Without this, selectSession's rehydration logic sees the old draft in the
            // cached session and restores it. This matters especially for draft-only
            // sessions where snapshotCurrentSession() returns null (no content left),
            // so the cache is never updated via the normal snapshot path.
            let nextLoadedSessions:
              | Map<string, AgentSessionWithRuntime>
              | undefined;
            if (prevHasDraft && !nextHasDraft) {
              const cachedSession = state.loadedSessions.get(sessionId);
              if (cachedSession?.draft?.text?.trim()) {
                const clearedSession = { ...cachedSession, draft: undefined };
                nextLoadedSessions = new Map(state.loadedSessions);
                nextLoadedSessions.set(sessionId, clearedSession);
                // Re-persist to disk so the stale draft doesn't resurface
                // after LRU eviction or app restart.
                window.sessionsApi.upsert(asIpcSession(stripRuntime(clearedSession)))
                  .catch(() => { /* best-effort */ });
              }
            }

            // Keep summary draft presence in sync (but only when presence flips, not on every keystroke).
            // This avoids expensive sidebar recomputation while still ensuring draft-only sessions
            // are visible from sessionSummaries.
            const shouldUpdateSummary =
              prevHasDraft !== nextHasDraft && summaryInHistory;
            if (!shouldUpdateSummary) {
              return {
                draftsBySessionId: nextDrafts,
                ...(nextLoadedSessions
                  ? { loadedSessions: nextLoadedSessions }
                  : undefined),
              };
            }

            return {
              draftsBySessionId: nextDrafts,
              ...(nextLoadedSessions
                ? { loadedSessions: nextLoadedSessions }
                : undefined),
              // delete-authority: update-only (map over existing rows by id; never creates a row, never touches deletedAt)
              sessionSummaries: state.sessionSummaries.map((s) =>
                s.id === sessionId
                  ? {
                      ...s,
                      hasDraft: nextHasDraft,
                      draftPreview: nextHasDraft
                        ? createDraftPreviewSnippet(sanitisedText, 50)
                        : null,
                      draftUpdatedAt: nextHasDraft ? now : null,
                      updatedAt: Math.max(s.updatedAt ?? s.createdAt, now),
                    }
                  : s,
              ),
            };
          });
        },

        setDraft: (text) => {
          // Convenience wrapper that uses current session
          const sessionId = get().currentSessionId;
          get().setDraftForSession(sessionId, text);
        },

        getCurrentDraft: () => {
          const state = get();
          return state.draftsBySessionId[state.currentSessionId] ?? null;
        },

        setAnnotationsForSession: (sessionId, annotations) => {
          set((state) => {
            const prevHasAnnotations =
              (state.annotationsBySessionId[sessionId]?.length ?? 0) > 0;
            const nextHasAnnotations = annotations.length > 0;
            const nextAnnotationsBySessionId = nextHasAnnotations
              ? {
                  ...state.annotationsBySessionId,
                  [sessionId]: [...annotations],
                }
              : omit(state.annotationsBySessionId, sessionId);

            let nextLoadedSessions:
              | Map<string, AgentSessionWithRuntime>
              | undefined;
            if (prevHasAnnotations && !nextHasAnnotations) {
              const cachedSession = state.loadedSessions.get(sessionId);
              if (
                cachedSession &&
                (hasOwn(cachedSession, 'annotations') ||
                  (cachedSession.annotations?.length ?? 0) > 0)
              ) {
                const clearedSession = {
                  ...cachedSession,
                  annotations: undefined,
                };
                nextLoadedSessions = new Map(state.loadedSessions);
                nextLoadedSessions.set(sessionId, clearedSession);
                window.sessionsApi.upsert(asIpcSession(stripRuntime(clearedSession)))
                  .catch((err) => {
                    console.warn(
                      '[sessionStore] setAnnotationsForSession: empty-clear persist failed; session will rehydrate from stale disk state on next load',
                      { sessionId, error: err },
                    );
                  });
              }
            }

            const summaryInHistory = state.sessionSummaries.find(
              (s) => s.id === sessionId,
            );
            const shouldUpdateSummary =
              prevHasAnnotations !== nextHasAnnotations && summaryInHistory;
            if (!shouldUpdateSummary) {
              return {
                annotationsBySessionId: nextAnnotationsBySessionId,
                ...(nextLoadedSessions
                  ? { loadedSessions: nextLoadedSessions }
                  : undefined),
              };
            }

            const latestAnnotationCreatedAt = nextHasAnnotations
              ? Math.max(...annotations.map((annotation) => annotation.createdAt))
              : 0;

            return {
              annotationsBySessionId: nextAnnotationsBySessionId,
              ...(nextLoadedSessions
                ? { loadedSessions: nextLoadedSessions }
                : undefined),
              // delete-authority: update-only (map over existing rows by id; never creates a row, never touches deletedAt)
              sessionSummaries: state.sessionSummaries.map((s) =>
                s.id === sessionId
                  ? {
                      ...s,
                      hasAnnotations: nextHasAnnotations,
                      updatedAt: nextHasAnnotations
                        ? Math.max(
                            s.updatedAt ?? s.createdAt,
                            latestAnnotationCreatedAt,
                          )
                        : s.updatedAt,
                    }
                  : s,
              ),
            };
          });
        },

        getAnnotationsForSession: (sessionId) => {
          return get().annotationsBySessionId[sessionId] ?? [];
        },

        setDismissedQuestionBatchIdsForSession: (sessionId, batchIds) => {
          const uniqueBatchIds = [...new Set(batchIds)].sort();
          set((state) => {
            const existing = state.dismissedQuestionBatchIdsBySessionId[sessionId] ?? [];
            if (
              existing.length === uniqueBatchIds.length &&
              existing.every((batchId, index) => batchId === uniqueBatchIds[index])
            ) {
              return state;
            }

            return {
              dismissedQuestionBatchIdsBySessionId: {
                ...state.dismissedQuestionBatchIdsBySessionId,
                [sessionId]: uniqueBatchIds,
              },
            };
          });
        },

        // Atomic CAS upsert with awaited durable-persist acknowledgement.
        // Stage 6 of docs/plans/260501_composer_tiptap_atmention_bugfix.md.
        //
        // Persistence model: this store does NOT use Zustand's `persist`
        // middleware (`draftsBySessionId` is renderer-local in-memory state;
        // disk persistence happens elsewhere via `window.sessionsApi.upsert`
        // when the session snapshot lifecycle fires). Within this store the
        // Zustand `set()` callback is synchronous and atomic, so the CAS
        // check is genuinely race-free against any concurrent `set()` from
        // the same renderer thread. The awaited resolution uses a next-tick
        // scheduler (`setTimeout(0)`) so callers can chain follow-up actions
        // (e.g. localStorage delete) only after the in-memory state is
        // observable to subsequent `getState()` reads. The 5s timeout is the
        // safety net if the macrotask queue is blocked.
        upsertDraftDurable: async (sessionId, text, expectedCurrent) => {
          let casFailed = false;
          set((state) => {
            if (expectedCurrent !== undefined) {
              const currentText =
                state.draftsBySessionId[sessionId]?.text ?? '';
              if (currentText !== expectedCurrent) {
                casFailed = true;
                return state; // unchanged
              }
            }
            const existingDraft = state.draftsBySessionId[sessionId];
            const updatedDraft: DraftContent = {
              ...existingDraft,
              text,
              updatedAt: Date.now(),
            };
            return {
              ...state,
              draftsBySessionId: {
                ...state.draftsBySessionId,
                [sessionId]: updatedDraft,
              },
            };
          });
          if (casFailed) {
            return { ok: false, reason: 'concurrent_write' };
          }
          // Await the next macrotask so callers see the updated state via
          // `getState()` before they decide whether to delete the localStorage
          // original. Race against a 5s timeout so a stalled event-loop never
          // pins the migration indefinitely.
          try {
            await Promise.race([
              new Promise<void>((resolve) => setTimeout(resolve, 0)),
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), 5000),
              ),
            ]);
            return { ok: true };
          } catch {
            return { ok: false, reason: 'timeout' };
          }
        },

        clearInterruptedTurnData: (turnId) => {
          // Phase 6.5 remediation: drain pending notification before
          // removing the interrupted turn's events from the external Map so
          // persistence subscribers observe the trailing-edge counter for
          // the pre-removal state before the Map mutates.
          flushPendingEventsVersionNotification();
          removeCurrentSessionEventTurn(turnId);
          set((state) => {
            // Remove ALL messages for this turn (including user message)
            // The resume flow will create a fresh user message via submitQueuedMessage
            const filteredMessages = state.messages.filter(
              (msg) => msg.turnId !== turnId,
            );

            return {
              messages: filteredMessages,
              activeTurnId: null,
              focusedTurnId: null,
              isBusy: false,
              lastError: null,
              lastErrorSource: null,
              // Reset runtime state
              runtime: runtimeReducer.resetRuntime(),
              // Phase 6.5 remediation: pair the post-removal visible state
              // with the trailing-edge counter so subscribers see the
              // filtered messages and the new eventsByTurnVersion in the
              // same notification.
              eventsByTurnVersion: getCurrentSessionEventsVersion(),
            };
          });
          // Phase 6.5 remediation: drain the just-scheduled microtask so a
          // redundant setState does not fire after the atomic boundary.
          flushPendingEventsVersionNotification();
        },

        markSessionHasPendingRecording: (sessionId) => {
          set((state) => ({
            pendingRecordingSessionIds: new Set([
              ...state.pendingRecordingSessionIds,
              sessionId,
            ]),
          }));
        },

        clearSessionPendingRecording: (sessionId) => {
          set((state) => {
            const next = new Set(state.pendingRecordingSessionIds);
            next.delete(sessionId);
            return { pendingRecordingSessionIds: next };
          });
        },

        appendThinkingDelta: (turnId, delta) => {
          accumulateThinkingDelta(turnId, delta);
          scheduleThinkingFlush(get, set);
        },

        clearThinkingBuffer: (turnId) => {
          // Discard any pending delta for this turn (no need to flush it)
          discardPendingThinkingDelta(turnId);
          set((state) => {
            if (!(turnId in state.thinkingTextByTurn)) {
              return state;
            }
            const { [turnId]: _, ...rest } = state.thinkingTextByTurn;
            return { thinkingTextByTurn: rest };
          });
        },

        markAnswerStreaming: (turnId) => {
          set((state) => {
            if (state.answerStreamingTurnIds.has(turnId)) return state; // idempotent
            return { answerStreamingTurnIds: new Set([...state.answerStreamingTurnIds, turnId]) };
          });
        },
        clearAnswerStreaming: (turnId) => {
          set((state) => {
            if (!state.answerStreamingTurnIds.has(turnId)) return state;
            const next = new Set(state.answerStreamingTurnIds);
            next.delete(turnId);
            return { answerStreamingTurnIds: next };
          });
        },

        addDoneAfterTurnId: (turnId) => {
          set((state) => ({
            doneAfterTurnIds: new Set([...state.doneAfterTurnIds, turnId]),
          }));
        },
        removeDoneAfterTurnId: (turnId) => {
          set((state) => {
            const next = new Set(state.doneAfterTurnIds);
            next.delete(turnId);
            return { doneAfterTurnIds: next };
          });
        },
        markRoleNotConfiguredToastSeen: (sessionId, role) => {
          const key = `${sessionId}:${role}`;
          if (get().roleNotConfiguredToastKeys.has(key)) {
            return false;
          }
          set((state) => ({
            roleNotConfiguredToastKeys: new Set([
              ...state.roleNotConfiguredToastKeys,
              key,
            ]),
          }));
          return true;
        },

        // Multi-session pending turn management
        setPendingTurnForSession: (sessionId, turn) => {
          const current = get().pendingNetworkRetryTurns;

          // Delete old cache files if overwriting existing entry for same session
          const existing = current[sessionId];
          if (existing?.attachmentCacheIds?.length) {
            window.agentApi
              .deleteCachedAttachments({
                cacheIds: existing.attachmentCacheIds,
              })
              .catch(() => {
                /* ignore cleanup errors */
              });
          }

          const newTurns = { ...current, [sessionId]: turn };

          // Enforce max limit with FIFO eviction
          const keys = Object.keys(newTurns);
          if (keys.length > MAX_PENDING_NETWORK_RETRY_TURNS) {
            // Sort by failedAt to find oldest
            const sorted = keys.sort(
              (a, b) =>
                (newTurns[a]?.failedAt ?? 0) - (newTurns[b]?.failedAt ?? 0),
            );
            // Remove oldest entries until within limit
            const toRemove = sorted.slice(
              0,
              keys.length - MAX_PENDING_NETWORK_RETRY_TURNS,
            );
            for (const key of toRemove) {
              // Delete cache files for evicted entries
              const evicted = newTurns[key];
              if (evicted?.attachmentCacheIds?.length) {
                window.agentApi
                  .deleteCachedAttachments({
                    cacheIds: evicted.attachmentCacheIds,
                  })
                  .catch(() => {
                    /* ignore cleanup errors */
                  });
              }
              delete newTurns[key];
            }
          }

          set({ pendingNetworkRetryTurns: newTurns });

          // Persist to localStorage for restart survival (fire-and-forget)
          persistRetry(localStorage, {
            sessionId,
            userMessageText: turn.userMessageText,
            failedAt: turn.failedAt,
            retryCount: turn.retryCount,
            attachmentCacheIds: turn.attachmentCacheIds,
          });
        },

        clearPendingTurnForSession: (sessionId, deleteCache = false) => {
          const current = get().pendingNetworkRetryTurns;
          const turn = current[sessionId];

          if (turn) {
            // Optionally delete cache files
            if (deleteCache && turn.attachmentCacheIds?.length) {
              window.agentApi
                .deleteCachedAttachments({
                  cacheIds: turn.attachmentCacheIds,
                })
                .catch(() => {
                  /* ignore cleanup errors */
                });
            }

            const { [sessionId]: _, ...rest } = current;
            set({ pendingNetworkRetryTurns: rest });
            clearPersistedRetry(localStorage, sessionId);
          }
        },

        clearAllPendingTurns: (deleteCache = false) => {
          const current = get().pendingNetworkRetryTurns;

          if (deleteCache) {
            // Collect all cache IDs and delete
            const allCacheIds: string[] = [];
            for (const turn of Object.values(current)) {
              if (turn.attachmentCacheIds?.length) {
                allCacheIds.push(...turn.attachmentCacheIds);
              }
            }
            if (allCacheIds.length > 0) {
              window.agentApi
                .deleteCachedAttachments({
                  cacheIds: allCacheIds,
                })
                .catch(() => {
                  /* ignore cleanup errors */
                });
            }
          }

          set({ pendingNetworkRetryTurns: {} });
          clearAllPersistedRetries(localStorage);
        },

        getPendingTurnCount: () => {
          return Object.keys(get().pendingNetworkRetryTurns).length;
        },

        getAllPendingTurns: () => {
          const turns = Object.values(get().pendingNetworkRetryTurns);
          // Sort by failedAt ascending (oldest first - FIFO)
          return turns.sort((a, b) => a.failedAt - b.failedAt);
        },

        setIsResuming: (value) => {
          set({ isResuming: value });
        },

        setResumeModalSnoozed: (value) => {
          set({ resumeModalSnoozed: value });
        },

        // Legacy single-turn API (backward compatibility)
        setPendingNetworkRetryTurn: (turn) => {
          if (turn) {
            // Add retryCount if not present for backward compat
            const turnWithRetry = { ...turn, retryCount: turn.retryCount ?? 0 };
            get().setPendingTurnForSession(turn.sessionId, turnWithRetry);
          } else {
            // Clear all (legacy behavior was single turn)
            set({ pendingNetworkRetryTurns: {} });
            clearAllPersistedRetries(localStorage);
          }
        },

        clearPendingNetworkRetryTurn: () => {
          // Legacy: clears all pending turns
          set({ pendingNetworkRetryTurns: {} });
          clearAllPersistedRetries(localStorage);
        },

        _getSessionCounter: () => sessionCounter,
        _incrementSessionCounter: () => {
          sessionCounter += 1;
        },
      })),
      {
        name: "SessionStore",
        enabled: import.meta.env.DEV,
      },
    ),
  );

  // Stage 1 / P3 (260502): dev-only shadow-writer assertion. This runs after
  // each settled Zustand write and warns (never throws) when a non-canonical
  // write re-enters busy state for a turn that is already terminal/terminated.
  const enableShadowBusyDevAssertion =
    import.meta.env.DEV || import.meta.env.MODE === 'test';
  if (enableShadowBusyDevAssertion) {
    store.subscribe((nextState, prevState) => {
      maybeAssertShadowBusyReflipForCurrentSession(prevState, nextState);
      maybeAssertShadowBusyReflipForLoadedSessions(prevState, nextState);
    });
  }

  const disposeNotifier = registerEventsVersionNotifier((version) => {
    store.setState({ eventsByTurnVersion: version });
  });

  // Phase 6 remediation (260508 Stage 5): expose the per-store notifier
  // unregister hook so tests can release stale notifiers in afterEach. The
  // production singleton (`useSessionStore`) lives for the process lifetime
  // so it never calls dispose; tests opt-in via the returned method.
  Object.defineProperty(store, "disposeEventsVersionNotifier", {
    value: disposeNotifier,
    configurable: true,
    enumerable: false,
    writable: false,
  });

  return store as typeof store & { disposeEventsVersionNotifier: () => void };
};

export const useSessionStore = createSessionStore();

export const getSessionStoreState = () => useSessionStore.getState();
export const subscribeToSessionStore = useSessionStore.subscribe;

// ==============================================================================
// Derived Selectors
// ==============================================================================

export const isCurrentSessionProjectionBusy = (
  state: Pick<SessionStoreState, 'activeTurnId'>,
): boolean =>
  getCurrentSessionProjectedLiveness(state.activeTurnId).status === 'running';

const maybeWarnLegacyBusyRead = (
  state: Pick<SessionStoreState, 'currentSessionId' | 'isBusy' | 'activeTurnId'>,
): void => {
  if (!(import.meta.env.DEV || import.meta.env.MODE === 'test')) {
    return;
  }
  const projectedBusy = isCurrentSessionProjectionBusy(state);
  if (state.isBusy === projectedBusy) {
    return;
  }
  const sessionId = state.currentSessionId || '__missing_current_session_id__';
  const warningKey = `${sessionId}:${state.activeTurnId ?? '__null_turn__'}:${state.isBusy ? 'busy' : 'idle'}:${projectedBusy ? 'busy' : 'idle'}`;
  if (legacyBusyReadWarningKeys.has(warningKey)) {
    return;
  }
  legacyBusyReadWarningKeys.add(warningKey);
  console.warn(
    '[sessionStore] Read-side guard: message-derived isBusy differs from projected liveness; consumers must read the projection.',
    {
      sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
      declaredActiveTurnIdHash: state.activeTurnId
        ? hashSessionIdForBreadcrumb(state.activeTurnId)
        : null,
      scalarIsBusy: state.isBusy,
      projectedIsBusy: projectedBusy,
    },
  );
};

/**
 * Selector that returns true when UI should show "idle" state.
 *
 * This treats `isStopping` as "optimistically idle" - when the user clicks Stop,
 * the UI immediately reflects an idle state even before the backend confirms.
 *
 * Use this ONLY for UI display purposes (thinking indicators, button states, etc.).
 * Do NOT use for backend logic like message queue draining - those should use raw `isBusy`.
 */
export const selectIsEffectivelyIdleForUi = (state: SessionStoreState) =>
  !isCurrentSessionProjectionBusy(state) || state.isStopping;

// Used by Stage 6 (main-process indexer/embedder pause via main-process isAnyTurnActive()).
// The body-level [data-active-work] uses selectCurrentSessionIsBusy (foreground-only).
// Do not delete this selector without checking docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md.
export const selectHasAnyActiveTurn = (state: SessionStoreState): boolean =>
  isCurrentSessionProjectionBusy(state)
  || state.sessionSummaries.some(
    (summary) => summary.id !== state.currentSessionId && summary.isBusy,
  );

/**
 * Selector that returns true when the foreground (current) session is busy.
 *
 * Foreground-only lens: idle Conversation B should keep its blur attribute
 * even while background Conversation A is streaming. Used by Stage 3's
 * body-level `data-active-work` attribute (perceived-work UI).
 *
 * `state.isBusy` already tracks the current session because Zustand mirrors
 * the active session's busy flag at the top level; we cross-check against
 * `sessionSummaries` to stay correct during cloud-sync transients where the
 * current session's summary lags the top-level flag.
 *
 * Plan reference: docs/plans/260508_active_work_cpu_gpu_architectural_rebuild.md Stage 1 (R2-2).
 */
export const selectCurrentSessionIsBusy = (state: SessionStoreState): boolean => {
  const currentId = state.currentSessionId;
  if (!currentId) return false;
  maybeWarnLegacyBusyRead(state);
  return isCurrentSessionProjectionBusy(state);
};
