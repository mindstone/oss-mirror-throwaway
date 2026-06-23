/**
 * RenameSpaceDialog Component
 *
 * Dialog for renaming a space folder or symlink.
 * Shows warning for symlinked spaces pointing to shared folders.
 */

import { useState, useCallback, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@renderer/components/ui/Dialog';
import { Button, Input, Notice } from '@renderer/components/ui';
import { AlertTriangle } from 'lucide-react';
import { basename } from 'pathe';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import styles from './SettingsSurface.module.css';

interface RenameSpaceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  space: SpaceInfo | null;
  onRename: (spacePath: string, newName: string) => Promise<void>;
}

export function RenameSpaceDialog({
  isOpen,
  onClose,
  space,
  onRename,
}: RenameSpaceDialogProps) {
  const currentName = space ? basename(space.path) : '';
  const [newName, setNewName] = useState(currentName);
  const [isRenaming, setIsRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check if this is a symlink to a shared folder (cloud storage)
  const isSharedSymlink = space?.isSymlink && space?.sourcePath && (
    space.sourcePath.includes('Google Drive') ||
    space.sourcePath.includes('OneDrive') ||
    space.sourcePath.includes('Dropbox') ||
    space.sourcePath.includes('iCloud')
  );

  // Reset state when dialog opens or space changes
  useEffect(() => {
    if (isOpen && space) {
      setNewName(basename(space.path));
      setError(null);
      setIsRenaming(false);
    }
  }, [isOpen, space]);

  const handleRename = useCallback(async () => {
    if (!space || !newName.trim()) {
      setError('Pick a name for the folder.');
      return;
    }

    if (newName === currentName) {
      onClose();
      return;
    }

    setIsRenaming(true);
    setError(null);

    try {
      await onRename(space.path, newName.trim());
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      setIsRenaming(false);
    }
  }, [space, newName, currentName, onRename, onClose]);

  if (!space) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose} disableOutsideClose={isRenaming}>
      <DialogContent size="md">
        <DialogHeader
          icon={isSharedSymlink ? <AlertTriangle size={24} /> : undefined}
          onClose={isRenaming ? undefined : onClose}
        >
          <DialogTitle>Rename Space</DialogTitle>
          <DialogDescription>
            Rename "{space.displayName || space.name}"
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {isSharedSymlink && (
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <Notice tone="warning" placement="inline" density="compact" title="This space links to a shared folder">
                Renaming will only change the local folder name. The shared folder name will
                remain unchanged, and other team members will still see the original name.
                For consistency, we recommend keeping the symlink name the same as the shared folder.
              </Notice>
            </div>
          )}

          <div className={styles.group}>
            <label htmlFor="new-space-name">New folder name</label>
            <Input
              id="new-space-name"
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setError(null);
              }}
              placeholder="Enter new folder name"
              disabled={isRenaming}
              autoFocus
            />
          </div>

          {error && (
            <div className={styles.errorText} style={{ marginTop: 8 }}>
              {error}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={isRenaming}>
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={() => void handleRename()}
            disabled={isRenaming || !newName.trim() || newName === currentName}
          >
            {isRenaming ? 'Renaming...' : isSharedSymlink ? 'Rename Anyway' : 'Rename'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
