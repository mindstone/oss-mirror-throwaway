import { z } from 'zod';
import type { ChatMessage, ToolUseBlock, ToolResultBlock, TokenUsage } from './modelTypes';
import type { ModelClient } from './modelClient';
import type { RebelCoreContextState } from './taskState';
import { createScopedLogger } from '@core/logger';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import type { RoutingModelId } from '@shared/utils/modelChoiceCodec';
import type { FailureReason } from '@shared/costOutcome';

const log = createScopedLogger({ service: 'contextStateUpdate' });

/**
 * Output token budget for the context-state update call.
 *
 * The old value (2000) caused ~97% of compaction attempts to fail: the model
 * emits the FULL cumulative state JSON, and once that exceeds the cap the JSON
 * truncates mid-structure → `JSON.parse` throws → `ok:false` → prune skipped →
 * still billed (confirmed in the cost-ledger: 241/250 rows pinned at outTok 2000).
 * Real states top out ~2300 tokens (measured across 2106 persisted task-boards),
 * so 8192 is ~3.4× the largest observed state. Cost is charged on *actual*
 * output, not the reserved cap, so the only downside is worst-case overgeneration
 * — bounded by {@link boundContextState}. See docs/plans/260612_compaction-state-cap.
 */
export const CONTEXT_STATE_UPDATE_MAX_TOKENS = 8192;

/**
 * Per-category item budget for {@link boundContextState}. The prompt instructs
 * the model never to delete prior entries, so the cumulative state grows
 * monotonically across prunes — any fixed output cap is otherwise a future wall.
 * Bounding the arrays makes the serialized state's size bounded *by construction*,
 * independent of session length. Set far above the largest observed real state
 * (kd=5, artifacts=15) so it never bites in practice but caps the worst case.
 */
export const CONTEXT_STATE_MAX_ITEMS_PER_CATEGORY = 40;

/** Hard bound on the free-text rolling summary so one field can't blow the cap. */
export const CONTEXT_STATE_MAX_SUMMARY_CHARS = 4000;

/**
 * Wall-clock budget for the context-state update call. Raised from 30s alongside
 * the larger output cap: emitting up to {@link CONTEXT_STATE_UPDATE_MAX_TOKENS}
 * tokens (esp. on slower or reasoning models) can exceed 30s, which would abort
 * mid-generation and resurface the same `ok:false` → prune-skipped failure for a
 * non-truncation reason. Compaction is awaited on the betweenTurns path, so this
 * is a deliberate, bounded ceiling.
 */
export const CONTEXT_STATE_UPDATE_TIMEOUT_MS = 60_000;

const ContextStateUpdateSchema = z.object({
  taskContext: z.object({
    goals: z.string().catch(''),
    constraints: z.string().catch(''),
    requirements: z.string().catch('')
  }).catch({ goals: '', constraints: '', requirements: '' }),
  keyDecisions: z.array(z.object({
    choice: z.string().catch(''),
    rationale: z.string().catch(''),
    rejectedAlternatives: z.array(z.string()).catch([])
  })).catch([]),
  artifacts: z.array(z.object({
    pathOrUrl: z.string().catch(''),
    identifier: z.string().catch('')
  })).catch([]),
  constraints: z.array(z.string()).catch([]),
  progressState: z.object({
    accomplished: z.array(z.string()).catch([]),
    remaining: z.array(z.string()).catch([]),
    blockers: z.array(z.string()).catch([]),
    failedApproaches: z.array(z.string()).catch([])
  }).catch({ accomplished: [], remaining: [], blockers: [], failedApproaches: [] }),
  recentContextSummary: z.string().catch(''),
}).partial();

export function extractOldToolPairs(messages: ChatMessage[], keepRecent: number): ChatMessage[] {
  if (messages.length === 0 || keepRecent < 0) return [];

  // This is a simplified extraction of what pruneOldToolPairs would remove.
  // Instead of complex index tracking, we just extract all tool_use/tool_result pairs
  // and return the oldest ones.
  const extracted: ChatMessage[] = [];
  const completePairs: Array<{ use: ToolUseBlock; result: ToolResultBlock; useId: string }> = [];

  const toolUseMap = new Map<string, ToolUseBlock>();
  const toolResultMap = new Map<string, ToolResultBlock>();

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') toolUseMap.set(block.id, block);
      else if (block.type === 'tool_result') toolResultMap.set(block.tool_use_id, block);
    }
  }

  for (const [toolUseId, useBlock] of toolUseMap) {
    const resultBlock = toolResultMap.get(toolUseId);
    if (resultBlock) {
      completePairs.push({ use: useBlock, result: resultBlock, useId: toolUseId });
    }
  }

  const removeCount = Math.max(completePairs.length - keepRecent, 0);
  if (removeCount === 0) return [];

  const pairsToRemove = completePairs.slice(0, removeCount);
  
  // Format them into a pseudo-message history for the LLM
  for (const pair of pairsToRemove) {
    extracted.push({ role: 'assistant', content: [pair.use] });
    extracted.push({ role: 'user', content: [pair.result] });
  }

  return extracted;
}

