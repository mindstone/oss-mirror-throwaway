/**
 * Prior-Turns Inspection Tools (Layer 2)
 *
 * Stage 3 of `docs/plans/260525_cross_turn_awareness_layer1_layer2.md`.
 *
 * Implements two model-facing builtin tools that let an active agent inspect
 * prior turns of the current session deterministically:
 *
 *   - `inspect_prior_turns()` — index of prior turns (C12 schema).
 *   - `inspect_prior_turns(turn_id)` — structured detail for one prior turn.
 *   - `get_tool_call(turn_id, tool_use_id)` — full I/O for one tool call (C13).
 *
 * Hard requirements (per plan):
 *   - Deterministic-only. No LLM call. (D9)
 *   - No cache. Fresh transcript reads on every invocation. (D11)
 *   - Filter out the current turn (`turnId !== ctx.currentTurnId`).
 *   - Sub-agents do not see these tools — see `agentTool.ts` for F1 wiring.
 *   - All embedded strings escape via `escapePriorTurnContent` (F2).
 *   - Visible error when `ctx.sessionId` or `ctx.currentTurnId` is empty
 *     (D-CLEAN-8).
 *   - Structured log per invocation (`priorTurnsInspect`).
 */

import { promises as fsp } from 'node:fs';
import { createScopedLogger } from '@core/logger';
import { withRetryOnEmfile } from '@core/utils/emfileRetry';
import {
  escapePriorTurnContent,
  readPriorTurns,
  type TranscriptTurnSummary,
} from './priorTurnsReader';
import {
  getTranscriptPath,
  type TranscriptEntry,
} from './transcriptService';
import type { ToolDefinition } from '../rebelCore/modelTypes';
import type {
  BuiltinToolContext,
  ToolExecutionResult,
} from '../rebelCore/types';

const log = createScopedLogger({ service: 'priorTurnsTool' });

const INLINE_OUTPUT_CAP_CHARS = 4_000;
const OUTPUT_SUMMARY_CHARS = 200;
const MATERIALIZED_PATH_REGEX = /\.rebel\/tool-outputs\/[\w.\-]+/;
const MATERIALIZED_SIZE_HINT_REGEX = /full\s+([\d_,]+)\s+chars\s+saved\s+to\s+(\.rebel\/tool-outputs\/[\w.\-]+)/i;

// ---------------------------------------------------------------------------
// Public response schemas (C12 + C13)
// ---------------------------------------------------------------------------

export interface IndexResponseTurn {
  id: string;
  ts: number;
  gist: string;
  toolCount: number;
  outcome: 'completed' | 'cancelled' | 'errored' | 'in_progress';
  inFlight: boolean;
}

export interface IndexResponse {
  turns: IndexResponseTurn[];
  totalTurns: number;
  truncated: boolean;
}

export interface InspectTurnDetailResponse {
  turnId: string;
  startTs: number;
  endTs: number;
  outcome: 'completed' | 'cancelled' | 'errored' | 'in_progress';
  inFlight: boolean;
  gist: string;
  toolCalls: Array<{ toolUseId: string; toolName: string }>;
  toolCallCount: Record<string, number>;
  filePathsRead: string[];
  externalSourcesHit: string[];
  materializedOutputs: string[];
}

export type GetToolCallOutput =
  | { type: 'inline'; content: string }
  | {
      type: 'materialized';
      path: string;
      sizeBytes: number;
      outputSummary: string;
    };

