import { memo, useState, useRef, useEffect, useCallback } from 'react';
import { CheckCircle2, Trash2, ChevronDown, Calendar } from 'lucide-react';
import type { PriorityLevel } from '@rebel/shared';
import { getPriorityLabel } from '@rebel/shared';
import type { ConcreteTemporalGroup } from '@rebel/shared';
import { TEMPORAL_GROUP_META } from '@rebel/shared';
import { Tooltip } from '@renderer/components/ui';
import styles from './InboxSelectionBar.module.css';

export type InboxSelectionBarProps = {
  count: number;
  totalCount?: number;
  onBatchDone?: () => void;
  onBatchDismiss: () => void;
  onBatchSetPriority?: (level: PriorityLevel) => void;
  onBatchSetSchedule?: (group: ConcreteTemporalGroup) => void;
  onSelectAll?: () => void;
  onClearSelection: () => void;
};

const PRIORITY_LEVELS: PriorityLevel[] = ['urgent', 'high', 'medium', 'low'];
const SCHEDULE_GROUPS: ConcreteTemporalGroup[] = ['due-today', 'due-this-week', 'upcoming'];

const InboxSelectionBarComponent = ({
  count,
  totalCount,
  onBatchDone,
  onBatchDismiss,
  onBatchSetPriority,
  onBatchSetSchedule,
  onSelectAll,
  onClearSelection,
}: InboxSelectionBarProps) => {
  const [priorityMenuOpen, setPriorityMenuOpen] = useState(false);
  const [scheduleMenuOpen, setScheduleMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const scheduleMenuRef = useRef<HTMLDivElement>(null);

  const handlePrioritySelect = useCallback((level: PriorityLevel) => {
    onBatchSetPriority?.(level);
    setPriorityMenuOpen(false);
  }, [onBatchSetPriority]);

  const handleScheduleSelect = useCallback((group: ConcreteTemporalGroup) => {
    onBatchSetSchedule?.(group);
    setScheduleMenuOpen(false);
  }, [onBatchSetSchedule]);

  useEffect(() => {
    if (!priorityMenuOpen && !scheduleMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (priorityMenuOpen && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setPriorityMenuOpen(false);
      }
      if (scheduleMenuOpen && scheduleMenuRef.current && !scheduleMenuRef.current.contains(e.target as Node)) {
        setScheduleMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [priorityMenuOpen, scheduleMenuOpen]);

  if (count === 0) return null;

  return (
    <div className={styles.bar} role="toolbar" aria-label="Batch actions">
      <span className={styles.count}>
        {count} selected
        {onSelectAll && totalCount != null && count < totalCount && (
          <>
            {' · '}
            <button type="button" className={styles.selectAllLink} onClick={onSelectAll}>
              Select all {totalCount}
            </button>
          </>
        )}
      </span>
      <div className={styles.actions}>
        {onBatchDone && (
          <Tooltip content="Mark as completed and move to Done" delayShow={400}>
            <button
              type="button"
              className={styles.actionButton}
              onClick={onBatchDone}
            >
              <CheckCircle2 size={13} />
              Mark done
            </button>
          </Tooltip>
        )}
        <Tooltip content="Remove this item — tap Undo to restore" delayShow={400}>
          <button
            type="button"
            className={`${styles.actionButton} ${styles.actionButtonDanger}`}
            onClick={onBatchDismiss}
          >
            <Trash2 size={13} />
            Delete
          </button>
        </Tooltip>
        {onBatchSetPriority && (
          <div className={styles.priorityDropdown} ref={menuRef}>
            <button
              type="button"
              className={styles.actionButton}
              onClick={() => setPriorityMenuOpen(prev => !prev)}
              aria-haspopup="listbox"
              aria-expanded={priorityMenuOpen}
            >
              Set priority
              <ChevronDown size={12} />
            </button>
            {priorityMenuOpen && (
              <div className={styles.priorityMenu} role="listbox">
                {PRIORITY_LEVELS.map(level => (
                  <button
                    key={level}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className={`${styles.priorityMenuItem} ${styles[`priority_${level}`]}`}
                    onClick={() => handlePrioritySelect(level)}
                  >
                    {getPriorityLabel(level)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {onBatchSetSchedule && (
          <div className={styles.scheduleDropdown} ref={scheduleMenuRef}>
            <button
              type="button"
              className={styles.actionButton}
              onClick={() => setScheduleMenuOpen(prev => !prev)}
              aria-haspopup="listbox"
              aria-expanded={scheduleMenuOpen}
            >
              <Calendar size={13} />
              Schedule
              <ChevronDown size={12} />
            </button>
            {scheduleMenuOpen && (
              <div className={styles.scheduleMenu} role="listbox">
                {SCHEDULE_GROUPS.map(group => (
                  <button
                    key={group}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className={styles.scheduleMenuItem}
                    onClick={() => handleScheduleSelect(group)}
                  >
                    {TEMPORAL_GROUP_META[group].label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className={styles.clearButton}
        onClick={onClearSelection}
      >
        Clear
      </button>
    </div>
  );
};

export const InboxSelectionBar = memo(InboxSelectionBarComponent);
InboxSelectionBar.displayName = 'InboxSelectionBar';
