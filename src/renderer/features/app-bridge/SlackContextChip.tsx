import { memo } from 'react';
import { ExternalLink, MessageSquare } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import styles from './ContextChip.module.css';

export interface SlackContextChipProps {
  channelName?: string | null;
  userName?: string | null;
  userDisplayName?: string | null;
  teamName?: string | null;
  permalink?: string | null;
}

const SlackContextChipComponent = ({
  channelName,
  userName,
  userDisplayName,
  teamName,
  permalink,
}: SlackContextChipProps) => {
  const displayUser = userName ?? userDisplayName ?? null;
  const channelLabel = channelName ? `#${channelName}` : null;
  const sourceLabel = channelLabel && displayUser
    ? `${displayUser} in ${channelLabel}`
    : channelLabel
      ? `Unknown user in ${channelLabel}`
      : displayUser
        ? `${displayUser} in (channel unavailable)`
        : 'Slack message';
  const fullLabel = teamName ? `${sourceLabel} · ${teamName}` : sourceLabel;
  const safePermalink = permalink?.startsWith('https://') ? permalink : null;

  const tooltipText = safePermalink
    ? `${fullLabel}\nView in Slack`
    : fullLabel;

  return (
    <Tooltip content={tooltipText} placement="top">
      <div
        className={styles.chip}
        data-testid="slack-context-chip"
        aria-label={`Slack context: ${fullLabel}`}
      >
        <MessageSquare size={12} className={styles.icon} aria-hidden="true" />
        <span className={styles.host}>{sourceLabel}</span>
        {teamName && (
          <span className={styles.separator} aria-hidden="true">·</span>
        )}
        {teamName && (
          <span className={styles.label}>{teamName}</span>
        )}
        {safePermalink && (
          <>
            <span className={styles.separator} aria-hidden="true">·</span>
            <a
              className={styles.chipLink}
              href={safePermalink}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="slack-context-chip-link"
              aria-label="View this Slack message in Slack"
            >
              View in Slack
              <ExternalLink size={11} aria-hidden="true" />
            </a>
          </>
        )}
      </div>
    </Tooltip>
  );
};

export const SlackContextChip = memo(SlackContextChipComponent);
SlackContextChip.displayName = 'SlackContextChip';
