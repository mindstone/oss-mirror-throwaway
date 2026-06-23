/**
 * Tool Normalization Keys
 *
 * Per-tool-family canonical-args dispatcher. Builds a stable, semantic key for
 * (toolId, normalized args) pairs so the session decision cache can short-
 * circuit the LLM safety evaluator on repeat calls within a session. Strategies
 * are conservative — when in doubt, return null (do-not-memoize).
 *
 * @see docs/plans/260526_safety_eval_context_completeness.md (Stage 1, Lever E / P0.4)
 * @see sessionToolDecisionCache.ts — TTL + prompt-version-aware allow cache that consumes these keys
 */

import crypto from 'node:crypto';

export interface BuildNormalizedToolKeyArgs {
  toolName: string;
  effectiveToolId: string;
  packageId: string | undefined;
  toolInput: unknown;
}

export type SafetyCacheStrategyFamily =
  | 'bash'
  | 'image_generation'
  | 'send_message'
  | 'send_email'
  | 'create_calendar_event'
  | 'file_write'
  | 'mcp_router'
  | 'default';

export interface MemoizationStrategy {
  family: SafetyCacheStrategyFamily;
  memoizable: boolean;
  sideEffectFields: readonly string[];
  toolNames?: readonly string[];
  matches(args: BuildNormalizedToolKeyArgs): boolean;
  buildKey(args: BuildNormalizedToolKeyArgs): string | null;
}

const VOLATILE_FIELDS: ReadonlySet<string> = new Set([
  '_rebel_staged',
  '_rebel_staged_id',
  '_rebel_staged_message',
]);

// File-write tool families are NEVER memoized: keying on file path alone would
// allow an agent to write safe content first, then mutate the payload to
// malicious content within the TTL window and bypass safety re-evaluation.
// Hashing content into the key is also a wash because it would never
// short-circuit anyway (content varies per call). Always re-eval.
const NO_MEMOIZE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'SearchFiles',
  'Edit',
  'Write',
  'Create',
  'str_replace_editor',
  'write_file',
  'create_file',
  // Additional edit/write surfaces the repo classifies as destructive
  // (lazyContextAccumulator, mcpClient, packages/shared approvalUtils). Kept
  // non-memoizable so a write/edit can never reuse a stale allow (rec C8 / F4).
  'MultiEdit',
  'NotebookEdit',
  'TextEditor',
]);

const NO_MEMOIZE_TOOL_NAME_LIST = [...NO_MEMOIZE_TOOL_NAMES] as const;

const ROUTER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'mcp__super-mcp-router__use_tool',
  'use_tool',
]);

const IMAGE_GEN_TOOL_PATTERN = /openai.*generate_image|generate_image$/i;
const SLACK_TOOL_PATTERN = /slack/i;
const SLACK_ACTION_PATTERN = /(?:^|_)(?:send_|post_)/;
// Email-send tool ids across connectors (Gmail/Workspace, Microsoft Mail, generic):
// send_workspace_email, gmail*send, send_email / email_send (Microsoft Mail),
// forward_email. NOTE: this list need not be exhaustive for SAFETY — any email-send
// tool NOT matched here falls through to the mcp_router/default strategy, which keys
// the FULL canonical args (every field), so no subset-key bypass is possible either
// way. The pattern only determines whether a send is explicitly non-memoized (matched)
// vs safely full-args-keyed (unmatched). See the send_email strategy comment.
const EMAIL_SEND_TOOL_PATTERN = /gmail.*send|send_workspace_email|workspace.*send|send_email|email_send|forward_email/i;
const CALENDAR_CREATE_TOOL_PATTERN = /create_calendar_event|create_event/i;

