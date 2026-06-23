import {
  type ToolLabel,
  FRIENDLY_TOOL_LABELS,
  PATH_KEYS,
  COMMAND_KEYS,
  TOOL_NAME_KEYS,
  SERVER_NAME_KEYS,
  truncateForDisplay,
  normalizeToolName,
  toTitleCase,
  sanitizeCommandForDisplay,
  extractBasename,
} from '@rebel/shared';
import { safeParseDetail } from '@rebel/shared/utils/safeParseDetail';

export type { ToolLabel };
export { sanitizeCommandForDisplay, extractBasename };

// ---------------------------------------------------------------------------
// Cloud-client-specific internal helpers
// ---------------------------------------------------------------------------

type ParsedToolDetail = {
  paths: string[];
  commands: string[];
  toolNames: string[];
  serverNames: string[];
};

/** Key Sets built from shared arrays for efficient lookup in collectValuesByKeys. */
const PATH_KEY_SET = new Set<string>(PATH_KEYS);
const COMMAND_KEY_SET = new Set<string>(COMMAND_KEYS);
const TOOL_NAME_KEY_SET = new Set<string>(TOOL_NAME_KEYS);
const SERVER_NAME_KEY_SET = new Set<string>([...SERVER_NAME_KEYS, 'server']);

const collectStringValuesFromUnknown = (value: unknown, collector: Set<string>) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) collector.add(trimmed);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectStringValuesFromUnknown(item, collector));
  }
};

const collectValuesByKeys = (value: unknown, keys: Set<string>, collector: Set<string>): void => {
  if (!value) return;

  if (Array.isArray(value)) {
    value.forEach((item) => collectValuesByKeys(item, keys, collector));
    return;
  }

  if (typeof value !== 'object') return;

  Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
    const normalizedKey = key.toLowerCase();
    if (keys.has(normalizedKey)) {
      collectStringValuesFromUnknown(child, collector);
    }
    collectValuesByKeys(child, keys, collector);
  });
};

const parseToolDetail = (detail?: string): ParsedToolDetail => {
  if (!detail || !detail.trim()) {
    return { paths: [], commands: [], toolNames: [], serverNames: [] };
  }

  const empty = { paths: [], commands: [], toolNames: [], serverNames: [] };

  // BOUNDED via safeParseDetail (both layers): a malformed OR over-budget detail
  // (or over-budget inner string for the double-encoded case) yields the empty
  // fallback — identical for ≤budget input.
  const outer = safeParseDetail(detail);
  if (!outer.ok) return empty;

  let parsedValue: unknown = outer.value;
  if (typeof parsedValue === 'string') {
    const inner = safeParseDetail(parsedValue);
    if (!inner.ok) return empty;
    parsedValue = inner.value;
  }

  const paths = new Set<string>();
  const commands = new Set<string>();
  const toolNames = new Set<string>();
  const serverNames = new Set<string>();

  collectValuesByKeys(parsedValue, PATH_KEY_SET, paths);
  collectValuesByKeys(parsedValue, COMMAND_KEY_SET, commands);
  collectValuesByKeys(parsedValue, TOOL_NAME_KEY_SET, toolNames);
  collectValuesByKeys(parsedValue, SERVER_NAME_KEY_SET, serverNames);

  return {
    paths: Array.from(paths),
    commands: Array.from(commands),
    toolNames: Array.from(toolNames),
    serverNames: Array.from(serverNames),
  };
};

const deriveIdentifierParts = (value: string): { server?: string; action?: string } => {
  const normalized = value.replace(/^mcp__/i, '').trim();
  const segments = normalized.split(/__+/).filter(Boolean);
  if (segments.length >= 2) {
    return { server: segments[0], action: segments[segments.length - 1] };
  }

  const fallback = normalized.split(/[:.]/).filter(Boolean);
  if (fallback.length >= 2) {
    return { server: fallback[0], action: fallback[fallback.length - 1] };
  }

  const action = fallback[0] ?? normalized;
  return { action: action || undefined };
};

const buildMcpRouterLabel = (toolName: string, detail: ParsedToolDetail): string | null => {
  const normalizedToolName = normalizeToolName(toolName);
  if (!normalizedToolName.startsWith('mcp__')) return null;

  const actionFromToolName = normalizedToolName.endsWith('__list_tools')
    ? 'list_tools'
    : normalizedToolName.endsWith('__use_tool')
      ? 'use_tool'
      : null;

  if (!actionFromToolName) return null;

  const toolIdentifier = detail.toolNames[0];
  const identifierParts = toolIdentifier ? deriveIdentifierParts(toolIdentifier) : {};

  const server = identifierParts.server ?? detail.serverNames[0];
  const action = identifierParts.action ?? actionFromToolName;

  const serverLabel = server ? toTitleCase(server) : 'MCP Router';
  const actionLabel = action ? toTitleCase(action) : 'Tool Call';
  return `${serverLabel} • ${actionLabel}`;
};

export const buildToolLabel = (toolName: string, detail?: string): ToolLabel => {
  const safeToolName = toolName?.trim() || 'tool';
  const parsedDetail = parseToolDetail(detail);

  const normalizedToolName = normalizeToolName(safeToolName);
  const mcpRouterLabel = buildMcpRouterLabel(safeToolName, parsedDetail);
  const label = mcpRouterLabel ?? FRIENDLY_TOOL_LABELS[normalizedToolName] ?? toTitleCase(safeToolName);

  const shortDetailSource = parsedDetail.commands[0]
    ? sanitizeCommandForDisplay(parsedDetail.commands[0])
    : parsedDetail.paths[0]
      ? extractBasename(parsedDetail.paths[0])
      : undefined;

  const shortDetail = shortDetailSource ? truncateForDisplay(shortDetailSource) : undefined;
  return {
    label,
    shortDetail,
  };
};
