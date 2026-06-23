/**
 * Memory Update Service
 *
 * Triggers automatic memory updates after successful agent turns.
 * Runs as a fire-and-forget background process that does not appear in history.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import type {
  AgentEvent,
  AgentTurnMessage,
  AppSettings,
  BroadcastMemoryUpdateStatus,
  MemoryEntityUpdate,
} from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { toPortablePath } from '@core/utils/portablePath';
import { hasValidAuth } from '../utils/authEnvUtils';
import { callBehindTheScenesWithAuth, getEffectiveModelName } from './behindTheScenesClient';
import { safeJsonParseFromModelText } from '@shared/utils/safeJsonParse';
import { getTracker } from '@core/tracking';
import { hashSessionId } from '@shared/trackingTypes';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { getDataPath } from '@core/utils/dataPaths';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';
import { FILE_WRITE_TOOLS } from '@core/services/safety/constants';
import { isTransientError } from '@shared/utils/friendlyErrors';
import { BroadcastMemoryUpdateStatusSchema } from '@shared/ipc/schemas/agent';
import { nextContentUpdatedAt } from '@shared/utils/sessionTimestamps';

const log = createScopedLogger({ service: 'memoryUpdate' });

/**
 * Persist a TERMINAL memory-update status (`success`/`error`) into the owning
 * session's `memoryUpdateStatusByTurn`, keyed by `originalTurnId`, on the surface
 * that EXECUTED the turn — desktop AND cloud (this runs in shared core). This
 * makes the status durable so a client that missed the live `memory:update-status`
 * broadcast (e.g. a desktop that was offline during a cloud-run turn) recovers it
 * on the next sync (260619 cloud catch-up fix). Mirrors the activity-summary
 * persistence in agentEventDispatcher.
 *
 * `running` is transient and intentionally NOT persisted (the store's hydration
 * cleanup wipes stale `running` anyway). This is the SINGLE writer of
 * memoryUpdateStatusByTurn on the producing surface: the renderer no longer
 * persists memory status (see useMemoryUpdateStatus), so there is no competing
 * read-modify-write. Failure is observable (warn), never silently swallowed.
 */
async function persistTerminalMemoryStatus(status: BroadcastMemoryUpdateStatus): Promise<void> {
  try {
    const { getIncrementalSessionStore } = await import('./incrementalSessionStore');
    const store = getIncrementalSessionStore();
    const persisted = await store.updateSession(status.originalSessionId, (current) => {
      if (!current) return null;
      return {
        ...current,
        memoryUpdateStatusByTurn: {
          ...(current.memoryUpdateStatusByTurn ?? {}),
          [status.originalTurnId]: status,
        },
        updatedAt: nextContentUpdatedAt(current.updatedAt),
      };
    });
    if (!persisted) {
      log.warn(
        { originalTurnId: status.originalTurnId, statusKind: status.status },
        'Terminal memory status not persisted (session missing, tombstoned, or read-only)',
      );
    }
  } catch (err) {
    log.warn(
      { err, originalTurnId: status.originalTurnId, statusKind: status.status },
      'Failed to persist terminal memory status',
    );
  }
}

// ---------------------------------------------------------------------------
// Memory Update I/O Capture
//
// When CAPTURE_MEMORY_UPDATES=1, logs full memory update inputs/outputs to a
// JSONL file for eval fixture mining. Default OFF to avoid disk bloat.
// See: docs/plans/260414_memory_notes_cost_optimization.md (Stage A)
// ---------------------------------------------------------------------------

const CAPTURE_FILE_NAME = 'memory-update-captures.jsonl';
/** Max chars per tool detail to keep capture file size manageable */
const TOOL_DETAIL_MAX_CHARS = 2000;
const MAX_OUTER_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 15_000;

const MEMORY_UPDATE_WRITE_TOOLS = new Set<string>([
  ...FILE_WRITE_TOOLS,
  'Bash',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
]);

interface CapturedToolCall {
  tool: string;
  stage: 'start' | 'end';
  input_preview: string;
  is_error?: boolean;
}

