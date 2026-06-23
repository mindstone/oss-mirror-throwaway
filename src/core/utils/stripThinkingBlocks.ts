/**
 * Strip reasoning model thinking blocks from response content.
 *
 * Some providers (e.g. MiniMax M2.7) embed <think>...</think> blocks in
 * the content field rather than using a separate reasoning_content field.
 */
export function stripThinkingBlocks(text: string): string {
  if (!text.includes('<think>')) return text;
  // Match closed blocks, then any trailing unclosed block (truncated response)
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();
}
