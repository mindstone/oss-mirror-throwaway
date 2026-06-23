import type { FileNode } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import drawerStyles from '../components/LibraryDrawer.module.css';

export const buildTreeItemClassName = ({
  kind,
  isActive,
  isSelected
}: {
  kind: FileNode['kind'];
  isActive?: boolean;
  isSelected?: boolean;
}) =>
  cn(
    drawerStyles.treeItem,
    kind === 'file' && drawerStyles.treeItemFile,
    isActive && drawerStyles.treeItemActive,
    isSelected && drawerStyles.treeItemSelected
  );
