/**
 * Inbox Domain IPC Handlers
 *
 * Handles inbox management operations.
 */

import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  getInboxState,
  deleteInboxItemById,
  recordInboxExecutionEntry,
  markInboxItemAsArchived,
  setInboxItemArchived,
  setInboxItemQuadrant,
  setInboxItemExecuting,
  setInboxItemStatus,
  loadInboxIndex,
  loadInboxItems,
  validateItemId,
  addInboxItem,
  updateInboxItem,
  readEntryFile,
  upsertInboxItemFromCloud,
  emitInboxState,
  retroactiveInboxCleanup,
  periodicFreshnessCheck,
} from '../services/inboxStore';
import type { InboxExecutionMode, InboxItem, InboxItemCategory, InboxItemStatus, InboxReference } from '@shared/types';
import { registerHandler } from './utils/registerHandler';
import { isNonEmptyString } from '@shared/utils/validators';
import { createScopedLogger } from '@core/logger';
import { parseUseToolEnvelopeJson } from '@core/rebelCore/superMcpEnvelope';
import { sessionCoachingScheduler } from '../services/sessionCoachingScheduler';
import { superMcpHttpManager } from '../services/superMcpHttpManager';

const log = createScopedLogger({ service: 'inboxHandlers' });

type InboxAddPayload = {
  title: string;
  text?: string;
  urgent?: boolean;
  important?: boolean;
  id?: string;
  category?: InboxItemCategory;
  tags?: string[];
  dueBy?: number;
};

// ---------------------------------------------------------------------------
// Resolution check: detect user replies in email threads via MCP
// ---------------------------------------------------------------------------

const RESOLUTION_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const RESOLUTION_NORMAL_MAX_ITEMS = 15;
const RESOLUTION_BACKLOG_MAX_ITEMS = 100;
const MCP_TOOL_TIMEOUT_MS = 15_000;
const MCP_CLIENT_INFO = { name: 'rebel-resolution-check', version: '1.0.0' };

let lastResolutionCheckMs = 0;

export type ResolutionCheckMode = 'normal' | 'backlog';

export type ResolutionCheckInput = {
  maxItems?: number;
  mode?: ResolutionCheckMode;
  dryRun?: boolean;
};

export type ResolutionCheckItemResult = {
  itemId: string;
  title: string;
  status: 'resolved' | 'active' | 'unsupported' | 'error';
  evidence?: string;
};

export type ResolutionCheckResult = {
  checked: number;
  archived: number;
  wouldArchive?: number;
  skipped?: boolean;
  mode: ResolutionCheckMode;
  candidates: number;
  results: ResolutionCheckItemResult[];
};

async function callResolutionMcpTool(
  mcpUrl: string,
  packageId: string,
  toolId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const client = new Client(MCP_CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), MCP_TOOL_TIMEOUT_MS);

  try {
    await client.connect(transport);

    const toolCallPromise = client.callTool({
      name: 'use_tool',
      arguments: { package_id: packageId, tool_id: toolId, args },
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutController.signal.addEventListener(
        'abort',
        () => reject(new Error('MCP resolution check timed out')),
        { once: true },
      );
    });

    const result = (await Promise.race([toolCallPromise, timeoutPromise])) as Awaited<typeof toolCallPromise>;
    const content = Array.isArray((result as { content?: unknown }).content)
      ? (result as { content: unknown[] }).content
      : [];
    const textEntry = content.find(
      (e): e is { type: 'text'; text: string } =>
        typeof e === 'object' &&
        e !== null &&
        (e as { type?: unknown }).type === 'text' &&
        typeof (e as { text?: unknown }).text === 'string',
    );
    if (!textEntry) throw new Error('No text response from MCP tool');

    // Unwrap use_tool envelope if present. parseUseToolEnvelopeJson strips
    // any "\n\n[...]" suffix Super-MCP may append (continuation hints, warnings).
    const parsed = parseUseToolEnvelopeJson<{
      package_id?: string; tool_id?: string;
      result?: { content?: Array<{ type?: string; text?: string }> };
    }>(textEntry.text);
    if (parsed?.package_id && parsed.result?.content) {
      const inner = parsed.result.content.find(c => c?.type === 'text' && typeof c.text === 'string');
      if (inner?.text) return inner.text;
    }

    return textEntry.text;
  } finally {
    clearTimeout(timeoutId);
    try { await transport.terminateSession(); } catch { /* ignore */ }
    try { await client.close(); } catch { /* ignore */ }
  }
}