function sha256(...parts: string[]): string {
  const hash = crypto.createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('|');
  }
  return hash.digest('hex');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRecordField(input: unknown, ...keys: string[]): string | undefined {
  if (!isPlainRecord(input)) return undefined;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Recursively canonicalize an object/array so equivalent shapes hash the same:
 * - object keys sorted lexicographically
 * - volatile fields (`_rebel_staged*`, anything starting with `_internal_`) stripped
 * - arrays preserved in order (caller decides whether to sort, e.g. recipients)
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainRecord(value)) {
    const sortedKeys = Object.keys(value)
      .filter((key) => !VOLATILE_FIELDS.has(key) && !key.startsWith('_internal_'))
      .sort();
    const sorted: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalArgsJSON(input: unknown): string {
  return JSON.stringify(canonicalize(input) ?? null);
}

function bashCanonical(command: string, cwd: string): string {
  const stripped = command.replace(/\s*2>\s*\/dev\/null/g, '');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return cwd ? `${cwd}::${collapsed}` : collapsed;
}

export function bashKey(toolName: string, toolInput: unknown): string | null {
  if (!isPlainRecord(toolInput)) return null;
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  if (!command) return null;
  const cwd = typeof toolInput.cwd === 'string' ? toolInput.cwd : '';
  return sha256(toolName, bashCanonical(command, cwd));
}

/**
 * @deprecated File-write tool families are no longer memoized; they always
 * re-evaluate so payload mutations can't slip past the safety eval inside the
 * cache TTL window. Retained as an exported no-op (returns `null`) for
 * backwards compatibility with any external callers.
 */
export function editWriteKey(_toolName: string, _toolInput: unknown): string | null {
  return null;
}

export function mcpRouterKey(args: BuildNormalizedToolKeyArgs): string {
  const { toolInput, packageId, effectiveToolId } = args;
  const innerToolId = readRecordField(toolInput, 'tool_id') ?? effectiveToolId;
  return sha256(packageId ?? '', innerToolId, canonicalArgsJSON(toolInput));
}

export function imageGenKey(args: BuildNormalizedToolKeyArgs): string | null {
  const { effectiveToolId, toolInput } = args;
  const inner = isPlainRecord(toolInput) && isPlainRecord(toolInput.args)
    ? toolInput.args
    : isPlainRecord(toolInput)
      ? toolInput
      : null;
  const prompt = readRecordField(inner, 'prompt');
  if (!prompt) return null;
  const model = readRecordField(inner, 'model') ?? '';
  const aspect = readRecordField(inner, 'size', 'aspect_ratio') ?? '';
  // Generation parameters that change the produced output / external side effect
  // (rec C8 / behavioral-safety review F3): quality, count (n), moderation. Without
  // these a single moderated image's allow could be reused for many higher-quality
  // or differently-moderated images sharing the same prompt + size.
  const quality = readRecordField(inner, 'quality') ?? '';
  const moderation = readRecordField(inner, 'moderation') ?? '';
  const countRaw = isPlainRecord(inner) ? (inner.n ?? inner.count) : undefined;
  const count = countRaw === undefined || countRaw === null ? '' : String(countRaw);
  return sha256(effectiveToolId, prompt, model, aspect, quality, moderation, count);
}

export function defaultKey(toolName: string, toolInput: unknown): string {
  return sha256(toolName, canonicalArgsJSON(toolInput));
}

function detectFamily(effectiveToolId: string): 'image' | 'slack' | 'email' | 'calendar' | null {
  if (IMAGE_GEN_TOOL_PATTERN.test(effectiveToolId)) return 'image';
  if (EMAIL_SEND_TOOL_PATTERN.test(effectiveToolId)) return 'email';
  if (CALENDAR_CREATE_TOOL_PATTERN.test(effectiveToolId)) return 'calendar';
  if (SLACK_TOOL_PATTERN.test(effectiveToolId) && SLACK_ACTION_PATTERN.test(effectiveToolId)) return 'slack';
  return null;
}

/**
 * Coarse tool-family classification used to scope user-intent classification
 * (Stage 3). Returns a stable string identifier the classifier prompt can match
 * against the user's most-recent message. Conservative — falls back to `other`
 * rather than guessing.
 *
 * @see userIntentExtractor.ts
 */
export type CoarseToolFamily =
  | 'image_generation'
  | 'send_message'
  | 'send_email'
  | 'create_calendar_event'
  | 'shell_command'
  | 'file_edit'
  | 'file_write'
  | 'memory_write'
  | 'web_fetch'
  | 'mcp_other'
  | 'other';

const FILE_EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Edit',
  'str_replace_editor',
]);

const FILE_WRITE_TOOL_NAMES_FAMILY: ReadonlySet<string> = new Set([
  'Write',
  'Create',
  'write_file',
]);

const MEMORY_WRITE_TOOL_PATTERN = /(?:memory_write|write_memory|create_memory)/i;
const WEB_FETCH_TOOL_PATTERN = /(?:web[_-]?(?:search|fetch)|fetch[_-]?url|webfetch|websearch)/i;

export function getToolFamily(args: {
  toolName: string;
  effectiveToolId: string;
  packageId?: string;
}): CoarseToolFamily {
  const { toolName, effectiveToolId } = args;

  if (toolName === 'Bash') return 'shell_command';
  if (FILE_EDIT_TOOL_NAMES.has(toolName)) return 'file_edit';
  if (FILE_WRITE_TOOL_NAMES_FAMILY.has(toolName)) return 'file_write';

  if (MEMORY_WRITE_TOOL_PATTERN.test(effectiveToolId)) return 'memory_write';
  if (WEB_FETCH_TOOL_PATTERN.test(effectiveToolId)) return 'web_fetch';

  const family = detectFamily(effectiveToolId);
  if (family === 'image') return 'image_generation';
  if (family === 'email') return 'send_email';
  if (family === 'calendar') return 'create_calendar_event';
  if (family === 'slack') return 'send_message';

  if (ROUTER_TOOL_NAMES.has(toolName)) return 'mcp_other';

  return 'other';
}

