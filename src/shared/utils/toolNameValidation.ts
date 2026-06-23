/**
 * Tool Name Validation Utilities
 *
 * Helpers for detecting and handling Anthropic API tool name length validation errors.
 * The Anthropic API enforces a 200-character limit on tool_use.name fields.
 *
 * Background: The Claude model can occasionally produce malformed tool_use blocks where
 * the tool arguments are serialized into the name field instead of the input field
 * (e.g., 'Task" prompt="Ultrathink..."' at 700+ chars with input: {}).
 * When these corrupt names are stored in the upstream session,
 * every resume attempt sends them back and gets a deterministic 400 error, permanently
 * breaking the conversation.
 *
 * Two-layer defense:
 * 1. Prevention: truncateToolName() clamps names on ingestion so corrupt names don't
 *    pollute eventsByTurn storage (agentMessageHandler.ts collectToolHints).
 * 2. Recovery: isToolNameLengthError() detects the API error so agentTurnExecutor can
 *    clear the corrupt upstream session and retry with rebuilt conversation context.
 *
 * First observed: rebel://conversation/963ed81f-6ba8-4774-ade3-72fd9ede76f7
 */

/** Maximum tool name length enforced by the Anthropic API */
export const ANTHROPIC_MAX_TOOL_NAME_LENGTH = 200;

/**
 * Detect whether an error message indicates an Anthropic API tool name length validation error.
 *
 * Matches the actual API error format:
 *   "messages.N.content.N.tool_use.name: String should have at most 200 characters"
 *
 * Requires "tool_use.name" (the exact API field path) PLUS at least one of the
 * validation-specific phrases ("at most", "characters", "string should have").
 * This prevents false positives on legitimate conversation text that might mention
 * "tool_use.name" in a discussion about API schemas.
 *
 * @param text - Error message text (case-insensitive matching)
 * @returns true if the text indicates a tool name length error
 */
export function isToolNameLengthError(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();

  // Require the exact API field path "tool_use.name" (not just "tool_use" + "name" separately)
  if (!lower.includes('tool_use.name')) return false;

  // Plus at least one validation-specific phrase to confirm this is an error, not discussion text
  return (
    lower.includes('at most') ||
    lower.includes('characters') ||
    lower.includes('string should have') ||
    lower.includes('invalid_request_error')
  );
}

/**
 * Truncate a tool name to the Anthropic API limit if it exceeds the maximum length.
 * This is a local safety measure to prevent dispatching oversized names to the renderer
 * or aggregator. It does NOT fix the upstream session (that requires session recovery).
 *
 * @param name - Original tool name
 * @returns Truncated name (at most 200 chars), or the original if already within limit
 */
export function truncateToolName(name: string): string {
  if (name.length <= ANTHROPIC_MAX_TOOL_NAME_LENGTH) return name;
  return name.slice(0, ANTHROPIC_MAX_TOOL_NAME_LENGTH);
}
