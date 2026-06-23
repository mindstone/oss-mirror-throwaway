/**
 * Compaction Utilities
 *
 * Shared utilities for context compaction and recovery.
 * Extracted from renderer to enable centralized recovery in main process.
 */

import type { AgentTurnMessage } from '@shared/types';

export const MAX_COMPACTION_DEPTH = 3;

export const MAX_COMPACTION_ATTEMPTS = 3;

export interface ToolLimitSuggestion {
  toolName: string;
  currentSize: number;
  suggestedLimit: number;
}

/**
 * Parse tool name to extract server_id and tool_id.
 * Handles format: "server_id/tool_id" (e.g., "filesystem/read_file")
 * Falls back to treating full name as tool_id if no separator found.
 */
function parseInnerToolName(fullName: string): { serverId: string; toolId: string } {
  if (fullName.includes('/')) {
    const [serverId, ...rest] = fullName.split('/');
    return { serverId, toolId: rest.join('/') };
  }
  // Fallback for non-MCP tools or old format
  return { serverId: '', toolId: fullName };
}

/**
 * Build an enhanced prompt that includes the conversation summary and tool guidance.
 * This prompt is used when retrying after context overflow.
 */
export function buildEnhancedPrompt(
  originalPrompt: string,
  summary: string,
  depth: number,
  toolSuggestions: ToolLimitSuggestion[]
): string {
  let toolGuidance = '';

  if (toolSuggestions.length > 0) {
    // Build specific limits for each tool (format: package_id/tool_id)
    const limitLines: string[] = [];
    for (const suggestion of toolSuggestions) {
      const { serverId, toolId } = parseInnerToolName(suggestion.toolName);
      const displayName = serverId ? `${serverId}/${toolId}` : toolId;
      limitLines.push(`  - ${displayName}: max_output_chars: ${suggestion.suggestedLimit} (was ${suggestion.currentSize} chars)`);
    }

    const severity = depth === 1 ? 'IMPORTANT' : 'CRITICAL';
    const intro = depth === 1
      ? 'The previous attempt exceeded context limits.'
      : 'Context limits exceeded again despite previous attempt. You MUST limit outputs.';

    // Build example using first suggestion
    const firstTool = parseInnerToolName(toolSuggestions[0].toolName);
    const exampleServerId = firstTool.serverId || 'server_name';
    const exampleToolId = firstTool.toolId || 'tool_name';

    toolGuidance = `\n\n${severity}: ${intro}
When calling use_tool for these tools, add max_output_chars:
${limitLines.join('\n')}

Example: use_tool({ package_id: "${exampleServerId}", tool_id: "${exampleToolId}", args: {...}, max_output_chars: ${toolSuggestions[0].suggestedLimit} })`;

    if (depth >= 2) {
      toolGuidance += '\n\nIf the task still cannot be completed, break it into smaller steps or request only summaries/excerpts instead of full content.';
    }
  } else {
    // No tool data available - give generic guidance
    const fallbackLimit = depth === 1 ? 100000 : depth === 2 ? 50000 : 25000;
    toolGuidance = depth === 1
      ? `\n\nNote: The previous attempt exceeded context limits. When using MCP tools via use_tool, consider adding the max_output_chars parameter to limit large outputs.\nExample: use_tool({ ..., max_output_chars: ${fallbackLimit} })`
      : `\n\nCRITICAL: Context limits exceeded again. For ALL use_tool calls, add max_output_chars: ${fallbackLimit} to limit output size. Break large tasks into smaller steps.`;
  }

  // Strip depth markers and @model: references to prevent the
  // detect-model -> oversized-subagent -> overflow loop (FOX-2857).
  const cleanedPrompt = cleanForCompaction(originalPrompt);

  return [
    `[COMPACTION_DEPTH:${depth}]`,
    '=== CONVERSATION SUMMARY ===',
    summary,
    toolGuidance,
    '',
    '=== CONTINUE WITH REQUEST ===',
    cleanedPrompt
  ].join('\n');
}

/**
 * Extract the original request text from nested compaction prompts.
 *
 * Compaction artifacts begin with a [COMPACTION_DEPTH:N] marker and may contain
 * nested "=== CONTINUE WITH REQUEST ===" sections from prior retries. We use
 * the LAST marker to unwrap to the most recent user request payload.
 */
export function unwrapCompactionArtifact(text: string): string {
  if (!text.startsWith('[COMPACTION_DEPTH:')) {
    return text;
  }

  const marker = '=== CONTINUE WITH REQUEST ===';
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex === -1) {
    return text;
  }

  const unwrapped = text.slice(markerIndex + marker.length).trim();
  return unwrapped.length > 0 ? unwrapped : text;
}

/**
 * Clean a text segment for use in compaction prompts.
 * Strips depth markers and @model: references to prevent the
 * detect-model → oversized-subagent → overflow loop (FOX-2857).
 */