interface MemoryUpdateCapture {
  ts: number;
  turnId: string;
  originalTurnId: string;
  originalSessionId: string;
  prompt: string;
  resultText?: string;
  entityUpdates?: MemoryEntityUpdate[];
  toolCalls: CapturedToolCall[];
  model?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  durationMs: number;
  error?: string;
}

export interface MemoryUpdateSummaryModelUpdate {
  entity: string;
  action: 'created' | 'updated';
  summary: string;
  filePath: string;
}

export interface MemoryUpdateSummaryModelResponse {
  updates: MemoryUpdateSummaryModelUpdate[];
}

function isCaptureEnabled(): boolean {
  return process.env.CAPTURE_MEMORY_UPDATES === '1';
}

/**
 * Fire-and-forget JSONL append (same pattern as costLedgerService).
 * Errors are logged but never thrown or awaited.
 */
function appendCapture(capture: MemoryUpdateCapture): void {
  try {
    const filePath = path.join(getDataPath(), CAPTURE_FILE_NAME);
    const line = JSON.stringify(capture) + '\n';
    fs.appendFile(filePath, line, 'utf8', (err) => {
      if (err) {
        log.warn({ err, filePath }, 'Failed to append memory update capture');
      } else {
        log.debug({ turnId: capture.turnId }, 'Appended memory update capture');
      }
    });
  } catch (err) {
    log.warn({ err }, 'Failed to prepare memory update capture');
  }
}

export interface TurnContext {
  originalTurnId: string;
  originalSessionId: string; // Main conversation session (for UI filtering)
  userPrompt: string;
  messages: AgentTurnMessage[];
  eventsByTurn: Record<string, AgentEvent[]>;
  /** Private mode from original session (forces always_ask for memory writes) */
  privateMode?: boolean;
}

export type MemoryUpdateDeps = {
  executeAgentTurn: (
    turnId: string,
    prompt: string,
    options: { sessionId: string; originalTurnId: string; originalSessionId: string; privateMode?: boolean; onEvent: (event: AgentEvent) => void }
  ) => Promise<void>;
  getSettings: () => AppSettings;
  broadcastMemoryUpdateStatus: (status: BroadcastMemoryUpdateStatus) => void;
};

let deps: MemoryUpdateDeps | null = null;

export const initializeMemoryUpdateService = (dependencies: MemoryUpdateDeps): void => {
  deps = dependencies;
  log.info('Memory update service initialized');
};

type MemoryUpdateTerminalEvent = Extract<AgentEvent, { type: 'result' | 'error' }>;

interface MemoryUpdateAttemptEventMeta {
  turnId: string;
  sessionId: string;
}

function assertBroadcastHasOriginalSessionId(
  payload: BroadcastMemoryUpdateStatus,
  callsite: string,
): BroadcastMemoryUpdateStatus {
  const parsed = BroadcastMemoryUpdateStatusSchema.safeParse(payload);
  if (!parsed.success) {
    log.error(
      { callsite, issues: parsed.error.issues },
      'Memory update broadcast missing required originalSessionId',
    );
    throw new Error(`Invalid memory update broadcast payload at ${callsite}`);
  }
  return parsed.data;
}

function isWriteEffectfulTool(toolName: string): boolean {
  return MEMORY_UPDATE_WRITE_TOOLS.has(toolName) || toolName.startsWith('mcp__');
}

