import { projectBlastRadius } from './blastRadius';
import type {
  ActionEffectKind,
  ActionPreviewInput,
  ActionPreviewModel,
  ContentVisibility,
  GenericStructuredRow,
} from '../model';

const MAX_ROW_COUNT = 24;
const MAX_OBJECT_KEYS = 30;
const MAX_ARRAY_ITEMS = 10;
const MAX_VALUE_LENGTH = 240;
const MAX_DEPTH = 4;
const SLACK_CHANNEL_ID_RE = /^[CG][A-Z0-9]+$/i;
const CONTENT_VISIBILITY_VALUES = new Set<ContentVisibility>(['safe', 'withheld', 'unknown']);
const CONTENT_LIKE_SEGMENTS = new Set([
  'blocks',
  'body',
  'content',
  'html',
  'markdown',
  'message',
  'summary',
  'text',
]);

const SENSITIVE_KEY_RE =
  /(token|api[_-]?key|access[_-]?key|private[_-]?key|secret|password|authorization|auth|cookie|session[_-]?id|bearer)/i;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function truncate(value: string, limit: number = MAX_VALUE_LENGTH): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function splitKeySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function normalizedKey(key: string): string {
  return splitKeySegments(key).join('');
}

function isContentLikeKey(key: string): boolean {
  const segments = splitKeySegments(key);
  if (segments.length === 0) return false;
  if (segments.includes('content') && segments.includes('preview')) return true;
  return segments.some((segment) => CONTENT_LIKE_SEGMENTS.has(segment));
}

function readContentVisibilityOverride(value: unknown): ContentVisibility | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = readContentVisibilityOverride(entry);
      if (nested) return nested;
    }
    return null;
  }

  if (!value || typeof value !== 'object') return null;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (normalizedKey(key) === 'contentvisibility') {
      const visibility = toNonEmptyString(entry)?.toLowerCase() as ContentVisibility | undefined;
      if (visibility && CONTENT_VISIBILITY_VALUES.has(visibility)) {
        return visibility;
      }
    }
    const nested = readContentVisibilityOverride(entry);
    if (nested) return nested;
  }
  return null;
}

function hasSensitivityMarker(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasSensitivityMarker(entry));
  }

  if (!value || typeof value !== 'object') return false;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (normalizedKey(key) === 'sensitivityreason' && toNonEmptyString(entry)) {
      return true;
    }
    if (hasSensitivityMarker(entry)) return true;
  }
  return false;
}

function hasKnownBodyContent(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasKnownBodyContent(entry));
  }

  if (!value || typeof value !== 'object') return false;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isContentLikeKey(key)) {
      if (toNonEmptyString(entry)) return true;
      if (Array.isArray(entry) && entry.length > 0) return true;
      if (entry && typeof entry === 'object' && Object.keys(asRecord(entry)).length > 0) return true;
    }
    if (hasKnownBodyContent(entry)) return true;
  }
  return false;
}

function redactValue(
  value: unknown,
  key: string,
  depth: number,
): unknown {
  if (SENSITIVE_KEY_RE.test(key)) return undefined;
  if (depth >= MAX_DEPTH) return '[Truncated]';

  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item, index) => redactValue(item, `${key}[${index}]`, depth + 1));
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)) {
      const redactedChild = redactValue(childValue, childKey, depth + 1);
      if (typeof redactedChild !== 'undefined') {
        output[childKey] = redactedChild;
      }
    }
    return output;
  }
  return String(value);
}

function flattenRows(
  value: unknown,
  prefix: string,
  rows: GenericStructuredRow[],
): void {
  if (rows.length >= MAX_ROW_COUNT) return;

  if (value == null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    rows.push({ key: prefix, value: truncate(String(value)) });
    return;
  }

  if (Array.isArray(value)) {
    rows.push({ key: prefix, value: truncate(JSON.stringify(value)) });
    return;
  }

  const entries = Object.entries(asRecord(value));
  if (entries.length === 0) {
    if (!prefix) return;
    rows.push({ key: prefix, value: '{}' });
    return;
  }

  for (const [childKey, childValue] of entries) {
    if (rows.length >= MAX_ROW_COUNT) break;
    const childPrefix = prefix ? `${prefix}.${childKey}` : childKey;
    flattenRows(childValue, childPrefix, rows);
  }
}

