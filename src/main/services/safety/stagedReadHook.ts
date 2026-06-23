/**
 * Staged Read Hook
 * 
 * PreToolUse hook that intercepts Read tool calls and returns staged content
 * when a file has pending staged changes. This provides read-after-write
 * consistency for the agent even before the user approves the changes.
 * 
 * Pattern: Uses "deny with content in message" - the runtime sees a denial but
 * the agent receives the staged content in the reason message.
 */

import type { HookJSONOutput } from '@core/agentRuntimeTypes';
import { createScopedLogger } from '@core/logger';
import {
  getPendingFileByDestination,
  type PendingFile,
  type PendingFileLookupResult,
} from './cosPendingService';

const log = createScopedLogger({ service: 'stagedReadHook' });

const MAX_CONTENT_SIZE = 100000;

function truncateContent(content: string): string {
  if (content.length <= MAX_CONTENT_SIZE) {
    return content;
  }
  const truncated = Buffer.from(content).subarray(0, MAX_CONTENT_SIZE).toString('utf-8');
  return truncated + '\n\n[...truncated, full content available once approved]';
}

function isBinaryContent(content: string): boolean {
  return content.includes('\0');
}

export interface StagedReadHookOptions {
  sessionId?: string;
}

type LegacyPendingLookupResult = { file: PendingFile; content: string } | null | undefined;

function normalizePendingLookupResult(
  result: PendingFileLookupResult | LegacyPendingLookupResult,
): PendingFileLookupResult {
  if (!result) {
    return { kind: 'none' };
  }

  if ('kind' in result) {
    return result;
  }

  if ('file' in result) {
    const legacyContent = typeof (result as { content?: unknown }).content === 'string'
      ? (result as { content: string }).content
      : '';
    return {
      kind: 'found',
      file: result.file,
      content: legacyContent,
    };
  }

  return { kind: 'none' };
}

export function createStagedReadHook(options: StagedReadHookOptions = {}) {
  const { sessionId } = options;
  
  return async (
    input: { tool_name?: string; tool_input?: Record<string, unknown>; tool_use_id?: string },
    _toolUseID: string | undefined,
    _hookOptions: { signal: AbortSignal }
  ): Promise<HookJSONOutput> => {
    if (input.tool_name !== 'Read') {
      return {};
    }
    
    const filePath = input.tool_input?.file_path as string;
    if (!filePath) {
      return {};
    }
    
    try {
      const pendingLookup = normalizePendingLookupResult(
        await getPendingFileByDestination(filePath, sessionId),
      );
      if (pendingLookup.kind === 'none') {
        return {};
      }

      if (pendingLookup.kind === 'candidate_unreadable') {
        log.warn(
          {
            filePath,
            pendingFilePath: pendingLookup.filePath,
            reason: pendingLookup.reason,
          },
          'Pending candidate unreadable during staged read lookup; falling back to disk read'
        );
        return {};
      }
      
      const { file, content } = pendingLookup;
      
      if (isBinaryContent(content)) {
        log.debug({ filePath }, 'Skipping staged read hook for binary file');
        return {};
      }
      
      const displayContent = truncateContent(content);
      
      log.info({ filePath, spaceName: file.frontmatter.original_space, pendingId: file.id }, 'Returning pending content for read');
      
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `[PENDING FILE - Pending approval to "${file.frontmatter.original_space}"]

Note: You are reading the PENDING version of this file. Changes have not been approved yet.
The file at "${filePath}" has pending staged changes that haven't been approved yet.
Here is the current pending content:

---BEGIN STAGED CONTENT---
${displayContent}
---END STAGED CONTENT---

This content will be written to the final location when the user approves.
You can use this content for your current task.`,
        },
      };
    } catch (error) {
      log.warn({ err: error, filePath }, 'Error checking pending content, allowing normal read');
      return {};
    }
  };
}
