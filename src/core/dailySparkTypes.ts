/**
 * Daily Spark Types
 *
 * Core types and helpers for the Daily Spark system — a weekly-generated,
 * daily-revealed personal note that sits on Home.
 *
 * @see docs/plans/260512_daily_spark.md
 */

/** Format pool the LLM picks from for each spark. */
export type DailySparkFormat =
  | 'limerick'
  | 'dry_one_liner'
  | 'haiku'
  | 'faux_news_headline'
  | 'mock_weather_report'
  | 'one_sentence_noir'
  | 'sommelier_note'
  | 'faux_shakespearean_aside'
  | 'telegram_style'
  | 'personal_proverb';

/** Visual layout hint the renderer uses to format the body. */
export type DailySparkLayout = 'poem' | 'single' | 'structured';

/** Tone tier produced by in-LLM classification. Silent suppresses the week entirely. */
export type DailySparkToneGauge = 'normal' | 'gentle' | 'silent';

/** User-controlled visibility mode for the Daily Spark card. */
export type DailySparkMode = 'on' | 'subtle' | 'off';

/** Default mode when the user has not set a preference. */
export const DEFAULT_DAILY_SPARK_MODE: DailySparkMode = 'on';

/** Ordered list of formats so the validator can enforce caps deterministically. */
export const DAILY_SPARK_FORMATS: readonly DailySparkFormat[] = [
  'limerick',
  'dry_one_liner',
  'haiku',
  'faux_news_headline',
  'mock_weather_report',
  'one_sentence_noir',
  'sommelier_note',
  'faux_shakespearean_aside',
  'telegram_style',
  'personal_proverb',
] as const;

/** Formats avoided on `gentle` tone weeks. */
export const GENTLE_TONE_BANNED_FORMATS: ReadonlySet<DailySparkFormat> = new Set([
  'limerick',
  'one_sentence_noir',
  'faux_shakespearean_aside',
]);

/** Soft substitutions used when the validator detects a banned gentle-tone format. */
export const GENTLE_TONE_SUBSTITUTIONS: Readonly<Record<DailySparkFormat, DailySparkFormat>> = {
  limerick: 'personal_proverb',
  one_sentence_noir: 'sommelier_note',
  faux_shakespearean_aside: 'haiku',
  // Identity mapping for the rest — keeps the type total.
  dry_one_liner: 'dry_one_liner',
  haiku: 'haiku',
  faux_news_headline: 'faux_news_headline',
  mock_weather_report: 'mock_weather_report',
  sommelier_note: 'sommelier_note',
  telegram_style: 'telegram_style',
  personal_proverb: 'personal_proverb',
};

/** Maximum number of weekly batches retained in the store. */
export const MAX_DAILY_SPARK_BATCHES = 4;

/** Maximum number of sparks of any single format allowed in one week. */
export const MAX_SPARKS_PER_FORMAT = 2;

/** Per-format hard caps below the generic per-format ceiling. */
export const FORMAT_HARD_CAPS: Readonly<Partial<Record<DailySparkFormat, number>>> = {
  limerick: 1,
  faux_shakespearean_aside: 1,
};

/** Total sparks expected per week when not silent. */
export const SPARKS_PER_WEEK = 7;

/** A single rendered spark for one day. */
export interface DailySpark {
  id: string;
  /** ISO date (YYYY-MM-DD) of the Monday 00:00 in user TZ that anchors this batch. */
  weekStartIso: string;
  /** ISO date (YYYY-MM-DD) of the intended reveal day. */
  dayIso: string;
  format: DailySparkFormat;
  layout: DailySparkLayout;
  /** Body text. May contain `\n` for multi-line poems. Never logged. */
  body: string;
  /** Populated for the first-appearance meta-spark only. Never logged. */
  captionOverride?: string;
  revealedAt?: number;
  dismissedAt?: number;
  feedback?: 'less_like_this';
}

/** A weekly batch produced by one LLM call. */
export interface DailySparkWeeklyBatch {
  weekStartIso: string;
  generatedAt: number;
  toneGauge: DailySparkToneGauge;
  /** 7 entries if normal/gentle, 0 if silent. */
  sparks: DailySpark[];
  sourceModel: string;
  promptVersion: string;
  isFirstAppearanceWeek: boolean;
}

/** Counts of per-format `less_like_this` feedback. */
export type FormatFeedbackCounts = Partial<Record<DailySparkFormat, number>>;

/** Persisted store shape — newest batch first, capped at MAX_DAILY_SPARK_BATCHES. */
export interface DailySparkStoreState {
  [key: string]: unknown;
  batches: DailySparkWeeklyBatch[];
  formatFeedback: FormatFeedbackCounts;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * Format a `Date` as `YYYY-MM-DD` in the given IANA timezone.
 * Used to anchor week and day boundaries regardless of UTC offset / DST shifts.
 */
function formatLocalIsoDate(date: Date, tz: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Return the 0-indexed weekday for the given date in the given timezone, with
 * Monday = 0 and Sunday = 6. Matches the ISO-week semantics used throughout
 * this module.
 */
function getLocalMondayIndex(date: Date, tz: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  }).format(date);
  const map: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  return map[weekday] ?? 0;
}

/**
 * Compute the ISO date (YYYY-MM-DD) of Monday at the start of the week that
 * contains `now`, expressed in the user's timezone.
 *
 * Implementation note: arithmetic against the UTC epoch is the safest cross-DST
 * approach — we shift in 24h increments and re-format using the same TZ each
 * time so DST transitions do not silently move the anchor.
 */
export function computeWeekStartIso(now: Date, tz: string): string {
  const offset = getLocalMondayIndex(now, tz);
  if (offset === 0) {
    return formatLocalIsoDate(now, tz);
  }
  const shifted = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
  // Re-derive the offset on the shifted date in case a DST boundary crossed
  // a non-Monday midnight. Two passes are sufficient for any sane TZ.
  const shiftedOffset = getLocalMondayIndex(shifted, tz);
  if (shiftedOffset === 0) {
    return formatLocalIsoDate(shifted, tz);
  }
  const corrected = new Date(shifted.getTime() - shiftedOffset * 24 * 60 * 60 * 1000);
  return formatLocalIsoDate(corrected, tz);
}

/** Whether the supplied date is a Monday in the given timezone. */
export function isMonday(date: Date, tz: string): boolean {
  return getLocalMondayIndex(date, tz) === 0;
}

/**
 * Return true when the current batch's `weekStartIso` is older than the week
 * that contains `now`. A null/missing anchor is treated as stale.
 */
export function isDailySparkBatchStale(weekStartIso: string | null, now: Date, tz: string): boolean {
  if (weekStartIso === null || weekStartIso.length === 0) return true;
  return weekStartIso !== computeWeekStartIso(now, tz);
}
