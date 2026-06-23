import { useId } from 'react';
import type { ActionPreviewModel } from '@rebel/shared';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui';
import {
  ActionPreview,
  type ActionPreviewState,
  getActionPreviewReasonText,
  getActionPreviewSummary,
  getActionPreviewTitle,
} from './ActionPreview';
import styles from './ActionPreviewDialog.module.css';

const DIALOG_WITHHELD_COPY = 'Content hidden for privacy. Rebel can still show where this goes and who can see it.';

export interface ActionPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: ActionPreviewModel;
  toolName?: string;
  reason?: string;
  state?: ActionPreviewState;
  stateMessage?: string;
  errorMessage?: string;
  onRetry?: () => void;
  revealedContent?: string | null;
  onDiscard?: () => void;
  onAllow?: () => void;
  onAllowForConversation?: () => void;
  onAllowAndRemember?: () => void;
  onChangeRequest?: () => void;
  allowDisabled?: boolean;
  allowLabel?: string;
  discardLabel?: string;
  showAllowForConversation?: boolean;
  showAllowAndRemember?: boolean;
  onOpenSafetyRules?: () => void;
}

function renderReasonWithSafetyRulesLink(
  reasonText: string,
  onOpenSafetyRules?: () => void,
) {
  const safetyRulesLabel = 'Safety Rules';
  const [before, after] = reasonText.split(safetyRulesLabel);

  if (!after) {
    return reasonText;
  }

  return (
    <>
      {before}
      {onOpenSafetyRules ? (
        <button
          type="button"
          className={styles.settingsLink}
          onClick={onOpenSafetyRules}
          data-testid="action-preview-safety-rules-link"
        >
          {safetyRulesLabel}
        </button>
      ) : safetyRulesLabel}
      {after}
    </>
  );
}

export const ActionPreviewDialog = ({
  open,
  onOpenChange,
  model,
  toolName,
  reason,
  state = 'ready',
  stateMessage,
  errorMessage,
  onRetry,
  revealedContent,
  onDiscard,
  onAllow,
  onAllowForConversation,
  onAllowAndRemember,
  onChangeRequest,
  allowDisabled = false,
  allowLabel = 'Allow',
  discardLabel = 'Discard',
  showAllowForConversation = true,
  showAllowAndRemember = true,
  onOpenSafetyRules,
}: ActionPreviewDialogProps) => {
  const hideDecisionCtas = state === 'no-longer-waiting';
  const showDiscardButton = !hideDecisionCtas && typeof onDiscard === 'function';
  const showAllowForConversationButton = !hideDecisionCtas
    && showAllowForConversation
    && typeof onAllowForConversation === 'function';
  const showAllowAndRememberButton = !hideDecisionCtas
    && showAllowAndRemember
    && typeof onAllowAndRemember === 'function';
  const showChangeRequestButton = !hideDecisionCtas && typeof onChangeRequest === 'function';
  const showAllowButton = !hideDecisionCtas && typeof onAllow === 'function';
  // "Allow and remember" is the hero. When it is present, the one-time "Allow"
  // steps back to a quiet outline; otherwise "Allow" carries the primary accent.
  const allowAndRememberIsPrimary = showAllowAndRememberButton;
  const titleId = useId();
  const title = getActionPreviewTitle(model);
  const reasonText = getActionPreviewReasonText(reason);
  const description = reasonText
    ? renderReasonWithSafetyRulesLink(`Because ${reasonText}`, onOpenSafetyRules)
    : getActionPreviewSummary(model.effectKind);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} ariaLabelledBy={titleId}>
      <DialogContent size="lg" className={styles.dialogContent} data-testid="action-preview-dialog">
        <DialogHeader
          className={styles.dialogHeader}
          onClose={() => onOpenChange(false)}
        >
          <DialogTitle id={titleId}>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className={styles.dialogBody}>
          <ActionPreview
            model={model}
            toolName={toolName}
            reason={reason}
            state={state}
            stateMessage={stateMessage}
            errorMessage={errorMessage}
            onRetry={onRetry}
            revealedContent={revealedContent}
            showHeader={false}
            showWhy={false}
            withheldCopy={DIALOG_WITHHELD_COPY}
          />
        </DialogBody>

        <DialogFooter className={styles.dialogFooter}>
          {hideDecisionCtas ? (
            <>
              <div className={styles.footerSpacer} />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
                data-testid="action-preview-cancel-button"
              >
                Close
              </Button>
            </>
          ) : (
            <>
              {showDiscardButton ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onDiscard}
                  data-testid="action-preview-discard-button"
                >
                  {discardLabel}
                </Button>
              ) : null}
              <div className={styles.footerSpacer} />
              {showChangeRequestButton ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onChangeRequest}
                  disabled={allowDisabled}
                  data-testid="action-preview-change-request-button"
                >
                  Change request
                </Button>
              ) : null}
              {showAllowForConversationButton ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onAllowForConversation}
                  disabled={allowDisabled}
                  data-testid="action-preview-allow-for-conversation-button"
                >
                  Allow for conversation
                </Button>
              ) : null}
              {showAllowButton ? (
                <Button
                  variant={allowAndRememberIsPrimary ? 'outline' : 'default'}
                  size="sm"
                  onClick={onAllow}
                  disabled={allowDisabled}
                  data-testid="action-preview-allow-button"
                >
                  {allowLabel}
                </Button>
              ) : null}
              {showAllowAndRememberButton ? (
                <Button
                  variant="default"
                  size="sm"
                  onClick={onAllowAndRemember}
                  disabled={allowDisabled}
                  data-testid="action-preview-allow-and-remember-button"
                >
                  Allow and remember
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
