import { memo, useCallback, useEffect, useState } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import { RotateCw, X, Mic, AlertCircle, FolderOpen, Settings } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import { formatRelativeTime as _formatRelativeTime } from '@rebel/shared';
import { usePendingAudio, type PendingAudioFileState, type VoiceErrorCategory } from '@renderer/features/voice';
import styles from './PendingAudioPopover.module.css';

type PendingAudioPopoverProps = {
  /** Hide trigger when actively recording */
  isTranscribing: boolean;
  /** Hide trigger when processing a recording */
  isTranscribeProcessing: boolean;
  /** Callback to open settings (for voice key/billing issues) */
  onOpenSettings?: () => void;
};

/** Format a timestamp as a short relative time string */
const formatRelativeTime = (timestamp: number): string =>
  _formatRelativeTime(timestamp, { includeMinutes: false });

const sourceLabel = (source: PendingAudioFileState['source']): string =>
  source === 'voice-mode' ? 'Voice mode' : 'Voice note';

/** Map a dominant error category to a reassuring subtext message */
const categorySubtext: Record<VoiceErrorCategory, string> = {
  temporary: 'The transcription service hiccupped. Your recording is safe.',
  billing: 'Your voice provider account needs attention. Recording is safe.',
  auth: "There's an API key issue. Your recording is safe.",
  network: "Couldn't reach the transcription service. Your recording is safe.",
  'provider-error': "Transcription didn't finish, but your recording is safe.",
};

const MIXED_SUBTEXT = "Transcription didn't finish, but your recording is safe.";

/**
 * Compute the dominant error category across all files.
 * Returns the shared category if all files have the same one, otherwise null.
 */
function getDominantCategory(files: PendingAudioFileState[]): VoiceErrorCategory | null {
  if (files.length === 0) return null;
  // ALL files must have the same category (including no undefined/missing categories)
  const first = files[0].errorCategory;
  if (!first) return null;
  return files.every(f => f.errorCategory === first) ? first : null;
}

type PendingFileRowProps = {
  file: PendingAudioFileState;
  onRetry: (filePath: string) => void;
  onReveal: (filePath: string) => void;
  onDismiss: (filePath: string) => void;
};

