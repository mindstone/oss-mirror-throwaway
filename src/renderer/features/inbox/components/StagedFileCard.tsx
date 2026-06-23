import { memo, useCallback, useEffect, useState } from 'react';
import { FileText, Check, X, Eye, ShieldCheck } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  FileLocationBadge,
  DialogHeader,
  DialogTitle,
  Input,
  Tooltip,
} from '@renderer/components/ui';
import { SharingBadge } from '@renderer/components/approval/primitives';
import { buildMemoryBlockedAction, usePrincipleOptions } from '@rebel/cloud-client';
import { legacyMissingLocation } from '@rebel/shared';
import { useDesktopApprovalTransport } from '@renderer/transport/useDesktopApprovalTransport';
import { SCOPE_LABELS, DENY_SCOPE_LABELS } from '@renderer/components/approval/scopeLabels';
import { tracking } from '@renderer/src/tracking';
import {
  recordFirstSeen as tallyRecordFirstSeen,
  markPreviewed as tallyMarkPreviewed,
} from '../hooks/useApprovalInteractionTally';
import { computeApprovalFacets, narrowSharing } from '../utils/approvalFacetAnalysis';
import { getStagedFileWhyText } from '../utils/approvalWhyText';
import type { StagedFileItem } from '../hooks/useStagedFiles';
import styles from './ApprovalCard.module.css';

export type StagedFileCardProps = {
  file: StagedFileItem;
  onApprove: () => void;
  onDeny: () => void;
  onPreview: () => void;
};

