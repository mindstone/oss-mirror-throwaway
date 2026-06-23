/**
 * Shared tool label primitives for display across platforms.
 *
 * Canonical source of truth for:
 * - Tool name normalisation and formatting
 * - Command sanitisation for safe UI display
 * - File path basename extraction
 * - Friendly tool label mapping
 * - Tool-detail JSON key constants
 *
 * Consumers: cloud-client (buildToolLabel), renderer (summarizeToolEvent/summarizeToolForApproval)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolLabel {
  label: string;
  shortDetail?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_SHORT_DETAIL_LENGTH = 60;

/** JSON keys that typically hold file / directory paths. */
export const PATH_KEYS = [
  'path',
  'paths',
  'file',
  'files',
  'file_path',
  'filepath',
  'source',
  'destination',
  'old_path',
  'new_path',
  'target_file',
] as const;

/** JSON keys that typically hold shell commands. */
export const COMMAND_KEYS = ['command', 'cmd'] as const;

/** JSON keys that typically hold tool names (e.g. inside MCP router payloads). */
export const TOOL_NAME_KEYS = ['tool_name', 'toolname', 'target_tool_name', 'targettoolname'] as const;

/** JSON keys that typically hold MCP server names. */
export const SERVER_NAME_KEYS = ['server_name', 'servername', 'server'] as const;

/**
 * Simple string map of normalised tool name → human-friendly label.
 *
 * This is the *base* set. The renderer extends this with richer per-tool
 * detail extractors (`getDetail` callbacks) that are renderer-specific.
 */
export const FRIENDLY_TOOL_LABELS: Record<string, string> = {
  read: 'Read file',
  read_file: 'Read file',
  write: 'Write file',
  write_file: 'Write file',
  str_replace_editor: 'Write file',
  bash: 'Run command',
  grep: 'Search',
  glob: 'Find files',
  ls: 'List directory',
  list_files: 'List directory',
  websearch: 'Web search',
  web_search: 'Web search',
  webfetch: 'Fetch page',
  web_fetch: 'Fetch page',
  searchfiles: 'Search files',
  search_files: 'Search files',
  todowrite: 'Update todos',
  todo_write: 'Update todos',
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a string for display, appending `...` if it exceeds `maxLength`.
 */
export const truncateForDisplay = (value: string, maxLength = MAX_SHORT_DETAIL_LENGTH): string => {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 3))}...`;
};

/**
 * Normalise a tool name to lowercase snake_case.
 * Converts camelCase → snake_case, trims, and lowercases.
 */
export const normalizeToolName = (toolName: string): string =>
  toolName
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase();

/**
 * Convert a raw tool / server / action name to Title Case for display.
 * Strips `mcp__` prefix, splits on camelCase / underscores / hyphens.
 */
export const toTitleCase = (value: string): string => {
  if (!value) return 'Tool';
  return value
    .replace(/^mcp__/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

/**
 * Extract the basename (final path segment) from a file path.
 * Handles both Unix and Windows separators.
 * Pure string implementation — no external dependencies.
 */
export const extractBasename = (pathValue: string): string => {
  if (!pathValue) return '';
  const normalized = pathValue.trim().replace(/[\\/]+$/, '');
  if (!normalized) return '';

  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
};

/**
 * Sanitize a shell command for safe display in UI.
 * Strips env vars, redacts secrets in args, normalizes paths, truncates.
 *
 * Security note: This is defense-in-depth for display purposes.
 * Regex-based sanitization cannot catch all cases, but handles common patterns.
 */
export const sanitizeCommandForDisplay = (command: string, maxLength = MAX_SHORT_DETAIL_LENGTH): string => {
  if (!command || !command.trim()) return '';

  // Limit input length to prevent ReDoS on very long strings
  let sanitized = command.trim().slice(0, 2000);

  // 1. Strip leading env var assignments (VAR=value VAR2="value" ...)
  // These often contain secrets and the var names can leak vendor info
  sanitized = sanitized.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s*)+/gi, '');

  // 2. Redact common secret-bearing CLI flag patterns
  // Flags containing: token, key, password, secret, auth, credential, bearer
  sanitized = sanitized.replace(
    /(-{1,2}[\w-]*(?:token|key|password|secret|auth|credential|bearer)[\w-]*)([=\s]+)(?:"[^"]*"|'[^']*'|\S+)/gi,
    '$1$2***',
  );

  // -H / --header with auth headers (redact entire header value)
  sanitized = sanitized.replace(
    /((?:-H|--header)\s*)["']?(?:Authorization|X-API-Key|X-Auth-Token|X-Secret):[^"'\s]*/gi,
    '$1"***"',
  );

  // -u / --user for basic auth (user:password)
  sanitized = sanitized.replace(/((?:-u|--user)\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1***');

  // -e / --env for docker/container secrets (keep var name, redact value)
  sanitized = sanitized.replace(
    /((?:-e|--env)\s*)([A-Z_][A-Z0-9_]*=)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
    '$1$2***',
  );

  // 3. Redact known API key formats inline
  // NOTE: Keep in sync with src/shared/utils/sentryRedaction.ts patterns
  sanitized = sanitized
    // Anthropic
    .replace(/sk-ant-[a-zA-Z0-9_-]+/g, 'sk-ant-***')
    // OpenAI
    .replace(/\bsk-[a-zA-Z0-9_-]{20,}\b/g, 'sk-***')
    // Groq
    .replace(/gsk_[a-zA-Z0-9]+/g, 'gsk_***')
    // Google
    .replace(/AIza[a-zA-Z0-9_-]{35}/g, 'AIza***')
    // ElevenLabs
    .replace(/xi-[a-zA-Z0-9_-]{20,}/gi, 'xi-***')
    // AWS Access Key ID
    .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA***')
    // GitHub tokens (ghp_, gho_, ghs_, ghr_)
    .replace(/gh[pors]_[a-zA-Z0-9]{36,}/g, 'gh*_***')
    // Slack tokens
    .replace(/xox[bpras]-[a-zA-Z0-9-]+/g, 'xox*-***');

  // 4. Redact URL credentials (https://user:pass@host)
  sanitized = sanitized.replace(/:\/\/([^:@\s]+):([^@\s]+)@/g, '://$1:***@');

  // 5. Normalize home directory paths
  sanitized = sanitized
    .replace(/\/Users\/[^/\s"']+/g, '~')
    .replace(/\/home\/[^/\s"']+/g, '~')
    .replace(/[A-Z]:\\Users\\[^\\"'\s]+/gi, '~');

  // 6. Shorten long absolute paths to last 2 segments
  sanitized = sanitized.replace(/(["']?)(?:~|\/[^\s"']+)\/([^/\s"']+\/[^/\s"']+)(["']?)/g, '$1.../$2$3');

  // 7. Normalize whitespace
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  // 8. Truncate to max length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength - 1) + '…';
  }

  return sanitized.trim();
};
