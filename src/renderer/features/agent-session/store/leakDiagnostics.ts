/**
 * Memory-leak / byte-attribution diagnostics for the renderer session store.
 *
 * Extracted from `sessionStore.ts` (behavior-preserving Stage 7). These are the
 * dev:perf / production memory-diagnostic readers used by the REBEL-5D5 leak
 * investigation. They are pure read-only estimators: every function takes its
 * inputs as parameters (loadedSessions, sessionSummaries, the Zustand state
 * maps) or reads the three module-level Maps via their encapsulated diagnostics
 * accessors (`getCurrentSessionEventsMapForDiagnostics`,
 * `getBackgroundEventBuffersForDiagnostics`,
 * `getPendingThinkingDeltasForDiagnostics`) — never the raw Maps. There is no
 * store-closure coupling, so nothing here is imported back into the store;
 * `sessionStore.ts` only re-exports the six reader functions so the canonical
 * .../store/sessionStore import path keeps resolving.
 *
 * @see ./sessionStore.ts — the store implementation
 * @see docs-private/investigations/260506_renderer_memory_leak.md — the investigation
 * @see docs/plans/260622_refactor-session-store/PLAN.md — extraction plan
 */
import type { AgentEvent } from "@shared/types";
import type { AgentSessionWithRuntime } from "../types";
import { getPendingThinkingDeltasForDiagnostics } from "./thinkingDeltaScheduler";
import { getCurrentSessionEventsMapForDiagnostics } from "./currentSessionEvents";
import { getBackgroundEventBuffersForDiagnostics } from "./backgroundEventBuffer";

/**
 * Non-allocating recursive byte estimator for diagnostic use. Walks the value
 * structure summing string lengths plus a small overhead per scalar/container,
 * without ever materialising a serialized copy. We deliberately avoid
 * `JSON.stringify(value).length` here because the renderer leak we are
 * diagnosing (REBEL-5D5) involves payloads that may already be hundreds of MB;
 * stringifying them every 5 minutes would transiently double the heap pressure
 * we are trying to measure. Cycles are handled via a WeakSet, and recursion is
 * depth-capped so a pathological structure cannot stall the renderer.
 */
const ESTIMATE_VALUE_BYTES_MAX_DEPTH = 64;
const estimateValueBytes = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): number => {
  if (value == null) return 0;
  if (depth > ESTIMATE_VALUE_BYTES_MAX_DEPTH) return 0;
  const t = typeof value;
  if (t === "string") return (value as string).length;
  if (t === "number") return 8;
  if (t === "boolean") return 4;
  if (t === "bigint") return 16;
  if (t !== "object") return 0;
  const obj = value as object;
  if (seen.has(obj)) return 0;
  seen.add(obj);
  let total = 16;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      total += estimateValueBytes(item, seen, depth + 1);
    }
    return total;
  }
  for (const [key, v] of Object.entries(obj as Record<string, unknown>)) {
    total += key.length + estimateValueBytes(v, seen, depth + 1);
  }
  return total;
};

/**
 * Sum bytes for an event's heavy ancillary payloads — fields the simple
 * detail/text estimator misses. These are the suspected dominant heap
 * contributors per `docs-private/investigations/260506_renderer_memory_leak.md`.
 */
const measureEventPayloadBytes = (
  evt: AgentEvent,
): { imageContentBytes: number; toolResultBytes: number; mcpAppUiMetaBytes: number } => {
  let imageContentBytes = 0;
  let toolResultBytes = 0;
  let mcpAppUiMetaBytes = 0;
  if (evt.type === "tool") {
    if (evt.imageContent) {
      for (const block of evt.imageContent) {
        imageContentBytes += block.data?.length ?? 0;
      }
    }
    if (evt.toolResult) {
      toolResultBytes = estimateValueBytes(evt.toolResult);
    }
    if (evt.mcpAppUiMeta) {
      mcpAppUiMetaBytes = estimateValueBytes(evt.mcpAppUiMeta);
    }
  }
  return { imageContentBytes, toolResultBytes, mcpAppUiMetaBytes };
};

/**
 * Cheap counters for module-level state — counts only, no payload walks.
 *
 * Safe to call from the production renderer memory diagnostic every 5 minutes
 * because every operation is O(1) Map size lookup or O(N) length sums (no
 * recursion into event payloads, no `estimateValueBytes`, no JSON.stringify).
 *
 * For the expensive payload-aware byte attribution that walks `imageContent`,
 * `toolResult`, and `mcpAppUiMeta`, use `getLeakDiagnostics()` instead — that
 * one is gated to `VITE_PERFORMANCE === 'true'` (dev:perf) because Stage 1+2
 * of the REBEL-5D5 investigation showed those buckets read ~0 KB even at
 * multi-GB heap, so the cost was not buying us actionable signal in prod.
 * See `docs-private/investigations/260506_renderer_memory_leak.md` for the timeline.
 */
