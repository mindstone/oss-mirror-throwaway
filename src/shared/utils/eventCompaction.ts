import type { AgentEvent } from '@shared/types';
import { COMPACTION_POLICY_FROM_MANIFEST } from '@shared/contracts/agentEventManifest';
import { isSubAgentTool, sanitizeToolImagePayloadForRefs } from './eventSanitization';
import { TOOL_PATH_KEYS, extractPathsFromMalformedJson } from './pathExtraction';
import {
  safeParseDetail,
  MAX_STRUCTURED_DETAIL_PARSE_BYTES,
} from '@shared/utils/safeParseDetail';

const SUBAGENT_IDENTITY_KEYS = ['subagent_type', 'agent', 'description'] as const;

/**
 * Extract subagent identity from a subagent tool start detail.
 * Preserves the agent name/type so subagent pills survive compaction.
 */
const extractSubAgentCompactDetail = (detail: string): string => {
  if (!detail) return '';
  // BOUNDED via safeParseDetail at the structured budget (1 MiB): preserves
  // sub-agent identity for realistic details; pathological >1MiB input falls
  // through to '' (same as a parse failure).
  const result = safeParseDetail(detail, { maxBytes: MAX_STRUCTURED_DETAIL_PARSE_BYTES });
  if (result.ok) {
    const parsed = result.value as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return '';

    const compact: Record<string, string> = {};
    for (const key of SUBAGENT_IDENTITY_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.length > 0) {
        compact[key] = value;
      }
    }
    if (Object.keys(compact).length > 0) {
      return JSON.stringify(compact);
    }
  }
  return '';
};

/**
 * Extract minimal file-path JSON from a tool event detail.
 * Preserves just enough for extractFileOperations / categorizeFileActivity
 * to identify which files were touched, while discarding large content payloads.
 *
 * Returns '' when no path can be extracted.
 */
const extractCompactDetail = (detail: string): string => {
  if (!detail) return '';

  // BOUNDED via safeParseDetail (256 KiB default — path extraction only reads
  // small scalar fields). On a malformed OR over-budget detail, fall back to
  // regex path extraction (identical for ≤budget input).
  const result = safeParseDetail(detail);
  if (result.ok) {
    const parsed = result.value as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return '';

    const compact: Record<string, string> = {};
    for (const key of TOOL_PATH_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.length > 0) {
        compact[key] = value;
      }
    }
    if (Object.keys(compact).length > 0) {
      return JSON.stringify(compact);
    }

    if (Array.isArray(parsed.paths) && parsed.paths.length > 0 &&
        parsed.paths.every((p: unknown) => typeof p === 'string')) {
      return JSON.stringify({ paths: parsed.paths });
    }
  } else {
    // Parse declined (malformed, or detail truncated by sanitization, or
    // over-budget). Fall back to regex extraction for path values.
    const recovered = extractPathsFromMalformedJson(detail);
    if (Object.keys(recovered).length > 0) {
      return JSON.stringify(recovered);
    }
  }

  return '';
};

/**
 * Compaction policy for each AgentEvent type — derived from the AgentEvent
 * manifest (R2 Stage 3a-L1 cutover, 2026-05-01).
 *
 * - 'keep':    Preserve with all fields (semantic state needed post-compaction)
 * - 'compact': Keep but strip large payloads (structural metadata only)
 * - 'drop':    Discard entirely (ephemeral, transient, or lifecycle-only)
 *
 * The manifest's `compactionPolicy` axis (per-variant) is the single source of
 * truth. Adding a new AgentEvent variant requires declaring its policy at the
 * manifest entry. The local `satisfies Record<AgentEvent['type'], …>` guard is
 * preserved as a Stage-3 cross-check: it would fail at compile time if the
 * `AgentEvent` discriminated-union (declared in `src/shared/types`) drifted
 * out of sync with the manifest's key set — catching either side regressing
 * independently. Manifest-internal exhaustiveness is enforced separately by
 * `agentEventManifest.test.ts`.
 *
 * Postmortems referenced by this policy: 260401_user_question_compaction,
 * 260331_cross_conversation_compaction.
 */