const StagedFileCardComponent = ({ file, onApprove, onDeny, onPreview }: StagedFileCardProps) => {
  const [showRuleUpdateDialog, setShowRuleUpdateDialog] = useState(false);
  const [showDenyRuleUpdateDialog, setShowDenyRuleUpdateDialog] = useState(false);
  const timeAgo = formatDistanceToNow(file.stagedAt, { addSuffix: true });
  const title = file.sessionTitle || file.fileName;
  const isNewFile = file.baseHash === 'new-file';
  const isSafetyPromptBlocked = file.blockedBy === 'safety_prompt';
  const isEvalError = file.blockedBy === 'eval_error';
  const evalErrorText = isEvalError ? getStagedFileWhyText(file) : undefined;

  // Analytics: tally-keyed to match NotificationDrawer's composite id so a
  // staged file appearing in both surfaces fires `Approval Card Viewed` once
  // AND with an identical payload — the drawer derives `whyText` from
  // `getStagedFileWhyText`, so the strip must too or `thinFacets` flips
  // depending on which surface mounted first.
  const approvalId = `staged-file:${file.id}`;
  const analyticsSharing = narrowSharing(file.sharing);

  useEffect(() => {
    if (!tallyRecordFirstSeen(approvalId)) return;
    const facets = computeApprovalFacets({
      summary: file.summary,
      whyText: getStagedFileWhyText(file),
      hasStructuredFacets: false,
    });
    tracking.approvals.cardViewed({
      approvalType: 'staged-file',
      blockedBy: file.blockedBy,
      sharing: analyticsSharing,
      hasContentPreview: facets.hasContentPreview,
      hasWithheldPreview: facets.hasWithheldPreview,
      hasWhyFacets: facets.hasWhyFacets,
      thinFacets: facets.thinFacets,
    });
  }, [approvalId, file, analyticsSharing]);

  const handlePreview = useCallback(() => {
    tallyMarkPreviewed(approvalId);
    tracking.approvals.previewContentClicked({
      approvalType: 'staged-file',
      previewSource: 'dialog',
    });
    onPreview();
  }, [approvalId, onPreview]);
  const location = file.location
    ?? legacyMissingLocation({
      fileName: file.fileName,
      spaceName: file.spaceName,
      legacyPath: file.spacePath || file.realPath,
    });

  const blockedAction = isSafetyPromptBlocked
    ? buildMemoryBlockedAction({
        spaceName: file.spaceName,
        filePath: file.realPath,
        sharing: file.sharing,
        spacePath: file.spacePath,
        location,
        contentSummary: file.summary,
      })
    : null;

  const transport = useDesktopApprovalTransport();

  const principleOptions = usePrincipleOptions({
    blockedAction,
    effectiveToolId: null,
    onApprove: () => {
      setShowRuleUpdateDialog(false);
      onApprove();
    },
    transport,
  });

  const denyPrincipleOptions = usePrincipleOptions({
    blockedAction,
    effectiveToolId: null,
    direction: 'deny',
    onApprove: onDeny,
    onDeny: () => {
      setShowDenyRuleUpdateDialog(false);
      onDeny();
    },
    transport,
  });

  const handleAllowAndChooseRuleUpdate = useCallback(() => {
    setShowDenyRuleUpdateDialog(false);
    setShowRuleUpdateDialog(true);
    principleOptions.startGeneration();
  }, [principleOptions]);

  const handleCloseRuleUpdateDialog = useCallback(() => {
    setShowRuleUpdateDialog(false);
    principleOptions.goBack();
  }, [principleOptions]);

  const handleDenyAndChooseRuleUpdate = useCallback(() => {
    setShowRuleUpdateDialog(false);
    setShowDenyRuleUpdateDialog(true);
    denyPrincipleOptions.startGeneration();
  }, [denyPrincipleOptions]);

  const handleCloseDenyRuleUpdateDialog = useCallback(() => {
    setShowDenyRuleUpdateDialog(false);
    denyPrincipleOptions.goBack();
  }, [denyPrincipleOptions]);

  return (
    <div className={styles.card} onClick={handlePreview} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePreview(); } }} style={{ cursor: 'pointer' }}>
      <div className={styles.cardHeader}>
        <FileText className={styles.cardIcon} size={16} />
        <span className={styles.cardTitle}>{title}</span>
        <span className={styles.cardTime}>{timeAgo}</span>
      </div>
      <div className={styles.memoryDestination}>
        <FileLocationBadge location={location} />
        <SharingBadge sharing={narrowSharing(file.sharing) ?? 'unclear'} />
      </div>
      {file.summary && (
        <p className={styles.cardDescription}>
          {file.summary}
        </p>
      )}
      {evalErrorText && (
        <p className={styles.cardDescription}>
          {evalErrorText}
        </p>
      )}
      <div className={styles.cardActions}>
        {/* Deny redirects this write to private memory (no deletion). */}
        <Tooltip
          content={isEvalError
            ? 'Do not save this to the target Space'
            : 'Deny this write to the target space and save it privately instead'}
          placement="top"
          delayShow={300}
        >
          <button
            type="button"
            className={styles.dontRunButton}
            onClick={(e) => { e.stopPropagation(); isSafetyPromptBlocked ? handleDenyAndChooseRuleUpdate() : onDeny(); }}
          >
            <X size={14} />
            {isSafetyPromptBlocked ? 'Deny\u2026' : isEvalError ? "Don't save this" : 'Deny'}
          </button>
        </Tooltip>

        {/* Preview: opens the diff/content preview dialog */}
        <Tooltip content="Preview full content and changes" placement="top" delayShow={300}>
          <button
            type="button"
            className={styles.previewButton}
            onClick={(e) => { e.stopPropagation(); handlePreview(); }}
          >
            <Eye size={14} />
            Preview
          </button>
        </Tooltip>

        {isSafetyPromptBlocked && (
          <Tooltip content="Allow this write and choose how to update your safety rules" placement="top" delayShow={300}>
            <button
              type="button"
              className={styles.reviewButton}
              onClick={(e) => { e.stopPropagation(); handleAllowAndChooseRuleUpdate(); }}
            >
              <ShieldCheck size={14} />
              Allow &amp; choose rule update…
            </button>
          </Tooltip>
        )}
        
        {/* Right: Primary action */}
        <Tooltip 
          content={isEvalError
            ? `Save to ${file.spaceName} once without the unfinished safety check`
            : isNewFile ? `Allow new file in ${file.spaceName}` : `Allow changes in ${file.spaceName}`} 
          placement="top" 
          delayShow={300}
        >
          <button
            type="button"
            className={styles.saveButton}
            onClick={(e) => { e.stopPropagation(); onApprove(); }}
          >
            <Check size={14} />
            {isEvalError ? 'Save it once' : 'Allow'}
          </button>
        </Tooltip>
      </div>

      {isSafetyPromptBlocked && (
        <Dialog open={showRuleUpdateDialog} onOpenChange={(open) => !open && handleCloseRuleUpdateDialog()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Allow &amp; choose rule update</DialogTitle>
              <DialogDescription>
                Choose how broadly to allow similar staged memory writes in the future.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              {principleOptions.generationState === 'loading' && <p>Generating options…</p>}

              {principleOptions.generationState === 'error' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <p>{principleOptions.generationError || 'Unable to generate options'}</p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button size="sm" variant="outline" onClick={principleOptions.retryGeneration}>
                      Retry
                    </Button>
                    <Button size="sm" onClick={principleOptions.approveOnce}>
                      Allow
                    </Button>
                  </div>
                </div>
              )}

              {principleOptions.generationState === 'loaded' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {principleOptions.options.map((opt, idx) => {
                    const { label: scopeLabel, icon: ScopeIcon } = SCOPE_LABELS[opt.scope];

                    return (
                      <Button
                        key={opt.scope}
                        size="sm"
                        variant={principleOptions.selectedOption === idx ? 'default' : 'outline'}
                        onClick={() => principleOptions.selectOption(idx)}
                        style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                      >
                        <ScopeIcon size={10} /><strong>{scopeLabel}:</strong>&nbsp;{opt.label}
                      </Button>
                    );
                  })}

                  <Button
                    size="sm"
                    variant={principleOptions.selectedOption === 'other' ? 'default' : 'outline'}
                    onClick={() => principleOptions.selectOption('other')}
                    style={{ justifyContent: 'flex-start' }}
                  >
                    Custom
                  </Button>

                  {principleOptions.selectedOption === 'other' && (
                    <Input
                      value={principleOptions.otherText}
                      onChange={(e) => principleOptions.setOtherText(e.target.value)}
                      placeholder="Type your own rule…"
                    />
                  )}

                  {principleOptions.applyState === 'confirming_trust' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <p>Saves to this space will always be allowed without safety checks. Are you sure?</p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Button size="sm" variant="outline" onClick={principleOptions.cancelTrustedTool}>Back</Button>
                        <Button size="sm" onClick={principleOptions.confirmTrustedTool}>Yes, always allow</Button>
                      </div>
                    </div>
                  )}

                  {principleOptions.applyState === 'applying' && <p>Applying…</p>}

                  {principleOptions.applyState === 'error' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <p>{principleOptions.applyError || 'Failed to apply selection'}</p>
                      <Button size="sm" variant="outline" onClick={principleOptions.retryApply}>
                        Retry
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={handleCloseRuleUpdateDialog}>Cancel</Button>
              {principleOptions.generationState === 'loaded'
                && principleOptions.applyState === 'idle'
                && principleOptions.selectedOption !== null && (
                  <Button
                    onClick={principleOptions.confirmSelection}
                    disabled={principleOptions.selectedOption === 'other' && !principleOptions.otherText.trim()}
                  >
                    Save &amp; allow
                  </Button>
                )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {isSafetyPromptBlocked && (
        <Dialog open={showDenyRuleUpdateDialog} onOpenChange={(open) => !open && handleCloseDenyRuleUpdateDialog()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Deny &amp; choose rule update</DialogTitle>
              <DialogDescription>
                Choose how broadly to block similar staged memory writes in the future.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              {denyPrincipleOptions.generationState === 'loading' && <p>Generating options…</p>}

              {denyPrincipleOptions.generationState === 'error' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <p>{denyPrincipleOptions.generationError || 'Unable to generate options'}</p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button size="sm" variant="outline" onClick={denyPrincipleOptions.retryGeneration}>
                      Retry
                    </Button>
                    <Button size="sm" onClick={denyPrincipleOptions.resolveOnce}>
                      Deny
                    </Button>
                  </div>
                </div>
              )}

              {denyPrincipleOptions.generationState === 'loaded' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {denyPrincipleOptions.options.map((opt, idx) => {
                    const { label: scopeLabel, icon: ScopeIcon } = DENY_SCOPE_LABELS[opt.scope];

                    return (
                      <Button
                        key={opt.scope}
                        size="sm"
                        variant={denyPrincipleOptions.selectedOption === idx ? 'default' : 'outline'}
                        onClick={() => denyPrincipleOptions.selectOption(idx)}
                        style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                      >
                        <ScopeIcon size={10} /><strong>{scopeLabel}:</strong>&nbsp;{opt.label}
                      </Button>
                    );
                  })}

                  <Button
                    size="sm"
                    variant={denyPrincipleOptions.selectedOption === 'other' ? 'default' : 'outline'}
                    onClick={() => denyPrincipleOptions.selectOption('other')}
                    style={{ justifyContent: 'flex-start' }}
                  >
                    Custom
                  </Button>

                  {denyPrincipleOptions.selectedOption === 'other' && (
                    <Input
                      value={denyPrincipleOptions.otherText}
                      onChange={(e) => denyPrincipleOptions.setOtherText(e.target.value)}
                      placeholder="Type your own rule…"
                    />
                  )}

                  {denyPrincipleOptions.applyState === 'confirming_trust' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <p>This will always be blocked by your safety rules. Are you sure?</p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <Button size="sm" variant="outline" onClick={denyPrincipleOptions.cancelTrustedTool}>Back</Button>
                        <Button
                          size="sm"
                          onClick={denyPrincipleOptions.confirmTrustedTool}
                          style={{ background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.9) 0%, rgba(220, 38, 38, 0.9) 100%)' }}
                        >
                          Yes, always block
                        </Button>
                      </div>
                    </div>
                  )}

                  {denyPrincipleOptions.applyState === 'applying' && <p>Applying…</p>}

                  {denyPrincipleOptions.applyState === 'error' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <p>{denyPrincipleOptions.applyError || 'Failed to apply selection'}</p>
                      <Button size="sm" variant="outline" onClick={denyPrincipleOptions.retryApply}>
                        Retry
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={handleCloseDenyRuleUpdateDialog}>Cancel</Button>
              {denyPrincipleOptions.generationState === 'loaded'
                && denyPrincipleOptions.applyState === 'idle'
                && denyPrincipleOptions.selectedOption !== null && (
                  <Button
                    onClick={denyPrincipleOptions.confirmSelection}
                    disabled={denyPrincipleOptions.selectedOption === 'other' && !denyPrincipleOptions.otherText.trim()}
                    style={{ background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.9) 0%, rgba(220, 38, 38, 0.9) 100%)' }}
                  >
                    Save &amp; deny
                  </Button>
                )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};

export const StagedFileCard = memo(StagedFileCardComponent);
StagedFileCard.displayName = 'StagedFileCard';