function isMemoryUpdateRetryableError(event: Extract<AgentEvent, { type: 'error' }>): boolean {
  if (event.isTransient === true) return true;
  if (event.isTransient === false) return false;

  switch (event.errorKind) {
    case 'server_error':
    case 'network':
    case 'rate_limit':
    case 'message_timeout':
      return true;
    case 'billing':
    case 'auth':
    case 'context_overflow':
    case 'invalid_request':
    // Non-transient by definition: a retry re-sends the same image-bearing
    // history to the same text-only model (see modelErrors.ts kind docstring).
    case 'image_input_unsupported':
    // Precondition/config failure (Chief-of-Staff space unavailable), not a
    // transient — retrying the same memory turn won't help. Defensive for
    // exhaustiveness: memory turns are non-interactive and never hit the gate.
    case 'chief-of-staff-unavailable':
      return false;
    case undefined:
    case 'unknown':
    case 'model_unavailable':
    case 'connection-not-configured':
    case 'moderation':
    case 'routing':
    case 'session_not_found':
    case 'tool_name_corrupt':
    case 'managed_model_not_allowed':
    case 'process_exit':
    case 'mcp_error':
    case 'user_action':
    case 'unsupported_model':
    default:
      return isTransientError(event.error);
  }
}

function getRetryDelayMs(retryCount: number): number {
  const baseDelayMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** retryCount, RETRY_MAX_DELAY_MS);
  const jitterMs = baseDelayMs * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.min(RETRY_MAX_DELAY_MS, Math.round(baseDelayMs + jitterMs)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @internal
 * @memoryUpdateOnly
 *
 * DO NOT export. DO NOT call from foreground turn paths. The retry policy here
 * is calibrated for fired-and-forgotten memory-update turns where terminal
 * status is the only user-visible output.
 */
async function executeMemoryUpdateWithRetry({
  deps,
  prompt,
  originalTurnId,
  originalSessionId,
  privateMode,
  onEvent,
  onTerminalEvent,
}: {
  deps: MemoryUpdateDeps;
  prompt: string;
  originalTurnId: string;
  originalSessionId: string;
  privateMode?: boolean;
  onEvent?: (event: AgentEvent, meta: MemoryUpdateAttemptEventMeta) => void;
  onTerminalEvent: (event: MemoryUpdateTerminalEvent, meta: MemoryUpdateAttemptEventMeta) => void | Promise<void>;
}): Promise<void> {
  let retryCount = 0;

  while (true) {
    const turnId = randomUUID();
    const sessionId = `memory-update-${turnId}`;
    const attempt = retryCount + 1;
    let writeActivityObserved = false;
    let transientErrorObserved = false;
    let terminalEvent: MemoryUpdateTerminalEvent | null = null;

    const wrappedOnEvent = (event: AgentEvent): void => {
      onEvent?.(event, { turnId, sessionId });

      if (event.type === 'tool' && isWriteEffectfulTool(event.toolName)) {
        writeActivityObserved = true;
      } else if (event.type === 'result') {
        terminalEvent = event;
      } else if (event.type === 'error') {
        terminalEvent = event;
        transientErrorObserved = isMemoryUpdateRetryableError(event);
      }
    };

    try {
      await deps.executeAgentTurn(turnId, prompt, {
        sessionId,
        originalTurnId,
        originalSessionId,
        privateMode,
        onEvent: wrappedOnEvent,
      });
    } catch (error) {
      if (!terminalEvent) {
        const synthesized = {
          type: 'error' as const,
          error: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        };
        terminalEvent = synthesized as MemoryUpdateTerminalEvent;
        transientErrorObserved = isMemoryUpdateRetryableError(synthesized);
      }
    }

    // The async closure (wrappedOnEvent) may set terminalEvent to either a
    // 'result' or 'error' variant; the catch block can also synthesize 'error'.
    // Cast through the type checker once to re-broaden to the union.
    const settled = terminalEvent as MemoryUpdateTerminalEvent | null;
    if (!settled) {
      log.warn({ turnId, originalTurnId }, 'Memory update attempt ended without terminal event');
      return;
    }

    if (settled.type === 'result') {
      await onTerminalEvent(settled, { turnId, sessionId });
      return;
    }

    if (
      transientErrorObserved &&
      !writeActivityObserved &&
      retryCount < MAX_OUTER_RETRIES &&
      deps.getSettings().memoryUpdateEnabled !== false
    ) {
      const retryCategory =
        settled.errorKind ??
        (settled.isTransient === true ? 'transient_unspecified' : 'unknown');
      log.info(
        { attempt, originalTurnId, retryCategory, retrying: true },
        'Memory update outer retry'
      );
      await sleep(getRetryDelayMs(retryCount));
      // Re-check settings after backoff in case the user disabled memory updates
      // mid-sleep. This is the only legitimate cancellation pathway between
      // attempts (per A1.R5 — controller-based abort is a no-op for fired
      // memory-update turns).
      if (deps.getSettings().memoryUpdateEnabled === false) {
        await onTerminalEvent(settled, { turnId, sessionId });
        return;
      }
      retryCount += 1;
      continue;
    }

    await onTerminalEvent(settled, { turnId, sessionId });
    return;
  }
}

const formatTurnContextForMemoryUpdate = (context: TurnContext): string => {
  const parts: string[] = [
    'Use your memory update skill to process this conversation turn and update memory as appropriate.',
    '',
    'Consult both the rebel-system memory-update skill instructions and any Chief-of-Staff space-specific memory instructions. Follow both as best as possible, but if there is a conflict, the Chief-of-Staff instructions take precedence.',
    '',
    '## User Message',
    '',
    context.userPrompt,
    '',
    '## Agent Response',
    ''
  ];

  for (const message of context.messages) {
    if (message.role === 'assistant') {
      parts.push(`**Assistant:** ${message.text}`);
      parts.push('');
    } else if (message.role === 'result') {
      parts.push(`**Result:** ${message.text}`);
      parts.push('');
    }
  }

  const allEvents = Object.values(context.eventsByTurn).flat();
  const toolEvents = allEvents.filter((e) => e.type === 'tool' && e.stage === 'end');

  if (toolEvents.length > 0) {
    parts.push('## Tool Outputs');
    parts.push('');
    for (const event of toolEvents) {
      if (event.type === 'tool') {
        parts.push(`**${event.toolName}:** ${event.detail.slice(0, 500)}`);
        parts.push('');
      }
    }
  }

  return parts.join('\n');
};

const parseMemoryUpdateSummary = (text: string): string | undefined => {
  const match = text.match(/Memory updated:\s*(.+)/i);
  if (match) {
    return match[0];
  }
  if (text.toLowerCase().includes('no new') || text.toLowerCase().includes('nothing to update')) {
    return 'No new facts to save';
  }
  if (text.trim().length > 0 && text.trim().length < 200) {
    return text.trim();
  }
  return undefined;
};

/**
 * Infer visibility from file path.
 * v3 paths: work/[Company]/[Space]/... = shared, Chief-of-Staff/... = private
 * Legacy: memory/teams/... = shared
 */
export const inferVisibility = (filePath: string): 'private' | 'shared' => {
  const normalized = toPortablePath(filePath).toLowerCase();
  
  if (normalized.startsWith('chief-of-staff/') || normalized.includes('/chief-of-staff/')) {
    return 'private';
  }
  if (normalized.startsWith('personal/') || normalized.includes('/personal/')) {
    return 'private';
  }
  if (normalized.startsWith('work/') || normalized.includes('/work/')) {
    return 'shared';
  }
  if (normalized.includes('memory/teams/')) {
    return 'shared';
  }
  return 'private';
};

/**
 * Parse markdown links from memory update skill output.
 * Expected format:
 *   - Updated [Space Name](path/to/file.md): description
 *   - Created [Space Name](path/to/file.md): description
 */
const parseMarkdownMemoryUpdates = (text: string): MemoryEntityUpdate[] | null => {
  // Match lines like: - Updated [Entity](path): summary  OR  - Created [Entity](path): summary
  const linePattern = /^-\s*(Updated|Created)\s*\[([^\]]+)\]\(([^)]+)\):\s*(.+)$/gim;
  const updates: MemoryEntityUpdate[] = [];
  
  let match;
  while ((match = linePattern.exec(text)) !== null) {
    const [, action, entity, filePath, summary] = match;
    const visibility = inferVisibility(filePath);
    
    updates.push({
      entity: entity.trim(),
      visibility,
      action: action.toLowerCase() as 'created' | 'updated',
      summary: summary.trim().slice(0, 300),
      filePath: filePath.trim()
    });
  }
  
  if (updates.length > 0) {
    log.info({ count: updates.length }, 'Parsed memory updates from markdown links');
    return updates;
  }
  
  return null;
};

