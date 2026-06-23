import {
  extractBasename,
  sanitizeCommandForDisplay,
  toTitleCase,
} from '@rebel/shared';
import type { AgentEvent, ContentRef, ImageContentBlock, ImageRef, McpAppUiMeta, McpAppViewData } from '@shared/types';
import { safeParseDetail } from './safeParseDetail';

export type ToolChipTone = 'files' | 'shell' | 'network' | 'planning' | 'default';

export type ToolChipStatus = 'pending' | 'running' | 'success' | 'error';

export type ToolChipEmphasis = 'primary' | 'subtle';

export type StepToolSummary = {
  label: string;
  detail?: string;
  /** Raw result payload preserved for result-aware affordances. */
  resultPayload?: unknown;
  icon: string;
  tone: ToolChipTone;
  count?: number;
  status?: ToolChipStatus;
  emphasis?: ToolChipEmphasis;
  parentToolUseId?: string | null;
  /** Original tool name (for filtering, e.g., hiding Task tools) */
  toolName?: string;
  /** Tool use ID (for matching with SubAgentTimeline items) */
  toolUseId?: string;
  /**
   * First-observed tool emission order within the turn. Used by primary MCP App
   * selection so "first primary wins" follows model emission, not completion time.
   */
  emissionIndex?: number;
  /** Timestamp from the first-observed tool event, used only as a deterministic fallback sort key. */
  emissionTimestamp?: number;
  /** Image content from tool results (transient, not persisted) */
  imageContent?: ImageContentBlock[];
  /**
   * Positional image refs from tool results (transient, not persisted).
   * Aligned 1:1 with `imageContent[]` — `null` entries mean materialization
   * failed for that slot and the legacy inline base64 (if present) is the
   * fallback path.
   */
  imageRef?: (ImageRef | null)[];
  /**
   * Positional content refs from tool results (transient, not persisted).
   * Aligned 1:1 with tool-result content blocks.
   */
  contentRef?: (ContentRef | null)[];
  /** Full untruncated file path for tooltip display */
  fullPath?: string;
  /** Full untruncated shell command for tooltip display */
  fullCommand?: string;
  /** Full untruncated URL for tooltip display */
  fullUrl?: string;
  /** MCP Apps UI metadata (when tool supports interactive views) */
  mcpAppUiMeta?: McpAppUiMeta;
  /** Full tool result payload for MCP App Views that need structured data */
  toolResult?: McpAppViewData['toolResult'];
};

type ToolAgentEvent = Extract<AgentEvent, { type: 'tool' }>;

const TOOL_ICONS: Record<ToolChipTone, string> = {
  files: '📄',
  shell: '⌨️',
  network: '🌐',
  planning: '🧠',
  default: '⚙️'
};

type ParsedToolDetail = {
  paths: string[];
  url: string | null;
  command: string | null;
  summary: string | null;
  serverName: string | null;
  actionName: string | null;
  status: string | null;
  highlights: string[];
  innerToolName: string | null;
  packageName: string | null;
};

const mergeParsedDetails = (primary: ParsedToolDetail, fallback: ParsedToolDetail): ParsedToolDetail => ({
  paths: primary.paths.length > 0 ? primary.paths : fallback.paths,
  url: primary.url ?? fallback.url,
  command: primary.command ?? fallback.command,
  summary: primary.summary ?? fallback.summary,
  serverName: primary.serverName ?? fallback.serverName,
  actionName: primary.actionName ?? fallback.actionName,
  status: primary.status ?? fallback.status,
  highlights: primary.highlights.length > 0 ? primary.highlights : fallback.highlights,
  innerToolName: primary.innerToolName ?? fallback.innerToolName,
  packageName: primary.packageName ?? fallback.packageName
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  if (!value.trim()) return null;
  const parsed = safeParseDetail(value);
  return parsed.ok && isRecord(parsed.value) ? parsed.value : null;
}

function extractPayloadRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const result = value.result;
  return isRecord(result) ? result : value;
}

function extractOperatorResultPayload(event: ToolAgentEvent, toolName: string): unknown {
  if (toolName !== 'rebel_operator__consult' || event.stage !== 'end') {
    return undefined;
  }

  const structuredPayload = extractPayloadRecord(event.toolResult?.structuredContent);
  if (structuredPayload) return structuredPayload;

  const content = event.toolResult?.content as unknown;
  const contentItems = Array.isArray(content) ? content : [content];
  for (const item of contentItems) {
    if (typeof item === 'string') {
      const parsed = extractPayloadRecord(parseJsonRecord(item));
      if (parsed) return parsed;
    }
    if (isRecord(item) && typeof item.text === 'string') {
      const parsed = extractPayloadRecord(parseJsonRecord(item.text));
      if (parsed) return parsed;
    }
  }

  return undefined;
}

const PATH_KEYS = [
  'path',
  'file_path',
  'filepath',
  'source',
  'destination',
  'old_path',
  'new_path',
  'file',
  'files',
  'paths'
];

