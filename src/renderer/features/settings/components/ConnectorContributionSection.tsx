/**
 * Contribution status section for ExpandedConnectionCard.
 *
 * Shows the contribution lifecycle state for connectors built or extended
 * via Rebel. Includes a chat button to open the originating conversation.
 *
 * Returns null when the section shouldn't show (loading, no contribution,
 * or not connected).
 *
 * @see docs/plans/260414_p8_contribution_status_settings_card.md
 * @see docs/plans/260417_contribution_settings_card_actionable_status.md
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Package, CheckCircle2, XCircle, Clock, Gift, MessageSquare, Github } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  Tooltip,
  useToast,
} from '@renderer/components/ui';
import { useIsOssBuild } from '@renderer/hooks/useIsOssBuild';
import type { ConnectorContribution } from '../hooks/useConnectorContribution';
import type { ContributionStatus } from '@shared/utils/contributionStateMapping';
import { SUBMITTED_HELPER_TEXT, toSubmittedSubstatus } from '@shared/utils/contributionStateMapping';
import { formatConnectorDisplayName } from '@shared/utils/formatConnectorDisplayName';
import styles from './ConnectorContributionSection.module.css';

/**
 * Age threshold (ms) above which a contribution stuck at `testing` is shown
 * in the Settings "Stuck contributions" recovery affordance. Chosen to match
 * `STUCK_AGE_THRESHOLD_MS` in `contributionStartupSweep.ts` — anything younger
 * is likely still in-flight via an active promotion path.
 *
 * Tunable: if operators report stuck-UI appearing too eagerly for slow builds,
 * raise to 20-30 minutes.
 */
const STUCK_CONTRIBUTION_AGE_MS = 10 * 60 * 1_000;

/**
 * Whether a contribution should be treated as "stuck at testing" — i.e. it
 * entered testing but hasn't transitioned past it within the age threshold.
 * Exported for testability.
 */
export function isStuckTestingContribution(
  contribution: ConnectorContribution | null,
  now: number = Date.now(),
): boolean {
  if (!contribution) return false;
  if (contribution.status !== 'testing') return false;
  const reference = contribution.updatedAt ?? contribution.createdAt;
  if (!reference) return false;
  const parsed = new Date(reference).getTime();
  if (Number.isNaN(parsed)) return false;
  return now - parsed > STUCK_CONTRIBUTION_AGE_MS;
}

/**
 * Format an age (ms) as a compact human-readable relative string. Used in the
 * stuck-contribution row. Kept local to this module; the repo has no shared
 * relative-time util.
 */
