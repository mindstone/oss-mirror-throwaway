/**
 * StartupRecoveryDialog - Shown when startup takes too long or fails
 *
 * Offers users the option to continue waiting or enter Safe Mode
 * when Super-MCP startup is delayed or has failed.
 */

import { useCallback, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  Button,
} from './ui';
import { getSafeModeCategoryGuidance } from '@renderer/features/app-shell/safeModeCategoryGuidance';
import type { SafeModeErrorCategory } from '@shared/types';

interface StartupRecoveryDialogProps {
  open: boolean;
  onContinueWaiting: () => void;
  variant: 'timeout' | 'failed';
  /** Error category from startup failure (for 'failed' variant) */
  errorCategory?: SafeModeErrorCategory;
  /** Sentry event ID for support (for 'failed' variant) */
  sentryEventId?: string;
}

export const StartupRecoveryDialog = ({
  open,
  onContinueWaiting,
  variant,
  errorCategory,
  sentryEventId,
}: StartupRecoveryDialogProps) => {
  const [isEnteringMode, setIsEnteringMode] = useState(false);

  const handleEnterSafeMode = useCallback(async () => {
    setIsEnteringMode(true);
    try {
      await window.appApi.enterSafeMode({
        reason: variant === 'timeout' ? 'timeout' : 'failure',
        errorCategory: errorCategory,
        sentryEventId: sentryEventId,
      });
      // App will restart, no need to reset state
    } catch (error) {
      console.error('Failed to enter safe mode:', error);
      setIsEnteringMode(false);
    }
  }, [variant, errorCategory, sentryEventId]);

  const title =
    variant === 'timeout'
      ? 'Startup is taking longer than expected'
      : 'Tools failed to start';

  const description =
    variant === 'timeout'
      ? 'Tools are still trying to start. You can wait, or start in Safe Mode (tools disabled) to troubleshoot.'
      : 'The tools connection hit an error before it was ready.';

  const continueLabel = variant === 'timeout' ? 'Continue Waiting' : 'Dismiss';
  const categoryGuidance = getSafeModeCategoryGuidance(errorCategory);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onContinueWaiting();
        }
      }}
    >
      <DialogContent size="sm" data-testid="startup-recovery-dialog">
        <DialogHeader icon={<AlertTriangle size={24} className="text-amber-500" />}>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {variant === 'failed' ? (
            <p className="text-sm text-secondary-foreground">
              {categoryGuidance}
            </p>
          ) : (
            <p className="text-sm text-secondary-foreground">
              Safe Mode allows you to access all app features except tools while you troubleshoot.
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onContinueWaiting}>
            {continueLabel}
          </Button>
          <Button onClick={handleEnterSafeMode} disabled={isEnteringMode}>
            {isEnteringMode ? 'Starting Safe Mode...' : 'Start in Safe Mode'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

StartupRecoveryDialog.displayName = 'StartupRecoveryDialog';
