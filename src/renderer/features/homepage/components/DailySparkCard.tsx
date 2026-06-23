/**
 * DailySparkCard — slim local Daily Spark surface on Home.
 *
 * The card sits between PageHeader and HomepageChat and renders one short
 * personal note for the day. Reuse-vs-new audit lives in
 * docs/plans/260512_daily_spark.md § Renderer Integration.
 *
 * Privacy invariant: spark body and captionOverride text must never appear in
 * logs, telemetry, or analytics payloads. Format names, ids, counts, and
 * timing are fine — spark text is not. The component reads `spark.body` /
 * `spark.captionOverride` for render only.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { MoreHorizontal } from 'lucide-react';
import { IconButton } from '@renderer/components/ui';
import type { DailySpark } from '@core/dailySparkTypes';
import styles from './DailySparkCard.module.css';

export interface DailySparkCardProps {
  spark: DailySpark;
  isFirstAppearance: boolean;
  onDismissToday: () => void;
  onLessLikeThis: () => void;
  onOpenSettings: () => void;
}

function formatWeekday(dayIso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayIso);
  if (!match) return '';
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(day)) {
    return '';
  }
  const date = new Date(Date.UTC(year, monthIndex, day));
  try {
    // Pinned to en-US so the weekday matches the hardcoded English "Daily Spark, "
    // prefix in the sr-only announcement; mixing locales there reads awkwardly.
    return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(date);
  } catch {
    return '';
  }
}

function renderBody(spark: DailySpark): React.ReactNode {
  if (spark.layout === 'single') {
    return <p className={styles.body} data-testid="daily-spark-body">{spark.body}</p>;
  }
  const lines = spark.body.split('\n');
  return (
    <p className={styles.body} data-testid="daily-spark-body">
      {lines.map((line, idx) => (
        <span key={idx}>
          {line}
          {idx < lines.length - 1 && <br />}
        </span>
      ))}
    </p>
  );
}

export function DailySparkCard({
  spark,
  isFirstAppearance,
  onDismissToday,
  onLessLikeThis,
  onOpenSettings,
}: DailySparkCardProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

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

  const handleDismissToday = useCallback(() => {
    setIsOpen(false);
    onDismissToday();
  }, [onDismissToday]);

  const handleLessLikeThis = useCallback(() => {
    setIsOpen(false);
    onLessLikeThis();
  }, [onLessLikeThis]);

  const handleOpenSettings = useCallback(() => {
    setIsOpen(false);
    onOpenSettings();
  }, [onOpenSettings]);

  const caption = isFirstAppearance && spark.captionOverride
    ? spark.captionOverride
    : 'Daily Spark';

  const weekday = useMemo(() => formatWeekday(spark.dayIso), [spark.dayIso]);
  const accessiblePrefix = weekday
    ? `Daily Spark, ${weekday}.`
    : 'Daily Spark.';

  return (
    <section
      className={styles.card}
      data-testid="daily-spark-card"
      data-format={spark.format}
      data-layout={spark.layout}
      aria-labelledby={`daily-spark-caption-${spark.id}`}
    >
      <span aria-hidden="true" className={styles.accentRail} />
      <div className={styles.content}>
        <p className={styles.caption} id={`daily-spark-caption-${spark.id}`}>
          {caption}
        </p>
        <span className={styles.srOnly}>{accessiblePrefix}</span>
        {renderBody(spark)}
      </div>
      <div className={styles.menuTrigger}>
        <IconButton
          ref={(node) => {
            triggerRef.current = node;
            refs.setReference(node);
          }}
          size="xs"
          variant="ghost"
          aria-label="Daily Spark options"
          aria-haspopup="menu"
          aria-expanded={isOpen}
          data-testid="daily-spark-options"
          {...getReferenceProps()}
        >
          <MoreHorizontal size={16} strokeWidth={2} />
        </IconButton>
      </div>
      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className={styles.menu}
            role="menu"
            data-positioned={isPositioned}
            data-testid="daily-spark-menu"
            {...getFloatingProps()}
          >
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={handleDismissToday}
              data-testid="daily-spark-menu-hide-today"
            >
              Hide today
            </button>
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={handleLessLikeThis}
              data-testid="daily-spark-menu-less-like-this"
            >
              Less like this
            </button>
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={handleOpenSettings}
              data-testid="daily-spark-menu-settings"
            >
              Daily Spark settings
            </button>
          </div>
        </FloatingPortal>
      )}
    </section>
  );
}

DailySparkCard.displayName = 'DailySparkCard';