// See contextPreservation.ts for the shared 6-category preservation schema.
import { PRESERVATION_CATEGORIES } from './contextPreservation';

/**
 * Get the context state update prompt (lazy access via prompt file service).
 * Pre-serializes PRESERVATION_CATEGORIES for the Nunjucks template.
 */
function getUpdatePrompt(): string {
  const categoriesText = PRESERVATION_CATEGORIES.map((cat, i) => `${i + 1}. ${cat.key}: ${cat.instruction}`).join('\n');
  return getPrompt(PROMPT_IDS.AGENT_CONTEXT_STATE_UPDATE, { categories: categoriesText });
}

/**
 * Why a context-state update did not produce a usable state. Mirrors the shared
 * cost-ledger `FailureReason` vocabulary so the caller can attribute the failed
 * attempt honestly instead of the catch-all `'other'`. `truncated` is the bug
 * this work fixes — the model hit the output cap (`stopReason: max_tokens`).
 */
export type ContextStateUpdateFailureReason =
  | 'truncated'
  | 'parse_error'
  | 'empty'
  | 'timeout'
  | 'aborted';

export interface ContextStateUpdateResult {
  ok: boolean;
  state: RebelCoreContextState;
  usage?: TokenUsage;
  /** Present only when `ok === false`; lets the caller categorize the failure. */
  failureReason?: ContextStateUpdateFailureReason;
}

/**
 * Map an update failure to the shared cost-ledger {@link FailureReason} so the
 * billed-but-failed attempt is attributed honestly (not the catch-all `other`).
 */
export function contextStateFailureToLedgerReason(
  reason: ContextStateUpdateFailureReason | undefined,
): FailureReason {
  switch (reason) {
    case 'truncated':
      return 'truncated';
    case 'timeout':
      return 'timeout';
    case 'parse_error':
    case 'empty':
      return 'parse_error';
    case 'aborted': // turn cancelled by the user/parent — not a model failure
    case undefined:
      return 'other';
  }
}

/** Provider stop reasons that mean the model was cut off at the output cap. */
const TRUNCATION_STOP_REASONS = new Set(['max_tokens', 'length']);

/** Concatenate every text block (models may emit thinking/other blocks first). */
function collectText(content: ReadonlyArray<{ type: string }>): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Scan a balanced top-level `{...}` starting at `start`; null if never closed. */
function scanBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // never closed → truncated / malformed
}

/**
 * Extract the first balanced top-level `{...}` object from model output. Robust
 * to markdown code fences and to leading/trailing prose, and scans brace depth
 * while respecting string literals and escapes — far safer than the old greedy
 * `/\{.*\}/s`, which spanned the first `{` to the *last* `}` anywhere in the
 * text. Returns `null` when no balanced object is present (e.g. the output was
 * truncated before its closing brace). The caller validates it as JSON/schema
 * and attributes a `parse_error` if this balanced chunk isn't valid JSON.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  return scanBalancedObject(text, start);
}

/** Keep the most-recent `max` items (newest assumed at the tail), deduped by `keyOf`. */
function keepRecentDeduped<T>(items: T[], keyOf: (item: T) => string, max: number): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  // Walk newest→oldest so the *first* occurrence of a duplicate (the most recent) wins.
  for (let i = items.length - 1; i >= 0; i--) {
    const key = keyOf(items[i]);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(items[i]);
    if (deduped.length >= max) break;
  }
  return deduped.reverse();
}

/**
 * Bound the cumulative context state so its serialized size can't grow without
 * limit across prunes (the prompt tells the model never to delete prior entries,
 * so the arrays otherwise grow monotonically and eventually breach any output
 * cap). Caps each append-prone category to the most-recent
 * {@link CONTEXT_STATE_MAX_ITEMS_PER_CATEGORY} deduped items and bounds the
 * rolling summary. Pure; never throws. Idempotent (bounding an already-bounded
 * state is a no-op). See docs/plans/260612_compaction-state-cap.
 */