/**
 * Check if an email thread contains a message sent by the user after `sinceMs`.
 * Returns true if a user reply was detected.
 */
async function checkGmailThread(
  mcpUrl: string,
  packageId: string,
  threadId: string,
  sinceMs: number,
): Promise<boolean> {
  const toolId = `${packageId}__get_workspace_email_thread`;
  const raw = await callResolutionMcpTool(mcpUrl, packageId, toolId, {
    threadId,
    returnJson: true,
    maxMessages: 20,
    includeBody: false,
  });

  let data: unknown;
  try { data = JSON.parse(raw); } catch { return false; }
  if (!data || typeof data !== 'object') return false;

  const messages = Array.isArray((data as Record<string, unknown>).messages)
    ? (data as { messages: Array<Record<string, unknown>> }).messages
    : [];

  for (const msg of messages) {
    const isSent =
      (msg.labelIds && Array.isArray(msg.labelIds) && (msg.labelIds as string[]).includes('SENT')) ||
      msg.from_me === true;
    if (!isSent) continue;

    const dateRaw = msg.date ?? msg.internalDate ?? msg.receivedDateTime;
    let msgTime = 0;
    if (typeof dateRaw === 'number') {
      msgTime = dateRaw;
    } else if (typeof dateRaw === 'string') {
      msgTime = /^\d+$/.test(dateRaw) ? Number(dateRaw) : new Date(dateRaw).getTime();
    }
    if (Number.isFinite(msgTime) && msgTime > sinceMs) return true;
  }

  return false;
}

const COMPLETION_PRONE_RE = /\b(reply|respond|follow\s+up|check|confirm|review|comment|approve)\b/i;

function hasExactResolutionReference(item: InboxItem): boolean {
  return item.references?.some(ref =>
    ref.kind === 'email' ||
    ref.kind === 'url' ||
    ref.kind === 'workspace' ||
    ref.kind === 'linear' ||
    ref.kind === 'github' ||
    ref.kind === 'asana'
  ) ?? false;
}

export function findSupportedEmailReference(
  item: InboxItem,
): Extract<InboxReference, { kind: 'email' }> | undefined {
  return item.references?.find(
    (ref): ref is Extract<InboxReference, { kind: 'email' }> =>
      ref.kind === 'email' && Boolean(ref.threadId) && ref.provider === 'gmail'
  );
}

function hasSupportedEmailReference(item: InboxItem): boolean {
  return Boolean(findSupportedEmailReference(item));
}

function hasCompletionProneSignal(item: InboxItem): boolean {
  return COMPLETION_PRONE_RE.test(`${item.title}\n${item.text}`);
}

function resolutionCandidateSortKey(item: InboxItem, now: number): [number, number, number] {
  const dueBy = typeof item.dueBy === 'number' ? item.dueBy : undefined;
  const dueSoon = dueBy !== undefined && dueBy <= now + 24 * 60 * 60 * 1000;
  const referenceRichCompletion = hasExactResolutionReference(item) && hasCompletionProneSignal(item);
  return [
    dueSoon ? 0 : 1,
    referenceRichCompletion ? 0 : 1,
    item.addedAt,
  ];
}

