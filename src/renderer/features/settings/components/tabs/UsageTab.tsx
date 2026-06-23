import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Trophy, Zap } from 'lucide-react';
import { Badge, Button, Notice, Tooltip } from '@renderer/components/ui';
import { useAppNavigation } from '@renderer/hooks/useAppNavigation';
import { formatCostCompact, formatTokenCount } from '@shared/utils/usageFormatters';
import { exportLedgerDailyToCsv, type LedgerDailyBreakdown } from '@shared/utils/usageHistoryUtils';
import { AUTH_METHOD_DISPLAY, calculateSubscriptionSavings } from '@shared/utils/authMethodDisplay';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { SettingSection } from '../SettingSection';
import {
  SpendQualitySummary,
  type HeroSavings,
  type SpendCategoryTotals,
  type SpendQualityWaterfall,
  type UsageReceiptPeriod,
} from '../usage/SpendQualitySummary';
import styles from '../SettingsSurface.module.css';

type TimePeriod = UsageReceiptPeriod;

const PERIOD_DAYS: Record<TimePeriod, number | null> = {
  day: 1,
  week: 7,
  month: 30,
  all: null,
};

/** Human-readable labels for automation types (fallback when the live name lookup misses). */
const AUTOMATION_TYPE_LABELS: Record<string, string> = {
  'calendar-sync': 'Calendar Sync',
  'wins-learnings-uncover': 'Daily Wins & Learnings',
  'community-highlights': 'Community Highlights',
  'use-case-refresh': 'Use Case Refresh',
  'transcript-analysis': 'Meeting Transcript Analysis',
  'community-video-recs': 'Video Picks',
  'source-capture': 'Source Capture',
};

interface CostSummary {
  totalCostUsd: number;
  entryCount: number;
  turnCount: number;
  oldestEntry: number | null;
  newestEntry: number | null;
  byCategory: Record<string, number>;
  byCategoryRaw: Record<string, number>;
  byModel?: Record<string, number>;
  byAutomationType: Record<string, number>;
  byAuthMethod: Record<string, number>;
  totalInputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
}

interface UsageInsights {
  topSession: {
    sessionId: string;
    cost: number;
    title: string | null;
    timestamp: number;
  } | null;
  topTurn: {
    turnId: string;
    sessionId: string | null;
    cost: number;
    timestamp: number;
    sessionTitle: string | null;
  } | null;
  comparison: {
    currentPeriodCost: number;
    previousPeriodCost: number;
    percentChange: number | null;
  };
  avgCostPerTurn: number | null;
  avgCostPerActiveDay: number | null;
  activeDayCount: number;
  peakDay: { date: string; cost: number } | null;
  projectedMonthCost: number | null;
  projectionBasis: {
    effectiveDays: number;
    daysSinceFirstUsage: number;
    periodDays: number;
  } | null;
}