export interface ToolCallResponse {
  turnId: string;
  toolUseId: string;
  toolName: string;
  inputs: Record<string, unknown>;
  output: GetToolCallOutput;
  outcome: 'completed' | 'cancelled' | 'errored';
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const INSPECT_PRIOR_TURNS_TOOL_DEFINITION: ToolDefinition = {
  name: 'inspect_prior_turns',
  description:
    'Inspect prior turns of the current session deterministically. Without `turn_id`, returns an index of prior turns (id, gist, tool count, outcome). With `turn_id`, returns a structured detail for that turn (tools called, file paths read, materialized outputs, outcome). Useful before re-running a Read/Search/Fetch you suspect was already done — the prior_turns header surfaces a summary; this tool drills in. No content beyond what the prior turn produced is fabricated. Read-only.',
  input_schema: {
    type: 'object',
    properties: {
      turn_id: {
        type: 'string',
        description:
          'Optional. The turn id to inspect (e.g. from the <prior_turns> header). Omit to receive the index of all prior turns.',
      },
    },
  },
};

export const GET_TOOL_CALL_TOOL_DEFINITION: ToolDefinition = {
  name: 'get_tool_call',
  description:
    'Return the full inputs and output for a single tool call from a prior turn. Use after `inspect_prior_turns(turn_id)` to retrieve specific I/O without re-running the tool. Output may be inline (small results) or a `.rebel/tool-outputs/` pointer (large results — Read the path for full content). Read-only.',
  input_schema: {
    type: 'object',
    properties: {
      turn_id: {
        type: 'string',
        description: 'The turn id containing the tool call.',
      },
      tool_use_id: {
        type: 'string',
        description: 'The toolUseId of the call to retrieve (from `inspect_prior_turns(turn_id)`).',
      },
    },
    required: ['turn_id', 'tool_use_id'],
  },
};

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

export async function executeInspectPriorTurns(
  input: unknown,
  ctx: BuiltinToolContext,
): Promise<ToolExecutionResult> {
  const sessionId = ctx.sessionId;
  const currentTurnId = ctx.currentTurnId;
  const surface = detectSurface();

  if (!sessionId || !currentTurnId) {
    log.info(
      {
        currentTurnId: currentTurnId ?? null,
        inspectedTurnId: null,
        sessionId: sessionId ?? null,
        status: 'missing_identity',
        surface,
        tool: 'inspect_prior_turns',
      },
      'priorTurnsInspect',
    );
    return {
      output: 'inspect_prior_turns: missing session/turn identity in BuiltinToolContext',
      isError: true,
    };
  }

  const params = parseInspectPriorTurnsInput(input);
  if (params instanceof Error) {
    log.info(
      {
        currentTurnId,
        inspectedTurnId: null,
        sessionId,
        status: 'invalid_input',
        surface,
        tool: 'inspect_prior_turns',
      },
      'priorTurnsInspect',
    );
    return { output: `inspect_prior_turns: ${params.message}`, isError: true };
  }

  log.info(
    {
      currentTurnId,
      inspectedTurnId: params.turnId ?? null,
      sessionId,
      status: 'ok',
      surface,
      tool: 'inspect_prior_turns',
    },
    'priorTurnsInspect',
  );

  const summaries = await readPriorTurns(sessionId);
  const eligible = summaries.filter((s) => s.turnId !== currentTurnId);

  if (params.turnId === undefined) {
    return { output: JSON.stringify(buildIndexResponse(eligible)), isError: false };
  }

  const detail = buildTurnDetailResponse(eligible, params.turnId);
  if (!detail) {
    return {
      output: `inspect_prior_turns: turn id "${escapePriorTurnContent(params.turnId)}" not found among prior turns. Call inspect_prior_turns() with no arguments to see the index.`,
      isError: true,
    };
  }
  return { output: JSON.stringify(detail), isError: false };
}

export async function executeGetToolCall(
  input: unknown,
  ctx: BuiltinToolContext,
): Promise<ToolExecutionResult> {
  const sessionId = ctx.sessionId;
  const currentTurnId = ctx.currentTurnId;
  const surface = detectSurface();

  if (!sessionId || !currentTurnId) {
    log.info(
      {
        currentTurnId: currentTurnId ?? null,
        inspectedTurnId: null,
        sessionId: sessionId ?? null,
        status: 'missing_identity',
        surface,
        tool: 'get_tool_call',
      },
      'priorTurnsInspect',
    );
    return {
      output: 'get_tool_call: missing session/turn identity in BuiltinToolContext',
      isError: true,
    };
  }

  const params = parseGetToolCallInput(input);
  if (params instanceof Error) {
    log.info(
      {
        currentTurnId,
        inspectedTurnId: null,
        sessionId,
        status: 'invalid_input',
        surface,
        tool: 'get_tool_call',
      },
      'priorTurnsInspect',
    );
    return { output: `get_tool_call: ${params.message}`, isError: true };
  }

  log.info(
    {
      currentTurnId,
      inspectedTurnId: params.turnId,
      sessionId,
      status: 'ok',
      surface,
      tool: 'get_tool_call',
    },
    'priorTurnsInspect',
  );

  const summaries = await readPriorTurns(sessionId);
  const eligible = summaries.filter((s) => s.turnId !== currentTurnId);

  const targetSummary = eligible.find((s) => s.turnId === params.turnId);
  if (!targetSummary) {
    return {
      output: `get_tool_call: turn id "${escapePriorTurnContent(params.turnId)}" not found among prior turns. Call inspect_prior_turns() to see the index.`,
      isError: true,
    };
  }

  const turnEntries = await loadTranscriptEntriesForTurn(sessionId, params.turnId);
  const response = buildToolCallResponse(turnEntries, params.turnId, params.toolUseId);
  if (!response) {
    return {
      output: `get_tool_call: tool_use_id "${escapePriorTurnContent(params.toolUseId)}" not found in turn "${escapePriorTurnContent(params.turnId)}". Call inspect_prior_turns(turn_id="${escapePriorTurnContent(params.turnId)}") to see the tool calls in that turn.`,
      isError: true,
    };
  }
  return { output: JSON.stringify(response), isError: false };
}

// ---------------------------------------------------------------------------
// Input parsers
// ---------------------------------------------------------------------------

function parseInspectPriorTurnsInput(
  input: unknown,
): { turnId?: string } | Error {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    return new Error('input must be an object');
  }
  const obj = input as Record<string, unknown>;
  if (obj.turn_id === undefined || obj.turn_id === null) return {};
  if (typeof obj.turn_id !== 'string' || obj.turn_id.trim().length === 0) {
    return new Error('turn_id must be a non-empty string when provided');
  }
  return { turnId: obj.turn_id };
}

