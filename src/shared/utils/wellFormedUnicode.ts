export interface WellFormedStringOptions {
  forceFallback?: boolean;
}

export interface WellFormedStringResult {
  value: string;
  replacementCount: number;
}

export interface WellFormedDeepOptions extends WellFormedStringOptions {}

export interface WellFormedDeepResult<T> {
  value: T;
  replacementCount: number;
  replacementPaths: string[];
}

export interface WellFormedReplacementPathSummary {
  replacementPaths: string[];
  omittedPathCount: number;
}

const REPLACEMENT_CHAR = '\uFFFD';
const MAX_WELL_FORMED_DEPTH = 20;
const SDK_PROCESSING_METADATA_KEY = 'sdkProcessingMetadata';
const DYNAMIC_PATH_SEGMENT = '<dynamic>';
const SAFE_PATH_SEGMENT_REGEX = /^[A-Za-z0-9_.-]{1,64}$/;
const WELL_FORMED_REPLACEMENT_PATH_LIMIT = 10;

const isLeadingSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isTrailingSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

function countUnpairedSurrogates(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (isLeadingSurrogate(code)) {
      const nextCode = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (isTrailingSurrogate(nextCode)) {
        i += 1;
        continue;
      }
      count += 1;
      continue;
    }
    if (isTrailingSurrogate(code)) {
      count += 1;
    }
  }
  return count;
}

function toWellFormedFallback(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (isLeadingSurrogate(code)) {
      const nextCode = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (isTrailingSurrogate(nextCode)) {
        result += value[i] + value[i + 1];
        i += 1;
      } else {
        result += REPLACEMENT_CHAR;
      }
      continue;
    }
    if (isTrailingSurrogate(code)) {
      result += REPLACEMENT_CHAR;
      continue;
    }
    result += value[i];
  }
  return result;
}

/**
 * Convert a string to a well-formed UTF-16 sequence.
 */
export function ensureWellFormedString(
  value: string,
  options: WellFormedStringOptions = {}
): WellFormedStringResult {
  const replacementCount = countUnpairedSurrogates(value);
  if (replacementCount === 0) {
    return { value, replacementCount: 0 };
  }

  const toWellFormedNative = (
    String.prototype as unknown as { toWellFormed?: (this: string) => string }
  ).toWellFormed;
  if (typeof toWellFormedNative === 'function' && !options.forceFallback) {
    return {
      value: toWellFormedNative.call(value),
      replacementCount,
    };
  }

  return {
    value: toWellFormedFallback(value),
    replacementCount,
  };
}

/**
 * Truncate by UTF-16 code units without splitting a surrogate pair. This helper
 * never creates ill-formed UTF-16, but it does not sanitize hostility that
 * already exists in the input — the Sentry chokepoint sweep handles that.
 */
export function truncateWellFormed(value: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;

  let truncated = value.slice(0, maxChars);
  if (truncated.length === 0) return truncated;

  const trailingCode = truncated.charCodeAt(truncated.length - 1);
  if (isLeadingSurrogate(trailingCode)) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

function appendPath(basePath: string, segment: string): string {
  if (!basePath) return segment;
  if (segment.startsWith('[')) return `${basePath}${segment}`;
  return `${basePath}.${segment}`;
}

function normalizePathSegment(segment: string): string {
  return SAFE_PATH_SEGMENT_REGEX.test(segment) ? segment : DYNAMIC_PATH_SEGMENT;
}

function sanitizeReplacementPath(path: string): string {
  if (!path) {
    return '<root>';
  }
  if (path === '<root>') {
    return path;
  }

  const rawSegments = path.match(/\[[^\]]+\]|[^.[\]]+/g);
  if (!rawSegments || rawSegments.length === 0) {
    return '<root>';
  }

  return rawSegments
    .map((segment) => (SAFE_PATH_SEGMENT_REGEX.test(segment) ? segment : DYNAMIC_PATH_SEGMENT))
    .join('.');
}

