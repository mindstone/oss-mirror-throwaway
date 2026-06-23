import { useState, useCallback, type FC, type MouseEvent as ReactMouseEvent } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import {
  Archive,
  CodeXml,
  Copy,
  CopyPlus,
  DatabaseBackup,
  Download,
  FileText,
  FolderOpen,
  HardDriveUpload,
  History,
  MessageSquare,
  MoreHorizontal,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import styles from './PluginActionsMenu.module.css';

export type PluginAction =
  | 'askRebel'
  | 'duplicate'
  | 'viewSource'
  | 'scan'
  | 'docs'
  | 'exportData'
  | 'importData'
  | 'restoreData'
  | 'export'
  | 'exportToSpace'
  | 'openFolder'
  | 'copyId'
  | 'archive'
  | 'delete'
  | 'disable';

interface ActionDef {
  id: PluginAction;
  label: string;
  icon: FC<{ size?: number; strokeWidth?: number; className?: string }>;
  dividerBefore?: boolean;
  isDanger?: boolean;
}

interface PluginActionsMenuProps {
  pluginName: string;
  hasDocumentation?: boolean;
  isDocsOpen?: boolean;
  isSpacePlugin?: boolean;
  isCatalogPlugin?: boolean;
  spacePath?: string;
  hasDataBackup?: boolean;
  onAction: (action: PluginAction) => void;
}

function buildActions(props: Pick<PluginActionsMenuProps, 'hasDocumentation' | 'isDocsOpen' | 'isSpacePlugin' | 'isCatalogPlugin' | 'spacePath' | 'hasDataBackup'>): ActionDef[] {
  const { hasDocumentation, isDocsOpen, isSpacePlugin, isCatalogPlugin, spacePath, hasDataBackup } = props;
  const canArchive = !isCatalogPlugin && !isSpacePlugin;

  const actions: ActionDef[] = [
    { id: 'askRebel', label: 'Ask Rebel', icon: MessageSquare },
    { id: 'duplicate', label: 'Duplicate', icon: CopyPlus },
    { id: 'viewSource', label: 'View Source', icon: CodeXml },
    { id: 'scan', label: 'Security Scan', icon: ShieldCheck },
  ];

  if (hasDocumentation) {
    actions.push({ id: 'docs', label: isDocsOpen ? 'Hide Docs' : 'Show Docs', icon: FileText });
  }

  actions.push(
    { id: 'exportData', label: 'Export Data', icon: DatabaseBackup, dividerBefore: true },
    { id: 'importData', label: 'Import Data', icon: HardDriveUpload },
  );

  if (hasDataBackup) {
    actions.push({ id: 'restoreData', label: 'Restore Previous Data', icon: History });
  }

  actions.push(
    { id: 'export', label: 'Export as File', icon: Download, dividerBefore: true },
  );

  if (!isSpacePlugin) {
    actions.push({ id: 'exportToSpace', label: 'Export to Space', icon: Upload });
  }

  if (isSpacePlugin && spacePath) {
    actions.push({ id: 'openFolder', label: 'Open Folder', icon: FolderOpen });
  }

  actions.push({
    id: 'copyId',
    label: spacePath ? 'Copy Path' : 'Copy ID',
    icon: Copy,
  });

  if (canArchive) {
    actions.push({ id: 'archive', label: 'Archive', icon: Archive, dividerBefore: true, isDanger: true });
  } else {
    actions.push({ id: 'disable', label: 'Disable', icon: Archive, dividerBefore: true, isDanger: true });
  }

  if (!isCatalogPlugin) {
    actions.push({ id: 'delete', label: 'Delete', icon: Trash2, isDanger: true });
  }

  return actions;
}

export const PluginActionsMenu: FC<PluginActionsMenuProps> = ({
  pluginName,
  hasDocumentation,
  isDocsOpen,
  isSpacePlugin,
  isCatalogPlugin,
  spacePath,
  hasDataBackup,
  onAction,
}) => {
  const [isOpen, setIsOpen] = useState(false);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-end',
    strategy: 'fixed',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context, { ancestorScroll: true });
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  const actions = buildActions({ hasDocumentation, isDocsOpen, isSpacePlugin, isCatalogPlugin, spacePath, hasDataBackup });

  const handleAction = useCallback(
    (actionId: PluginAction, event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onAction(actionId);
      setIsOpen(false);
    },
    [onAction],
  );

  return (
    <>
      <Tooltip content="More actions" disabled={isOpen}>
        <button
          ref={refs.setReference}
          type="button"
          className={`${styles.menuTrigger} ${isOpen ? styles.menuTriggerOpen : ''}`.trim()}
          aria-label={`More actions for ${pluginName}`}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          {...getReferenceProps({ onClick: (e) => e.stopPropagation() })}
        >
          <MoreHorizontal size={16} strokeWidth={2} />
        </button>
      </Tooltip>
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={styles.menu}
            role="menu"
            data-positioned={isPositioned}
            onClick={(e) => e.stopPropagation()}
            {...getFloatingProps()}
          >
            {actions.map((action, index) => (
              <div key={action.id}>
                {action.dividerBefore && index > 0 && <div className={styles.menuDivider} />}
                <button
                  type="button"
                  className={`${styles.menuItem} ${action.isDanger ? styles.menuItemDanger : ''}`.trim()}
                  role="menuitem"
                  onClick={(e) => handleAction(action.id, e)}
                >
                  <action.icon size={14} strokeWidth={2} className={styles.menuItemIcon} />
                  <span>{action.label}</span>
                </button>
              </div>
            ))}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};
