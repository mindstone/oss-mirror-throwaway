import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@renderer/lib/utils';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@renderer/components/ui';
import {
  Pencil,
  FilePlus,
  FolderPlus,
  PenLine,
  Copy,
  Link,
  FileSymlink,
  FolderOpen,
  Globe,
  Trash2,
  Star,
} from 'lucide-react';
import drawerStyles from './LibraryDrawer.module.css';
import { useLibraryNavigator } from '../providers/LibraryNavigatorProvider';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

export const LibraryDialogs = () => {
  const { contextMenuState, createDialogState, isFileFavorite } = useLibraryNavigator();
  const {
    contextMenu,
    closeContextMenu,
    editInContext,
    createFileInContext,
    createFolderInContext,
    startRenaming,
    copyPath,
    copyRelativePath,
    copyAsMarkdownLink,
    revealInFinder,
    deleteItem,
    toggleFavorite,
    sharePublicly,
  } = contextMenuState;
  const { createDialog, createDialogValue, setCreateDialogValue, confirmCreate, closeCreateDialog } = createDialogState;

  // Keep the context menu fully within the viewport and outside any clipped containers
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  // Reset initial position when a new context menu target is set
  useEffect(() => {
    if (contextMenu) {
      setMenuPos({ x: contextMenu.x, y: contextMenu.y });
    } else {
      setMenuPos(null);
    }
  }, [contextMenu]);

  // After render, measure and clamp to viewport so the menu never gets cut off
  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const padding = 8;
    let x = contextMenu.x;
    let y = contextMenu.y;
    if (x + rect.width + padding > viewportW) {
      x = Math.max(padding, viewportW - rect.width - padding);
    }
    if (y + rect.height + padding > viewportH) {
      y = Math.max(padding, viewportH - rect.height - padding);
    }
    if (!menuPos || x !== menuPos.x || y !== menuPos.y) {
      setMenuPos({ x, y });
    }
  }, [contextMenu, menuPos]);

  // Close menu on Escape for accessibility
  useEffect(() => {
    if (!contextMenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeContextMenu();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [contextMenu, closeContextMenu]);

  return (
    <>
      {contextMenu &&
        createPortal(
          <div
            ref={menuRef}
            className={drawerStyles.contextMenu}
            style={{ top: menuPos?.y ?? contextMenu.y, left: menuPos?.x ?? contextMenu.x }}
            onClick={(e) => e.stopPropagation()}
            role="menu"
            data-testid="library-context-menu"
          >
            {/* Edit option - files only */}
            {contextMenu.target.kind === 'file' && (
              <button type="button" className={drawerStyles.contextMenuItem} onClick={editInContext}>
                <Pencil size={14} className={drawerStyles.contextMenuIcon} />
                <span className={drawerStyles.contextMenuLabel}>Edit</span>
              </button>
            )}
            {/* Favourite/Unfavourite option - available for both files and folders */}
            <button type="button" className={drawerStyles.contextMenuItem} onClick={toggleFavorite}>
              <Star 
                size={14} 
                className={drawerStyles.contextMenuIcon}
                fill={isFileFavorite(contextMenu.target.path) ? 'currentColor' : 'none'}
              />
              <span className={drawerStyles.contextMenuLabel}>
                {isFileFavorite(contextMenu.target.path) ? 'Unfavourite' : 'Favourite'}
              </span>
            </button>
            <div className={drawerStyles.contextMenuDivider} />
            <button type="button" className={drawerStyles.contextMenuItem} onClick={createFileInContext}>
              <FilePlus size={14} className={drawerStyles.contextMenuIcon} />
              <span className={drawerStyles.contextMenuLabel}>
                New File{contextMenu.target.kind === 'directory' ? ' here' : ''}
              </span>
            </button>
            <button type="button" className={drawerStyles.contextMenuItem} onClick={createFolderInContext}>
              <FolderPlus size={14} className={drawerStyles.contextMenuIcon} />
              <span className={drawerStyles.contextMenuLabel}>
                New Folder{contextMenu.target.kind === 'directory' ? ' here' : ''}
              </span>
            </button>
            <div className={drawerStyles.contextMenuDivider} />
            <button type="button" className={drawerStyles.contextMenuItem} onClick={startRenaming}>
              <PenLine size={14} className={drawerStyles.contextMenuIcon} />
              <span className={drawerStyles.contextMenuLabel}>Rename</span>
              <kbd className={drawerStyles.contextMenuKbd}>F2</kbd>
            </button>
            <div className={drawerStyles.contextMenuDivider} />
            <button type="button" className={drawerStyles.contextMenuItem} onClick={copyPath}>
              <Copy size={14} className={drawerStyles.contextMenuIcon} />
              <span className={drawerStyles.contextMenuLabel}>Copy path</span>
            </button>
            <button type="button" className={drawerStyles.contextMenuItem} onClick={copyRelativePath}>
              <Link size={14} className={drawerStyles.contextMenuIcon} />
              <span className={drawerStyles.contextMenuLabel}>Copy relative path</span>
            </button>
            <button type="button" className={drawerStyles.contextMenuItem} onClick={copyAsMarkdownLink}>
              <FileSymlink size={14} className={drawerStyles.contextMenuIcon} />
              <span className={drawerStyles.contextMenuLabel}>Copy as Markdown link</span>
            </button>
            {sharePublicly && (
              <>
                <div className={drawerStyles.contextMenuDivider} />
                <button type="button" className={drawerStyles.contextMenuItem} onClick={sharePublicly}>
                  <Globe size={14} className={drawerStyles.contextMenuIcon} />
                  <span className={drawerStyles.contextMenuLabel}>Share publicly…</span>
                </button>
              </>
            )}
            <div className={drawerStyles.contextMenuDivider} />
            <button type="button" className={drawerStyles.contextMenuItem} onClick={revealInFinder}>
              <FolderOpen size={14} className={drawerStyles.contextMenuIcon} />
              <span className={drawerStyles.contextMenuLabel}>
                Reveal in {isMac ? 'Finder' : 'Explorer'}
              </span>
            </button>
            <div className={drawerStyles.contextMenuDivider} />
            <button
              type="button"
              className={cn(drawerStyles.contextMenuItem, drawerStyles.contextMenuItemDanger)}
              onClick={deleteItem}
            >
              <Trash2 size={14} className={drawerStyles.contextMenuIcon} />
              <span className={drawerStyles.contextMenuLabel}>Delete</span>
              <kbd className={drawerStyles.contextMenuKbd}>{isMac ? '⌘' : 'Ctrl'}+⌫</kbd>
            </button>
          </div>,
          document.body
        )}
      {createDialog && (
        <Dialog open={!!createDialog} onOpenChange={(open) => !open && closeCreateDialog()}>
          <DialogContent size="sm">
            <DialogHeader icon={createDialog.type === 'file' ? <FilePlus size={20} /> : <FolderPlus size={20} />}>
              <DialogTitle>Create New {createDialog.type === 'file' ? 'File' : 'Folder'}</DialogTitle>
              <DialogDescription className={drawerStyles.createDialogHint}>
                {createDialog.parentNode ? `Creating in: ${createDialog.parentNode.name}` : 'Creating in Library root'}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <Input
                className={drawerStyles.createDialogInput}
                placeholder={`Enter ${createDialog.type} name...`}
                value={createDialogValue}
                onChange={(e) => setCreateDialogValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && createDialogValue.trim()) {
                    void confirmCreate();
                  }
                }}
                autoFocus
              />
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={closeCreateDialog}>
                Cancel
              </Button>
              <Button onClick={() => void confirmCreate()} disabled={!createDialogValue.trim()}>
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
};