function parseGetToolCallInput(
  input: unknown,
): { turnId: string; toolUseId: string } | Error {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return new Error('input must be an object');
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.turn_id !== 'string' || obj.turn_id.trim().length === 0) {
    return new Error('turn_id must be a non-empty string');
  }
  if (typeof obj.tool_use_id !== 'string' || obj.tool_use_id.trim().length === 0) {
    return new Error('tool_use_id must be a non-empty string');
  }
  return { turnId: obj.turn_id, toolUseId: obj.tool_use_id };
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

function buildIndexResponse(summaries: TranscriptTurnSummary[]): IndexResponse {
  const turns: IndexResponseTurn[] = summaries.map((s) => ({
    id: escapePriorTurnContent(s.turnId),
    ts: s.startTs,
    gist: escapePriorTurnContent(s.oneLineGist),
    toolCount: countTotalTools(s.toolCallCount),
    outcome: mapOutcome(s.outcomeClass),
    inFlight: s.outcomeClass === 'in-flight',
  }));
  return {
    turns,
    totalTurns: summaries.length,
    truncated: false,
  };
}

function buildTurnDetailResponse(
  summaries: TranscriptTurnSummary[],
  turnId: string,
): InspectTurnDetailResponse | null {
  const summary = summaries.find((s) => s.turnId === turnId);
  if (!summary) return null;

  const toolCalls = summary.toolUseIds.map((toolUseId) => ({
    toolUseId: escapePriorTurnContent(toolUseId),
    toolName: escapePriorTurnContent(summary.toolUseIdToToolName[toolUseId] ?? 'unknown'),
  }));

  return {
    turnId: escapePriorTurnContent(summary.turnId),
    startTs: summary.startTs,
    endTs: summary.endTs,
    outcome: mapOutcome(summary.outcomeClass),
    inFlight: summary.outcomeClass === 'in-flight',
    gist: escapePriorTurnContent(summary.oneLineGist),
    toolCalls,
    toolCallCount: escapeCountKeys(summary.toolCallCount),
    filePathsRead: summary.filePathsRead.map(escapePriorTurnContent),
    externalSourcesHit: summary.externalSourcesHit.map(escapePriorTurnContent),
    materializedOutputs: summary.materializedOutputs.map(escapePriorTurnContent),
  };
}

function buildToolCallResponse(
  entries: TranscriptEntry[],
  turnId: string,
  toolUseId: string,
): ToolCallResponse | null {
  let startEntry: TranscriptEntry | null = null;
  let resultEntry: TranscriptEntry | null = null;

  for (const entry of entries) {
    if (entry.event.kind !== 'core') continue;
    const ev = entry.event.event;
    if (ev.type === 'tool_use:start' && ev.toolUseId === toolUseId) {
      startEntry = entry;
    } else if (ev.type === 'tool_use:result' && ev.toolUseId === toolUseId) {
      resultEntry = entry;
    }
  }

  if (!startEntry || startEntry.event.kind !== 'core' || startEntry.event.event.type !== 'tool_use:start') {
    return null;
  }
  const startEvent = startEntry.event.event;

  const inputs = sanitizeInputs(startEvent.input);

  let output: GetToolCallOutput;
  let outcome: ToolCallResponse['outcome'];
  let durationMs: number;

  if (resultEntry && resultEntry.event.kind === 'core' && resultEntry.event.event.type === 'tool_use:result') {
    const resultEvent = resultEntry.event.event;
    const rawOutput = resultEvent.output ?? '';
    output = buildToolCallOutput(rawOutput);
    outcome = resultEvent.isError ? 'errored' : 'completed';
    durationMs = Math.max(0, resultEntry.ts - startEntry.ts);
  } else {
    output = { type: 'inline', content: '' };
    outcome = 'cancelled';
    durationMs = 0;
  }

  return {
    turnId: escapePriorTurnContent(turnId),
    toolUseId: escapePriorTurnContent(toolUseId),
    toolName: escapePriorTurnContent(startEvent.toolName),
    inputs,
    output,
    outcome,
    durationMs,
  };
}