const STRUCTURED_SUMMARY_TIMEOUT_MS = 10000;

// Visibility instructions removed from prompt (REBEL-124): the LLM's visibility
// inference was unreliable. inferVisibility() now deterministically overrides it
// from the filePath, so prompting the LLM to classify private/shared wastes tokens
// and risks confusion. The filePath instruction remains critical.
const STRUCTURED_SUMMARY_PROMPT = `You are analyzing the output of a memory update operation. Extract which memory spaces were updated.

Memory spaces are entities like "Chief of Staff", "Mindstone", "Project X", "Exec Team", or other named spaces.

Rules:
- Identify the memory space/entity name
- Determine if each entry was "created" or "updated"
- Provide a brief 3-8 word summary of what was stored
- ALWAYS include the filePath - look for file paths in the output text (e.g., "memory/README.md", "work/Company/Space/memory/topics/file.md")
- If no memory was updated, return an empty updates array`;

// Structured output schema for guaranteed valid JSON
// Note: Anthropic API requires additionalProperties: false on all object types
export const MEMORY_UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    updates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          entity: { 
            type: 'string',
            description: 'Name of the memory space (e.g., "Chief of Staff", "Mindstone")'
          },
          action: { 
            type: 'string', 
            enum: ['created', 'updated'],
            description: 'Whether the memory file was created or updated'
          },
          summary: { 
            type: 'string',
            description: 'Brief 3-8 word summary of what was stored'
          },
          filePath: { 
            type: 'string',
            description: 'Relative file path to the memory file (e.g., "memory/README.md", "work/Mindstone/Exec/memory/topics/project.md")'
          }
        },
        required: ['entity', 'action', 'summary', 'filePath'],
        additionalProperties: false
      }
    }
  },
  required: ['updates'],
  additionalProperties: false
} as const;