export const getCheapLeakCounters = (): {
  backgroundEventBuffersSessions: number;
  backgroundEventBuffersTotal: number;
  pendingThinkingDeltasKeys: number;
} => {
  const bgBuffers = getBackgroundEventBuffersForDiagnostics();
  let bgTotal = 0;
  for (const entries of bgBuffers.values()) {
    bgTotal += entries.length;
  }
  return {
    backgroundEventBuffersSessions: bgBuffers.size,
    backgroundEventBuffersTotal: bgTotal,
    pendingThinkingDeltasKeys: getPendingThinkingDeltasForDiagnostics().size,
  };
};

/** Dev:perf diagnostics — estimate memory footprint of module-level data structures. */
export const getLeakDiagnostics = (): {
  currentSessionEventsTurns: number;
  currentSessionEventsTotal: number;
  currentSessionEventsEstimatedKB: number;
  /** imageContent (base64) bytes across active-session tool events — unmeasured by the basic estimator. */
  currentSessionImageContentKB: number;
  /** toolResult (MCP App payload) bytes across active-session tool events. */
  currentSessionToolResultKB: number;
  /** mcpAppUiMeta bytes across active-session tool events. */
  currentSessionMcpAppUiMetaKB: number;
  backgroundEventBuffersSessions: number;
  backgroundEventBuffersTotal: number;
  backgroundEventBuffersEstimatedKB: number;
  /** Heavy payload bytes on background-buffered tool events. */
  backgroundEventPayloadKB: number;
  pendingThinkingDeltasKeys: number;
} => {
  let csEventsTotal = 0;
  let csEventsEstBytes = 0;
  let csImageBytes = 0;
  let csToolResultBytes = 0;
  let csMcpAppUiMetaBytes = 0;
  for (const events of getCurrentSessionEventsMapForDiagnostics().values()) {
    csEventsTotal += events.length;
    for (const evt of events) {
      csEventsEstBytes +=
        ("detail" in evt ? evt.detail.length : 0) +
        ("text" in evt ? evt.text.length : 0) +
        200;
      const payload = measureEventPayloadBytes(evt);
      csImageBytes += payload.imageContentBytes;
      csToolResultBytes += payload.toolResultBytes;
      csMcpAppUiMetaBytes += payload.mcpAppUiMetaBytes;
    }
  }

  const bgBuffers = getBackgroundEventBuffersForDiagnostics();
  let bgTotal = 0;
  let bgEstBytes = 0;
  let bgPayloadBytes = 0;
  for (const entries of bgBuffers.values()) {
    bgTotal += entries.length;
    for (const entry of entries) {
      const evt = entry.event;
      bgEstBytes +=
        ("detail" in evt ? evt.detail.length : 0) +
        ("text" in evt ? evt.text.length : 0) +
        200;
      const payload = measureEventPayloadBytes(evt);
      bgPayloadBytes += payload.imageContentBytes + payload.toolResultBytes + payload.mcpAppUiMetaBytes;
    }
  }

  return {
    currentSessionEventsTurns: getCurrentSessionEventsMapForDiagnostics().size,
    currentSessionEventsTotal: csEventsTotal,
    currentSessionEventsEstimatedKB: Math.round(csEventsEstBytes / 1024),
    currentSessionImageContentKB: Math.round(csImageBytes / 1024),
    currentSessionToolResultKB: Math.round(csToolResultBytes / 1024),
    currentSessionMcpAppUiMetaKB: Math.round(csMcpAppUiMetaBytes / 1024),
    backgroundEventBuffersSessions: bgBuffers.size,
    backgroundEventBuffersTotal: bgTotal,
    backgroundEventBuffersEstimatedKB: Math.round(bgEstBytes / 1024),
    backgroundEventPayloadKB: Math.round(bgPayloadBytes / 1024),
    pendingThinkingDeltasKeys: getPendingThinkingDeltasForDiagnostics().size,
  };
};

/** Estimate total tool archive memory across all loaded sessions. */
export const getToolArchiveDiagnostics = (
  loadedSessions: Map<string, AgentSessionWithRuntime>,
): {
  totalArchiveEntries: number;
  totalArchiveEstimatedKB: number;
} => {
  let totalEntries = 0;
  let totalChars = 0;
  for (const session of loadedSessions.values()) {
    const archive = session.toolDetailArchive;
    if (!archive) continue;
    const entries = Object.values(archive);
    totalEntries += entries.length;
    for (const entry of entries) {
      totalChars += (entry.input?.length ?? 0) + (entry.output?.length ?? 0);
    }
  }
  return {
    totalArchiveEntries: totalEntries,
    totalArchiveEstimatedKB: Math.round(totalChars / 1024),
  };
};

