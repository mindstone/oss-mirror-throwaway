import { useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { Badge } from '@renderer/components/ui';
import { formatTimestamp } from '@renderer/utils/formatters';
import type { AgentEvent, TurnFallback } from '@shared/types';
import type { InsightTurnSummary } from '../../work-surface/types';
import styles from './IssuesTab.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type IssuesTabProps = {
  eventsByTurn: Record<string, AgentEvent[]>;
  turnSummaries: InsightTurnSummary[];
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type IssueKind = 'error' | 'tool_failure' | 'fallback' | 'compaction' | 'context_overflow';

type IssueEntry = {
  id: string;
  kind: IssueKind;
  turnId: string;
  turnNumber: number;
  timestamp: number;
  summary: string;
  detail: string;
  errorKind?: string;
  isTransient?: boolean;
  retryAfterMs?: number;
  fallbackType?: string;
};

type IssueSummary = {
  errorCount: number;
  toolFailureCount: number;
  fallbackCount: number;
  compactionCount: number;
  contextOverflowCount: number;
  totalCount: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const truncateMessage = (text: string, maxLen = 120): string => {
  if (!text) return '';
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
};

const collectIssues = (
  eventsByTurn: Record<string, AgentEvent[]>,
  turnSummaries: InsightTurnSummary[]
): { issues: IssueEntry[]; summary: IssueSummary } => {
  const issues: IssueEntry[] = [];
  const summary: IssueSummary = {
    errorCount: 0,
    toolFailureCount: 0,
    fallbackCount: 0,
    compactionCount: 0,
    contextOverflowCount: 0,
    totalCount: 0,
  };

  const turnIdToNumber = new Map<string, number>();
  for (let i = 0; i < turnSummaries.length; i++) {
    turnIdToNumber.set(turnSummaries[i].turnId, i + 1);
  }

  const turnIds = Object.keys(eventsByTurn);

  for (const turnId of turnIds) {
    const events = eventsByTurn[turnId] ?? [];
    const turnNumber = turnIdToNumber.get(turnId) ?? 0;

    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      // Error events
      if (event.type === 'error') {
        summary.errorCount += 1;
        const rateLimitInfo = event.rateLimitMeta?.retryAfterMs
          ? ` (retry after ${Math.round(event.rateLimitMeta.retryAfterMs / 1000)}s)`
          : '';
        issues.push({
          id: `error-${turnId}-${i}`,
          kind: 'error',
          turnId,
          turnNumber,
          timestamp: event.timestamp,
          summary: truncateMessage(event.error),
          detail: event.error + rateLimitInfo,
          errorKind: event.errorKind,
          isTransient: event.isTransient,
          retryAfterMs: event.rateLimitMeta?.retryAfterMs,
        });
      }

      // Failed tool calls
      if (event.type === 'tool' && event.stage === 'end' && event.isError) {
        summary.toolFailureCount += 1;
        issues.push({
          id: `tool-fail-${turnId}-${i}`,
          kind: 'tool_failure',
          turnId,
          turnNumber,
          timestamp: event.timestamp,
          summary: `Tool failed: ${event.toolName}`,
          detail: event.detail || 'No error detail available',
        });
      }

      // Fallbacks from result events
      if (event.type === 'result' && event.fallbacks) {
        for (let j = 0; j < event.fallbacks.length; j++) {
          const fb: TurnFallback = event.fallbacks[j];
          summary.fallbackCount += 1;
          issues.push({
            id: `fallback-${turnId}-${i}-${j}`,
            kind: 'fallback',
            turnId,
            turnNumber,
            timestamp: event.timestamp,
            summary: `${fb.type} fallback: ${fb.from} → ${fb.to}`,
            detail: fb.reason || `Fell back from ${fb.from} to ${fb.to}`,
            fallbackType: fb.type,
          });
        }
      }

      // Compaction / recovery events
      if (
        event.type === 'compaction_started' ||
        event.type === 'compaction_failed' ||
        event.type === 'recovery:started' ||
        event.type === 'recovery:failed' ||
        event.type === 'recovery:last_resort_skipped'
      ) {
        summary.compactionCount += 1;
        const desc = (() => {
          if (event.type === 'compaction_failed') return `Compaction failed (depth ${event.depth}): ${event.error}`;
          if (event.type === 'compaction_started') return `Compaction started (depth ${event.depth})`;
          if (event.type === 'recovery:failed') return `Recovery failed (depth ${event.depth}): ${event.error}`;
          if (event.type === 'recovery:last_resort_skipped') return `Recovery skipped: ${event.reason}`;
          return `Recovery started (${event.phase})`;
        })();
        const detail = (() => {
          if (event.type === 'compaction_failed') return event.error;
          if (event.type === 'compaction_started') return `Session ${event.sessionId ?? turnId}, depth ${event.depth}`;
          if (event.type === 'recovery:failed') return event.error;
          if (event.type === 'recovery:last_resort_skipped') return event.userFacingMessage;
          return `Session ${event.sessionId}, original session ${event.originalSessionId}, total calls ${event.totalCalls}`;
        })();
        issues.push({
          id: `compaction-${turnId}-${i}`,
          kind: 'compaction',
          turnId,
          turnNumber,
          timestamp: event.timestamp,
          summary: desc,
          detail,
        });
      }

      // Context overflow
      if (event.type === 'context_overflow') {
        summary.contextOverflowCount += 1;
        issues.push({
          id: `overflow-${turnId}-${i}`,
          kind: 'context_overflow',
          turnId,
          turnNumber,
          timestamp: event.timestamp,
          summary: 'Context overflow',
          detail: event.originalPrompt ? truncateMessage(event.originalPrompt, 200) : 'Context window exceeded',
        });
      }
    }
  }

  // Sort chronologically
  issues.sort((a, b) => a.timestamp - b.timestamp);
  summary.totalCount =
    summary.errorCount + summary.toolFailureCount + summary.fallbackCount +
    summary.compactionCount + summary.contextOverflowCount;

  return { issues, summary };
};

const getKindIcon = (kind: IssueKind) => {
  switch (kind) {
    case 'error':
      return <XCircle size={16} style={{ color: 'rgba(239, 68, 68, 0.72)' }} aria-hidden />;
    case 'tool_failure':
      return <AlertCircle size={16} style={{ color: 'rgba(239, 68, 68, 0.72)' }} aria-hidden />;
    case 'fallback':
      return <AlertTriangle size={16} style={{ color: 'rgba(180, 140, 8, 0.72)' }} aria-hidden />;
    case 'compaction':
      return <AlertTriangle size={16} style={{ color: 'rgba(180, 140, 8, 0.72)' }} aria-hidden />;
    case 'context_overflow':
      return <AlertCircle size={16} style={{ color: 'rgba(239, 68, 68, 0.72)' }} aria-hidden />;
  }
};

const getKindLabel = (kind: IssueKind): string => {
  switch (kind) {
    case 'error': return 'Error';
    case 'tool_failure': return 'Tool Failure';
    case 'fallback': return 'Fallback';
    case 'compaction': return 'Compaction';
    case 'context_overflow': return 'Overflow';
  }
};

const getKindVariant = (kind: IssueKind): 'destructive' | 'outline' => {
  switch (kind) {
    case 'error':
    case 'tool_failure':
    case 'context_overflow':
      return 'destructive';
    case 'fallback':
    case 'compaction':
      return 'outline';
  }
};

const getItemClass = (kind: IssueKind): string => {
  switch (kind) {
    case 'error':
    case 'tool_failure':
    case 'context_overflow':
      return styles.issueItemError;
    case 'fallback':
    case 'compaction':
      return styles.issueItemWarning;
  }
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const IssuesTab = ({ eventsByTurn, turnSummaries }: IssuesTabProps) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Memo keyed to eventsByTurn identity alone. Invariant: turnSummaries
  // is downstream of the event flow that bumps eventsByTurnVersion in
  // sessionStore (see store/sessionStore.ts "Invariants" header), so its
  // content is implicitly covered. If you add a path that updates
  // turnSummaries WITHOUT appending an agent event, this deps array must
  // be expanded (e.g. add `turnSummaries.length`). Stage 6 / 260523
  // code-health sweep.
  const { issues, summary } = useMemo(
    () => collectIssues(eventsByTurn, turnSummaries),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per invariant above
    [eventsByTurn]
  );

  const toggleExpanded = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  const hasIssues = summary.totalCount > 0;

  return (
    <div className={styles.issuesTab} role="region" aria-label="Issues diagnostics">
      {/* Summary card */}
      <div
        className={`${styles.summaryCard} ${hasIssues ? styles.summaryCardIssues : styles.summaryCardClean}`}
      >
        {hasIssues ? (
          <AlertCircle
            size={24}
            className={`${styles.summaryIcon} ${styles.summaryIconIssues}`}
            aria-hidden
          />
        ) : (
          <CheckCircle
            size={24}
            className={`${styles.summaryIcon} ${styles.summaryIconClean}`}
            aria-hidden
          />
        )}
        <p className={styles.summaryText}>
          {hasIssues
            ? `${summary.totalCount} issue${summary.totalCount === 1 ? '' : 's'} detected`
            : 'No issues detected ✓'}
        </p>
        {hasIssues && (
          <div className={styles.summaryBreakdown}>
            {summary.errorCount > 0 && (
              <Badge variant="destructive" size="sm">
                {summary.errorCount} error{summary.errorCount === 1 ? '' : 's'}
              </Badge>
            )}
            {summary.toolFailureCount > 0 && (
              <Badge variant="destructive" size="sm">
                {summary.toolFailureCount} failed tool{summary.toolFailureCount === 1 ? '' : 's'}
              </Badge>
            )}
            {summary.fallbackCount > 0 && (
              <Badge variant="outline" size="sm">
                {summary.fallbackCount} fallback{summary.fallbackCount === 1 ? '' : 's'}
              </Badge>
            )}
            {summary.compactionCount > 0 && (
              <Badge variant="outline" size="sm">
                {summary.compactionCount} compaction{summary.compactionCount === 1 ? '' : 's'}
              </Badge>
            )}
            {summary.contextOverflowCount > 0 && (
              <Badge variant="destructive" size="sm">
                {summary.contextOverflowCount} overflow{summary.contextOverflowCount === 1 ? '' : 's'}
              </Badge>
            )}
          </div>
        )}
      </div>

      {/* Issues list */}
      {hasIssues && (
        <section className={styles.section} aria-labelledby="issues-list-heading">
          <h3 id="issues-list-heading" className={styles.sectionHeading}>
            Chronological issues
          </h3>

          <div className={styles.issuesList} role="list">
            {issues.map((issue) => {
              const isExpanded = expandedId === issue.id;

              return (
                <div key={issue.id} role="listitem">
                  <div
                    className={`${styles.issueItem} ${getItemClass(issue.kind)}`}
                    onClick={() => toggleExpanded(issue.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleExpanded(issue.id);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-expanded={isExpanded}
                    aria-label={`${getKindLabel(issue.kind)}: ${issue.summary}`}
                  >
                    {getKindIcon(issue.kind)}
                    <div className={styles.issueHeader}>
                      <span className={styles.issueTimestamp}>
                        {formatTimestamp(issue.timestamp)}
                      </span>
                      <Badge
                        variant="muted"
                        size="sm"
                        className={styles.issueTurnBadge}
                      >
                        Turn {issue.turnNumber}
                      </Badge>
                      <Badge variant={getKindVariant(issue.kind)} size="sm">
                        {getKindLabel(issue.kind)}
                      </Badge>
                      {issue.errorKind && (
                        <Badge variant="outline" size="sm">{issue.errorKind}</Badge>
                      )}
                      {issue.isTransient && (
                        <Badge variant="muted" size="sm">Transient</Badge>
                      )}
                      <span className={styles.issueDescription}>{issue.summary}</span>
                    </div>
                    <span
                      className={`${styles.issueExpandIcon} ${isExpanded ? styles.issueExpandIconOpen : ''}`}
                      aria-hidden
                    >
                      ▸
                    </span>
                  </div>
                  {isExpanded && (
                    <div className={styles.issueDetail}>{issue.detail}</div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};
