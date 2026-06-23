/**
 * Prior-Turns Reader
 *
 * Pure read-side primitive for cross-turn awareness (Layer 1 + Layer 2).
 * Parses the JSONL transcript at `transcripts/<sid>.jsonl`, intersects parsed
 * turn-ids with the compaction-eligible turn-id set derived from
 * `IncrementalSessionStore`, and returns chronologically-ordered summaries
 * suitable for header rendering (Stage 2) and tool inspection (Stage 3).
 *
 * Pure read-side, no behaviour change anywhere else. No consumer is allowed
 * to import this module yet; Stage 2 wires it up.
 *
 * @see docs/plans/260525_cross_turn_awareness_layer1_layer2.md (Stage 1)
 */

import { promises as fsp } from 'node:fs';
import { createScopedLogger } from '@core/logger';
import { withRetryOnEmfile } from '@core/utils/emfileRetry';
import { getIncrementalSessionStore } from './incrementalSessionStore';
import {
  getTranscriptPath,
  type TranscriptEntry,
} from './transcriptService';
import type { ContentBlock } from '../rebelCore/modelTypes';
import type { RebelCoreEvent } from '../rebelCore/types';

const log = createScopedLogger({ service: 'priorTurnsReader' });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OutcomeClass =
  | 'asked-user-question'
  | 'completed'
  | 'errored'
  | 'in-flight';

export interface TranscriptTurnSummary {
  turnId: string;
  startTs: number;
  endTs: number;
  terminalSeq: number | null;
  toolCallCount: Record<string, number>;
  toolUseIds: string[];
  toolUseIdToToolName: Record<string, string>;
  filePathsRead: string[];
  externalSourcesHit: string[];
  materializedOutputs: string[];
  oneLineGist: string;
  outcomeClass: OutcomeClass;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const GIST_MAX_CHARS = 120;
const MATERIALIZED_OUTPUT_REGEX = /\.rebel\/tool-outputs\/[\w.\-]+/g;
const ZERO_WIDTH_SPACE = '\u200B';

// ---------------------------------------------------------------------------
// Escaper (F2 — used by Stage 2 header builder; exported for reuse + testing)
// ---------------------------------------------------------------------------

/**
 * Content escaper. Transforms the literal sentinel substrings `</prior_turns>`
 * and `<prior_turns>` by inserting a zero-width space (U+200B) between the
 * leading `<` and the rest of the tag, breaking the tag while remaining
 * visually identical.
 *
 * Wrapping alone (e.g. `<<<</prior_turns>>>>`) is INSUFFICIENT — it leaves
 * the literal sentinel substring inside the wrapper, which the model could
 * still read as a tag.
 *
 * Other content (file paths, queries, gist text) is wrapped in fenced
 * backticks by the header builder. Per the no-raw-snippets policy,
 * user-controlled content shouldn't reach this fn, so other special
 * characters (`<`, `>`, `&`) are not escaped.
 */
export function escapePriorTurnContent(input: string): string {
  if (!input) return '';
  return input
    .replace(/<\/prior_turns>/g, `<${ZERO_WIDTH_SPACE}/prior_turns>`)
    .replace(/<prior_turns>/g, `<${ZERO_WIDTH_SPACE}prior_turns>`);
}

// ---------------------------------------------------------------------------
// readPriorTurns
// ---------------------------------------------------------------------------

/**
 * Reads the JSONL transcript for `sessionId`, intersects parsed turn-ids with
 * the compaction-eligible turn-id set derived from `IncrementalSessionStore`,
 * and returns a chronologically-ordered array of summaries.
 *
 * Every path that falls back to `[]` emits a structured
 * `priorTurnsReaderFallback` warn event with a `reason` discriminator
 * (D-CLEAN-7). The counter makes silent fallback rate observable so the
 * Stage 5 telemetry surface can distinguish "feature off for this session"
 * from "feature failed silently" without having to grep multiple log
 * messages.
 *
 * Tolerates missing/empty transcript files, partial last lines, and entries
 * whose schema version is not 1.
 */
export async function readPriorTurns(
  sessionId: string,
): Promise<TranscriptTurnSummary[]> {
  const entries = await loadTranscriptEntries(sessionId);
  if (entries.length === 0) {
    return [];
  }

  const { session, failedToLoad } = await loadSession(sessionId);
  if (!session) {
    log.warn(
      {
        sessionId,
        reason: failedToLoad ? 'session_load_failed' : 'session_not_found',
      },
      'priorTurnsReaderFallback',
    );
    return [];
  }

  const eligibleTurnIds = computeEligibleTurnIds(session);
  if (eligibleTurnIds.size === 0) {
    log.warn(
      { sessionId, reason: 'compaction_filtered_all' },
      'priorTurnsReaderFallback',
    );
    return [];
  }

  const grouped = groupEntriesByTurn(entries);
  const summaries: TranscriptTurnSummary[] = [];
  for (const [turnId, turnEntries] of grouped.entries()) {
    if (!eligibleTurnIds.has(turnId)) continue;
    summaries.push(buildTurnSummary(turnId, turnEntries));
  }

  summaries.sort((a, b) => a.startTs - b.startTs);
  return summaries;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadTranscriptEntries(
  sessionId: string,
): Promise<TranscriptEntry[]> {
  const filePath = getTranscriptPath(sessionId);
  let content: string;
  try {
    content = await withRetryOnEmfile(() => fsp.readFile(filePath, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      log.debug(
        { sessionId, filePath },
        'priorTurnsReader: transcript file missing',
      );
      log.warn(
        { sessionId, reason: 'transcript_missing' },
        'priorTurnsReaderFallback',
      );
      return [];
    }
    log.warn(
      { sessionId, filePath, err: getErrorMessage(err) },
      'priorTurnsReader: failed to read transcript',
    );
    log.warn(
      { sessionId, reason: 'transcript_read_failed' },
      'priorTurnsReaderFallback',
    );
    return [];
  }

  if (!content.trim()) {
    log.warn(
      { sessionId, reason: 'transcript_empty' },
      'priorTurnsReaderFallback',
    );
    return [];
  }

  const lines = content.split('\n');
  const entries: TranscriptEntry[] = [];
  let parseFailures = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isValidTranscriptEntry(parsed)) {
        parseFailures++;
        continue;
      }
      entries.push(parsed);
    } catch {
      parseFailures++;
    }
  }

