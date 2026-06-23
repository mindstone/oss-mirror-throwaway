import type { CloudSessionToolEvent as SessionToolEvent } from '@rebel/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubAgentStatus = 'running' | 'completed';

export type SubAgentItem = {
  id: string;
  toolUseId?: string;
  label: string;
  subagentType?: string;
  summary?: string;
  status: SubAgentStatus;
  isBackground: boolean;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  result?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const isSubAgentToolName = (toolName: string): boolean =>
  toolName === 'Task' ||
  toolName === 'Agent' ||
  toolName.endsWith('/Task') ||
  toolName.endsWith('/Agent');

/** Strip `mcp__` prefix, replace `_` / `-` with spaces, title-case each word. */
export const formatSubAgentName = (value: string): string => {
  const withoutPrefix = value.replace(/^mcp__/i, '');
  const cleaned = withoutPrefix.replace(/[_-]+/g, ' ').trim();
  if (!cleaned) return value.trim() || 'Sub-agent';
  return cleaned
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
};

/**
 * Maximum length (in UTF-16 code units) of a single captured field we are
 * willing to hand to `JSON.parse`. This fallback runs on details that the
 * caller has already declined to parse wholesale as too large, so an unbounded
 * `JSON.parse("...")` of a huge captured `prompt`/`description` would re-open
 * the OOM hole the renderer Stage 1 fix closed (`subAgentTimeline`'s
 * `MAX_RAW_FIELD_PARSE_CHARS`). Sub-agent metadata we display (type name, short
 * summary) is always small; a field larger than this is never useful here, so
 * we skip it rather than decode it. Core-local by design — `src/core` must not
 * import the renderer constant. (Stage 3 sibling-class fix — see
 * docs/plans/260616_stuck-library-renderer-oom/PLAN.md.)
 */
const MAX_RAW_FIELD_PARSE_CHARS = 16 * 1024;

/**
 * Regex-extract a JSON string field from potentially truncated JSON.
 * Handles escaped characters inside the value.
 */
const extractJsonStringField = (detail: string, key: string): string | undefined => {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = detail.match(new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match?.[1]) return undefined;
  // BOUNDED: never JSON.parse an oversized captured field — a huge prompt would
  // allocate a large decoded copy and defeat the OOM invariant.
  if (match[1].length > MAX_RAW_FIELD_PARSE_CHARS) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
};

export type SubAgentMetadata = { label: string; subagentType?: string; summary?: string };

const truncate = (text: string, maxLen: number): string =>
  text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;

/** Extract subagent metadata from a (possibly truncated) JSON detail string. */
export const extractSubAgentMetadataFromRawDetail = (detail: string): SubAgentMetadata | null => {
  // Task format: { "subagent_type": "...", "description": "...", "prompt": "..." }
  const subAgentTypeRaw = extractJsonStringField(detail, 'subagent_type');
  if (subAgentTypeRaw?.trim()) {
    const label = formatSubAgentName(subAgentTypeRaw);
    const description = extractJsonStringField(detail, 'description')?.trim();
    const prompt = extractJsonStringField(detail, 'prompt')?.trim();
    const summary = description || (prompt ? truncate(prompt, 96) : undefined);
    return { label, subagentType: subAgentTypeRaw, summary };
  }

  // Agent format: { "agent": "...", "prompt": "..." }
  const agentNameRaw = extractJsonStringField(detail, 'agent');
  if (agentNameRaw?.trim()) {
    const label = formatSubAgentName(agentNameRaw);
    const prompt = extractJsonStringField(detail, 'prompt')?.trim();
    const summary = prompt ? truncate(prompt, 96) : undefined;
    return { label, subagentType: agentNameRaw, summary };
  }

  return null;
};

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

/**
 * Extract subagent items from a list of `SessionToolEvent`s.
 *
 * Detects Task/Agent tool starts, pairs them with their end events by
 * `toolUseId`, and returns a list of `SubAgentItem` sorted by `startedAt`.
 */
export const extractSubAgentItems = (events: SessionToolEvent[]): SubAgentItem[] => {
  const items: SubAgentItem[] = [];
  const pendingByToolUseId = new Map<string, number>();

  for (const event of events) {
    if (!isSubAgentToolName(event.toolName)) continue;

    if (event.stage === 'start') {
      const metadata = event.detail
        ? extractSubAgentMetadataFromRawDetail(event.detail)
        : null;

      const item: SubAgentItem = {
        id: event.toolUseId ?? `subagent-${items.length}`,
        toolUseId: event.toolUseId,
        label: metadata?.label ?? 'Sub-agent',
        subagentType: metadata?.subagentType,
        summary: metadata?.summary,
        status: 'running',
        isBackground: false,
        startedAt: event.timestamp,
      };

      items.push(item);
      if (event.toolUseId) {
        pendingByToolUseId.set(event.toolUseId, items.length - 1);
      }
      continue;
    }

    // stage === 'end'
    if (!event.toolUseId) continue;

    const idx = pendingByToolUseId.get(event.toolUseId);
    if (idx === undefined) continue;

    const isBackgroundAck =
      event.detail?.includes('Async agent launched successfully') ||
      event.detail?.includes('working in the background');

    if (isBackgroundAck) {
      items[idx] = { ...items[idx], isBackground: true };
      // Leave status as 'running' — background agent continues independently
    } else {
      items[idx] = {
        ...items[idx],
        status: 'completed',
        completedAt: event.timestamp,
        durationMs: event.timestamp - items[idx].startedAt,
        result: event.detail || undefined,
      };
      pendingByToolUseId.delete(event.toolUseId);
    }
  }

  return items.sort((a, b) => a.startedAt - b.startedAt);
};
