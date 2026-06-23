import { basename } from 'pathe';
import type { AgentEvent } from '@shared/types';
import { extractPathsFromMalformedJson as sharedExtractPathsFromMalformedJson } from '@shared/utils/pathExtraction';
import { safeParseDetail, safeParseDetailRecord } from '@shared/utils/safeParseDetail';

export interface FileOperation {
  toolName: string;
  operation: string; // 'read', 'write', 'edit', 'create', 'move', 'list'
  filePath: string | null;
  timestamp: number;
  stage: 'start' | 'end';
  isError?: boolean;
  detail?: string;
  lineStart?: number | null;
  lineEnd?: number | null;
  summary?: string | null;
  stepNumber?: number;
}

type ParsedDetail = {
  paths: string[];
  lineStart: number | null;
  lineEnd: number | null;
  summary: string | null;
};

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

const SUMMARY_KEYS = ['summary', 'result', 'status', 'message', 'output', 'response'];

const isLikelyFilePath = (value: string): boolean => {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed.includes('/') || trimmed.includes('\\') || /\.[\w-]{2,}$/u.test(trimmed);
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
};

const collectPathsFromValue = (value: unknown, collector: Set<string>): void => {
  if (!value) return;
  if (typeof value === 'string') {
    if (isLikelyFilePath(value)) {
      collector.add(value.trim());
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectPathsFromValue(entry, collector));
    return;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of PATH_KEYS) {
      if (record[key] !== undefined) {
        collectPathsFromValue(record[key], collector);
      }
    }
    if (Array.isArray(record.operations)) {
      record.operations.forEach((operation) => collectPathsFromValue(operation, collector));
    }
  }
};

const extractLineInfo = (value: unknown): { lineStart: number | null; lineEnd: number | null } => {
  if (!value || typeof value !== 'object') {
    return { lineStart: null, lineEnd: null };
  }
  const record = value as Record<string, unknown>;
  const candidatesStart = [
    record.start_line,
    record.line_start,
    record.startLine,
    record.lineStart,
    record.line,
    record.lineNumber,
    record.range && typeof record.range === 'object' ? (record.range as Record<string, unknown>).start : undefined,
    record.selection && typeof record.selection === 'object'
      ? (record.selection as Record<string, unknown>).from
      : undefined
  ];
  const candidatesEnd = [
    record.end_line,
    record.line_end,
    record.endLine,
    record.lineEnd,
    record.range && typeof record.range === 'object' ? (record.range as Record<string, unknown>).end : undefined,
    record.selection && typeof record.selection === 'object'
      ? (record.selection as Record<string, unknown>).to
      : undefined
  ];

  let lineStart: number | null = null;
  let lineEnd: number | null = null;

  for (const candidate of candidatesStart) {
    const numeric = typeof candidate === 'object' && candidate !== null ? toNumber((candidate as Record<string, unknown>).line) : toNumber(candidate);
    if (numeric !== null) {
      lineStart = numeric;
      break;
    }
  }

  for (const candidate of candidatesEnd) {
    const numeric = typeof candidate === 'object' && candidate !== null ? toNumber((candidate as Record<string, unknown>).line) : toNumber(candidate);
    if (numeric !== null) {
      lineEnd = numeric;
      break;
    }
  }

  if (lineStart !== null && lineEnd === null) {
    lineEnd = lineStart;
  }

  return { lineStart, lineEnd };
};

const extractSummaryFromObject = (value: Record<string, unknown>): string | null => {
  for (const key of SUMMARY_KEYS) {
    if (typeof value[key] === 'string') {
      const trimmed = (value[key] as string).trim();
      if (trimmed.length > 0) {
        return trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed;
      }
    }
  }
  return null;
};

/**
 * Renderer-specific adapter: extracts file paths from truncated JSON using
 * the shared regex fallback, then filters to likely file paths only.
 */
const extractPathsFromMalformedJson = (detail: string): string[] => {
  const recovered = sharedExtractPathsFromMalformedJson(detail);
  return Object.values(recovered).filter(isLikelyFilePath);
};

