/**
 * Activity Classification Utility
 * 
 * Categorizes file operations from a turn into memory/skill reads and writes.
 * Used by MemoryUpdateIndicator to display which files were read/written.
 */

import { isMemoryFile, isSkillFile } from '@shared/trackingTypes';
import type { FileOperation } from './fileOperations';
import type { MemoryUpdateStatus } from '@shared/types';

/** Operation types that represent reads (file was accessed but not modified) */
const READ_OPERATIONS = new Set(['read', 'search', 'list']);

/** Operation types that represent writes (file was created, modified, moved, or deleted) */
const WRITE_OPERATIONS = new Set(['create', 'edit', 'write', 'move', 'delete']);

/** Instructions file names (space-level config files) */
const INSTRUCTIONS_FILES = new Set(['README.md', 'AGENTS.md']);

/**
 * Check if a file path is an instructions file (README.md or AGENTS.md in a space).
 * These are high-salience files that define space behavior.
 */
function isInstructionsFile(filePath: string): boolean {
  const fileName = filePath.split(/[\\/]/).pop() ?? '';
  return INSTRUCTIONS_FILES.has(fileName);
}

export interface CategorizedActivity {
  /** Memory files that were written (have richer info from MemoryUpdateStatus) */
  memoryWrites: string[];
  /** Memory files that were read but not written */
  memoryReads: string[];
  /** Skill files that were written */
  skillWrites: string[];
  /** Skill files that were read but not written */
  skillReads: string[];
  /** Instructions files (README.md, AGENTS.md) that were written */
  instructionsWrites: string[];
  /** Instructions files that were read but not written */
  instructionsReads: string[];
  /** Workspace files (not memory/skill/instructions) that were written */
  workspaceWrites: string[];
}

/**
 * Categorize file operations into memory/skill reads and writes.
 * 
 * @param fileOps - Array of file operations from the turn
 * @param memoryStatus - Memory update status (optional, used to exclude writes from reads)
 * @returns Categorized file activity with deduplicated paths
 */
export function categorizeFileActivity(
  fileOps: FileOperation[],
  memoryStatus?: MemoryUpdateStatus
): CategorizedActivity {
  const memoryReadPaths = new Set<string>();
  const memoryWritePaths = new Set<string>();
  const skillReadPaths = new Set<string>();
  const skillWritePaths = new Set<string>();
  const instructionsReadPaths = new Set<string>();
  const instructionsWritePaths = new Set<string>();
  const workspaceWritePaths = new Set<string>();

  // First pass: collect all paths by operation type
  for (const op of fileOps) {
    if (!op.filePath) continue;

    const isMemory = isMemoryFile(op.filePath);
    const isSkill = isSkillFile(op.filePath);
    const isInstructions = isInstructionsFile(op.filePath);

    // Only count successful "end" events. Start events contain the intended path
    // before execution, and failed end events may reference files that were never
    // actually read or written.
    const isSuccessfulEnd = op.stage === 'end' && !op.isError;

    // For write operations, only count successful "end" stage events — "start" events contain
    // the intended path before execution and may reference files that were staged/denied
    // by the memory write hook and never actually written to disk.
    const isConfirmedWrite = WRITE_OPERATIONS.has(op.operation) && isSuccessfulEnd;
    const isConfirmedRead = READ_OPERATIONS.has(op.operation) && isSuccessfulEnd;

    // For untracked files, capture writes (user wants to see what Rebel modified)
    if (!isMemory && !isSkill && !isInstructions) {
      if (isConfirmedWrite) {
        workspaceWritePaths.add(op.filePath);
      }
      continue;
    }

    if (isConfirmedRead) {
      if (isInstructions) {
        instructionsReadPaths.add(op.filePath);
      } else if (isMemory) {
        memoryReadPaths.add(op.filePath);
      } else if (isSkill) {
        skillReadPaths.add(op.filePath);
      }
    } else if (isConfirmedWrite) {
      if (isInstructions) {
        instructionsWritePaths.add(op.filePath);
      } else if (isMemory) {
        memoryWritePaths.add(op.filePath);
      } else if (isSkill) {
        skillWritePaths.add(op.filePath);
      }
    }
  }

  // Collect memory write paths from memoryStatus (these have richer summaries)
  // This handles cases where the memory update service wrote files that weren't
  // captured in tool events (e.g., the update service creates files directly).
  // Only trust entityUpdates when the memory update succeeded — pending_approval
  // or error status means the files may not exist at the target path yet.
  if (memoryStatus?.status === 'success' && memoryStatus.entityUpdates) {
    for (const update of memoryStatus.entityUpdates) {
      if (update.filePath) {
        memoryWritePaths.add(update.filePath);
      }
    }
  }

  // Remove reads that also appear as writes (writes take precedence)
  for (const path of memoryWritePaths) {
    memoryReadPaths.delete(path);
  }
  for (const path of skillWritePaths) {
    skillReadPaths.delete(path);
  }
  for (const path of instructionsWritePaths) {
    instructionsReadPaths.delete(path);
  }

  return {
    memoryWrites: Array.from(memoryWritePaths),
    memoryReads: Array.from(memoryReadPaths),
    skillWrites: Array.from(skillWritePaths),
    skillReads: Array.from(skillReadPaths),
    instructionsWrites: Array.from(instructionsWritePaths),
    instructionsReads: Array.from(instructionsReadPaths),
    workspaceWrites: Array.from(workspaceWritePaths),
  };
}


