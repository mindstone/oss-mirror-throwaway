import type { PendingApprovalItem } from '../../hooks/usePendingApprovals';
import type { StagedFileItem } from '../../hooks/useStagedFiles';

function isStagedFileSourceItem(item: PendingApprovalItem | StagedFileItem): item is StagedFileItem {
  return 'realPath' in item && 'baseHash' in item;
}

export interface ApprovalDecisionState {
  isSafetyBlock: boolean;
  isEvalError: boolean;
}

export function getApprovalDecisionState(
  item: PendingApprovalItem | StagedFileItem | null | undefined,
): ApprovalDecisionState {
  if (!item) {
    return { isSafetyBlock: false, isEvalError: false };
  }

  if (isStagedFileSourceItem(item)) {
    const isEvalError = item.blockedBy === 'eval_error';
    return {
      isSafetyBlock: item.blockedBy === 'safety_prompt' || isEvalError,
      isEvalError,
    };
  }

  if (item.type === 'tool') {
    const isEvalError = item.toolApproval?.blockedBy === 'eval_error';
    return {
      isSafetyBlock: item.toolApproval?.blockedBy === 'safety_prompt'
        || isEvalError,
      isEvalError,
    };
  }

  if (item.type === 'staged-tool') {
    const isEvalError = item.stagedToolCall?.blockedBy === 'eval_error';
    return {
      isSafetyBlock: item.stagedToolCall?.blockedBy === 'safety_prompt'
        || isEvalError,
      isEvalError,
    };
  }

  if (item.type === 'memory') {
    const isEvalError = item.memoryApproval?.blockedBy === 'eval_error';
    return {
      isSafetyBlock: item.memoryApproval?.blockedBy === 'safety_prompt' || isEvalError,
      isEvalError,
    };
  }

  return { isSafetyBlock: false, isEvalError: false };
}