const PendingFileRow = memo(function PendingFileRow({
  file,
  onRetry,
  onReveal,
  onDismiss,
}: PendingFileRowProps) {
  return (
    <div
      className={styles.fileRow}
      data-testid="pending-audio-row"
      onClick={() => !file.isRetrying && onRetry(file.filePath)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' && !file.isRetrying) onRetry(file.filePath); }}
    >
      <div className={styles.fileRowIcon}>
        <Mic size={14} aria-hidden />
      </div>
      <div className={styles.fileRowContent}>
        <div className={styles.fileRowMeta}>
          <span className={styles.fileRowLabel}>{sourceLabel(file.source)}</span>
          <span className={styles.fileRowTime}>{formatRelativeTime(file.createdAt)}</span>
        </div>
        {file.lastError && (
          <span className={styles.fileRowError}>{file.lastError}</span>
        )}
        {!file.lastError && (
          <span className={styles.fileRowHint}>Click to retry transcription</span>
        )}
      </div>
      <div className={styles.fileRowActions}>
        <Tooltip content="Retry transcription" placement="top" delayShow={300}>
          <button
            type="button"
            className={styles.actionButton}
            onClick={(e) => { e.stopPropagation(); onRetry(file.filePath); }}
            onKeyDown={(e) => e.stopPropagation()}
            disabled={file.isRetrying}
            aria-label="Retry transcription"
            data-testid="pending-audio-retry"
          >
            <RotateCw size={13} aria-hidden className={file.isRetrying ? styles.spinning : undefined} />
          </button>
        </Tooltip>
        <Tooltip content="Show recording in file explorer" placement="top" delayShow={300}>
          <button
            type="button"
            className={styles.actionButton}
            onClick={(e) => { e.stopPropagation(); onReveal(file.filePath); }}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label="Show recording in file explorer"
            data-testid="pending-audio-reveal"
          >
            <FolderOpen size={13} aria-hidden />
          </button>
        </Tooltip>
        <Tooltip content="Dismiss recording" placement="top" delayShow={300}>
          <button
            type="button"
            className={styles.actionButton}
            onClick={(e) => { e.stopPropagation(); onDismiss(file.filePath); }}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label="Dismiss recording"
            data-testid="pending-audio-dismiss"
          >
            <X size={13} aria-hidden />
          </button>
        </Tooltip>
      </div>
    </div>
  );
});

const PendingAudioPopoverComponent = ({
  isTranscribing,
  isTranscribeProcessing,
  onOpenSettings,
}: PendingAudioPopoverProps) => {
  const {
    files,
    pendingCount,
    retryFile,
    revealFile,
    dismissFile,
    dismissAll,
    retryAllInlineMic,
    isRetrying,
  } = usePendingAudio();

  const [isOpen, setIsOpen] = useState(false);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'top-start',
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'dialog' });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  // Auto-close when last item is dismissed
  useEffect(() => {
    if (isOpen && pendingCount === 0) {
      setIsOpen(false);
    }
  }, [isOpen, pendingCount]);

  const handleDismissFile = useCallback(
    (filePath: string) => {
      void dismissFile(filePath);
    },
    [dismissFile],
  );

  const handleRetryFile = useCallback(
    (filePath: string) => {
      void retryFile(filePath);
    },
    [retryFile],
  );

  const handleRevealFile = useCallback(
    (filePath: string) => {
      void revealFile(filePath);
    },
    [revealFile],
  );

  const handleDismissAll = useCallback(() => {
    void dismissAll();
  }, [dismissAll]);

  const handleRetryAll = useCallback(() => {
    void retryAllInlineMic();
  }, [retryAllInlineMic]);

  const handleNewRecording = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Don't render when there's nothing pending or when mic is active
  if (pendingCount === 0 || isTranscribing || isTranscribeProcessing) {
    return null;
  }

  const hasInlineMic = files.some(f => f.source === 'inline-mic');
  const showSettingsButton = files.some(
    f => f.errorCategory === 'auth' || f.errorCategory === 'billing',
  );
  const showFooter = files.length >= 2 || showSettingsButton;

  const headerTitle = pendingCount === 1
    ? 'Recording saved'
    : `${pendingCount} recordings saved`;

  const dominantCategory = getDominantCategory(files);
  const headerSubtext = dominantCategory
    ? categorySubtext[dominantCategory]
    : MIXED_SUBTEXT;

  return (
    <>
      <Tooltip content={`${pendingCount} recording${pendingCount === 1 ? '' : 's'} failed transcription`} placement="top" delayShow={300}>
        <span className={styles.triggerWrapper}>
          <button
            ref={refs.setReference}
            type="button"
            className={styles.trigger}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            aria-label={`${pendingCount} failed recording${pendingCount === 1 ? '' : 's'}`}
            data-testid="pending-audio-trigger"
            {...getReferenceProps()}
          >
            <AlertCircle size={14} aria-hidden />
          </button>
        </span>
      </Tooltip>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={styles.popover}
            data-positioned={isPositioned}
            aria-label="Pending voice recordings"
            data-testid="pending-audio-popover"
            {...getFloatingProps()}
          >
            {/* Header */}
            <div className={styles.header}>
              <span className={styles.headerTitle}>{headerTitle}</span>
              <span className={styles.headerSubtext}>
                {headerSubtext}
              </span>
            </div>

            {/* Scrollable file list */}
            <div className={styles.fileList}>
              {files.map((file) => (
                <PendingFileRow
                  key={file.filePath}
                  file={file}
                  onRetry={handleRetryFile}
                  onReveal={handleRevealFile}
                  onDismiss={handleDismissFile}
                />
              ))}
            </div>

            {/* Footer with batch actions */}
            {showFooter && (
              <div className={styles.footer}>
                <div className={styles.footerLeft}>
                  <button
                    type="button"
                    className={styles.footerButtonSecondary}
                    onClick={handleNewRecording}
                    data-testid="pending-audio-new-recording"
                  >
                    <Mic size={12} aria-hidden />
                    New recording
                  </button>
                  {showSettingsButton && onOpenSettings && (
                    <button
                      type="button"
                      className={styles.footerButtonSecondary}
                      onClick={onOpenSettings}
                      data-testid="pending-audio-open-settings"
                    >
                      <Settings size={12} aria-hidden />
                      Open Settings
                    </button>
                  )}
                </div>
                <div className={styles.footerRight}>
                  {hasInlineMic && (
                    <button
                      type="button"
                      className={styles.footerButton}
                      onClick={handleRetryAll}
                      disabled={isRetrying}
                      data-testid="pending-audio-retry-all"
                    >
                      {isRetrying ? 'Retrying…' : 'Retry all'}
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.footerButtonDestructive}
                    onClick={handleDismissAll}
                    data-testid="pending-audio-clear-all"
                  >
                    Clear all
                  </button>
                </div>
              </div>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

export const PendingAudioPopover = memo(PendingAudioPopoverComponent);
PendingAudioPopover.displayName = 'PendingAudioPopover';
