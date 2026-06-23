import { useMemo } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Clock,
  Cpu,
  DollarSign,
  Layers,
  RefreshCw,
  TrendingUp,
  Wrench,
  Zap
} from 'lucide-react';
import { Badge, Tooltip } from '@renderer/components/ui';
import { formatDurationShort } from '@renderer/utils/formatters';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import { formatCostCompact } from '@shared/utils/usageFormatters';
import type { InsightTurnSummary } from '../../work-surface/types';
import {
  buildSessionSummary,
  describeContextTrend,
  type SessionSummary
} from '../utils/buildSessionSummary';
import styles from './SummaryTab.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type SummaryTabProps = {
  eventsByTurn: Record<string, AgentEvent[]>;
  turnSummaries: InsightTurnSummary[];
  messages: AgentTurnMessage[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const formatMinutes = (ms: number): string => {
  if (ms <= 0) return '0 s';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.round(ms / 60_000);
  return `${minutes} min`;
};

const isHighlightedRow = (
  digest: SessionSummary['turnDigests'][number],
  averageCost: number
): boolean => digest.hasErrors || (averageCost > 0 && digest.costUsd > averageCost * 2);

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

const OverviewSection = ({ summary }: { summary: SessionSummary }) => {
  const { turnCount, totalDurationMs, totalCostUsd } = summary.overview;

  if (turnCount === 0) {
    return (
      <section className={styles.section} aria-labelledby="summary-overview">
        <h3 id="summary-overview" className={styles.sectionHeading}>
          Overview
        </h3>
        <div className={styles.emptyState}>Nothing to summarize yet</div>
      </section>
    );
  }

  const turnLabel = turnCount === 1 ? '1 turn' : `${turnCount} turns`;
  const costLabel = formatCostCompact(totalCostUsd);

  return (
    <section className={styles.section} aria-labelledby="summary-overview">
      <h3 id="summary-overview" className={styles.sectionHeading}>
        Overview
      </h3>
      <div className={styles.overviewCard}>
        <Tooltip content="Cost from aggregated result event usage.costUsd" placement="top">
          <p className={styles.overviewText}>
            {turnLabel} over {formatMinutes(totalDurationMs)}. Total cost: {costLabel}
          </p>
        </Tooltip>
      </div>
    </section>
  );
};

const TurnDigestsSection = ({ summary }: { summary: SessionSummary }) => {
  const { turnDigests } = summary;
  if (turnDigests.length === 0) return null;

  const averageCost =
    turnDigests.length > 0
      ? turnDigests.reduce((sum, d) => sum + d.costUsd, 0) / turnDigests.length
      : 0;

  return (
    <section className={styles.section} aria-labelledby="summary-turns">
      <h3 id="summary-turns" className={styles.sectionHeading}>
        Turn-by-turn digest
      </h3>
      <div className={styles.digestList} role="list">
        {turnDigests.map((digest) => {
          const highlighted = isHighlightedRow(digest, averageCost);
          const rowClass = [styles.digestRow, highlighted ? styles.digestRowHighlight : '']
            .filter(Boolean)
            .join(' ');

          return (
            <div key={digest.turnId} className={rowClass} role="listitem">
              <span className={styles.digestTurnNumber} aria-label={`Turn ${digest.turnNumber}`}>
                {digest.turnNumber}
              </span>

              <span className={styles.digestSnippet} title={digest.userMessageSnippet}>
                {digest.userMessageSnippet}
              </span>

              <div className={styles.digestMeta}>
                <Tooltip content="Duration derived from turn start/end timestamps" placement="top">
                  <span className={styles.digestMetaItem}>
                    <Clock size={13} aria-hidden />
                    {formatDurationShort(digest.durationMs)}
                  </span>
                </Tooltip>

                <Tooltip content="Cost from result event usage.costUsd" placement="top">
                  <span className={styles.digestMetaItem}>
                    <DollarSign size={13} aria-hidden />
                    {formatCostCompact(digest.costUsd)}
                  </span>
                </Tooltip>

                {digest.toolCallCount > 0 && (
                  <Tooltip
                    content={`${digest.toolCallCount} tool call${digest.toolCallCount > 1 ? 's' : ''} — from result.toolMetrics or tool start events`}
                    placement="top"
                  >
                    <span className={styles.digestMetaItem}>
                      <Wrench size={13} aria-hidden />
                      {digest.toolCallCount}
                    </span>
                  </Tooltip>
                )}

                {digest.hasErrors && (
                  <Badge variant="destructive" size="sm">
                    {digest.errorCount} error{digest.errorCount > 1 ? 's' : ''}
                  </Badge>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

const KeyFindingsSection = ({ summary }: { summary: SessionSummary }) => {
  const { longestTurn, mostExpensiveTurn, mostToolHeavyTurn, totalErrors, hasFallbacks, hasCompaction } =
    summary.keyFindings;

  const hasFindings =
    longestTurn !== null ||
    mostExpensiveTurn !== null ||
    mostToolHeavyTurn !== null ||
    totalErrors > 0 ||
    hasFallbacks ||
    hasCompaction;

  return (
    <section className={styles.section} aria-labelledby="summary-findings">
      <h3 id="summary-findings" className={styles.sectionHeading}>
        Key findings
      </h3>
      <div className={styles.findingsGrid}>
        {!hasFindings && (
          <div className={`${styles.findingCard} ${styles.findingCardSuccess}`}>
            <CheckCircle size={16} aria-hidden />
            <span>No issues detected ✓</span>
          </div>
        )}

        {longestTurn !== null && (
          <div className={styles.findingCard}>
            <Clock size={16} aria-hidden />
            <span>
              Longest turn: Turn {longestTurn.turnNumber} ({formatDurationShort(longestTurn.durationMs)})
            </span>
          </div>
        )}

        {mostExpensiveTurn !== null && (
          <div className={styles.findingCard}>
            <DollarSign size={16} aria-hidden />
            <span>
              Most expensive turn: Turn {mostExpensiveTurn.turnNumber} (
              {formatCostCompact(mostExpensiveTurn.costUsd)})
            </span>
          </div>
        )}

        {mostToolHeavyTurn !== null && (
          <div className={styles.findingCard}>
            <Wrench size={16} aria-hidden />
            <span>
              Most tool-heavy turn: Turn {mostToolHeavyTurn.turnNumber} (
              {mostToolHeavyTurn.toolCalls} tool call{mostToolHeavyTurn.toolCalls > 1 ? 's' : ''})
            </span>
          </div>
        )}

        {totalErrors > 0 && (
          <div className={`${styles.findingCard} ${styles.findingCardError}`}>
            <AlertCircle size={16} aria-hidden />
            <span>
              {totalErrors} error{totalErrors > 1 ? 's' : ''} detected across the session
            </span>
          </div>
        )}

        {hasFallbacks && (
          <div className={`${styles.findingCard} ${styles.findingCardWarning}`}>
            <RefreshCw size={16} aria-hidden />
            <span>Fallback occurred</span>
          </div>
        )}

        {hasCompaction && (
          <div className={`${styles.findingCard} ${styles.findingCardWarning}`}>
            <Layers size={16} aria-hidden />
            <span>Context compacted during this session</span>
          </div>
        )}
      </div>
    </section>
  );
};

const EfficiencySection = ({ summary }: { summary: SessionSummary }) => {
  const { cacheEfficiencyPercent, contextUtilizationTrend } = summary.efficiency;
  const trendDescription = describeContextTrend(contextUtilizationTrend);

  if (summary.overview.turnCount === 0) return null;

  return (
    <section className={styles.section} aria-labelledby="summary-efficiency">
      <h3 id="summary-efficiency" className={styles.sectionHeading}>
        Efficiency
      </h3>
      <div className={styles.efficiencyRow}>
        <Tooltip
          content="Cache read tokens / (input + cache creation tokens). Higher is better."
          placement="top"
        >
          <div className={styles.efficiencyStat}>
            <Zap size={16} aria-hidden />
            <span className={styles.efficiencyLabel}>Cache efficiency:</span>
            <span className={styles.efficiencyValue}>{cacheEfficiencyPercent}%</span>
          </div>
        </Tooltip>

        <Tooltip
          content="Context utilization from result.usage.contextUtilization per turn"
          placement="top"
        >
          <div className={styles.efficiencyStat}>
            <TrendingUp size={16} aria-hidden />
            <span className={styles.efficiencyLabel}>Context trend:</span>
            <span className={styles.efficiencyValue}>{trendDescription}</span>
          </div>
        </Tooltip>

        {summary.turnDigests.some((d) => d.modelName) && (
          <div className={styles.efficiencyStat}>
            <Cpu size={16} aria-hidden />
            <span className={styles.efficiencyLabel}>Model:</span>
            <span className={styles.efficiencyValue}>
              {(() => {
                const models = new Set(
                  summary.turnDigests.map((d) => d.modelName).filter(Boolean) as string[]
                );
                return models.size === 1 ? Array.from(models)[0] : 'Mixed';
              })()}
            </span>
          </div>
        )}
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const SummaryTab = ({ eventsByTurn, turnSummaries, messages }: SummaryTabProps) => {
  // Memo keyed to eventsByTurn identity alone. Invariant: messages and
  // turnSummaries are downstream of the event flow that bumps
  // eventsByTurnVersion in sessionStore (see store/sessionStore.ts
  // "Invariants" header), so their content is implicitly covered. If you
  // add a path that updates either prop WITHOUT appending an agent event,
  // this deps array must be expanded (e.g. add `messages.length` or
  // `turnSummaries.length`). Stage 6 / 260523 code-health sweep.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- per invariant above
  const summary = useMemo(() => buildSessionSummary(eventsByTurn, messages, turnSummaries), [eventsByTurn]);

  return (
    <div className={styles.summaryTab} role="region" aria-label="Session summary">
      <OverviewSection summary={summary} />
      <TurnDigestsSection summary={summary} />
      <KeyFindingsSection summary={summary} />
      <EfficiencySection summary={summary} />
    </div>
  );
};
