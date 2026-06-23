/**
 * SafeModeIndicator - Banner shown when app is running in Safe Mode
 *
 * Safe Mode disables tools (Super-MCP) for troubleshooting. This banner
 * makes the state visible, explains why we're in Safe Mode, and provides
 * ways to get help and exit.
 */

import { useCallback, useState } from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import type { SafeModeContext, SafeModeReason } from '@shared/types';
import { Button, Tooltip } from './ui';
import styles from './SafeModeIndicator.module.css';

interface SafeModeIndicatorProps {
  context: SafeModeContext;
  onGetTroubleshootingTips: () => void;
}

/** Human-readable reason text for the banner */
function getReasonText(reason?: SafeModeReason): string {
  switch (reason) {
    case 'timeout':
      return 'Started due to startup timeout';
    case 'failure':
      return 'Started due to tools failing to load';
    case 'cli':
      return 'Started via command line';
    case 'user':
      return 'Started by user';
    default:
      return 'Tools disabled for troubleshooting';
  }
}

/** Format ISO timestamp to locale string */
function formatTriggeredAt(isoString?: string): string | null {
  if (!isoString) return null;
  try {
    const date = new Date(isoString);
    return date.toLocaleString();
  } catch {
    return null;
  }
}

export const SafeModeIndicator = ({ context, onGetTroubleshootingTips }: SafeModeIndicatorProps) => {
  const [isExiting, setIsExiting] = useState(false);

  const handleExitSafeMode = useCallback(async () => {
    setIsExiting(true);
    try {
      await window.appApi.exitSafeMode();
      // App will restart, no need to reset state
    } catch (error) {
      console.error('Failed to exit safe mode:', error);
      setIsExiting(false);
    }
  }, []);

  if (!context.isEnabled) return null;

  const reasonText = getReasonText(context.reason);
  const triggeredAtFormatted = formatTriggeredAt(context.triggeredAt);

  // Build tooltip content
  const tooltipLines: string[] = [];
  if (triggeredAtFormatted) {
    tooltipLines.push(`Triggered: ${triggeredAtFormatted}`);
  }
  if (context.errorCategory && context.errorCategory !== 'unknown') {
    tooltipLines.push(`Error type: ${context.errorCategory.replace(/_/g, ' ')}`);
  }
  if (context.sentryEventId) {
    tooltipLines.push(`Support ID: ${context.sentryEventId}`);
  }

  const bannerContent = (
    <div className={styles.banner}>
      <div className={styles.content}>
        <AlertTriangle size={18} className={styles.icon} />
        <span className={styles.text}>
          <strong>Safe Mode</strong> — {reasonText}
        </span>
        <div className={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            onClick={onGetTroubleshootingTips}
            className={styles.helpButton}
          >
            <HelpCircle size={14} />
            Get troubleshooting tips
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleExitSafeMode}
            disabled={isExiting}
            className={styles.exitButton}
          >
            {isExiting ? 'Restarting...' : 'Exit & Restart'}
          </Button>
        </div>
      </div>
    </div>
  );

  // Wrap with tooltip if we have additional context
  // Render as separate spans to preserve line breaks (Tooltip CSS uses white-space: normal)
  if (tooltipLines.length > 0) {
    const tooltipContent = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {tooltipLines.map((line, i) => <span key={i}>{line}</span>)}
      </div>
    );
    return (
      <Tooltip content={tooltipContent} placement="bottom">
        {bannerContent}
      </Tooltip>
    );
  }

  return bannerContent;
};

SafeModeIndicator.displayName = 'SafeModeIndicator';
