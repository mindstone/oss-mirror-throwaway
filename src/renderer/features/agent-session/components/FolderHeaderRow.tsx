import { memo, useState, useCallback, useRef, useEffect, forwardRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Folder, FolderOpen, MoreHorizontal, Pencil, Trash2, CheckCircle2, RotateCcw } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import type { ConversationFolder } from '@shared/ipc/schemas/folders';
import { isDuplicateFolderName, MAX_FOLDER_NAME_LENGTH } from '../utils/folderNameValidation';
import styles from './FolderHeaderRow.module.css';
import menuStyles from './SessionActionsMenu.module.css';

interface FolderHeaderRowProps {
  folder: ConversationFolder;
  /** All folders (for duplicate-name warning while renaming) */
  allFolders: ConversationFolder[];
  childCount: number;
  isCollapsed: boolean;
  isDone: boolean;
  onToggleCollapse: (folderId: string) => void;
  onToggleDone: (folderId: string) => void;
  onRename: (folderId: string, newName: string) => void;
  onDelete: (folderId: string) => void;
  /** When true, the row shows an inline input for rename */
  isEditing?: boolean;
  onStartEdit?: () => void;
  onCancelEdit?: () => void;
  /** Called when a dragged session is dropped onto this folder */
  onSessionDrop?: (sessionId: string) => void;
}

const DRAG_DATA_FORMAT = 'text/x-rebel-session-id';
const AUTO_EXPAND_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// Inline folder context menu (minimal, uses existing SessionActionsMenu styles)
// ---------------------------------------------------------------------------

const FolderContextMenu = forwardRef<
  HTMLDivElement,
  {
    isDone: boolean;
    hasChildren: boolean;
    onToggleDone: (e: React.MouseEvent) => void;
    onRename: (e: React.MouseEvent) => void;
    onDelete: (e: React.MouseEvent) => void;
    anchorRef: React.RefObject<HTMLButtonElement | null>;
  }
>(({ isDone, hasChildren, onToggleDone, onRename, onDelete, anchorRef }, ref) => {
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 2, left: rect.right - 160 });
    }
  }, [anchorRef]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        zIndex: 99999,
        minWidth: 160,
        padding: 4,
        borderRadius: 10,
        background: '#1e2338',
        border: '1px solid rgba(148, 163, 184, 0.25)',
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(99, 102, 241, 0.1)',
      }}
    >
      <button
        type="button"
        className={menuStyles.menuItem}
        role="menuitem"
        onClick={onRename}
      >
        <Pencil size={14} strokeWidth={2} className={menuStyles.menuItemIcon} />
        <span>Rename folder</span>
      </button>
      {hasChildren && (
        <button
          type="button"
          className={menuStyles.menuItem}
          role="menuitem"
          onClick={onToggleDone}
        >
          {isDone ? (
            <RotateCcw size={14} strokeWidth={2} className={menuStyles.menuItemIcon} />
          ) : (
            <CheckCircle2 size={14} strokeWidth={2} className={menuStyles.menuItemIcon} />
          )}
          <span>{isDone ? 'Reopen folder' : 'Mark folder as done'}</span>
        </button>
      )}
      <div className={menuStyles.menuDivider} />
      <button
        type="button"
        className={`${menuStyles.menuItem} ${menuStyles.menuItemDanger}`}
        role="menuitem"
        onClick={onDelete}
      >
        <Trash2 size={14} strokeWidth={2} className={menuStyles.menuItemIcon} />
        <span>Delete folder</span>
      </button>
    </div>,
    document.body,
  );
});

FolderContextMenu.displayName = 'FolderContextMenu';

