import { AlertTriangle, CheckCircle2, RefreshCw, Unplug } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import { formatConnectorDisplayName } from '@shared/utils/formatConnectorDisplayName';
import type { AuthRequiredCardInfo } from '../hooks/useAuthRequiredSignals';
import styles from './MCPAuthRequiredCard.module.css';

export interface MCPAuthRequiredCardProps {
  card: AuthRequiredCardInfo;
  variant?: 'inline' | 'footer';
  onReconnect: (packageId: string) => Promise<void>;
  onCancel: (packageId: string) => Promise<void>;
}

const descriptionByReason: Record<AuthRequiredCardInfo['signal']['reason'], string> = {
  token_expired: 'Your Slack sign-in expired. Reconnect to keep using Slack tools.',
  not_connected: "Slack isn't connected. Reconnect to grant access.",
};

export function MCPAuthRequiredCard({
  card,
  variant = 'inline',
  onReconnect,
  onCancel,
}: MCPAuthRequiredCardProps) {
  const isFooter = variant === 'footer';
  const packageLabel =
    formatConnectorDisplayName(card.signal.packageId) || 'Slack';
  const title = `Reconnect ${packageLabel}`;
  const reasonDescription = descriptionByReason[card.signal.reason];

  const reconnectButton = (
    <Button
      size="sm"
      onClick={() => {
        void onReconnect(card.signal.packageId);
      }}
    >
      Reconnect
    </Button>
  );

  if (card.state === 'reconnecting') {
    return (
      <section
        data-testid="mcp-auth-required-card"
        className={cn(styles.card, styles.cardReconnecting, isFooter && styles.cardFooter)}
        role="region"
        aria-live="polite"
        aria-label={title}
      >
        <header className={styles.header}>
          <RefreshCw
            size={16}
            aria-hidden="true"
            className={cn(styles.icon, styles.iconSpinning)}
          />
          <div>
            <p className={styles.title}>{title}</p>
            <p className={styles.subtitle}>Waiting for Slack sign-in</p>
          </div>
        </header>
        <div className={styles.body}>
          <p className={styles.message}>Finish Slack sign-in in the browser tab that opened.</p>
        </div>
        <div className={styles.actions}>
          <Button size="sm" disabled>
            Reconnecting…
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void onCancel(card.signal.packageId);
            }}
          >
            Cancel
          </Button>
        </div>
      </section>
    );
  }

  if (card.state === 'success') {
    return (
      <section
        data-testid="mcp-auth-required-card"
        className={cn(styles.card, styles.cardSuccess, isFooter && styles.cardFooter)}
        role="region"
        aria-live="polite"
        aria-label={title}
      >
        <header className={styles.header}>
          <CheckCircle2 size={16} aria-hidden="true" className={cn(styles.icon, styles.iconSuccess)} />
          <div>
            <p className={styles.title}>{title}</p>
            <p className={styles.subtitle}>Reconnected</p>
          </div>
        </header>
        <div className={styles.body}>
          <p className={styles.message}>Slack is connected again.</p>
        </div>
      </section>
    );
  }

  if (card.state === 'error') {
    return (
      <section
        data-testid="mcp-auth-required-card"
        className={cn(styles.card, styles.cardError, isFooter && styles.cardFooter)}
        role="region"
        aria-live="polite"
        aria-label={title}
      >
        <header className={styles.header}>
          <AlertTriangle size={16} aria-hidden="true" className={cn(styles.icon, styles.iconError)} />
          <div>
            <p className={styles.title}>{title}</p>
            <p className={styles.subtitle}>Reconnect failed</p>
          </div>
        </header>
        <div className={styles.body}>
          <p className={styles.message}>
            {card.errorMessage ?? 'We could not reconnect Slack. Try again.'}
          </p>
        </div>
        <div className={styles.actions}>
          <Button
            size="sm"
            onClick={() => {
              void onReconnect(card.signal.packageId);
            }}
          >
            Try again
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section
      data-testid="mcp-auth-required-card"
      className={cn(styles.card, isFooter && styles.cardFooter)}
      role="region"
      aria-live="polite"
      aria-label={title}
    >
      <header className={styles.header}>
        <Unplug size={16} aria-hidden="true" className={styles.icon} />
        <div>
          <p className={styles.title}>{title}</p>
          <p className={styles.subtitle}>Action needed</p>
        </div>
      </header>
      <div className={styles.body}>
        <p className={styles.message}>{reasonDescription}</p>
      </div>
      <div className={styles.actions}>{reconnectButton}</div>
    </section>
  );
}
