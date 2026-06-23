import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'tokenEstimation' });

export const APPROX_CHARS_PER_TOKEN = 4;
export const IMAGE_BLOCK_TOKEN_COST = 2_000;
const MAX_RECURSION_DEPTH = 16;

interface PromptInputs {
  systemPrompt?: unknown;
  messages?: unknown;
  tools?: unknown;
}

let hasLoggedRecursionWarning = false;

const isImageBlock = (value: Record<string, unknown>): boolean => {
  if (value.type !== 'image') return false;

  return typeof value.data === 'string'
    || typeof value.source === 'object'
    || Boolean(value.media_type)
    || Boolean(value.mimeType);
};

function estimateTokensInternal(value: unknown, depth: number): number {
  if (depth >= MAX_RECURSION_DEPTH) {
    if (!hasLoggedRecursionWarning) {
      hasLoggedRecursionWarning = true;
      log.warn(
        { depth, maxDepth: MAX_RECURSION_DEPTH },
        'Token estimation recursion depth exceeded; skipping nested value',
      );
    }
    return 0;
  }

  if (value == null) return 0;
  if (typeof value === 'string') return Math.ceil(value.length / APPROX_CHARS_PER_TOKEN);
  if (typeof value === 'number' || typeof value === 'boolean') return 1;

  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateTokensInternal(item, depth + 1), 0);
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Deliberately over-count image blocks at a fixed cost; under-counting is riskier for preflight checks.
    if (isImageBlock(record) || record.type === 'image_url') {
      return IMAGE_BLOCK_TOKEN_COST;
    }

    return Object.entries(record).reduce(
      (sum, [key, propertyValue]) =>
        sum
        + Math.ceil(key.length / APPROX_CHARS_PER_TOKEN)
        // Per-key structural overhead approximates JSON punctuation (`,":"`) so totals stay close to JSON.stringify char-counts on text-only structures.
        + 1
        + estimateTokensInternal(propertyValue, depth + 1),
      0,
    );
  }

  return 0;
}

export function estimateTokensFromUnknown(value: unknown): number {
  return estimateTokensInternal(value, 0);
}

export function estimatePromptTokens(inputs: PromptInputs): number {
  try {
    return estimateTokensFromUnknown(inputs.systemPrompt)
      + estimateTokensFromUnknown(inputs.messages)
      + estimateTokensFromUnknown(inputs.tools);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
