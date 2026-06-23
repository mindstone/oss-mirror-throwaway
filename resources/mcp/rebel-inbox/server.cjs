#!/usr/bin/env node
/**
 * RebelInbox MCP Server
 *
 * Manage user's Actions: add/update/remove tasks, list/query items, bulk archive/delete, check status/stats.
 *
 * Tools (12):
 * - rebel_inbox_status
 * - rebel_inbox_ready
 * - rebel_inbox_add
 * - rebel_inbox_add_many
 * - rebel_inbox_update
 * - rebel_inbox_remove
 * - rebel_inbox_list
 * - rebel_inbox_query
 * - rebel_inbox_feedback
 * - rebel_inbox_stats
 * - rebel_inbox_bulk
 * - rebel_inbox_get
 */
// MUST be the first non-comment statement — see docs/plans/260428_graceful_fs_emfile_fix.md
// Uses globalThis.process so files that later `const process = require('node:process')` don't trigger TDZ.
if (globalThis.process.env.REBEL_DISABLE_GRACEFUL_FS !== '1') {
  try { require('graceful-fs').gracefulify(require('node:fs')); } catch (e) {
    globalThis.__REBEL_BOOTSTRAP_LEAF_ERROR__ = { kind: 'graceful_fs_leaf_install_failed', error: { name: e?.name, message: e?.message, stack: e?.stack }, at: Date.now() };
    if (globalThis.process.env.REBEL_DEBUG_BOOTSTRAP === '1') console.warn('[installGracefulFs] failed:', e);
  }
}
const fs = require('node:fs');
const os = require('node:os');
const process = require('node:process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const statePath = process.env.MINDSTONE_REBEL_BRIDGE_STATE;

const loadBridgeState = () => {
  if (!statePath) {
    return null;
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.port !== 'number' || !parsed.token) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const bridgeState = loadBridgeState();

if (!bridgeState) {
  console.error('[RebelInbox] Missing bridge configuration file.');
  process.exit(1);
}

const bridgePort = bridgeState.port;
const bridgeToken = bridgeState.token;
const bridgeBaseUrl = `http://127.0.0.1:${bridgePort}`;

// Create the server instance
const server = new McpServer({
  name: 'RebelInbox',
  version: '1.2.0',
  description: `Manage user's Actions: add/update/remove tasks, list/query items, bulk archive/delete, check status/stats.`
});

// Helper: Make bridge requests
const bridgeRequest = async (toolName, path, options = {}) => {
  const { method = 'POST', body } = options;
  const headers = {
    'Content-Type': 'application/json',
    ...(bridgeToken ? { Authorization: `Bearer ${bridgeToken}` } : {})
  };

  const response = await fetch(`${bridgeBaseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    let detail = 'Request failed.';
    try {
      const payload = await response.json();
      detail = payload?.error ?? detail;
    } catch {
      detail = await response.text();
    }
    throw new Error(`[${toolName}] ${detail || `Request failed (${response.status})`}`);
  }

  return response.json();
};

// =============================================================================
// Tool Names
// =============================================================================
const TOOL_NAMES = {
  status: 'rebel_inbox_status',
  ready: 'rebel_inbox_ready',
  add: 'rebel_inbox_add',
  addMany: 'rebel_inbox_add_many',
  update: 'rebel_inbox_update',
  remove: 'rebel_inbox_remove',
  list: 'rebel_inbox_list',
  query: 'rebel_inbox_query',
  feedback: 'rebel_inbox_feedback',
  stats: 'rebel_inbox_stats',
  bulk: 'rebel_inbox_bulk',
  get: 'rebel_inbox_get'
};

// =============================================================================
// Schemas
// =============================================================================
const referenceSchema = z.union([
  z.object({
    kind: z.literal('workspace'),
    path: z.string().min(1),
    label: z.string().min(1).optional()
  }),
  z.object({
    kind: z.literal('url'),
    url: z.string().url(),
    label: z.string().min(1).optional()
  }),
  z.object({
    kind: z.literal('email'),
    threadId: z.string().min(1),
    messageId: z.string().min(1).optional(),
    provider: z.enum(['gmail', 'outlook']).optional(),
    label: z.string().min(1).optional()
  }),
  z.object({
    kind: z.literal('linear'),
    issueId: z.string().min(1),
    label: z.string().min(1).optional()
  }),
  z.object({
    kind: z.literal('github'),
    owner: z.string().min(1),
    repo: z.string().min(1),
    issueNumber: z.number().int().positive(),
    label: z.string().min(1).optional()
  }),
  z.object({
    kind: z.literal('asana'),
    taskId: z.string().min(1),
    label: z.string().min(1).optional()
  })
]);

const referenceInputSchema = z.union([referenceSchema, z.string().min(1)]);
const referenceCollectionSchema = z
  .union([z.array(referenceInputSchema), referenceInputSchema])
  .optional();

const sourceSchema = z.union([
  z.object({ kind: z.literal('text'), label: z.string().min(1) }),
  z.object({ kind: z.literal('workspace'), path: z.string().min(1), label: z.string().min(1).optional() }),
  z.object({ kind: z.literal('automation'), automationId: z.string().min(1), automationName: z.string().min(1), label: z.string().min(1).optional() }),
  z.object({ kind: z.literal('meeting'), meetingId: z.string().min(1).optional(), meetingTitle: z.string().min(1).optional(), label: z.string().min(1).optional() }),
  z.object({ kind: z.literal('conversation'), sessionId: z.string().min(1), label: z.string().min(1).optional() })
]);
const sourceInputSchema = z.union([sourceSchema, z.string().min(1)]).optional();

const socialPlatformSchema = z.enum(['twitter', 'linkedin', 'facebook']);

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('execute') }),
  z.object({
    type: z.literal('shareToSocial'),
    text: z.string().min(1),
    url: z.string().min(1).optional(),
    platforms: z.array(socialPlatformSchema).optional()
  })
]);

const actionsInputSchema = z.union([z.array(actionSchema), actionSchema]).optional();

const categorySchema = z.enum(['user-request', 'automation', 'meeting-action', 'follow-up', 'system', 'uncategorized']).optional()
  .describe('Origin/intent category. Use: user-request (user explicitly asked), automation (scheduled automation output), meeting-action (from transcript processing), follow-up (conversation-derived), system (error/warning notifications).');

const tagsSchema = z.array(z.string().min(1)).max(20).optional()
  .describe('Topic tags for filtering (1-5 lowercase terms, e.g. "finance", "marketing", "hiring"). Helps users find items by topic. Tags mark items as user-curated for metadata-only staleness checks, but explicit completion evidence can still resolve the item. When context clearly suggests a topic, set 1-3 tags.');

// Coerce ISO date strings (e.g. "2026-04-08T12:00:00+03:00") to epoch ms numbers.
// LLMs frequently send date strings despite schema saying "Epoch ms". (REBEL-13Y)
// Digit-only strings are accepted ONLY in the unambiguous epoch-ms window
// [1e12, 1e14) (≈ Sep 2001 → year 5138): a bare Number() pass would silently
// accept Unix SECONDS strings as milliseconds (1000x wrong scale), and letting
// digit-only strings fall through to Date.parse is worse ("5" → year 2005).
const EPOCH_MS_MIN = 1e12;
const EPOCH_MS_MAX = 1e14;
const coerceEpochMs = (val) => {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (trimmed === '') return val;
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    return num >= EPOCH_MS_MIN && num < EPOCH_MS_MAX ? num : val;
  }
  const ms = new Date(trimmed).getTime();
  return Number.isNaN(ms) ? val : ms;
};
// Export a schema that advertises BOTH number and string to JSON Schema (so
// SuperMCP's AJV validator does not reject ISO date strings before our coercion
// runs), while still coercing ISO→epoch and REJECTING un-parseable strings at
// runtime via the refine. (REBEL-13Y)
const epochMsField = () =>
  z.preprocess(coerceEpochMs, z.union([z.number(), z.string()]))
   .refine((v) => typeof v === 'number', {
     message: 'Expected epoch milliseconds (number), a 13-digit epoch-ms string, or a parseable date string (e.g. "2026-04-08").',
   });

const addTaskSchema = z.object({
  title: z.string().min(1),
  text: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  source: sourceInputSchema,
  references: referenceCollectionSchema,
  actions: actionsInputSchema,
  priority: z.enum(['p1', 'p2', 'p3']).optional(),
  urgent: z.boolean().optional(),
  important: z.boolean().optional(),
  clarifyingQuestion: z.string().min(1).optional(),
  draft: z.string().min(1).optional(),
  relevantDate: epochMsField().optional().describe('Epoch ms (number or ISO date string accepted). The date when this item is most relevant/time-sensitive. For meeting follow-ups: the next business day after the meeting. For event-related items: the event date. For time-bound tasks: the date the task relates to. Items surface in Today when relevantDate is today. Items with expired relevantDate (3+ days past) are gradually archived. Do NOT use for delegation follow-up timing.'),
  dueBy: epochMsField().optional().describe('Epoch ms (number or ISO date string accepted) — target completion date. Set when evidence exists: for follow-up emails, 48h after meeting; for prep tasks, before the next related meeting; for items with explicit deadlines, use that date. If no deadline is stated or inferable, omit — a missing dueBy is better than a guessed one. Used for Today/This Week/Later grouping.'),
  category: categorySchema,
  tags: tagsSchema
});

const addManyItemSchema = z.object({
  title: z.string().min(1),
  text: z.string().min(1).optional(),
  source: sourceInputSchema,
  references: referenceCollectionSchema,
  actions: actionsInputSchema,
  urgent: z.boolean().optional(),
  important: z.boolean().optional(),
  clarifyingQuestion: z.string().min(1).optional(),
  draft: z.string().min(1).optional(),
  relevantDate: epochMsField().optional(),
  dueBy: epochMsField().optional(),
  category: categorySchema,
  tags: tagsSchema
});

const addManySchema = z.object({
  items: z.array(addManyItemSchema).min(1).max(50).describe('Array of action items to add (1-50 items)')
});

const updateTaskSchema = z.object({
  id: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  text: z.string().optional(),
  summary: z.string().optional(),
  source: sourceInputSchema.or(z.null()),
  references: referenceCollectionSchema.or(z.null()),
  urgent: z.boolean().optional(),
  important: z.boolean().optional(),
  archived: z.boolean().optional(),
  draft: z.string().optional().or(z.null()),
  clarifyingQuestion: z.string().optional().or(z.null()),
  relevantDate: epochMsField().optional().or(z.null()).describe('Epoch ms (number or ISO date string accepted) deadline after which item is stale. Set null to clear.'),
  dueBy: epochMsField().optional().or(z.null()).describe('Epoch ms (number or ISO date string accepted) by which item should be completed. Set null to clear.'),
  category: categorySchema,
  tags: tagsSchema,
  // Advisory archival annotations the agent volunteers when archiving an item
  // (archived=true). The morning-triage / source-capture skills ask the agent to
  // archive only with completion evidence, so models routinely attach a reason and
  // the supporting evidence to the update call. These are accepted to stop the
  // strict-arg-validation rejection (REBEL-61R: 195 users sent these and the call
  // failed with -33003 "Unknown fields"), following the same accommodate-the-field
  // precedent as category/tags (REBEL-13Y, 97a70c694). They are advisory only and
  // are intentionally NOT forwarded to /inbox/update — the archive action itself is
  // the persisted effect — so no store schema/version change is required.
  archiveReason: z.string().min(1).optional()
    .describe('Optional short reason for archiving this item, e.g. "completed", "no longer relevant", "duplicate". Advisory only — supply it when you set archived=true so the decision is self-documenting.'),
  evidenceNote: z.string().min(1).optional()
    .describe('Optional evidence supporting an archive/update decision, e.g. "reply sent to the requester", "meeting completed 2 days ago". Advisory only.')
});

const removeTaskSchema = z.object({
  id: z.string().min(1).optional(),
  taskId: z.string().min(1).optional()
});

const LIST_DEFAULT_LIMIT = 50;
const LIST_SUMMARY_MAX_CHARS = 500;

const listTaskSchema = z.object({
  limit: z.number().int().positive().max(500).optional().describe(`Max items to return (default: ${LIST_DEFAULT_LIMIT}, max: 500). Pass an explicit value to fetch more in a single call.`),
  includeArchived: z.boolean().optional().describe('Also show archived items (default: false)'),
  quadrant: z.enum(['do_now', 'schedule', 'delegate', 'consider']).optional().describe('Filter by Eisenhower quadrant')
});

const querySchema = z.object({
  includeArchived: z.boolean().optional().describe('Include archived items (default: false)'),
  archivedOnly: z.boolean().optional().describe('Only show archived items'),
  includeHistory: z.boolean().optional().describe('Include execution history'),
  quadrant: z.enum(['do_now', 'schedule', 'delegate', 'consider']).optional().describe('Filter by quadrant'),
  urgent: z.boolean().optional().describe('Filter by urgent flag'),
  important: z.boolean().optional().describe('Filter by important flag'),
  addedAfter: z.union([z.number(), z.string()]).optional().describe('Items added after (epoch ms or ISO date)'),
  addedBefore: z.union([z.number(), z.string()]).optional().describe('Items added before (epoch ms or ISO date)'),
  search: z.string().optional().describe('Search in title and text'),
  limit: z.number().int().positive().max(500).optional().describe('Max items to return (max 500)'),
  offset: z.number().int().min(0).optional().describe('Pagination offset'),
  sortBy: z.enum(['addedAt', 'title', 'quadrant']).optional().describe('Sort field'),
  sortOrder: z.enum(['asc', 'desc']).optional().describe('Sort order')
});

const feedbackSchema = z.object({
  limit: z.number().int().positive().max(20).optional().describe('Maximum feedback examples to return (default 5, max 20).'),
  maxAgeDays: z.number().int().positive().max(365).optional().describe('Only return examples dismissed within this many days (default 90).'),
  sourceKind: z.enum(['text', 'workspace', 'automation', 'role', 'meeting', 'conversation']).optional().describe('Scope feedback examples to one source kind.'),
  automationId: z.string().min(1).optional().describe('Scope to one automation id, e.g. system-source-capture.'),
  automationName: z.string().min(1).optional().describe('Scope to one automation name, e.g. source-capture.'),
  category: z.enum(['user-request', 'automation', 'meeting-action', 'follow-up', 'system', 'uncategorized']).optional().describe('Scope to one action category.')
});

const getSchema = z.object({
  id: z.string().min(1).describe('The action item ID (UUID)')
});

const bulkSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('archive'),
    ids: z.array(z.string().min(1)).min(1).describe('Item IDs to archive')
  }),
  z.object({
    action: z.literal('unarchive'),
    ids: z.array(z.string().min(1)).min(1).describe('Item IDs to unarchive')
  }),
  z.object({
    action: z.literal('delete'),
    ids: z.array(z.string().min(1)).min(1).describe('Item IDs to delete')
  }),
  z.object({
    action: z.literal('move_quadrant'),
    ids: z.array(z.string().min(1)).min(1).describe('Item IDs to move'),
    urgent: z.boolean().describe('Target urgent flag'),
    important: z.boolean().describe('Target important flag')
  }),
  z.object({
    action: z.literal('archive_quadrant'),
    quadrant: z.enum(['do_now', 'schedule', 'delegate', 'consider']).describe('Quadrant to archive')
  }),
  z.object({
    action: z.literal('delete_quadrant'),
    quadrant: z.enum(['do_now', 'schedule', 'delegate', 'consider']).describe('Quadrant to delete')
  }),
  z.object({ action: z.literal('archive_all') }),
  z.object({ action: z.literal('delete_archived') })
]);

// =============================================================================
// Helper Functions
// =============================================================================
const normalizeSource = (input) => {
  if (!input || typeof input === 'undefined' || input === null) {
    return undefined;
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      return undefined;
    }
    return { kind: 'text', label: trimmed };
  }
  return input;
};

const normalizeReference = (input) => {
  if (!input) {
    return null;
  }
  if (typeof input !== 'string') {
    return input;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const isUrl = /^https?:\/\//i.test(trimmed);
  if (isUrl) {
    return { kind: 'url', url: trimmed };
  }
  return { kind: 'workspace', path: trimmed };
};

const normalizeReferences = (input) => {
  if (!input) {
    return [];
  }
  const values = Array.isArray(input) ? input : [input];
  return values
    .map((value) => normalizeReference(value))
    .filter((value) => Boolean(value));
};

const normalizeText = (input, fallback) => {
  const trimmed = input?.trim();
  if (trimmed && trimmed.length > 0) {
    return trimmed;
  }
  return fallback;
};

const normalizeAction = (action) => {
  if (!action || typeof action !== 'object') {
    return null;
  }
  if (action.type === 'execute') {
    return { type: 'execute' };
  }
  if (action.type === 'shareToSocial' && typeof action.text === 'string' && action.text.trim()) {
    return {
      type: 'shareToSocial',
      text: action.text.trim(),
      url: typeof action.url === 'string' && action.url.trim() ? action.url.trim() : undefined,
      platforms: Array.isArray(action.platforms) && action.platforms.length > 0 ? action.platforms : undefined
    };
  }
  return null;
};

const normalizeActions = (input) => {
  if (!input) {
    return undefined;
  }
  const values = Array.isArray(input) ? input : [input];
  const normalized = values.map(normalizeAction).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
};

const pickTaskId = (input) => input?.id ?? input?.taskId ?? null;

const getQuadrantLabel = (item) => {
  const urgent = item.urgent ?? false;
  const important = item.important ?? true;
  if (urgent && important) return 'DO NOW';
  if (!urgent && important) return 'SCHEDULE';
  if (urgent && !important) return 'DELEGATE';
  return 'CONSIDER';
};

const appendLabel = (value, label) => `${value}${label ? ` (${label})` : ''}`;

const formatReference = (ref) => {
  if (!ref || typeof ref !== 'object') return '';
  switch (ref.kind) {
    case 'workspace':
      return appendLabel(ref.path, ref.label);
    case 'url':
      return appendLabel(ref.url, ref.label);
    case 'email':
      return appendLabel(`[email thread=${ref.threadId}${ref.messageId ? ` msg=${ref.messageId}` : ''}${ref.provider ? ` provider=${ref.provider}` : ''}]`, ref.label);
    case 'linear':
      return appendLabel(`[linear issue=${ref.issueId}]`, ref.label);
    case 'github':
      return appendLabel(`[github ${ref.owner}/${ref.repo}#${ref.issueNumber}]`, ref.label);
    case 'asana':
      return appendLabel(`[asana task=${ref.taskId}]`, ref.label);
    default:
      return appendLabel(`[${ref.kind ?? 'reference'}]`, ref.label);
  }
};

/**
 * Format inbox items as a numbered list with metadata.
 *
 * @param {Array} items - Items to format
 * @param {Object} options
 * @param {boolean} options.showArchived - Include [ARCHIVED] tags
 * @param {number}  options.startIndex - Starting number for the list (0-based offset)
 * @returns {string} Formatted text
 */
const formatItemList = (items, options = {}) => {
  const { showArchived = false, startIndex = 0 } = options;
  if (items.length === 0) {
    return showArchived ? 'No archived items found.' : 'No items found.';
  }
  return items
    .map((item, index) => {
      const quadrant = getQuadrantLabel(item);
      const hasDraft = item.draft ? ' [draft]' : '';
      const archivedTag = item.archived ? ' [ARCHIVED]' : '';
      const executing = item.executingSessionId ? ' [EXECUTING]' : '';
      const rawText = typeof item.text === 'string' ? item.text : '';
      const summary = rawText.length > LIST_SUMMARY_MAX_CHARS
        ? `${rawText.slice(0, LIST_SUMMARY_MAX_CHARS)}…[truncated, use rebel_inbox_get for full text]`
        : rawText;
      const references = Array.isArray(item.references) && item.references.length > 0
        ? `\n    references: ${item.references
            .map(formatReference)
            .filter(Boolean)
            .join(', ')}`
        : '';
      return `${startIndex + index + 1}. [${item.id}] ${item.title}${archivedTag}${hasDraft}${executing}\n    quadrant: ${quadrant}\n    summary: ${summary}${references}`;
    })
    .join('\n');
};

const summarizeHistory = (history, limit) => {
  const list = history.slice(0, typeof limit === 'number' ? limit : 10);
  if (list.length === 0) {
    return 'No execution history.';
  }
  return list
    .map((entry, index) => {
      const executedDate = new Date(entry.executedAt).toISOString().split('T')[0];
      return `${index + 1}. [${entry.id}] ${entry.title}\n    executed: ${executedDate} (${entry.mode})\n    session: ${entry.sessionId}`;
    })
    .join('\n');
};

const formatStats = (stats) => {
  const lines = [
    `═══════════════════════════════════════`,
    `ACTIONS OVERVIEW`,
    `═══════════════════════════════════════`,
    `Total items: ${stats.total} (${stats.active} active, ${stats.archived} archived)`,
    `Execution history: ${stats.history} entries`,
    ``,
    `ACTIVE ITEMS BY QUADRANT:`,
    `┌─────────────────────┬─────────────────────┐`,
    `│ DO NOW: ${String(stats.byQuadrant.do_now).padStart(3)}        │ SCHEDULE: ${String(stats.byQuadrant.schedule).padStart(3)}     │`,
    `├─────────────────────┼─────────────────────┤`,
    `│ DELEGATE: ${String(stats.byQuadrant.delegate).padStart(3)}     │ CONSIDER: ${String(stats.byQuadrant.consider).padStart(3)}     │`,
    `└─────────────────────┴─────────────────────┘`,
  ];
  
  if (stats.archived > 0) {
    lines.push(``);
    lines.push(`ARCHIVED BY QUADRANT:`);
    lines.push(`  Do Now: ${stats.byQuadrantArchived.do_now}, Schedule: ${stats.byQuadrantArchived.schedule}, Delegate: ${stats.byQuadrantArchived.delegate}, Consider: ${stats.byQuadrantArchived.consider}`);
  }
  
  if (stats.oldestActiveAt) {
    const oldestDate = new Date(stats.oldestActiveAt).toISOString().split('T')[0];
    const newestDate = new Date(stats.newestActiveAt).toISOString().split('T')[0];
    lines.push(``);
    lines.push(`Date range: ${oldestDate} to ${newestDate}`);
  }
  
  return lines.join('\n');
};

const formatFeedbackExamples = (examples) => {
  if (!Array.isArray(examples) || examples.length === 0) {
    return [
      'No dismissed feedback examples found for this scope.',
      '',
      'Continue using the normal Actions quality rules. Do not invent feedback patterns.'
    ].join('\n');
  }

  const lines = [
    'DISMISSED ACTION FEEDBACK EXAMPLES',
    '',
    'Use these as weak examples of past misses for this user and source. Do NOT infer keyword blacklists.',
    'Do NOT reject a new item just because it shares a person, client, topic, or word with an example.',
    'Prefer skipping only when the new candidate has the same kind of source, action shape, and user-value problem.',
    ''
  ];

  for (const [index, example] of examples.entries()) {
    const reason = example.dismissedReasonCategory || 'dismissed';
    const source = example.sourceLabel
      ? `${example.sourceLabel}${example.sourceKind ? ` (${example.sourceKind})` : ''}`
      : example.sourceKind || 'unknown source';
    const date = example.dismissedAt ? new Date(example.dismissedAt).toISOString().split('T')[0] : 'unknown date';
    lines.push(`${index + 1}. ${example.title}`);
    lines.push(`   reason: ${reason}`);
    if (example.dismissedReason) lines.push(`   note: ${example.dismissedReason}`);
    lines.push(`   source: ${source}`);
    if (example.category) lines.push(`   category: ${example.category}`);
    lines.push(`   dismissed: ${date}`);
    if (example.text && example.text !== example.title) lines.push(`   context: ${example.text}`);
  }

  return lines.join('\n');
};

/**
 * Build the normalized payload for a single inbox item from tool input.
 */
const buildAddPayload = (input) => {
  const title = input.title.trim();
  const text = normalizeText(input.text ?? input.summary, undefined);
  return {
    title,
    text,
    source: normalizeSource(input.source),
    references: normalizeReferences(input.references),
    actions: normalizeActions(input.actions),
    priority: input.priority ?? 'p2',
    urgent: input.urgent ?? false,
    important: input.important ?? true,
    clarifyingQuestion: input.clarifyingQuestion?.trim() || undefined,
    draft: input.draft?.trim() || undefined,
    relevantDate: typeof input.relevantDate === 'number' ? input.relevantDate : undefined,
    dueBy: typeof input.dueBy === 'number' ? input.dueBy : undefined,
    category: input.category || undefined,
    tags: Array.isArray(input.tags) ? input.tags : undefined
  };
};

// =============================================================================
// Tool Registrations
// =============================================================================

// Status tool (local, no bridge call)
const statusSchema = z.object({
  includeUptime: z.boolean().optional(),
  includeLoad: z.boolean().optional()
});

server.registerTool(TOOL_NAMES.status, {
  title: 'Rebel Actions system status',
  description: `Returns local system diagnostics (OS, architecture, uptime, load).

WHEN TO USE: Only for debugging - if Actions operations are failing or behaving unexpectedly.

DO NOT USE for normal Actions operations like adding, listing, or removing items.`,
  inputSchema: statusSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const includeUptime = input.includeUptime ?? true;
  const includeLoad = input.includeLoad ?? true;
  const lines = [
    `platform: ${os.platform()}`,
    `release: ${os.release()}`,
    `arch: ${os.arch()}`,
    `nodeVersion: ${process.version}`,
    `timestamp: ${new Date().toISOString()}`
  ];

  if (includeUptime) {
    lines.push(`uptimeSeconds: ${Math.round(os.uptime())}`);
  }

  if (includeLoad && os.loadavg) {
    const [one, five, fifteen] = os.loadavg();
    lines.push(`loadavg: ${one.toFixed(2)},${five.toFixed(2)},${fifteen.toFixed(2)}`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
});

// Ready/health check tool
server.registerTool(TOOL_NAMES.ready, {
  title: 'Rebel Actions health',
  description: `Quick health check to verify the Actions MCP is responsive.

WHEN TO USE: Only if you suspect the Actions service is down or unresponsive.

DO NOT USE before normal operations - just call the operation directly.`,
  annotations: { readOnlyHint: true }
}, async () => ({
  content: [{ type: 'text', text: 'Rebel Actions is ready.' }]
}));

// Add to inbox
server.registerTool(TOOL_NAMES.add, {
  title: 'Add to Rebel Actions',
  description: `Add a single action item to the user's Actions. For multiple items, use rebel_inbox_add_many instead.

Think of yourself as a Chief of Staff briefing a CEO. Your job is NOT to hand
them a to-do list — it's to hand them decision-ready materials they can approve
in under 2 minutes. The best action item is one the user reviews and sends, not
one they have to start from scratch.

═══════════════════════════════════════════════════════════════
COMMUNICATION STYLE — BRIEF LIKE A CHIEF OF STAFF
═══════════════════════════════════════════════════════════════
Write like you're briefing an executive who has 30 seconds to scan this:

• Title: Action-oriented, 5-12 words. Lead with verb or key noun.
  Include the person's name when delegating or following up.
  GOOD: "Send Arnon updated deck + cohort retention KPIs"
  GOOD: "Follow up with Trish Skoglund re: Fairwater pilot"
  BAD:  "I noticed you mentioned wanting to review the Q3 proposal"

• Text: Essential context only. What, why, when — no fluff.
  GOOD: "James asked for updated projections by EOD Friday. Deck is ready, needs your sign-off."
  BAD:  "During the meeting with James, we discussed several topics including the Series A..."

• Clarifying questions: One short question, not a paragraph.
  GOOD: "Formal or casual tone?"
  BAD:  "What tone would you like me to use for this email?"

═══════════════════════════════════════════════════════════════
ITEM INTENT — WHAT DOES THE USER NEED TO DO?
═══════════════════════════════════════════════════════════════
Before creating an item, determine the user's required action. This drives
which fields you set and how the item appears in Actions:

1. REVIEW & SEND (best case — lowest friction, highest completion rate)
   You have a complete deliverable. User reviews, edits 10%, hits send.
   → Set: draft (the full deliverable) + actions: [{ type: "execute" }]
   → Example: Email draft, Slack message, HubSpot record fields, briefing text

2. DECIDE (user must choose between options)
   You cannot proceed without the user's judgment on something specific.
   → Set: clarifyingQuestion (the specific decision) + actions: [{ type: "execute" }]
   → Example: "Volume discount or per-seat pricing for Intragen?", "Formal or friendly tone?"

3. DO (user must take an action you cannot take for them)
   The action requires the user personally — a call, a meeting, a judgment call.
   → Set: actions: [{ type: "execute" }] + detailed text explaining what to do
   → Example: "Call Sarah to discuss Q3 budget", "Review and sign DocuSign"

4. KNOW (pure information — USUALLY DOES NOT BELONG IN ACTIONS)
   Status updates, monitoring notes, FYI items with no action.
   → STOP: Route to Coach/memory instead. Only add to Actions if the user
     explicitly asked for it (e.g., "add this to my actions").
   → If you must add: no actions, no clarifyingQuestion. But strongly prefer
     routing to Coach — Actions is for things that need the user's hands.

RULE: If an item has no actions AND no clarifyingQuestion, ask yourself:
"Is there something the user needs to DO here?" If the answer is no,
route it to Coach/memory, not Actions — unless the user explicitly
requested it (e.g., "add this to my actions").

═══════════════════════════════════════════════════════════════
DRAFTS — ALWAYS DRAFT THE DELIVERABLE (THIS IS THE #1 RULE)
═══════════════════════════════════════════════════════════════
A draft transforms a 30-minute task into a 2-minute review. ALWAYS attempt
a draft when the deliverable is predictable. The user sees a preview and
can approve with one click or request edits.

WHEN TO DRAFT (always, unless the deliverable is genuinely unpredictable):
  "Send email to X"          → draft = the full email body
  "Follow up with X"         → draft = the follow-up message
  "Slack X about Y"          → draft = the Slack message
  "Brief X on Y"             → draft = the briefing text
  "Create HubSpot record"    → draft = the record fields formatted
  "Post shoutout for X"      → draft = the shoutout message
  "Reply to X"               → draft = the reply
  "Draft proposal for X"     → draft = the proposal

WHEN NOT TO DRAFT (the deliverable requires user judgment to even start):
  "Decide between A and B"   → use clarifyingQuestion instead
  "Call Sarah"                → no deliverable to draft
  "Review contract"           → the contract IS the deliverable

DRAFT FORMAT: Write the actual artifact, not a description of it.
  BAD draft:  "An email to James about Q3 projections"
  GOOD draft: "Hi James,\n\nAttached are the updated Q3 projections you requested..."

ACCURACY: Do not invent facts, recipient details, figures, or commitments in drafts.
  If key details are missing, use [placeholders] or set a clarifyingQuestion instead.
  A draft with "[amount TBD]" is better than one with a fabricated number.

AUTOMATION FLOWS: For automated/batch item creation (meeting transcripts, source
  capture), draft when the deliverable is clear from context. Skip drafting if you
  lack sufficient context — a low-quality filler draft creates more work than it saves.

═══════════════════════════════════════════════════════════════
DELEGATION ITEMS — TRACK THE OPEN LOOP
═══════════════════════════════════════════════════════════════
Nearly half of action items involve delegating to someone else. When creating
items that delegate work (send, brief, delegate, follow up, contact, DM),
structure them for tracking:

• ALWAYS include the person's name in the title
  GOOD: "Brief Alex on FICO multi-agent opportunity"
  BAD:  "Brief sales team on new opportunity"

• ALWAYS draft the deliverable (the message/email/brief you will send them)
  This is the most common missed draft — delegation items almost always have
  a predictable deliverable.

• Do NOT use relevantDate for delegation follow-up timing. relevantDate means
  "this item is stale after this date" and triggers auto-archival — the opposite
  of what you want for tracking open loops. Leave relevantDate unset for
  delegation items unless they are genuinely time-bound (e.g., event-related).

• If the delegation has already happened and you're tracking the response,
  set clarifyingQuestion to "Did [person] respond?" or "Was this completed?"

═══════════════════════════════════════════════════════════════
WHEN TO USE THIS TOOL
═══════════════════════════════════════════════════════════════
• User says: "add to actions", "remind me later", "save this for later"
• You've created a deliverable the user might want to send or share (posts, emails, prepared materials)
• You've identified a task that requires user input or action
• Following up on something from a meeting, email, or document
• Adding 1 item. For 2+ items, use rebel_inbox_add_many.

═══════════════════════════════════════════════════════════════
PROHIBITED ITEM TYPES — DO NOT ADD THESE TO ACTIONS
═══════════════════════════════════════════════════════════════
Actions is for concrete tasks only. Route everything else to Coach/memory.

• System receipts and automation logs:
  "Actions enriched Wed 4 Mar — 26 items updated"
  "Daily cleanup receipt — Wednesday 4 March 2026"
  "Source capture complete — 15 sources processed"
  "Memory hygiene — 4 discrepancies found"
  "Stand-up draft saved locally"

• Status updates and monitoring notes (no action for the user):
  "HBSE — Whitney reviewing, Alex engaged" (awareness, not a task)
  "Monitor: Greg's brainstorm in progress" (FYI, not a task)

• Insights, learnings, wins, and recaps:
  "Insight: Chief of Staff page — high visits but zero interaction"
  "Win: 3+ connectors correlates with strong user retention"

• Confirmations that something is already done or resolved:
  "Deployment successful — all services green"
  "Bug fixed: login redirect now works"
  "Liam's hiring criteria reviewed — looks good"
  "Josh confirmed Operators beta exposure is feature-flagged"

If the user cannot DO something with this item right now, it does not
belong in Actions. Log it, write to memory, or route to Coach.

═══════════════════════════════════════════════════════════════
EISENHOWER MATRIX — CHOOSING urgent AND important
═══════════════════════════════════════════════════════════════
┌─────────────────────────────────────┬─────────────────────────────────────┐
│ DO NOW (urgent=true, important=true)│ SCHEDULE (urgent=false, important=true)│
│ Crises, deadlines, urgent requests  │ Strategic work, planning, goals      │
├─────────────────────────────────────┼─────────────────────────────────────┤
│ DELEGATE (urgent=true, important=false)│ CONSIDER (urgent=false, important=false)│
│ Interruptions, some emails, requests│ Nice-to-have, FYI, low priority      │
└─────────────────────────────────────┴─────────────────────────────────────┘
DEFAULT: urgent=false, important=true → "Schedule" (most tasks go here)

═══════════════════════════════════════════════════════════════
CATEGORY — ORIGIN/INTENT TRACKING
═══════════════════════════════════════════════════════════════
ALWAYS set category. This is required for analytics and filtering:
• user-request: User explicitly asked ("add to actions", "remind me")
• automation: Running as part of a scheduled automation (daily briefing, source capture)
• meeting-action: Processing a meeting transcript
• follow-up: Derived from a conversation (not explicitly requested by user)
• system: System notifications (errors, warnings, service alerts)
If genuinely unsure, omit — defaults to "uncategorized". But try to categorize.

═══════════════════════════════════════════════════════════════
SOURCE/PROVENANCE — WHERE DID THIS COME FROM?
═══════════════════════════════════════════════════════════════
Set "source" to track where this item originated:
• Scheduled automation: { kind: "automation", automationId: "<id>", automationName: "<name>" }
• Meeting transcript processing: { kind: "meeting", meetingTitle: "<title>" }
• Conversation follow-up: { kind: "conversation", sessionId: "<session-id>" }
• General text label: { kind: "text", label: "Morning Briefing" }
• Workspace file: { kind: "workspace", path: "/path/to/file" }
If you are an automation, ALWAYS set kind:"automation" with your automationId.
If processing a meeting, ALWAYS set kind:"meeting" with the meeting title.

═══════════════════════════════════════════════════════════════
REFERENCES — LINK ITEMS TO THE EVIDENCE
═══════════════════════════════════════════════════════════════
When creating email-action items (reply to, follow up on email, respond to), ALWAYS include
an email reference with the threadId and provider so Rebel can track reply status:
  references: [{ kind: "email", threadId: "<thread-id>", messageId: "<message-id>", provider: "gmail" or "outlook", label: "Thread: <subject>" }]
The threadId and messageId come from the email provider's message data.
The provider field ("gmail" or "outlook") tells Rebel which tools to use for reply detection.
This enables automatic archival when the email is replied to.

When creating review/check items from documents, Notion pages, Slack/Teams threads, or
ticketing systems, include the narrowest available reference:
• Document, Notion, Slack, Teams, or web page URL:
  references: [{ kind: "url", url: "<exact-url>", label: "Notion: Hiring criteria" }]
• Local or workspace file:
  references: [{ kind: "workspace", path: "<exact-path>", label: "Source capture" }]
• Linear/GitHub/Asana:
  references: [{ kind: "linear", issueId: "<id>", label: "FOX-1234" }]

References are not decoration. They keep future freshness checks cheap and accurate by
letting Rebel inspect the exact thread/page/task before doing any broader search.
If no precise reference is available, include the person, tool, and topic in text so
freshness checks can use one targeted search rather than scanning broadly.
Use the user's actual system of record: Outlook or Gmail for email, Teams or Slack
for messaging, Notion/Drive/SharePoint for documents, Linear/GitHub/Asana/Jira for
tickets, or whichever connected tool the source came from. Do not assume a fixed
connector stack.

═══════════════════════════════════════════════════════════════
TONE GUIDELINES
═══════════════════════════════════════════════════════════════
Professional and neutral — write like a calendar entry or project tracker.
• Never use informal verbs: "chase", "nag", "bug", "ping"
• Use "Follow up with" instead of "Chase", "Contact" instead of "Ping"
• No editorial commentary — state the action, not your opinion
• No exclamation marks in titles
  GOOD: "Follow up with Athena re: sales tax refund"
  BAD:  "Chase Athena on sales tax refund"
  GOOD: "Review Q3 proposal — deadline Friday"
  BAD:  "You really should look at that Q3 proposal!"

═══════════════════════════════════════════════════════════════
OWNER-RELEVANCE
═══════════════════════════════════════════════════════════════
Only add items for actions OWNED BY or RELEVANT TO the current user.
Do not add other people's tasks. If the user was an observer (not the
assignee or decision-maker), do NOT add the item.
Ask: "Would this person need to act on this if they missed the meeting?"
If no, skip it.

If "Harry needs to fix connectors", that is Harry's task — do NOT add
it unless the user IS Harry or has a specific follow-up action.
If "Greg will check pricing" or "Harry is working on the release", do NOT add it
unless the user has an explicit follow-up deadline. Other people's ownership is
context, not a task for this user's active Actions.

SKIP EXAMPLES — do NOT add these:
• "Customer support team to handle billing dispute" (support's task)
• "ROI analysis shows strong prognosis" (insight, not action)
• "Engineering team will fix the connector issue" (engineering's task)
• "Sales team follow-up with prospect" (sales team's task)
• "[Person name] to send the deck by Friday" (that person's task)
• "Greg to check Cursor pricing vs Droid/Factory" (Greg's task unless the user must chase it)
• "Harry is working on OSS MCP release" (Harry's task; record context elsewhere)

═══════════════════════════════════════════════════════════════
CONTEXT SUFFICIENCY
═══════════════════════════════════════════════════════════════
Each item must have enough context to be actionable without re-reading
the source material. Include: what, who, when, and where it came from.
BAD:  "Define experiment framework: goals, analytics, deadline"
GOOD: "Define Rebel feature experiment framework — goals, analytics
       criteria, and deadline (discussed in Eng AI seminar Feb 25)"
If you can't make it specific enough, skip it — vague items waste
the user's time and get ignored.

═══════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════
title (required): 5-12 words, action-oriented. Include person name for delegation items.
text (optional): 1-3 sentences of context. Becomes the prompt when user clicks "Go".
source (optional): Where this came from — see SOURCE/PROVENANCE section above.
references (optional): Related files, URLs, or email threads.
actions (optional): Array of action objects. Set [{ type: "execute" }] for items where
  the user should act (Review & Send, Decide, Do intents). Also supports
  { type: "shareToSocial", text: "...", platforms: ["twitter"] } for social posts.
  Items without actions are treated as informational — see PROHIBITED ITEM TYPES.
urgent (optional, default false): Needs attention TODAY?
important (optional, default true): Matters for their goals?
clarifyingQuestion (optional): ONE short question when user must DECIDE something.
draft (optional): ALWAYS include when the deliverable is predictable. Full text of the
  email/message/document/record ready for user approval. This is the highest-impact field.
  Do not invent facts — use [placeholders] when details are missing.
relevantDate (optional): Epoch ms. The date when this item is most relevant/time-sensitive.
  For meeting follow-ups: the next business day after the meeting. For event-related items:
  the event date. For time-bound tasks: the date the task relates to. Items surface in Today
  when relevantDate is today. Items with expired relevantDate (3+ days past) are gradually
  archived. Do NOT use for delegation follow-up timing (it would auto-archive the item too early).
category (optional): Origin/intent — see CATEGORY section above. ALWAYS set when possible.
dueBy (optional): Epoch ms or ISO date string (e.g. 1712345678000 or "2026-04-08") — target
  completion date. Set when evidence exists: for follow-up emails, 48h after meeting; for prep
  tasks, before the next related meeting; for items with explicit deadlines, use that date. If
  no deadline is stated or inferable, omit — a missing dueBy is better than a guessed one.
  Used for Today/This Week/Later grouping.
tags (optional): 1-5 lowercase topic tags for filtering (e.g. ["finance", "hiring", "product"]).
  Infer from context. Use single words or hyphenated terms. Helps users filter by topic.
  Tags mark items as user-curated for metadata-only staleness checks, but explicit
  completion evidence can still resolve the item. When context clearly suggests a topic,
  set 1-3 tags.`,
  inputSchema: addTaskSchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const normalized = buildAddPayload(input);
  const result = await bridgeRequest(TOOL_NAMES.add, '/inbox/add', { body: normalized });
  if (result.redirected) {
    return {
      content: [{ type: 'text', text: `Redirected to Coach: "${input.title}" — ${result.rejectedReason ?? 'non-actionable content'}. This content has value but belongs in the Coach section, not the actions queue.` }]
    };
  }
  if (result.accepted === false) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Rejected: "${input.title}" — ${result.rejectedReason ?? 'did not pass quality filter'}. Item was NOT added to actions. Adjust and retry if the issue is fixable, or skip this item.` }]
    };
  }
  return {
    content: [{ type: 'text', text: `Added "${input.title}" to actions.` }]
  };
});

// Add many items at once
server.registerTool(TOOL_NAMES.addMany, {
  title: 'Add multiple items to Rebel Actions',
  description: `Add multiple items to Actions in a single call. Much more efficient than calling rebel_inbox_add repeatedly.

WHEN TO USE:
• After analyzing a meeting transcript (action items, follow-ups, decisions)
• When processing an email thread with multiple tasks
• Any time you need to create 2+ action items

LIMITS: 1-50 items per call.

Each item follows the same rules as rebel_inbox_add. Key reminders for batch adds:
• ALWAYS attempt a draft for each item where the deliverable is predictable.
  Batch operations must NOT skip drafts just because there are multiple items.
• Determine each item's intent: Review & Send, Decide, Do, or Know.
  Items that are pure "Know" (no action, no question) should be routed to
  Coach/memory, not added to Actions.
• Set category on every item. ALWAYS include source provenance.
• For delegation items, include the person's name in the title.

RETURNS: Count of successfully added items plus any failures.`,
  inputSchema: addManySchema,
  annotations: { readOnlyHint: false, destructiveHint: false }
}, async (input) => {
  const results = { added: 0, rejected: 0, redirected: 0, failed: 0, addedTitles: [], rejectedTitles: [], redirectedTitles: [] };
  for (const item of input.items) {
    try {
      const normalized = buildAddPayload(item);
      const result = await bridgeRequest(TOOL_NAMES.add, '/inbox/add', { body: normalized });
      if (result.redirected) {
        results.redirected++;
        results.redirectedTitles.push(`${item.title} (→ Coach: ${result.rejectedReason ?? 'non-actionable'})`);
      } else if (result.accepted === false) {
        results.rejected++;
        results.rejectedTitles.push(`${item.title} (${result.rejectedReason ?? 'filtered'})`);
      } else {
        results.added++;
        results.addedTitles.push(item.title);
      }
    } catch (err) {
      results.failed++;
      results.rejectedTitles.push(`${item.title} (bridge error: ${err?.message ?? 'unknown'})`);
    }
  }
  const lines = [`Added ${results.added} of ${input.items.length} items to actions.`];
  if (results.rejected > 0) {
    lines.push(`${results.rejected} item(s) rejected by quality filter.`);
  }
  if (results.redirected > 0) {
    lines.push(`${results.redirected} item(s) redirected to Coach section.`);
  }
  if (results.failed > 0) {
    lines.push(`${results.failed} item(s) failed to add.`);
  }
  if (results.addedTitles.length > 0) {
    lines.push('Added:');
    for (const title of results.addedTitles) lines.push(`  + ${title}`);
  }
  if (results.rejectedTitles.length > 0) {
    lines.push('Rejected:');
    for (const title of results.rejectedTitles) lines.push(`  - ${title}`);
  }
  if (results.redirectedTitles.length > 0) {
    lines.push('Redirected to Coach:');
    for (const title of results.redirectedTitles) lines.push(`  → ${title}`);
  }
  return {
    ...(results.added === 0 && results.redirected === 0 ? { isError: true } : {}),
    content: [{ type: 'text', text: lines.join('\n') }]
  };
});

// Update inbox item
server.registerTool(TOOL_NAMES.update, {
  title: 'Edit action item',
  description: `Modify an existing action item. Can change content, priority quadrant, or archive status.

WHEN TO USE:
• User asks to "edit", "change", or "update" an action item
• User wants to re-prioritize (move to different quadrant)
• User says "archive this" or "mark as done" (without executing)
• Fixing a typo or clarifying task description

REQUIRED: You need the item ID. Get it from rebel_inbox_list or rebel_inbox_query.

PARAMETERS:
• id (required): The UUID from rebel_inbox_list (e.g., "1d004112-6b03-4a5d-...")
• title, text, source, references: New content (omit to keep current)
• urgent, important: Set to change quadrant
• archived: true = archive, false = unarchive
• draft, clarifyingQuestion: Update or null to clear
• relevantDate, dueBy: Update or null to clear
• category: Origin/intent (user-request, automation, meeting-action, follow-up, system)
• tags: Topic tags for filtering

QUADRANT CHANGES:
• urgent=true,  important=true  → DO NOW
• urgent=false, important=true  → SCHEDULE
• urgent=true,  important=false → DELEGATE
• urgent=false, important=false → CONSIDER`,
  inputSchema: updateTaskSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
}, async (input) => {
  const itemId = pickTaskId(input);
  if (!itemId) {
    throw new Error('Item id is required. Use rebel_inbox_list to find item IDs.');
  }
  const body = {
    id: itemId,
    title: input.title ? input.title.trim() : undefined,
    text: normalizeText(input.text ?? input.summary, undefined),
    source: input.source === null ? null : normalizeSource(input.source),
    references: input.references === null ? null : normalizeReferences(input.references),
    urgent: input.urgent,
    important: input.important,
    archived: input.archived,
    draft: input.draft === null ? null : input.draft?.trim() || undefined,
    clarifyingQuestion: input.clarifyingQuestion === null ? null : input.clarifyingQuestion?.trim() || undefined,
    relevantDate: input.relevantDate === null ? null : (typeof input.relevantDate === 'number' ? input.relevantDate : undefined),
    dueBy: input.dueBy === null ? null : (typeof input.dueBy === 'number' ? input.dueBy : undefined),
    category: input.category || undefined,
    tags: Array.isArray(input.tags) ? input.tags : undefined
  };
  await bridgeRequest(TOOL_NAMES.update, '/inbox/update', { body });
  return {
    content: [{ type: 'text', text: `Updated action item ${itemId}.` }]
  };
});

// Remove inbox item
server.registerTool(TOOL_NAMES.remove, {
  title: 'Remove action item',
  description: `Permanently delete an action item.

WHEN TO USE:
• User says "delete", "remove", or "get rid of" an action item
• Removing exact duplicates during cleanup

WHEN NOT TO USE:
• User says "done" or "finished" → use rebel_inbox_update with archived=true instead
• Suggest archiving instead if the user might want to reference it later

REQUIRED: You need the item ID. Get it from rebel_inbox_list or rebel_inbox_query.

WARNING: This is permanent. Items cannot be recovered after deletion.`,
  inputSchema: removeTaskSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, async (input) => {
  const itemId = pickTaskId(input);
  if (!itemId) {
    throw new Error('Item id is required. Use rebel_inbox_list to find item IDs.');
  }
  await bridgeRequest(TOOL_NAMES.remove, '/inbox/remove', { body: { id: itemId } });
  return {
    content: [{ type: 'text', text: `Removed action item ${itemId}.` }]
  };
});

// Get single inbox item by ID
server.registerTool(TOOL_NAMES.get, {
  title: 'Get action item details',
  description: `Retrieve the full details of a single action item by its ID.

WHEN TO USE:
• You already have the item ID and need to see its current state
• Checking if an item was updated/archived successfully
• Reading a draft or clarifying question on a specific item

Returns: Full item data including title, text, quadrant, draft, references, etc.`,
  inputSchema: getSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.query, '/inbox/query', {
    body: { includeArchived: true }
  });
  const items = result.items ?? [];
  const item = items.find((i) => i.id === input.id);
  if (!item) {
    throw new Error(`Item not found: ${input.id}`);
  }
  const quadrant = getQuadrantLabel(item);
  const lines = [
    `ID: ${item.id}`,
    `Title: ${item.title}`,
    `Quadrant: ${quadrant}`,
    `Status: ${item.archived ? 'ARCHIVED' : 'ACTIVE'}${item.executingSessionId ? ' [EXECUTING]' : ''}`,
    `Added: ${new Date(item.addedAt).toISOString()}`,
  ];
  if (item.archivedAt) {
    lines.push(`Archived: ${new Date(item.archivedAt).toISOString()}`);
  }
  lines.push(``, `Text: ${item.text}`);
  if (item.draft) {
    lines.push(``, `Draft:`, item.draft);
  }
  if (item.clarifyingQuestion) {
    lines.push(``, `Clarifying question: ${item.clarifyingQuestion}`);
  }
  if (item.source) {
    const srcLabel = item.source.label
      || item.source.path
      || item.source.automationName
      || item.source.meetingTitle
      || item.source.sessionId
      || item.source.kind;
    lines.push(`Source: ${srcLabel} (${item.source.kind})`);
  }
  if (Array.isArray(item.references) && item.references.length > 0) {
    lines.push(`References:`);
    for (const ref of item.references) {
      const formatted = formatReference(ref);
      if (formatted) lines.push(`  - ${formatted}`);
    }
  }
  if (item.relevantDate) {
    lines.push(`Relevant date: ${new Date(item.relevantDate).toISOString()}`);
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
});

// List inbox items
server.registerTool(TOOL_NAMES.list, {
  title: 'List action items',
  description: `List action items with IDs, titles, quadrants, and summaries.

IMPORTANT: By default this returns the first ${LIST_DEFAULT_LIMIT} active items so the payload stays small.
The response always starts with a count header so you can tell whether more items exist.
Each summary is also capped at ${LIST_SUMMARY_MAX_CHARS} characters — call rebel_inbox_get on a specific
item id for the full body.

WHEN TO USE:
• User asks "what's in my actions?", "show my tasks", "list actions"
• Before calling rebel_inbox_update or rebel_inbox_remove (to get item IDs)
• To get a quick overview of the Actions state

PARAMETERS:
• limit (optional): Max items to return. Default: ${LIST_DEFAULT_LIMIT}. Max: 500. Pass an explicit number to fetch more in one call.
• includeArchived (optional): Also show archived items (default: false)
• quadrant (optional): Filter by "do_now", "schedule", "delegate", "consider"

RESPONSE FORMAT:
  ACTIONS: 142 active items (7 archived) | Showing 50 of 142

  1. [uuid-here] Follow up with Sarah
     quadrant: DO NOW
     summary: Send the proposal by Friday...

When the header indicates more items, either raise limit, paginate via rebel_inbox_query
with offset/limit, or use rebel_inbox_stats for a count-only overview.`,
  inputSchema: listTaskSchema,
  annotations: { readOnlyHint: true }
}, async ({ limit, includeArchived, quadrant }) => {
  const effectiveLimit = limit ?? LIST_DEFAULT_LIMIT;
  const result = await bridgeRequest(TOOL_NAMES.query, '/inbox/query', {
    body: { includeArchived, quadrant, limit: effectiveLimit }
  });

  const items = result.items ?? [];
  const totalActive = result.totalActive ?? 0;
  const totalArchived = result.totalArchived ?? 0;
  const totalMatching = result.total ?? items.length;
  const hasMore = result.hasMore ?? false;

  const lines = [];

  // Always emit a clear count header
  const archivedNote = totalArchived > 0 ? ` (${totalArchived} archived)` : '';
  const filterNote = quadrant ? ` | Filtered: ${quadrant.toUpperCase()}` : '';
  if (items.length < totalMatching) {
    lines.push(`ACTIONS: ${totalActive} active items${archivedNote}${filterNote} | Showing ${items.length} of ${totalMatching}`);
  } else {
    lines.push(`ACTIONS: ${totalActive} active items${archivedNote}${filterNote} | Showing all ${items.length}`);
  }
  lines.push('');

  // Items
  lines.push(formatItemList(items, { showArchived: includeArchived }));

  // Explicit "more items" signal
  if (hasMore) {
    lines.push('');
    lines.push(`NOTE: ${totalMatching - items.length} more items not shown. Increase limit or use rebel_inbox_query with offset/limit for pagination.`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
});

// Advanced query tool with full filtering and pagination
server.registerTool(TOOL_NAMES.query, {
  title: 'Query actions with filters',
  description: `Advanced Actions query with filtering, pagination, sorting, and search.

USE THIS WHEN:
• You need to filter: "show archived", "only urgent tasks", "items about X"
• You need pagination for very large action lists (offset + limit)
• You need search: { search: "proposal" }
• You need execution history: { includeHistory: true }

For simple "show me everything" use rebel_inbox_list instead (clearer output).

RESPONSE always includes explicit counts:
• total: matching items (before pagination)
• totalActive / totalArchived / totalHistory: global counts
• hasMore: true if more items exist beyond current page

PARAMETERS:
• includeArchived, archivedOnly, includeHistory: scope control
• quadrant, urgent, important: filter by priority
• search: text search in title and text (case-insensitive)
• addedAfter / addedBefore: date range (ISO date or epoch ms)
• limit (max 500), offset: pagination
• sortBy: "addedAt" (default), "title", "quadrant"
• sortOrder: "asc" or "desc"`,
  inputSchema: querySchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.query, '/inbox/query', { body: input });
  
  const lines = [];
  const total = result.total ?? 0;
  const offset = input.offset ?? 0;
  const totalActive = result.totalActive ?? 0;
  const totalArchived = result.totalArchived ?? 0;
  const itemCount = result.items?.length ?? 0;
  
  // Header with explicit counts
  if (input.archivedOnly) {
    lines.push(`ARCHIVED ITEMS: ${total} found (of ${totalArchived} total archived)`);
  } else if (input.includeArchived) {
    lines.push(`ALL ITEMS: ${total} found (${totalActive} active, ${totalArchived} archived)`);
  } else {
    lines.push(`ACTIVE ITEMS: ${total} found (of ${totalActive} total active)`);
  }
  
  // Show active filters
  const filters = [];
  if (input.quadrant) filters.push(`quadrant=${input.quadrant.toUpperCase()}`);
  if (input.search) filters.push(`search="${input.search}"`);
  if (input.urgent !== undefined) filters.push(`urgent=${input.urgent}`);
  if (input.important !== undefined) filters.push(`important=${input.important}`);
  if (input.addedAfter) filters.push(`after=${input.addedAfter}`);
  if (input.addedBefore) filters.push(`before=${input.addedBefore}`);
  if (filters.length > 0) {
    lines.push(`Filters: ${filters.join(', ')}`);
  }
  if (offset > 0 || input.limit) {
    lines.push(`Page: offset=${offset}, limit=${input.limit ?? 'none'}, showing=${itemCount}`);
  }
  lines.push('');
  
  // Items
  lines.push(formatItemList(result.items ?? [], {
    showArchived: input.archivedOnly || input.includeArchived,
    startIndex: offset
  }));
  
  // Pagination info
  if (result.hasMore) {
    const nextOffset = offset + itemCount;
    lines.push('');
    lines.push(`MORE ITEMS AVAILABLE: ${total - nextOffset} remaining. Use offset=${nextOffset} to get next page.`);
  }
  
  // History if requested
  if (input.includeHistory && result.history?.length > 0) {
    lines.push('');
    lines.push('─────────────────────────────────────');
    lines.push(`EXECUTION HISTORY: ${result.totalHistory ?? result.history.length} total entries`);
    lines.push('');
    lines.push(summarizeHistory(result.history, input.limit));
  }
  
  return {
    content: [{ type: 'text', text: lines.join('\n') }]
  };
});

// Feedback examples tool
server.registerTool(TOOL_NAMES.feedback, {
  title: 'Recent dismissed Actions feedback',
  description: `Fetch recent dismissed action examples with the user's feedback reason.

WHEN TO USE:
• Before automated/source-capture creation of new Actions
• When deciding whether a candidate action is genuinely useful for this user
• When you need examples of past misses from the same source/category

HOW TO USE THE OUTPUT:
• Treat examples as weak calibration evidence, not rules
• Do NOT create keyword blacklists from people, topics, clients, or words in examples
• Prefer filtering by sourceKind/automationId/automationName/category so feedback stays scoped
• Skip a candidate only when the new item has the same kind of source, action shape, and user-value problem

COMMON SOURCE-CAPTURE CALL:
{ "automationId": "system-source-capture", "automationName": "source-capture", "limit": 5 }`,
  inputSchema: feedbackSchema,
  annotations: { readOnlyHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.feedback, '/inbox/feedback', { body: input });
  return {
    content: [{ type: 'text', text: formatFeedbackExamples(result.examples ?? []) }]
  };
});

// Stats tool
server.registerTool(TOOL_NAMES.stats, {
  title: 'Actions statistics',
  description: `Get a quick count-only overview of Actions state: totals by quadrant, archived, history.

WHEN TO USE:
• User asks "how many tasks do I have?", "actions overview"
• Before bulk operations to understand scope
• To get counts without loading all item data

RETURNS: Total counts, breakdown by Eisenhower quadrant, date range.
Does NOT return individual items — use rebel_inbox_list for that.`,
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true }
}, async () => {
  const result = await bridgeRequest(TOOL_NAMES.stats, '/inbox/stats', { method: 'GET' });
  return {
    content: [{ type: 'text', text: formatStats(result) }]
  };
});

// Bulk operations tool
server.registerTool(TOOL_NAMES.bulk, {
  title: 'Bulk action operations',
  description: `Perform mass operations on action items. Use for reorganization and cleanup.

WHEN TO USE:
• Archive multiple items: { action: "archive", ids: ["id1", "id2"] }
• Unarchive items: { action: "unarchive", ids: ["id1", "id2"] }
• Delete items: { action: "delete", ids: ["id1", "id2"] }
• Move to quadrant: { action: "move_quadrant", ids: [...], urgent: true, important: false }
• Archive whole quadrant: { action: "archive_quadrant", quadrant: "consider" }
• Delete whole quadrant: { action: "delete_quadrant", quadrant: "consider" }
• Archive all active: { action: "archive_all" }
• Delete all archived: { action: "delete_archived" }

WORKFLOW: Use rebel_inbox_list or rebel_inbox_query first to get item IDs.

CAUTION: Delete operations are permanent. Archive is reversible.`,
  inputSchema: bulkSchema,
  annotations: { readOnlyHint: false, destructiveHint: true }
}, async (input) => {
  const result = await bridgeRequest(TOOL_NAMES.bulk, '/inbox/bulk', { body: input });
  return {
    content: [{ type: 'text', text: result.message }]
  };
});

// =============================================================================
// Start the server
// =============================================================================
const transport = new StdioServerTransport();

server
  .connect(transport)
  .then(() => {
    console.error('[RebelInbox] Server started');
  })
  .catch((error) => {
    console.error('[RebelInbox] Failed to start', error);
    process.exit(1);
  });