export function selectResolutionCandidates(
  items: InboxItem[],
  input: { mode: ResolutionCheckMode; maxItems?: number; now?: number },
): InboxItem[] {
  const now = input.now ?? Date.now();
  const defaultLimit = input.mode === 'backlog' ? RESOLUTION_BACKLOG_MAX_ITEMS : RESOLUTION_NORMAL_MAX_ITEMS;
  const requestedLimit = input.maxItems ?? defaultLimit;
  const limit = input.mode === 'backlog'
    ? Math.min(requestedLimit, RESOLUTION_BACKLOG_MAX_ITEMS)
    : Math.min(requestedLimit, RESOLUTION_NORMAL_MAX_ITEMS);

  return [...items]
    .sort((a, b) => {
      const aKey = resolutionCandidateSortKey(a, now);
      const bKey = resolutionCandidateSortKey(b, now);
      return aKey[0] - bKey[0] || aKey[1] - bKey[1] || aKey[2] - bKey[2];
    })
    .slice(0, limit);
}

export function selectEmailResolutionCandidates(
  items: InboxItem[],
  input: { mode: ResolutionCheckMode; maxItems?: number; now?: number },
): InboxItem[] {
  return selectResolutionCandidates(items.filter(hasSupportedEmailReference), input);
}

async function performResolutionCheck(
  input: ResolutionCheckInput = {},
): Promise<ResolutionCheckResult> {
  const mode: ResolutionCheckMode = input.mode === 'backlog' ? 'backlog' : 'normal';
  const now = Date.now();
  if (mode === 'backlog' && input.dryRun !== true) {
    log.warn('Rejected backlog resolution check without dryRun=true');
    return { checked: 0, archived: 0, wouldArchive: 0, skipped: true, mode, candidates: 0, results: [] };
  }
  if (mode === 'normal' && now - lastResolutionCheckMs < RESOLUTION_COOLDOWN_MS) {
    return { checked: 0, archived: 0, skipped: true, mode, candidates: 0, results: [] };
  }

  const index = loadInboxIndex();
  const activeIds = index.entries
    .filter(e => !e.archived && e.status !== 'completed' && e.status !== 'dismissed')
    .map(e => e.id);

  if (activeIds.length === 0) return { checked: 0, archived: 0, mode, candidates: 0, results: [] };

  const activeItems = await loadInboxItems(activeIds);
  const emailItems = selectEmailResolutionCandidates(activeItems, { mode, maxItems: input.maxItems, now });
  const results: ResolutionCheckItemResult[] = [];

  if (emailItems.length === 0) return { checked: 0, archived: 0, wouldArchive: 0, mode, candidates: 0, results };

  const mcpState = superMcpHttpManager.getState();
  if (!mcpState.isRunning || !mcpState.url) {
    log.debug('Super-MCP not running, skipping resolution check');
    return { checked: 0, archived: 0, wouldArchive: 0, mode, candidates: emailItems.length, results };
  }

  let checked = 0;
  let archived = 0;
  let wouldArchive = 0;

  for (const item of emailItems) {
    const emailRef = findSupportedEmailReference(item);
    if (!emailRef?.threadId || !emailRef.provider) continue;

    try {
      let resolved = false;

      if (emailRef.provider === 'gmail') {
        resolved = await checkGmailThread(
          mcpState.url,
          'GoogleWorkspace',
          emailRef.threadId,
          item.addedAt,
        );
      } else {
        log.debug({ provider: emailRef.provider, itemId: item.id }, 'Skipping unsupported email provider for resolution check');
      }

      checked++;
      if (resolved) {
        if (!input.dryRun) {
          setInboxItemStatus(item.id, 'completed', 'rebel');
          archived++;
        } else {
          wouldArchive++;
        }
        results.push({
          itemId: item.id,
          title: item.title,
          status: 'resolved',
          evidence: 'User reply detected in referenced email thread',
        });
        log.info({ itemId: item.id, threadId: emailRef.threadId }, 'Resolution check: archived item (user reply detected)');
      } else {
        results.push({ itemId: item.id, title: item.title, status: 'active' });
      }
    } catch (err) {
      results.push({
        itemId: item.id,
        title: item.title,
        status: 'error',
        evidence: err instanceof Error ? err.message : 'Resolution check failed',
      });
      log.warn({ err, itemId: item.id }, 'Resolution check failed for item (non-critical)');
    }
  }

  if (mode === 'normal' && !input.dryRun) {
    lastResolutionCheckMs = Date.now();
  }

  if (checked > 0) {
    log.info({ checked, archived }, 'Resolution check complete');
  }

  return { checked, archived, wouldArchive, mode, candidates: emailItems.length, results };
}

