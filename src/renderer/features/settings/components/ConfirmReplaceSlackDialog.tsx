import { useId } from 'react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui';
import styles from './ConnectSlackCard.module.css';

export interface ConfirmReplaceSlackDialogProps {
  open: boolean;
  slackName: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function ConfirmReplaceSlackDialog({
  open,
  slackName,
  onOpenChange,
  onConfirm,
}: ConfirmReplaceSlackDialogProps) {
  const titleId = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} ariaLabelledBy={titleId}>
      <DialogContent size="sm">
        <DialogHeader onClose={() => onOpenChange(false)}>
          <DialogTitle id={titleId}>Disconnect current Slack?</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className={styles.dialogBody}>
            Rebel is connected to {slackName}. To connect a different Slack, disconnect this one first.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Keep current</Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>Disconnect and continue</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