const URL_KEYS = ['url', 'endpoint', 'href'];
const COMMAND_KEYS = ['command', 'cmd', 'script'];
const SUMMARY_KEYS = ['summary', 'result', 'message', 'status', 'output'];
const SERVER_KEYS = ['server', 'server_name', 'serverName', 'router'];
const ACTION_KEYS = ['action', 'action_name', 'actionName', 'operation'];
const STATUS_KEYS = ['status', 'state'];
const HIGHLIGHT_KEYS = ['query', 'text', 'title', 'target', 'resource', 'channel', 'thread', 'email', 'path'];
const INNER_TOOL_KEYS = ['tool_name', 'toolName', 'target_tool_name', 'targetToolName', 'tool_id', 'toolId'];
const PACKAGE_KEYS = ['package_id', 'packageId'];

// extractBasename imported from @rebel/shared

// sanitizeCommandForDisplay imported from @rebel/shared

// JSON Schema type hints and other meaningless values to filter out
const SCHEMA_TYPE_VALUES = new Set([
  'string', 'number', 'boolean', 'object', 'array', 'null', 'integer',
  'any', 'undefined', 'unknown', 'void', 'never'
]);

const isSchemaTypeValue = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return SCHEMA_TYPE_VALUES.has(normalized) || /^<[a-z]+>$/i.test(value);
};

const collectValues = (
  value: unknown,
  keys: string[],
  collector: Set<string>,
  shouldCollect = false,
  keyPath: string[] = []
) => {
  if (value === undefined || value === null) {
    return;
  }

  if (typeof value === 'string') {
    if (shouldCollect && !isSchemaTypeValue(value)) {
      collector.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectValues(entry, keys, collector, shouldCollect, keyPath));
    return;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    Object.entries(record).forEach(([childKey, childValue]) => {
      const nextShouldCollect = shouldCollect || keys.includes(childKey);
      collectValues(childValue, keys, collector, nextShouldCollect, [...keyPath, childKey]);
    });
  }
};

const parseToolDetail = (detail: string): ParsedToolDetail => {
  if (!detail || !detail.trim()) {
    return {
      paths: [],
      url: null,
      command: null,
      summary: null,
      serverName: null,
      actionName: null,
      status: null,
      highlights: [],
      innerToolName: null,
      packageName: null
    } satisfies ParsedToolDetail;
  }

  const trimmed = detail.trim();

  const parseResult = safeParseDetail(trimmed);
  try {
    if (!parseResult.ok) {
      // too-large / malformed → reuse the plain-text fallback below
      throw new Error(parseResult.reason);
    }
    const parsed = parseResult.value;
    const pathCollector = new Set<string>();
    collectValues(parsed, PATH_KEYS, pathCollector);
    const urlCollector = new Set<string>();
    collectValues(parsed, URL_KEYS, urlCollector);
    const commandCollector = new Set<string>();
    collectValues(parsed, COMMAND_KEYS, commandCollector);
    const serverCollector = new Set<string>();
    collectValues(parsed, SERVER_KEYS, serverCollector);
    const actionCollector = new Set<string>();
    collectValues(parsed, ACTION_KEYS, actionCollector);
    const statusCollector = new Set<string>();
    collectValues(parsed, STATUS_KEYS, statusCollector);
    const highlightCollector = new Set<string>();
    collectValues(parsed, HIGHLIGHT_KEYS, highlightCollector);
    const innerToolCollector = new Set<string>();
    collectValues(parsed, INNER_TOOL_KEYS, innerToolCollector);
    const packageCollector = new Set<string>();
    collectValues(parsed, PACKAGE_KEYS, packageCollector);

    const summaryCollector = new Set<string>();
    collectValues(parsed, SUMMARY_KEYS, summaryCollector);
    const summary = summaryCollector.size > 0 ? Array.from(summaryCollector)[0] : null;

    return {
      paths: Array.from(pathCollector),
      url: urlCollector.size > 0 ? Array.from(urlCollector)[0] : null,
      command: commandCollector.size > 0 ? Array.from(commandCollector)[0] : null,
      summary,
      serverName: serverCollector.size > 0 ? Array.from(serverCollector)[0] : null,
      actionName: actionCollector.size > 0 ? Array.from(actionCollector)[0] : null,
      status: statusCollector.size > 0 ? Array.from(statusCollector)[0] : null,
      highlights: Array.from(highlightCollector),
      innerToolName: innerToolCollector.size > 0 ? Array.from(innerToolCollector)[0] : null,
      packageName: packageCollector.size > 0 ? Array.from(packageCollector)[0] : null
    };
  } catch {
    // Plain text fallback
    const urlMatch = trimmed.match(/https?:\/\/\S+/u);
    const pathMatch = trimmed.match(/([./~][\w@#$%^&()\-./]+\.[\w-]+)$/u);
    const commandMatch = trimmed.match(/^(?:bash|sh|zsh|cmd|powershell)\s.+$/iu);
    return {
      paths: pathMatch ? [pathMatch[1]] : [],
      url: urlMatch ? urlMatch[0] : null,
      command: commandMatch ? commandMatch[0] : null,
      summary: trimmed,
      serverName: null,
      actionName: null,
      status: null,
      highlights: [],
      innerToolName: null,
      packageName: null
    };
  }
};

// toTitleCase imported from @rebel/shared

const tokenize = (value: string): string[] => value.split(/[^a-z0-9]+/gi).map((token) => token.toLowerCase()).filter(Boolean);

const chooseTone = (toolName: string, detail: ParsedToolDetail): ToolChipTone => {
  const candidates = buildCategoryCandidates(toolName, detail);
  const tokens = candidates.flatMap((candidate) => tokenize(candidate));

  const hasToken = (...needle: string[]) => tokens.some((token) => needle.includes(token));

  if (detail.paths.length > 0 || hasToken('file', 'files', 'read', 'write', 'edit', 'create', 'filesystem', 'directory', 'path')) {
    return 'files';
  }
  if (detail.command || hasToken('shell', 'bash', 'terminal', 'cmd', 'powershell', 'command')) {
    return 'shell';
  }
  if (detail.url || hasToken('http', 'https', 'fetch', 'request', 'api', 'network', 'web')) {
    return 'network';
  }
  if (hasToken('plan', 'task', 'todo', 'analyze', 'analysis', 'reason', 'chain', 'agent', 'workflow')) {
    return 'planning';
  }
  return 'default';
};

const STATUS_ERROR_PATTERNS = [/error/, /fail/, /failed/, /denied/, /timeout/, /cancel/, /panic/, /invalid/];
const STATUS_PENDING_PATTERNS = [/pending/, /queue/, /queued/, /wait/, /in[_-]?progress/, /running/];
const STATUS_SUCCESS_PATTERNS = [/ok/, /success/, /complete/, /completed/, /done/, /finished/, /resolved/];

const containsPattern = (value: string | null | undefined, patterns: RegExp[]): boolean => {
  if (!value) return false;
  return patterns.some((pattern) => pattern.test(value));
};

const normalizeBoolean = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 0) return false;
    if (value === 1) return true;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'ok', 'success'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'error', 'fail'].includes(normalized)) {
      return false;
    }
  }
  return null;
};

