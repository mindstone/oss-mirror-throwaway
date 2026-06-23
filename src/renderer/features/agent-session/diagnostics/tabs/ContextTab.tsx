import { useMemo } from 'react';
import { AlertTriangle, CheckCircle } from 'lucide-react';
import { Badge, Tooltip } from '@renderer/components/ui';
import type { AgentEvent, TurnFallback } from '@shared/types';
import { extractTurnUsage } from '@shared/utils/usageAggregator';
import type { InsightTurnSummary } from '../../work-surface/types';
import styles from './ContextTab.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type ContextTabProps = {
  eventsByTurn: Record<string, AgentEvent[]>;
  turnSummaries: InsightTurnSummary[];
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TurnContextRow = {
  turnId: string;
  turnNumber: number;
  contextUtilization: number | null;
  contextWindow: number | null;
  model: string | null;
  thinkingEffort: string | null;
  authMethod: string | null;
};

type FallbackEntry = {
  turnId: string;
  turnNumber: number;
  fallback: TurnFallback;
};

type DerivedContextData = {
  turnRows: TurnContextRow[];
  fallbacks: FallbackEntry[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getUtilizationColorClass = (percent: number): string => {
  if (percent < 33) return styles.barFillGreen;
  if (percent < 66) return styles.barFillYellow;
  return styles.barFillRed;
};

const getUtilizationLabel = (percent: number): string => {
  if (percent < 33) return 'Low';
  if (percent < 66) return 'Medium';
  return 'High';
};

const formatContextWindow = (tokens: number | null): string => {
  if (tokens == null) return '—';
  if (tokens >= 1_000_000) return '1M';
  return `${Math.round(tokens / 1000)}K`;
};

const deriveContextData = (
  eventsByTurn: Record<string, AgentEvent[]>,
  turnSummaries: InsightTurnSummary[]
): DerivedContextData => {
  const turnRows: TurnContextRow[] = [];
  const fallbacks: FallbackEntry[] = [];

  for (let i = 0; i < turnSummaries.length; i++) {
    const summary = turnSummaries[i];
    const events = eventsByTurn[summary.turnId] ?? [];

    const resultEvent = events.find((e) => e.type === 'result') as
      | Extract<AgentEvent, { type: 'result' }>
      | undefined;

    const usage = extractTurnUsage(summary.turnId, events);

    turnRows.push({
      turnId: summary.turnId,
      turnNumber: i + 1,
      contextUtilization: usage?.contextUtilization ?? resultEvent?.usage?.contextUtilization ?? null,
      contextWindow: usage?.contextWindow ?? resultEvent?.usage?.contextWindow ?? null,
      model: resultEvent?.model ?? null,
      thinkingEffort: resultEvent?.thinkingEffort ?? null,
      authMethod: resultEvent?.authMethod ?? null,
    });

    if (resultEvent?.fallbacks) {
      for (const fb of resultEvent.fallbacks) {
        fallbacks.push({
          turnId: summary.turnId,
          turnNumber: i + 1,
          fallback: fb,
        });
      }
    }
  }

  return { turnRows, fallbacks };
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ContextTab = ({ eventsByTurn, turnSummaries }: ContextTabProps) => {
  // Memo keyed to eventsByTurn identity alone. Invariant: turnSummaries
  // is downstream of the event flow that bumps eventsByTurnVersion in
  // sessionStore (see store/sessionStore.ts "Invariants" header), so its
  // content is implicitly covered. If you add a path that updates
  // turnSummaries WITHOUT appending an agent event, this deps array must
  // be expanded (e.g. add `turnSummaries.length`). Stage 6 / 260523
  // code-health sweep.
  const derived = useMemo(
    () => deriveContextData(eventsByTurn, turnSummaries),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per invariant above
    [eventsByTurn]
  );

  if (derived.turnRows.length === 0) {
    return (
      <div className={styles.contextTab} role="region" aria-label="Context diagnostics">
        <div className={styles.emptyState}>No context data for this conversation yet</div>
      </div>
    );
  }

  return (
    <div className={styles.contextTab} role="region" aria-label="Context diagnostics">
      {/* Section 1: Context utilization bars */}
      <section className={styles.section} aria-labelledby="context-utilization">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <h3 id="context-utilization" className={styles.sectionHeading}>
            Context utilization per turn
          </h3>
          <Tooltip
            content="Context utilization from result.usage.contextUtilization"
            placement="top"
          >
            <span className={styles.infoDot} aria-hidden>ⓘ</span>
          </Tooltip>
        </div>

        <div className={styles.barList}>
          {derived.turnRows.map((row) => {
            const hasUtilization = row.contextUtilization != null;
            const percent = row.contextUtilization ?? 0;

            return (
              <div key={row.turnId} className={styles.barRow}>
                <span className={styles.turnLabel}>Turn {row.turnNumber}</span>
                <div
                  className={styles.barTrack}
                  role="meter"
                  aria-valuenow={hasUtilization ? percent : undefined}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={
                    hasUtilization
                      ? `Context utilization: ${percent}% (${getUtilizationLabel(percent)})`
                      : 'Context utilization: not available'
                  }
                >
                  {hasUtilization && (
                    <div
                      className={`${styles.barFill} ${getUtilizationColorClass(percent)}`}
                      style={{ width: `${Math.min(100, percent)}%` }}
                    />
                  )}
                </div>
                <span className={styles.percentLabel}>
                  {hasUtilization ? `${percent}%` : '—'}
                </span>
                <span className={styles.barMeta}>
                  {row.model && (
                    <Badge variant="outline" size="sm">{row.model}</Badge>
                  )}
                  {row.thinkingEffort && (
                    <Badge variant="muted" size="sm">{row.thinkingEffort}</Badge>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Section 2: Model + thinking info per turn */}
      <section className={styles.section} aria-labelledby="context-model-info">
        <h3 id="context-model-info" className={styles.sectionHeading}>
          Model &amp; configuration per turn
        </h3>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Turn</th>
                <th scope="col">Model</th>
                <th scope="col">Thinking Effort</th>
                <th scope="col">Auth Method</th>
                <th scope="col">Context Window</th>
                <th scope="col">Utilization</th>
              </tr>
            </thead>
            <tbody>
              {derived.turnRows.map((row) => (
                <tr key={row.turnId}>
                  <th scope="row">Turn {row.turnNumber}</th>
                  <td>{row.model ?? '—'}</td>
                  <td>
                    {row.thinkingEffort ? (
                      <Badge variant="muted" size="sm">{row.thinkingEffort}</Badge>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{row.authMethod ?? '—'}</td>
                  <td>{formatContextWindow(row.contextWindow)}</td>
                  <td>
                    {row.contextUtilization != null ? (
                      <span>
                        {row.contextUtilization}%
                        {' '}
                        <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>
                          ({getUtilizationLabel(row.contextUtilization)})
                        </span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Section 3: Fallback / degradation log */}
      <section className={styles.section} aria-labelledby="context-fallbacks">
        <h3 id="context-fallbacks" className={styles.sectionHeading}>
          Fallbacks &amp; degradations
        </h3>

        {derived.fallbacks.length === 0 ? (
          <div className={styles.noFallbacks}>
            <CheckCircle size={16} aria-hidden />
            <span>No fallbacks or degradations occurred in this session</span>
          </div>
        ) : (
          <div className={styles.fallbackList}>
            {derived.fallbacks.map((entry, index) => (
              <div key={`${entry.turnId}-${index}`} className={styles.fallbackItem}>
                <AlertTriangle size={16} aria-hidden />
                <div className={styles.fallbackDetail}>
                  <span className={styles.fallbackTitle}>
                    Turn {entry.turnNumber}: {entry.fallback.type} fallback
                  </span>
                  <span className={styles.fallbackDescription}>
                    {entry.fallback.from} → {entry.fallback.to}
                    {entry.fallback.reason && ` — ${entry.fallback.reason}`}
                  </span>
                </div>
                <Badge variant="outline" size="sm">{entry.fallback.type}</Badge>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