export function cleanForCompaction(text: string): string {
  return text
    .replace(/\[COMPACTION_DEPTH:\d+\]\s*/g, '')
    .replace(/@model:`[^`]+`/gi, '')
    .replace(/@model:\S+/gi, '')
    .replace(/<conversation_history>[\s\S]*?<\/conversation_history>\s*/gi, '')
    .replace(/<user-request>[\s\S]*?<\/user-request>\s*/gi, '')
    .replace(/<suggested-skills>[\s\S]*?<\/suggested-skills>\s*/gi, '');
}

/**
 * Normalize task context used for BTS compression prompts.
 * Unwraps nested compaction artifacts, then applies standard compaction cleanup.
 */
export function sanitizeTaskContext(text: string): string {
  return cleanForCompaction(unwrapCompactionArtifact(text));
}

/**
 * Format recent messages as a readable transcript for the compaction prompt.
 * Each message is labeled with its role (User/Assistant/Result) for clarity.
 */
function formatRecentTranscript(messages: AgentTurnMessage[]): string {
  return messages
    .map((msg) => {
      const label = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'Result';
      return `${label}: ${cleanForCompaction(msg.text)}`;
    })
    .join('\n\n');
}

/**
 * Build tool limit guidance for compaction retry prompts.
 */
function buildToolGuidanceSection(
  toolSuggestions: ToolLimitSuggestion[],
  depth: number
): string {
  if (toolSuggestions.length > 0) {
    const limitLines: string[] = [];
    for (const suggestion of toolSuggestions) {
      const { serverId, toolId } = parseInnerToolName(suggestion.toolName);
      const displayName = serverId ? `${serverId}/${toolId}` : toolId;
      limitLines.push(`  - ${displayName}: max_output_chars: ${suggestion.suggestedLimit} (was ${suggestion.currentSize} chars)`);
    }

    const severity = depth === 1 ? 'IMPORTANT' : 'CRITICAL';
    const intro = depth === 1
      ? 'The previous attempt exceeded context limits.'
      : 'Context limits exceeded again despite previous attempt. You MUST limit outputs.';

    const firstTool = parseInnerToolName(toolSuggestions[0].toolName);
    const exampleServerId = firstTool.serverId || 'server_name';
    const exampleToolId = firstTool.toolId || 'tool_name';

    let guidance = `${severity}: ${intro}
When calling use_tool for these tools, add max_output_chars:
${limitLines.join('\n')}

Example: use_tool({ package_id: "${exampleServerId}", tool_id: "${exampleToolId}", args: {...}, max_output_chars: ${toolSuggestions[0].suggestedLimit} })`;

    if (depth >= 2) {
      guidance += '\n\nIf the task still cannot be completed, break it into smaller steps or request only summaries/excerpts instead of full content.';
    }

    return guidance;
  }

  // No tool data available — generic guidance
  const fallbackLimit = depth === 1 ? 100000 : depth === 2 ? 50000 : 25000;
  return depth === 1
    ? `Note: The previous attempt exceeded context limits. When using MCP tools via use_tool, consider adding the max_output_chars parameter to limit large outputs.\nExample: use_tool({ ..., max_output_chars: ${fallbackLimit} })`
    : `CRITICAL: Context limits exceeded again. For ALL use_tool calls, add max_output_chars: ${fallbackLimit} to limit output size. Break large tasks into smaller steps.`;
}

/**
 * Build an enhanced prompt with sliding window context for intelligent compaction.
 * Uses compressed older context + verbatim recent messages for better continuity.
 *
 * This is the preferred prompt builder when generateIntelligentSummary() succeeds;
 * falls back to buildEnhancedPrompt() when it doesn't.
 */
export function buildEnhancedPromptWithWindow(
  originalPrompt: string,
  olderSummary: string,
  recentMessages: AgentTurnMessage[],
  depth: number,
  toolSuggestions: ToolLimitSuggestion[]
): string {
  const cleanedPrompt = cleanForCompaction(originalPrompt);
  const cleanedSummary = cleanForCompaction(olderSummary);
  const toolGuidance = buildToolGuidanceSection(toolSuggestions, depth);

  const parts: string[] = [`[COMPACTION_DEPTH:${depth}]`, '=== CONVERSATION CONTEXT ==='];

  // Only include older context section if there's a summary
  if (cleanedSummary.trim()) {
    parts.push('', '--- OLDER CONTEXT (COMPRESSED) ---', cleanedSummary);
  }

  // Only include recent context section if there are recent messages
  if (recentMessages.length > 0) {
    parts.push('', '--- RECENT CONTEXT (VERBATIM) ---', formatRecentTranscript(recentMessages));
  }

  // Tool guidance
  parts.push('', toolGuidance);

  parts.push('', '=== CONTINUE WITH REQUEST ===', cleanedPrompt);

  return parts.join('\n');
}
