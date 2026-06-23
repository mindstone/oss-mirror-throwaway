import type { FileNode } from '@shared/types';
import { Button } from '@renderer/components/ui';
import { buildTreeItemClassName } from '../utils/classNames';
import drawerStyles from './LibraryDrawer.module.css';

export type LibraryRecentDrawerProps = {
  open: boolean;
  files: FileNode[];
  editorPath: string | null;
  onSelectFile: (node: FileNode) => void;
  onClose: () => void;
  onClear: () => void;
};

export const LibraryRecentDrawer = ({ open, files, editorPath, onSelectFile, onClose, onClear }: LibraryRecentDrawerProps) => {
  if (files.length === 0) {
    return null;
  }

  return (
    <aside className={open ? `${drawerStyles.recentDrawer} ${drawerStyles.recentDrawerOpen}` : drawerStyles.recentDrawer} aria-hidden={!open}>
      <div className={drawerStyles.recentDrawerHeader}>
        <div className={drawerStyles.recentDrawerTitleBlock}>
          <span className={drawerStyles.recentDrawerTitle}>Recent files</span>
          <span className={drawerStyles.recentBadge}>{files.length}</span>
        </div>
        <div className={drawerStyles.recentDrawerActions}>
          <Button variant="ghost" onClick={onClear} title="Clear recent files">
            Clear
          </Button>
          <Button variant="ghost" onClick={onClose} aria-label="Close recent files drawer">
            Close
          </Button>
        </div>
      </div>
      <ul className={drawerStyles.recentDrawerList}>
        {files.map((node) => {
          const isActive = editorPath === node.path;
          return (
            <li key={node.path}>
              <button
                type="button"
                className={buildTreeItemClassName({ kind: 'file', isActive })}
                onClick={() => {
                  onSelectFile(node);
                  onClose();
                }}
              >
                <span className={drawerStyles.treeItemIcon}>📄</span>
                <span className={drawerStyles.treeItemName}>{node.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
};
