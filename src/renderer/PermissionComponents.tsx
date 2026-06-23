import { useCallback, useEffect, useState } from 'react';
import type { AppSettings } from '@shared/types';
import { Button } from './components/ui';
import styles from './PermissionComponents.module.css';

interface PermissionStatus {
  microphone: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'checking' | 'unknown';
  fileAccess: 'granted' | 'denied' | 'unknown';
}

interface PermissionStatusBannerProps {
  onRequestPermissions: () => void;
  settings: AppSettings | null;
}

export const PermissionStatusBanner = ({ onRequestPermissions, settings }: PermissionStatusBannerProps) => {
  const [status, setStatus] = useState<PermissionStatus>({
    microphone: 'checking',
    fileAccess: 'unknown'
  });
  const [dismissed, setDismissed] = useState(false);
  const [hasCompletedInitialCheck, setHasCompletedInitialCheck] = useState(false);

  const checkPermissions = useCallback(async () => {
    // Check microphone permission
    try {
      const micStatus = await window.permissionsApi.getMicrophoneStatus();
      setStatus(prev => ({ ...prev, microphone: micStatus }));
    } catch (error) {
      console.error('Failed to check microphone permission:', error);
      setStatus(prev => ({ ...prev, microphone: 'not-determined' }));
    }

    // Check file access
    if (!settings?.coreDirectory) {
      setStatus(prev => ({ ...prev, fileAccess: 'unknown' }));
      setHasCompletedInitialCheck(true);
      return;
    }

    try {
      const fileAccessResult = await window.permissionsApi.checkFileAccess();
      setStatus(prev => ({ 
        ...prev, 
        fileAccess: fileAccessResult.hasAccess ? 'granted' : 'denied' 
      }));
    } catch (error) {
      console.error('Failed to check file access:', error);
      setStatus(prev => ({ ...prev, fileAccess: 'denied' }));
    }
    setHasCompletedInitialCheck(true);
  }, [settings?.coreDirectory]);

  const allGranted = status.microphone === 'granted' && status.fileAccess === 'granted';
  const shouldPoll = !dismissed && !allGranted;

  useEffect(() => {
    if (!shouldPoll) {
      return;
    }

    let intervalId: number | null = null;

    const tick = () => {
      void checkPermissions();
    };

    const start = () => {
      if (intervalId !== null || typeof window === 'undefined') {
        return;
      }
      intervalId = window.setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) {
          return;
        }
        tick();
      }, 5000);
    };

    const stop = () => {
      if (intervalId !== null && typeof window !== 'undefined') {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibility = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        stop();
      } else {
        tick();
        start();
      }
    };

    tick();
    if (typeof document === 'undefined' || !document.hidden) {
      start();
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
    }

    return () => {
      stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
    };
  }, [checkPermissions, shouldPoll]);
  const hasIssues = status.microphone === 'denied' || status.fileAccess === 'denied';
  const needsAttention = 
    (status.microphone === 'not-determined' || status.fileAccess === 'unknown') && 
    settings?.coreDirectory && 
    status.microphone !== 'checking';

  // Don't show banner until initial check completes - prevents the "tests running" feel
  // Only show if there's an actual problem (not just checking) and not already granted/dismissed
  if (!hasCompletedInitialCheck || allGranted || dismissed) return null;
  
  // Only show if there's actually something wrong or needs attention
  if (!hasIssues && !needsAttention) return null;

  const getBannerMessage = () => {
    const issues: string[] = [];
    if (status.microphone !== 'granted' && status.microphone !== 'checking') {
      issues.push('Microphone access needed for voice commands.');
    }
    if (status.fileAccess !== 'granted' && settings?.coreDirectory) {
      issues.push('Workspace folder access needed to read/write files.');
    }
    return issues.join(' ');
  };

  const bannerClassName = [
    styles.permissionBanner,
    hasIssues ? styles.permissionBannerWarning : styles.permissionBannerInfo
  ].join(' ');

  return (
    <div className={bannerClassName}>
      <div className={styles.permissionBannerContent}>
        <span className={styles.permissionBannerIcon}>
          {hasIssues ? '⚠️' : 'ℹ️'}
        </span>
        <div className={styles.permissionBannerText}>
          <strong>
            {hasIssues ? 'Permissions Required' : needsAttention ? 'Ready to Set Up Permissions' : 'Permissions Needed'}
          </strong>
          <p>{getBannerMessage()}</p>
        </div>
        <div className={styles.permissionBannerActions}>
          <button 
            className={styles.permissionBannerAction}
            onClick={onRequestPermissions}
          >
            {hasIssues ? 'Fix Permissions' : 'Grant Permissions'}
          </button>
          <button 
            className={styles.permissionBannerDismiss}
            onClick={() => setDismissed(true)}
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
};

interface PermissionOnboardingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings | null;
}

