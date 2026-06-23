import { Fragment, useMemo, useState } from 'react';
import { Badge, Tooltip } from '@renderer/components/ui';
import type { AgentEvent } from '@shared/types';
import { extractTurnUsage, getCacheEfficiencyPercent } from '@shared/utils/usageAggregator';
import { formatCostCompact, formatTokenCount } from '@shared/utils/usageFormatters';
import type { InsightTurnSummary } from '../../work-surface/types';
import styles from './CostTab.module.css';

type CostTabProps = {
  eventsByTurn: Record<string, AgentEvent[]>;
  turnSummaries: InsightTurnSummary[];
};

type TurnCostRow = {
  turnId: string;
  turnNumber: number;
  hasUsage: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  costUsd: number | null;
  modelUsageRows: ModelUsageRow[];
};

type CumulativePoint = {
  turnId: string;
  turnNumber: number;
  cumulativeCostUsd: number;
};

type CostTotals = {
  hasAnyUsage: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
};

type DerivedCostData = {
  turnRows: TurnCostRow[];
  averageTurnCost: number;
  maxTurnCost: number;
  costliestTurnId: string | null;
  cumulativePoints: CumulativePoint[];
  maxCumulativeCost: number;
  totals: CostTotals;
  cacheEfficiencyPercent: number | null;
};

type ModelUsageRow = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
};

const formatTokenMaybe = (tokens: number | null): string =>
  tokens == null ? '—' : formatTokenCount(tokens);

const formatDollarValue = (costUsd: number): string => `$${costUsd.toFixed(2)}`;

const formatCostMaybe = (costUsd: number | null): string =>
  costUsd == null ? '—' : formatCostCompact(costUsd);

const formatTotalToken = (hasAnyUsage: boolean, tokenTotal: number): string =>
  hasAnyUsage ? formatTokenCount(tokenTotal) : '—';

const isExpensiveTurn = (turnCost: number, averageTurnCost: number): boolean =>
  averageTurnCost > 0 && turnCost > averageTurnCost * 2;

const extractTurnModelUsageRows = (events: AgentEvent[]): ModelUsageRow[] => {
  const resultEvent = events.find(
    (event): event is Extract<AgentEvent, { type: 'result' }> => event.type === 'result'
  );

  if (!resultEvent?.modelUsage) {
    return [];
  }

  const modelUsageRows = Object.entries(resultEvent.modelUsage)
    .map(([model, usage]) => ({
      model,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      costUsd: usage.costUsd ?? null
    }))
    .sort((left, right) => {
      const leftCost = left.costUsd ?? -1;
      const rightCost = right.costUsd ?? -1;

      if (leftCost !== rightCost) {
        return rightCost - leftCost;
      }

      const leftTotalTokens = left.inputTokens + left.outputTokens;
      const rightTotalTokens = right.inputTokens + right.outputTokens;

      if (leftTotalTokens !== rightTotalTokens) {
        return rightTotalTokens - leftTotalTokens;
      }

      return left.model.localeCompare(right.model);
    });

  return modelUsageRows.length >= 2 ? modelUsageRows : [];
};

type ModelBreakdownProps = {
  modelUsageRows: ModelUsageRow[];
  label: string;
  compact?: boolean;
};

const ModelBreakdown = ({ modelUsageRows, label, compact = false }: ModelBreakdownProps) => (
  <div
    className={`${styles.modelBreakdownList} ${compact ? styles.modelBreakdownListCompact : ''}`}
    role="group"
    aria-label={label}
  >
    <div className={`${styles.modelBreakdownRow} ${styles.modelBreakdownHeader}`} aria-hidden="true">
      <span className={styles.modelBreakdownHeaderLabel}>Model</span>
      <span className={styles.modelBreakdownHeaderLabel}>Input</span>
      <span className={styles.modelBreakdownHeaderLabel}>Output</span>
      <span className={styles.modelBreakdownHeaderLabel}>Cost</span>
    </div>
    {modelUsageRows.map((modelUsageRow) => (
      <div key={modelUsageRow.model} className={styles.modelBreakdownRow}>
        <span className={styles.modelBreakdownModel} title={modelUsageRow.model}>
          {modelUsageRow.model}
        </span>
        <span className={styles.modelBreakdownMetric}>
          {formatTokenCount(modelUsageRow.inputTokens)}
        </span>
        <span className={styles.modelBreakdownMetric}>
          {formatTokenCount(modelUsageRow.outputTokens)}
        </span>
        <span className={styles.modelBreakdownCost}>{formatCostMaybe(modelUsageRow.costUsd)}</span>
      </div>
    ))}
  </div>
);

