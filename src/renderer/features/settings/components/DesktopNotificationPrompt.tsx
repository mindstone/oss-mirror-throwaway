import { memo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  Button,
} from '@renderer/components/ui';
import { Bell } from 'lucide-react';

type DesktopNotificationPromptProps = {
  isOpen: boolean;
  onEnable: () => Promise<void>;
  onDismiss: (source?: 'secondary_button' | 'dialog_close') => Promise<void>;
  onOpenSettings: () => void;
};

export const DesktopNotificationPrompt = memo(function DesktopNotificationPrompt({
  isOpen,
  onEnable,
  onDismiss,
  onOpenSettings,
}: DesktopNotificationPromptProps) {
  const handleEnable = async () => {
    await onEnable();
    onOpenSettings();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) void onDismiss('dialog_close'); }}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bell size={20} />
            <DialogTitle>Stay in the loop</DialogTitle>
          </div>
          <DialogDescription>
            Rebel can send you a notification when automations and conversations
            finish — even when you're working in another app.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p style={{ fontSize: '0.875rem', opacity: 0.7, margin: 0 }}>
            You can always adjust which notifications you receive in Settings.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => void onDismiss('secondary_button')}>
            No thanks
          </Button>
          <Button onClick={() => void handleEnable()}>
            Enable notifications
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
