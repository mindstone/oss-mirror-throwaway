import { memo, useState, useCallback, useMemo } from 'react';
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
import { SlidersHorizontal, Check, Inbox, CheckCircle2, Trash2, AlertTriangle, ArrowUpCircle, Circle, ArrowDownCircle } from 'lucide-react';
import type { PriorityLevel } from '@rebel/shared';
import { IconButton, Tooltip } from '@renderer/components/ui';
import styles from './InboxFilterDropdown.module.css';

export type ViewMode = 'active' | 'done' | 'dismissed' | 'archived';

type InboxFilterDropdownProps = {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  activeCount: number;
  doneCount: number;
  dismissedCount: number;
  archivedCount: number;
  priorityFilter: Set<PriorityLevel>;
  onTogglePriority: (level: PriorityLevel) => void;
  globalAutoDone: boolean;
  onToggleGlobalAutoDone: () => void;
};

const VIEW_OPTIONS: { value: ViewMode; label: string; icon: typeof Inbox }[] = [
  { value: 'active', label: 'Active', icon: Inbox },
  { value: 'done', label: 'Done', icon: CheckCircle2 },
  { value: 'dismissed', label: 'Deleted', icon: Trash2 },
];

const PRIORITY_OPTIONS: { value: PriorityLevel; label: string; icon: typeof ArrowUpCircle }[] = [
  { value: 'urgent', label: 'Urgent', icon: AlertTriangle },
  { value: 'high', label: 'High', icon: ArrowUpCircle },
  { value: 'medium', label: 'Medium', icon: Circle },
  { value: 'low', label: 'Low', icon: ArrowDownCircle },
];

function getCount(mode: ViewMode, props: InboxFilterDropdownProps): number {
  switch (mode) {
    case 'active': return props.activeCount;
    case 'done': return props.doneCount;
    case 'dismissed': return props.dismissedCount;
    case 'archived': return props.archivedCount;
  }
}

export const InboxFilterDropdown = memo((props: InboxFilterDropdownProps) => {
  const { viewMode, onViewModeChange, priorityFilter, onTogglePriority, globalAutoDone, onToggleGlobalAutoDone } = props;
  const [isOpen, setIsOpen] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-end',
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  const handleSelectViewMode = useCallback((mode: ViewMode) => {
    onViewModeChange(mode);
    setIsOpen(false);
  }, [onViewModeChange]);

  const handleTogglePriority = useCallback((level: PriorityLevel) => {
    onTogglePriority(level);
  }, [onTogglePriority]);

  const hasActiveFilters = viewMode !== 'active' || priorityFilter.size > 0 || globalAutoDone;
  const currentViewLabel = VIEW_OPTIONS.find(o => o.value === viewMode)?.label ?? 'Active';
  const currentCount = getCount(viewMode, props);

  const tooltipContent = useMemo(() => {
    const parts = [`${currentViewLabel} (${currentCount})`];
    if (priorityFilter.size > 0) {
      const labels = Array.from(priorityFilter).map(l => l.charAt(0).toUpperCase() + l.slice(1));
      parts.push(`Priority: ${labels.join(', ')}`);
    }
    return parts.join(' · ');
  }, [currentViewLabel, currentCount, priorityFilter]);

  return (
    <>
      <Tooltip content={tooltipContent} disabled={isOpen}>
        <span className={styles.filterWrapper}>
          <IconButton
            ref={refs.setReference}
            size="xs"
            active={isOpen || hasActiveFilters}
            className={styles.filterButton}
            data-open={isOpen}
            data-has-filters={hasActiveFilters}
            aria-label={`Filter: ${tooltipContent}`}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            {...getReferenceProps()}
          >
            <SlidersHorizontal size={14} strokeWidth={2} className={styles.filterIcon} />
            {hasActiveFilters && (
              <span className={styles.activeIndicator} aria-hidden />
            )}
          </IconButton>
        </span>
      </Tooltip>
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={styles.menu}
            role="menu"
            {...getFloatingProps()}
          >
            {/* Status section */}
            <div className={styles.menuSection}>
              <div className={styles.menuHeader}>Status</div>
              {VIEW_OPTIONS.map(opt => {
                const Icon = opt.icon;
                const count = getCount(opt.value, props);
                const isSelected = viewMode === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`${styles.menuItem} ${isSelected ? styles.menuItemActive : ''}`.trim()}
                    role="menuitemradio"
                    aria-checked={isSelected}
                    onClick={() => handleSelectViewMode(opt.value)}
                  >
                    <span className={styles.menuItemIcon}>
                      <Icon size={15} strokeWidth={2} />
                    </span>
                    <span className={styles.menuItemContent}>
                      <span className={styles.menuItemLabel}>{opt.label}</span>
                    </span>
                    <span className={styles.menuItemCount}>{count}</span>
                    {isSelected && (
                      <span className={styles.menuItemCheck}>
                        <Check size={14} strokeWidth={2.5} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className={styles.menuDivider} />

            {/* Priority section */}
            <div className={styles.menuSection}>
              <div className={styles.menuHeader}>Priority</div>
              {PRIORITY_OPTIONS.map(opt => {
                const Icon = opt.icon;
                const isSelected = priorityFilter.has(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`${styles.menuItem} ${styles.menuItemCompact} ${isSelected ? styles.menuItemActive : ''}`.trim()}
                    role="menuitemcheckbox"
                    aria-checked={isSelected}
                    onClick={() => handleTogglePriority(opt.value)}
                  >
                    <span className={styles.menuItemIcon}>
                      <Icon size={15} strokeWidth={2} />
                    </span>
                    <span className={styles.menuItemContent}>
                      <span className={styles.menuItemLabel}>{opt.label}</span>
                    </span>
                    {isSelected && (
                      <span className={styles.menuItemCheck}>
                        <Check size={14} strokeWidth={2.5} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className={styles.menuDivider} />

            {/* Behavior section */}
            <div className={styles.menuSection}>
              <div className={styles.menuHeader}>Behavior</div>
              <button
                type="button"
                className={`${styles.menuItem} ${styles.menuItemCompact}`.trim()}
                role="switch"
                aria-checked={globalAutoDone}
                onClick={onToggleGlobalAutoDone}
              >
                <span className={styles.menuItemIcon}>
                  <CheckCircle2 size={15} strokeWidth={2} />
                </span>
                <span className={styles.menuItemContent}>
                  <span className={styles.menuItemLabel}>Auto-mark done</span>
                </span>
                <span className={`${styles.toggleSwitch} ${globalAutoDone ? styles.toggleSwitchOn : ''}`} aria-hidden />
              </button>
            </div>

          </div>
        </FloatingPortal>
      )}
    </>
  );
});
InboxFilterDropdown.displayName = 'InboxFilterDropdown';
