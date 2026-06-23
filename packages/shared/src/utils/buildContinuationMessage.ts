/**
 * Build continuation messages for memory write approvals/discards.
 *
 * CRITICAL: These messages tell Claude that the user approved/declined the write,
 * but the operation has NOT been executed yet. Claude must re-run the
 * operation to complete it.
 *
 * Previous bug: Message said "Committing this to..." which made Claude
 * think the write had already happened, causing an infinite approval loop.
 */

export interface ApprovalInfo {
  spaceName: string;
  filePath: string;
  content: string;
  approvalKind?: 'memory_write' | 'shared_skill_checkpoint';
}

export interface DiscardInfo {
  spaceName: string;
  filePath: string;
}

/**
 * Build discard feedback message for declined memory writes.
 *
 * Sent as a system continuation so the agent knows the user declined
 * and does not retry the same write.
 */
export function buildDiscardMessage(discards: DiscardInfo[]): string {
  if (discards.length === 0) return '';

  if (discards.length === 1) {
    const { spaceName, filePath } = discards[0];
    return `User chose not to save to ${spaceName} (${filePath}). Don't retry.`;
  }

  const listing = discards
    .map(({ spaceName, filePath }) => `- ${spaceName} (${filePath})`)
    .join('\n');

  return `User declined the following memory writes. Don't retry these.\n\n${listing}`;
}

/**
 * Build continuation message for approved memory writes.
 *
 * The message clearly instructs Claude that:
 * 1. The user approved the write
 * 2. The operation has NOT been executed yet
 * 3. Claude must re-run the operation to complete it
 */
export function buildContinuationMessage(approvals: ApprovalInfo[]): string {
  if (approvals.length === 0) return '';

  if (approvals.length === 1 && approvals[0].approvalKind === 'shared_skill_checkpoint') {
    const { spaceName, filePath, content } = approvals[0];
    return `User confirmed the shared-skill checkpoint for ${spaceName}.

IMPORTANT: The write has NOT happened yet. Re-run the operation once to update the approved shared skill.

Target: ${filePath}
---
${content}
---

Retry this operation once now. Do not ask again unless the file changes and the checkpoint is raised anew.`;
  }

  if (approvals.length === 1) {
    const { spaceName, filePath, content } = approvals[0];
    return `User approved the write to ${spaceName}.

IMPORTANT: The operation has NOT been executed yet. You must now re-run the operation to complete it.

Target: ${filePath}
---
${content}
---

Re-execute this operation now to complete the approved write.`;
  }

  // Multiple approvals
  const details = approvals
    .map(
      ({ spaceName, filePath, content }, i) =>
        `${i + 1}. ${spaceName}: ${filePath}
---
${content}
---`
    )
    .join('\n\n');

  return `User approved ${approvals.length} writes.

IMPORTANT: These operations have NOT been executed yet. You must now re-run each operation to complete them.

${details}

Re-execute these operations now to complete the approved writes.`;
}
