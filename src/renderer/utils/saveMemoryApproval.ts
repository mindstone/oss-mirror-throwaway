/**
 * Shared utility for saving memory approvals.
 * Used by both Inbox and the Library (Show: Memory) to avoid code duplication.
 */

import { buildContinuationMessage, buildDiscardMessage } from '@renderer/features/agent-session/utils/buildContinuationMessage';
import { dispatchAgentTurn } from '@renderer/features/agent-session/utils/dispatchAgentTurn';
import { toUserFacingActionErrorReason } from './actionErrorMessage';

export interface MemoryApprovalData {
  toolUseId: string;
  originalSessionId: string;
  filePath: string;
  spaceName: string;
  content: string;
  approvalKind?: 'memory_write' | 'shared_skill_checkpoint';
  /** True when content was already staged to CoS pending — skip continuation (FM #15) */
  staged?: boolean;
}

export interface MemoryApprovalResult {
  ok: boolean;
  reason?: 'ipc-failed' | 'continuation-failed';
  detail?: string;
}

/**
 * Save a memory approval and trigger the agent continuation.
 * Returns a typed result distinguishing IPC failures (real error) from
 * continuation failures (approval stored, agent will retry — not a user error).
 *
 * @param sendContinuation - Optional callback to route the continuation message
 *   through the renderer queue instead of dispatching a turn directly.
 *   When omitted, falls back to `dispatchAgentTurn` with an explicit
 *   `'reject'` admission policy (backward-compatible for Library Show: Memory callers).
 */
export async function saveMemoryApproval(
  approval: MemoryApprovalData,
  sendContinuation?: (sessionId: string, message: string, receiptText?: string) => Promise<void> | void,
): Promise<MemoryApprovalResult> {
  try {
    // 1. Store approval (so retry succeeds)
    const result = await window.api.sendMemoryWriteApprovalResponse({
      toolUseId: approval.toolUseId,
      approved: true,
    });

    // Check if the IPC call succeeded
    if (!result.success) {
      const detail = toUserFacingActionErrorReason(
        (result as { error?: string }).error,
        'The approval could not be saved.',
      );
      console.error('Memory approval response failed:', { toolUseId: approval.toolUseId, detail });
      return { ok: false, reason: 'ipc-failed', detail };
    }

    // 2. Build and send continuation message — but NOT for staged items (FM #15).
    // Staged items already have their content in CoS pending; the agent does not
    // need a retry-trigger continuation. Publishing happens through the staged
    // file flow, not through agent retry.
    if (!approval.staged) {
      // Use ?? for content to handle valid empty strings
      const effectiveSpaceName = result.spaceName ?? approval.spaceName;
      const message = buildContinuationMessage([
        {
          spaceName: effectiveSpaceName,
          filePath: result.filePath ?? approval.filePath,
          content: result.content ?? approval.content,
          approvalKind: approval.approvalKind,
        },
      ]);

      // 3. Send continuation — use callback if provided, else direct IPC.
      // Continuation is best-effort: approval is already stored at this point.
      try {
        const receipt = `Approved: save to ${effectiveSpaceName}`;
        if (sendContinuation) {
          await Promise.resolve(sendContinuation(approval.originalSessionId, message, receipt));
        } else {
          // 'reject': the approval is already stored — never cancel a turn
          // the user has since started just to deliver the retry trigger.
          await dispatchAgentTurn({
            sessionId: approval.originalSessionId,
            prompt: message,
            isSystemContinuation: true,
          }, { policy: 'reject' });
        }
      } catch (continuationErr) {
        console.warn('Memory approved but continuation failed — agent will retry on next interaction:', continuationErr);
        return { ok: true, reason: 'continuation-failed' };
      }
    }

    return { ok: true };
  } catch (err) {
    console.error('Failed to save memory approval:', err);
    return {
      ok: false,
      reason: 'ipc-failed',
      detail: toUserFacingActionErrorReason(err, 'The approval could not be saved.'),
    };
  }
}

export interface MemoryDiscardData {
  toolUseId: string;
  originalSessionId: string;
  filePath: string;
  spaceName: string;
}

/**
 * Discard a memory approval and send feedback to the originating conversation.
 * Returns true once the IPC deny succeeds — the discard has taken effect at
 * that point. The follow-up feedback message is BEST-EFFORT: a delivery
 * failure (e.g. a typed busy refusal of the informational turn) is logged but
 * never reported as a failed discard, otherwise callers like
 * `usePendingApprovals.dismissApproval` show a false "Failed to dismiss" and
 * strand stale UI after the deny already landed (Stage 3 review F1).
 *
 * @param sendContinuation - Optional callback to route the discard message
 *   through the renderer queue. Falls back to direct IPC when omitted.
 */
export async function discardMemoryApproval(
  discard: MemoryDiscardData,
  sendContinuation?: (sessionId: string, message: string) => Promise<void> | void,
): Promise<boolean> {
  try {
    // 1. Deny the approval via IPC
    const result = await window.api.sendMemoryWriteApprovalResponse({
      toolUseId: discard.toolUseId,
      approved: false,
    });

    if (!result.success) {
      console.error('Memory discard response failed:', { toolUseId: discard.toolUseId });
      return false;
    }

    // 2. Build and send discard feedback message — best-effort AFTER the
    // successful deny. The discard itself is already done.
    const message = buildDiscardMessage([{
      spaceName: discard.spaceName,
      filePath: discard.filePath,
    }]);

    try {
      if (sendContinuation) {
        await Promise.resolve(sendContinuation(discard.originalSessionId, message));
      } else {
        // 'reject': discard feedback is informational — never cancel a
        // running turn to deliver it. A busy-target refusal lands here and is
        // deliberately NOT a discard failure.
        await dispatchAgentTurn({
          sessionId: discard.originalSessionId,
          prompt: message,
          isSystemContinuation: true,
        }, { policy: 'reject' });
      }
    } catch (feedbackErr) {
      console.warn(
        'Memory discarded but feedback message failed — agent will observe the denial on its next interaction:',
        feedbackErr,
      );
    }

    return true;
  } catch (err) {
    console.error('Failed to discard memory approval:', err);
    return false;
  }
}
