import { isToolEvent, type AgentEvent, type ToolAgentEvent } from '@shared/types';
import { safeParseDetail } from '../../utils/safeParseDetail';

const hasImageContentOrRef = (event: ToolAgentEvent): boolean => {
  const hasContent = Array.isArray(event.imageContent) && event.imageContent.length > 0;
  if (hasContent) return true;
  const refs = event.imageRef;
  return Array.isArray(refs) && refs.some((slot) => slot !== null);
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolCallDiagnostic = {
  toolName: string;
  toolUseId: string;
  parentToolUseId: string | null;
  startTimestamp: number;
  endTimestamp: number | null;
  durationMs: number | null;
  isError: boolean;
  inputDetail: string;
  outputDetail: string;
  isCompacted: boolean;
  hasImageContent: boolean;
};

/**
 * Check if a tool detail is compacted (empty or path-only JSON from eventCompaction.ts).
 */
const isCompactedDetail = (detail: string): boolean => {
  if (detail === '') return true;
  if (!detail.startsWith('{')) return false;
  // A path-only compaction stub is tiny; over-budget / malformed detail is, by
  // definition, not one — so a guarded parse failure maps to `false`.
  const parsed = safeParseDetail(detail);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    return false;
  }
  const keys = Object.keys(parsed.value);
  return keys.length === 1 && (keys[0] === 'file_path' || keys[0] === 'path' || keys[0] === 'filePath');
};

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Pairs tool start/end events by `toolUseId` and computes durations.
 *
 * Handles edge cases:
 * - **Orphaned starts** (no matching end): `endTimestamp` and `durationMs` are null.
 * - **Orphaned ends** (no matching start): uses end timestamp as start, marks duration null.
 * - **Missing toolUseId**: generates a synthetic ID from tool name + timestamp.
 *
 * Results are sorted by `startTimestamp` ascending.
 */
export const deriveToolDurations = (events: AgentEvent[]): ToolCallDiagnostic[] => {
  const startMap = new Map<string, ToolAgentEvent>();
  const endMap = new Map<string, ToolAgentEvent>();
  const seenIds = new Set<string>();

  // Ordered list to preserve insertion order for deterministic output.
  const orderedIds: string[] = [];

  for (const event of events) {
    if (!isToolEvent(event)) continue;

    const id = event.toolUseId ?? `synthetic-${event.toolName}-${event.timestamp}`;

    if (!seenIds.has(id)) {
      seenIds.add(id);
      orderedIds.push(id);
    }

    if (event.stage === 'start') {
      startMap.set(id, event);
    } else {
      endMap.set(id, event);
    }
  }

  const diagnostics: ToolCallDiagnostic[] = [];

  for (const id of orderedIds) {
    const startEvent = startMap.get(id);
    const endEvent = endMap.get(id);

    if (startEvent && endEvent) {
      // Normal paired tool call.
      diagnostics.push({
        toolName: startEvent.toolName,
        toolUseId: id,
        parentToolUseId: startEvent.parentToolUseId ?? null,
        startTimestamp: startEvent.timestamp,
        endTimestamp: endEvent.timestamp,
        durationMs: Math.max(0, endEvent.timestamp - startEvent.timestamp),
        isError: endEvent.isError === true,
        inputDetail: startEvent.detail,
        outputDetail: endEvent.detail,
        isCompacted: isCompactedDetail(endEvent.detail),
        hasImageContent: hasImageContentOrRef(endEvent),
      });
    } else if (startEvent) {
      // Orphaned start — no matching end event.
      diagnostics.push({
        toolName: startEvent.toolName,
        toolUseId: id,
        parentToolUseId: startEvent.parentToolUseId ?? null,
        startTimestamp: startEvent.timestamp,
        endTimestamp: null,
        durationMs: null,
        isError: false,
        inputDetail: startEvent.detail,
        outputDetail: '',
        isCompacted: false,
        hasImageContent: false,
      });
    } else if (endEvent) {
      // Orphaned end — no matching start event.
      diagnostics.push({
        toolName: endEvent.toolName,
        toolUseId: id,
        parentToolUseId: endEvent.parentToolUseId ?? null,
        startTimestamp: endEvent.timestamp,
        endTimestamp: endEvent.timestamp,
        durationMs: null,
        isError: endEvent.isError === true,
        inputDetail: '',
        outputDetail: endEvent.detail,
        isCompacted: isCompactedDetail(endEvent.detail),
        hasImageContent: hasImageContentOrRef(endEvent),
      });
    }
  }

  // Sort by startTimestamp ascending.
  diagnostics.sort((a, b) => a.startTimestamp - b.startTimestamp);

  return diagnostics;
};
