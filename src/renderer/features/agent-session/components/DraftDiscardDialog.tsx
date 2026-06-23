import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  Button
} from '@renderer/components/ui';
import styles from './DraftDiscardDialog.module.css';

type DraftDiscardDialogProps = {
  draftPreview: string;
  /** Type of content being discarded - affects dialog copy */
  type?: 'draft' | 'attachments';
  onDiscard: () => void;
  onCancel: () => void;
};

const truncatePreview = (text: string, maxLength = 120): string => {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength).trim() + '…';
};

export const DraftDiscardDialog = ({
  draftPreview,
  type = 'draft',
  onDiscard,
  onCancel
}: DraftDiscardDialogProps) => {
  const preview = truncatePreview(draftPreview);
  const isAttachments = type === 'attachments';

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent size="sm" className={styles.content}>
        <DialogHeader icon={isAttachments ? '📎' : '✏️'} className={styles.header}>
          <span className={styles.overline}>{isAttachments ? 'Unsaved attachments' : 'Unsent message'}</span>
          <DialogTitle>
            {isAttachments
              ? 'Attachments will be lost'
              : 'You have text that hasn\'t been sent'}
          </DialogTitle>
          <DialogDescription>
            {isAttachments
              ? 'Attachments are not saved with drafts. They will be lost if you switch. Continue?'
              : 'Switching away will discard this message. Are you sure?'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {preview && (
            <div className={styles.preview}>
              <span className={styles.previewLabel}>{isAttachments ? 'Attachments:' : 'Your draft:'}</span>
              <span className={styles.previewText}>{isAttachments ? preview : `"${preview}"`}</span>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {isAttachments ? 'Stay here' : 'Keep editing'}
          </Button>
          <Button className={styles.discardButton} onClick={onDiscard}>
            {isAttachments ? 'Switch anyway' : 'Discard and continue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

DraftDiscardDialog.displayName = 'DraftDiscardDialog';
