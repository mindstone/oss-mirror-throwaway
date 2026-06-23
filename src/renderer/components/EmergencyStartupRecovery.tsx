/**
 * EmergencyStartupRecovery - Last-resort recovery UI when startup is completely stuck
 *
 * This component is shown when settings fail to load within a timeout (e.g., 15 seconds).
 * Unlike StartupRecoveryDialog, this works even when normal IPC is completely unresponsive
 * because it uses fire-and-forget IPC (ipcRenderer.send) via the emergencyApi.
 *
 * The component attempts to restart the app in Safe Mode. If that doesn't work
 * within a few seconds, it offers a "Force Quit" option.
 */

import { useCallback, useState, useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { BrandLogo } from '@renderer/components/BrandLogo';

type RecoveryPhase = 'showing' | 'restarting' | 'failed';

interface EmergencyStartupRecoveryProps {
  /** Called when user clicks "Continue Waiting" */
  onContinueWaiting: () => void;
}

export const EmergencyStartupRecovery = ({ onContinueWaiting }: EmergencyStartupRecoveryProps) => {
  const [phase, setPhase] = useState<RecoveryPhase>('showing');

  const handleRestartInSafeMode = useCallback(() => {
    setPhase('restarting');
    // Fire-and-forget - doesn't wait for response
    window.emergencyApi.requestSafeModeRestart();
  }, []);

  const handleForceQuit = useCallback(() => {
    window.emergencyApi.requestQuit();
  }, []);

  // If restart was requested but app hasn't closed after 5s, show "Force Quit" option
  useEffect(() => {
    if (phase !== 'restarting') return;

    const timeout = setTimeout(() => {
      setPhase('failed');
    }, 5000);

    return () => clearTimeout(timeout);
  }, [phase]);

  return (
    <div className="emergency-startup-recovery">
      <div className="emergency-startup-recovery__content">
        <BrandLogo height={32} style={{ opacity: 0.7, marginBottom: '24px' }} />
        
        <div className="emergency-startup-recovery__icon">
          <AlertTriangle size={32} className="text-amber-500" />
        </div>

        <h2 className="emergency-startup-recovery__title">
          {phase === 'restarting' ? 'Restarting...' : 'Startup is taking too long'}
        </h2>

        <p className="emergency-startup-recovery__description">
          {phase === 'showing' && (
            <>
              Something may be preventing Rebel from starting properly.
              You can restart in Safe Mode to troubleshoot, or continue waiting.
            </>
          )}
          {phase === 'restarting' && (
            <>
              <RefreshCw size={16} className="inline-block animate-spin mr-2" />
              Attempting to restart in Safe Mode...
            </>
          )}
          {phase === 'failed' && (
            <>
              The restart command was sent but the app hasn&apos;t restarted.
              Please force quit and relaunch manually.
            </>
          )}
        </p>

        <div className="emergency-startup-recovery__actions">
          {phase === 'showing' && (
            <>
              <button
                className="emergency-startup-recovery__button emergency-startup-recovery__button--ghost"
                onClick={onContinueWaiting}
              >
                Continue Waiting
              </button>
              <button
                className="emergency-startup-recovery__button emergency-startup-recovery__button--primary"
                onClick={handleRestartInSafeMode}
                disabled={phase !== 'showing'}
              >
                Restart in Safe Mode
              </button>
            </>
          )}
          {phase === 'failed' && (
            <button
              className="emergency-startup-recovery__button emergency-startup-recovery__button--primary"
              onClick={handleForceQuit}
            >
              Force Quit
            </button>
          )}
        </div>
      </div>

      <style>{`
        .emergency-startup-recovery {
          position: fixed;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--color-background, #0a0a0a);
          z-index: 9999;
          padding: 24px;
        }

        .emergency-startup-recovery__content {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          max-width: 400px;
        }

        .emergency-startup-recovery__icon {
          margin-bottom: 16px;
        }

        .emergency-startup-recovery__title {
          font-size: 18px;
          font-weight: 600;
          color: var(--color-foreground, #fafafa);
          margin: 0 0 12px 0;
        }

        .emergency-startup-recovery__description {
          font-size: 14px;
          color: var(--color-muted-foreground, #a1a1aa);
          margin: 0 0 24px 0;
          line-height: 1.5;
        }

        .emergency-startup-recovery__actions {
          display: flex;
          gap: 12px;
        }

        .emergency-startup-recovery__button {
          padding: 10px 20px;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease;
          border: none;
        }

        .emergency-startup-recovery__button--ghost {
          background: transparent;
          color: var(--color-muted-foreground, #a1a1aa);
          border: 1px solid var(--color-border, #27272a);
        }

        .emergency-startup-recovery__button--ghost:hover {
          background: var(--color-accent, #27272a);
          color: var(--color-foreground, #fafafa);
        }

        .emergency-startup-recovery__button--primary {
          background: var(--color-primary, #3b82f6);
          color: white;
        }

        .emergency-startup-recovery__button--primary:hover:not(:disabled) {
          background: var(--color-primary-hover, #2563eb);
        }

        .emergency-startup-recovery__button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .text-amber-500 {
          color: #f59e0b;
        }

        .animate-spin {
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

EmergencyStartupRecovery.displayName = 'EmergencyStartupRecovery';
