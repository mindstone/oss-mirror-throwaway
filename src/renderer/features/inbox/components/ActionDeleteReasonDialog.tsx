import { useCallback, useEffect, useId, useState } from 'react';
import type { InboxDismissReasonCategory } from '@shared/types';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui';
import styles from './ActionDeleteReasonDialog.module.css';

export type ActionDeleteReason = {
  category?: InboxDismissReasonCategory;
  text?: string;
};

const REASON_OPTIONS: Array<{ value: InboxDismissReasonCategory; label: string }> = [
  { value: 'not_useful', label: 'Not useful' },
  { value: 'not_an_action', label: 'Not an action' },
  { value: 'wrong_context', label: 'Wrong context' },
  { value: 'already_handled', label: 'Already handled' },
  { value: 'other', label: 'Other' },
];

type ActionDeleteReasonDialogProps = {
  open: boolean;
  itemTitle?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason?: ActionDeleteReason) => void;
};

export function ActionDeleteReasonDialog({
  open,
  itemTitle,
  onOpenChange,
  onConfirm,
}: ActionDeleteReasonDialogProps) {
  const titleId = useId();
  const [category, setCategory] = useState<InboxDismissReasonCategory | undefined>();
  const [text, setText] = useState('');

  useEffect(() => {
    if (!open) {
      setCategory(undefined);
      setText('');
    }
  }, [open]);

  const handleConfirm = useCallback(() => {
    const trimmed = text.trim();
    onConfirm(category || trimmed ? { category, text: trimmed || undefined } : undefined);
  }, [category, onConfirm, text]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} ariaLabelledBy={titleId}>
      <DialogContent size="sm">
        <DialogHeader onClose={() => onOpenChange(false)}>
          <DialogTitle id={titleId}>Delete this action?</DialogTitle>
          <DialogDescription>
            Optional, but useful: tell Rebel why this action missed so future suggestions get less annoying.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {itemTitle ? <p className={styles.itemTitle}>{itemTitle}</p> : null}
          <div className={styles.reasonGrid} role="group" aria-label="Delete reason">
            {REASON_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                size="xs"
                variant={category === option.value ? 'secondary' : 'ghost'}
                className={styles.reasonButton}
                aria-pressed={category === option.value}
                onClick={() => setCategory((current) => current === option.value ? undefined : option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <label className={styles.textLabel}>
            Anything else?
            <textarea
              className={styles.textarea}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="e.g. This was just a status update, not something I needed to do."
              rows={3}
            />
          </label>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={handleConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