export interface InboxHandlerDeps {
  // No deps needed for now
}

export function registerInboxHandlers(_deps: InboxHandlerDeps = {}): void {
  registerHandler('inbox:load', (_event: HandlerInvokeEvent) => {
    return getInboxState();
  });

  // Stage 2.4: New lazy loading handlers
  registerHandler('inbox:load-index', (_event: HandlerInvokeEvent) => {
    periodicFreshnessCheck();
    return loadInboxIndex();
  });

  registerHandler(
    'inbox:load-items',
    async (_event: HandlerInvokeEvent, payload: { ids: string[] }): Promise<InboxItem[]> => {
      if (!payload || !Array.isArray(payload.ids)) {
        log.warn({ payload }, 'Invalid inbox:load-items payload');
        return [];
      }
      
      // Validate all IDs are UUIDs (path traversal protection)
      const validIds = payload.ids.filter(id => {
        if (!validateItemId(id)) {
          log.warn({ id }, 'Invalid item ID in inbox:load-items - skipping');
          return false;
        }
        return true;
      });
      
      // loadInboxItems handles batching internally (50 items per batch)
      // to avoid EMFILE limits while still returning all requested items
      return loadInboxItems(validIds);
    }
  );

  registerHandler('inbox:delete', (_event: HandlerInvokeEvent, itemId: string) => {
    if (!isNonEmptyString(itemId)) {
      return getInboxState();
    }
    return deleteInboxItemById(itemId);
  });

  registerHandler(
    'inbox:record-execution',
    (
      _event: HandlerInvokeEvent,
      payload: { itemId: string; sessionId: string; mode: InboxExecutionMode; executedAt?: number }
    ) => {
      if (!payload || !isNonEmptyString(payload.itemId)) {
        return getInboxState();
      }
      return recordInboxExecutionEntry(
        payload.itemId,
        isNonEmptyString(payload.sessionId) ? payload.sessionId : randomUUID(),
        payload.mode === 'execute_with_context' ? 'execute_with_context' : 'execute',
        payload.executedAt
      );
    }
  );

  registerHandler('inbox:mark-archived', (_event: HandlerInvokeEvent, itemId: string) => {
    if (!isNonEmptyString(itemId)) {
      return getInboxState();
    }
    return markInboxItemAsArchived(itemId);
  });

  registerHandler(
    'inbox:set-archived',
    (_event: HandlerInvokeEvent, payload: { itemId: string; archived: boolean }) => {
      if (!payload || !isNonEmptyString(payload.itemId)) {
        return getInboxState();
      }
      return setInboxItemArchived(payload.itemId, payload.archived);
    }
  );

  registerHandler(
    'inbox:set-quadrant',
    (_event: HandlerInvokeEvent, payload: { itemId: string; urgent: boolean; important: boolean }) => {
      if (!payload || !isNonEmptyString(payload.itemId)) {
        return getInboxState();
      }
      return setInboxItemQuadrant(payload.itemId, payload.urgent, payload.important);
    }
  );

  registerHandler(
    'inbox:set-dueBy',
    (_event: HandlerInvokeEvent, payload: { itemId: string; dueBy: number | null }) => {
      if (!payload || !isNonEmptyString(payload.itemId)) {
        return getInboxState();
      }
      if (payload.dueBy === null) {
        return updateInboxItem(payload.itemId, { dueBy: null as unknown as number });
      }
      return updateInboxItem(payload.itemId, { dueBy: payload.dueBy });
    }
  );

  registerHandler(
    'inbox:set-executing',
    (_event: HandlerInvokeEvent, payload: { itemId: string; sessionId: string | null; autoCompleteOnExecution?: boolean }) => {
      if (!payload || !isNonEmptyString(payload.itemId)) {
        return getInboxState();
      }
      return setInboxItemExecuting(payload.itemId, payload.sessionId, {
        autoCompleteOnExecution: payload.autoCompleteOnExecution,
      });
    }
  );

  registerHandler(
    'inbox:set-status',
    (_event: HandlerInvokeEvent, payload: {
      itemId: string;
      status: InboxItemStatus;
      completedBy?: 'user' | 'rebel';
      dismissedReasonCategory?: 'not_useful' | 'not_an_action' | 'wrong_context' | 'already_handled' | 'other';
      dismissedReason?: string;
    }) => {
      if (!payload || !isNonEmptyString(payload.itemId)) {
        return getInboxState();
      }
      return setInboxItemStatus(payload.itemId, payload.status, payload.completedBy, {
        dismissedReasonCategory: payload.dismissedReasonCategory,
        dismissedReason: payload.dismissedReason,
      });
    }
  );

  registerHandler(
    'inbox:set-tags',
    (_event: HandlerInvokeEvent, payload: { itemId: string; tags: string[] }) => {
      if (!payload || !isNonEmptyString(payload.itemId)) {
        return getInboxState();
      }
      return updateInboxItem(payload.itemId, { tags: payload.tags });
    }
  );

  registerHandler(
    'inbox:add',
    (_event: HandlerInvokeEvent, payload: InboxAddPayload) => {
      if (!payload || !isNonEmptyString(payload.title)) {
        return getInboxState();
      }
      // NOTE: Mutating payload.id here (not reassigning) ensures the cloud dual-write
      // forward in ElectronHandlerRegistry sees the same ID. The registry forwards
      // the original args array reference — property mutations propagate, reassignments don't.
      if (!payload.id) {
        payload.id = randomUUID();
      }
      const result = addInboxItem({
        title: payload.title,
        text: payload.text,
        urgent: payload.urgent,
        important: payload.important,
        id: payload.id,
        category: payload.category ?? 'user-request',
        tags: payload.tags,
        dueBy: payload.dueBy,
      });
      if (result.redirected && result.redirectTarget === 'coach') {
        try {
          sessionCoachingScheduler.addAutomationInsight({
            insightId: payload.id,
            title: payload.title,
            text: payload.text,
          });
        } catch (err) {
          log.warn({ err, title: payload.title }, 'Failed to route redirected item to Coach');
        }
      }
      if (!result.accepted) {
        log.info(
          { title: payload.title, rejected: !result.redirected, redirected: result.redirected, reason: result.rejectedReason },
          'IPC inbox:add item filtered',
        );
      }
      return result.state;
    }
  );

  registerHandler(
    'inbox:upsert',
    (_event: HandlerInvokeEvent, payload: InboxItem) => {
      if (!payload || !isNonEmptyString(payload.id) || !isNonEmptyString(payload.title)) {
        return getInboxState();
      }
      if (!validateItemId(payload.id)) {
        throw new Error('Invalid item ID');
      }
      const added = upsertInboxItemFromCloud(payload);
      if (!added) {
        log.debug({ id: payload.id }, 'inbox:upsert skipped (item exists or write failed)');
      }
      const state = getInboxState();
      // Emit so onInboxStateChange fires — on cloud-service this triggers
      // inbox:changed broadcast to other connected clients (mobile/web).
      if (added) emitInboxState(state);
      return state;
    }
  );

  registerHandler(
    'inbox:check-resolution',
    async (_event: HandlerInvokeEvent, payload?: ResolutionCheckInput) => {
      try {
        return await performResolutionCheck(payload);
      } catch (err) {
        log.warn({ err }, 'Resolution check failed (non-critical)');
        return { checked: 0, archived: 0, wouldArchive: 0, mode: payload?.mode === 'backlog' ? 'backlog' : 'normal', candidates: 0, results: [] };
      }
    }
  );

  registerHandler(
    'inbox:execute',
    (_event: HandlerInvokeEvent, payload: { itemId: string; sessionId?: string; context?: string }) => {
      if (!payload || !isNonEmptyString(payload.itemId)) {
        throw new Error('itemId is required');
      }
      // Generate deterministic sessionId for dual-write: cloud receives the same sessionId
      // via args mutation (ElectronHandlerRegistry forwards the same args reference).
      if (!payload.sessionId) {
        payload.sessionId = randomUUID();
      }

      const item = readEntryFile(payload.itemId);
      if (!item) {
        // Fallback: search full state for legacy items
        const state = getInboxState();
        const legacyItem = state.items.find((i) => i.id === payload.itemId);
        if (!legacyItem) {
          throw new Error(`Inbox item not found: ${payload.itemId}`);
        }
        return executeInboxItem(legacyItem, payload.sessionId, payload.context);
      }

      return executeInboxItem(item, payload.sessionId, payload.context);
    }
  );

  // One-time retroactive cleanup of existing inbox items.
  // Deferred via setTimeout so it runs after app rendering completes
  // (queueMicrotask runs before pending I/O and could block startup).
  setTimeout(() => {
    try {
      const result = retroactiveInboxCleanup();
      if (result.redirectedToCoach > 0) {
        for (const item of result.itemsForCoach) {
          try {
            sessionCoachingScheduler.addAutomationInsight({
              insightId: item.id,
              title: item.title,
              text: item.text,
              sourceLabel: item.sourceLabel,
            });
          } catch (err) {
            log.warn({ err, title: item.title }, 'Failed to route cleanup item to Coach');
          }
        }
      }
    } catch (err) {
      log.warn({ err }, 'Retroactive inbox cleanup failed (non-critical)');
    }

    try {
      const freshness = periodicFreshnessCheck();
      if (freshness.archived > 0) {
        log.info({ archived: freshness.archived }, 'Periodic freshness check archived items');
      }
    } catch (err) {
      log.error({ err }, 'Periodic freshness check failed');
    }
  });
}

