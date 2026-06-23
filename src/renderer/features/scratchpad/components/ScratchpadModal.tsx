import { useCallback, useEffect, useState, useRef } from 'react';
import { FileText, Sparkles, Loader2, Settings } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  Button,
  MaturityBadge,
  Tooltip
} from '@renderer/components/ui';
import { writeFileOrFail } from '@renderer/utils/libraryWrites';
import { WriteFailureError } from '@shared/utils/documentIoErrorClassification';
import { useScratchpad } from '../hooks/useScratchpad';
import { useRecentMemoryFiles } from '../hooks/useRecentMemoryFiles';
import { TasksPanel } from './TasksPanel';
import styles from './ScratchpadModal.module.css';

export interface ScratchpadModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  coreDirectory: string | null;
  onOpenFile: (path: string) => void;
  showToast: (options: { title: string }) => void;
  onOpenSettings?: () => void;
  onAskRebel?: (prompt: string) => void;
}

export const ScratchpadModal = ({
  open,
  onOpenChange,
  coreDirectory,
  onOpenFile,
  showToast,
  onOpenSettings,
  onAskRebel,
}: ScratchpadModalProps) => {
  const {
    content,
    setContent,
    loading,
    error,
    isDirty,
    lastModified,
    save,
    load,
    textareaRef,
    selection,
    updateSelection
  } = useScratchpad({
    coreDirectory,
    onError: (msg) => showToast({ title: `Scratchpad error: ${msg}` })
  });

  const { files: recentFiles, refresh: refreshRecentFiles } = useRecentMemoryFiles({
    coreDirectory,
    enabled: open
  });

  const [showMakeNoteDialog, setShowMakeNoteDialog] = useState(false);
  const [suggestion, setSuggestion] = useState<{
    folder: string;
    filename: string;
    reasoning: string;
  } | null>(null);
  const [isCreatingNote, setIsCreatingNote] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const hasInitializedRef = useRef(false);

  // Load scratchpad when modal opens (only once per open)
  useEffect(() => {
    if (open && !hasInitializedRef.current) {
      hasInitializedRef.current = true;
      void load();
      void refreshRecentFiles();
    } else if (!open) {
      hasInitializedRef.current = false;
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- intentional: omitting load/refreshRecentFiles so initialization runs once per open transition, not when callback identities change

  const handleClose = useCallback(async () => {
    await save();
    onOpenChange(false);
  }, [save, onOpenChange]);

  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setContent(e.target.value);
    },
    [setContent]
  );

  const handleRecentFileClick = useCallback(
    (path: string) => {
      handleClose();
      onOpenFile(path);
    },
    [handleClose, onOpenFile]
  );

  const handleMakeNote = useCallback(async () => {
    if (!selection?.text) return;

    setIsSuggesting(true);
    try {
      const result = await window.scratchpadApi.suggestLocation({ content: selection.text });
      setSuggestion({
        folder: result.suggestedFolder,
        filename: result.suggestedFilename,
        reasoning: result.reasoning
      });
      setShowMakeNoteDialog(true);
    } catch {
      showToast({ title: 'Could not suggest location. Please try again.' });
    } finally {
      setIsSuggesting(false);
    }
  }, [selection, showToast]);

  const handleConfirmMakeNote = useCallback(async () => {
    if (!suggestion || !selection) return;

    setIsCreatingNote(true);
    try {
      const fullPath = `${suggestion.folder}/${suggestion.filename}`;
      
      console.warn('[Scratchpad] Creating note at:', fullPath);
      
      // Ensure the folder exists
      try {
        await window.libraryApi.createFolder({
          parentPath: suggestion.folder.split('/').slice(0, -1).join('/') || undefined,
          folderName: suggestion.folder.split('/').pop() || 'topics'
        });
        console.warn('[Scratchpad] Folder created/verified');
      } catch (folderErr) {
        console.warn('[Scratchpad] Folder creation error (may already exist):', folderErr);
      }

      // Create and write the file
      const writeResult = await writeFileOrFail({
        path: fullPath,
        content: selection.text
      });
      if (writeResult.result === 'conflict') {
        showToast({ title: 'Save failed: file changed externally.' });
        return;
      }
      console.warn('[Scratchpad] File written:', writeResult);

      // Remove selected text from scratchpad
      const newContent = content.slice(0, selection.start) + content.slice(selection.end);
      setContent(newContent);
      await save();

      showToast({ title: `Note created: ${suggestion.filename}` });
      setShowMakeNoteDialog(false);
      setSuggestion(null);
      
      // Refresh recent files to show the new one (small delay to ensure file write is synced)
      setTimeout(() => {
        void refreshRecentFiles();
      }, 100);
    } catch (err) {
      if (err instanceof WriteFailureError) {
        showToast({ title: 'Unable to save changes.' });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      showToast({ title: `Failed to create note: ${message}` });
    } finally {
      setIsCreatingNote(false);
    }
  }, [suggestion, selection, content, setContent, save, showToast, refreshRecentFiles]);

  const handleCancelMakeNote = useCallback(() => {
    setShowMakeNoteDialog(false);
    setSuggestion(null);
  }, []);

  if (!open) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose} disableOutsideClose>
        <DialogContent size="xl" className={styles.modal}>
          <DialogHeader onClose={handleClose}>
            <DialogTitle className={styles.dialogTitle}>
              Scratchpad
              <MaturityBadge level="early" featureName="Scratchpad" />
            </DialogTitle>
            <DialogDescription>Quick capture for notes and tasks</DialogDescription>
          </DialogHeader>

          <DialogBody className={styles.body}>
            <div className={styles.twoColumnLayout}>
              {/* Left column: scratchpad */}
              <div className={styles.scratchpadColumn}>
                {loading ? (
                  <div className={styles.loading}>
                    <Loader2 className={styles.spinner} size={24} />
                    <span>Loading scratchpad...</span>
                  </div>
                ) : error ? (
                  <div className={styles.error}>
                    <span>{error}</span>
                    <Button variant="ghost" size="sm" onClick={() => void load()}>
                      Retry
                    </Button>
                  </div>
                ) : (
                  <textarea
                    ref={textareaRef}
                    className={styles.textarea}
                    value={content}
                    onChange={handleContentChange}
                    onSelect={updateSelection}
                    placeholder="Capture your thoughts..."
                    spellCheck={false}
                    autoFocus
                  />
                )}
              </div>

              {/* Right column: tasks */}
              <div className={styles.tasksColumn}>
                <TasksPanel 
                  showToast={showToast}
                  onAskRebel={onAskRebel}
                />
              </div>
            </div>
          </DialogBody>

          <DialogFooter className={styles.footer}>
            <div className={styles.recentFiles}>
              {onOpenSettings && (
                <Tooltip content="Configure recent files">
                  <button
                    type="button"
                    className={styles.settingsButton}
                    onClick={onOpenSettings}
                    aria-label="Configure scratchpad settings"
                  >
                    <Settings size={14} />
                  </button>
                </Tooltip>
              )}
              {recentFiles.length > 0 && (
                <>
                  <span className={styles.recentLabel}>Recent:</span>
                  {recentFiles.slice(0, 3).map((file) => (
                    <Tooltip key={file.path} content={file.relativePath}>
                      <button
                        type="button"
                        className={styles.recentFile}
                        onClick={() => handleRecentFileClick(file.path)}
                      >
                        <FileText size={12} />
                        <span>{file.name}</span>
                      </button>
                    </Tooltip>
                  ))}
                </>
              )}
            </div>

            <div className={styles.actions}>
              {isDirty ? (
                <span className={styles.unsaved}>Saving...</span>
              ) : lastModified ? (
                <span className={styles.lastUpdated}>
                  Updated {new Intl.DateTimeFormat([], {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit'
                  }).format(lastModified)}
                </span>
              ) : null}
              <Tooltip content={selection ? 'Save selected text as a new note' : 'Select text to save as a note'}>
                <span style={{ display: 'inline-flex' }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!selection?.text || isSuggesting}
                    onClick={() => void handleMakeNote()}
                  >
                    {isSuggesting ? (
                      <Loader2 className={styles.spinner} size={14} />
                    ) : (
                      <Sparkles size={14} />
                    )}
                    New Note
                  </Button>
                </span>
              </Tooltip>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Note Confirmation Dialog */}
      <Dialog open={showMakeNoteDialog} onOpenChange={handleCancelMakeNote}>
        <DialogContent size="sm">
          <DialogHeader onClose={handleCancelMakeNote}>
            <DialogTitle>Create Note</DialogTitle>
          </DialogHeader>

          <DialogBody>
            {suggestion && (
              <div className={styles.suggestionDetails}>
                <div className={styles.suggestionRow}>
                  <span className={styles.suggestionLabel}>Location:</span>
                  <code className={styles.suggestionPath}>{suggestion.folder}</code>
                </div>
                <div className={styles.suggestionRow}>
                  <span className={styles.suggestionLabel}>Filename:</span>
                  <code className={styles.suggestionPath}>{suggestion.filename}</code>
                </div>
                <p className={styles.suggestionReasoning}>{suggestion.reasoning}</p>
              </div>
            )}
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" onClick={handleCancelMakeNote} disabled={isCreatingNote}>
              Cancel
            </Button>
            <Button onClick={() => void handleConfirmMakeNote()} disabled={isCreatingNote}>
              {isCreatingNote ? (
                <>
                  <Loader2 className={styles.spinner} size={14} />
                  Creating...
                </>
              ) : (
                'Create Note'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

ScratchpadModal.displayName = 'ScratchpadModal';
