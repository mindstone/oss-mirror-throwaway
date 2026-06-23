/**
 * Safe JSON Parsing Utilities for Model Text Output
 *
 * Handles common cases when parsing JSON from LLM responses:
 * - Text wrapped in ```json fences
 * - Leading/trailing whitespace
 * - Model returning refusal text instead of JSON (e.g., "Claude cannot...")
 *
 * SECURITY: Never logs the actual model text (may contain secrets).
 * Only logs textLength and context for debugging.
 */

/**
 * Logger interface that matches pino Logger signature.
 * Using minimal interface to avoid direct pino dependency in shared code.
 */
interface Logger {
  warn: (obj: Record<string, unknown>, msg?: string) => void;
}

/**
 * Safely parse JSON from model text output.
 *
 * Handles common cases:
 * - Text wrapped in ```json fences
 * - Leading/trailing whitespace
 * - Model returning refusal text instead of JSON
 *
 * SECURITY: Never logs the actual model text (may contain secrets).
 *
 * @param text - Raw text from model response
 * @param context - Context string for logging (e.g., "memoryUpdate", "toolSafety")
 * @param logger - Optional logger for warnings
 * @returns Parsed object or null if parsing fails
 */
export function safeJsonParseFromModelText<T>(
  text: string,
  context: string,
  logger?: Logger
): T | null {
  let candidate = text.trim();

  // Strip markdown json fences if present
  const fenceMatch = candidate.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  // Quick check: must start with { or [
  if (!candidate.startsWith('{') && !candidate.startsWith('[')) {
    logger?.warn({ context, textLength: text.length }, 'Model returned non-JSON text');
    return null;
  }

  try {
    return JSON.parse(candidate) as T;
  } catch (e) {
    logger?.warn({ context, textLength: text.length, error: String(e) }, 'Failed to parse model JSON');
    return null;
  }
}
