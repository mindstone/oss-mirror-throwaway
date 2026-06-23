import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Tooltip } from '@renderer/components/ui';
import type { AvailableCalendar } from '@shared/ipc/channels/calendar';
import type { AppSettings } from '@shared/types';
import { AlertCircle, CalendarDays, Check, Loader2, RefreshCw } from 'lucide-react';
import { useSettingsSafe } from '../SettingsProvider';
import styles from './SettingsSurface.module.css';

interface CalendarSelectionSectionProps {
  calendarSource: string;
  disabled?: boolean;
  settings: AppSettings | null;
}

const getAccountLabel = (calendarSource: string): string => {
  const [, ...accountParts] = calendarSource.split(':');
  return accountParts.join(':') || calendarSource;
};

const getTestIdSegment = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const buildSelectedCalendarIds = (
  selectedCalendarIds: string[] | null | undefined,
  primaryCalendarId: string | undefined,
): string[] => {
  const normalizedIds = (selectedCalendarIds ?? []).filter((calendarId): calendarId is string => {
    return typeof calendarId === 'string' && calendarId.trim().length > 0;
  });

  if (!primaryCalendarId) {
    return Array.from(new Set(normalizedIds));
  }

  return Array.from(new Set([primaryCalendarId, ...normalizedIds]));
};

