/**
 * ScheduleEditorPopover
 *
 * Floating popover for inline editing of automation schedules.
 * Uses @floating-ui/react for positioning.
 * 
 * Stage 1: Daily schedule support only. Other schedule types will be added in Stage 2-3.
 */

import { useState, useCallback, useEffect, useId, type FC, type KeyboardEvent } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  FloatingPortal,
  FloatingFocusManager,
  useDismiss,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { Calendar, X, Info } from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { Select } from '@renderer/components/ui/Select';
import type { AutomationSchedule, AutomationEventType } from '@shared/types';
import { AutomationSchedule as ScheduleConstructors } from '@shared/utils/automationSchedule';
import styles from './ScheduleEditorPopover.module.css';

// Schedule type labels for the dropdown
// 'event' is NOT included - event schedules are read-only and redirect to conversation flow
const SCHEDULE_TYPE_OPTIONS: { value: Exclude<AutomationSchedule['type'], 'event'>; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'every_n_days', label: 'Every N Days' },
];

// Schedule types that are fully implemented and can be saved
// Stage 1: 'daily' - Stage 2: 'hourly', 'weekly', 'monthly' - Stage 3: 'every_n_days'
const SAVEABLE_SCHEDULE_TYPES: Set<AutomationSchedule['type']> = new Set(['daily', 'hourly', 'weekly', 'monthly', 'every_n_days', 'once']);

/**
 * Format a Date as a local datetime string for <input type="datetime-local">.
 * Returns `YYYY-MM-DDTHH:mm` in local time (NOT UTC — do not use toISOString()).
 */
