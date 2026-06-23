/**
 * buildMemoryBlockedAction — pure helper that constructs a `BlockedActionContext`
 * from memory-write approval data.
 *
 * Moved from `src/renderer/components/approval/hooks/buildMemoryBlockedAction.ts`
 * in Stage 4 of the approval consolidation plan
 * (`docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`). The file is
 * kept under `hooks/` for symmetry with `usePrincipleOptions.ts`, but it is not
 * actually a React hook — it's a deterministic, dependency-free function that
 * the hook consumes.
 *
 * Why it lives in `@rebel/cloud-client`:
 *  - It's used by both desktop `UnifiedApprovalCard` and mobile approval sheets.
 *  - It depends on `@rebel/shared/credentialLabels` (also cross-surface) and on
 *    `BlockedActionContext` (defined in `@rebel/cloud-client/transport`).
 *  - Desktop keeps a one-line re-export wrapper at the original renderer path
 *    so existing consumers (and the dynamic import in
 *    `src/core/__tests__/safetyPromptLogic.test.ts`) keep working unchanged.
 */

import { getCredentialLabel, type FileLocation } from '@rebel/shared';
import type { BlockedActionContext } from '../transport/approvalTransport';

function describeSharingLevel(sharing: string | undefined): string {
  switch (sharing) {
    case 'private':
      return 'private — only you can see this';
    case 'restricted':
      return 'team sharing — visible to team members';
    case 'company-wide':
      return 'company-wide — visible to everyone in the organization';
    case 'public':
      return 'public — visible to anyone';
    default:
      return 'restricted sharing';
  }
}

export function buildMemoryBlockedAction(memoryApproval: {
  spaceName: string;
  filePath: string;
  sharing?: string;
  sensitivityReason?: string;
  spacePath?: string;
  location?: FileLocation;
  contentSummary?: string;
}): BlockedActionContext {
  let reason = `Memory write to "${memoryApproval.spaceName}"`;
  if (memoryApproval.sensitivityReason) {
    const humanLabel = getCredentialLabel(memoryApproval.sensitivityReason);
    reason += ` — spotted ${humanLabel}`;
  }
  if (memoryApproval.sharing && memoryApproval.sharing !== 'private') {
    reason += ` (${memoryApproval.sharing} sharing)`;
  }

  const toolInput: Record<string, unknown> = {
    spaceName: memoryApproval.spaceName,
    filePath: memoryApproval.filePath,
    sharing: memoryApproval.sharing,
    spacePath: memoryApproval.location?.kind === 'in-space'
      ? memoryApproval.location.workspaceRelativePath
      : memoryApproval.spacePath,
  };

  if (memoryApproval.sensitivityReason) {
    toolInput.sensitivityReason = memoryApproval.sensitivityReason;
  }

  if (memoryApproval.contentSummary) {
    toolInput.contentSummary = memoryApproval.contentSummary.slice(0, 200);
  }

  return {
    toolName: 'memory_write',
    toolInput,
    blockReason: reason,
    spaceDescription: `Space "${memoryApproval.spaceName}" (${describeSharingLevel(memoryApproval.sharing)})`,
  };
}