export function CalendarSelectionSection({
  calendarSource,
  disabled = false,
  settings,
}: CalendarSelectionSectionProps) {
  const settingsContext = useSettingsSafe();
  const [calendars, setCalendars] = useState<AvailableCalendar[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savingCalendarId, setSavingCalendarId] = useState<string | null>(null);
  const [optimisticSelectedCalendarIds, setOptimisticSelectedCalendarIds] = useState<string[] | null>(null);
  const requestIdRef = useRef(0);

  const shouldRender = settings?.calendar?.useOtherCalendarProvider !== true;
  const accountLabel = useMemo(() => getAccountLabel(calendarSource), [calendarSource]);
  const configuredSelectedCalendarIds = settings?.calendar?.selectedCalendars?.[calendarSource];
  const primaryCalendarId = useMemo(
    () => calendars.find((calendar) => calendar.isPrimary)?.id,
    [calendars],
  );
  const effectiveSelectedCalendarIds = useMemo(() => {
    return buildSelectedCalendarIds(
      optimisticSelectedCalendarIds ?? configuredSelectedCalendarIds,
      primaryCalendarId,
    );
  }, [configuredSelectedCalendarIds, optimisticSelectedCalendarIds, primaryCalendarId]);

  useEffect(() => {
    setOptimisticSelectedCalendarIds(null);
  }, [configuredSelectedCalendarIds]);

  const loadCalendars = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadError(null);

    try {
      const result = await window.calendarApi.listAvailableCalendars({ calendarSource });
      if (requestId !== requestIdRef.current) {
        return;
      }

      if (!result.success) {
        setLoadError(result.error ?? 'Failed to load calendars');
        return;
      }

      setCalendars(result.calendars);
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return;
      }

      setLoadError(error instanceof Error ? error.message : 'Failed to load calendars');
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, [calendarSource]);

  useEffect(() => {
    if (!shouldRender) {
      return undefined;
    }

    void loadCalendars();

    return () => {
      requestIdRef.current += 1;
    };
  }, [loadCalendars, shouldRender]);

  const handleToggleCalendar = useCallback(
    async (calendarId: string, checked: boolean) => {
      if (!settingsContext?.saveSettingsWith) {
        setActionError('Settings are unavailable right now.');
        return;
      }

      const currentSelectedCalendarIds = effectiveSelectedCalendarIds.filter((selectedId) => {
        return selectedId !== calendarId && selectedId !== primaryCalendarId;
      });
      const nextSelectedCalendarIds = buildSelectedCalendarIds(
        checked ? [...currentSelectedCalendarIds, calendarId] : currentSelectedCalendarIds,
        primaryCalendarId,
      );

      setOptimisticSelectedCalendarIds(nextSelectedCalendarIds);
      setSavingCalendarId(calendarId);
      setActionError(null);

      try {
        await settingsContext.saveSettingsWith(
          (currentSettings) => ({
            ...currentSettings,
            calendar: {
              ...currentSettings.calendar,
              selectedCalendars: {
                ...(currentSettings.calendar?.selectedCalendars ?? {}),
                [calendarSource]: nextSelectedCalendarIds,
              },
            },
          }),
          { keepOpen: true },
        );

        const syncResult = await window.calendarApi.triggerSync();
        if (!syncResult.success) {
          setActionError(syncResult.message ?? 'Saved, but failed to start a calendar sync.');
        }
      } catch (error) {
        setOptimisticSelectedCalendarIds(null);
        setActionError(error instanceof Error ? error.message : 'Failed to update calendars');
      } finally {
        setSavingCalendarId(null);
      }
    },
    [calendarSource, effectiveSelectedCalendarIds, primaryCalendarId, settingsContext],
  );

  if (!shouldRender) {
    return null;
  }

  return (
    <div className={styles.mcpExtension}>
      <div className={styles.mcpExtensionHeader}>
        <div className={styles.calendarSelectionHeaderTitle}>
          <CalendarDays size={14} className={styles.chipMuted} />
          <span className={styles.mcpExtensionTitle}>Calendars</span>
        </div>
        <Badge variant="muted" size="sm" className={styles.calendarSelectionAccountBadge}>
          <span className={styles.calendarSelectionAccountBadgeText}>{accountLabel}</span>
        </Badge>
      </div>

      {loading && calendars.length === 0 ? (
        <div className={styles.mcpExtensionLoading}>
          <Loader2 size={14} className={styles.spinnerIcon} />
          Loading calendars...
        </div>
      ) : null}

      {loadError && calendars.length === 0 ? (
        <div className={styles.mcpExtensionError}>
          <AlertCircle size={12} />
          <span>{loadError}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadCalendars()}
            disabled={loading || disabled}
            data-testid={`calendar-selection-retry-${getTestIdSegment(calendarSource)}`}
          >
            <RefreshCw size={12} />
            Retry
          </Button>
        </div>
      ) : null}

      {!loading && !loadError && calendars.length === 0 ? (
        <p className={styles.mcpExtensionEmpty}>No calendars available for this account.</p>
      ) : null}

      {calendars.length > 0 ? (
        <div className={styles.mcpExtensionList}>
          {calendars.map((calendar) => {
            const isPrimaryCalendar = calendar.isPrimary;
            const isChecked = isPrimaryCalendar || effectiveSelectedCalendarIds.includes(calendar.id);
            const isSaving = savingCalendarId === calendar.id;

            return (
              <div
                key={calendar.id}
                className={`${styles.mcpExtensionItem}${isSaving ? ` ${styles.calendarSelectionItemSaving}` : ''}`}
              >
                <label className={styles.calendarSelectionRow}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={disabled || !!savingCalendarId || isPrimaryCalendar}
                    onChange={(event) => {
                      void handleToggleCalendar(calendar.id, event.target.checked);
                    }}
                    className={styles.calendarSelectionCheckbox}
                    data-testid={`calendar-selection-toggle-${getTestIdSegment(calendarSource)}-${getTestIdSegment(calendar.id)}`}
                  />
                  <span className={styles.calendarSelectionLabelGroup}>
                    <span className={styles.calendarSelectionLabelRow}>
                      <span className={styles.calendarSelectionLabel}>{calendar.name}</span>
                      {isPrimaryCalendar ? (
                        <Tooltip content="Your primary calendar is always synced.">
                          <span className={styles.calendarSelectionPrimaryBadgeWrapper}>
                            <Badge variant="muted" size="sm" className={styles.calendarSelectionPrimaryBadge}>
                              <Check size={10} />
                              (Primary)
                            </Badge>
                          </span>
                        </Tooltip>
                      ) : null}
                    </span>
                    {isSaving ? (
                      <span className={styles.calendarSelectionHelper}>
                        <Loader2 size={12} className={styles.spinnerIcon} />
                        Saving...
                      </span>
                    ) : null}
                  </span>
                </label>
              </div>
            );
          })}
        </div>
      ) : null}

      {loadError && calendars.length > 0 ? (
        <div className={styles.mcpExtensionError}>
          <AlertCircle size={12} />
          <span>{loadError}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void loadCalendars()}
            disabled={loading || disabled}
            data-testid={`calendar-selection-retry-${getTestIdSegment(calendarSource)}`}
          >
            <RefreshCw size={12} />
            Retry
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <p className={styles.mcpExtensionError}>
          <AlertCircle size={12} />
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