  if (parseFailures > 0) {
    log.warn(
      { sessionId, parseFailures, totalLines: lines.length },
      'priorTurnsReader: skipped malformed transcript lines',
    );
  }

  if (entries.length === 0 && parseFailures > 0) {
    log.warn(
      { sessionId, reason: 'parse_error', parseFailures, totalLines: lines.length },
      'priorTurnsReaderFallback',
    );
  }

  return entries;
}

/**
 * Minimal shape validation for a parsed JSONL line. JSON-valid but
 * schema-invalid lines (missing fields, wrong types) would otherwise crash
 * downstream summary building. Forward-compat: entries with `v !== 1` are
 * counted as malformed so future schema bumps require a deliberate read-side
 * update.
 */
function isValidTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.v !== 1) return false;
  if (typeof v.tid !== 'string') return false;
  if (typeof v.seq !== 'number') return false;
  if (typeof v.ts !== 'number') return false;
  if (!v.event || typeof v.event !== 'object') return false;
  const ev = v.event as Record<string, unknown>;
  if (typeof ev.kind !== 'string') return false;
  // For 'core' kind, the inner `event` MUST be an object with a string `type`
  // field — buildTurnSummary reads entry.event.event.type unconditionally and
  // would crash on a malformed entry without this guard.
  if (ev.kind === 'core') {
    if (!ev.event || typeof ev.event !== 'object') return false;
    const inner = ev.event as Record<string, unknown>;
    if (typeof inner.type !== 'string') return false;
  }
  return true;
}

type LoadedSession = Awaited<
  ReturnType<ReturnType<typeof getIncrementalSessionStore>['getSession']>
