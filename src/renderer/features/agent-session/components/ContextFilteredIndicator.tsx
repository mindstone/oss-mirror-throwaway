import { memo, useCallback, type MouseEvent } from 'react';
import { Notice } from '@renderer/components/ui';
import { useNavigationSafe } from '@renderer/contexts';
import type { PolicyMode } from '@rebel/shared';
import styles from './ContextFilteredIndicator.module.css';

const RECENT_ATTEMPTS_SETTINGS_URL = 'rebel://settings/?tab=cloud&section=recent-message-attempts';

export interface ContextFilteredIndicatorProps {
  filteredCount: number;
  mode: PolicyMode;
}

const ContextFilteredIndicatorComponent = ({
  filteredCount,
  mode,
}: ContextFilteredIndicatorProps) => {
  const navigation = useNavigationSafe();
  const summary = filteredCount === 1
    ? "Context filtered — 1 message was ignored because that sender isn't allowed to message Rebel. "
    : `Context filtered — ${filteredCount} messages were ignored because those senders aren't allowed to message Rebel. `;

  const handleOpenRecentAttempts = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (!navigation) return;
    event.preventDefault();
    void navigation.navigate(RECENT_ATTEMPTS_SETTINGS_URL);
  }, [navigation]);

  if (filteredCount === 0 || mode === 'legacyPermissive') {
    return null;
  }

  return (
    <Notice
      tone="info"
      placement="inline"
      density="compact"
      role="note"
      data-testid="context-filtered-indicator"
    >
      <>
        {summary}
        <a
          href={RECENT_ATTEMPTS_SETTINGS_URL}
          className={styles.link}
          data-testid="context-filtered-indicator-link"
          onClick={handleOpenRecentAttempts}
        >
          Review recent message attempts
        </a>
      </>
    </Notice>
  );
};

export const ContextFilteredIndicator = memo(ContextFilteredIndicatorComponent);
ContextFilteredIndicator.displayName = 'ContextFilteredIndicator';