/**
 * Payload-aware byte estimate for the LRU-cached `loadedSessions`. Counts
 * `messages[].text + attachmentTexts` plus the heavy event ancillary fields
 * (imageContent, toolResult, mcpAppUiMeta) that the basic estimator misses.
 * Compaction preserves these payloads (see `eventCompaction.ts`), so cached
 * sessions can carry hundreds of MB even when their `eventsByTurnKB` looks small.
 *
 * Pass `excludeSessionId` to skip a session you are reporting separately (the
 * caller usually wants to exclude `currentSessionId` so its `messages` and
 * `attachmentTexts` aren't double-counted alongside the basic diagnostic's
 * `currentMessagesKB` field).
 */
export const getLoadedSessionsPayloadDiagnostics = (
  loadedSessions: Map<string, AgentSessionWithRuntime>,
  excludeSessionId?: string | null,
): {
  messagesKB: number;
  attachmentTextsKB: number;
  eventDetailKB: number;
  imageContentKB: number;
  toolResultKB: number;
  mcpAppUiMetaKB: number;
} => {
  let messagesBytes = 0;
  let attachmentTextsBytes = 0;
  let eventDetailBytes = 0;
  let imageBytes = 0;
  let toolResultBytes = 0;
  let mcpAppUiMetaBytes = 0;
  for (const [sessionId, session] of loadedSessions.entries()) {
    if (excludeSessionId && sessionId === excludeSessionId) continue;
    for (const message of session.messages ?? []) {
      messagesBytes += (message.text?.length ?? 0);
      const texts = message.attachmentTexts;
      if (texts) {
        for (const value of Object.values(texts)) {
          attachmentTextsBytes += value?.length ?? 0;
        }
      }
    }
    for (const events of Object.values(session.eventsByTurn ?? {})) {
      for (const evt of events) {
        eventDetailBytes +=
          ("detail" in evt ? evt.detail.length : 0) +
          ("text" in evt ? evt.text.length : 0);
        const payload = measureEventPayloadBytes(evt);
        imageBytes += payload.imageContentBytes;
        toolResultBytes += payload.toolResultBytes;
        mcpAppUiMetaBytes += payload.mcpAppUiMetaBytes;
      }
    }
  }
  return {
    messagesKB: Math.round(messagesBytes / 1024),
    attachmentTextsKB: Math.round(attachmentTextsBytes / 1024),
    eventDetailKB: Math.round(eventDetailBytes / 1024),
    imageContentKB: Math.round(imageBytes / 1024),
    toolResultKB: Math.round(toolResultBytes / 1024),
    mcpAppUiMetaKB: Math.round(mcpAppUiMetaBytes / 1024),
  };
};

/**
 * Stage 2 dev:perf-only diagnostics — measures the now-leading byte-attribution
 * gaps after Stage 1 falsified the dominant-payload hypothesis on 2026-05-11
 * (heap 2.5 GB while every Stage 1 bucket reported ~0 KB). See
 * `docs-private/investigations/260506_renderer_memory_leak.md` § Layer 1 Reproduction.
 *
 * These helpers are deliberately gated to `VITE_PERFORMANCE=true` callers; the
 * sessionSummaries deep walk visits thousands of entries per cycle on real
 * users (2,443 on greg's machine) and should not run on the production hot path.
 */
export const getSessionSummariesPayloadDiagnostics = (
  // delete-authority: type (diagnostics parameter, not a write)
  sessionSummaries: readonly unknown[],
): { count: number; totalKB: number } => {
  let bytes = 0;
  for (const summary of sessionSummaries) {
    bytes += estimateValueBytes(summary);
  }
  return {
    count: sessionSummaries.length,
    totalKB: Math.round(bytes / 1024),
  };
};

/**
 * Byte sizes for Zustand state maps the Stage 1 instrumentation only counted by
 * key. The `pendingThinkingDeltas` Map is module-level (not in state), so it is
 * read via the encapsulated `getPendingThinkingDeltasForDiagnostics` accessor
 * rather than from `state`.
 */
export const getStateMapsByteDiagnostics = (state: {
  autoDoneBySessionId: Record<string, unknown>;
  draftsBySessionId: Record<string, unknown>;
  memoryUpdateStatusByTurn: Record<string, unknown>;
  timeSavedStatusByTurn: Record<string, unknown>;
}): {
  autoDoneKB: number;
  draftsKB: number;
  memoryStatusKB: number;
  timeSavedStatusKB: number;
  thinkingDeltasKB: number;
} => {
  let thinkingDeltasBytes = 0;
  for (const [k, v] of getPendingThinkingDeltasForDiagnostics()) {
    thinkingDeltasBytes += k.length + v.length;
  }
  return {
    autoDoneKB: Math.round(estimateValueBytes(state.autoDoneBySessionId) / 1024),
    draftsKB: Math.round(estimateValueBytes(state.draftsBySessionId) / 1024),
    memoryStatusKB: Math.round(estimateValueBytes(state.memoryUpdateStatusByTurn) / 1024),
    timeSavedStatusKB: Math.round(estimateValueBytes(state.timeSavedStatusByTurn) / 1024),
    thinkingDeltasKB: Math.round(thinkingDeltasBytes / 1024),
  };
};
