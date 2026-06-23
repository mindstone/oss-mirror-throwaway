/**
 * Anthropic-specific context window + max-output token limits.
 *
 * Single source of truth for both:
 * - `src/core/rebelCore/modelLimits.ts` (cascade resolution including
 *   maxOutputTokens)
 * - `src/shared/data/modelProviderPresets.ts` (registry lookup for the
 *   provenance helpers)
 *
 * Order matters: more specific patterns first. The `(?:-|$)` delimiter
 * prevents `claude-opus-4-60` from matching the `opus-4-6` rule.
 *
 * Verified against Anthropic docs (March 2026).
 */

export interface AnthropicModelLimit {
  pattern: RegExp;
  contextWindow: number;
  maxOutputTokens: number;
}

export const ANTHROPIC_MODEL_LIMITS: ReadonlyArray<AnthropicModelLimit> = [
  { pattern: /^claude-fable-5(?:-|$)/i, contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  { pattern: /^claude-opus-4-8(?:-|$)/i, contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  { pattern: /^claude-opus-4-7(?:-|$)/i, contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  { pattern: /^claude-opus-4-6(?:-|$)/i, contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  { pattern: /^claude-sonnet-4-6(?:-|$)/i, contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  { pattern: /^claude-haiku-4-5(?:-|$)/i, contextWindow: 200_000, maxOutputTokens: 64_000 },
  { pattern: /^claude-opus-4(?:-|$)/i, contextWindow: 200_000, maxOutputTokens: 64_000 },
  { pattern: /^claude-sonnet-4(?:-|$)/i, contextWindow: 200_000, maxOutputTokens: 64_000 },
  { pattern: /^claude-haiku-4(?:-|$)/i, contextWindow: 200_000, maxOutputTokens: 16_000 },
  { pattern: /^claude-3(?:-|$)/i, contextWindow: 200_000, maxOutputTokens: 8_192 },
];

/**
 * Normalise a model id for Anthropic pattern matching: strip the `[1m]`
 * extended-context suffix, the `anthropic/` provider prefix, and dot-format
 * version numbers (Claude only).
 */
export function normalizeForAnthropicMatch(model: string): string {
  let clean = model.replace(/\[1[mM]\]$/, '').trim();
  if (clean.startsWith('anthropic/')) clean = clean.slice('anthropic/'.length);
  if (/^claude-/i.test(clean)) clean = clean.replace(/(\d)\.(\d)/g, '$1-$2');
  return clean;
}

export function getAnthropicContextWindow(model: string): number | null {
  const cleaned = normalizeForAnthropicMatch(model);
  for (const entry of ANTHROPIC_MODEL_LIMITS) {
    if (entry.pattern.test(cleaned)) return entry.contextWindow;
  }
  return null;
}

export function getAnthropicMaxOutput(model: string): number | null {
  const cleaned = normalizeForAnthropicMatch(model);
  for (const entry of ANTHROPIC_MODEL_LIMITS) {
    if (entry.pattern.test(cleaned)) return entry.maxOutputTokens;
  }
  return null;
}
