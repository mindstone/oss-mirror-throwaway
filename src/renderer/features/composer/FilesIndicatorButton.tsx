import { memo, useCallback, useMemo, useState } from 'react';
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
  FilePen,
  FileText,
  Brain,
  Wand2,
  ScrollText,
  type LucideIcon,
} from 'lucide-react';
import { basename, relative, isAbsolute } from 'pathe';
import { cn } from '@renderer/lib/utils';
import { IconButton, Tooltip } from '@renderer/components/ui';
import type { ConversationFileEntry, ConversationFileSummary } from '@renderer/features/agent-session/hooks/useConversationFiles';
import styles from './FilesIndicatorButton.module.css';

export type FilesIndicatorButtonProps = {
  files: ConversationFileSummary;
  coreDirectory?: string;
  onOpenFile?: (path: string) => void;
};

const CATEGORY_ICON: Record<ConversationFileEntry['category'], LucideIcon> = {
  workspace: FileText,
  memory: Brain,
  skill: Wand2,
  instructions: ScrollText,
};

const CATEGORY_LABEL: Record<ConversationFileEntry['category'], string> = {
  workspace: 'Workspace',
  memory: 'Memory',
  skill: 'Skills',
  instructions: 'Instructions',
};

const CATEGORY_ORDER: ConversationFileEntry['category'][] = [
  'workspace',
  'memory',
  'skill',
  'instructions',
];

type OperationLabel = 'created' | 'updated' | 'deleted' | 'moved';

function toOperationLabel(operation: string): OperationLabel {
  switch (operation) {
    case 'create':
      return 'created';
    case 'delete':
      return 'deleted';
    case 'move':
      return 'moved';
    default:
      return 'updated';
  }
}

function toRelativePath(filePath: string, coreDirectory?: string): string {
  if (!coreDirectory || !isAbsolute(filePath)) return filePath;

  const rel = relative(coreDirectory, filePath);
  if (rel.startsWith('..')) {
    const parts = filePath.split(/[\\/]/);
    const meaningful = parts.filter(
      (p) => p && !['', 'Users', 'Library', 'Documents', 'home'].includes(p)
    );
    if (meaningful.length > 4) {
      return '.../' + meaningful.slice(-3).join('/');
    }
    return meaningful.join('/');
  }
  return rel || filePath;
}

type GroupedFiles = {
  category: ConversationFileEntry['category'];
  entries: ConversationFileEntry[];
};

function groupByCategory(files: ConversationFileEntry[]): GroupedFiles[] {
  const map = new Map<ConversationFileEntry['category'], ConversationFileEntry[]>();
  for (const file of files) {
    const existing = map.get(file.category) ?? [];
    existing.push(file);
    map.set(file.category, existing);
  }
  return CATEGORY_ORDER
    .filter((cat) => map.has(cat))
    .map((cat) => {
      const entries = map.get(cat);
      return entries ? { category: cat, entries } : null;
    })
    .filter((group): group is GroupedFiles => group !== null);
}

const FilesIndicatorButtonComponent = ({
  files,
  coreDirectory,
  onOpenFile,
}: FilesIndicatorButtonProps) => {
  const [isOpen, setIsOpen] = useState(false);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'top-end',
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'dialog' });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  const grouped = useMemo(() => groupByCategory(files.files), [files.files]);
  const hasMultipleCategories = grouped.length > 1;

  const handleFileClick = useCallback(
    (path: string) => {
      onOpenFile?.(path);
      setIsOpen(false);
    },
    [onOpenFile]
  );

  const isEmpty = files.totalFileCount === 0 && !files.hasMemoryUpdates;

  const operationSummary = useMemo(() => {
    if (isEmpty) return { label: 'created', mixed: false };
    const ops = new Set(files.files.map((f) => toOperationLabel(f.operation)));
    if (ops.size === 1) {
      const only = [...ops][0];
      return { label: only, mixed: false };
    }
    return { label: 'modified', mixed: true };
  }, [files.files, isEmpty]);

  const triggerTooltip = isEmpty
    ? 'Files from this conversation'
    : `${files.totalFileCount} file${files.totalFileCount === 1 ? '' : 's'} ${operationSummary.label} in this conversation`;

  const headerTitle = isEmpty
    ? null
    : `${files.totalFileCount} file${files.totalFileCount === 1 ? '' : 's'} ${operationSummary.label}`;

  return (
    <>
      <Tooltip content={triggerTooltip} placement="top" delayShow={300}>
        <span className={styles.triggerWrapper}>
          <IconButton
            ref={refs.setReference}
            size="md"
            active={isOpen}
            className={cn(styles.trigger, isOpen && styles.triggerOpen)}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            aria-label={triggerTooltip}
            data-testid="files-indicator-button"
            {...getReferenceProps()}
          >
            <FilePen size={16} aria-hidden />
            {files.totalFileCount > 0 && (
              <span className={styles.badge} aria-label={`${files.totalFileCount} files`}>
                {files.totalFileCount}
              </span>
            )}
          </IconButton>
        </span>
      </Tooltip>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={styles.popover}
            data-positioned={isPositioned}
            aria-label="Conversation files"
            {...getFloatingProps()}
          >
            {isEmpty ? (
              <div className={styles.emptyState}>
                <FileText size={24} aria-hidden className={styles.emptyIcon} />
                <span className={styles.emptyTitle}>No files created yet</span>
                <span className={styles.emptySubtext}>
                  Files and memory updates from this conversation will appear here
                </span>
              </div>
            ) : (
              <>
                <div className={styles.header}>
                  <span className={styles.headerTitle}>{headerTitle}</span>
                  <span className={styles.headerSubtext}>
                    Files written or updated during this conversation
                  </span>
                </div>
                <div className={styles.fileList}>
                  {grouped.map((group) => {
                    const Icon = CATEGORY_ICON[group.category];
                    return (
                      <div key={group.category}>
                        {hasMultipleCategories && (
                          <div className={styles.categoryLabel}>
                            {CATEGORY_LABEL[group.category]}
                          </div>
                        )}
                        {group.entries.map((entry) => {
                          const opLabel = toOperationLabel(entry.operation);
                          const fullRelPath = toRelativePath(entry.path, coreDirectory);
                          return (
                            <Tooltip
                              key={entry.path}
                              content={fullRelPath}
                              placement="left"
                              delayShow={300}
                            >
                              <button
                                type="button"
                                className={styles.fileRow}
                                onClick={() => handleFileClick(entry.path)}
                                aria-label={`Open ${basename(entry.path)} (${opLabel})`}
                              >
                                <span className={styles.fileRowIconWrapper}>
                                  <Icon
                                    size={14}
                                    aria-hidden
                                    className={styles.fileRowIcon}
                                  />
                                </span>
                                <span className={styles.fileRowText}>
                                  <span className={styles.fileName}>
                                    {basename(entry.path)}
                                  </span>
                                  <span className={styles.filePath}>
                                    {fullRelPath}
                                  </span>
                                </span>
                                <span
                                  className={styles.operationBadge}
                                  data-op={opLabel}
                                >
                                  {opLabel}
                                </span>
                              </button>
                            </Tooltip>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

export const FilesIndicatorButton = memo(FilesIndicatorButtonComponent);
FilesIndicatorButton.displayName = 'FilesIndicatorButton';
