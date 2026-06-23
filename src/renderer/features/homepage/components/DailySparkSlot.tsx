/**
 * DailySparkSlot — gating-aware wrapper for DailySparkCard.
 *
 * Owns the IPC subscription via useDailySpark and renders either the card or
 * nothing. Lets HomepagePanel diff stay a single-line insertion.
 *
 * Privacy invariant: spark body and captionOverride text must never appear in
 * logs, telemetry, or analytics payloads. Format names, ids, counts, and
 * timing are fine — spark text is not.
 */
import { useDailySpark } from '../hooks/useDailySpark';
import { DailySparkCard } from './DailySparkCard';

export function DailySparkSlot(): React.ReactElement | null {
  const { spark, isFirstAppearance, dismiss, feedback, openSettings } = useDailySpark();
  if (!spark) return null;
  return (
    <DailySparkCard
      spark={spark}
      isFirstAppearance={isFirstAppearance}
      onDismissToday={dismiss}
      onLessLikeThis={feedback}
      onOpenSettings={openSettings}
    />
  );
}

DailySparkSlot.displayName = 'DailySparkSlot';
