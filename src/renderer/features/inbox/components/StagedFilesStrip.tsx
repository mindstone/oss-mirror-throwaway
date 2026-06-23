import { memo, useState, useCallback, useEffect } from 'react';
import { FileStack, ChevronDown, Check, X } from 'lucide-react';
import { useToast } from '@renderer/components/ui';
import type { StagedFileItem } from '../hooks/useStagedFiles';
import { StagedFileCard } from './StagedFileCard';
import { StagedFilePreviewDialog } from './StagedFilePreviewDialog';
import { appendErrorReason } from '@renderer/utils/actionErrorMessage';
import styles from './StagedFilesStrip.module.css';

export type StagedFilesStripProps = {
  files: StagedFileItem[];
  onNavigateToSession: (sessionId: string) => void;
  onOpenFilePath: (path: string) => Promise<void> | void;
  onPublish: (id: string) => Promise<{ 
    success: boolean; 
    hasConflict?: boolean; 
    error?: string;
    conflict?: { realContent: string; stagedContent: string };
  }>;
  onDiscard: (id: string) => Promise<{ success: boolean; error?: string }>;
  onKeepPrivate?: (id: string) => Promise<{ success: boolean; error?: string; destinationPath?: string }>;
  onPublishAll: () => void;
  onDiscardAll: () => void;
  /** Send a message to a specific session (for conversational approval instructions) */
  onSendMessageToSession?: (sessionId: string, message: string) => Promise<void>;
};

const StagedFilesStripComponent = ({
  files,
  onNavigateToSession,
  onOpenFilePath,
  onPublish,
  onDiscard,
  onKeepPrivate,
  onPublishAll,
  onSendMessageToSession,
}: StagedFilesStripProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [previewFile, setPreviewFile] = useState<StagedFileItem | null>(null);
  const [initialConflictData, setInitialConflictData] = useState<{ realContent: string; stagedContent: string } | null>(null);
  const { showToast } = useToast();

  // Reset expanded state when files drop to 0 or 1
  useEffect(() => {
    if (files.length <= 1) {
      setIsExpanded(false);
    }
  }, [files.length]);

  // Close preview if file is no longer in list
  useEffect(() => {
    if (previewFile && !files.find(f => f.id === previewFile.id)) {
      setPreviewFile(null);
    }
  }, [files, previewFile]);

  // Clear stale conflict data when switching to a different preview file
  useEffect(() => {
    setInitialConflictData(null);
  }, [previewFile?.id]);

  const handleBarClick = useCallback(() => {
    if (files.length === 1) {
      // Single file - open preview
      setPreviewFile(files[0]);
      return;
    }
    setIsExpanded((prev) => !prev);
  }, [files]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleBarClick();
      }
    },
    [handleBarClick]
  );

  const handleDenyAll = useCallback(async () => {
    if (!onKeepPrivate) {
      showToast({
        title: 'Unable to deny all files',
        description: 'Private redirect is unavailable for staged files.',
        variant: 'error',
      });
      return;
    }

    await Promise.all(files.map(async (file) => {
      await onKeepPrivate(file.id);
    }));
  }, [files, onKeepPrivate, showToast]);

  if (files.length === 0) {
    return null;
  }

  const count = files.length;
  const label =
    count === 1
      ? `"${files[0].fileName}" ready to save`
      : `${count} files ready to save`;

  const showChevron = count > 1;

  return (
    <div
      className={styles.strip}
      data-expanded={isExpanded}
      data-count={count}
    >
      <button
        type="button"
        className={styles.header}
        onClick={handleBarClick}
        onKeyDown={handleKeyDown}
        aria-expanded={showChevron ? isExpanded : undefined}
        aria-label={label}
      >
        <FileStack className={styles.icon} size={16} />
        <span className={styles.label}>{label}</span>
        {showChevron && (
          <ChevronDown className={styles.chevron} size={14} />
        )}
        {count === 1 && files[0].sessionId && (
          <span className={styles.singleHint}>Click to review</span>
        )}
      </button>

      {isExpanded && count > 1 && (
        <div className={styles.body}>
          <div className={styles.batchActions}>
            <button
              type="button"
              className={styles.publishAllButton}
              onClick={onPublishAll}
              title="Allow all files to publish to their target spaces"
            >
              <Check size={14} />
              Allow All
            </button>
            <button
              type="button"
              className={styles.discardAllButton}
              onClick={() => void handleDenyAll()}
              title="Deny all staged files and save them privately"
            >
              <X size={14} />
              Deny All
            </button>
          </div>
          {files.map((file) => (
            <StagedFileCard
              key={file.id}
              file={file}
              onPreview={() => setPreviewFile(file)}
              onApprove={async () => {
                const result = await onPublish(file.id);
                if (!result.success) {
                  if (result.hasConflict && result.conflict) {
                    setInitialConflictData({
                      realContent: result.conflict.realContent,
                      stagedContent: result.conflict.stagedContent,
                    });
                    setPreviewFile(file);
                  } else {
                    showToast({
                      title: appendErrorReason('Failed to save file', result.error),
                      description: 'The file is still waiting, so you can try again.',
                      variant: 'error',
                    });
                  }
                }
              }}
              onDeny={() => {
                if (onKeepPrivate) {
                  void onKeepPrivate(file.id);
                  return;
                }
                showToast({
                  title: 'Unable to deny file',
                  description: 'Private redirect is unavailable for this staged file.',
                  variant: 'error',
                });
              }}
            />
          ))}
        </div>
      )}

      <StagedFilePreviewDialog
        file={previewFile}
        onClose={() => { setPreviewFile(null); setInitialConflictData(null); }}
        onOpenFilePath={onOpenFilePath}
        onPublish={onPublish}
        onDiscard={onDiscard}
        onKeepPrivate={onKeepPrivate}
        onSendMessageToSession={onSendMessageToSession}
        onNavigateToSession={onNavigateToSession}
        initialConflictData={initialConflictData}
      />
    </div>
  );
};

export const StagedFilesStrip = memo(StagedFilesStripComponent);
StagedFilesStrip.displayName = 'StagedFilesStrip';