const COMPACTION_POLICY = COMPACTION_POLICY_FROM_MANIFEST satisfies Record<
  AgentEvent['type'],
  'keep' | 'compact' | 'drop'
>;

/**
 * Compacts a completed turn's events for in-memory storage.
 *
 * Strips large string payloads (`detail`, `text`) from events that are no
 * longer needed after a turn completes, while preserving the structural
 * metadata needed by UI components (tool summaries, step windows, usage
 * aggregation, inline images).
 *
 * Full-fidelity events remain on disk (persistence runs before compaction).
 */
export const compactTurnEvents = (events: AgentEvent[]): AgentEvent[] => {
  const compacted: AgentEvent[] = [];

  for (const event of events) {
    const policy = COMPACTION_POLICY[event.type as AgentEvent['type']] as
      | 'keep' | 'compact' | 'drop'
      | undefined;

    // Unknown types (e.g. forward-version data from disk) are preserved to
    // avoid silent data loss. The compile-time `satisfies` guard above catches
    // missing entries for known types; this handles runtime-only unknowns.
    if (policy === undefined || policy === 'keep') {
      compacted.push(event);
      continue;
    }

    if (policy === 'drop') continue;

    // policy === 'compact' — type-specific payload stripping
    switch (event.type) {
      case 'tool': {
        const isSubAgent = event.stage === 'start' && isSubAgentTool(event.toolName);
        const compactedToolEvent: Extract<AgentEvent, { type: 'tool' }> = {
          type: 'tool',
          toolName: event.toolName,
          toolUseId: event.toolUseId,
          parentToolUseId: event.parentToolUseId,
          detail: isSubAgent
            ? extractSubAgentCompactDetail(event.detail) || extractCompactDetail(event.detail)
            : extractCompactDetail(event.detail),
          stage: event.stage,
          timestamp: event.timestamp,
          mcpAppUiMeta: event.mcpAppUiMeta,
          toolResult: event.toolResult,
          imageContent: event.imageContent,
          imageRef: event.imageRef,
          // Preserve provenance so post-compaction recovery/synthesis paths
          // can still distinguish real model-invoked tools from synthetic
          // plan-seed and pre-turn-context events.
          _origin: event._origin,
          // Preserve seq so re-ingested compacted events keep the same
          // (turnId, seq) identity rather than getting restamped on the
          // next pipeline hop.
          ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
        };
        compacted.push(sanitizeToolImagePayloadForRefs(compactedToolEvent));
        break;
      }

      case 'assistant':
        compacted.push({
          type: 'assistant',
          text: '',
          timestamp: event.timestamp,
          ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
        });
        break;

      default:
        // A type was marked 'compact' in the policy map but has no handler.
        // Preserve it to avoid silent data loss.
        compacted.push(event);
        break;
    }
  }

  return compacted;
};

const isTurnCompleted = (events: AgentEvent[]): boolean => {
  if (events.length === 0) return false;
  const last = events[events.length - 1];
  return last.type === 'result' || last.type === 'error';
};

/**
 * Compacts all completed turns in an eventsByTurn record.
 * A turn is completed if its last event is a result or error.
 *
 * @param eventsByTurn - The full eventsByTurn record
 * @param excludeTurnId - Optional turn ID to skip (e.g., active turn)
 * @returns New eventsByTurn with completed turns compacted
 */
export const compactCompletedTurns = (
  eventsByTurn: Record<string, AgentEvent[]>,
  excludeTurnId?: string | null
): Record<string, AgentEvent[]> => {
  const result: Record<string, AgentEvent[]> = {};
  let anyCompacted = false;

  for (const [turnId, events] of Object.entries(eventsByTurn)) {
    if (turnId === excludeTurnId || !isTurnCompleted(events)) {
      result[turnId] = events;
    } else {
      result[turnId] = compactTurnEvents(events);
      anyCompacted = true;
    }
  }

  return anyCompacted ? result : eventsByTurn;
};
