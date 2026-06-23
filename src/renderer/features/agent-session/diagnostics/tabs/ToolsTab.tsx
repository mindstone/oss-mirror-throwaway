import { useMemo, useState } from 'react';
import { Badge, Tooltip } from '@renderer/components/ui';
import { formatDurationShort, formatTimestamp } from '@renderer/utils/formatters';
import type { AgentEvent } from '@shared/types';
import type { InsightTurnSummary } from '../../work-surface/types';
import { deriveToolDurations } from '../utils/deriveToolDurations';
import styles from './ToolsTab.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type ToolsTabProps = {
  eventsByTurn: Record<string, AgentEvent[]>;
  turnSummaries: InsightTurnSummary[];
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortColumn = 'name' | 'callCount' | 'errorCount' | 'avgDuration' | 'totalDuration';
type SortDirection = 'asc' | 'desc';

type ToolSummaryRow = {
  toolName: string;
  callCount: number;
  errorCount: number;
  subAgentCount: number;
  avgDurationMs: number | null;
  totalDurationMs: number | null;
  invocations: ToolInvocation[];
};

type ToolInvocation = {
  toolUseId: string;
  turnId: string;
  turnNumber: number;
  timestamp: number;
  inputSnippet: string;
  outputSnippet: string;
  durationMs: number | null;
  isError: boolean;
  isSubAgent: boolean;
  isCompacted: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SNIPPET_LENGTH = 50;

const createSnippet = (text: string, maxLen: number): string => {
  if (!text) return '';
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
};

const buildToolSummary = (
  eventsByTurn: Record<string, AgentEvent[]>,
  turnSummaries: InsightTurnSummary[]
): ToolSummaryRow[] => {
  const toolMap = new Map<string, ToolSummaryRow>();

  // Use turnSummaries order for consistent turn numbering across all tabs
  const turnIdToNumber = new Map<string, number>();
  for (let i = 0; i < turnSummaries.length; i++) {
    turnIdToNumber.set(turnSummaries[i].turnId, i + 1);
  }

  const turnIds = turnSummaries.map((ts) => ts.turnId);

  for (const turnId of turnIds) {
    const events = eventsByTurn[turnId] ?? [];
    const toolCalls = deriveToolDurations(events);

    for (const call of toolCalls) {
      let row = toolMap.get(call.toolName);
      if (!row) {
        row = {
          toolName: call.toolName,
          callCount: 0,
          errorCount: 0,
          subAgentCount: 0,
          avgDurationMs: null,
          totalDurationMs: null,
          invocations: [],
        };
        toolMap.set(call.toolName, row);
      }

      row.callCount += 1;
      if (call.isError) row.errorCount += 1;
      if (call.parentToolUseId) row.subAgentCount += 1;

      if (call.durationMs != null) {
        row.totalDurationMs = (row.totalDurationMs ?? 0) + call.durationMs;
      }

      row.invocations.push({
        toolUseId: call.toolUseId,
        turnId,
        turnNumber: turnIdToNumber.get(turnId) ?? 0,
        timestamp: call.startTimestamp,
        inputSnippet: call.isCompacted && !call.inputDetail
          ? ''
          : createSnippet(call.inputDetail, SNIPPET_LENGTH),
        outputSnippet: call.isCompacted
          ? ''
          : createSnippet(call.outputDetail, SNIPPET_LENGTH),
        durationMs: call.durationMs,
        isError: call.isError,
        isSubAgent: call.parentToolUseId != null,
        isCompacted: call.isCompacted,
      });
    }
  }

  // Compute averages
  for (const row of toolMap.values()) {
    if (row.totalDurationMs != null) {
      const callsWithDuration = row.invocations.filter((i) => i.durationMs != null).length;
      row.avgDurationMs = callsWithDuration > 0 ? row.totalDurationMs / callsWithDuration : null;
    }
  }

  return Array.from(toolMap.values());
};

const sortRows = (
  rows: ToolSummaryRow[],
  column: SortColumn,
  direction: SortDirection
): ToolSummaryRow[] => {
  const sorted = [...rows];
  const dir = direction === 'asc' ? 1 : -1;

  sorted.sort((a, b) => {
    switch (column) {
      case 'name':
        return dir * a.toolName.localeCompare(b.toolName);
      case 'callCount':
        return dir * (a.callCount - b.callCount);
      case 'errorCount':
        return dir * (a.errorCount - b.errorCount);
      case 'avgDuration':
        return dir * ((a.avgDurationMs ?? -1) - (b.avgDurationMs ?? -1));
      case 'totalDuration':
        return dir * ((a.totalDurationMs ?? -1) - (b.totalDurationMs ?? -1));
      default:
        return 0;
    }
  });

  return sorted;
};

const formatDurationApprox = (ms: number | null): string => {
  if (ms == null) return '—';
  return `~${formatDurationShort(ms)}`;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ToolsTab = ({ eventsByTurn, turnSummaries }: ToolsTabProps) => {
  const [sortColumn, setSortColumn] = useState<SortColumn>('callCount');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [expandedTool, setExpandedTool] = useState<string | null>(null);

  // Intentionally keyed to eventsByTurn identity for stable memoization.
  const toolRows = useMemo(
    () => buildToolSummary(eventsByTurn, turnSummaries),
    [eventsByTurn, turnSummaries]
  );

  const sortedRows = useMemo(
    () => sortRows(toolRows, sortColumn, sortDirection),
    [toolRows, sortColumn, sortDirection]
  );

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection(column === 'name' ? 'asc' : 'desc');
    }
  };

  const toggleExpanded = (toolName: string) => {
    setExpandedTool((prev) => (prev === toolName ? null : toolName));
  };

  const renderSortIndicator = (column: SortColumn) => {
    if (sortColumn !== column) return null;
    return (
      <span className={styles.sortIndicator} aria-hidden>
        {sortDirection === 'asc' ? '▲' : '▼'}
      </span>
    );
  };

  if (toolRows.length === 0) {
    return (
      <div className={styles.toolsTab} role="region" aria-label="Tools diagnostics">
        <div className={styles.emptyState}>No tools used yet — tool calls appear here when Rebel reaches for them</div>
      </div>
    );
  }

  return (
    <div className={styles.toolsTab} role="region" aria-label="Tools diagnostics">
      <section className={styles.section} aria-labelledby="tools-summary">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <h3 id="tools-summary" className={styles.sectionHeading}>
            Tool usage summary
          </h3>
          <Tooltip content="Tool durations derived from event timestamp pairs" placement="top">
            <span className={styles.infoDot} aria-hidden>ⓘ</span>
          </Tooltip>
        </div>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th
                  scope="col"
                  className={styles.sortableHeader}
                  onClick={() => handleSort('name')}
                  aria-sort={sortColumn === 'name' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  Tool Name{renderSortIndicator('name')}
                </th>
                <th
                  scope="col"
                  className={styles.sortableHeader}
                  onClick={() => handleSort('callCount')}
                  aria-sort={sortColumn === 'callCount' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  Calls{renderSortIndicator('callCount')}
                </th>
                <th
                  scope="col"
                  className={styles.sortableHeader}
                  onClick={() => handleSort('errorCount')}
                  aria-sort={sortColumn === 'errorCount' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  Errors{renderSortIndicator('errorCount')}
                </th>
                <th
                  scope="col"
                  className={styles.sortableHeader}
                  onClick={() => handleSort('avgDuration')}
                  aria-sort={sortColumn === 'avgDuration' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  Avg Duration{renderSortIndicator('avgDuration')}
                </th>
                <th
                  scope="col"
                  className={styles.sortableHeader}
                  onClick={() => handleSort('totalDuration')}
                  aria-sort={sortColumn === 'totalDuration' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  Total Duration{renderSortIndicator('totalDuration')}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const isExpanded = expandedTool === row.toolName;

                return (
                  <>
                    <tr
                      key={row.toolName}
                      className={`${styles.toolRow} ${isExpanded ? styles.toolRowExpanded : ''}`}
                      onClick={() => toggleExpanded(row.toolName)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleExpanded(row.toolName);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-expanded={isExpanded}
                      aria-label={`${row.toolName}: ${row.callCount} calls, ${row.errorCount} errors`}
                    >
                      <td>
                        <span className={styles.toolNameCell}>
                          <span
                            className={`${styles.expandIcon} ${isExpanded ? styles.expandIconOpen : ''}`}
                            aria-hidden
                          >
                            ▸
                          </span>
                          {row.toolName}
                          {row.subAgentCount > 0 && (
                            <Badge variant="muted" size="sm" className={styles.subAgentBadge}>
                              sub-agent
                            </Badge>
                          )}
                        </span>
                      </td>
                      <td>{row.callCount}</td>
                      <td>
                        {row.errorCount > 0 ? (
                          <Badge variant="destructive" size="sm">{row.errorCount}</Badge>
                        ) : (
                          '0'
                        )}
                      </td>
                      <td>{formatDurationApprox(row.avgDurationMs)}</td>
                      <td>{formatDurationApprox(row.totalDurationMs)}</td>
                    </tr>

                    {isExpanded &&
                      row.invocations.map((inv) => (
                        <tr key={inv.toolUseId} className={styles.invocationRow}>
                          <td style={{ paddingLeft: '32px' }}>
                            <span className={styles.toolNameCell}>
                              Turn {inv.turnNumber}
                              {inv.isSubAgent && (
                                <Badge variant="muted" size="sm">sub-agent</Badge>
                              )}
                            </span>
                          </td>
                          <td>{formatTimestamp(inv.timestamp)}</td>
                          <td>
                            {inv.isCompacted ? (
                              <span className={styles.compactedNote}>Detail unavailable</span>
                            ) : (
                              <span className={styles.snippetText} title={inv.inputSnippet || '—'}>
                                {inv.inputSnippet || '—'}
                              </span>
                            )}
                          </td>
                          <td>
                            {inv.durationMs != null ? formatDurationApprox(inv.durationMs) : '—'}
                          </td>
                          <td>
                            {inv.isError ? (
                              <Badge variant="destructive" size="sm">Error</Badge>
                            ) : (
                              <Badge variant="outline" size="sm">OK</Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