const extractStatusText = (...values: Array<string | null | undefined>): string | null => {
  const text = values.find((value) => Boolean(value));
  return text ? text.toLowerCase() : null;
};

const deriveChipStatus = (
  event: ToolAgentEvent,
  summaryDetail: ParsedToolDetail,
  runtimeDetail: ParsedToolDetail
): ToolChipStatus => {
  const normalizedStatus = extractStatusText(summaryDetail.status, runtimeDetail.status);
  const parsePayload = (): Record<string, unknown> | null => {
    const parsed = safeParseDetail(event.detail ?? '{}');
    return parsed.ok && isRecord(parsed.value) ? parsed.value : null;
  };

  const payload = parsePayload();
  const result = (payload?.result as Record<string, unknown>) ?? null;
  const telemetry = (payload?.telemetry as Record<string, unknown>) ?? null;

  const explicitErrorFlags = [
    result?.isError,
    payload?.isError,
    payload?.error,
    result?.ok === false,
    payload?.ok === false,
    telemetry?.status === 'error'
  ]
    .map((flag) => normalizeBoolean(flag))
    .filter((flag): flag is boolean => flag !== null)
    .some((flag) => flag === true);

  const statusFromPayload = extractStatusText(
    summaryDetail.status,
    runtimeDetail.status,
    typeof result?.status === 'string' ? (result.status as string) : null,
    typeof telemetry?.status === 'string' ? (telemetry.status as string) : null,
    typeof payload?.status === 'string' ? (payload.status as string) : null
  );

  if (event.stage === 'start') {
    if (containsPattern(statusFromPayload, STATUS_PENDING_PATTERNS)) {
      return 'pending';
    }
    if (containsPattern(normalizedStatus, STATUS_PENDING_PATTERNS)) {
      return 'pending';
    }
    return 'running';
  }

  if (explicitErrorFlags) {
    return 'error';
  }

  const explicitSuccessFlags = [
    result?.isError === false,
    result?.ok,
    payload?.ok,
    telemetry?.status === 'ok' || telemetry?.status === 'success'
  ]
    .map((flag) => normalizeBoolean(flag))
    .filter((flag): flag is boolean => flag !== null)
    .some((flag) => flag === true);

  if (explicitSuccessFlags) {
    return 'success';
  }

  if (containsPattern(statusFromPayload, STATUS_ERROR_PATTERNS) || containsPattern(normalizedStatus, STATUS_ERROR_PATTERNS)) {
    return 'error';
  }

  if (containsPattern(statusFromPayload, STATUS_PENDING_PATTERNS) || containsPattern(normalizedStatus, STATUS_PENDING_PATTERNS)) {
    return 'pending';
  }

  if (containsPattern(statusFromPayload, STATUS_SUCCESS_PATTERNS) || containsPattern(normalizedStatus, STATUS_SUCCESS_PATTERNS)) {
    return 'success';
  }

  return 'success';
};

type CategoryDefinition = {
  id: string;
  tone: ToolChipTone;
  icon: string;
  label: string;
  keywords: RegExp[];
};

const isRouterCategory = (category: CategoryDefinition | null | undefined): boolean => {
  if (!category) {
    return false;
  }
  return category.id === 'router' || category.id === 'automation_router';
};