function formatShortDate(iso: string | number): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export const UsageTab = () => {
  const { navigate } = useAppNavigation();

  const [timePeriod, setTimePeriod] = useState<TimePeriod>('week');
  const [costSummary, setCostSummary] = useState<CostSummary | null>(null);
  const [costWaterfall, setCostWaterfall] = useState<SpendQualityWaterfall | null>(null);
  const [insights, setInsights] = useState<UsageInsights | null>(null);
  const [dailyBreakdown, setDailyBreakdown] = useState<LedgerDailyBreakdown[] | null>(null);
  const [automationNames, setAutomationNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  /** Tier-1 (insights + daily) fetch failed but the glance succeeded → observable degrade. */
  // Tier-1 detail fetches degrade independently: insights (Records / Efficiency /
  // trend / peak) vs daily breakdown (table / CSV). One failing must not hide the other.
  const [insightsError, setInsightsError] = useState(false);
  const [dailyError, setDailyError] = useState(false);
  /** Whether the ledger has ANY entries at all (drives first-use vs empty-period copy). */
  const [hasAnyLedgerEntries, setHasAnyLedgerEntries] = useState(true);

  const sinceTimestamp = useMemo(() => {
    const days = PERIOD_DAYS[timePeriod];
    if (days === null) return undefined;
    return Date.now() - days * 24 * 60 * 60 * 1000;
  }, [timePeriod]);

  // Resolve automation UUIDs/system-types to human-readable names (once on mount).
  useEffect(() => {
    let cancelled = false;
    const loadAutomationNames = async () => {
      try {
        const state = await window.automationsApi.state();
        if (cancelled) return;
        const nameMap: Record<string, string> = {};
        for (const def of state.definitions) {
          nameMap[def.id] = def.name;
          if (def.systemType) nameMap[def.systemType] = def.name;
        }
        setAutomationNames(nameMap);
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'loadAutomationNames',
          reason: 'automation labels fall back to AUTOMATION_TYPE_LABELS or the raw type',
        });
      }
    };
    void loadAutomationNames();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadCostData = async () => {
      setLoading(true);
      setLoadError(false);
      setInsightsError(false);
      setDailyError(false);

      const periodDays = PERIOD_DAYS[timePeriod] ?? 365 * 10; // 10 years for "all time"

      // Glance data (summary + waterfall) is load-bearing: a failure fails the page.
      let summaryResult: CostSummary;
      let waterfallResult: SpendQualityWaterfall;
      try {
        [summaryResult, waterfallResult] = await Promise.all([
          window.usageApi.getCostSummary({ since: sinceTimestamp }),
          window.usageApi.getCostWaterfall({ since: sinceTimestamp }),
        ]);
      } catch (err) {
        // Observable failure: surface the user-visible error state (not a silent swallow).
        ignoreBestEffortCleanup(err, {
          operation: 'loadUsageGlanceData',
          reason: 'rendered as the page-level error Notice; user can retry',
          severity: 'warn',
        });
        if (cancelled) return;
        setLoadError(true);
        setCostSummary(null);
        setCostWaterfall(null);
        setInsights(null);
        setDailyBreakdown(null);
        setLoading(false);
        return;
      }

      if (cancelled) return;
      setCostSummary(summaryResult);
      setCostWaterfall(waterfallResult);

      // Tier-1 detail data degrades observably, never fails the page — and the two
      // fetches degrade INDEPENDENTLY: a daily-breakdown failure must not hide the
      // insights-backed Records/Efficiency, and vice versa. Each runs as its own task
      // that catches internally, so a rejection handler is attached the instant the
      // promise is created (no unhandled-rejection window) while degradation stays
      // independent. Both are awaited together; neither inner task ever rejects.
      const loadInsights = async () => {
        try {
          const insightsResult = await window.usageApi.getInsights({ periodDays });
          if (!cancelled) setInsights(insightsResult);
        } catch (err) {
          ignoreBestEffortCleanup(err, {
            operation: 'loadUsageInsights',
            reason: 'glance stays accurate; Records/Efficiency show a degradation Notice + badge',
            severity: 'warn',
          });
          if (!cancelled) {
            setInsightsError(true);
            setInsights(null);
          }
        }
      };
      const loadDaily = async () => {
        try {
          const dailyResult = await window.usageApi.getDailyBreakdown({ since: sinceTimestamp });
          if (!cancelled) setDailyBreakdown(dailyResult);
        } catch (err) {
          ignoreBestEffortCleanup(err, {
            operation: 'loadUsageDailyBreakdown',
            reason: 'glance stays accurate; the Day by day table shows a degradation Notice + badge',
            severity: 'warn',
          });
          if (!cancelled) {
            setDailyError(true);
            setDailyBreakdown(null);
          }
        }
      };
      await Promise.all([loadInsights(), loadDaily()]);
      if (cancelled) return;

      // Track whether the ledger has any entries at all (for first-use detection).
      // The "all time" summary is the authoritative signal; reuse the current
      // summary when we're already looking at all time.
      try {
        const allTime =
          timePeriod === 'all'
            ? summaryResult
            : await window.usageApi.getCostSummary({});
        if (!cancelled) setHasAnyLedgerEntries(allTime.entryCount > 0);
      } catch (err) {
        // If the all-time probe fails we can't prove first-use. Assume history exists
        // (entries !== first use) so an empty current period shows the recoverable
        // "no data for this period" branch rather than a false "first use" message.
        if (!cancelled && summaryResult.entryCount === 0) setHasAnyLedgerEntries(true);
        ignoreBestEffortCleanup(err, {
          operation: 'loadAllTimeLedgerSignal',
          reason: 'first-use detection: on probe failure, prefer the no-data-for-period branch over a false first-use',
        });
      }

      if (!cancelled) setLoading(false);
    };

    void loadCostData();
    return () => {
      cancelled = true;
    };
  }, [sinceTimestamp, timePeriod]);

  const categoryTotals = useMemo<SpendCategoryTotals>(
    () => ({
      conversations: costSummary?.byCategory.conversations ?? 0,
      automations: costSummary?.byCategory.automations ?? 0,
      fileIntelligence: costSummary?.byCategory.fileIntelligence ?? 0,
      memoryNotes: costSummary?.byCategory.memoryNotes ?? 0,
      safetyChecks: costSummary?.byCategory.safetyChecks ?? 0,
      housekeeping: costSummary?.byCategory.housekeeping ?? 0,
    }),
    [costSummary?.byCategory],
  );

  const automationTypeBreakdown = useMemo(() => {
    if (!costSummary?.byAutomationType) return [];
    return Object.entries(costSummary.byAutomationType)
      .filter(([, cost]) => cost > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([type, cost]) => ({
        type,
        cost,
        label: automationNames[type] ?? AUTOMATION_TYPE_LABELS[type] ?? type,
      }));
  }, [costSummary?.byAutomationType, automationNames]);

  // Honest hero savings: split the auth breakdown into covered / paid / unclassified / free.
  const heroSavings = useMemo<HeroSavings | null>(() => {
    if (!costSummary?.byAuthMethod || Object.keys(costSummary.byAuthMethod).length === 0) {
      return null;
    }
    const base = calculateSubscriptionSavings(costSummary.byAuthMethod);
    const totalValueUsd =
      base.subscriptionCoveredUsd + base.actualCostUsd + base.freeUsd + base.unclassifiedUsd;
    const coveragePercent =
      totalValueUsd > 0 ? Math.round((base.subscriptionCoveredUsd / totalValueUsd) * 100) : 0;

    // Determine the specific subscription label (or "mixed" → generic).
    const subscriptionAuths = Object.entries(costSummary.byAuthMethod).filter(
      ([auth, cost]) => cost > 0 && AUTH_METHOD_DISPLAY[auth]?.isSubscription,
    );
    const distinctLabels = new Set(
      subscriptionAuths.map(([auth]) => AUTH_METHOD_DISPLAY[auth]?.label ?? auth),
    );
    const mixedSubscriptions = distinctLabels.size > 1;
    const subscriptionLabel =
      distinctLabels.size === 1 ? [...distinctLabels][0] : null;

    // Out-of-pocket providers behind "You paid" (non-subscription, non-local,
    // non-unclassified), sorted by cost — drives the multi-provider hero hint.
    const paidProviders = Object.entries(costSummary.byAuthMethod)
      .filter(([auth, cost]) => {
        if (!(cost > 0) || auth === 'unknown' || auth === 'local') return false;
        return !(AUTH_METHOD_DISPLAY[auth]?.isSubscription ?? false);
      })
      .map(([auth, cost]) => ({ label: AUTH_METHOD_DISPLAY[auth]?.label ?? auth, cost }))
      .sort((a, b) => b.cost - a.cost);

    return {
      ...base,
      totalValueUsd,
      coveragePercent,
      subscriptionLabel,
      mixedSubscriptions,
      paidProviders,
    };
  }, [costSummary?.byAuthMethod]);

  // By-model breakdown (Tier-1 detail).
  const modelBreakdown = useMemo(() => {
    if (!costSummary?.byModel) return [];
    return Object.entries(costSummary.byModel)
      .filter(([, cost]) => cost > 0)
      .sort(([, a], [, b]) => b - a);
  }, [costSummary?.byModel]);
  const totalModelCost = useMemo(
    () => modelBreakdown.reduce((sum, [, cost]) => sum + cost, 0),
    [modelBreakdown],
  );

  // By provider & plan (Tier-1 detail), grouped so the user's real question reads
  // top-to-bottom: what's out of my pocket vs what a subscription covered. The
  // 'unknown' bucket ("Before cost tracking") is neither — it trails, muted.
  const authBreakdown = useMemo(() => {
    if (!costSummary?.byAuthMethod) return [];
    return Object.entries(costSummary.byAuthMethod)
      .filter(([, cost]) => cost > 0)
      .sort(([, a], [, b]) => b - a);
  }, [costSummary?.byAuthMethod]);
  const totalAuthCost = useMemo(
    () => authBreakdown.reduce((sum, [, cost]) => sum + cost, 0),
    [authBreakdown],
  );
  const authGroups = useMemo(() => {
    const paid: Array<[string, number]> = [];
    const covered: Array<[string, number]> = [];
    const unclassified: Array<[string, number]> = [];
    for (const row of authBreakdown) {
      const [auth] = row;
      if (auth === 'unknown') unclassified.push(row);
      else if (AUTH_METHOD_DISPLAY[auth]?.isSubscription) covered.push(row);
      else paid.push(row);
    }
    return { paid, covered, unclassified };
  }, [authBreakdown]);

  const totalAutomationCost = useMemo(
    () => automationTypeBreakdown.reduce((sum, a) => sum + a.cost, 0),
    [automationTypeBreakdown],
  );

  const cacheEfficiencyPercent = useMemo(() => {
    const totalBase =
      (costSummary?.totalInputTokens ?? 0) + (costSummary?.totalCacheCreationTokens ?? 0);
    const cacheRead = costSummary?.totalCacheReadTokens ?? 0;
    if (totalBase === 0 || cacheRead === 0) return null;
    return Math.round((cacheRead / totalBase) * 100);
  }, [
    costSummary?.totalInputTokens,
    costSummary?.totalCacheReadTokens,
    costSummary?.totalCacheCreationTokens,
  ]);

  const trackingSinceDate = useMemo(() => {
    if (!costSummary?.oldestEntry) return null;
    return new Date(costSummary.oldestEntry).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }, [costSummary?.oldestEntry]);

  const handleExport = useCallback(() => {
    if (!dailyBreakdown || dailyBreakdown.length === 0) return;
    const csv = exportLedgerDailyToCsv(dailyBreakdown);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const periodSuffix =
      timePeriod === 'all'
        ? 'all-time'
        : timePeriod === 'day'
          ? 'last-24h'
          : `last-${PERIOD_DAYS[timePeriod]}-days`;
    a.download = `rebel-usage-${periodSuffix}-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [dailyBreakdown, timePeriod]);

  const hasUsage = (costSummary?.entryCount ?? 0) > 0 && (costSummary?.totalCostUsd ?? 0) > 0;
  const showDetails = !loading && !loadError && hasUsage;

  // Visible degraded indicator for a Tier-1 accordion whose data failed to load —
  // shows on the collapsed header so degradation isn't hidden behind the chevron.
  const degradedBadge = (
    <Badge variant="warning" size="sm">
      Couldn&apos;t load
    </Badge>
  );

  // Trend sentence for "Day by day".
  const trendSentence = useMemo(() => {
    if (!insights || timePeriod === 'all') return null;
    const pc = insights.comparison.percentChange;
    if (pc == null) return null;
    if (pc > 0) return `Spending is up ${pc}% versus the previous period.`;
    if (pc < 0) return `Spending is down ${Math.abs(pc)}% versus the previous period.`;
    return 'Spending is flat versus the previous period.';
  }, [insights, timePeriod]);

  return (
    <>
      <SettingSection title="">
        <SpendQualitySummary
          period={timePeriod}
          onPeriodChange={setTimePeriod}
          loading={loading}
          error={loadError}
          totalCostUsd={costSummary?.totalCostUsd ?? 0}
          entryCount={costSummary?.entryCount ?? 0}
          turnCount={costSummary?.turnCount ?? 0}
          categoryTotals={categoryTotals}
          waterfall={costWaterfall}
          savings={heroSavings}
          byCategoryRaw={costSummary?.byCategoryRaw ?? {}}
          automationTypeBreakdown={automationTypeBreakdown}
          totalInputTokens={costSummary?.totalInputTokens ?? 0}
          firstUse={!hasAnyLedgerEntries}
        />

        {trackingSinceDate && timePeriod === 'all' && !loadError && !loading && (
          <div className={styles.usageFooter}>
            <span className={styles.usageFooterMeta}>Tracking since {trackingSinceDate}</span>
          </div>
        )}
      </SettingSection>

      {showDetails && (
        <>
          {/* Tier 1 — Where it went, in detail */}
          {/* Glance-data-backed (model / payment / automation come from the cost summary),
              so this section can't fail independently of the page — no degraded state. */}
          <SettingSection
            advanced
            title="Where it went, in detail"
            data-testid="usage-detail-section"
          >
            {modelBreakdown.length >= 2 && (
              <div className={styles.usageDetailsSection}>
                <Tooltip content="Cost attributed to each model. Multi-model turns are split across the models that ran.">
                  <h4 className={styles.usageTableTitle}>By model</h4>
                </Tooltip>
                <div className={styles.usageSubCategoryList}>
                  {modelBreakdown.map(([model, cost]) => {
                    const percent = totalModelCost > 0 ? (cost / totalModelCost) * 100 : 0;
                    return (
                      <div key={model} className={styles.usageSubCategoryRow}>
                        <span className={styles.usageSubCategoryLabel} title={model}>
                          {model}
                        </span>
                        <div
                          className={styles.usageCategoryBarTrack}
                          role="presentation"
                          aria-hidden="true"
                        >
                          <div
                            className={styles.usageCategoryBar}
                            style={{ width: `${Math.max(percent, 2)}%` }}
                          />
                        </div>
                        <span className={styles.usageSubCategoryCost}>
                          {formatCostCompact(cost)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {authBreakdown.length >= 2 && (
              <div className={styles.usageDetailsSection}>
                <Tooltip content="Where each turn ran and how it was paid for. Covered = absorbed by a subscription, not billed to you.">
                  <h4 className={styles.usageTableTitle}>By provider &amp; plan</h4>
                </Tooltip>
                {(() => {
                  const renderAuthRow = ([auth, cost]: [string, number], hideBadge: boolean) => {
                    const percent = totalAuthCost > 0 ? (cost / totalAuthCost) * 100 : 0;
                    const meta = AUTH_METHOD_DISPLAY[auth];
                    const label = meta?.label ?? auth;
                    const isSubscription = meta?.isSubscription ?? false;
                    return (
                      <Tooltip key={auth} content={meta?.description ?? auth}>
                        <div className={styles.usageSubCategoryRow}>
                          <span className={styles.usageSubCategoryLabel} title={label}>
                            {label}
                            {isSubscription && !hideBadge && (
                              <span className={styles.usageAuthSubscriptionBadge}>covered</span>
                            )}
                          </span>
                          <div
                            className={styles.usageCategoryBarTrack}
                            role="presentation"
                            aria-hidden="true"
                          >
                            <div
                              className={
                                isSubscription
                                  ? styles.usageCategoryBarSubscription
                                  : styles.usageCategoryBar
                              }
                              style={{ width: `${Math.max(percent, 2)}%` }}
                            />
                          </div>
                          <span className={styles.usageSubCategoryCost}>
                            {formatCostCompact(cost)}
                          </span>
                        </div>
                      </Tooltip>
                    );
                  };
                  return (
                    <>
                      {authGroups.paid.length > 0 && (
                        <div className={styles.usageSubCategoryList}>
                          <p className={styles.usageSubGroupLabel}>Out of pocket</p>
                          {authGroups.paid.map((row) => renderAuthRow(row, false))}
                        </div>
                      )}
                      {authGroups.covered.length > 0 && (
                        <div className={styles.usageSubCategoryList}>
                          <p className={styles.usageSubGroupLabel}>Covered by a subscription</p>
                          {/* Group header already says "covered" — drop the per-row badge here. */}
                          {authGroups.covered.map((row) => renderAuthRow(row, true))}
                        </div>
                      )}
                      {authGroups.unclassified.map((row) => renderAuthRow(row, false))}
                    </>
                  );
                })()}
              </div>
            )}

            {automationTypeBreakdown.length >= 2 && (
              <div className={styles.usageDetailsSection}>
                <Tooltip content="Cost per scheduled automation. Manage or pause these in the Automations tab.">
                  <h4 className={styles.usageTableTitle}>By automation</h4>
                </Tooltip>
                <div className={styles.usageSubCategoryList}>
                  {automationTypeBreakdown.map((a) => {
                    const percent =
                      totalAutomationCost > 0 ? (a.cost / totalAutomationCost) * 100 : 0;
                    return (
                      <div key={a.type} className={styles.usageSubCategoryRow}>
                        <span className={styles.usageSubCategoryLabel} title={a.label}>
                          {a.label}
                        </span>
                        <div
                          className={styles.usageCategoryBarTrack}
                          role="presentation"
                          aria-hidden="true"
                        >
                          <div
                            className={styles.usageCategoryBar}
                            style={{ width: `${Math.max(percent, 2)}%` }}
                          />
                        </div>
                        <span className={styles.usageSubCategoryCost}>
                          {formatCostCompact(a.cost)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {modelBreakdown.length < 2 &&
              authBreakdown.length < 2 &&
              automationTypeBreakdown.length < 2 && (
                <p className={styles.usageFooterMeta}>
                  Not enough variety to break down further for this period.
                </p>
              )}
          </SettingSection>

          {/* Tier 1 — The Records (insights-backed; render on insightsError with a
              visible header badge + Notice so degradation isn't hidden behind collapse). */}
          {(insightsError || insights?.topSession || insights?.topTurn) && (
            <SettingSection
              advanced
              title="The Records"
              data-testid="usage-records-section"
              badge={insightsError ? degradedBadge : undefined}
            >
              {insightsError && (
                <Notice tone="warning" density="compact">
                  Couldn&apos;t load your records. The glance above is still accurate.
                </Notice>
              )}
              {insights && (
              <div className={styles.usageRecordsList}>
                {insights.topSession && (
                  <div
                    className={`${styles.usageRecordItem} ${styles.usageRecordClickable}`}
                    onClick={() => {
                      if (insights.topSession)
                        navigate({ type: 'sessions', sessionId: insights.topSession.sessionId });
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && insights.topSession) {
                        e.preventDefault();
                        navigate({ type: 'sessions', sessionId: insights.topSession.sessionId });
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open conversation: ${insights.topSession.title ?? 'most expensive conversation'}`}
                    data-testid="usage-record-top-session"
                  >
                    <div className={styles.usageRecordIcon}>
                      <Trophy size={16} />
                    </div>
                    <div className={styles.usageRecordContent}>
                      <div className={styles.usageRecordHeader}>
                        <span className={styles.usageRecordLabel}>
                          Most expensive conversation
                          <ExternalLink size={12} className={styles.usageRecordLinkIcon} />
                        </span>
                        <span className={styles.usageRecordCost}>
                          {formatCostCompact(insights.topSession.cost)}
                        </span>
                      </div>
                      <div className={styles.usageRecordDetail}>
                        {insights.topSession.title ? (
                          <span className={styles.usageRecordTitle}>
                            &ldquo;{insights.topSession.title}&rdquo;
                          </span>
                        ) : (
                          <span className={styles.usageRecordMuted}>
                            A conversation from {formatShortDate(insights.topSession.timestamp)}
                          </span>
                        )}
                      </div>
                      <p className={styles.usageRecordQuip}>Your magnum opus. Well-spent, one hopes.</p>
                    </div>
                  </div>
                )}
                {insights.topTurn && (() => {
                  // Click through to the conversation containing the priciest turn,
                  // when we know which session it belongs to (matches topSession).
                  const turn = insights.topTurn;
                  const turnSessionId = turn.sessionId;
                  const openTurn = turnSessionId
                    ? () => navigate({ type: 'sessions', sessionId: turnSessionId })
                    : undefined;
                  return (
                    <div
                      className={`${styles.usageRecordItem} ${openTurn ? styles.usageRecordClickable : ''}`}
                      data-testid="usage-record-top-turn"
                      onClick={openTurn}
                      onKeyDown={
                        openTurn
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                openTurn();
                              }
                            }
                          : undefined
                      }
                      role={openTurn ? 'button' : undefined}
                      tabIndex={openTurn ? 0 : undefined}
                      aria-label={
                        openTurn
                          ? `Open the conversation with the costliest turn${turn.sessionTitle ? `: ${turn.sessionTitle}` : ''}`
                          : undefined
                      }
                    >
                      <div className={styles.usageRecordIcon}>
                        <Zap size={16} />
                      </div>
                      <div className={styles.usageRecordContent}>
                        <div className={styles.usageRecordHeader}>
                          <span className={styles.usageRecordLabel}>
                            Costliest single turn
                            {openTurn && (
                              <ExternalLink size={12} className={styles.usageRecordLinkIcon} />
                            )}
                          </span>
                          <span className={styles.usageRecordCost}>
                            {formatCostCompact(turn.cost)}
                          </span>
                        </div>
                        <div className={styles.usageRecordDetail}>
                          <span className={styles.usageRecordMuted}>
                            {formatShortDate(turn.timestamp)}
                            {turn.sessionTitle && <> in &ldquo;{turn.sessionTitle}&rdquo;</>}
                          </span>
                        </div>
                        <p className={styles.usageRecordQuip}>
                          The priciest single exchange — usually a long document or a big tool result.
                        </p>
                      </div>
                    </div>
                  );
                })()}
              </div>
              )}
            </SettingSection>
          )}

          {/* Tier 1 — Day by day (table is daily-backed; trend/peak are insights-backed). */}
          <SettingSection
            advanced
            title="Day by day"
            data-testid="usage-daily-section"
            badge={dailyError ? degradedBadge : undefined}
          >
            {dailyError && (
              <Notice tone="warning" density="compact">
                Couldn&apos;t load the daily breakdown. The glance above is still accurate.
              </Notice>
            )}

            {trendSentence && <p className={styles.usageHeroSplit}>{trendSentence}</p>}

            {insights?.peakDay && timePeriod !== 'day' && (
              <p className={styles.usageFooterMeta}>
                Peak day: {formatShortDate(insights.peakDay.date)} (
                {formatCostCompact(insights.peakDay.cost)}).
              </p>
            )}

            {dailyBreakdown && dailyBreakdown.length > 0 ? (
              <>
                <div className={styles.usageTableWrapper}>
                  <table className={styles.usageTable}>
                    <thead>
                      <tr>
                        <th>
                          <Tooltip content="Days are counted in UTC, so a day near midnight may land on the next date.">
                            <span>Date</span>
                          </Tooltip>
                        </th>
                        <th>Cost</th>
                        <th>Turns</th>
                        <th>Input tokens</th>
                        <th>Output tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dailyBreakdown.slice(0, 14).map((day) => {
                        const isPeakDay =
                          timePeriod !== 'day' && insights?.peakDay?.date === day.date;
                        return (
                          <tr
                            key={day.date}
                            className={isPeakDay ? styles.usageTablePeakRow : undefined}
                          >
                            <td>
                              {day.date}
                              {isPeakDay && <span className={styles.usageTablePeakTag}> peak</span>}
                            </td>
                            <td>{formatCostCompact(day.cost)}</td>
                            <td>{day.turns}</td>
                            <td>{formatTokenCount(day.inTok)}</td>
                            <td>{formatTokenCount(day.outTok)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className={styles.usageFooter}>
                  <Button variant="ghost" onClick={handleExport} data-testid="usage-export-csv">
                    Export to CSV
                  </Button>
                </div>
              </>
            ) : (
              !dailyError && (
                <p className={styles.usageFooterMeta}>No daily data for this period.</p>
              )
            )}
          </SettingSection>

          {/* Tier 1 — Efficiency (insights-backed; render on insightsError with badge + Notice). */}
          {(insightsError || (insights && (costSummary?.turnCount ?? 0) > 0)) && (
            <SettingSection
              advanced
              title="Efficiency"
              data-testid="usage-efficiency-section"
              badge={insightsError ? degradedBadge : undefined}
            >
              {insightsError && (
                <Notice tone="warning" density="compact">
                  Couldn&apos;t load efficiency stats. The glance above is still accurate.
                </Notice>
              )}
              {insights && (
              <div className={styles.usageStatsStrip}>
                {insights.projectedMonthCost != null &&
                  timePeriod !== 'all' &&
                  insights.projectionBasis && (
                    <Tooltip
                      content={`${formatCostCompact(insights.comparison.currentPeriodCost)} ÷ ${insights.projectionBasis.effectiveDays} days × 30 ≈ $${insights.projectedMonthCost.toFixed(0)}/mo.`}
                    >
                      <div className={styles.usageStatItem}>
                        <span className={styles.usageStatValue}>
                          ~${insights.projectedMonthCost.toFixed(0)}
                        </span>
                        <span className={styles.usageStatLabel}>projected / mo</span>
                      </div>
                    </Tooltip>
                  )}
                {insights.avgCostPerTurn != null && (
                  <Tooltip content="Average cost per conversation turn across this period.">
                    <div className={styles.usageStatItem}>
                      <span className={styles.usageStatValue}>
                        {formatCostCompact(insights.avgCostPerTurn)}
                      </span>
                      <span className={styles.usageStatLabel}>per turn</span>
                    </div>
                  </Tooltip>
                )}
                {insights.avgCostPerActiveDay != null && timePeriod !== 'day' && (
                  <Tooltip
                    content={`Average daily cost on days you used Rebel (${insights.activeDayCount} active ${insights.activeDayCount === 1 ? 'day' : 'days'}).`}
                  >
                    <div className={styles.usageStatItem}>
                      <span className={styles.usageStatValue}>
                        {formatCostCompact(insights.avgCostPerActiveDay)}
                      </span>
                      <span className={styles.usageStatLabel}>avg / active day</span>
                    </div>
                  </Tooltip>
                )}
                {insights.peakDay && timePeriod !== 'day' && (
                  <Tooltip content="Your highest-spending day in this period.">
                    <div className={styles.usageStatItem}>
                      <span className={styles.usageStatValue}>
                        {formatShortDate(insights.peakDay.date)}
                      </span>
                      <span className={styles.usageStatLabel}>
                        peak day ({formatCostCompact(insights.peakDay.cost)})
                      </span>
                    </div>
                  </Tooltip>
                )}
                {cacheEfficiencyPercent != null && (
                  <Tooltip content="Prompt cache hit ratio: cache_read ÷ (input + cache_creation). Higher means more tokens served from cache at a discount.">
                    <div className={styles.usageStatItem}>
                      <span className={styles.usageStatValue}>{cacheEfficiencyPercent}%</span>
                      <span className={styles.usageStatLabel}>cache hit ratio</span>
                    </div>
                  </Tooltip>
                )}
              </div>
              )}
            </SettingSection>
          )}
        </>
      )}
    </>
  );
};