export function buildStructuredMemoryUpdateSummaryPrompt(memoryUpdateResultText: string): string {
  return `${getPrompt(PROMPT_IDS.INTELLIGENCE_MEMORY_UPDATE)}

Analyze this memory update output:

${memoryUpdateResultText.slice(0, 4000)}`;
}

export function parseStructuredMemoryUpdateSummaryModelText(
  text: string
): MemoryUpdateSummaryModelResponse | null {
  return safeJsonParseFromModelText<MemoryUpdateSummaryModelResponse>(
    text,
    'memoryUpdate.structuredSummary',
    log
  );
}

export async function getStructuredMemoryUpdateSummary(
  settings: AppSettings,
  memoryUpdateResultText: string
): Promise<MemoryEntityUpdate[] | null> {
  if (!hasValidAuth(settings)) {
    log.warn('Cannot get structured summary: no valid auth');
    return null;
  }

  const prompt = buildStructuredMemoryUpdateSummaryPrompt(memoryUpdateResultText);

  try {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), STRUCTURED_SUMMARY_TIMEOUT_MS);

    log.debug({ model: getEffectiveModelName(settings) }, 'Calling LLM for structured memory summary');

    const response = await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: resolveCodexConnectivity(),
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 512,
      outputFormat: {
        type: 'json_schema',
        schema: MEMORY_UPDATE_SCHEMA
      },
      signal: abortController.signal,
      timeout: STRUCTURED_SUMMARY_TIMEOUT_MS
    }, { category: 'memory' });

    clearTimeout(timeoutId);

    // With structured output, response is guaranteed valid JSON
    const content = response.content?.[0];
    if (content?.type !== 'text' || !content.text) {
      log.warn({ content }, 'Unexpected response format from structured summary');
      return null;
    }

    // Safe parse: fail-open (skip memory update if parsing fails)
    const parsed = parseStructuredMemoryUpdateSummaryModelText(content.text);
    if (!parsed) {
      return null;
    }
    
    if (!parsed.updates || parsed.updates.length === 0) {
      log.debug('No memory updates found in structured summary');
      return null;
    }

    // Set visibility deterministically from file paths (REBEL-124).
    // The LLM schema no longer includes visibility — inferVisibility() is the
    // single source of truth for private vs shared classification.
    const cleanedUpdates = parsed.updates.map((u) => {
      const deterministic = u.filePath ? inferVisibility(u.filePath) : 'private';
      if (!u.filePath) {
        log.debug({ entity: u.entity }, 'Missing filePath from LLM – defaulting to private');
      }
      return {
        ...u,
        summary: u.summary.slice(0, 300),
        visibility: deterministic
      };
    });

    log.info({ entityCount: cleanedUpdates.length }, 'Extracted structured memory update summary');
    return cleanedUpdates;
  } catch (error) {
    // Handle abort
    if (axios.isCancel(error) || (error instanceof Error && error.name === 'AbortError')) {
      log.debug('Structured summary request aborted');
      return null;
    }
    
    // Capture Anthropic API error details for diagnosis
    if (axios.isAxiosError(error) && error.response) {
      log.warn({
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
        errorType: error.response.data?.error?.type,
        errorMessage: error.response.data?.error?.message
      }, 'Structured summary API error with response details');
    } else {
      log.warn({ err: error }, 'Failed to get structured memory update summary');
    }
    return null;
  }
}