export function boundContextState(state: RebelCoreContextState): RebelCoreContextState {
  const N = CONTEXT_STATE_MAX_ITEMS_PER_CATEGORY;
  const summary = state.recentContextSummary ?? '';
  return {
    ...state,
    keyDecisions: keepRecentDeduped(state.keyDecisions ?? [], (d) => d.choice, N),
    // Composite key: two artifacts sharing a path but with different identifiers
    // (e.g. proposal.docx "budget table" vs "risk table") are distinct entries.
    artifacts: keepRecentDeduped(state.artifacts ?? [], (a) => `${a.pathOrUrl} ${a.identifier}`, N),
    constraints: keepRecentDeduped(state.constraints ?? [], (c) => c, N),
    progressState: {
      accomplished: keepRecentDeduped(state.progressState?.accomplished ?? [], (s) => s, N),
      remaining: keepRecentDeduped(state.progressState?.remaining ?? [], (s) => s, N),
      blockers: keepRecentDeduped(state.progressState?.blockers ?? [], (s) => s, N),
      failedApproaches: keepRecentDeduped(state.progressState?.failedApproaches ?? [], (s) => s, N),
    },
    // "Recent context" — keep the TAIL (most-recent text), not the head.
    recentContextSummary:
      summary.length > CONTEXT_STATE_MAX_SUMMARY_CHARS
        ? '…[earlier truncated] ' + summary.slice(-CONTEXT_STATE_MAX_SUMMARY_CHARS)
        : summary,
  };
}

export async function updateContextStateViaLLM(
  client: ModelClient,
  model: RoutingModelId,
  currentState: RebelCoreContextState,
  prunedMessages: ChatMessage[],
  parentSignal?: AbortSignal,
): Promise<ContextStateUpdateResult> {
  if (prunedMessages.length === 0) return { ok: true, state: currentState };
  if (parentSignal?.aborted) return { ok: false, state: currentState };

  let usage: TokenUsage | undefined;

  try {
    const prunedText = JSON.stringify(prunedMessages, null, 2);
    const userPrompt = `Current State:\n${JSON.stringify(currentState, null, 2)}\n\nPruned Interactions:\n${prunedText}\n\nReturn the updated JSON state.`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONTEXT_STATE_UPDATE_TIMEOUT_MS);
    const onParentAbort = (): void => controller.abort();
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });

    let result;
    try {
      result = await client.create({
        model,
        maxTokens: CONTEXT_STATE_UPDATE_MAX_TOKENS,
        systemPrompt: getUpdatePrompt(),
        messages: [{ role: 'user', content: userPrompt }],
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }

    usage = result.usage ?? undefined;
    const stopReason = result.stopReason ?? '';
    const truncated = TRUNCATION_STOP_REASONS.has(stopReason);
    const outputText = collectText(result.content);
    const jsonText = extractFirstJsonObject(outputText);
    const outputTokens = usage?.outputTokens;
    const nearCap =
      typeof outputTokens === 'number' &&
      outputTokens >= CONTEXT_STATE_UPDATE_MAX_TOKENS * 0.8;

    let parseError: unknown;
    if (jsonText) {
      try {
        const parsedJson = JSON.parse(jsonText);
        const newState = ContextStateUpdateSchema.parse(parsedJson);
        const mergedState = boundContextState({ ...currentState, ...newState });
        const updatedFields = Object.keys(newState).filter((k) => newState[k as keyof typeof newState] !== undefined);
        if (nearCap) {
          // Early warning before the next truncation cliff (output ≥80% of cap).
          log.warn({ model, outputTokens, cap: CONTEXT_STATE_UPDATE_MAX_TOKENS, stopReason },
            'Context state update succeeded but output is near the token cap');
        }
        log.debug({
          prunedMessageCount: prunedMessages.length,
          updatedFields,
          updatedFieldCount: updatedFields.length,
        }, 'Context state updated via LLM');
        return { ok: true, state: mergedState, usage };
      } catch (err) {
        // Balanced object extracted but not valid JSON / schema; retain the error
        // so the failure below is observable, then fall through to the failure path.
        parseError = err;
      }
    }

    // No usable JSON. Distinguish truncation (the cap was hit) from a genuine
    // parse failure so the caller can attribute the cost honestly.
    const failureReason: ContextStateUpdateFailureReason = truncated ? 'truncated' : 'parse_error';
    log.warn({
      model,
      prunedMessageCount: prunedMessages.length,
      stopReason,
      outputTokens,
      cap: CONTEXT_STATE_UPDATE_MAX_TOKENS,
      failureReason,
      parseError: parseError instanceof Error ? parseError.message : parseError ? String(parseError) : undefined,
      outputSnippet: outputText.slice(0, 300),
    }, 'Context state update returned no usable JSON');
    return { ok: false, state: currentState, usage, failureReason };
  } catch (error) {
    const isTimeout =
      (error instanceof Error && error.name === 'AbortError') || parentSignal?.aborted === true;
    log.warn({
      err: error instanceof Error ? error.message : String(error),
      model,
      prunedMessageCount: prunedMessages.length,
      isTimeout,
    }, 'Failed to update context state via LLM');
    return {
      ok: false,
      state: currentState,
      usage,
      failureReason: isTimeout ? (parentSignal?.aborted ? 'aborted' : 'timeout') : 'parse_error',
    };
  }
}
