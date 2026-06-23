/**
 * RenameFileDialog Component
 *
 * Dialog for renaming a file in the Library editor.
 * Uses proper Dialog component for reliable focus handling in Electron.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@renderer/components/ui/Dialog';
import { Button, Input } from '@renderer/components/ui';
import { PenLine } from 'lucide-react';

interface RenameFileDialogProps {
  isOpen: boolean;
  onClose: () => void;
  currentName: string;
  onRename: (newName: string) => Promise<void>;
}

export function RenameFileDialog({
  isOpen,
  onClose,
  currentName,
  onRename,
}: RenameFileDialogProps) {
  const [newName, setNewName] = useState(currentName);
  const [isRenaming, setIsRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setNewName(currentName);
      setError(null);
      setIsRenaming(false);
      // Focus and select the filename (excluding extension) after a short delay
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          const dotIndex = currentName.lastIndexOf('.');
          if (dotIndex > 0) {
            inputRef.current.setSelectionRange(0, dotIndex);
          } else {
            inputRef.current.select();
          }
        }
      }, 50);
    }
  }, [isOpen, currentName]);

  const handleRename = useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed) {
      setError('Pick a name for it.');
      return;
    }

    if (trimmed === currentName) {
      onClose();
      return;
    }

    setIsRenaming(true);
    setError(null);

    try {
      await onRename(trimmed);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to rename file';
      setError(message);
      setIsRenaming(false);
    }
  }, [newName, currentName, onClose, onRename]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !isRenaming) {
        e.preventDefault();
        void handleRename();
      }
    },
    [handleRename, isRenaming]
  );

  // Gate closing - prevent closing while rename is in progress
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isRenaming) {
        onClose();
      }
    },
    [isRenaming, onClose]
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange} disableOutsideClose={isRenaming}>
      <DialogContent size="sm">
        <DialogHeader icon={<PenLine size={20} />} onClose={isRenaming ? undefined : onClose}>
          <DialogTitle>Rename</DialogTitle>
        </DialogHeader>

        <DialogBody>
          <Input
            ref={inputRef}
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              setError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Enter file name"
            disabled={isRenaming}
          />
          {error && (
            <p style={{ color: 'var(--color-destructive)', fontSize: '0.875rem', marginTop: 8 }}>
              {error}
            </p>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={isRenaming}>
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={() => void handleRename()}
            disabled={isRenaming || !newName.trim() || newName.trim() === currentName}
          >
            {isRenaming ? 'Renaming...' : 'Rename'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