/**
 * Server-side inbox execution: archives item, records execution, builds prompt.
 * Returns { sessionId, prompt, success }. The client navigates to the session
 * with the prompt as a query param so ConversationScreen auto-starts the turn.
 */
function executeInboxItem(item: InboxItem, sessionId: string, context?: string): { sessionId: string; prompt: string; success: boolean } {
  if (item.archived || item.executingSessionId) {
    throw new Error('Item already archived or executing');
  }

  const mode: InboxExecutionMode = context ? 'execute_with_context' : 'execute';

  // Use the provided sessionId (generated by handler for dual-write determinism)
  // Order matters: set executing first (updates entry file), then archive + record
  // (which moves the item to history and deletes the entry file).
  setInboxItemExecuting(item.id, sessionId);
  markInboxItemAsArchived(item.id);
  recordInboxExecutionEntry(item.id, sessionId, mode);

  // Build a simple prompt from the inbox item content
  const parts: string[] = [];
  if (item.title) parts.push(item.title);
  if (item.text) parts.push(item.text);
  if (item.references?.length) {
    const urls = item.references.flatMap((r) => {
      if (r.kind !== 'url') return [];
      return [r.label ? `[${r.label}](${r.url})` : r.url];
    });
    if (urls.length) parts.push(`\nReferences:\n${urls.join('\n')}`);
  }
  const basePrompt = parts.join('\n\n');
  const prompt = context
    ? `${basePrompt}\n\n**Additional instructions from user:**\n${context}`
    : basePrompt;

  return { sessionId, prompt, success: true };
}

/** @deprecated Use InboxHandlerDeps */
export type TasksHandlerDeps = InboxHandlerDeps;
/** @deprecated Use registerInboxHandlers */
export const registerTasksHandlers = registerInboxHandlers;