>;

async function loadSession(
  sessionId: string,
): Promise<{ session: LoadedSession; failedToLoad: boolean }> {
  try {
    const session = await getIncrementalSessionStore().getSession(sessionId);
    return { session, failedToLoad: false };
  } catch (err) {
    log.warn(
      { sessionId, err: getErrorMessage(err) },
      'priorTurnsReader: failed to load session',
    );
    return { session: null, failedToLoad: true };
  }
}

/**
 * Mirrors `prepareEligibleMessages` from `conversationHistoryService.ts` so a
 * turn-id is "eligible" only if at least one of its messages survives the
 * exact same filter the history builder applies. Diverging from that predicate
 * would surface turns in the prior-turns header that the history builder
 * suppresses (warnings, legacy hidden, or messages with no text).
 */
function computeEligibleTurnIds(session: {
  messages?: Array<{
    turnId: string;
    role?: string;
    text?: string;
    isWarning?: boolean;
    isHidden?: boolean;
    messageOrigin?: string;
  }>;
  compactionBoundaries?: Array<{ afterMessageIndex: number }>;
}): Set<string> {
  const messages = session.messages ?? [];
  if (messages.length <= 1) return new Set();

  let messagesToInclude = messages;
  const boundaries = session.compactionBoundaries ?? [];
  if (boundaries.length > 0) {
    const lastBoundaryIndex = Math.max(
      ...boundaries.map((b) => b.afterMessageIndex),
    );
    if (lastBoundaryIndex >= 0 && lastBoundaryIndex < messages.length) {
      messagesToInclude = messages.slice(lastBoundaryIndex + 1);
    }
  }

  const survivors = messagesToInclude.filter(
    (m) =>
      (m.role === 'user' || m.role === 'assistant' || m.role === 'result') &&
      m.text?.trim() &&
      !m.isWarning &&
      (!m.isHidden || m.messageOrigin === 'system-continuation'),
  );

  const eligible = new Set<string>();
  for (const m of survivors) {
    if (m.turnId) eligible.add(m.turnId);
  }
  return eligible;
}

function groupEntriesByTurn(
  entries: TranscriptEntry[],
): Map<string, TranscriptEntry[]> {
  const grouped = new Map<string, TranscriptEntry[]>();
  for (const entry of entries) {
    const existing = grouped.get(entry.tid);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(entry.tid, [entry]);
    }
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.seq - b.seq);
  }
  return grouped;
}

