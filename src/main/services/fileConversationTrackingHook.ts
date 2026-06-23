/**
 * File-Conversation Tracking Hook (PostToolUse)
 *
 * Observes successful file write operations to track file-conversation associations.
 * Used for smart routing when sending annotations to Rebel.
 */

import { createScopedLogger } from '@core/logger';
import { toPortablePath } from '@core/utils/portablePath';
import { trackFileConversation } from './fileConversationStore';
import { FILE_WRITE_TOOLS } from './safety/constants';

const log = createScopedLogger({ service: 'fileConversationTracking' });

export interface FileConversationTrackingOptions {
  sessionId: string;
  sessionTitle: string;
  coreDirectory?: string;
}

/**
 * Extract file path from tool input based on tool type.
 */
function extractFilePath(toolInput: Record<string, unknown>): string | null {
  if (typeof toolInput.file_path === 'string') return toolInput.file_path;
  if (typeof toolInput.path === 'string') return toolInput.path;
  if (typeof toolInput.filePath === 'string') return toolInput.filePath;
  return null;
}

/**
 * Make path relative to coreDirectory if absolute.
 */
function makeRelativePath(filePath: string, coreDirectory?: string): string {
  if (!coreDirectory) return filePath;
  
  const normalizedFile = toPortablePath(filePath);
  const normalizedCore = toPortablePath(coreDirectory);
  
  if (normalizedFile.startsWith(normalizedCore + '/')) {
    return normalizedFile.slice(normalizedCore.length + 1);
  }
  if (normalizedFile.startsWith(normalizedCore)) {
    return normalizedFile.slice(normalizedCore.length);
  }
  
  return filePath;
}

/**
 * Create the file-conversation tracking hook for PostToolUse.
 *
 * This is an observe-only hook - it fires after successful tool execution
 * and doesn't block or modify the tool result.
 *
 * Note: Hooks MUST return an object (even empty {}), not void/undefined.
 * Returning undefined causes ZodError in the hook output parsing.
 */
export function createFileConversationTrackingHook(options: FileConversationTrackingOptions) {
  const { sessionId, sessionTitle, coreDirectory } = options;

  return async (input: {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_output?: unknown;
    tool_use_id?: string;
  }): Promise<Record<string, never>> => {
    const toolName = input.tool_name;
    const toolInput = input.tool_input as Record<string, unknown> | undefined;

    // Only track file write tools
    if (!toolName || !FILE_WRITE_TOOLS.includes(toolName as typeof FILE_WRITE_TOOLS[number])) {
      return {};
    }

    if (!toolInput) {
      return {};
    }

    const filePath = extractFilePath(toolInput);
    if (!filePath) {
      log.debug({ toolName }, 'Could not extract file path from tool input');
      return {};
    }

    // Make path relative for storage
    const relativePath = makeRelativePath(filePath, coreDirectory);

    // Track the association (fire-and-forget)
    try {
      trackFileConversation(relativePath, sessionId, sessionTitle, 'write');
      log.debug({ filePath: relativePath, sessionId, toolName }, 'Tracked file-conversation link');
    } catch (error) {
      log.warn({ err: error, filePath: relativePath }, 'Failed to track file-conversation link');
    }

    return {};
  };
}
