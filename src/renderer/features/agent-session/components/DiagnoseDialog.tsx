/**
 * DiagnoseDialog
 *
 * A dialog for initiating conversation diagnosis.
 * User can optionally describe their problem before starting diagnosis.
 */

import { useState, useCallback, useEffect } from 'react';
import { Stethoscope } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Button,
  Textarea,
} from '@renderer/components/ui';
import styles from './DiagnoseDialog.module.css';

interface DiagnoseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionTitle: string;
  onConfirm: (userDescription: string) => void;
}

export const DiagnoseDialog = ({
  open,
  onOpenChange,
  sessionTitle,
  onConfirm,
}: DiagnoseDialogProps) => {
  const [description, setDescription] = useState('');

  // Reset description when dialog closes (handles ESC, overlay click, etc.)
  useEffect(() => {
    if (!open) {
      setDescription('');
    }
  }, [open]);

  const handleConfirm = useCallback(() => {
    onConfirm(description.trim());
    onOpenChange(false);
  }, [description, onConfirm, onOpenChange]);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const hasDescription = description.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader icon={<Stethoscope size={20} />}>
          <DialogTitle>Diagnose conversation</DialogTitle>
        </DialogHeader>
        <DialogBody className={styles.body}>
          <p className={styles.subtitle}>
            I'll analyze <strong>{sessionTitle}</strong> to help you understand what happened.
          </p>
          <div className={styles.inputWrapper}>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What went wrong? (optional)"
              aria-label="Describe the problem (optional)"
              className={styles.textarea}
              rows={3}
              maxLength={500}
              autoFocus
            />
            <p className={styles.hint} id="diagnose-hint">
              Describe the issue to help focus the diagnosis, or skip to get a general analysis.
            </p>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>
            {hasDescription ? 'Send to Rebel' : 'Skip and diagnose'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

DiagnoseDialog.displayName = 'DiagnoseDialog';