function buildTurnSummary(
  turnId: string,
  entries: TranscriptEntry[],
): TranscriptTurnSummary {
  let startTs = Number.POSITIVE_INFINITY;
  let terminalTs: number | null = null;
  let terminalSeq: number | null = null;
  let firstAssistantMessageContent: ContentBlock[] | null = null;
  let hasError = false;
  let askedUserQuestion = false;

  const toolCallCount: Record<string, number> = {};
  const toolUseIds: string[] = [];
  const toolUseIdToToolName: Record<string, string> = {};
  const filePathsRead: string[] = [];
  const filePathsSeen = new Set<string>();
  const externalSourcesHit: string[] = [];
  const externalSourcesSeen = new Set<string>();
  const materializedOutputs: string[] = [];
  const materializedSeen = new Set<string>();

  for (const entry of entries) {
    if (entry.ts < startTs) startTs = entry.ts;

    if (entry.event.kind === 'error') {
      hasError = true;
      continue;
    }

    if (entry.event.kind !== 'core') {
      continue;
    }

    const ev: RebelCoreEvent = entry.event.event;

    if (ev.type === 'turn:complete') {
      terminalSeq = entry.seq;
      terminalTs = entry.ts;
      continue;
    }

    if (ev.type === 'turn:error') {
      hasError = true;
      continue;
    }

    if (ev.type === 'tool_use:start') {
      const toolName = ev.toolName;
      toolCallCount[toolName] = (toolCallCount[toolName] ?? 0) + 1;
      toolUseIds.push(ev.toolUseId);
      toolUseIdToToolName[ev.toolUseId] = toolName;

      if (toolName === 'AskUserQuestion') {
        askedUserQuestion = true;
      }

      if (toolName === 'Read') {
        const inputPath = extractReadPath(ev.input);
        if (inputPath && !filePathsSeen.has(inputPath)) {
          filePathsSeen.add(inputPath);
          filePathsRead.push(inputPath);
        }
      } else if (toolName === 'WebFetch') {
        const host = extractHostname(ev.input);
        if (host) {
          const escaped = escapePriorTurnContent(host);
          if (!externalSourcesSeen.has(escaped)) {
            externalSourcesSeen.add(escaped);
            externalSourcesHit.push(escaped);
          }
        }
      } else if (toolName === 'WebSearch') {
        const query = extractSearchQuery(ev.input);
        if (query) {
          const escaped = escapePriorTurnContent(query);
          if (!externalSourcesSeen.has(escaped)) {
            externalSourcesSeen.add(escaped);
            externalSourcesHit.push(escaped);
          }
        }
      } else if (isMcpToolName(toolName)) {
        const escaped = escapePriorTurnContent(toolName);
        if (!externalSourcesSeen.has(escaped)) {
          externalSourcesSeen.add(escaped);
          externalSourcesHit.push(escaped);
        }
      }
      continue;
    }

    if (ev.type === 'tool_use:result') {
      if (ev.isError) hasError = true;
      const matches = ev.output?.matchAll(MATERIALIZED_OUTPUT_REGEX);
      if (matches) {
        for (const match of matches) {
          const path = match[0];
          if (!materializedSeen.has(path)) {
            materializedSeen.add(path);
            materializedOutputs.push(path);
          }
        }
      }
      continue;
    }

    if (
      ev.type === 'assistant:message' &&
      firstAssistantMessageContent === null
    ) {
      firstAssistantMessageContent = ev.content;
    }
  }

  if (startTs === Number.POSITIVE_INFINITY) {
    startTs = 0;
  }
  const endTs = terminalTs ?? startTs;

  const oneLineGist = synthesizeGist(firstAssistantMessageContent);
  const outcomeClass = resolveOutcomeClass({
    askedUserQuestion,
    terminalSeq,
    hasError,
  });

  return {
    turnId,
    startTs,
    endTs,
    terminalSeq,
    toolCallCount,
    toolUseIds,
    toolUseIdToToolName,
    filePathsRead,
    externalSourcesHit,
    materializedOutputs,
    oneLineGist,
    outcomeClass,
  };
}

function resolveOutcomeClass(args: {
  askedUserQuestion: boolean;
  terminalSeq: number | null;
  hasError: boolean;
}): OutcomeClass {
  if (args.askedUserQuestion) return 'asked-user-question';
  if (args.hasError) return 'errored';
  if (args.terminalSeq === null) return 'in-flight';
  return 'completed';
}

function extractReadPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const filePath = obj.file_path;
  if (typeof filePath === 'string' && filePath.trim()) return filePath;
  const path = obj.path;
  if (typeof path === 'string' && path.trim()) return path;
  return null;
}

function extractHostname(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const url = obj.url;
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function extractSearchQuery(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const query = obj.query;
  if (typeof query === 'string' && query.trim()) return query;
  return null;
}

/**
 * Heuristic: MCP tool names use a `<server>__<tool>` separator; built-in
 * tool names never contain the double-underscore separator. Good enough
 * to surface external-source provenance without coupling this read-side
 * primitive to the builtin-tool registry.
 */
function isMcpToolName(toolName: string): boolean {
  return toolName.includes('__');
}

function synthesizeGist(content: ContentBlock[] | null): string {
  if (!content || content.length === 0) return '';
  let raw = '';
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      raw = block.text;
      break;
    }
  }
  if (!raw) return '';

  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= GIST_MAX_CHARS) return collapsed;

  const truncated = collapsed.slice(0, GIST_MAX_CHARS);
  const lastSpace = truncated.lastIndexOf(' ');
  const cut = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  return `${cut.trimEnd()}…`;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