export const PermissionOnboardingDialog = ({ 
  isOpen, 
  onClose, 
  settings 
}: PermissionOnboardingDialogProps) => {
  const [step, setStep] = useState<'intro' | 'microphone' | 'files' | 'complete'>('intro');
  const [micGranted, setMicGranted] = useState(false);
  const [filesGranted, setFilesGranted] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setStep('intro');
      setMicGranted(false);
      setFilesGranted(false);
      setError(null);
    }
  }, [isOpen]);

  const requestMicrophonePermission = async () => {
    setIsRequesting(true);
    setError(null);
    
    try {
      const result = await window.permissionsApi.requestMicrophone();
      
      if (result.granted) {
        setMicGranted(true);
        setStep('files');
      } else {
        // Permission denied, show message and allow user to open system preferences
        setError('Microphone permission was denied. You can enable it in System Settings.');
        // Still move to next step after a delay
        setTimeout(() => {
          setError(null);
          setStep('files');
        }, 3000);
      }
    } catch (err) {
      console.error('Failed to request microphone permission:', err);
      setError('Something went sideways — try again.');
    } finally {
      setIsRequesting(false);
    }
  };

  const testFileAccess = async () => {
    setIsRequesting(true);
    setError(null);
    
    try {
      const result = await window.permissionsApi.checkFileAccess();
      
      if (result.hasAccess) {
        setFilesGranted(true);
        setStep('complete');
      } else {
        if (result.reason === 'no-workspace-configured') {
          setError("Set up your Library directory in Settings first.");
        } else {
          setError("Can't reach the Library folder yet. Your system may prompt for access on first use.");
        }
        // Move to complete after showing error
        setTimeout(() => {
          setStep('complete');
        }, 2000);
      }
    } catch (err) {
      console.error('Failed to check file access:', err);
      setError("Something went sideways checking file access.");
      setTimeout(() => {
        setStep('complete');
      }, 2000);
    } finally {
      setIsRequesting(false);
    }
  };

  const openSystemPreferences = async (type: 'microphone' | 'files') => {
    try {
      await window.permissionsApi.openSystemPreferences(type);
    } catch (err) {
      console.error('Failed to open system preferences:', err);
    }
  };

  if (!isOpen) return null;

  return (
    <div className={styles.permissionDialogOverlay} onClick={onClose}>
      <div className={styles.permissionDialog} onClick={(e) => e.stopPropagation()}>
        {step === 'intro' && (
          <>
            <h2>Welcome to Mindstone Rebel</h2>
            <p>To provide the best experience, we need a couple of permissions:</p>
            <ul className={styles.permissionList}>
              <li className={styles.permissionListItem}>
                <span className={styles.permissionIcon}>🎤</span>
                <div>
                  <strong>Microphone</strong>
                  <p>For voice commands and voice mode interaction</p>
                </div>
              </li>
              <li className={styles.permissionListItem}>
                <span className={styles.permissionIcon}>📁</span>
                <div>
                  <strong>Library Folder Access</strong>
                  <p>To read and write files in: {settings?.coreDirectory || 'your Library'}</p>
                </div>
              </li>
            </ul>
            <div className={styles.permissionDialogActions}>
              <Button onClick={() => setStep('microphone')}>
                Get Started
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Skip for Now
              </Button>
            </div>
          </>
        )}

        {step === 'microphone' && (
          <>
            <h2>🎤 Microphone Access</h2>
            <p>
              Voice commands make it easy to interact with Claude. When you click "Allow Microphone",
              your system will ask for permission to use your microphone.
            </p>
            {error && (
              <div className={styles.permissionError}>
                {error}
                <button 
                  onClick={() => openSystemPreferences('microphone')}
                  className={styles.permissionErrorAction}
                >
                  Open System Settings
                </button>
              </div>
            )}
            <div className={styles.permissionDialogActions}>
              <Button 
                onClick={requestMicrophonePermission} 
                disabled={isRequesting}
              >
                {isRequesting ? 'Requesting...' : 'Allow Microphone'}
              </Button>
              <Button variant="ghost" onClick={() => setStep('files')} disabled={isRequesting}>
                Skip
              </Button>
            </div>
          </>
        )}

        {step === 'files' && (
          <>
            <h2>📁 Library Folder Access</h2>
            <p>
              The app needs to read and write files in your Library folder. This allows Claude
              to assist with your documents and research.
            </p>
            {settings?.coreDirectory && (
              <p className={styles.workspacePath}>
                <strong>Library:</strong> {settings.coreDirectory}
              </p>
            )}
            {error && (
              <div className={styles.permissionError}>
                {error}
              </div>
            )}
            <div className={styles.permissionDialogActions}>
              <Button 
                onClick={testFileAccess} 
                disabled={isRequesting || !settings?.coreDirectory}
              >
                {isRequesting ? 'Checking...' : 'Test Folder Access'}
              </Button>
              <Button variant="ghost" onClick={() => setStep('complete')} disabled={isRequesting}>
                Skip
              </Button>
            </div>
          </>
        )}

        {step === 'complete' && (
          <>
            <h2>✅ All Set!</h2>
            <div className={styles.permissionSummary}>
              <div
                className={[
                  styles.permissionStatus,
                  micGranted ? styles.permissionStatusGranted : styles.permissionStatusPending
                ].join(' ')}
              >
                <span>{micGranted ? '✓' : '○'}</span>
                Microphone {micGranted ? 'Granted' : 'Not Granted'}
              </div>
              <div
                className={[
                  styles.permissionStatus,
                  filesGranted ? styles.permissionStatusGranted : styles.permissionStatusPending
                ].join(' ')}
              >
                <span>{filesGranted ? '✓' : '○'}</span>
                Folder Access {filesGranted ? 'Granted' : 'Not Granted'}
              </div>
            </div>
            {(!micGranted || !filesGranted) && (
              <div className={styles.permissionNote}>
                <p>
                  You can grant missing permissions later by clicking the status indicator at the top of the window
                  or visiting System Settings &gt; Privacy &amp; Security.
                </p>
                <div className={styles.permissionNoteActions}>
                  {!micGranted && (
                    <Button 
                      variant="ghost"
                      onClick={() => openSystemPreferences('microphone')}
                    >
                      Open Microphone Settings
                    </Button>
                  )}
                  {!filesGranted && (
                    <Button 
                      variant="ghost"
                      onClick={() => openSystemPreferences('files')}
                    >
                      Open File Access Settings
                    </Button>
                  )}
                </div>
              </div>
            )}
            <Button onClick={onClose}>
              Start Using Mindstone Rebel
            </Button>
          </>
        )}
      </div>
    </div>
  );
};
