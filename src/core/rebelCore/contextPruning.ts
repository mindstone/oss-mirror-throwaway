import { createScopedLogger } from '@core/logger';
import type { ChatMessage } from './modelTypes';

const log = createScopedLogger({ service: 'contextPruning' });

interface ToolPairLocation {
  useMessageIndex: number;
  useBlockIndex: number;
  resultMessageIndex: number;
  resultBlockIndex: number;
  toolUseId: string;
}

/**
 * Removes old tool_use/tool_result pairs from message history, keeping the N most recent.
 * Handles: paired ID correlation, empty-message cleanup, role alternation preservation.
 * Mutates the array in-place for efficiency (same pattern as stripOldThinkingBlocks).
 *
 * @returns count of pairs removed
 */
export function pruneOldToolPairs(messages: ChatMessage[], keepRecent: number): number {
  if (messages.length === 0 || keepRecent < 0) return 0;

  // 1. Scan for all tool_use and tool_result blocks with their locations
  const toolUseLocations = new Map<string, { messageIndex: number; blockIndex: number }>();
  const toolResultLocations = new Map<string, { messageIndex: number; blockIndex: number }>();

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx += 1) {
    const message = messages[msgIdx];
    if (!Array.isArray(message.content)) continue;

    for (let blockIdx = 0; blockIdx < message.content.length; blockIdx += 1) {
      const block = message.content[blockIdx];
      if (block.type === 'tool_use') {
        toolUseLocations.set(block.id, { messageIndex: msgIdx, blockIndex: blockIdx });
      } else if (block.type === 'tool_result') {
        toolResultLocations.set(block.tool_use_id, { messageIndex: msgIdx, blockIndex: blockIdx });
      }
    }
  }

  // 2. Build list of complete pairs (both use and result found)
  const completePairs: ToolPairLocation[] = [];
  for (const [toolUseId, useLoc] of toolUseLocations) {
    const resultLoc = toolResultLocations.get(toolUseId);
    if (resultLoc) {
      completePairs.push({
        useMessageIndex: useLoc.messageIndex,
        useBlockIndex: useLoc.blockIndex,
        resultMessageIndex: resultLoc.messageIndex,
        resultBlockIndex: resultLoc.blockIndex,
        toolUseId,
      });
    }
  }

  if (completePairs.length === 0) return 0;

  // 3. Sort pairs by position (earliest tool_use first)
  completePairs.sort((a, b) => {
    if (a.useMessageIndex !== b.useMessageIndex) return a.useMessageIndex - b.useMessageIndex;
    return a.useBlockIndex - b.useBlockIndex;
  });

  // 4. Determine which pairs to remove (all except keepRecent most recent)
  const removeCount = Math.max(completePairs.length - keepRecent, 0);
  if (removeCount === 0) return 0;

  const pairsToRemove = completePairs.slice(0, removeCount);

  // 5. Collect block indexes to remove per message (in descending order for safe splice)
  const blocksToRemoveByMessage = new Map<number, number[]>();

  for (const pair of pairsToRemove) {
    // tool_use block
    let useBlocks = blocksToRemoveByMessage.get(pair.useMessageIndex);
    if (!useBlocks) {
      useBlocks = [];
      blocksToRemoveByMessage.set(pair.useMessageIndex, useBlocks);
    }
    useBlocks.push(pair.useBlockIndex);

    // tool_result block
    let resultBlocks = blocksToRemoveByMessage.get(pair.resultMessageIndex);
    if (!resultBlocks) {
      resultBlocks = [];
      blocksToRemoveByMessage.set(pair.resultMessageIndex, resultBlocks);
    }
    resultBlocks.push(pair.resultBlockIndex);
  }

  // 6. Remove blocks in reverse order within each message (to preserve indexes)
  for (const [msgIdx, blockIndexes] of blocksToRemoveByMessage) {
    const message = messages[msgIdx];
    if (!Array.isArray(message.content)) continue;

    // Sort descending so splice doesn't shift subsequent indexes
    const sorted = [...blockIndexes].sort((a, b) => b - a);
    for (const blockIdx of sorted) {
      message.content.splice(blockIdx, 1);
    }
  }

  // 7. Clean up: remove messages whose content array is now empty
  //    Iterate in reverse to avoid index shifting
  const lengthBeforeCleanup = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (Array.isArray(message.content) && message.content.length === 0) {
      messages.splice(i, 1);
    }
  }
  const emptyMessagesRemoved = lengthBeforeCleanup - messages.length;

  log.debug({
    totalPairs: completePairs.length,
    removed: removeCount,
    kept: completePairs.length - removeCount,
    emptyMessagesRemoved,
  }, 'Tool pair pruning complete');

  // 8. Validate role alternation (warn but don't fix — caller may handle)
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === messages[i - 1].role) {
      log.warn({
        index: i,
        role: messages[i].role,
        totalMessages: messages.length,
      }, 'Consecutive same-role messages after pruning');
      break; // One warning is enough
    }
  }

  return removeCount;
}