const tryParseDetail = (detail: string): ParsedDetail => {
  if (!detail || !detail.trim()) {
    return { paths: [], lineStart: null, lineEnd: null, summary: null };
  }

  const trimmed = detail.trim();
  const result = safeParseDetail(trimmed);
  if (result.ok) {
    const parsed = result.value;
    const pathCollector = new Set<string>();
    collectPathsFromValue(parsed, pathCollector);
    const { lineStart, lineEnd } = extractLineInfo(parsed);
    const summary = typeof parsed === 'object' && parsed !== null ? extractSummaryFromObject(parsed as Record<string, unknown>) : null;
    return {
      paths: Array.from(pathCollector),
      lineStart,
      lineEnd,
      summary
    };
  } else {
    // Parse declined (malformed, or too-large to parse safely) — detail may be
    // truncated by sanitization. Try regex extraction for path key-value pairs
    // before falling through to text parsing.
    const recovered = extractPathsFromMalformedJson(trimmed);
    if (recovered.length > 0) {
      return { paths: recovered, lineStart: null, lineEnd: null, summary: null };
    }
  }

  const fallbackPath = extractFilePathFromText(trimmed);
  return {
    paths: fallbackPath ? [fallbackPath] : [],
    lineStart: null,
    lineEnd: null,
    summary: trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed
  };
};

/**
 * Extract file operation type from tool name (built-in or MCP)
 */
const getOperationType = (toolName: string): string | null => {
  // Built-in tools (case-sensitive exact matches)
  if (toolName === 'Read') return 'read';
  if (toolName === 'Edit' || toolName === 'MultiEdit') return 'edit';
  if (toolName === 'Create') return 'create';
  if (toolName === 'Write') return 'write';
  if (toolName === 'Grep' || toolName === 'Glob') return 'search';
  if (toolName === 'LS') return 'list';
  
  // Anthropic computer use / legacy tool format
  if (toolName === 'str_replace_editor') return 'edit';
  
  // MCP filesystem operations (case-insensitive)
  const normalized = toolName.toLowerCase();
  if (normalized.includes('read')) return 'read';
  if (normalized.includes('write')) return 'write';
  if (normalized.includes('edit')) return 'edit';
  if (normalized.includes('create')) return 'create';
  if (normalized.includes('move') || normalized.includes('rename')) return 'move';
  if (normalized.includes('delete') || normalized.includes('remove')) return 'delete';
  if (normalized.includes('list') || normalized.includes('directory_tree')) return 'list';
  if (normalized.includes('search')) return 'search';
  
  return null;
};

/**
 * Extract file path from tool input/output detail text
 * Handles both JSON (start events) and raw text (end events)
 */