function formatLocalDateTime(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * Get tomorrow at 09:00 local time as a default for once-schedule.
 */
function getDefaultOnceDateTime(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return formatLocalDateTime(tomorrow);
}

/**
 * Internal editor state - flat structure for easier form handling.
 * Fields are populated based on the current schedule type.
 */
interface EditorState {
  scheduleType: AutomationSchedule['type'];
  time: string;             // HH:mm for daily/weekly/monthly/every_n_days
  minute: number;           // 0-59 for hourly
  daysOfWeek: number[];     // 0-6 for weekly
  daysOfMonth: number[];    // 1-31 for monthly
  intervalDays: number;     // for every_n_days
  anchorDate: string;       // ISO date for every_n_days
  dateTime: string;         // YYYY-MM-DDTHH:mm for once
  // Preserved fields (kept on save but not editable in UI):
  additionalTimes?: string[];        // daily
  runOnLastDayIfShorter?: boolean;   // monthly
  eventType?: AutomationEventType;   // event (read-only)
  // UI state:
  saving: boolean;
  error: string | null;
}

/**
 * Convert an AutomationSchedule to EditorState for form editing.
 */
function fromSchedule(schedule: AutomationSchedule): EditorState {
  const base: EditorState = {
    scheduleType: schedule.type,
    time: '09:00',
    minute: 0,
    daysOfWeek: [],
    daysOfMonth: [],
    intervalDays: 7,
    anchorDate: new Date().toISOString().slice(0, 10),
    dateTime: getDefaultOnceDateTime(),
    saving: false,
    error: null,
  };

  switch (schedule.type) {
    case 'hourly':
      return { ...base, minute: schedule.minute };
    case 'daily':
      return {
        ...base,
        time: schedule.time,
        additionalTimes: schedule.additionalTimes,
      };
    case 'weekly':
      return {
        ...base,
        time: schedule.time,
        daysOfWeek: schedule.daysOfWeek,
      };
    case 'monthly':
      return {
        ...base,
        time: schedule.time,
        daysOfMonth: schedule.daysOfMonth,
        runOnLastDayIfShorter: schedule.runOnLastDayIfShorter,
      };
    case 'every_n_days':
      return {
        ...base,
        time: schedule.time,
        intervalDays: schedule.intervalDays,
        anchorDate: schedule.anchorDate,
      };
    case 'once':
      // Slice to YYYY-MM-DDTHH:mm for datetime-local input compatibility
      return { ...base, dateTime: schedule.dateTime.slice(0, 16) };
    case 'event':
      return {
        ...base,
        eventType: schedule.eventType,
      };
    default:
      return base;
  }
}

/**
 * Convert EditorState back to AutomationSchedule for saving.
 */
function toSchedule(state: EditorState): AutomationSchedule {
  switch (state.scheduleType) {
    case 'hourly':
      return ScheduleConstructors.hourly({ minute: state.minute });
    case 'daily':
      return ScheduleConstructors.daily({
        time: state.time,
        ...(state.additionalTimes?.length && { additionalTimes: state.additionalTimes }),
      });
    case 'weekly':
      return ScheduleConstructors.weekly({
        time: state.time,
        daysOfWeek: state.daysOfWeek,
      });
    case 'monthly':
      return ScheduleConstructors.monthly({
        time: state.time,
        daysOfMonth: state.daysOfMonth,
        ...(state.runOnLastDayIfShorter !== undefined && { runOnLastDayIfShorter: state.runOnLastDayIfShorter }),
      });
    case 'every_n_days':
      return ScheduleConstructors.everyNDays({
        time: state.time,
        intervalDays: state.intervalDays,
        anchorDate: state.anchorDate,
      });
    case 'once':
      return ScheduleConstructors.once({ dateTime: state.dateTime });
    case 'event':
      return ScheduleConstructors.event({
        eventType: state.eventType ?? 'transcript-ready',
      });
  }

  const _exhaustiveCheck: never = state.scheduleType;
  throw new Error(`Unsupported schedule type: ${_exhaustiveCheck}`);
}

/**
 * Format an ISO date string (YYYY-MM-DD) into a human-readable format.
 * Example: "2026-01-30" -> "January 30, 2026"
 */
function formatAnchorDate(isoDate: string): string {
  try {
    const date = new Date(isoDate + 'T00:00:00'); // Add time to avoid timezone issues
    return date.toLocaleDateString(undefined, { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
  } catch {
    return isoDate; // Fallback to ISO format if parsing fails
  }
}

/**
 * Validate time string format and range.
 * Returns true if valid HH:mm format with valid hours (00-23) and minutes (00-59).
 */
function isValidTime(time: string): boolean {
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return false;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

/**
 * Validate the current editor state.
 * Returns an error message if invalid, null if valid.
 */
function validateState(state: EditorState): string | null {
  switch (state.scheduleType) {
    case 'hourly':
      if (state.minute < 0 || state.minute > 59) return 'Minute must be 0-59';
      break;
    case 'daily':
    case 'weekly':
    case 'monthly':
    case 'every_n_days':
      if (!isValidTime(state.time)) return 'Invalid time (use HH:MM format)';
      break;
    case 'once':
      if (!state.dateTime) return 'Scheduled time is required';
      if (new Date(state.dateTime).getTime() <= Date.now()) return 'Scheduled time must be in the future';
      break;
    case 'event':
      // Event types are read-only, no validation needed
      break;
  }
  if (state.scheduleType === 'weekly' && state.daysOfWeek.length === 0) {
    return 'Select at least one day';
  }
  if (state.scheduleType === 'monthly' && state.daysOfMonth.length === 0) {
    return 'Select at least one day';
  }
  if (state.scheduleType === 'every_n_days' && state.intervalDays < 1) {
    return 'Interval must be at least 1 day';
  }
  return null;
}

export interface ScheduleEditorPopoverProps {
  isOpen: boolean;
  anchorElement: HTMLElement | null;
  currentSchedule: AutomationSchedule;
  onSave: (schedule: AutomationSchedule) => Promise<void>;
  onClose: () => void;
}

export const ScheduleEditorPopover: FC<ScheduleEditorPopoverProps> = ({
  isOpen,
  anchorElement,
  currentSchedule,
  onSave,
  onClose,
}) => {
  const [state, setState] = useState<EditorState>(() => fromSchedule(currentSchedule));
  const headerId = useId();

  // Reset state when schedule changes or popover opens
  useEffect(() => {
    if (isOpen) {
      setState(fromSchedule(currentSchedule));
    }
  }, [isOpen, currentSchedule]);

  const {
    refs,
    floatingStyles,
    context,
  } = useFloating({
    open: isOpen,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
    placement: 'bottom-start',
    middleware: [
      offset(8),
      flip({ fallbackAxisSideDirection: 'start', padding: 8 }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
    elements: {
      reference: anchorElement,
    },
  });

  const dismiss = useDismiss(context, {
    escapeKey: true,
    outsidePress: true,
  });

  const role = useRole(context, { role: 'dialog' });

  const { getFloatingProps } = useInteractions([dismiss, role]);

  const handleTypeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const newType = e.target.value as EditorState['scheduleType'];
    setState((prev) => {
      // Preserve time when switching types (except to/from hourly and once)
      const preserveTime = newType !== 'hourly' && prev.scheduleType !== 'hourly'
        && newType !== 'once' && prev.scheduleType !== 'once';
      return {
        ...prev,
        scheduleType: newType,
        time: preserveTime ? prev.time : '09:00',
        minute: newType === 'hourly' ? (prev.minute ?? 0) : prev.minute,
        // Set default values for new type if empty
        daysOfWeek: newType === 'weekly' && prev.daysOfWeek.length === 0 
          ? [new Date().getDay()] 
          : prev.daysOfWeek,
        daysOfMonth: newType === 'monthly' && prev.daysOfMonth.length === 0 
          ? [1] 
          : prev.daysOfMonth,
        intervalDays: newType === 'every_n_days' ? (prev.intervalDays || 7) : prev.intervalDays,
        // Only set new anchorDate if switching TO every_n_days from another type
        anchorDate: newType === 'every_n_days' && prev.scheduleType !== 'every_n_days'
          ? new Date().toISOString().slice(0, 10)
          : prev.anchorDate,
        // Default to tomorrow at 09:00 when switching TO once from another type
        dateTime: newType === 'once' && prev.scheduleType !== 'once'
          ? getDefaultOnceDateTime()
          : prev.dateTime,
        error: null,
      };
    });
  }, []);

  const handleTimeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setState((prev) => ({ ...prev, time: e.target.value, error: null }));
  }, []);

  const handleMinuteChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value, 10);
    // Clamp to 0-59 range
    const minute = isNaN(value) ? 0 : Math.max(0, Math.min(59, value));
    setState((prev) => ({ ...prev, minute, error: null }));
  }, []);

  const handleDayOfWeekToggle = useCallback((day: number) => {
    setState((prev) => {
      const current = prev.daysOfWeek;
      const updated = current.includes(day)
        ? current.filter((d) => d !== day)
        : [...current, day].sort((a, b) => a - b);
      return { ...prev, daysOfWeek: updated, error: null };
    });
  }, []);

  const handleDayOfMonthToggle = useCallback((day: number) => {
    setState((prev) => {
      const current = prev.daysOfMonth;
      const updated = current.includes(day)
        ? current.filter((d) => d !== day)
        : [...current, day].sort((a, b) => a - b);
      return { ...prev, daysOfMonth: updated, error: null };
    });
  }, []);

  const handleIntervalChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value, 10);
    // Minimum 1 day interval
    const intervalDays = isNaN(value) ? 1 : Math.max(1, value);
    setState((prev) => ({ ...prev, intervalDays, error: null }));
  }, []);

  const handleDateTimeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setState((prev) => ({ ...prev, dateTime: e.target.value, error: null }));
  }, []);

  const handleSave = useCallback(async () => {
    const validationError = validateState(state);
    if (validationError) {
      setState((prev) => ({ ...prev, error: validationError }));
      return;
    }

    setState((prev) => ({ ...prev, saving: true, error: null }));
    try {
      const schedule = toSchedule(state);
      await onSave(schedule);
      onClose();
    } catch (err) {
      setState((prev) => ({
        ...prev,
        saving: false,
        error: err instanceof Error ? err.message : "Couldn't save that.",
      }));
    }
  }, [state, onSave, onClose]);

  // Handle Enter key to submit (unless it's a day picker button or event type)
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !state.saving) {
      // Don't trigger on day picker buttons or event type
      const target = e.target as HTMLElement;
      const isDayButton = target.closest('[data-testid^="schedule-day-"]');
      if (isDayButton || state.scheduleType === 'event') return;
      
      // Only submit if type is saveable
      if (SAVEABLE_SCHEDULE_TYPES.has(state.scheduleType)) {
        e.preventDefault();
        void handleSave();
      }
    }
  }, [state.saving, state.scheduleType, handleSave]);

  if (!isOpen || !anchorElement) {
    return null;
  }

  // Event type is not editable inline
  const isEventType = state.scheduleType === 'event';
  
  // Check if current type is fully implemented and can be saved
  // Stage 1: Only 'daily' is saveable. Other types will be added in Stage 2-3.
  const canSave = SAVEABLE_SCHEDULE_TYPES.has(state.scheduleType) && !isEventType;

  return (
    <FloatingPortal>
      <FloatingFocusManager context={context} modal={false}>
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          className={styles.popover}
          data-testid="schedule-editor-popover"
          aria-labelledby={headerId}
          onKeyDown={handleKeyDown}
          {...getFloatingProps()}
        >
          <div className={styles.header}>
            <div id={headerId} className={styles.headerTitle}>
              <Calendar size={16} />
              <span>Edit Schedule</span>
            </div>
            <button
              className={styles.closeButton}
              onClick={onClose}
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>

        <div className={styles.content}>
          {/* Schedule Type Selector - hidden for event types */}
          {!isEventType && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="schedule-type">
                Frequency
              </label>
              <Select
                id="schedule-type"
                value={state.scheduleType}
                onChange={handleTypeChange}
                disabled={state.saving}
                data-testid="schedule-type-select"
              >
                {SCHEDULE_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {/* Minute Input - for hourly type */}
          {state.scheduleType === 'hourly' && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="schedule-minute">
                Minute (0-59)
              </label>
              <input
                id="schedule-minute"
                type="number"
                min={0}
                max={59}
                value={state.minute}
                onChange={handleMinuteChange}
                disabled={state.saving}
                className={styles.numberInput}
                data-testid="schedule-minute-input"
              />
              <span className={styles.fieldHint}>
                Runs at {state.minute} minute{state.minute !== 1 ? 's' : ''} past each hour
              </span>
            </div>
          )}

          {/* Date & Time Input - for once type */}
          {state.scheduleType === 'once' && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="schedule-datetime">
                Date & Time
              </label>
              <input
                id="schedule-datetime"
                type="datetime-local"
                value={state.dateTime}
                onChange={handleDateTimeChange}
                min={formatLocalDateTime(new Date())}
                disabled={state.saving}
                className={styles.dateTimeInput}
                data-testid="schedule-datetime-input"
              />
            </div>
          )}

          {/* Time Input - for daily, weekly, monthly types */}
          {(state.scheduleType === 'daily' || state.scheduleType === 'weekly' || state.scheduleType === 'monthly') && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="schedule-time">
                Time
              </label>
              <input
                id="schedule-time"
                type="time"
                value={state.time}
                onChange={handleTimeChange}
                disabled={state.saving}
                className={styles.timeInput}
                data-testid="schedule-time-input"
              />
            </div>
          )}

          {/* Day-of-week checkboxes - for weekly type */}
          {state.scheduleType === 'weekly' && (
            <div className={styles.field}>
              <label className={styles.label}>Days</label>
              <div className={styles.dayPicker}>
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((dayName, index) => (
                  <button
                    key={index}
                    type="button"
                    className={`${styles.dayButton} ${state.daysOfWeek.includes(index) ? styles.dayButtonSelected : ''}`}
                    onClick={() => handleDayOfWeekToggle(index)}
                    disabled={state.saving}
                    data-testid={`schedule-day-${index}`}
                    aria-pressed={state.daysOfWeek.includes(index)}
                    aria-label={`${dayName}${state.daysOfWeek.includes(index) ? ' (selected)' : ''}`}
                  >
                    {dayName}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Day-of-month selector - for monthly type */}
          {state.scheduleType === 'monthly' && (
            <div className={styles.field}>
              <label className={styles.label}>Days of month</label>
              <div className={styles.monthDayPicker}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                  <button
                    key={day}
                    type="button"
                    className={`${styles.monthDayButton} ${state.daysOfMonth.includes(day) ? styles.monthDayButtonSelected : ''}`}
                    onClick={() => handleDayOfMonthToggle(day)}
                    disabled={state.saving}
                    data-testid={`schedule-day-${day}`}
                    aria-pressed={state.daysOfMonth.includes(day)}
                    aria-label={`Day ${day}${state.daysOfMonth.includes(day) ? ' (selected)' : ''}`}
                  >
                    {day}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Time and interval inputs for every_n_days */}
          {state.scheduleType === 'every_n_days' && (
            <>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="schedule-time">
                  Time
                </label>
                <input
                  id="schedule-time"
                  type="time"
                  value={state.time}
                  onChange={handleTimeChange}
                  disabled={state.saving}
                  className={styles.timeInput}
                  data-testid="schedule-time-input"
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="schedule-interval">
                  Interval (days)
                </label>
                <input
                  id="schedule-interval"
                  type="number"
                  min={1}
                  value={state.intervalDays}
                  onChange={handleIntervalChange}
                  disabled={state.saving}
                  className={styles.numberInput}
                  data-testid="schedule-interval-input"
                />
              </div>
              <div className={styles.anchorInfo}>
                Runs every {state.intervalDays} day{state.intervalDays !== 1 ? 's' : ''} starting from {formatAnchorDate(state.anchorDate)}
              </div>
            </>
          )}

          {/* Event type message with "Edit in conversation" button */}
          {isEventType && (
            <div className={styles.eventMessage}>
              <span>Event-triggered automations must be edited through a conversation.</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                className={styles.eventEditButton}
              >
                Edit in conversation
              </Button>
            </div>
          )}

          {/* Additional times warning for daily */}
          {state.scheduleType === 'daily' && state.additionalTimes && state.additionalTimes.length > 0 && (
            <div className={styles.infoNote}>
              <Info size={14} className={styles.infoIcon} aria-hidden="true" />
              <span>This automation also runs at {state.additionalTimes.join(', ')}. These times will be preserved.</span>
            </div>
          )}

          {/* Error display with aria-live for screen readers */}
          <div 
            className={styles.errorContainer} 
            aria-live="polite" 
            aria-atomic="true"
          >
            {state.error && (
              <div className={styles.error} role="alert">{state.error}</div>
            )}
          </div>
        </div>

        <div className={styles.footer}>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={state.saving}
            data-testid="schedule-cancel-button"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={state.saving || !canSave}
            data-testid="schedule-save-button"
          >
            {state.saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
};

ScheduleEditorPopover.displayName = 'ScheduleEditorPopover';
