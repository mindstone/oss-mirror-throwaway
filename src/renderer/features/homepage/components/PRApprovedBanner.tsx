import { CheckCircle2, X } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { formatConnectorDisplayName } from '@shared/utils/formatConnectorDisplayName';
import styles from './PRApprovedBanner.module.css';

export interface PRApprovedBannerProps {
  connectorName: string;
  onDismiss?: () => void;
  onViewConnector?: () => void;
}

export function PRApprovedBanner({
  connectorName,
  onDismiss,
  onViewConnector,
}: PRApprovedBannerProps) {
  // Voice doc: publication is "quiet success", not party-popper celebration.
  // See docs/project/CONNECTOR_CONTRIBUTION_VOICE.md § Publication.
  return (
    <section className={styles.banner} role="status" aria-live="polite">
      <div className={styles.content}>
        <div className={styles.iconWrap} aria-hidden>
          <CheckCircle2 size={16} />
        </div>
        <div className={styles.copy}>
          <p className={styles.title}>Your {formatConnectorDisplayName(connectorName)} tool is live. Other people can use it now.</p>
          <div className={styles.metaRow}>
            <p className={styles.subtitle}>You&apos;re credited in the release notes.</p>
            <Button
              variant="ghost"
              size="sm"
              className={styles.cta}
              onClick={onViewConnector}
              disabled={!onViewConnector}
            >
              View tool →
            </Button>
          </div>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className={styles.dismiss}
        aria-label="Dismiss notification"
        onClick={onDismiss}
        disabled={!onDismiss}
      >
        <X size={14} />
      </Button>
    </section>
  );
}
