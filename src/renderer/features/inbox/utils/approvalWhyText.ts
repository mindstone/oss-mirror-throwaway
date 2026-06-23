/**
 * approvalWhyText
 *
 * Human-readable explanation of *why* a given approval is blocked / needs
 * review. Extracted here (vs inline in `DrawerApprovalCard`) so multiple card
 * surfaces can render the same copy AND pipe the same string into analytics
 * (`computeApprovalFacets.whyText`) — otherwise the drawer and the strip can
 * disagree about whether a given approvalId is `thinFacets: true`, which
 * contaminates the R17 promotion-gate subset calculation.
 *
 * This is also the preparatory-refactor direction called out in
 * docs/plans/260419_approval_card_clarity_improvements.md § Preparatory
 * Refactor — Phase 2 (R4) will build the structured-facet list on top of the
 * same source of truth.
 */

import type { StagedFileItem } from '../hooks/useStagedFiles';
import { getSharingLabel } from '@renderer/features/agent-session/utils/memoryExplanation';
import { buildEvalErrorUserReason } from '@shared/safety/evalErrorCopy';

export function getStagedFileWhyText(stagedFile: StagedFileItem): string | undefined {
  if (stagedFile.approvalKind === 'shared_skill_checkpoint') {
    const byline = stagedFile.authorLabel ? ` by ${stagedFile.authorLabel}` : '';
    return `This is a shared skill${byline}. Edits take effect for everyone using it.`;
  }

  switch (stagedFile.blockedBy) {
    case 'safety_prompt':
      return `Your safety rules flagged saving "${stagedFile.fileName}" to ${stagedFile.spaceName}.`;
    case 'sensitivity_eval':
      return 'I spotted content that might be sensitive. Worth a quick check before publishing.';
    case 'structural_policy':
      return 'This space requires approval for all saves.';
    case 'eval_error':
      return buildEvalErrorUserReason();
    default: {
      if (stagedFile.sharing && stagedFile.sharing !== 'private') {
        const audience = getSharingLabel(stagedFile.sharing);
        return `${stagedFile.spaceName} is visible to ${audience}. I check before saving to shared spaces.`;
      }
      return undefined;
    }
  }
}
