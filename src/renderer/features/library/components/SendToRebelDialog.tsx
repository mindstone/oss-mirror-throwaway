/**
 * SendToRebelDialog
 *
 * Dialog for smart routing of annotations to conversations.
 * Shows options based on file's conversation history.
 */

import { useState, useEffect, useCallback } from 'react';
import { MessageSquare, Plus, History } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@renderer/components/ui/Dialog';
import { Button } from '@renderer/components/ui/Button';
import { formatRelativeTime } from '@rebel/shared';
import type { FileConversationLink } from '@shared/ipc/channels/fileConversation';
import styles from './SendToRebelDialog.module.css';

export type SendTarget = 'file-conversation' | 'last-active' | 'new';

export interface SendToRebelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  fileName: string;
  annotationCount: number;
  lastActiveSessionId?: string | null;
  lastActiveSessionTitle?: string | null;
  onSend: (target: SendTarget, sessionId?: string, clearComments?: boolean) => void;
}

export function SendToRebelDialog({
  open,
  onOpenChange,
  filePath,
  fileName,
  annotationCount,
  lastActiveSessionId,
  lastActiveSessionTitle,
  onSend,
}: SendToRebelDialogProps) {
  const [selectedTarget, setSelectedTarget] = useState<SendTarget>('new');
  const [clearComments, setClearComments] = useState(true);
  const [fileConversation, setFileConversation] = useState<FileConversationLink | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch file conversation links when dialog opens
  useEffect(() => {
    if (!open || !filePath) return;

    setLoading(true);
    window.fileConversationApi
      .getForFile({ filePath })
      .then((result) => {
        setFileConversation(result.mostRecent);
        // Auto-select best option
        if (result.mostRecent) {
          setSelectedTarget('file-conversation');
        } else if (lastActiveSessionId) {
          setSelectedTarget('last-active');
        } else {
          setSelectedTarget('new');
        }
      })
      .catch(() => {
        setFileConversation(null);
        setSelectedTarget(lastActiveSessionId ? 'last-active' : 'new');
      })
      .finally(() => setLoading(false));
  }, [open, filePath, lastActiveSessionId]);

  const handleSend = useCallback(() => {
    if (selectedTarget === 'file-conversation' && fileConversation) {
      onSend('file-conversation', fileConversation.sessionId, clearComments);
    } else if (selectedTarget === 'last-active' && lastActiveSessionId) {
      onSend('last-active', lastActiveSessionId, clearComments);
    } else {
      onSend('new', undefined, clearComments);
    }
    onOpenChange(false);
  }, [selectedTarget, fileConversation, lastActiveSessionId, onSend, onOpenChange, clearComments]);

  const fmtTime = (ts: number): string =>
    formatRelativeTime(ts, { capitalize: false, includeYesterday: false, absoluteDateAfterDays: false });

  const hasFileConversation = !!fileConversation;
  const hasLastActive = !!lastActiveSessionId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Send {annotationCount} comment{annotationCount !== 1 ? 's' : ''} to Rebel</DialogTitle>
        </DialogHeader>
        <DialogBody className={styles.body}>
          <p className={styles.fileInfo}>
            From <strong>{fileName}</strong>
          </p>

          {loading ? (
            <div className={styles.loading}>Checking conversation history...</div>
          ) : (
            <div className={styles.options}>
              {/* File's conversation option */}
              {hasFileConversation && (
                <label
                  className={`${styles.option} ${selectedTarget === 'file-conversation' ? styles.optionSelected : ''}`}
                >
                  <input
                    type="radio"
                    name="sendTarget"
                    value="file-conversation"
                    checked={selectedTarget === 'file-conversation'}
                    onChange={() => setSelectedTarget('file-conversation')}
                  />
                  <div className={styles.optionIcon}>
                    <History size={18} />
                  </div>
                  <div className={styles.optionContent}>
                    <span className={styles.optionLabel}>Continue file's conversation</span>
                    <span className={styles.optionDescription}>
                      {fileConversation?.sessionTitle || 'Previous conversation'}
                      {' · '}
                      {fmtTime(fileConversation?.timestamp || 0)}
                    </span>
                  </div>
                </label>
              )}

              {/* Last active conversation option */}
              {hasLastActive && lastActiveSessionId !== fileConversation?.sessionId && (
                <label
                  className={`${styles.option} ${selectedTarget === 'last-active' ? styles.optionSelected : ''}`}
                >
                  <input
                    type="radio"
                    name="sendTarget"
                    value="last-active"
                    checked={selectedTarget === 'last-active'}
                    onChange={() => setSelectedTarget('last-active')}
                  />
                  <div className={styles.optionIcon}>
                    <MessageSquare size={18} />
                  </div>
                  <div className={styles.optionContent}>
                    <span className={styles.optionLabel}>Send to current conversation</span>
                    <span className={styles.optionDescription}>
                      {lastActiveSessionTitle || 'Active conversation'}
                    </span>
                  </div>
                </label>
              )}

              {/* New conversation option */}
              <label
                className={`${styles.option} ${selectedTarget === 'new' ? styles.optionSelected : ''}`}
              >
                <input
                  type="radio"
                  name="sendTarget"
                  value="new"
                  checked={selectedTarget === 'new'}
                  onChange={() => setSelectedTarget('new')}
                />
                <div className={styles.optionIcon}>
                  <Plus size={18} />
                </div>
                <div className={styles.optionContent}>
                  <span className={styles.optionLabel}>Start new conversation</span>
                  <span className={styles.optionDescription}>
                    Fresh context for this request
                  </span>
                </div>
              </label>
            </div>
          )}

          <label className={styles.clearOption}>
            <input
              type="checkbox"
              checked={clearComments}
              onChange={(e) => setClearComments(e.target.checked)}
            />
            <span className={styles.clearOptionLabel}>Clear comments from document after sending</span>
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={loading}>
            Send to Rebel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