const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
  {
    id: 'filesystem_read',
    tone: 'files',
    icon: '📖',
    label: 'Read file',
    keywords: [
      /read[_ ]files?/,
      /view[_ ]file/,
      /open[_ ]file/,
      /show[_ ]file/,
      /print[_ ]file/,
      /\bcat\b/,
      /\bhead\b/,
      /\btail\b/
    ]
  },
  {
    id: 'filesystem_write',
    tone: 'files',
    icon: '📝',
    label: 'Write file',
    keywords: [/write[_ ]files?/, /edit[_ ]file/, /update[_ ]file/, /append[_ ]file/, /apply[_ ]patch/, /save[_ ]file/]
  },
  {
    id: 'filesystem_create',
    tone: 'files',
    icon: '✨',
    label: 'Create file',
    keywords: [/create[_ ]file/, /new[_ ]file/, /\btouch\b/, /\bmkdir\b/, /make[_ ]dir/]
  },
  {
    id: 'filesystem_list',
    tone: 'files',
    icon: '📁',
    label: 'List files',
    keywords: [/list[_ ]files?/, /files?[_ ]list/, /\bls\b/, /\bdir\b/, /\btree\b/, /\bglob\b/, /walk[_ ]files?/]
  },
  {
    id: 'filesystem_search',
    tone: 'files',
    icon: '🔍',
    label: 'Search files',
    keywords: [/search[_ ]files?/, /files?[_ ]search/, /find[_ ]files?/, /\bgrep\b/, /\brg\b/]
  },
  {
    id: 'terminal',
    tone: 'shell',
    icon: '⌨️',
    label: 'Shell command',
    keywords: [/bash/, /shell/, /command/, /terminal/, /sh/]
  },
  {
    id: 'network',
    tone: 'network',
    icon: '🌐',
    label: 'Network call',
    keywords: [/http/, /fetch/, /request/, /url/, /api/, /websearch/, /web[_ ]?search/, /search[_ ]?web/]
  },
  {
    id: 'planner',
    tone: 'planning',
    icon: '🧠',
    label: 'Planning',
    keywords: [/plan/, /todo/, /task/, /agent/, /strategy/]
  },
  {
    id: 'knowledge',
    tone: 'planning',
    icon: '📘',
    label: 'Knowledge lookup',
    keywords: [/skill/, /memory/, /notebook/, /knowledge/]
  },
  {
    id: 'automation',
    tone: 'planning',
    icon: '🤖',
    label: 'Automation',
    keywords: [/automation/, /schedule/, /run_task/, /workflow/]
  },
  {
    id: 'email',
    tone: 'network',
    icon: '✉️',
    label: 'Email access',
    keywords: [/gmail/, /email/, /inbox/, /mail/]
  },
  {
    id: 'slack',
    tone: 'network',
    icon: '💬',
    label: 'Slack',
    keywords: [/slack/, /channel/, /workspace/]
  },
  {
    id: 'calendar',
    tone: 'planning',
    icon: '🗓️',
    label: 'Calendar',
    keywords: [/calendar/, /event/, /schedule/, /availability/]
  },
  {
    id: 'docs',
    tone: 'files',
    icon: '📄',
    label: 'Documents',
    keywords: [/google_docs/, /document/, /docx/, /notion/, /confluence/]
  },
  {
    id: 'sheets',
    tone: 'files',
    icon: '📊',
    label: 'Spreadsheets',
    keywords: [/sheet/, /spreadsheet/, /excel/, /table/, /rows?/]
  },
  {
    id: 'crm',
    tone: 'planning',
    icon: '🧾',
    label: 'CRM',
    keywords: [/salesforce/, /hubspot/, /pipedrive/, /contact/, /deal/, /opportunit/]
  },
  {
    id: 'storage',
    tone: 'files',
    icon: '🗂️',
    label: 'File storage',
    keywords: [/drive/, /dropbox/, /box/, /onedrive/, /storage/, /files/]
  },
  {
    id: 'tasks',
    tone: 'planning',
    icon: '✅',
    label: 'Tasks',
    keywords: [/todo/, /task/, /asana/, /trello/, /clickup/, /linear/, /jira/]
  },
  {
    id: 'code_hosting',
    tone: 'planning',
    icon: '🐙',
    label: 'Code hosting',
    keywords: [/github/, /gitlab/, /bitbucket/, /repository/, /commit/]
  },
  {
    id: 'communication',
    tone: 'network',
    icon: '📱',
    label: 'Messaging',
    keywords: [/sms/, /whatsapp/, /discord/, /teams/, /dialpad/, /message/]
  },
  {
    id: 'ai_search',
    tone: 'network',
    icon: '🔍',
    label: 'Search',
    keywords: [/search/, /brave/, /tavily/, /websearch/, /firecrawl/]
  },
  {
    id: 'finance',
    tone: 'planning',
    icon: '💰',
    label: 'Finance',
    keywords: [/stripe/, /quickbooks/, /invoice/, /payment/, /budget/]
  },
  {
    id: 'support',
    tone: 'planning',
    icon: '🎧',
    label: 'Support',
    keywords: [/zendesk/, /servicenow/, /intercom/, /ticket/, /support/]
  },
  {
    id: 'analytics',
    tone: 'planning',
    icon: '📈',
    label: 'Analytics',
    keywords: [/mixpanel/, /posthog/, /analytics/, /insight/, /metric/]
  },
  {
    id: 'search_web',
    tone: 'network',
    icon: '🔎',
    label: 'Web search',
    keywords: [/websearch/, /search_web/, /brave/, /tavily/, /firecrawl/, /news_search/, /image_search/, /video_search/]
  },
  {
    id: 'automation_router',
    tone: 'planning',
    icon: '🧰',
    label: 'Tool router',
    keywords: [/router/, /package_id/]
  },
  {
    id: 'router',
    tone: 'planning',
    icon: '🧰',
    label: 'MCP router',
    keywords: [/mcp__/, /list_tool/, /use_tool/, /get_help/, /get_tool_details/, /health_check/, /authenticate/]
  }
];