function extractFilePathFromText(detail: string): string | null {
  if (!detail || !detail.trim()) return null;
  
  const result = safeParseDetailRecord(detail);
  if (result.ok) {
    // Parsed as a JSON object (start events)
    const parsed = result.value;

    // Common parameter names for file paths
    const pathKeys = ['path', 'file_path', 'filepath', 'source', 'destination', 'old_path', 'new_path'];

    for (const key of pathKeys) {
      if (parsed[key] && typeof parsed[key] === 'string') {
        return parsed[key] as string;
      }
    }

    // For read_multiple_files, get first file
    if (Array.isArray(parsed.paths) && parsed.paths.length > 0) {
      return parsed.paths[0] as string;
    }
  } else {
    // Not JSON (or too large to parse safely), might be text result - try to
    // extract file path from text. Look for common patterns like:
    // "Read file: /path/to/file" or "path/to/file.ext"
    const filePathRegex = /(?:^|\s)([./~]?[\w\-./]+\.\w{2,6})(?:\s|$)/u;
    const match = detail.match(filePathRegex);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

const isFilesystemToolName = (toolName: string): boolean => {
  const lower = toolName.toLowerCase();
  return (
    toolName === 'Read' ||
    toolName === 'Edit' ||
    toolName === 'Create' ||
    toolName === 'Write' ||
    toolName === 'Grep' ||
    toolName === 'Glob' ||
    toolName === 'LS' ||
    toolName === 'MultiEdit' ||
    toolName === 'str_replace_editor' ||
    lower.includes('filesystem') ||
    lower === 'read_file' ||
    lower === 'write_file' ||
    lower === 'edit_file' ||
    lower === 'create_file' ||
    lower === 'read_multiple_files' ||
    lower === 'move_file' ||
    lower === 'create_directory' ||
    lower === 'list_directory' ||
    lower === 'directory_tree' ||
    lower === 'search_files' ||
    lower === 'get_file_info' ||
    lower === 'list_allowed_directories'
  );
};

type ResolvedWrapper = {
  innerToolName: string;
  operationType: string;
  paths: string[];
};

/**
 * Try to resolve an MCP router `use_tool` wrapper into an inner filesystem operation.
 * The super-mcp router wraps tool calls as:
 *   { package_id: "filesystem", tool_id: "write_file", args: { path: "...", content: "..." } }
 * Returns null if the event isn't a use_tool wrapper or the inner tool isn't filesystem-related.
 */
const tryResolveUseToolWrapper = (
  toolName: string,
  detail: string
): ResolvedWrapper | null => {
  if (!toolName.endsWith('use_tool') || !detail) return null;

  const result = safeParseDetailRecord(detail);
  if (!result.ok) return null;
  const parsed = result.value;
  const packageId = parsed.package_id;
  const toolId = parsed.tool_id;
  if (!packageId || !toolId) return null;

  const innerToolName = `${packageId as string}/${toolId as string}`;
  const operationType = getOperationType(innerToolName) ?? getOperationType(toolId as string);
  if (!operationType) return null;

  const args = parsed.args;
  if (!args || typeof args !== 'object') return { innerToolName, operationType, paths: [] };

  const pathCollector = new Set<string>();
  collectPathsFromValue(args, pathCollector);
  return { innerToolName, operationType, paths: Array.from(pathCollector) };
};

/**
 * Extract file operations from agent events.
 * Filters for file-related tool calls and extracts relevant metadata.
 *
 * End events often lack the file path in their result detail (the runtime may
 * return just "success"). We propagate the path from the matching start
 * event via toolUseId so that categorizeFileActivity can count confirmed
 * writes (which require stage === 'end' + a valid filePath).
 *
 * MCP router `use_tool` wrappers are resolved to their inner filesystem tool.
 * Start events arrive as `mcp__super-mcp-router__use_tool` while end events
 * get resolved to the effective name (e.g. `filesystem/write_file`) by the
 * main process aggregator. We bridge both sides via the resolvedWrappers map.
 */
export const extractFileOperations = (events: AgentEvent[]): FileOperation[] => {
  const operations: FileOperation[] = [];
  const startPathsByToolUseId = new Map<string, string>();
  const resolvedWrappers = new Map<string, ResolvedWrapper>();

  // First pass: collect file paths from start events by toolUseId
  for (const event of events) {
    if (event.type !== 'tool' || event.stage !== 'start' || !event.toolUseId) continue;

    if (isFilesystemToolName(event.toolName)) {
      const parsed = tryParseDetail(event.detail);
      const path = parsed.paths[0] ?? extractFilePathFromText(event.detail);
      if (path) {
        startPathsByToolUseId.set(event.toolUseId, path);
      }
      continue;
    }

    // MCP router use_tool wrappers: extract inner filesystem tool info and paths from args.
    // Start events keep the router name (mcp__…__use_tool) while end events get resolved
    // to the inner name (e.g. filesystem/write_file). We need to collect the path here
    // so the end event can inherit it.
    const wrapper = tryResolveUseToolWrapper(event.toolName, event.detail);
    if (wrapper) {
      resolvedWrappers.set(event.toolUseId, wrapper);
      if (wrapper.paths.length > 0) {
        startPathsByToolUseId.set(event.toolUseId, wrapper.paths[0]);
      }
    }
  }

  // Second pass: build operations, inheriting paths for end events
  for (const event of events) {
    if (event.type !== 'tool') continue;

    let effectiveToolName = event.toolName;
    let operationType: string | null = null;

    if (isFilesystemToolName(event.toolName)) {
      operationType = getOperationType(event.toolName);
    } else if (event.toolUseId && resolvedWrappers.has(event.toolUseId)) {
      const wrapper = resolvedWrappers.get(event.toolUseId);
      if (!wrapper) continue;
      effectiveToolName = wrapper.innerToolName;
      operationType = wrapper.operationType;
    } else {
      continue;
    }

    if (!operationType) continue;

    const parsedDetail = tryParseDetail(event.detail);
    let targetPaths: (string | null)[] = parsedDetail.paths;
    if (targetPaths.length === 0) {
      const fallback = extractFilePathFromText(event.detail);
      if (fallback) {
        targetPaths = [fallback];
      }
    }

    // For end events (or use_tool wrapper start events where the path is nested in args),
    // inherit from the path collected in the first pass.
    if (targetPaths.length === 0 && event.toolUseId) {
      const startPath = startPathsByToolUseId.get(event.toolUseId);
      if (startPath) {
        targetPaths = [startPath];
      }
    }

    if (targetPaths.length === 0) {
      targetPaths = [null];
    }

    for (const path of targetPaths) {
      operations.push({
        toolName: effectiveToolName,
        operation: operationType,
        filePath: path,
        timestamp: event.timestamp,
        stage: event.stage,
        isError: event.isError,
        detail: event.detail,
        lineStart: parsedDetail.lineStart,
        lineEnd: parsedDetail.lineEnd,
        summary: parsedDetail.summary
      });
    }
  }

  return operations;
};

/**
 * Get icon for file operation type
 */
const getFileOperationIcon = (operation: string): string => {
  switch (operation) {
    case 'read':
      return '📖';
    case 'write':
    case 'edit':
      return '📝';
    case 'create':
      return '✨';
    case 'move':
      return '📦';
    case 'delete':
      return '🗑️';
    case 'list':
    case 'search':
      return '📁';
    default:
      return '📄';
  }
};

/**
 * Summarize file operations for display
 * Returns a short summary like "3 files" or "Edited 2 files"
 */
export const summarizeFileOperations = (operations: FileOperation[]): string | null => {
  if (operations.length === 0) return null;
  
  // Count unique files (by path)
  const uniquePaths = new Set(
    operations
      .filter(op => op.filePath)
      .map(op => op.filePath)
  );
  
  const fileCount = uniquePaths.size;
  if (fileCount === 0) return null;
  
  // Determine primary operation
  const operationCounts = operations.reduce((acc, op) => {
    acc[op.operation] = (acc[op.operation] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  const primaryOp = Object.entries(operationCounts)
    .sort(([, a], [, b]) => b - a)[0]?.[0];
  
  if (fileCount === 1) {
    const op = operations[0];
    const fileName = op.filePath ? basename(op.filePath) : 'file';
    return `${getFileOperationIcon(op.operation)} ${fileName}`;
  }
  
  const opLabel = primaryOp === 'read' ? 'Read' : primaryOp === 'write' || primaryOp === 'edit' ? 'Modified' : 'Accessed';
  return `📄 ${opLabel} ${fileCount} files`;
};

/**
 * Get detailed file operation info for expanded view
 */
export const getFileOperationDetails = (operation: FileOperation): string => {
  const icon = getFileOperationIcon(operation.operation);
  const opLabel = operation.operation.charAt(0).toUpperCase() + operation.operation.slice(1);
  const fileName = operation.filePath ? basename(operation.filePath) : 'unknown';
  const path = operation.filePath || 'unknown path';
  const lineLabel = (() => {
    if (operation.lineStart == null) return null;
    if (operation.lineEnd == null || operation.lineEnd === operation.lineStart) {
      return `line ${operation.lineStart}`;
    }
    return `lines ${operation.lineStart}–${operation.lineEnd}`;
  })();
  const summary = operation.summary ? ` · ${operation.summary}` : '';
  const lineSuffix = lineLabel ? ` · ${lineLabel}` : '';

  return `${icon} ${opLabel}: ${fileName} (${path}${lineSuffix})${summary}`;
};
