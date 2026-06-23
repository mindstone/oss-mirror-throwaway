import { memo, useCallback, useState } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import type { AutomationDefinition, AutomationRun } from '@shared/types';
import { Button } from '@renderer/components/ui';
import { getAutomationReasonDisplayText } from '../hooks/useAutomationApprovals';
import styles from './BlockedRunDetail.module.css';

interface BlockedRunDetailProps {
  run: AutomationRun;
  definition: AutomationDefinition;
  onRetry: (automationId: string) => Promise<void>;
}

/**
 * Format a raw tool name into a human-readable display name.
 * Handles MCP router tool names and general cleanup.
 */
const formatToolDisplayName = (toolName: string): string => {
  // Strip common prefixes
  let name = toolName
    .replace(/^mcp__super-mcp-router__/, '')
    .replace(/^mcp__/, '');
  // Convert underscores/hyphens to spaces and title-case
  name = name
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return name;
};

const formatBlockedTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
};

const BlockedRunDetailComponent = ({
  run,
  definition,
  onRetry,
}: BlockedRunDetailProps) => {
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = useCallback(async () => {
    setIsRetrying(true);
    try {
      await onRetry(definition.id);
    } finally {
      setIsRetrying(false);
    }
  }, [definition.id, onRetry]);

  const blockedActions = run.blockedActions ?? [];
  if (blockedActions.length === 0) return null;

  return (
    <div className={styles.container}>
      {run.error && (
        <pre className={styles.errorText}>{run.error}</pre>
      )}
      <div className={styles.blockedList}>
        {blockedActions.map((action, index) => {
          const toolDisplayName = formatToolDisplayName(action.toolName);
          const blockedReason = getAutomationReasonDisplayText(action.reason, toolDisplayName);

          return (
            <div key={`${action.toolId}-${index}`} className={styles.blockedItem}>
              <ShieldAlert size={14} className={styles.blockedIcon} />
              <div className={styles.blockedInfo}>
                <div className={styles.blockedToolName}>{toolDisplayName}</div>
                <div className={styles.blockedReason}>{blockedReason}</div>
                {action.timestamp > 0 && (
                  <div className={styles.blockedTime}>{formatBlockedTime(action.timestamp)}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={handleRetry} disabled={isRetrying}>
          <RefreshCw size={12} />
          {isRetrying ? 'Retrying…' : 'Retry now'}
        </Button>
      </div>
    </div>
  );
};

export const BlockedRunDetail = memo(BlockedRunDetailComponent);
BlockedRunDetail.displayName = 'BlockedRunDetail';