const looksLikeRawJson = (value: string): boolean => {
  const trimmed = value.trim();
  return (trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 60;
};

const truncateLabel = (label: string, maxLength = 80): string => {
  if (label.length <= maxLength) {
    return label;
  }
  return `${label.slice(0, maxLength - 1)}…`;
};

// User-friendly labels for common bundled MCP tools
const FRIENDLY_TOOL_LABELS: Record<string, { label: string; getDetail?: (detail: ParsedToolDetail) => string | undefined }> = {
  // File search (@files keyword or agent-initiated)
  file_search: {
    label: 'File Search',
    getDetail: (d) => d.summary ?? undefined
  },
  // File operations
  glob: {
    label: 'Find files',
    getDetail: (d) => d.highlights[0] ? `Pattern: ${d.highlights[0]}` : d.paths[0] ? `In: ${extractBasename(d.paths[0])}` : undefined
  },
  read: { 
    label: 'Read file',
    getDetail: (d) => d.paths[0] ? extractBasename(d.paths[0]) : undefined
  },
  read_file: { 
    label: 'Read file',
    getDetail: (d) => d.paths[0] ? extractBasename(d.paths[0]) : undefined
  },
  write: { 
    label: 'Write file',
    getDetail: (d) => d.paths[0] ? extractBasename(d.paths[0]) : undefined
  },
  write_file: { 
    label: 'Write file',
    getDetail: (d) => d.paths[0] ? extractBasename(d.paths[0]) : undefined
  },
  edit: { 
    label: 'Edit file',
    getDetail: (d) => d.paths[0] ? extractBasename(d.paths[0]) : undefined
  },
  edit_file: { 
    label: 'Edit file',
    getDetail: (d) => d.paths[0] ? extractBasename(d.paths[0]) : undefined
  },
  list: { 
    label: 'List directory',
    getDetail: (d) => d.paths[0] ? extractBasename(d.paths[0]) : undefined
  },
  ls: { 
    label: 'List directory',
    getDetail: (d) => d.paths[0] ? extractBasename(d.paths[0]) : undefined
  },
  // Shell operations - use sanitizeCommandForDisplay to strip env vars and redact secrets
  bash: { 
    label: 'Run command',
    getDetail: (d) => d.command ? sanitizeCommandForDisplay(d.command) : undefined
  },
  shell: { 
    label: 'Run command',
    getDetail: (d) => d.command ? sanitizeCommandForDisplay(d.command) : undefined
  },
  execute: { 
    label: 'Execute command',
    getDetail: (d) => d.command ? sanitizeCommandForDisplay(d.command) : undefined
  },
  // Search operations - show search pattern, or sanitized path as fallback
  grep: { 
    label: 'Search in files',
    getDetail: (d) => d.highlights[0] 
      ? `"${truncateLabel(d.highlights[0], 40)}"` 
      : d.paths[0] 
        ? `in ${extractBasename(d.paths[0])}` 
        : undefined
  },
  find: { 
    label: 'Find files',
    getDetail: (d) => d.highlights[0] 
      ? truncateLabel(d.highlights[0], 40) 
      : d.paths[0] 
        ? extractBasename(d.paths[0]) 
        : undefined
  },
  search: { 
    label: 'Search',
    getDetail: (d) => d.highlights[0] ? `"${truncateLabel(d.highlights[0], 40)}"` : undefined
  },
  // Web/search built-in tools
  websearch: {
    label: 'Web search',
    getDetail: (d) => d.highlights[0] ? `"${truncateLabel(d.highlights[0], 40)}"` : undefined
  },
  web_search: {
    label: 'Web search',
    getDetail: (d) => d.highlights[0] ? `"${truncateLabel(d.highlights[0], 40)}"` : undefined
  },
  webfetch: {
    label: 'Fetch page',
    getDetail: (d) => {
      if (d.url) {
        try {
          const url = new URL(d.url);
          return url.hostname || d.url;
        } catch {
          return d.url;
        }
      }
      return undefined;
    }
  },
  web_fetch: {
    label: 'Fetch page',
    getDetail: (d) => {
      if (d.url) {
        try {
          const url = new URL(d.url);
          return url.hostname || d.url;
        } catch {
          return d.url;
        }
      }
      return undefined;
    }
  },
  searchfiles: {
    label: 'Search files',
    getDetail: (d) => d.highlights[0] ? `"${truncateLabel(d.highlights[0], 40)}"` : d.paths[0] ? `In: ${extractBasename(d.paths[0])}` : undefined
  },
  search_files: {
    label: 'Search files',
    getDetail: (d) => d.highlights[0] ? `"${truncateLabel(d.highlights[0], 40)}"` : d.paths[0] ? `In: ${extractBasename(d.paths[0])}` : undefined
  },
  // Pre-turn context search tools (dispatched by agentTurnExecutor during context assembly)
  tool_search: {
    label: 'Tool Search',
    getDetail: (d) => d.summary ?? undefined
  },
  skill_search: {
    label: 'Skill Search',
    getDetail: (d) => d.summary ?? undefined
  },
  conversation_search: {
    label: 'Conversation Search',
    getDetail: (d) => d.summary ?? undefined
  },
  document_prefetch: {
    label: 'Document Prefetch',
    getDetail: (d) => d.summary ?? undefined
  }
};

function buildCategoryCandidates(toolName: string, detail: ParsedToolDetail): string[] {
  const safeSummary = detail.summary && !looksLikeRawJson(detail.summary) ? detail.summary : null;
  const candidates = [toolName, detail.serverName, detail.innerToolName, detail.packageName, detail.actionName, safeSummary]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  return candidates.length > 0 ? candidates : [toolName.toLowerCase()];
}

const inferCategory = (toolName: string, detail: ParsedToolDetail): CategoryDefinition | null => {
  const normalizedCandidates = buildCategoryCandidates(toolName, detail);
  for (const category of CATEGORY_DEFINITIONS) {
    if (
      normalizedCandidates.some((candidate) =>
        category.keywords.some((keyword) => keyword.test(candidate.replace(/[_-]+/g, ' ')))
      )
    ) {
      return category;
    }
  }
  if (detail.paths.length > 0) {
    return CATEGORY_DEFINITIONS.find((category) => category.id.startsWith('filesystem')) ?? null;
  }
  if (detail.command) {
    return CATEGORY_DEFINITIONS.find((category) => category.id === 'terminal') ?? null;
  }
  if (detail.url) {
    return CATEGORY_DEFINITIONS.find((category) => category.id === 'network') ?? null;
  }
  return null;
};

const deriveIdentifierParts = (toolName: string): { server: string | null; action: string | null } => {
  if (!toolName) {
    return { server: null, action: null };
  }
  const normalized = toolName.replace(/^mcp__/i, '');
  const segments = normalized.split(/__+/).filter(Boolean);
  if (segments.length >= 2) {
    return {
      server: segments[0],
      action: segments[segments.length - 1]
    };
  }
  const fallback = normalized.split(/[:.]/).filter(Boolean);
  return {
    server: fallback.length > 1 ? fallback[0] : null,
    action: fallback.length > 0 ? fallback[fallback.length - 1] : null
  };
};

const buildStoryLabel = (
  toolName: string,
  detail: ParsedToolDetail,
  fallbackLabel?: string,
  fallbackDetail?: string
): { label: string; detail?: string } => {
  // Check for friendly tool labels FIRST (before complex parsing)
  const normalizedToolName = toolName.toLowerCase().replace(/^mcp__|_tool$/g, '');
  const friendlyTool = FRIENDLY_TOOL_LABELS[normalizedToolName];
  if (friendlyTool) {
    const friendlyDetail = friendlyTool.getDetail?.(detail);
    // Return label and detail separately - callers decide how to combine them
    return { label: friendlyTool.label, detail: friendlyDetail };
  }

  const identifierParts = deriveIdentifierParts(toolName);
  const packageLabel = detail.packageName ? toTitleCase(detail.packageName) : null;
  const serverLabel = detail.serverName
    ? toTitleCase(detail.serverName)
    : packageLabel
      ? packageLabel
      : identifierParts.server
        ? toTitleCase(identifierParts.server)
        : null;
  const rawActionName = detail.actionName
    ? toTitleCase(detail.actionName)
    : identifierParts.action
      ? toTitleCase(identifierParts.action)
      : null;
  const innerToolLabel = detail.innerToolName ? toTitleCase(detail.innerToolName) : null;
  const isSuperMcp = /^mcp__/i.test(toolName);
  const normalizedAction = (rawActionName ?? innerToolLabel ?? '').toLowerCase();
  const GENERIC_ROUTER_ACTIONS = new Set(['use tool', 'use_tool', 'call tool', 'call_tool']);
  const _DISCOVERY_ACTIONS = /list[_ ]?(tools|packages)|search[_ ]?tools|discover/.test(normalizedAction);
  const actionLabel = GENERIC_ROUTER_ACTIONS.has(normalizedAction)
    ? innerToolLabel ?? rawActionName
    : rawActionName;
  const isDiscoveryAction = /list[_ ]?tools?[_ ]?packages?|list[_ ]?(tools|packages)|search[_ ]?tools|discover/.test(normalizedAction) || /list_tools?_?packages?|search_tools|list_packages|discover/.test(toolName.toLowerCase());

  let label: string;
  if (isSuperMcp) {
    if (isDiscoveryAction) {
      // For discovery actions, use the router name from tool name parsing, not payload-extracted names
      // (payload contains the list being discovered, which would incorrectly label the chip)
      const routerLabel = identifierParts.server ? toTitleCase(identifierParts.server) : 'MCP Router';
      label = `${routerLabel} • ${actionLabel ?? 'Discover'}`;
    } else if (serverLabel && actionLabel) {
      label = `${serverLabel} • ${actionLabel}`;
    } else if (!serverLabel && actionLabel) {
      label = actionLabel;
    } else if (serverLabel && innerToolLabel) {
      label = `${serverLabel} • ${innerToolLabel}`;
    } else if (innerToolLabel) {
      label = innerToolLabel;
    } else if (serverLabel) {
      label = `${serverLabel} • Tool call`;
    } else {
      label = toTitleCase(toolName);
    }
  } else if (serverLabel && actionLabel) {
    label = `${serverLabel} • ${actionLabel}`;
  } else if (serverLabel) {
    label = `${serverLabel} • Tool call`;
  } else if (actionLabel) {
    label = actionLabel;
  } else if (fallbackLabel) {
    label = fallbackLabel.split('\n')[0];
  } else {
    label = toTitleCase(toolName);
  }

  const highlight = detail.highlights.find((entry) => typeof entry === 'string' && entry.trim());
  const preferPath = detail.paths.length > 0 ? extractBasename(detail.paths[0]) : null;

  let detailLine: string | undefined;
  if (isDiscoveryAction) {
    // Discovery actions (list_tools, etc.) return a tool catalog as their result —
    // not useful as display text. The label already identifies the server + action.
    detailLine = undefined;
  } else if (detail.summary && !looksLikeRawJson(detail.summary)) {
    detailLine = detail.summary;
  } else if (detail.status) {
    detailLine = detail.status;
  } else if (highlight) {
    detailLine = highlight;
  } else if (isSuperMcp) {
    if (serverLabel && (actionLabel || innerToolLabel)) {
      const actionDescriptor = actionLabel ?? innerToolLabel ?? 'tool';
      detailLine = `via ${serverLabel} (${actionDescriptor})`;
    } else if (innerToolLabel) {
      detailLine = `via router (${innerToolLabel})`;
    } else if (actionLabel) {
      detailLine = `${actionLabel} via router`;
    }
  } else if (preferPath) {
    detailLine = `File: ${preferPath}`;
  } else if (detail.command) {
    detailLine = detail.command;
  } else if (detail.url) {
    try {
      const parsedUrl = new URL(detail.url);
      detailLine = parsedUrl.hostname || parsedUrl.href;
    } catch {
      detailLine = detail.url;
    }
  } else if (fallbackDetail) {
    detailLine = fallbackDetail;
  }

  return { label, detail: detailLine };
};

const formatLabelForTone = (
  tone: ToolChipTone,
  detail: ParsedToolDetail,
  toolName: string,
  fallbackLabel?: string,
  category?: CategoryDefinition | null
): string => {
  if (category) {
    if (category.id.startsWith('filesystem')) {
      if (detail.paths.length > 0) {
        return `${category.label}: ${extractBasename(detail.paths[0])}`;
      }
      if (detail.summary) {
        return detail.summary.split('\n')[0];
      }
      return category.label;
    }
    if (category.id === 'terminal' && detail.command) {
      return detail.command;
    }
    if (category.id === 'network' && detail.url) {
      try {
        const url = new URL(detail.url);
        return `${category.label}: ${url.hostname || url.href}`;
      } catch {
        return `${category.label}: ${detail.url}`;
      }
    }
    if (category.id === 'email' && detail.serverName) {
      return `${toTitleCase(detail.serverName)} email`;
    }
    if (category.id === 'slack' && detail.serverName) {
      return `${toTitleCase(detail.serverName)} messaging`;
    }
    return category.label;
  }
  if (tone === 'files') {
    if (detail.paths.length > 0) {
      return extractBasename(detail.paths[0]) || 'File access';
    }
    return 'File access';
  }
  if (tone === 'shell') {
    if (detail.command) {
      return detail.command.trim();
    }
    return 'Shell command';
  }
  if (tone === 'network') {
    if (detail.url) {
      try {
        const url = new URL(detail.url);
        return url.hostname || url.href;
      } catch {
        return detail.url;
      }
    }
    if (detail.serverName) {
      return `${toTitleCase(detail.serverName)} connection`;
    }
    return 'Network call';
  }
  if (tone === 'planning') {
    if (detail.summary) {
      return detail.summary.split('\n')[0];
    }
    if (fallbackLabel) {
      return fallbackLabel;
    }
  }
  return toTitleCase(toolName);
};

type SummarizeOptions = {
  sourceToolName?: string;
  sourceDetail?: string;
  fallbackLabel?: string;
  fileSummary?: string;
  fallbackDetail?: string;
};

export const summarizeToolEvent = (event: ToolAgentEvent, options?: SummarizeOptions): StepToolSummary => {
  const toolName = options?.sourceToolName ?? event.toolName ?? 'tool';
  const sourceDetail = parseToolDetail(options?.sourceDetail ?? event.detail);
  const runtimeDetail = event.stage === 'end' ? parseToolDetail(event.detail) : sourceDetail;
  const detail = mergeParsedDetails(sourceDetail, runtimeDetail);
  const category = inferCategory(toolName, detail);
  const tone = category?.tone ?? chooseTone(toolName, detail);
  const story = buildStoryLabel(toolName, detail, options?.fallbackLabel, options?.fallbackDetail ?? options?.fileSummary);
  const toneLabel = formatLabelForTone(
    tone,
    detail,
    toolName,
    options?.fallbackLabel ?? options?.fileSummary,
    category
  );
  const resolvedLabel = truncateLabel(story.label || toneLabel);
  const resolvedDetail = story.detail ?? (toneLabel !== story.label ? toneLabel : undefined) ?? options?.fileSummary;
  const icon = category?.icon ?? TOOL_ICONS[tone];
  const status = deriveChipStatus(event, detail, runtimeDetail);
  const emphasis: ToolChipEmphasis = isRouterCategory(category) ? 'subtle' : 'primary';

  const resultPayload = extractOperatorResultPayload(event, toolName);
  const summary: StepToolSummary = {
    label: resolvedLabel,
    detail: resolvedDetail,
    icon,
    tone,
    count: 1,
    status,
    emphasis,
    parentToolUseId: event.parentToolUseId ?? null,
    toolName,
    toolUseId: event.toolUseId,
    fullPath: detail.paths[0] ?? undefined,
    fullCommand: detail.command ?? undefined,
    fullUrl: detail.url ?? undefined
  };

  if (resultPayload !== undefined) {
    summary.resultPayload = resultPayload;
  }

  // Include image content from tool results (only for 'end' stage events)
  if (event.stage === 'end' && event.imageContent && event.imageContent.length > 0) {
    summary.imageContent = event.imageContent;
  }

  // Include image refs from tool results (only for 'end' stage events). Stage 4
  // emits these alongside `imageContent`; Stage 5 strips the corresponding inline
  // bytes once a ref is in place. Carrying both forward is intentional — the
  // renderer prefers refs and falls back to bytes per-slot.
  if (event.stage === 'end' && event.imageRef && event.imageRef.length > 0) {
    summary.imageRef = event.imageRef;
  }

  if (event.stage === 'end' && event.contentRef && event.contentRef.length > 0) {
    summary.contentRef = event.contentRef;
  }

  // Include MCP Apps UI metadata (only for 'end' stage events)
  if (event.stage === 'end' && event.mcpAppUiMeta) {
    summary.mcpAppUiMeta = event.mcpAppUiMeta;
    if (event.toolResult) {
      summary.toolResult = event.toolResult;
    }
  }

  return summary;
};

// =============================================================================
// Tool Approval Summary (lightweight version for approval card)
// =============================================================================

export type ToolApprovalSummary = {
  label: string;
  detail?: string;
  icon: string;
  tone: ToolChipTone;
  /** Full untruncated file path for tooltip display (sanitized: ~ replaces home dir) */
  fullPath?: string;
};

/**
 * Sanitize a file path for display by replacing home directory with ~.
 * Handles Unix (macOS/Linux) and Windows paths with various formats.
 */
const sanitizePathForDisplay = (path: string): string => {
  if (!path) return path;
  // Common home directory patterns (order matters - more specific first)
  const homePatterns = [
    /^\/Users\/[^/]+/,            // macOS: /Users/username
    /^\/home\/[^/]+/,             // Linux: /home/username
    /^\\\\\?\\[A-Z]:\\Users\\[^\\]+/i,  // Windows: \\?\C:\Users\username (extended path)
    /^[A-Z]:[/\\]Users[/\\][^/\\]+/i,   // Windows: C:\Users\username or C:/Users/username (any drive)
  ];
  for (const pattern of homePatterns) {
    if (pattern.test(path)) {
      return path.replace(pattern, '~');
    }
  }
  return path;
};

/**
 * Truncate a path to show the last N segments for readability.
 * Returns ".../<last-n-segments>" for long paths.
 */
const truncatePathForDisplay = (path: string, maxSegments = 3): string => {
  if (!path) return path;
  // Handle both Unix and Windows separators
  const separator = path.includes('\\') ? '\\' : '/';
  const segments = path.split(separator).filter(Boolean);
  if (segments.length <= maxSegments) {
    return path;
  }
  const lastSegments = segments.slice(-maxSegments);
  return `...${separator}${lastSegments.join(separator)}`;
};

/**
 * Summarize a tool call for the approval card.
 * Lighter-weight version of summarizeToolEvent that works with raw input object
 * instead of requiring a full AgentEvent.
 */
export const summarizeToolForApproval = (
  toolName: string,
  input: Record<string, unknown>
): ToolApprovalSummary => {
  const detail = parseToolDetail(JSON.stringify(input));
  const category = inferCategory(toolName, detail);
  const tone = category?.tone ?? chooseTone(toolName, detail);
  const story = buildStoryLabel(toolName, detail);
  const icon = category?.icon ?? TOOL_ICONS[tone];

  // Extract and sanitize file path for display
  const rawPath = detail.paths[0];
  const sanitizedPath = rawPath ? sanitizePathForDisplay(rawPath) : undefined;
  
  // For file operations, show truncated path as detail (more context than basename)
  let displayDetail = story.detail;
  if (sanitizedPath && (tone === 'files' || detail.paths.length > 0)) {
    displayDetail = truncatePathForDisplay(sanitizedPath, 3);
    // If multiple files, indicate count
    if (detail.paths.length > 1) {
      displayDetail = `${displayDetail} (+${detail.paths.length - 1} more)`;
    }
  }

  return {
    label: truncateLabel(story.label),
    detail: displayDetail,
    icon,
    tone,
    fullPath: sanitizedPath,
  };
};
