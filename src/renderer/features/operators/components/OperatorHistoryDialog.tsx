import { type ReactNode } from 'react';
import type { OperatorMetadata } from '@shared/ipc/channels/operators';
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@renderer/components/ui';
import { OperatorDiaryViewer } from './OperatorDiaryViewer';

interface OperatorHistoryDialogProps {
  operator: OperatorMetadata | null;
  open: boolean;
  onClose: () => void;
}

export function OperatorHistoryDialog({ operator, open, onClose }: OperatorHistoryDialogProps): ReactNode {
  if (!operator) return null;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="lg" data-testid="operator-history-dialog">
        <DialogHeader onClose={onClose}>
          <DialogTitle>{operator.displayName ?? operator.name} — recently asked</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <OperatorDiaryViewer operator={operator} />
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