function buildToolCallOutput(rawOutput: string): GetToolCallOutput {
  const sizeHintMatch = rawOutput.match(MATERIALIZED_SIZE_HINT_REGEX);
  if (sizeHintMatch) {
    const sizeBytes = parseInt(sizeHintMatch[1].replace(/[_,]/g, ''), 10);
    return {
      type: 'materialized',
      path: escapePriorTurnContent(sizeHintMatch[2]),
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
      outputSummary: deterministicDigest(rawOutput),
    };
  }

  const pathMatch = rawOutput.match(MATERIALIZED_PATH_REGEX);
  if (pathMatch && rawOutput.length >= INLINE_OUTPUT_CAP_CHARS) {
    return {
      type: 'materialized',
      path: escapePriorTurnContent(pathMatch[0]),
      sizeBytes: 0,
      outputSummary: deterministicDigest(rawOutput),
    };
  }

  if (rawOutput.length > INLINE_OUTPUT_CAP_CHARS) {
    const truncated = rawOutput.slice(0, INLINE_OUTPUT_CAP_CHARS);
    return {
      type: 'inline',
      content: `${escapePriorTurnContent(truncated)}\n[output truncated to ${INLINE_OUTPUT_CAP_CHARS} chars; total was ${rawOutput.length}]`,
    };
  }

  return { type: 'inline', content: escapePriorTurnContent(rawOutput) };
}

function deterministicDigest(rawOutput: string): string {
  const slice = rawOutput.slice(0, OUTPUT_SUMMARY_CHARS);
  return escapePriorTurnContent(slice);
}

function sanitizeInputs(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[escapePriorTurnContent(key)] = sanitizeInputValue(value);
  }
  return out;
}

function sanitizeInputValue(value: unknown): unknown {
  if (typeof value === 'string') return escapePriorTurnContent(value);
  if (Array.isArray(value)) return value.map(sanitizeInputValue);
  if (value && typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[escapePriorTurnContent(k)] = sanitizeInputValue(v);
    }
    return obj;
  }
  return value;
}

function countTotalTools(counts: Record<string, number>): number {
  let total = 0;
  for (const n of Object.values(counts)) total += n;
  return total;
}

function escapeCountKeys(counts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) out[escapePriorTurnContent(k)] = v;
  return out;
}

function mapOutcome(
  outcomeClass: TranscriptTurnSummary['outcomeClass'],
): IndexResponseTurn['outcome'] {
  switch (outcomeClass) {
    case 'asked-user-question':
    case 'completed':
      return 'completed';
    case 'errored':
      return 'errored';
    case 'in-flight':
      return 'in_progress';
    default: {
      const _exhaustive: never = outcomeClass;
      return _exhaustive;
    }
  }
}

function detectSurface(): 'desktop' | 'cloud' {
  return process.env.REBEL_SURFACE === 'cloud' ? 'cloud' : 'desktop';
}

// ---------------------------------------------------------------------------
// Local transcript helper (used only by get_tool_call)
// ---------------------------------------------------------------------------

async function loadTranscriptEntriesForTurn(
  sessionId: string,
  turnId: string,
): Promise<TranscriptEntry[]> {
  const filePath = getTranscriptPath(sessionId);
  let content: string;
  try {
    content = await withRetryOnEmfile(() => fsp.readFile(filePath, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return [];
    log.warn(
      { sessionId, filePath, err: err instanceof Error ? err.message : String(err) },
      'priorTurnsTool: failed to read transcript for tool call lookup',
    );
    return [];
  }
  if (!content.trim()) return [];

  const lines = content.split('\n');
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isTranscriptEntryShape(parsed)) continue;
    if (parsed.tid !== turnId) continue;
    entries.push(parsed);
  }
  entries.sort((a, b) => a.seq - b.seq);
  return entries;
}

function isTranscriptEntryShape(value: unknown): value is TranscriptEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.v !== 1) return false;
  if (typeof v.tid !== 'string') return false;
  if (typeof v.seq !== 'number') return false;
  if (typeof v.ts !== 'number') return false;
  if (!v.event || typeof v.event !== 'object') return false;
  const ev = v.event as Record<string, unknown>;
  if (typeof ev.kind !== 'string') return false;
  // For 'core' kind, the inner `event` must be an object with a string `type`
  // field — buildToolCallResponse reads entry.event.event.type unconditionally,
  // and a malformed entry without an inner event would crash without this guard.
  if (ev.kind === 'core') {
    if (!ev.event || typeof ev.event !== 'object') return false;
    const inner = ev.event as Record<string, unknown>;
    if (typeof inner.type !== 'string') return false;
  }
  return true;
}