function formatRelativeAge(ageMs: number): string {
  const minutes = Math.max(1, Math.round(ageMs / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ─── Pure eligibility helpers (exported for testability) ────────────

/**
 * Whether to show the contribution section at all.
 * Only shows when connected AND a contribution record exists.
 * The contribution record IS the "Rebel-built" signal.
 */
export function shouldShowContributionSection(
  isConnected: boolean,
  contribution: ConnectorContribution | null,
): boolean {
  return isConnected && contribution !== null;
}

/**
 * Whether to show the "Share with community" CTA.
 * Only for draft or ready_to_submit contributions.
 */
export function shouldShowShareCta(
  contribution: ConnectorContribution | null,
): boolean {
  if (!contribution) return false;
  return contribution.status === 'draft' || contribution.status === 'ready_to_submit';
}

// ─── Status display helpers ─────────────────────────────────────────

function getStatusLabel(status: ContributionStatus): string {
  switch (status) {
    case 'draft':
      return 'On your machine';
    case 'testing':
      return 'Still being made';
    case 'ready_to_submit':
      return 'Ready to share';
    case 'submitted':
      return 'Sent for review';
    case 'ci_pass':
      return 'Waiting on a reviewer';
    case 'ci_fail':
      return 'Checks need attention';
    case 'changes_requested':
      return 'Reviewer asked for tweaks';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Not accepted';
    case 'published':
      return 'Live';
  }
}

function getStatusIcon(status: ContributionStatus): React.ReactNode {
  switch (status) {
    case 'draft':
      return <Package size={13} className={styles.contributionStatusIcon} />;
    case 'testing':
      return <Loader2 size={13} className={`${styles.contributionStatusIcon} ${styles.spinnerIcon}`} />;
    case 'ready_to_submit':
      return <Gift size={13} className={styles.contributionStatusIcon} />;
    case 'submitted':
    case 'ci_pass':
      return <Clock size={13} className={styles.contributionStatusIcon} />;
    case 'ci_fail':
    case 'changes_requested':
    case 'rejected':
      return <XCircle size={13} className={styles.contributionStatusIcon} />;
    case 'approved':
    case 'published':
      return <CheckCircle2 size={13} className={styles.contributionStatusIcon} />;
  }
}

function getStatusTooltip(status: ContributionStatus): string {
  switch (status) {
    case 'draft':
      return 'This tool was made with Rebel and lives only on your machine';
    case 'testing':
      return 'Rebel is still getting this tool working';
    case 'ready_to_submit':
      return 'This tool is ready to share with other people';
    case 'submitted':
      return 'Your tool has been sent and is being reviewed';
    case 'ci_pass':
      return 'Checks passed — waiting on a reviewer';
    case 'ci_fail':
      return 'The checks found something — the team will follow up';
    case 'changes_requested':
      return 'Reviewers asked for tweaks to this tool';
    case 'approved':
      return 'Your tool was approved and should land soon';
    case 'rejected':
      return "This tool wasn't accepted for sharing with everyone";
    case 'published':
      return 'This tool is live for Rebel users';
  }
}

function getStatusClassName(status: ContributionStatus): string {
  switch (status) {
    case 'draft':
      return styles.statusDraft;
    case 'testing':
      return styles.statusTesting;
    case 'ready_to_submit':
      return styles.statusDraft;
    case 'submitted':
    case 'ci_pass':
      return styles.statusSubmitted;
    case 'ci_fail':
    case 'changes_requested':
      return styles.statusActionNeeded;
    case 'approved':
    case 'published':
      return styles.statusApproved;
    case 'rejected':
      return styles.statusRejected;
  }
}

// ─── Component ──────────────────────────────────────────────────────

interface ConnectorContributionSectionProps {
  contribution: ConnectorContribution | null;
  isConnected: boolean;
  loading: boolean;
  /**
   * Invoked when the user clicks the Settings → Tools "Share with everyone"
   * button. Receives the contribution's canonical `connectorName` so the
   * upstream handler (`handleShareWithCommunity` in `App.tsx`) can match it
   * against the contribution store via case-insensitive name lookup. Per
   * C8 of `docs/plans/260428_keep_private_minimize_and_settings_share_button.md`
   * — the section uses the canonical name on the contribution record itself
   * rather than reconstructing one from connection-panel data. See also
   * `docs/project/MCP_CONNECTOR_CONTRIBUTION_FLOW.md` for the recovery-path
   * semantics this button provides after a keep-private minimize.
   */
  onShareWithCommunity?: (connectorName: string) => void;
  onOpenChat?: (sessionId: string) => void;
  /**
   * Called after the stuck-contribution Discard action successfully removes
   * the record, so the caller can refresh its contribution view. Optional —
   * if absent, the component relies on natural refetch cadence.
   */
  onContributionDeleted?: (contributionId: string) => void;
}

export function ConnectorContributionSection({
  contribution,
  isConnected,
  loading,
  onShareWithCommunity,
  onOpenChat,
  onContributionDeleted,
}: ConnectorContributionSectionProps) {
  const isOssBuild = useIsOssBuild();

  if (isOssBuild || loading || !shouldShowContributionSection(isConnected, contribution) || !contribution) {
    return null;
  }

  const status = contribution.status;

  const substatus = toSubmittedSubstatus(status);
  const helperText = substatus ? SUBMITTED_HELPER_TEXT[substatus] : null;

  const chatSessionId = contribution.followUpSessionIds?.length
    ? contribution.followUpSessionIds[contribution.followUpSessionIds.length - 1]
    : contribution.sessionId;

  const stuck = isStuckTestingContribution(contribution);
  const prUrl = contribution.prUrl;

  return (
    <div className={styles.contributionSection} data-testid="connector-contribution-section">
      <div className={styles.contributionHeader}>
        <Tooltip content={getStatusTooltip(status)}>
          <span className={`${styles.contributionStatus} ${getStatusClassName(status)}`}>
            {getStatusIcon(status)}
            {getStatusLabel(status)}
          </span>
        </Tooltip>

        <div className={styles.contributionHeaderActions}>
          {prUrl && (
            <Tooltip content="View on GitHub">
              <IconButton
                size="xs"
                className={styles.contributionChatButton}
                onClick={() => void window.appApi.openUrl(prUrl)}
                aria-label="View on GitHub"
                data-testid="contribution-view-pr"
              >
                <Github size={13} />
              </IconButton>
            </Tooltip>
          )}

          {onOpenChat && (
            <Tooltip content="Open the conversation where we made this tool">
              <IconButton
                size="xs"
                className={styles.contributionChatButton}
                onClick={() => onOpenChat(chatSessionId)}
                aria-label="Open the conversation where we made this tool"
                data-testid="contribution-open-chat"
              >
                <MessageSquare size={13} />
              </IconButton>
            </Tooltip>
          )}
        </div>
      </div>

      {helperText && (
        <p className={styles.contributionHelper}>{helperText}</p>
      )}

      {/*
       * Settings recovery path for `draft` / `ready_to_submit` contributions
       * after a keep-private minimize (Stage 1) auto-dismissed the inline
       * submit-prompt. Routes back to the source conversation via
       * `handleShareWithCommunity` in App.tsx. Pass the contribution's
       * canonical `connectorName` (per C8 of
       * `docs/plans/260428_keep_private_minimize_and_settings_share_button.md`).
       * Visibility gate doubled by `shouldShowShareCta` (status filter) AND
       * the optional callback (so legacy callers / tests that omit the prop
       * silently render no button).
       */}
      {shouldShowShareCta(contribution) && onShareWithCommunity && (
        <div className={styles.contributionCta}>
          <Button
            size="sm"
            onClick={() => onShareWithCommunity(contribution.connectorName)}
            aria-label={`Share ${contribution.connectorName} with everyone`}
            data-testid="contribution-share-with-everyone"
          >
            Share with everyone
          </Button>
        </div>
      )}

      {stuck && (
        <StuckContributionRecovery
          contribution={contribution}
          onOpenChat={onOpenChat}
          onDeleted={onContributionDeleted}
        />
      )}
    </div>
  );
}

// ─── Stuck Contribution Recovery Sub-Section ────────────────────────

interface StuckContributionRecoveryProps {
  contribution: ConnectorContribution;
  onOpenChat?: (sessionId: string) => void;
  onDeleted?: (contributionId: string) => void;
}

/**
 * Settings recovery affordance for contributions that entered `testing` but
 * never transitioned further. Historically these sat invisible in the store;
 * the Stage 3 removal of the testing-phase card made the invisibility total,
 * so this sub-section is the operator-facing escape hatch.
 *
 * UX contract:
 *   - Discard is destructive and has a confirm dialog. No undo. Files on disk
 *     are explicitly NOT deleted (only the store record).
 *   - Open conversation routes to the originating session. Disabled when the
 *     session has been deleted (graceful degradation).
 */
function StuckContributionRecovery({
  contribution,
  onOpenChat,
  onDeleted,
}: StuckContributionRecoveryProps) {
  const { showToast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [sessionExists, setSessionExists] = useState<boolean | null>(null);

  const chatSessionId = contribution.followUpSessionIds?.length
    ? contribution.followUpSessionIds[contribution.followUpSessionIds.length - 1]
    : contribution.sessionId;

  // Check whether the originating session still exists so we can grey out
  // "Open conversation" when it's gone. Deliberately best-effort — if the IPC
  // fails we leave the button enabled (matches the existing pattern in the
  // main header chat button).
  useEffect(() => {
    let cancelled = false;
    if (!chatSessionId) {
      setSessionExists(false);
      return;
    }
    void (async () => {
      try {
        const session = await window.sessionsApi.get({ id: chatSessionId });
        if (!cancelled) setSessionExists(session !== null);
      } catch {
        if (!cancelled) setSessionExists(true); // assume present on error
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatSessionId]);

  const reference = contribution.updatedAt ?? contribution.createdAt;
  const parsed = reference ? new Date(reference).getTime() : NaN;
  const ageLabel = Number.isFinite(parsed)
    ? formatRelativeAge(Date.now() - parsed)
    : 'some time ago';

  const handleDiscard = async () => {
    setIsDiscarding(true);
    try {
      const result = await window.contributionApi.delete({ contributionId: contribution.id });
      if (!result.success) {
        showToast({
          variant: 'error',
          title: "Couldn't discard",
          description: result.error ?? 'Try again in a moment.',
        });
        return;
      }
      setConfirmOpen(false);
      onDeleted?.(contribution.id);
    } catch (err) {
      showToast({
        variant: 'error',
        title: "Couldn't discard",
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setIsDiscarding(false);
    }
  };

  const openDisabled = !onOpenChat || sessionExists === false;
  const openTooltip = !onOpenChat
    ? "Opening conversations isn't available here"
    : sessionExists === false
      ? 'The original conversation is no longer available'
      : 'Open the conversation to retry';

  return (
    <div className={styles.stuckSection} data-testid="stuck-contribution-section">
      <div className={styles.stuckHeader}>
        <AlertTriangle size={13} className={styles.stuckIcon} />
        <span className={styles.stuckTitle}>Stuck while trying it out</span>
      </div>
      <p className={styles.stuckHelper}>
        This got stuck while Rebel was trying it out {ageLabel}. You can remove this record,
        or reopen the conversation and try again.
      </p>
      <div className={styles.stuckActions}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setConfirmOpen(true)}
          disabled={isDiscarding}
          data-testid="stuck-contribution-discard"
        >
          Discard
        </Button>
        <Tooltip content={openTooltip}>
          <span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => chatSessionId && onOpenChat?.(chatSessionId)}
              disabled={openDisabled}
              data-testid="stuck-contribution-open-conversation"
            >
              Open conversation
            </Button>
          </span>
        </Tooltip>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Discard this stuck record?</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p>
              This removes Rebel&apos;s saved status for <strong>{formatConnectorDisplayName(contribution.connectorName)}</strong>.
              The files themselves stay where they are.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={isDiscarding}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDiscard}
              disabled={isDiscarding}
              data-testid="stuck-contribution-discard-confirm"
            >
              {isDiscarding ? (
                <>
                  <Loader2 size={12} className={styles.spinnerIcon} />
                  Discarding…
                </>
              ) : (
                'Discard'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
