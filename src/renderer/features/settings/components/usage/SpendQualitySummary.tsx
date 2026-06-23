import { useState } from 'react';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';
import { Badge, Button, Notice, Tooltip } from '@renderer/components/ui';
import { formatCostCompact, formatTokenCount } from '@shared/utils/usageFormatters';
import {
  labelForCategory,
  descForCategory,
  categoriesForGroup,
  ALL_KNOWN_CATEGORIES,
  type CostGroupKey,
} from '@shared/costCategories';
import { type SubscriptionSavings } from '@shared/utils/authMethodDisplay';
import styles from '../SettingsSurface.module.css';

export type UsageReceiptPeriod = 'day' | 'week' | 'month' | 'all';

export type SpendOutcomeKind =
  | 'success'
  | 'aborted'
  | 'quota'
  | 'safety_eval_rejected'
  | 'tool_budget'
  | 'failed'
  | 'auxiliary_success'
  | 'auxiliary_failed'
  | 'legacy_unknown';

export interface SpendQualityBucket {
  totalUsd: number;
  count: number;
  lastTs: number;
}

export interface SpendQualityWaterfall {
  buckets: Record<SpendOutcomeKind, SpendQualityBucket>;
  total: {
    totalUsd: number;
    count: number;
  };
  orphans: {
    resolutionLost: number;
    resolutionUnmatched: number;
  };
}

export type SpendCategoryKey =
  | 'conversations'
  | 'automations'
  | 'fileIntelligence'
  | 'memoryNotes'
  | 'safetyChecks'
  | 'housekeeping';

export type SpendCategoryTotals = Partial<Record<SpendCategoryKey, number>>;

/** The four buckets reconcile to total API-equivalent value. */
export interface HeroSavings extends SubscriptionSavings {
  /** Total API-equivalent value delivered (covered + paid + free + unclassified). */
  totalValueUsd: number;
  /** Coverage percentage of subscription-covered value over total value. */
  coveragePercent: number;
  /**
   * Specific subscription name when usage is from a single subscription auth
   * method, or null when mixed (then the UI says "your subscription").
   */
  subscriptionLabel: string | null;
  /** True when more than one distinct subscription auth method contributed. */
  mixedSubscriptions: boolean;
  /**
   * Out-of-pocket providers (non-subscription, non-local, non-unclassified) that
   * make up "You paid", sorted by cost desc. Drives the multi-provider hero hint.
   */
  paidProviders: Array<{ label: string; cost: number }>;
}

export interface SpendQualitySummaryProps {
  period: UsageReceiptPeriod;
  onPeriodChange: (period: UsageReceiptPeriod) => void;
  loading: boolean;
  error: boolean;
  /** Total API-equivalent value for the period (used for empty-state detection + meta). */
  totalCostUsd: number;
  entryCount: number;
  turnCount: number;
  categoryTotals: SpendCategoryTotals;
  waterfall: SpendQualityWaterfall | null;
  /** Subscription savings split for the honest hero. Null until the auth breakdown loads. */
  savings: HeroSavings | null;
  /** Raw per-category totals for the inline sub-category breakdowns. */
  byCategoryRaw: Record<string, number>;
  /** Automation-type breakdown for the Automations inline expand. */
  automationTypeBreakdown: Array<{ type: string; cost: number; label: string }>;
  /** Total input tokens for the hero meta line (0 hides the token suffix). */
  totalInputTokens: number;
  /**
   * True when the ledger has no entries at all (first use). When false but this
   * period is empty, we show the "no data for this period" recovery branch.
   */
  firstUse: boolean;
}