export const triggerMemoryUpdate = async (context: TurnContext): Promise<void> => {
  if (!deps) {
    log.warn('Memory update service not initialized');
    return;
  }

  const settings = deps.getSettings();

  if (settings.memoryUpdateEnabled === false) {
    log.debug('Memory updates disabled in settings');
    return;
  }

  if (!settings.coreDirectory) {
    log.debug('No core directory configured, skipping memory update');
    return;
  }

  const { originalTurnId, originalSessionId } = context;

  // Phase 2: Approval happens at tool level (Edit/Create interception)
  // No pre-approval gate here - memory write hook handles it

  const prompt = formatTurnContextForMemoryUpdate(context);

  log.info({ originalTurnId }, 'Triggering memory update');

  deps.broadcastMemoryUpdateStatus(
    assertBroadcastHasOriginalSessionId(
      {
        originalTurnId,
        originalSessionId,
        status: 'running',
        timestamp: Date.now(),
      },
      'triggerMemoryUpdate:running',
    ),
  );

  // --- I/O capture state (only allocated when capture is enabled) ---
  const capturing = isCaptureEnabled();
  const captureStartMs = capturing ? Date.now() : 0;
  const capturedTools: CapturedToolCall[] = capturing ? [] : [];

  const captureEvent = (event: AgentEvent) => {
    // Capture tool events for eval fixture mining
    if (capturing && event.type === 'tool') {
      capturedTools.push({
        tool: event.toolName,
        stage: event.stage,
        input_preview: event.detail.slice(0, TOOL_DETAIL_MAX_CHARS),
        ...(event.isError ? { is_error: true } : {}),
      });
    }
  };

  const onTerminalEvent = async (event: MemoryUpdateTerminalEvent, { turnId }: MemoryUpdateAttemptEventMeta) => {
    if (event.type === 'result') {
      const summary = parseMemoryUpdateSummary(event.text);
      log.info({ turnId, originalTurnId, summary }, 'Memory update completed');

      // Track memory update turn cost for analytics visibility
      const usage = event.usage;
      if (usage) {
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        const cacheReadTokens = usage.cacheReadTokens ?? 0;
        const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
        const totalPromptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
        getTracker().track('Memory Update Turn Completed', {
          turnId,
          originalTurnId,
          originalSessionId: hashSessionId(originalSessionId),
          model: event.model ?? undefined,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
          totalPromptTokens,
          cacheHitRatio: totalPromptTokens > 0
            ? Math.round((cacheReadTokens / totalPromptTokens) * 1000) / 1000
            : 0,
          costUsd: usage.costUsd ?? 0,
          turnCategory: 'memory',
        });
      }
      
      // Try to parse markdown links first (fast, no LLM call needed)
      let entityUpdates = parseMarkdownMemoryUpdates(event.text);
      
      // Fall back to LLM extraction if markdown parsing didn't find updates
      if (!entityUpdates) {
        log.debug('No markdown links found, falling back to LLM extraction');
        entityUpdates = await getStructuredMemoryUpdateSummary(settings, event.text);
      }
      
      const successStatus = assertBroadcastHasOriginalSessionId(
        {
          originalTurnId,
          originalSessionId,
          status: 'success',
          summary,
          entityUpdates: entityUpdates ?? undefined,
          timestamp: Date.now(),
        },
        'triggerMemoryUpdate:success',
      );
      // Broadcast for live UI FIRST (never block the live status on disk I/O),
      // THEN persist the terminal status on the executing surface so a client that
      // missed the broadcast recovers it on sync. Order doesn't affect offline
      // recovery (persist happens either way); broadcast-first keeps the live path
      // resilient if the store write is slow/unavailable.
      deps?.broadcastMemoryUpdateStatus(successStatus);
      await persistTerminalMemoryStatus(successStatus);

      // Write capture on successful completion
      if (capturing) {
        appendCapture({
          ts: Date.now(),
          turnId,
          originalTurnId,
          originalSessionId: hashSessionId(originalSessionId),
          prompt,
          resultText: event.text,
          entityUpdates: entityUpdates ?? undefined,
          toolCalls: capturedTools,
          model: event.model ?? undefined,
          costUsd: usage?.costUsd ?? undefined,
          inputTokens: usage?.inputTokens ?? undefined,
          outputTokens: usage?.outputTokens ?? undefined,
          cacheReadTokens: usage?.cacheReadTokens ?? undefined,
          cacheCreationTokens: usage?.cacheCreationTokens ?? undefined,
          durationMs: Date.now() - captureStartMs,
        });
      }
    } else if (event.type === 'error') {
      log.warn({ turnId, originalTurnId, error: event.error }, 'Memory update failed');
      const errorStatus = assertBroadcastHasOriginalSessionId(
        {
          originalTurnId,
          originalSessionId,
          status: 'error',
          error: event.error,
          timestamp: Date.now(),
        },
        'triggerMemoryUpdate:error',
      );
      deps?.broadcastMemoryUpdateStatus(errorStatus);
      await persistTerminalMemoryStatus(errorStatus);

      // Write capture on error too — useful for debugging failures
      if (capturing) {
        appendCapture({
          ts: Date.now(),
          turnId,
          originalTurnId,
          originalSessionId: hashSessionId(originalSessionId),
          prompt,
          toolCalls: capturedTools,
          durationMs: Date.now() - captureStartMs,
          error: event.error,
        });
      }
    }
  };

  executeMemoryUpdateWithRetry({
    deps,
    prompt,
    originalTurnId,
    originalSessionId,
    privateMode: context.privateMode,
    onEvent: captureEvent,
    onTerminalEvent,
  }).catch(async (error) => {
    log.warn({ err: error, originalTurnId }, 'Memory update retry wrapper failed silently');
    const wrapperErrorStatus = assertBroadcastHasOriginalSessionId(
      {
        originalTurnId,
        originalSessionId,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      },
      'triggerMemoryUpdate:wrapper-failure',
    );
    deps?.broadcastMemoryUpdateStatus(wrapperErrorStatus);
    await persistTerminalMemoryStatus(wrapperErrorStatus);

    // Write capture on unhandled failure
    if (capturing) {
      appendCapture({
        ts: Date.now(),
        turnId: `memory-update-wrapper-${originalTurnId}`,
        originalTurnId,
        originalSessionId: hashSessionId(originalSessionId),
        prompt,
        toolCalls: capturedTools,
        durationMs: Date.now() - captureStartMs,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
