const LARGE_OUTPUT_WARNING_MARKER = '\n\n---\n⚠️ LARGE OUTPUT WARNING:';
const BASE64_MIN_LENGTH = 1_000;
const BASE64_PATTERN = /^(?:data:[^;]*;base64,)?[A-Za-z0-9+/\n\r]{500,}={0,2}$/;
const EMBEDDED_BASE64_PATTERN = /(?:data:[^;]*;base64,)?[A-Za-z0-9+/\n\r]{1000,}={0,2}/g;
const BASE64_PLACEHOLDER = '[base64 content stripped]';
const MAX_SUMMARY_LENGTH = 4_000;
const MAX_STRING_LENGTH = 800;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;
const MAX_DEPTH = 6;

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}… [truncated ${value.length - maxLength} chars]`;
}

function stripLargeOutputWarning(value: string): string {
  const markerIndex = value.indexOf(LARGE_OUTPUT_WARNING_MARKER);
  return markerIndex === -1 ? value : value.slice(0, markerIndex).trimEnd();
}

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractTextContent(value: unknown): string | null {
  if (!Array.isArray(value)) return null;

  const texts = value
    .filter((entry): entry is { type?: string; text?: string } => (
      typeof entry === 'object' &&
      entry !== null &&
      ((entry as { type?: string }).type === 'text') &&
      typeof (entry as { text?: string }).text === 'string'
    ))
    .map((entry) => entry.text as string);

  return texts.length > 0 ? texts.join('\n') : null;
}

function sanitizeString(value: string): string {
  const withoutWarning = stripLargeOutputWarning(value);
  const trimmed = withoutWarning.trim();

  if (trimmed.length >= BASE64_MIN_LENGTH && BASE64_PATTERN.test(trimmed)) {
    return BASE64_PLACEHOLDER;
  }

  const replaced = withoutWarning.length >= BASE64_MIN_LENGTH
    ? withoutWarning.replace(EMBEDDED_BASE64_PATTERN, BASE64_PLACEHOLDER)
    : withoutWarning;

  return truncateText(replaced, MAX_STRING_LENGTH);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) {
    return '[nested content truncated]';
  }

  if (typeof value === 'string') {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    const limited = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeValue(entry, depth + 1));

    if (value.length > MAX_ARRAY_ITEMS) {
      limited.push(`[${value.length - MAX_ARRAY_ITEMS} more items truncated]`);
    }

    return limited;
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const limitedEntries = entries.slice(0, MAX_OBJECT_KEYS);
    const sanitized: Record<string, unknown> = {};

    for (const [key, entryValue] of limitedEntries) {
      sanitized[key] = sanitizeValue(entryValue, depth + 1);
    }

    if (entries.length > MAX_OBJECT_KEYS) {
      sanitized.__truncated = `${entries.length - MAX_OBJECT_KEYS} more keys truncated`;
    }

    return sanitized;
  }

  return value;
}

function unwrapExecutionPayload(rawContent: string): unknown {
  const stripped = stripLargeOutputWarning(rawContent).trim();
  const parsed = tryParseJson(stripped);

  if (!parsed || typeof parsed !== 'object') {
    return stripped;
  }

  const record = parsed as Record<string, unknown>;
  const resultRecord = record.result && typeof record.result === 'object'
    ? (record.result as Record<string, unknown>)
    : null;
  const meta = resultRecord?._meta as Record<string, unknown> | undefined;
  const innerText = extractTextContent(resultRecord?.content ?? meta?.content ?? null);

  if (innerText) {
    const unwrappedInner = stripLargeOutputWarning(innerText).trim();
    return tryParseJson(unwrappedInner) ?? unwrappedInner;
  }

  if (record.result !== undefined) {
    return record.result;
  }

  return record;
}

export function summarizeStagedExecutionResult(rawContent: string): string {
  const normalized = unwrapExecutionPayload(rawContent);
  const sanitized = sanitizeValue(normalized);
  const summary = typeof sanitized === 'string'
    ? sanitized.trim()
    : JSON.stringify(sanitized, null, 2).trim();

  if (!summary) {
    return 'Operation completed successfully.';
  }

  return truncateText(summary, MAX_SUMMARY_LENGTH);
}
