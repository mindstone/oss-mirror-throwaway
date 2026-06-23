/**
 * Lightweight WHY text generator for memory approvals in the Automations panel.
 *
 * Adapts the flattened `AutomationApprovalItem.memoryApproval` shape to produce
 * Rebel-voice explanations, mirroring the logic in `memoryExplanation.ts` without
 * requiring the full `MemoryWriteApprovalRequest` type.
 */

import { getSharingLabel } from '@renderer/features/agent-session/utils/memoryExplanation';
import { getCredentialLabel } from '@rebel/shared';
import type { FileLocation } from '@rebel/shared';

interface MemoryApprovalFields {
  spaceName: string;
  sensitivityReason?: string;
  sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
  privateMode?: boolean;
  hasSpaceOverride?: boolean;
  approvalKind?: 'memory_write' | 'shared_skill_checkpoint';
  authorLabel?: string;
  /** Resolved file location — used to detect outside-workspace files. */
  location?: FileLocation;
}

/**
 * Generate a Rebel-voice "why" explanation for a memory approval.
 * Returns undefined if no meaningful explanation can be constructed.
 */
export function getMemoryWhyText(fields: MemoryApprovalFields): string | undefined {
  const { spaceName, sensitivityReason, sharing, privateMode, hasSpaceOverride, approvalKind, authorLabel, location } = fields;

  if (approvalKind === 'shared_skill_checkpoint') {
    const byline = authorLabel ? ` by ${authorLabel}` : '';
    return `This is a shared skill${byline}. Edits take effect for everyone using it.`;
  }

  if (privateMode) {
    return "You've got Privacy Mode on — I check everything, no exceptions.";
  }

  if (sensitivityReason) {
    const humanLabel = getCredentialLabel(sensitivityReason);

    if (sensitivityReason === 'non_inspectable_bash') {
      return "This is a command where I can't preview what gets written. Just want to make sure it's what you expect.";
    }

    if (sharing !== 'private') {
      const audience = getSharingLabel(sharing);
      return `I spotted ${humanLabel}, and ${spaceName} is visible to ${audience}. Worth a quick check before saving.`;
    }

    return `I spotted ${humanLabel} in this save. Probably nothing to worry about — just making sure you didn't accidentally include something sensitive.`;
  }

  if (hasSpaceOverride) {
    return `You've set ${spaceName} to always check. Your rules, I follow.`;
  }

  if (location?.kind === 'outside-workspace') {
    return `This file isn\u2019t in one of your Spaces, so I\u2019m checking before saving.`;
  }

  if (sharing !== 'private') {
    const audience = getSharingLabel(sharing);
    return `${spaceName} is visible to ${audience}. I check before saving to shared spaces.`;
  }

  return undefined;
}