const PERIODS: Array<{ key: UsageReceiptPeriod; label: string }> = [
  { key: 'day', label: 'Last 24h' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
  { key: 'all', label: 'All time' },
];

const PERIOD_LOWER: Record<UsageReceiptPeriod, string> = {
  day: 'the last 24 hours',
  week: 'the last 7 days',
  month: 'the last 30 days',
  all: 'all time',
};

const CATEGORY_ROWS: Array<{
  key: SpendCategoryKey;
  group: CostGroupKey;
  label: string;
  tooltip: string;
  /** Inline-expandable to nested sub-rows (decision-relevant breakdowns). */
  inlineExpand?: boolean;
}> = [
  {
    key: 'conversations',
    group: 'conversations',
    label: 'Conversations',
    tooltip: 'Interactive work you asked Rebel to do.',
  },
  {
    key: 'automations',
    group: 'automations',
    label: 'Automations',
    tooltip: 'Scheduled or triggered work Rebel ran for you.',
    inlineExpand: true,
  },
  {
    key: 'fileIntelligence',
    group: 'fileIntelligence',
    label: 'Files & search',
    tooltip: 'Indexing, search, and file-understanding work.',
  },
  {
    key: 'memoryNotes',
    group: 'memoryNotes',
    label: 'Memory & notes',
    tooltip: 'Memory updates, notes, and session context.',
  },
  {
    key: 'safetyChecks',
    group: 'safetyChecks',
    label: 'Safety checks',
    tooltip: 'Safety reviews before sensitive actions.',
  },
  {
    key: 'housekeeping',
    group: 'housekeeping',
    label: 'Background housekeeping',
    tooltip: 'Maintenance work that keeps Rebel tidy enough to be useful.',
    inlineExpand: true,
  },
];

const QUALITY_ROWS: Array<{
  key: string;
  label: string;
  outcomeKinds: SpendOutcomeKind[];
  badge: string;
  badgeVariant: 'success' | 'warning' | 'destructive' | 'muted' | 'info';
  muted?: boolean;
}> = [
  {
    key: 'completed',
    label: 'Completed work',
    outcomeKinds: ['success'],
    badge: 'Covered',
    badgeVariant: 'success',
  },
  {
    key: 'behind-the-scenes',
    label: 'Behind-the-scenes work',
    outcomeKinds: ['auxiliary_success'],
    badge: 'Current',
    badgeVariant: 'info',
  },
  {
    key: 'stopped-early',
    label: 'Stopped early',
    outcomeKinds: ['aborted'],
    badge: 'Stopped',
    badgeVariant: 'warning',
  },
  {
    key: 'blocked-for-safety',
    label: 'Blocked for safety',
    outcomeKinds: ['safety_eval_rejected'],
    badge: 'Protected',
    badgeVariant: 'warning',
  },
  {
    key: 'service-limit',
    label: 'Hit a service/tool limit',
    outcomeKinds: ['quota', 'tool_budget'],
    badge: 'Needs attention',
    badgeVariant: 'warning',
  },
  {
    key: 'did-not-finish',
    label: 'Did not finish',
    outcomeKinds: ['failed', 'auxiliary_failed'],
    badge: 'Needs attention',
    badgeVariant: 'destructive',
  },
  {
    key: 'legacy',
    label: 'Older/unclear entries',
    outcomeKinds: ['legacy_unknown'],
    badge: 'Older',
    badgeVariant: 'muted',
    muted: true,
  },
];

function sumOutcomes(
  waterfall: SpendQualityWaterfall,
  outcomeKinds: SpendOutcomeKind[],
): SpendQualityBucket {
  return outcomeKinds.reduce<SpendQualityBucket>(
    (total, kind) => {
      const bucket = waterfall.buckets[kind];
      return {
        totalUsd: total.totalUsd + (bucket?.totalUsd ?? 0),
        count: total.count + (bucket?.count ?? 0),
        lastTs: Math.max(total.lastTs, bucket?.lastTs ?? 0),
      };
    },
    { totalUsd: 0, count: 0, lastTs: 0 },
  );
}

function formatHeroCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

const COVERED_TOOLTIP =
  'Covered work runs on your subscription, so you are not billed per use. The dollar figure is what it would have cost at pay-as-you-go API rates.';

const UNCLASSIFIED_TOOLTIP =
  "This is older usage from before we tracked costs in detail, so we can't sort it by category or payment method. Newer work is fully categorised, so this slice only shrinks over time.";

/** Small info icon that reveals an explanatory tooltip on hover/focus. */
function InfoTip({ content }: { content: string }) {
  return (
    <Tooltip content={content}>
      <span className={styles.usageHeroHelp} aria-label={content} role="img" tabIndex={0}>
        <Info size={13} aria-hidden="true" />
      </span>
    </Tooltip>
  );
}

/**
 * Quiet one-liner naming the top out-of-pocket provider when more than one paid
 * provider contributed — so a multi-provider user sees "Anthropic" (94% of their
 * paid spend) instead of nothing. Suppressed for single-provider users.
 */
function PaidProvidersHint({ providers }: { providers: HeroSavings['paidProviders'] }) {
  if (providers.length < 2) return null;
  const [top, ...rest] = providers;
  // Strip any "(API key)"-style qualifier for a clean provider name in the hint.
  const topName = top.label.replace(/\s*\(.*\)\s*$/, '');
  return (
    <p className={styles.usageHeroMeta} data-testid="usage-hero-paid-providers">
      Mostly {topName} ({formatCostCompact(top.cost)}), plus {rest.length}{' '}
      {rest.length === 1 ? 'other' : 'others'}.
    </p>
  );
}

/**
 * Muted footnote for unattributable spend. Gated at >=1% of total value so it
 * auto-suppresses for recent periods (where the bucket is negligible) — no
 * period special-casing needed. Rephrased off the fault-sounding "could not be
 * classified" and answers "will this improve?" behind the InfoTip.
 */
function UnclassifiedFootnote({ savings }: { savings: HeroSavings }) {
  const denom = savings.totalValueUsd > 0 ? savings.totalValueUsd : 1;
  if (savings.unclassifiedUsd <= 0 || savings.unclassifiedUsd / denom < 0.01) return null;
  return (
    <p className={styles.usageHeroFootnote} data-testid="usage-hero-unclassified">
      {formatCostCompact(savings.unclassifiedUsd)} is from before we tracked costs in detail, so we
      can&apos;t sort it by category. <InfoTip content={UNCLASSIFIED_TOOLTIP} />
    </p>
  );
}

/**
 * Honest hero: leads with "You paid" (out-of-pocket only), frames subscription
 * coverage as good news, and shows unclassified spend as a separate line.
 */
function UsageHero({
  savings,
  turnCount,
  totalInputTokens,
}: {
  savings: HeroSavings;
  turnCount: number;
  totalInputTokens: number;
}) {
  const { hasSubscriptionUsage } = savings;
  const subscriptionName =
    savings.subscriptionLabel && !savings.mixedSubscriptions
      ? savings.subscriptionLabel
      : 'Your subscription';

  // API-only branch: a single honest out-of-pocket number, no coverage bar.
  if (!hasSubscriptionUsage) {
    const paid = savings.actualCostUsd;
    return (
      <div className={styles.usageReceiptHero} data-testid="usage-hero">
        <span className={styles.usageReceiptHeroLabel}>You paid</span>
        <strong className={styles.usageReceiptHeroValue} data-testid="usage-hero-paid">
          {formatHeroCost(paid)}
        </strong>
        <PaidProvidersHint providers={savings.paidProviders} />
        {savings.freeUsd > 0 && (
          <p className={styles.usageHeroMeta} data-testid="usage-hero-free">
            Plus {formatCostCompact(savings.freeUsd)} on local models, free.
          </p>
        )}
        <UnclassifiedFootnote savings={savings} />
        <p className={styles.usageHeroMeta}>
          {turnCount} {turnCount === 1 ? 'turn' : 'turns'}
          {totalInputTokens > 0 && <> · {formatTokenCount(totalInputTokens)} input tokens</>}
        </p>
      </div>
    );
  }

  // Subscription branch: lead with "You paid", frame coverage as context.
  // One fact per line, said once (per clarity-pass brief): paid → covered
  // sentence + bar → meta. No redundant "% covered" caption, no quip.
  return (
    <div className={styles.usageReceiptHero} data-testid="usage-hero">
      <span className={styles.usageReceiptHeroLabel}>You paid</span>
      <strong className={styles.usageReceiptHeroValue} data-testid="usage-hero-paid">
        {formatHeroCost(savings.actualCostUsd)}
      </strong>

      <PaidProvidersHint providers={savings.paidProviders} />

      <p className={styles.usageHeroCommentary} data-testid="usage-hero-covered">
        {subscriptionName} covered {formatCostCompact(savings.subscriptionCoveredUsd)} of{' '}
        {formatCostCompact(savings.totalValueUsd)} total value. <InfoTip content={COVERED_TOOLTIP} />
      </p>

      <div className={styles.usageRatioSection}>
        <div className={styles.usageRatioTrack} role="presentation" aria-hidden="true">
          <div
            className={styles.usageRatioFill}
            style={{ width: `${Math.min(Math.max(savings.coveragePercent, 2), 100)}%` }}
          />
        </div>
        <span className={styles.usageRatioPercent}>{savings.coveragePercent}% covered</span>
      </div>

      {savings.freeUsd > 0 && (
        <p className={styles.usageHeroMeta} data-testid="usage-hero-free">
          {formatCostCompact(savings.freeUsd)} ran on local models, free.
        </p>
      )}

      <UnclassifiedFootnote savings={savings} />

      <p className={styles.usageHeroMeta}>
        {turnCount} {turnCount === 1 ? 'turn' : 'turns'}
        {totalInputTokens > 0 && <> · {formatTokenCount(totalInputTokens)} input tokens</>}
      </p>
    </div>
  );
}

export function SpendQualitySummary({
  period,
  onPeriodChange,
  loading,
  error,
  totalCostUsd,
  entryCount,
  turnCount,
  categoryTotals,
  waterfall,
  savings,
  byCategoryRaw,
  automationTypeBreakdown,
  totalInputTokens,
  firstUse,
}: SpendQualitySummaryProps) {
  const [expandedCategory, setExpandedCategory] = useState<SpendCategoryKey | null>(null);

  const totalCategoryCost = CATEGORY_ROWS.reduce(
    (sum, row) => sum + (categoryTotals[row.key] ?? 0),
    0,
  );

  const totalAutomationCost = automationTypeBreakdown.reduce((sum, a) => sum + a.cost, 0);

  const hasUsage = entryCount > 0 && totalCostUsd > 0;

  return (
    <div className={styles.usageReceipt} data-testid="spend-quality-summary">
      <div className={styles.usageReceiptPeriodFilter} aria-label="Usage period">
        {PERIODS.map((option) => (
          <Button
            key={option.key}
            variant={period === option.key ? 'secondary' : 'outline'}
            onClick={() => onPeriodChange(option.key)}
            aria-pressed={period === option.key}
            data-testid={`usage-period-${option.key}`}
          >
            {option.label}
          </Button>
        ))}
      </div>

      {loading ? (
        <p className={styles.usageLoading}>Loading usage data…</p>
      ) : error ? (
        <Notice tone="error">
          Usage data could not be loaded. Your work is untouched. Try again.
        </Notice>
      ) : !hasUsage ? (
        // Distinguish genuine first-use (empty ledger) from an empty period:
        // firstUse drives the witty empty copy; otherwise the recovery branch.
        <NoUsage period={period} firstUse={firstUse} />
      ) : (
        <>
          {savings ? (
            <UsageHero savings={savings} turnCount={turnCount} totalInputTokens={totalInputTokens} />
          ) : (
            <div className={styles.usageReceiptHero} data-testid="usage-hero">
              <span className={styles.usageReceiptHeroLabel}>Total value</span>
              <strong className={styles.usageReceiptHeroValue}>
                {formatHeroCost(totalCostUsd)}
              </strong>
            </div>
          )}

          {/* Header names the list's question (WHERE work went) and reuses "total value"
              so the $436 here visibly matches the hero's "total value", not the "You paid"
              number — closing the $4.05-vs-$436 coherence gap. */}
          <div className={styles.usageQualityHeader}>
            <h3 className={styles.usageQualityTitle}>Where the work went</h3>
            <p className={styles.usageQualityDescription}>
              {formatHeroCost(totalCostUsd)} of total value across {turnCount}{' '}
              {turnCount === 1 ? 'turn' : 'turns'}.
            </p>
          </div>

          <div className={styles.usageReceiptCategoryList} aria-label="Where the work went">
            {CATEGORY_ROWS.map((row) => {
              const amount = categoryTotals[row.key] ?? 0;
              const percent = totalCategoryCost > 0 ? (amount / totalCategoryCost) * 100 : 0;

              // Build the raw sub-category breakdown for this group.
              const rawCategories = categoriesForGroup(row.group);
              let rawBreakdown = rawCategories
                .map((raw) => ({ raw, cost: byCategoryRaw[raw] ?? 0 }))
                .filter(({ cost }) => cost > 0)
                .sort((a, b) => b.cost - a.cost);

              // Housekeeping absorbs unknown/unmapped raw categories (compaction lives here).
              if (row.group === 'housekeeping') {
                const unknownCats = Object.entries(byCategoryRaw)
                  .filter(([cat, c]) => !ALL_KNOWN_CATEGORIES.has(cat) && c > 0)
                  .map(([cat, c]) => ({ raw: cat, cost: c }));
                rawBreakdown = [...rawBreakdown, ...unknownCats].sort((a, b) => b.cost - a.cost);
              }

              // Inline-expandable rows (Automations, Background housekeeping).
              if (row.inlineExpand) {
                const subRows =
                  row.group === 'automations'
                    ? automationTypeBreakdown.map((a) => ({
                        key: a.type,
                        label: a.label,
                        cost: a.cost,
                      }))
                    : rawBreakdown.map((r) => ({
                        key: r.raw,
                        label: labelForCategory(r.raw),
                        cost: r.cost,
                      }));
                const subTotal =
                  row.group === 'automations'
                    ? totalAutomationCost
                    : rawBreakdown.reduce((s, r) => s + r.cost, 0);
                const canExpand = subRows.length >= 2 && amount > 0;
                const isExpanded = expandedCategory === row.key;

                return (
                  <div key={row.key} className={styles.usageCategoryExpandable}>
                    <div
                      className={`${styles.usageReceiptRow} ${canExpand ? styles.usageCategoryRowClickable : ''}`}
                      onClick={
                        canExpand
                          ? () => setExpandedCategory(isExpanded ? null : row.key)
                          : undefined
                      }
                      role={canExpand ? 'button' : undefined}
                      tabIndex={canExpand ? 0 : undefined}
                      aria-expanded={canExpand ? isExpanded : undefined}
                      onKeyDown={
                        canExpand
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setExpandedCategory(isExpanded ? null : row.key);
                              }
                            }
                          : undefined
                      }
                      data-testid={`usage-category-${row.key}`}
                    >
                      <span className={styles.usageReceiptRowLabel}>
                        {canExpand && (
                          <span className={styles.usageCategoryChevron}>
                            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                          </span>
                        )}
                        {row.label}
                      </span>
                      <div
                        className={styles.usageReceiptBarTrack}
                        role="presentation"
                        aria-hidden="true"
                      >
                        <span
                          className={styles.usageReceiptBarFill}
                          style={{ width: `${Math.max(percent, amount > 0 ? 2 : 0)}%` }}
                        />
                      </div>
                      <span className={styles.usageReceiptRowValue}>
                        {formatCostCompact(amount)}
                      </span>
                    </div>
                    {canExpand && isExpanded && (
                      <div className={styles.usageSubCategoryList} data-testid={`usage-subrows-${row.key}`}>
                        {subRows.map((sub) => {
                          const subPercent = subTotal > 0 ? (sub.cost / subTotal) * 100 : 0;
                          return (
                            <div key={sub.key} className={styles.usageSubCategoryRow}>
                              <span className={styles.usageSubCategoryLabel} title={sub.label}>
                                {sub.label}
                              </span>
                              <div
                                className={styles.usageSubCategoryBarTrack}
                                role="presentation"
                                aria-hidden="true"
                              >
                                <span
                                  className={styles.usageSubCategoryBar}
                                  style={{ width: `${Math.max(subPercent, 3)}%` }}
                                />
                              </div>
                              <span className={styles.usageSubCategoryCost}>
                                {formatCostCompact(sub.cost)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }

              // Tooltip-composition rows (low-cardinality groups).
              let tooltipContent: React.ReactNode = row.tooltip;
              if (rawBreakdown.length > 1) {
                tooltipContent = (
                  <div className={styles.usageCategoryTooltip}>
                    {rawBreakdown.map(({ raw, cost: rawCost }) => {
                      const label = labelForCategory(raw);
                      const desc = descForCategory(raw);
                      return (
                        <div key={raw} className={styles.usageCategoryTooltipRow}>
                          <div className={styles.usageCategoryTooltipLabel}>
                            <span>{label}</span>
                            {desc && (
                              <span className={styles.usageCategoryTooltipDesc}>{desc}</span>
                            )}
                          </div>
                          <span className={styles.usageCategoryTooltipCost}>
                            {formatCostCompact(rawCost)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              }

              const rowContent = (
                <div className={styles.usageReceiptRow} data-testid={`usage-category-${row.key}`}>
                  <span className={styles.usageReceiptRowLabel}>{row.label}</span>
                  <div
                    className={styles.usageReceiptBarTrack}
                    role="presentation"
                    aria-hidden="true"
                  >
                    <span
                      className={styles.usageReceiptBarFill}
                      style={{ width: `${Math.max(percent, amount > 0 ? 2 : 0)}%` }}
                    />
                  </div>
                  <span className={styles.usageReceiptRowValue}>{formatCostCompact(amount)}</span>
                </div>
              );

              return (
                <Tooltip key={row.key} content={tooltipContent} placement="left">
                  {rowContent}
                </Tooltip>
              );
            })}
          </div>

          {waterfall && (
            <section className={styles.usageQualityBlock} aria-labelledby="spend-quality-heading">
              <div className={styles.usageQualityHeader}>
                <h3 id="spend-quality-heading" className={styles.usageQualityTitle}>
                  Spend quality
                </h3>
                <p className={styles.usageQualityDescription}>
                  A plain-English receipt for what finished, what stopped, and what got blocked.
                </p>
              </div>

              <div className={styles.usageQualityRows}>
                {QUALITY_ROWS.map((row) => {
                  const bucket = sumOutcomes(waterfall, row.outcomeKinds);
                  if (row.key === 'legacy' && bucket.totalUsd <= 0) return null;

                  return (
                    <div
                      key={row.key}
                      className={[
                        styles.usageQualityRow,
                        row.muted ? styles.usageQualityRowMuted : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <div className={styles.usageQualityRowText}>
                        <span className={styles.usageQualityRowLabel}>{row.label}</span>
                        {row.key === 'legacy' && (
                          <span className={styles.usageQualityRowNote}>
                            Older entries from before Rebel kept tidier receipts.
                          </span>
                        )}
                      </div>
                      <Badge variant={row.badgeVariant} size="sm">
                        {row.badge}
                      </Badge>
                      <span className={styles.usageQualityRowValue}>
                        {formatCostCompact(bucket.totalUsd)}
                      </span>
                    </div>
                  );
                })}
              </div>

              {(() => {
                const unfinished = sumOutcomes(waterfall, ['failed', 'auxiliary_failed']);
                if (unfinished.totalUsd <= 0) return null;
                const background = sumOutcomes(waterfall, ['auxiliary_failed']);
                const mostlyBackground = background.totalUsd >= unfinished.totalUsd * 0.6;
                return (
                  <p className={styles.usageQualityRowNote} data-testid="usage-unfinished-note">
                    {unfinished.count} {unfinished.count === 1 ? 'task' : 'tasks'} didn&apos;t finish
                    but were still billed — {formatCostCompact(unfinished.totalUsd)} in total
                    {mostlyBackground
                      ? ', mostly background work retrying behind the scenes.'
                      : '.'}{' '}
                    <InfoTip content="Some work fails partway (a timeout, a limit, a background retry) after the model has already done billable work. We charge for what ran, not the finished result. Most of this is background maintenance, not your conversations." />
                  </p>
                );
              })()}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** Empty / no-data-for-period copy. The period control stays visible (rendered above). */
function NoUsage({ period, firstUse }: { period: UsageReceiptPeriod; firstUse: boolean }) {
  if (firstUse) {
    return (
      <p className={styles.usageEmpty} data-testid="usage-empty">
        No usage yet. Have a conversation and the receipt will appear here. Bureaucracy, but useful.
      </p>
    );
  }
  return (
    <p className={styles.usageEmpty} data-testid="usage-no-data-for-period">
      Nothing here for {PERIOD_LOWER[period]}. Try a different time period.
    </p>
  );
}
