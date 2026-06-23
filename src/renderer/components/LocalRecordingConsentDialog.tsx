import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@renderer/components/ui/Dialog';
import { Button } from '@renderer/components/ui/Button';
import { Mic } from 'lucide-react';

interface LocalRecordingConsentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (dontShowAgain: boolean) => void;
  onCancel: () => void;
}

/**
 * Consent dialog shown before first local recording.
 * Warns user that local recording is invisible to other participants.
 */
export function LocalRecordingConsentDialog({
  open,
  onOpenChange,
  onConfirm,
  onCancel,
}: LocalRecordingConsentDialogProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const handleConfirm = () => {
    onConfirm(dontShowAgain);
    onOpenChange(false);
  };

  const handleCancel = () => {
    onCancel();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Mic size={20} style={{ opacity: 0.6 }} />
            <DialogTitle>Before you record locally</DialogTitle>
          </div>
          <DialogDescription>
            Local recording captures audio from your computer without other
            participants seeing a bot in the meeting.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p style={{ fontSize: '14px', opacity: 0.7, marginBottom: '16px' }}>
            You are responsible for obtaining consent from other participants
            where required by law.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              style={{ width: '16px', height: '16px' }}
            />
            <span>Don't show this again</span>
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>
            I Understand, Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
