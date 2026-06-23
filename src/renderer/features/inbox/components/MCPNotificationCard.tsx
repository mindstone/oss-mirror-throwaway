import { AlertTriangle, CheckCircle2, PartyPopper, XCircle, CircleX } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import { formatConnectorDisplayName } from '@shared/utils/formatConnectorDisplayName';
import styles from './MCPNotificationCard.module.css';

export type MCPNotificationState =
  | 'ci-pass'
  | 'ci-fail'
  | 'approved'
  | 'changes-requested'
  | 'rejected';

export interface MCPNotificationCardProps {
  state: MCPNotificationState;
  connectorName: string;
  reviewNotes?: string;
  prUrl?: string;
  onViewConnector?: () => void;
  onMakeChanges?: () => void;
  onOpenInGitHub?: () => void;
  onAcknowledge?: () => void;
}

function getStateCopy(state: MCPNotificationState, rawConnectorName: string) {
  // Connector names flowing in from the contribution store are the raw slug
  // (e.g. `apple-shortcuts`). Title-case for display without mutating the
  // identifier used by downstream lookups.
  const connectorName = formatConnectorDisplayName(rawConnectorName);
  switch (state) {
    case 'ci-pass':
      return {
        Icon: CheckCircle2,
        title: `Your ${connectorName} tool passed its checks`,
        body: 'A Mindstone reviewer will take a look soon.',
      };
    case 'ci-fail':
      return {
        Icon: CircleX,
        title: `Your ${connectorName} tool needs a fix before review`,
        body: "We'll help you sort it out so it can be reviewed.",
      };
    case 'approved':
      return {
        Icon: PartyPopper,
        title: `Your ${connectorName} tool was approved by the Mindstone team`,
        body: 'It is now on its way into Rebel for everyone.',
      };
    case 'changes-requested':
      return {
        Icon: AlertTriangle,
        title: `Your ${connectorName} tool needs a small update`,
        body: 'A reviewer left feedback to help get it ready.',
      };
    case 'rejected':
      return {
        Icon: XCircle,
        title: `Your ${connectorName} tool wasn't accepted`,
        body: 'You can still keep using it locally.',
      };
  }
}

export function MCPNotificationCard({
  state,
  connectorName,
  reviewNotes,
  prUrl,
  onViewConnector,
  onMakeChanges,
  onOpenInGitHub,
  onAcknowledge,
}: MCPNotificationCardProps) {
  const copy = getStateCopy(state, connectorName);
  const isChangesRequested = state === 'changes-requested';

  return (
    <section
      className={cn(
        styles.card,
        state === 'approved' && styles.cardApproved,
        (state === 'changes-requested' || state === 'ci-fail') && styles.cardNeedsAttention,
      )}
      role="status"
      aria-live="polite"
    >
      <div className={styles.timeRow}>
        <div className={styles.typeIcon}>
          <copy.Icon size={12} className={styles.icon} aria-hidden />
        </div>
        <span className={styles.timeText}>just now</span>
      </div>

      <div className={styles.header}>
        <p className={styles.title}>{copy.title}</p>
      </div>
      <p className={styles.body}>{copy.body}</p>

      {isChangesRequested && reviewNotes && (
        <div className={styles.reviewBlock}>
          <p className={styles.reviewLabel}>Feedback from review</p>
          <p className={styles.reviewNotes}>{reviewNotes}</p>
        </div>
      )}
      {state === 'rejected' && reviewNotes && (
        <div className={styles.reviewBlock}>
          <p className={styles.reviewLabel}>Why it was not accepted</p>
          <p className={styles.reviewNotes}>{reviewNotes}</p>
        </div>
      )}

      <div className={styles.actions}>
        {(state === 'ci-pass' || state === 'ci-fail') && (
          <Button
            variant="ghost"
            size="sm"
            className={styles.secondaryAction}
            onClick={onAcknowledge}
            disabled={!onAcknowledge}
          >
            OK
          </Button>
        )}
        {state === 'approved' && (
          <Button
            size="sm"
            className={styles.primaryAction}
            onClick={onViewConnector}
            disabled={!onViewConnector}
          >
            View tool
          </Button>
        )}
        {isChangesRequested && (
          <>
            <Button
              size="sm"
              className={styles.primaryAction}
              onClick={onMakeChanges}
              disabled={!onMakeChanges}
            >
              Make the tweaks
            </Button>
            {prUrl && (
              <Button
                variant="ghost"
                size="sm"
                className={styles.secondaryAction}
                onClick={onOpenInGitHub}
                disabled={!onOpenInGitHub}
              >
                Open in GitHub
              </Button>
            )}
          </>
        )}
        {state === 'rejected' && (
          <Button
            variant="ghost"
            size="sm"
            className={styles.secondaryAction}
            onClick={onAcknowledge}
            disabled={!onAcknowledge}
          >
            OK
          </Button>
        )}
      </div>
    </section>
  );
}
