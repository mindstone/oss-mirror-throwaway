import { useMemo } from 'react';
import type { TurnStepContext } from '../utils/turnStepContext';
import type { MemoryUpdateStatus } from '@shared/types';
import { categorizeFileActivity } from '@renderer/utils/activityClassification';

export type ConversationFileEntry = {
  path: string;
  operation: string;
  category: 'workspace' | 'memory' | 'skill' | 'instructions';
};

export type ConversationFileSummary = {
  files: ConversationFileEntry[];
  hasMemoryUpdates: boolean;
  totalFileCount: number;
};

const EMPTY_SUMMARY: ConversationFileSummary = {
  files: [],
  hasMemoryUpdates: false,
  totalFileCount: 0,
};

/**
 * Infer whether a file was created or updated based on the conversation's
 * operation history. If the first operation on a path was 'write' or 'create'
 * (no prior read/edit), the file was likely created during this conversation.
 */
function inferEffectiveOperation(firstOp?: string, lastOp?: string): string {
  if (lastOp === 'create' || lastOp === 'delete' || lastOp === 'move') return lastOp;
  if (firstOp === 'write' || firstOp === 'create') return 'create';
  return lastOp ?? 'write';
}

/**
 * Aggregates file operations and memory updates across all turns in a conversation.
 * Deduplicates by file path (last occurrence wins) and categorizes into
 * workspace / memory / skill / instructions buckets.
 *
 * Tracks first-seen operation per path to distinguish newly created files
 * (first op is 'write'/'create') from updates to existing files (first op is 'read'/'edit').
 */
export function useConversationFiles(
  turnStepContextByTurn: Record<string, TurnStepContext> | undefined,
  memoryStatusByTurn: Record<string, MemoryUpdateStatus | undefined> | undefined
): ConversationFileSummary {
  return useMemo(() => {
    if (!turnStepContextByTurn) return EMPTY_SUMMARY;

    const turnIds = Object.keys(turnStepContextByTurn);
    if (turnIds.length === 0) return EMPTY_SUMMARY;

    const firstOperationByPath = new Map<string, string>();
    const lastOperationByPath = new Map<string, string>();
    const entriesByPath = new Map<string, ConversationFileEntry>();
    let hasMemoryUpdates = false;

    for (const turnId of turnIds) {
      const ctx = turnStepContextByTurn[turnId];
      const fileOps = ctx.flattenedFileOperations;
      const memoryStatus = memoryStatusByTurn?.[turnId];

      for (const op of fileOps) {
        if (op.filePath && op.stage === 'end' && !op.isError) {
          if (!firstOperationByPath.has(op.filePath)) {
            firstOperationByPath.set(op.filePath, op.operation);
          }
          lastOperationByPath.set(op.filePath, op.operation);
        }
      }

      const activity = categorizeFileActivity(fileOps, memoryStatus);

      const effectiveOp = (path: string) =>
        inferEffectiveOperation(firstOperationByPath.get(path), lastOperationByPath.get(path));

      for (const path of activity.workspaceWrites) {
        entriesByPath.set(path, {
          path,
          operation: effectiveOp(path),
          category: 'workspace',
        });
      }

      for (const path of activity.memoryWrites) {
        entriesByPath.set(path, {
          path,
          operation: effectiveOp(path),
          category: 'memory',
        });
        hasMemoryUpdates = true;
      }

      for (const path of activity.skillWrites) {
        entriesByPath.set(path, {
          path,
          operation: effectiveOp(path),
          category: 'skill',
        });
      }

      for (const path of activity.instructionsWrites) {
        entriesByPath.set(path, {
          path,
          operation: effectiveOp(path),
          category: 'instructions',
        });
      }
    }

    const files = Array.from(entriesByPath.values());
    return {
      files,
      hasMemoryUpdates,
      totalFileCount: files.length,
    };
  }, [turnStepContextByTurn, memoryStatusByTurn]);
}