export const SAFETY_CACHE_MEMOIZATION_STRATEGIES: readonly MemoizationStrategy[] = [
  {
    family: 'file_write',
    memoizable: false,
    sideEffectFields: [],
    toolNames: NO_MEMOIZE_TOOL_NAME_LIST,
    matches: ({ toolName }) => NO_MEMOIZE_TOOL_NAMES.has(toolName),
    buildKey: ({ toolName, toolInput }) => editWriteKey(toolName, toolInput),
  },
  {
    family: 'bash',
    memoizable: true,
    sideEffectFields: ['command', 'cwd'],
    matches: ({ toolName }) => toolName === 'Bash',
    buildKey: ({ toolName, toolInput }) => bashKey(toolName, toolInput),
  },
  {
    family: 'image_generation',
    memoizable: true,
    sideEffectFields: ['prompt', 'model', 'size', 'aspect_ratio', 'quality', 'moderation', 'count'],
    matches: ({ effectiveToolId }) => detectFamily(effectiveToolId) === 'image',
    buildKey: imageGenKey,
  },
  {
    // NON-MEMOIZABLE by policy (behavioral-safety review). slackKey hashed only
    // channel + message_text — a SUBSET. Slack-like sends can carry blocks,
    // attachments, and thread targeting (blocks are treated as message body by
    // the shared action-preview projectors), so an allow for a benign message
    // could be reused for the same channel+text plus added blocks/attachments.
    // The matcher classifies by effectiveToolId pattern (broader than the bundled
    // connector's current narrow schema) and wins over mcp_router, so we cannot
    // rely on the connector schema staying narrow. Never memoize; safety eval
    // always runs.
    family: 'send_message',
    memoizable: false,
    sideEffectFields: [],
    matches: ({ effectiveToolId }) => detectFamily(effectiveToolId) === 'slack',
    buildKey: () => null,
  },
  {
    // NON-MEMOIZABLE by policy (behavioral-safety review F1). Email send schemas
    // diverge widely across providers (Google: cc/bcc/attachments/is_html/reply;
    // Microsoft: cc/importance) — far more than emailSendKey's to/subject/body. A
    // partial key reproduces the exact source-bug bypass class (an allow for a
    // plain message reused for one with cc=execs, bcc=external, attachments).
    // Rather than enumerate every provider's full envelope (brittle — the next
    // provider field silently reopens the gap), we never memoize email sends: the
    // safety eval always runs. (If memoization is ever revisited, a complete
    // per-provider key would need the full envelope listed above.)
    family: 'send_email',
    memoizable: false,
    sideEffectFields: [],
    matches: ({ effectiveToolId }) => detectFamily(effectiveToolId) === 'email',
    buildKey: () => null,
  },
  {
    // NON-MEMOIZABLE by policy (behavioral-safety review F2). Calendar events are
    // defined by far more than calendar_id/start/attendees (subject, end, body,
    // location, recurrence, reminders, online-meeting flag, visibility…), and the
    // set diverges across Google/Microsoft. Same reasoning as send_email: never
    // memoize; safety eval always runs.
    family: 'create_calendar_event',
    memoizable: false,
    sideEffectFields: [],
    matches: ({ effectiveToolId }) => detectFamily(effectiveToolId) === 'calendar',
    buildKey: () => null,
  },
  {
    family: 'mcp_router',
    memoizable: true,
    sideEffectFields: ['packageId', 'tool_id', 'canonical_args'],
    matches: ({ toolName }) => ROUTER_TOOL_NAMES.has(toolName),
    buildKey: mcpRouterKey,
  },
  {
    family: 'default',
    memoizable: true,
    sideEffectFields: ['toolName', 'canonical_args'],
    matches: () => true,
    buildKey: ({ toolName, toolInput }) => defaultKey(toolName, toolInput),
  },
];

export function getMemoizationStrategy(args: BuildNormalizedToolKeyArgs): MemoizationStrategy {
  return SAFETY_CACHE_MEMOIZATION_STRATEGIES.find((strategy) => strategy.matches(args))
    ?? SAFETY_CACHE_MEMOIZATION_STRATEGIES[SAFETY_CACHE_MEMOIZATION_STRATEGIES.length - 1];
}

export function buildNormalizedToolKey(args: BuildNormalizedToolKeyArgs): string | null {
  const strategy = getMemoizationStrategy(args);
  const key = strategy.buildKey(args);
  return strategy.memoizable ? key : null;
}