export const CostTab = ({ eventsByTurn, turnSummaries }: CostTabProps) => {
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);

  const derived = useMemo<DerivedCostData>(() => {
    const turnRows: TurnCostRow[] = turnSummaries.map((summary, index) => {
      const turnEvents = eventsByTurn[summary.turnId] ?? [];
      const usage = extractTurnUsage(summary.turnId, turnEvents);
      const modelUsageRows = extractTurnModelUsageRows(turnEvents);

      return {
        turnId: summary.turnId,
        turnNumber: index + 1,
        hasUsage: usage !== null,
        inputTokens: usage ? usage.inputTokens : null,
        outputTokens: usage ? usage.outputTokens : null,
        cacheCreationTokens: usage ? usage.cacheCreationTokens : null,
        cacheReadTokens: usage ? usage.cacheReadTokens : null,
        costUsd: usage ? usage.costUsd : null,
        modelUsageRows
      };
    });

    const totals: CostTotals = {
      hasAnyUsage: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0
    };

    let positiveCostSum = 0;
    let positiveCostCount = 0;
    let maxTurnCost = 0;
    let costliestTurnId: string | null = null;
    let hasAnyCacheValue = false;
    let cumulativeCost = 0;

    const cumulativePoints: CumulativePoint[] = [];

    for (const row of turnRows) {
      const turnCost = row.costUsd ?? 0;

      if (turnCost > maxTurnCost) {
        maxTurnCost = turnCost;
        costliestTurnId = row.turnId;
      }

      if (turnCost > 0) {
        positiveCostSum += turnCost;
        positiveCostCount += 1;
      }

      if (row.hasUsage) {
        totals.hasAnyUsage = true;
        totals.inputTokens += row.inputTokens ?? 0;
        totals.outputTokens += row.outputTokens ?? 0;
        totals.cacheCreationTokens += row.cacheCreationTokens ?? 0;
        totals.cacheReadTokens += row.cacheReadTokens ?? 0;
        totals.costUsd += turnCost;

        if ((row.cacheCreationTokens ?? 0) > 0 || (row.cacheReadTokens ?? 0) > 0) {
          hasAnyCacheValue = true;
        }
      }

      cumulativeCost += turnCost;
      cumulativePoints.push({
        turnId: row.turnId,
        turnNumber: row.turnNumber,
        cumulativeCostUsd: cumulativeCost
      });
    }

    const averageTurnCost = positiveCostCount > 0 ? positiveCostSum / positiveCostCount : 0;
    const maxCumulativeCost =
      cumulativePoints[cumulativePoints.length - 1]?.cumulativeCostUsd ?? 0;

    const cacheEfficiencyPercent =
      totals.hasAnyUsage && hasAnyCacheValue
        ? getCacheEfficiencyPercent({
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheCreationTokens: totals.cacheCreationTokens,
            cacheReadTokens: totals.cacheReadTokens,
            costUsd: totals.costUsd,
            turnCount: turnRows.length
          })
        : null;

    return {
      turnRows,
      averageTurnCost,
      maxTurnCost,
      costliestTurnId,
      cumulativePoints,
      maxCumulativeCost,
      totals,
      cacheEfficiencyPercent
    };
  }, [eventsByTurn, turnSummaries]);

  const selectedTurn = useMemo(
    () =>
      selectedTurnId == null
        ? null
        : derived.turnRows.find((row) => row.turnId === selectedTurnId) ?? null,
    [derived.turnRows, selectedTurnId]
  );

  return (
    <div className={styles.costTab} role="region" aria-label="Cost diagnostics">
      <section className={styles.section} aria-labelledby="cost-per-turn">
        <h3 id="cost-per-turn" className={styles.sectionHeading}>
          Per-turn cost
        </h3>

        {derived.turnRows.length === 0 ? (
          <div className={styles.emptyState}>No cost data yet — usage appears after the first turn</div>
        ) : (
          <>
            <div className={styles.barList}>
              {derived.turnRows.map((row) => {
                const turnCost = row.costUsd ?? 0;
                const barWidthPercent =
                  derived.maxTurnCost > 0 ? (turnCost / derived.maxTurnCost) * 100 : 0;
                const expensiveTurn = isExpensiveTurn(turnCost, derived.averageTurnCost);
                const selectedTurnRow = selectedTurnId === row.turnId;
                const costliestTurn = derived.costliestTurnId === row.turnId && turnCost > 0;
                const tokenSummary = `${formatTokenMaybe(row.inputTokens)} in, ${formatTokenMaybe(
                  row.outputTokens
                )} out`;
                const costLabel = formatCostCompact(row.costUsd);

                return (
                  <Tooltip
                    key={row.turnId}
                    content="Cost from result.usage.costUsd"
                    placement="top"
                  >
                    <button
                      type="button"
                      className={`${styles.barRowButton} ${
                        selectedTurnRow ? styles.barRowButtonSelected : ''
                      }`}
                      onClick={() => setSelectedTurnId(row.turnId)}
                      aria-label={`Turn ${row.turnNumber}: ${costLabel}. ${tokenSummary}.`}
                      aria-pressed={selectedTurnRow}
                    >
                      <span className={styles.turnLabel}>Turn {row.turnNumber}</span>
                      <div
                        style={{
                          flex: 1,
                          minWidth: '120px',
                          height: '16px',
                          borderRadius: '6px',
                          border: '1px solid var(--cost-bar-border)',
                          background: 'var(--cost-bar-track)',
                          overflow: 'hidden'
                        }}
                        aria-hidden
                      >
                        <div
                          style={{
                            width: `${barWidthPercent}%`,
                            height: '100%',
                            borderRadius: '6px',
                            transition: 'width 0.24s ease',
                            background: expensiveTurn
                              ? 'var(--cost-bar-expensive)'
                              : costliestTurn
                                ? 'var(--cost-bar-costliest)'
                                : 'var(--cost-bar-normal)'
                          }}
                        />
                      </div>
                      <span className={styles.costLabel}>{costLabel}</span>
                      <span className={styles.tokenSummary}>({tokenSummary})</span>
                      <span className={styles.badgeCluster}>
                        {costliestTurn && (
                          <Badge variant="muted" size="sm">
                            Costliest
                          </Badge>
                        )}
                        {expensiveTurn && (
                          <Badge variant="outline" size="sm" className={styles.expensiveBadge}>
                            Expensive
                          </Badge>
                        )}
                      </span>
                    </button>
                  </Tooltip>
                );
              })}
            </div>

            {selectedTurn ? (
              <div className={styles.selectionCard} role="status" aria-live="polite">
                <p className={styles.selectionTitle}>Turn {selectedTurn.turnNumber} token detail</p>
                <div className={styles.selectionGrid}>
                  <div className={styles.selectionItem}>
                    <span className={styles.selectionLabel}>Input</span>
                    <span className={styles.selectionValue}>
                      {formatTokenMaybe(selectedTurn.inputTokens)}
                    </span>
                  </div>
                  <div className={styles.selectionItem}>
                    <span className={styles.selectionLabel}>Output</span>
                    <span className={styles.selectionValue}>
                      {formatTokenMaybe(selectedTurn.outputTokens)}
                    </span>
                  </div>
                  <div className={styles.selectionItem}>
                    <span className={styles.selectionLabel}>Cache write</span>
                    <span className={styles.selectionValue}>
                      {formatTokenMaybe(selectedTurn.cacheCreationTokens)}
                    </span>
                  </div>
                  <div className={styles.selectionItem}>
                    <span className={styles.selectionLabel}>Cache read</span>
                    <span className={styles.selectionValue}>
                      {formatTokenMaybe(selectedTurn.cacheReadTokens)}
                    </span>
                  </div>
                  <div className={styles.selectionItem}>
                    <span className={styles.selectionLabel}>Cost</span>
                    <span className={styles.selectionValue}>
                      {formatCostCompact(selectedTurn.costUsd)}
                    </span>
                  </div>
                </div>
                {selectedTurn.modelUsageRows.length >= 2 && (
                  <div className={styles.modelBreakdownSection}>
                    <p className={styles.modelBreakdownTitle}>By model</p>
                    <ModelBreakdown
                      modelUsageRows={selectedTurn.modelUsageRows}
                      label={`Turn ${selectedTurn.turnNumber} model breakdown`}
                    />
                  </div>
                )}
              </div>
            ) : (
              <p className={styles.selectionHint}>Click a bar to inspect token detail for that turn.</p>
            )}
          </>
        )}
      </section>

      <section className={styles.section} aria-labelledby="cost-token-breakdown">
        <h3 id="cost-token-breakdown" className={styles.sectionHeading}>
          Token breakdown
        </h3>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Turn</th>
                <th scope="col">Input</th>
                <th scope="col">Output</th>
                <th scope="col">Cache W</th>
                <th scope="col">Cache R</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {derived.turnRows.map((row) => (
                <Fragment key={row.turnId}>
                  <tr>
                    <th scope="row">Turn {row.turnNumber}</th>
                    <td>{formatTokenMaybe(row.inputTokens)}</td>
                    <td>{formatTokenMaybe(row.outputTokens)}</td>
                    <td>{formatTokenMaybe(row.cacheCreationTokens)}</td>
                    <td>{formatTokenMaybe(row.cacheReadTokens)}</td>
                    <td>{formatCostCompact(row.costUsd)}</td>
                  </tr>
                  {row.modelUsageRows.length >= 2 && (
                    <tr className={styles.modelBreakdownTableRow}>
                      <td colSpan={6}>
                        <div className={styles.modelBreakdownTableCell}>
                          <p className={styles.modelBreakdownTableLabel}>By model</p>
                          <ModelBreakdown
                            modelUsageRows={row.modelUsageRows}
                            label={`Turn ${row.turnNumber} token usage by model`}
                            compact
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr className={styles.totalsRow}>
                <th scope="row">Total</th>
                <td>{formatTotalToken(derived.totals.hasAnyUsage, derived.totals.inputTokens)}</td>
                <td>{formatTotalToken(derived.totals.hasAnyUsage, derived.totals.outputTokens)}</td>
                <td>
                  {formatTotalToken(derived.totals.hasAnyUsage, derived.totals.cacheCreationTokens)}
                </td>
                <td>{formatTotalToken(derived.totals.hasAnyUsage, derived.totals.cacheReadTokens)}</td>
                <td>
                  {derived.totals.hasAnyUsage ? formatCostCompact(derived.totals.costUsd) : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="cost-cumulative">
        <h3 id="cost-cumulative" className={styles.sectionHeading}>
          Cumulative cost
        </h3>
        <div className={styles.sparklineWrap}>
          <div className={styles.sparkline} role="list" aria-label="Cumulative session cost by turn">
            {derived.cumulativePoints.map((point) => {
              const height =
                derived.maxCumulativeCost > 0
                  ? Math.max(8, (point.cumulativeCostUsd / derived.maxCumulativeCost) * 42)
                  : 8;
              const hoverLabel = `After turn ${point.turnNumber}: ${formatDollarValue(
                point.cumulativeCostUsd
              )}`;

              return (
                <Tooltip key={point.turnId} content={hoverLabel} placement="top">
                  <span
                    className={styles.sparkPoint}
                    style={{ height: `${height}px` }}
                    role="listitem"
                    aria-label={hoverLabel}
                  />
                </Tooltip>
              );
            })}
          </div>
          <p className={styles.sparklineSummary}>
            Total: {formatCostCompact(derived.cumulativePoints[derived.cumulativePoints.length - 1]?.cumulativeCostUsd ?? 0)}
          </p>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="cost-cache-efficiency">
        <h3 id="cost-cache-efficiency" className={styles.sectionHeading}>
          Cache efficiency
        </h3>
        <div className={styles.cacheCard}>
          <span className={styles.cacheHeadingRow}>
            <span className={styles.cacheHeading}>Session cache utilization</span>
            <Tooltip
              content="Formula: cache_read / (input + cache_creation) × 100"
              placement="top"
            >
              <span className={styles.infoDot} aria-hidden>
                ⓘ
              </span>
            </Tooltip>
          </span>
          <p className={styles.cacheValue}>
            Cache efficiency:{' '}
            {derived.cacheEfficiencyPercent == null ? 'Not available' : `${derived.cacheEfficiencyPercent}%`}
          </p>
          <p className={styles.cacheSubtext}>
            Cache read/write totals: {formatTotalToken(derived.totals.hasAnyUsage, derived.totals.cacheReadTokens)} /{' '}
            {formatTotalToken(derived.totals.hasAnyUsage, derived.totals.cacheCreationTokens)}
          </p>
        </div>
      </section>
    </div>
  );
};
