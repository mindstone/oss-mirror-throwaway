import { useState, useCallback, useRef, useEffect, useMemo, type KeyboardEvent, type FC } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import { Folder, FolderPlus, FolderMinus } from 'lucide-react';
import type { ConversationFolder } from '@shared/ipc/schemas/folders';
import { useToast } from '@renderer/components/ui';
import {
  isDuplicateFolderName,
  MAX_FOLDER_NAME_LENGTH,
  SOFT_FOLDER_COUNT_WARNING_THRESHOLD,
} from '../utils/folderNameValidation';
import menuStyles from './SessionActionsMenu.module.css';

interface MoveToFolderPopoverProps {
  /** All available folders */
  folders: ConversationFolder[];
  /** The folder the session is currently in (null if unfiled) */
  currentFolderId: string | null;
  /** Anchor: virtual element positioning (cursor coordinates) */
  anchor: { x: number; y: number };
  onMoveToFolder: (folderId: string) => void;
  onRemoveFromFolder: () => void;
  onCreateFolder: (name: string) => string;
  onClose: () => void;
}

export const MoveToFolderPopover: FC<MoveToFolderPopoverProps> = ({
  folders,
  currentFolderId,
  anchor,
  onMoveToFolder,
  onRemoveFromFolder,
  onCreateFolder,
  onClose,
}) => {
  const { showToast } = useToast();
  const [isCreating, setIsCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const createInputRef = useRef<HTMLInputElement>(null);
  const createNameDuplicate = isCreating && isDuplicateFolderName(newFolderName, folders);

  const virtualElement = useMemo(() => ({
    getBoundingClientRect: () => ({
      width: 0,
      height: 0,
      x: anchor.x,
      y: anchor.y,
      top: anchor.y,
      left: anchor.x,
      right: anchor.x,
      bottom: anchor.y,
    }),
  }), [anchor.x, anchor.y]);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
    placement: 'right-start',
    strategy: 'fixed',
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    refs.setPositionReference(virtualElement);
  }, [refs, virtualElement]);

  const dismiss = useDismiss(context, { ancestorScroll: true });
  const role = useRole(context, { role: 'menu' });

  const { getFloatingProps } = useInteractions([dismiss, role]);

  useEffect(() => {
    if (isCreating) {
      requestAnimationFrame(() => createInputRef.current?.focus());
    }
  }, [isCreating]);

  const handleCreateCommit = useCallback(() => {
    const trimmed = newFolderName.trim().slice(0, MAX_FOLDER_NAME_LENGTH);
    if (trimmed) {
      if (folders.length >= SOFT_FOLDER_COUNT_WARNING_THRESHOLD) {
        showToast({
          title:
            'You have a lot of folders. Consider organizing conversations into broader categories.',
          variant: 'warning',
        });
      }
      const newId = onCreateFolder(trimmed);
      onMoveToFolder(newId);
    }
    onClose();
  }, [newFolderName, onCreateFolder, onMoveToFolder, onClose, folders.length, showToast]);

  const handleCreateKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCreateCommit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsCreating(false);
      setNewFolderName('');
    }
  }, [handleCreateCommit]);

  const handleFolderClick = useCallback((folderId: string) => {
    onMoveToFolder(folderId);
    onClose();
  }, [onMoveToFolder, onClose]);

  const handleRemove = useCallback(() => {
    onRemoveFromFolder();
    onClose();
  }, [onRemoveFromFolder, onClose]);

  const sortedFolders = [...folders].sort((a, b) => a.createdAt - b.createdAt);

  // Total interactive items: folders + "New folder..." + maybe "Remove from folder"
  const itemCount = sortedFolders.length + 1 + (currentFolderId ? 1 : 0);

  const handleListKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((prev) => Math.min(prev + 1, itemCount - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && highlightIndex >= 0) {
      e.preventDefault();
      if (highlightIndex < sortedFolders.length) {
        handleFolderClick(sortedFolders[highlightIndex].id);
      } else if (highlightIndex === sortedFolders.length) {
        setIsCreating(true);
      } else if (currentFolderId && highlightIndex === sortedFolders.length + 1) {
        handleRemove();
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [highlightIndex, itemCount, sortedFolders, currentFolderId, handleFolderClick, handleRemove, onClose]);

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className={menuStyles.menu}
        role="menu"
        data-positioned={isPositioned}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleListKeyDown}
        {...getFloatingProps()}
      >
        {isCreating && (
          <div style={{ padding: '4px 6px' }}>
            <input
              ref={createInputRef}
              type="text"
              value={newFolderName}
              onChange={(e) =>
                setNewFolderName(e.target.value.slice(0, MAX_FOLDER_NAME_LENGTH))
              }
              onKeyDown={handleCreateKeyDown}
              onBlur={() => { setIsCreating(false); setNewFolderName(''); }}
              placeholder="Folder name…"
              maxLength={MAX_FOLDER_NAME_LENGTH}
              aria-invalid={createNameDuplicate || undefined}
              style={{
                width: '100%',
                fontSize: '0.82rem',
                padding: '6px 8px',
                border: '1px solid rgba(99, 102, 241, 0.4)',
                borderRadius: '4px',
                background: 'transparent',
                color: 'inherit',
                outline: 'none',
              }}
            />
            {createNameDuplicate && (
              <p
                role="status"
                style={{
                  margin: '6px 0 0',
                  fontSize: '0.68rem',
                  lineHeight: 1.25,
                  color: 'rgba(251, 191, 36, 0.9)',
                }}
              >
                A folder with this name already exists
              </p>
            )}
          </div>
        )}

        {sortedFolders.map((folder, idx) => (
          <button
            key={folder.id}
            type="button"
            className={menuStyles.menuItem}
            role="menuitem"
            data-highlighted={highlightIndex === idx || undefined}
            style={highlightIndex === idx ? { background: 'rgba(99, 102, 241, 0.12)' } : undefined}
            onClick={() => handleFolderClick(folder.id)}
          >
            <Folder size={14} strokeWidth={2} className={menuStyles.menuItemIcon} />
            <span style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {folder.name}
            </span>
            {folder.id === currentFolderId && (
              <span style={{
                marginLeft: 'auto',
                fontSize: '0.72rem',
                opacity: 0.5,
              }}>
                ✓
              </span>
            )}
          </button>
        ))}

        <div className={menuStyles.menuDivider} />

        <button
          type="button"
          className={menuStyles.menuItem}
          role="menuitem"
          data-highlighted={highlightIndex === sortedFolders.length || undefined}
          style={highlightIndex === sortedFolders.length ? { background: 'rgba(99, 102, 241, 0.12)' } : undefined}
          onClick={() => setIsCreating(true)}
        >
          <FolderPlus size={14} strokeWidth={2} className={menuStyles.menuItemIcon} />
          <span>New folder…</span>
        </button>

        {currentFolderId && (
          <>
            <div className={menuStyles.menuDivider} />
            <button
              type="button"
              className={menuStyles.menuItem}
              role="menuitem"
              data-highlighted={highlightIndex === sortedFolders.length + 1 || undefined}
              style={highlightIndex === sortedFolders.length + 1 ? { background: 'rgba(99, 102, 241, 0.12)' } : undefined}
              onClick={handleRemove}
            >
              <FolderMinus size={14} strokeWidth={2} className={menuStyles.menuItemIcon} />
              <span>Remove from folder</span>
            </button>
          </>
        )}
      </div>
    </FloatingPortal>
  );
};

MoveToFolderPopover.displayName = 'MoveToFolderPopover';