export function summarizeWellFormedReplacementPaths(
  replacementPaths: string[],
  limit = WELL_FORMED_REPLACEMENT_PATH_LIMIT,
): WellFormedReplacementPathSummary {
  const sanitized = [...new Set(replacementPaths.map(sanitizeReplacementPath))];
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : WELL_FORMED_REPLACEMENT_PATH_LIMIT;

  return {
    replacementPaths: sanitized.slice(0, safeLimit),
    omittedPathCount: Math.max(0, sanitized.length - safeLimit),
  };
}

/**
 * Deeply normalizes JSON-ish values so string values and object keys are
 * well-formed UTF-16. If normalization changes a key and collides with an
 * existing normalized key, the last key in Object.entries order wins
 * deterministically.
 *
 * NOT an unconditional whole-object guarantee — two deliberate exceptions:
 * the root-level `sdkProcessingMetadata` key is skipped entirely (the SDK
 * strips it before serialization), and subtrees deeper than
 * MAX_WELL_FORMED_DEPTH are left as-is rather than risking a throw inside
 * beforeSend.
 */
export function ensureWellFormedDeep<T>(
  input: T,
  options: WellFormedDeepOptions = {}
): WellFormedDeepResult<T> {
  const replacementPaths = new Set<string>();
  let replacementCount = 0;
  const scanned = new WeakSet<object>();
  let hasReplacements = false;

  const scan = (value: unknown, path: string, depth: number, isRoot: boolean): void => {
    if (typeof value === 'string') {
      const normalized = ensureWellFormedString(value, options);
      if (normalized.replacementCount > 0) {
        hasReplacements = true;
        replacementCount += normalized.replacementCount;
        replacementPaths.add(path || '<root>');
      }
      return;
    }

    if (value === null || typeof value !== 'object') {
      return;
    }

    if (depth >= MAX_WELL_FORMED_DEPTH || scanned.has(value)) {
      return;
    }
    scanned.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        scan(value[i], appendPath(path, `[${i}]`), depth + 1, false);
      }
      return;
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isRoot && key === SDK_PROCESSING_METADATA_KEY) {
        continue;
      }

      const normalizedKey = ensureWellFormedString(key, options);
      if (normalizedKey.replacementCount > 0) {
        hasReplacements = true;
        replacementCount += normalizedKey.replacementCount;
        replacementPaths.add(appendPath(path, DYNAMIC_PATH_SEGMENT) || DYNAMIC_PATH_SEGMENT);
      }

      scan(child, appendPath(path, normalizePathSegment(key)), depth + 1, false);
    }
  };

  scan(input, '', 0, true);

  if (!hasReplacements) {
    return {
      value: input,
      replacementCount: 0,
      replacementPaths: [],
    };
  }

  const visited = new WeakMap<object, unknown>();
  const clone = (value: unknown, path: string, depth: number, isRoot: boolean): unknown => {
    if (typeof value === 'string') {
      return ensureWellFormedString(value, options).value;
    }

    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (depth >= MAX_WELL_FORMED_DEPTH) {
      return value;
    }

    if (visited.has(value)) {
      return visited.get(value);
    }

    if (Array.isArray(value)) {
      const arrayClone: unknown[] = [];
      visited.set(value, arrayClone);
      for (let i = 0; i < value.length; i += 1) {
        arrayClone[i] = clone(value[i], appendPath(path, `[${i}]`), depth + 1, false);
      }
      return arrayClone;
    }

    const objectClone: Record<string, unknown> = {};
    visited.set(value, objectClone);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isRoot && key === SDK_PROCESSING_METADATA_KEY) {
        objectClone[key] = child;
        continue;
      }

      const normalizedKey = ensureWellFormedString(key, options).value;
      objectClone[normalizedKey] = clone(child, appendPath(path, normalizePathSegment(key)), depth + 1, false);
    }
    return objectClone;
  };

  return {
    value: clone(input, '', 0, true) as T,
    replacementCount,
    replacementPaths: [...replacementPaths],
  };
}