function buildSourceArgs(input: ActionPreviewInput): Record<string, unknown> {
  if (input.kind === 'tool' || input.kind === 'staged-tool') {
    return asRecord(input.args);
  }

  return {
    filePath: input.filePath,
    spaceName: input.spaceName,
    spacePath: input.spacePath,
    sharing: input.sharing,
    summary: input.summary,
    contentPreview: input.contentPreview,
    content: input.kind === 'memory' ? input.content : undefined,
    isNewFile: input.isNewFile,
    baseHash: input.kind === 'staged-file' ? input.baseHash : undefined,
  };
}

function deriveContentVisibility(input: ActionPreviewInput, args: Record<string, unknown>): ContentVisibility {
  if ((input.kind === 'memory' || input.kind === 'staged-file') && input.sensitivityReason) {
    return 'withheld';
  }

  const explicitVisibility = readContentVisibilityOverride(args);
  if (explicitVisibility && explicitVisibility !== 'safe') {
    return explicitVisibility;
  }

  if (hasSensitivityMarker(args)) {
    return 'withheld';
  }

  if (input.kind === 'tool' || input.kind === 'staged-tool') {
    return Object.keys(args).length > 0
      ? 'safe'
      : (explicitVisibility ?? 'unknown');
  }

  if (hasKnownBodyContent(args)) {
    return 'safe';
  }

  return explicitVisibility ?? 'unknown';
}

function sanitizeUnresolvedSlackChannelArgs(
  input: ActionPreviewInput,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (input.kind !== 'tool' && input.kind !== 'staged-tool') return args;

  const toolLike = [
    input.packageId ?? '',
    input.kind === 'tool' ? input.effectiveToolId ?? input.toolName : input.toolId,
    input.reason ?? '',
  ]
    .join(' ')
    .toLowerCase();
  if (!toolLike.includes('slack')) return args;

  const resolvedChannel = (input.resolvedChannelName ?? '').replace(/^#+/, '').trim();
  if (resolvedChannel.length > 0) return args;

  const sanitized = { ...args };
  let changed = false;
  for (const key of ['channel', 'channelId'] as const) {
    const value = sanitized[key];
    if (typeof value === 'string' && SLACK_CHANNEL_ID_RE.test(value.trim())) {
      sanitized[key] = 'Slack channel';
      changed = true;
    }
  }

  return changed ? sanitized : args;
}

function stripBodyLikeFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripBodyLikeFields(entry))
      .filter((entry) => typeof entry !== 'undefined');
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const stripped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isContentLikeKey(key)) continue;
    const nextValue = stripBodyLikeFields(entry);
    if (typeof nextValue !== 'undefined') {
      stripped[key] = nextValue;
    }
  }
  return stripped;
}

function stripBodyFieldsForWithheldContent(args: Record<string, unknown>): Record<string, unknown> {
  return asRecord(stripBodyLikeFields(args));
}

function buildTitle(input: ActionPreviewInput, effectKind: ActionEffectKind): string {
  if (input.kind === 'memory' || input.kind === 'staged-file') {
    return input.spaceName
      ? `Save to ${input.spaceName}`
      : effectKind === 'data-capture'
        ? 'Save captured source'
        : 'Update document';
  }
  if (input.kind === 'tool') return input.toolName;
  return input.displayName ?? input.toolId;
}

export function redactArgsForPreview(args: Record<string, unknown>): {
  rows: GenericStructuredRow[];
  safeRawArgs: Record<string, unknown>;
} {
  const safeRawArgs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args).slice(0, MAX_OBJECT_KEYS)) {
    const redactedValue = redactValue(value, key, 0);
    if (typeof redactedValue !== 'undefined') {
      safeRawArgs[key] = redactedValue;
    }
  }

  const rows: GenericStructuredRow[] = [];
  flattenRows(safeRawArgs, '', rows);
  return {
    rows: rows.slice(0, MAX_ROW_COUNT),
    safeRawArgs,
  };
}

export function projectGenericStructured(
  input: ActionPreviewInput,
  effectKind: ActionEffectKind,
): ActionPreviewModel {
  const sourceArgs = buildSourceArgs(input);
  const contentVisibility = deriveContentVisibility(input, sourceArgs);
  const channelSafeArgs = sanitizeUnresolvedSlackChannelArgs(input, sourceArgs);
  const projectionArgs = contentVisibility === 'safe'
    ? channelSafeArgs
    : stripBodyFieldsForWithheldContent(channelSafeArgs);
  const { rows, safeRawArgs } = redactArgsForPreview(projectionArgs);
  const { blastRadius, reversibility, riskReasons } = projectBlastRadius(input, effectKind);

  return {
    effectKind,
    title: buildTitle(input, effectKind),
    contentVisibility,
    blastRadius,
    reversibility,
    riskReasons,
    structuredArgs: rows,
    safeRawArgs,
  };
}
