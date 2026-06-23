import { useState, useCallback, useMemo, useRef, type FC } from 'react';
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
  FloatingPortal
} from '@floating-ui/react';
import { SlidersHorizontal, User, Sparkles, Check, Clock, Layers } from 'lucide-react';
import { IconButton, Tooltip } from '@renderer/components/ui';
import type { RecencyFilter } from '@renderer/utils/conversationSearch';
import { RECENCY_FILTER_LABELS } from '@renderer/utils/conversationSearch';
import type { SessionTypeFilter } from '@shared/types';
import { tracking } from '@renderer/src/tracking';
import styles from './HistoryFilterDropdown.module.css';

/** Labels for session type filter options */
const SESSION_TYPE_LABELS: Record<SessionTypeFilter, string> = {
  all: 'All',
  conversations: 'Conversations',
  automations: 'Automations',
};

type HistoryFilterDropdownProps = {
  /** Current session type filter */
  sessionTypeFilter: SessionTypeFilter;
  /** Callback when session type filter changes */
  onSessionTypeFilterChange: (filter: SessionTypeFilter) => void;
  recencyFilter: RecencyFilter;
  onRecencyFilterChange: (filter: RecencyFilter) => void;
  className?: string;
  isAutomationRunning?: boolean;
};

export const HistoryFilterDropdown: FC<HistoryFilterDropdownProps> = ({
  sessionTypeFilter,
  onSessionTypeFilterChange,
  recencyFilter,
  onRecencyFilterChange,
  className,
  isAutomationRunning = false
}) => {
  const [isOpen, setIsOpen] = useState(false);
  // Track previous filter for analytics
  const previousFilterRef = useRef<RecencyFilter>(recencyFilter);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-end',
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({ padding: 8 })
    ],
    whileElementsMounted: autoUpdate
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role
  ]);

  const handleSelectTypeFilter = useCallback((filter: SessionTypeFilter) => {
    onSessionTypeFilterChange(filter);
    setIsOpen(false);
  }, [onSessionTypeFilterChange]);

  const handleSelectRecency = useCallback((filter: RecencyFilter) => {
    // Track filter change with previous value
    if (filter !== previousFilterRef.current) {
      tracking.navigation.recencyFilterChanged(filter, previousFilterRef.current);
      previousFilterRef.current = filter;
    }
    onRecencyFilterChange(filter);
    setIsOpen(false);
  }, [onRecencyFilterChange]);

  const rootClassName = [styles.filterDropdown, className || ''].filter(Boolean).join(' ').trim();
  const currentTypeLabel = SESSION_TYPE_LABELS[sessionTypeFilter];
  const currentTimeLabel = RECENCY_FILTER_LABELS[recencyFilter];
  const hasActiveFilters = sessionTypeFilter !== 'all' || recencyFilter !== 'all';
  const tooltipContent = useMemo(() => `${currentTypeLabel} · ${currentTimeLabel}`, [currentTypeLabel, currentTimeLabel]);

  return (
    <>
      <Tooltip content={tooltipContent} disabled={isOpen}>
        <span className={styles.filterDropdownWrapper}>
          <IconButton
            ref={refs.setReference}
            size="xs"
            active={isOpen || hasActiveFilters}
            className={rootClassName}
            data-open={isOpen}
            data-has-filters={hasActiveFilters}
            aria-label={`Filter: ${currentTypeLabel}, ${currentTimeLabel}`}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            {...getReferenceProps()}
          >
            <SlidersHorizontal size={14} strokeWidth={2} className={styles.filterIcon} />
            {isAutomationRunning && (
              <span className={styles.runningIndicator} aria-label="Automation running" />
            )}
            {hasActiveFilters && !isAutomationRunning && (
              <span className={styles.activeFilterIndicator} aria-hidden />
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
            data-positioned={isPositioned}
            {...getFloatingProps()}
          >
            {/* Type section */}
            <div className={styles.menuSection}>
              <div className={styles.menuHeader}>Type</div>
              <button
                type="button"
                className={`${styles.menuItem} ${sessionTypeFilter === 'all' ? styles.menuItemActive : ''}`.trim()}
                role="menuitemradio"
                aria-checked={sessionTypeFilter === 'all'}
                onClick={() => handleSelectTypeFilter('all')}
              >
                <span className={styles.menuItemIcon}>
                  <Layers size={15} strokeWidth={2} />
                </span>
                <span className={styles.menuItemContent}>
                  <span className={styles.menuItemLabel}>All</span>
                </span>
                {sessionTypeFilter === 'all' && (
                  <span className={styles.menuItemCheck}>
                    <Check size={14} strokeWidth={2.5} />
                  </span>
                )}
              </button>
              <button
                type="button"
                className={`${styles.menuItem} ${sessionTypeFilter === 'conversations' ? styles.menuItemActive : ''}`.trim()}
                role="menuitemradio"
                aria-checked={sessionTypeFilter === 'conversations'}
                onClick={() => handleSelectTypeFilter('conversations')}
              >
                <span className={styles.menuItemIcon}>
                  <User size={15} strokeWidth={2} />
                </span>
                <span className={styles.menuItemContent}>
                  <span className={styles.menuItemLabel}>Conversations</span>
                </span>
                {sessionTypeFilter === 'conversations' && (
                  <span className={styles.menuItemCheck}>
                    <Check size={14} strokeWidth={2.5} />
                  </span>
                )}
              </button>
              <button
                type="button"
                className={`${styles.menuItem} ${sessionTypeFilter === 'automations' ? styles.menuItemActive : ''}`.trim()}
                role="menuitemradio"
                aria-checked={sessionTypeFilter === 'automations'}
                onClick={() => handleSelectTypeFilter('automations')}
              >
                <span className={styles.menuItemIcon}>
                  <Sparkles size={15} strokeWidth={2} />
                  {isAutomationRunning && (
                    <span className={styles.menuItemRunningDot} aria-hidden />
                  )}
                </span>
                <span className={styles.menuItemContent}>
                  <span className={styles.menuItemLabel}>
                    Automations
                    {isAutomationRunning && (
                      <span className={styles.runningBadge}>Running</span>
                    )}
                  </span>
                </span>
                {sessionTypeFilter === 'automations' && (
                  <span className={styles.menuItemCheck}>
                    <Check size={14} strokeWidth={2.5} />
                  </span>
                )}
              </button>
            </div>

            {/* Divider */}
            <div className={styles.menuDivider} />

            {/* Time section */}
            <div className={styles.menuSection}>
              <div className={styles.menuHeader}>
                <Clock size={12} className={styles.menuHeaderIcon} />
                Time
              </div>
              {(Object.keys(RECENCY_FILTER_LABELS) as RecencyFilter[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`${styles.menuItem} ${styles.menuItemCompact} ${recencyFilter === key ? styles.menuItemActive : ''}`.trim()}
                  role="menuitemradio"
                  aria-checked={recencyFilter === key}
                  onClick={() => handleSelectRecency(key)}
                >
                  <span className={styles.menuItemContent}>
                    <span className={styles.menuItemLabel}>{RECENCY_FILTER_LABELS[key]}</span>
                  </span>
                  {recencyFilter === key && (
                    <span className={styles.menuItemCheck}>
                      <Check size={14} strokeWidth={2.5} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

HistoryFilterDropdown.displayName = 'HistoryFilterDropdown';

