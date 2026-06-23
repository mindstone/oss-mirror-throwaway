import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Notice,
  Spinner,
} from '@renderer/components/ui';
import { Check, CheckCircle2, Copy } from 'lucide-react';
import { RECALL_DESKTOP_SDK_INSTALL_COMMAND } from '@shared/recallRecorder';
import styles from '../SettingsSurface.module.css';
import { useRecorderInstall } from '../../hooks/useRecorderInstall';

const TITLE_ID = 'meeting-recorder-install-dialog-title';
const DESC_ID = 'meeting-recorder-install-dialog-desc';
const COPY_FEEDBACK_MS = 1800;

export interface RecorderInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the recorder is installed (so the parent can refresh its gate). */
  onInstalled?: () => void;
}

/**
 * The "Set up the meeting recorder" dialog. One dialog, four phases
 * (idle → installing → success / failure) with a constant header. Self-contained:
 * it owns the install state machine ({@link useRecorderInstall}), the copy-command
 * fallback, and the "don't close mid-install" guard. See the Chief Designer UI
 * brief in docs/plans/260618_recorder-install-button.
 */
export function RecorderInstallDialog({ open, onOpenChange, onInstalled }: RecorderInstallDialogProps) {
  const { phase, errorMessage, unsupportedPlatform, install, cancel, restart, reset } =
    useRecorderInstall(onInstalled);

  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopyCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(RECALL_DESKTOP_SDK_INSTALL_COMMAND);
      setCopyError(null);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, COPY_FEEDBACK_MS);
    } catch {
      setCopyError("Couldn't copy the command. The text is still there, being quietly useful.");
    }
  }, []);

  const installing = phase === 'installing';

  // Move focus to the actionable control whenever a phase renders, so keyboard /
  // screen-reader users land on (and hear) the right button. (The shared Dialog
  // does not provide a focus trap; see plan Discovered Improvements.)
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => primaryActionRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open, phase]);

  // A close request (X / Escape / "Maybe later") while installing aborts the
  // install instead of stranding it running; otherwise close + reset to idle.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && installing) {
        cancel();
        return;
      }
      if (!next) {
        reset();
        setCopied(false);
        setCopyError(null);
      }
      onOpenChange(next);
    },
    [installing, cancel, onOpenChange, reset],
  );

  const close = useCallback(() => handleOpenChange(false), [handleOpenChange]);

  const copyCommandBlock = (
    <>
      <code className={styles.recorderInstallCommand} data-testid="meeting-recorder-install-command">
        {RECALL_DESKTOP_SDK_INSTALL_COMMAND}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void handleCopyCommand()}
        data-testid="meeting-recorder-copy-command-button"
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        <span>{copied ? 'Copied' : 'Copy command'}</span>
      </Button>
      {copyError && <p className={styles.errorMessage}>{copyError}</p>}
    </>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      disableOutsideClose={installing}
      ariaLabelledBy={TITLE_ID}
      ariaDescribedBy={DESC_ID}
    >
      <DialogContent size="md" data-testid="meeting-recorder-install-dialog">
        <DialogHeader onClose={close} closeDisabled={installing}>
          <DialogTitle id={TITLE_ID}>Set up the meeting recorder</DialogTitle>
          <DialogDescription id={DESC_ID}>
            Recall provides the recorder software. You choose whether to install it.
          </DialogDescription>
        </DialogHeader>

        {phase === 'idle' && (
          <>
            <DialogBody>
              <div className={styles.recorderInstallDialogBody}>
                <p>
                  The meeting recorder is powered by Recall's Desktop SDK. It isn't part of Rebel,
                  so it's installed directly from Recall, under Recall's terms.
                </p>
                <p>Rebel can install it for you — it takes about a minute and changes nothing else.</p>
                <details className={styles.recorderInstallDetails}>
                  <summary className={styles.recorderInstallFallbackToggle}>
                    Prefer to run it yourself?
                  </summary>
                  <div className={styles.recorderInstallDialogBody}>
                    <p>Run this command in this project, then restart Rebel:</p>
                    {copyCommandBlock}
                  </div>
                </details>
                <p className={styles.recorderInstallReassurance}>
                  Prefer not to? No problem. Skip this and Rebel works exactly as before, minus the recorder.
                </p>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Maybe later
              </Button>
              <Button
                ref={primaryActionRef}
                type="button"
                onClick={install}
                data-testid="meeting-recorder-install-button"
              >
                Install it for me
              </Button>
            </DialogFooter>
          </>
        )}

        {phase === 'installing' && (
          <>
            <DialogBody>
              <div className={styles.recorderInstallProgress}>
                <Spinner size="md" label="Installing the recorder. This can take up to a minute." />
                <p className={styles.recorderInstallReassurance}>
                  You can keep using Rebel while this finishes.
                </p>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button
                ref={primaryActionRef}
                type="button"
                variant="ghost"
                onClick={cancel}
                data-testid="meeting-recorder-cancel-button"
              >
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}

        {phase === 'success' && (
          <>
            <DialogBody>
              <div className={styles.recorderInstallSuccess} aria-live="polite">
                <p>
                  <CheckCircle2 size={18} aria-hidden className={styles.recorderInstallSuccessIcon} />
                  <span>Recorder installed. One more step: restart Rebel so it can load.</span>
                </p>
                <p className={styles.recorderInstallManualNote}>
                  Or restart it yourself anytime. Your settings are saved.
                </p>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Not now
              </Button>
              <Button
                ref={primaryActionRef}
                type="button"
                onClick={restart}
                data-testid="meeting-recorder-restart-button"
              >
                Restart Rebel
              </Button>
            </DialogFooter>
          </>
        )}

        {phase === 'failure' && (
          <>
            <DialogBody>
              <div className={styles.recorderInstallDialogBody}>
                <Notice tone="error" placement="section" role="alert">
                  {errorMessage ??
                    'Something went wrong installing the recorder. You can try again, or run the command below yourself.'}
                </Notice>
                {!unsupportedPlatform && (
                  <>
                    <p>You can also install it yourself — run this command in this project, then restart Rebel:</p>
                    {copyCommandBlock}
                  </>
                )}
              </div>
            </DialogBody>
            <DialogFooter>
              <Button
                ref={unsupportedPlatform ? primaryActionRef : undefined}
                type="button"
                variant="ghost"
                onClick={close}
              >
                Close
              </Button>
              {!unsupportedPlatform && (
                <Button
                  ref={primaryActionRef}
                  type="button"
                  onClick={install}
                  data-testid="meeting-recorder-retry-button"
                >
                  Try again
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
