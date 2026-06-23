/**
 * RenameWorkspaceDialog Component
 *
 * Dialog for renaming the workspace (coreDirectory) folder.
 * App will restart after rename to apply changes.
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
import { Button, Input } from '@renderer/components/ui';
import { AlertTriangle } from 'lucide-react';
import { basename } from 'pathe';
import styles from './SettingsSurface.module.css';

interface RenameWorkspaceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  currentPath: string;
}

export function RenameWorkspaceDialog({
  isOpen,
  onClose,
  currentPath,
}: RenameWorkspaceDialogProps) {
  const currentName = basename(currentPath);
  const [newName, setNewName] = useState(currentName);
  const [isRenaming, setIsRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setNewName(currentName);
      setError(null);
      setIsRenaming(false);
    }
  }, [isOpen, currentName]);

  const handleRename = useCallback(async () => {
    if (!newName.trim()) {
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
      const result = await window.settingsApi.renameWorkspace({ newName: newName.trim() });
      if (!result.success) {
        setError("Couldn't rename that workspace.");
        setIsRenaming(false);
      }
      // If success, app will restart - no need to close dialog
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      setIsRenaming(false);
    }
  }, [newName, currentName, onClose]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose} disableOutsideClose={isRenaming}>
      <DialogContent size="md">
        <DialogHeader icon={<AlertTriangle size={24} />} onClose={isRenaming ? undefined : onClose}>
          <DialogTitle>Rename Workspace Folder</DialogTitle>
          <DialogDescription>
            Rename your workspace folder on disk
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className={styles.group}>
            <label htmlFor="new-workspace-name">New folder name</label>
            <Input
              id="new-workspace-name"
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

          <div style={{ marginTop: 16 }}>
            <p className={styles.groupDescription} style={{ fontWeight: 500, marginBottom: 8 }}>
              What will happen:
            </p>
            <ul className={styles.groupDescription} style={{ paddingLeft: 20, margin: 0 }}>
              <li>The folder will be renamed on disk</li>
              <li>The app will restart automatically</li>
              <li>Search index will rebuild (may take a few minutes)</li>
            </ul>
          </div>

          <div style={{ marginTop: 16 }}>
            <p className={styles.groupDescription} style={{ fontWeight: 500, marginBottom: 8 }}>
              If something goes wrong:
            </p>
            <ul className={styles.groupDescription} style={{ paddingLeft: 20, margin: 0 }}>
              <li>On next launch, you'll be prompted to locate your workspace folder</li>
              <li>Or you can manually rename the folder back</li>
            </ul>
          </div>
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
            {isRenaming ? 'Renaming...' : 'Rename & Restart'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
