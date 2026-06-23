import { useMemo, useState, useCallback } from 'react';
import { Badge } from '@renderer/components/ui';
import { formatTimestamp } from '@renderer/utils/formatters';
import { tryFormatJSON } from '@renderer/utils/stringUtils';
import { formatCostCompact, formatTokenCount } from '@shared/utils/usageFormatters';
import type { AgentEvent } from '@shared/types';
import type { InsightTurnSummary } from '../../work-surface/types';
import styles from './RawEventsTab.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type RawEventsTabProps = {
  eventsByTurn: Record<string, AgentEvent[]>;
  turnSummaries: InsightTurnSummary[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 200;
const ALL_TURNS = '__all__';

type EventTypeFilter = 'assistant' | 'tool' | 'error' | 'result' | 'status' | 'other';

const EVENT_TYPE_FILTERS: EventTypeFilter[] = [
  'assistant',
  'tool',
  'error',
  'result',
  'status',
  'other',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FlatEvent = {
  id: string;
  turnId: string;
  turnNumber: number;
  event: AgentEvent;
  timestamp: number;
  typeLabel: string;
  filterCategory: EventTypeFilter;
  summary: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const truncate = (text: string, maxLen: number): string => {
  if (!text) return '';
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
};

const getEventTypeLabel = (event: AgentEvent): string => {
  if (event.type === 'tool') return `tool:${event.stage}`;
  return event.type;
};

const getFilterCategory = (event: AgentEvent): EventTypeFilter => {
  switch (event.type) {
    case 'assistant':
    case 'assistant_delta':
    case 'thinking_delta':
      return 'assistant';
    case 'tool':
      return 'tool';
    case 'error':
      return 'error';
    case 'result':
      return 'result';
    case 'status':
    case 'turn_started':
    case 'recovery:started':
    case 'recovery:fallback_attempting':
    case 'recovery:fallback_succeeded':
    case 'recovery:compacting':
    case 'recovery:summary_ready':
    case 'recovery:retrying':
    case 'recovery:skeleton_attempting':
    case 'recovery:depth4_attempting':
    case 'recovery:succeeded':
    case 'recovery:failed':
    case 'recovery:last_resort_skipped':
      return 'status';
    default:
      return 'other';
  }
};

const getTypeBadgeClass = (category: EventTypeFilter): string => {
  switch (category) {
    case 'assistant': return styles.badgeAssistant;
    case 'tool': return styles.badgeTool;
    case 'error': return styles.badgeError;
    case 'result': return styles.badgeResult;
    case 'status': return styles.badgeStatus;
    default: return styles.badgeOther;
  }
};

const summarizeEvent = (event: AgentEvent): string => {
  switch (event.type) {
    case 'assistant':
      return truncate(event.text, 80);
    case 'assistant_delta':
      return truncate(event.text, 80);
    case 'thinking_delta':
      return truncate(event.text, 80);
    case 'tool': {
      if (event.stage === 'start') {
        return `→ ${event.toolName} ${truncate(event.detail, 50)}`;
      }
      const statusMark = event.isError ? '✗' : '✓';
      const outputSize = event.detail ? `${event.detail.length} chars` : '0 chars';
      return `← ${event.toolName} ${statusMark} (${outputSize})`;
    }
    case 'error':
      return truncate(event.error, 80);
    case 'result': {
      const costStr = event.usage?.costUsd != null ? formatCostCompact(event.usage.costUsd) : '';
      const tokensStr = event.usage?.outputTokens != null ? formatTokenCount(event.usage.outputTokens) : '';
      return `✓ Complete${costStr ? ` · ${costStr}` : ''}${tokensStr ? ` · ${tokensStr} tokens` : ''}`;
    }
    case 'status':
      return truncate(event.message, 80);
    case 'compaction_started':
    case 'compaction_summary_ready':
    case 'compaction_completed':
    case 'compaction_retrying':
    case 'compaction_failed':
      return event.type.replace(/_/g, ' ');
    case 'recovery:started':
      return `Recovery started (${event.phase})`;
    case 'recovery:fallback_attempting':
      return `Trying fallback: ${event.target.modelName ?? event.target.profileName ?? event.target.profileId ?? event.target.kind}`;
    case 'recovery:fallback_succeeded':
      return `Fallback succeeded: ${event.target.modelName ?? event.target.profileName ?? event.target.profileId ?? event.target.kind}`;
    case 'recovery:compacting':
      return `Compacting depth ${event.depth}, attempt ${event.attempt}`;
    case 'recovery:summary_ready':
      return `Summary ready: ${truncate(event.summary, 60)}`;
    case 'recovery:retrying':
      return `Retrying depth ${event.depth}`;
    case 'recovery:skeleton_attempting':
      return `Skeleton fallback attempt ${event.attempt}`;
    case 'recovery:depth4_attempting':
      return `Last-resort model: ${event.modelName}`;
    case 'recovery:succeeded':
      return `Recovery succeeded (${event.totalCalls} calls)`;
    case 'recovery:failed':
      return `Recovery failed: ${event.exhaustedReason}`;
    case 'recovery:last_resort_skipped':
      return `Last resort skipped: ${event.reason}`;
    case 'context_overflow':
      return 'Context overflow';
    case 'turn_started':
      return 'Turn execution began';
    default:
      return event.type;
  }
};

const flattenEvents = (
  eventsByTurn: Record<string, AgentEvent[]>,
  turnSummaries: InsightTurnSummary[]
): FlatEvent[] => {
  const turnIdToNumber = new Map<string, number>();
  for (let i = 0; i < turnSummaries.length; i++) {
    turnIdToNumber.set(turnSummaries[i].turnId, i + 1);
  }

  const flat: FlatEvent[] = [];

  const turnIds = Object.keys(eventsByTurn);
  for (const turnId of turnIds) {
    const events = eventsByTurn[turnId] ?? [];
    const turnNumber = turnIdToNumber.get(turnId) ?? 0;

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      flat.push({
        id: `${turnId}-${i}`,
        turnId,
        turnNumber,
        event,
        timestamp: event.timestamp,
        typeLabel: getEventTypeLabel(event),
        filterCategory: getFilterCategory(event),
        summary: summarizeEvent(event),
      });
    }
  }

  flat.sort((a, b) => a.timestamp - b.timestamp);
  return flat;
};

const detectCompactedSession = (eventsByTurn: Record<string, AgentEvent[]>): boolean => {
  const turnIds = Object.keys(eventsByTurn);
  for (const turnId of turnIds) {
    const events = eventsByTurn[turnId] ?? [];
    for (const event of events) {
      if (event.type === 'tool' && event.stage === 'end' && event.detail === '') {
        return true;
      }
    }
  }
  return false;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const RawEventsTab = ({ eventsByTurn, turnSummaries }: RawEventsTabProps) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [enabledTypes, setEnabledTypes] = useState<Set<EventTypeFilter>>(
    () => new Set(EVENT_TYPE_FILTERS)
  );
  const [selectedTurn, setSelectedTurn] = useState<string>(ALL_TURNS);
  const [showAll, setShowAll] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Memo keyed to eventsByTurn identity alone. Invariant: turnSummaries
  // is downstream of the event flow that bumps eventsByTurnVersion in
  // sessionStore (see store/sessionStore.ts "Invariants" header), so its
  // content is implicitly covered. If you add a path that updates
  // turnSummaries WITHOUT appending an agent event, this deps array must
  // be expanded (e.g. add `turnSummaries.length`). Stage 6 / 260523
  // code-health sweep.
  const allEvents = useMemo(
    () => flattenEvents(eventsByTurn, turnSummaries),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per invariant above
    [eventsByTurn]
  );

  const isCompacted = useMemo(
    () => detectCompactedSession(eventsByTurn),
    [eventsByTurn]
  );

  const filteredEvents = useMemo(() => {
    let events = allEvents;

    if (selectedTurn !== ALL_TURNS) {
      events = events.filter((e) => e.turnId === selectedTurn);
    }

    events = events.filter((e) => enabledTypes.has(e.filterCategory));

    return events;
  }, [allEvents, selectedTurn, enabledTypes]);

  const visibleEvents = useMemo(() => {
    if (showAll || filteredEvents.length <= PAGE_SIZE) return filteredEvents;
    return filteredEvents.slice(0, PAGE_SIZE);
  }, [filteredEvents, showAll]);

  const toggleType = useCallback((type: EventTypeFilter) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleCopy = useCallback(async (id: string, event: AgentEvent) => {
    try {
      const json = JSON.stringify(event, null, 2);
      await navigator.clipboard.writeText(json);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // Clipboard write failed silently
    }
  }, []);

  if (allEvents.length === 0) {
    return (
      <div className={styles.rawEventsTab} role="region" aria-label="Raw events">
        <div className={styles.emptyState}>No events recorded — activity appears here as the conversation progresses</div>
      </div>
    );
  }

  return (
    <div className={styles.rawEventsTab} role="region" aria-label="Raw events">
      {/* Header */}
      <div className={styles.headerRow}>
        <Badge variant="outline" size="sm" className={styles.devBadge}>
          Developer view
        </Badge>
        <span style={{ fontSize: '0.76rem', color: 'var(--color-text-muted)' }}>
          {allEvents.length} event{allEvents.length === 1 ? '' : 's'} total
          {filteredEvents.length !== allEvents.length && ` · ${filteredEvents.length} shown`}
        </span>
      </div>

      {isCompacted && (
        <div className={styles.compactedBanner} role="status">
          <Badge variant="muted" size="sm">Compacted</Badge>
          <span>Some event details have been compacted for this session</span>
        </div>
      )}

      {/* Controls */}
      <div className={styles.controls}>
        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Type:</span>
          {EVENT_TYPE_FILTERS.map((type) => (
            <label key={type} className={styles.filterCheckbox}>
              <input
                type="checkbox"
                checked={enabledTypes.has(type)}
                onChange={() => toggleType(type)}
              />
              {type}
            </label>
          ))}
        </div>

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Turn:</span>
          <select
            className={styles.turnSelect}
            value={selectedTurn}
            onChange={(e) => setSelectedTurn(e.target.value)}
            aria-label="Filter by turn"
          >
            <option value={ALL_TURNS}>All turns</option>
            {turnSummaries.map((ts, i) => (
              <option key={ts.turnId} value={ts.turnId}>
                Turn {i + 1}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Event list */}
      <div className={styles.eventList} role="list" aria-label="Event log">
        {visibleEvents.map((flatEvent) => {
          const isExpanded = expandedId === flatEvent.id;
          const isCopied = copiedId === flatEvent.id;

          return (
            <div key={flatEvent.id} role="listitem">
              <div
                className={`${styles.eventRow} ${isExpanded ? styles.eventRowExpanded : ''}`}
                onClick={() => toggleExpanded(flatEvent.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleExpanded(flatEvent.id);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-expanded={isExpanded}
                aria-label={`${flatEvent.typeLabel}: ${flatEvent.summary}`}
              >
                <span className={styles.eventTimestamp}>
                  {formatTimestamp(flatEvent.timestamp)}
                </span>
                <Badge
                  variant="muted"
                  size="sm"
                  className={styles.eventTurnBadge}
                >
                  T{flatEvent.turnNumber}
                </Badge>
                <Badge
                  variant="outline"
                  size="sm"
                  className={getTypeBadgeClass(flatEvent.filterCategory)}
                >
                  {flatEvent.typeLabel}
                </Badge>
                <span className={styles.eventSummary}>{flatEvent.summary}</span>
                <div className={styles.eventActions}>
                  <button
                    className={styles.copyButton}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleCopy(flatEvent.id, flatEvent.event);
                    }}
                    aria-label="Copy event as JSON"
                    title="Copy as JSON"
                  >
                    {isCopied ? '✓' : '⎘'}
                  </button>
                </div>
                <span
                  className={`${styles.expandIcon} ${isExpanded ? styles.expandIconOpen : ''}`}
                  aria-hidden
                >
                  ▸
                </span>
              </div>
              {isExpanded && (
                <div className={styles.jsonWrap}>
                  <pre className={styles.jsonContent}>
                    {tryFormatJSON(JSON.stringify(flatEvent.event)).formatted}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {!showAll && filteredEvents.length > PAGE_SIZE && (
        <button
          className={styles.showAllButton}
          onClick={() => setShowAll(true)}
        >
          Show all ({filteredEvents.length} events)
        </button>
      )}
    </div>
  );
};