export const FolderHeaderRow = memo(({
  folder,
  allFolders,
  childCount,
  isCollapsed,
  isDone,
  onToggleCollapse,
  onToggleDone,
  onRename,
  onDelete,
  isEditing = false,
  onStartEdit,
  onCancelEdit,
  onSessionDrop,
}: FolderHeaderRowProps) => {
  const [editValue, setEditValue] = useState(folder.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const dragCounterRef = useRef(0);
  const dragExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isEditing) {
      setEditValue(folder.name);
      requestAnimationFrame(() => {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      });
    }
  }, [isEditing, folder.name]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          menuBtnRef.current && !menuBtnRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== folder.name) {
      onRename(folder.id, trimmed);
    }
    onCancelEdit?.();
  }, [editValue, folder.id, folder.name, onRename, onCancelEdit]);

  const handleEditKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancelEdit?.();
    }
  }, [commitRename, onCancelEdit]);

  const handleClick = useCallback(() => {
    if (!isEditing) {
      onToggleCollapse(folder.id);
    }
  }, [isEditing, onToggleCollapse, folder.id]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    // Only handle keyboard activation when the event originated on the wrapper
    // itself. Events bubbled from descendant focusables (e.g., the rename input)
    // must not be interpreted as wrapper hotkeys — otherwise preventDefault()
    // here would swallow characters typed into the input (notably Space).
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    } else if (e.key === 'ArrowRight' && isCollapsed) {
      e.preventDefault();
      onToggleCollapse(folder.id);
    } else if (e.key === 'ArrowLeft' && !isCollapsed) {
      e.preventDefault();
      onToggleCollapse(folder.id);
    }
  }, [isCollapsed, onToggleCollapse, folder.id, handleClick]);

  const handleMoreClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen((prev) => !prev);
  }, []);

  const handleMenuRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    onStartEdit?.();
  }, [onStartEdit]);

  const handleMenuDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    onDelete(folder.id);
  }, [onDelete, folder.id]);

  const handleDoneClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onToggleDone(folder.id);
  }, [folder.id, onToggleDone]);

  const handleMenuToggleDone = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    onToggleDone(folder.id);
  }, [folder.id, onToggleDone]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(true);
  }, []);

  // ── Drag-and-drop target ──────────────────────────────────────────────────
  const clearDragExpandTimer = useCallback(() => {
    if (dragExpandTimerRef.current) {
      clearTimeout(dragExpandTimerRef.current);
      dragExpandTimerRef.current = null;
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_DATA_FORMAT)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_DATA_FORMAT)) return;
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) {
      setIsDragOver(true);
      if (isCollapsed) {
        dragExpandTimerRef.current = setTimeout(() => {
          onToggleCollapse(folder.id);
        }, AUTO_EXPAND_DELAY_MS);
      }
    }
  }, [isCollapsed, onToggleCollapse, folder.id]);

  const handleDragLeave = useCallback(() => {
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
      clearDragExpandTimer();
    }
  }, [clearDragExpandTimer]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    clearDragExpandTimer();
    const sessionId = e.dataTransfer.getData(DRAG_DATA_FORMAT);
    if (sessionId) onSessionDrop?.(sessionId);
  }, [onSessionDrop, clearDragExpandTimer]);

  useEffect(() => clearDragExpandTimer, [clearDragExpandTimer]);

  const FolderIcon = isCollapsed ? Folder : FolderOpen;
  const renameDuplicateWarning =
    isEditing && isDuplicateFolderName(editValue, allFolders, folder.id);
  const actionLabel = isDone ? 'Reopen folder' : 'Mark folder as done';

  return (
    <div className={styles.folderRow}>
      <div
        role="button"
        tabIndex={0}
        className={`${styles.folderHeader}${isDragOver ? ` ${styles.folderHeaderDropTarget}` : ''}`}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        aria-expanded={!isCollapsed}
        aria-label={`${folder.name} folder, ${childCount} conversations`}
      >
        <ChevronRight
          className={`${styles.chevron}${!isCollapsed ? ` ${styles.chevronExpanded}` : ''}`}
          aria-hidden
        />
        <FolderIcon className={styles.folderIcon} aria-hidden />
        {isEditing ? (
          <input
            ref={editInputRef}
            type="text"
            className={styles.folderNameInput}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value.slice(0, MAX_FOLDER_NAME_LENGTH))}
            onKeyDown={handleEditKeyDown}
            onBlur={commitRename}
            onClick={(e) => e.stopPropagation()}
            maxLength={MAX_FOLDER_NAME_LENGTH}
            aria-label="Folder name"
            aria-invalid={renameDuplicateWarning || undefined}
          />
        ) : (
          <span className={styles.folderName}>{folder.name}</span>
        )}
      </div>
      <span className={`${styles.childCountOverlay}${menuOpen ? ` ${styles.childCountOverlayHidden}` : ''}`}>
        {childCount}
      </span>
      <div className={`${styles.folderActions}${menuOpen ? ` ${styles.folderActionsVisible}` : ''}`}>
        {childCount > 0 && (
          <Tooltip content={actionLabel}>
            <button
              type="button"
              className={styles.doneButton}
              onClick={handleDoneClick}
              aria-label={`${isDone ? 'Reopen' : 'Mark'} folder ${folder.name} as ${isDone ? 'active' : 'done'}`}
            >
              {isDone ? <RotateCcw size={14} /> : <CheckCircle2 size={14} />}
            </button>
          </Tooltip>
        )}
        <button
          ref={menuBtnRef}
          type="button"
          className={styles.moreButton}
          onClick={handleMoreClick}
          aria-label={`More actions for ${folder.name}`}
          aria-haspopup="menu"
        >
          <MoreHorizontal size={14} />
        </button>
      </div>

      {menuOpen && (
        <FolderContextMenu
          ref={menuRef}
          anchorRef={menuBtnRef}
          isDone={isDone}
          hasChildren={childCount > 0}
          onToggleDone={handleMenuToggleDone}
          onRename={handleMenuRename}
          onDelete={handleMenuDelete}
        />
      )}

      {renameDuplicateWarning && (
        <p className={styles.folderNameDuplicateWarning} role="status">
          A folder with this name already exists
        </p>
      )}
    </div>
  );
});

FolderHeaderRow.displayName = 'FolderHeaderRow';
