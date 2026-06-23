import { useMemo, useState } from 'react';
import {
  AlertCircle,
  Brain,
  CheckCircle,
  Clock,
  DollarSign,
  XCircle,
} from 'lucide-react';
import { Badge, Tooltip } from '@renderer/components/ui';
import { createMessageSnippet, formatDurationShort } from '@renderer/utils/formatters';
import { formatCostCompact, formatTokenCount } from '@shared/utils/usageFormatters';
import { extractTurnUsage } from '@shared/utils/usageAggregator';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import type { InsightTurnSummary } from '../../work-surface/types';
import { deriveToolDurations, type ToolCallDiagnostic } from '../utils/deriveToolDurations';
import styles from './TimelineTab.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_TURNS = '__all__';

const TOOL_DURATION_PROVENANCE =
  'Duration derived from tool start → end timestamps. May not reflect actual execution time if events were batched.';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type TimelineTabProps = {
  eventsByTurn: Record<string, AgentEvent[]>;
  turnSummaries: InsightTurnSummary[];
  messages: AgentTurnMessage[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TurnTimelineData = {
  turnId: string;
  turnNumber: number;
  userMessageSnippet: string;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  tools: ToolCallDiagnostic[];
  thinkingPhases: Array<{ timestamp: number; durationEstimateMs: number }>;
  errors: Array<{ timestamp: number; message: string }>;
  hasResult: boolean;
};

/**
 * Estimates thinking phases from thinking_delta events.
 * Groups consecutive deltas into phases by detecting gaps > 2s between them.
 */
const extractThinkingPhases = (
  events: AgentEvent[]
): Array<{ timestamp: number; durationEstimateMs: number }> => {
  const thinkingDeltas = events.filter((e) => e.type === 'thinking_delta');
  if (thinkingDeltas.length === 0) return [];

  const phases: Array<{ timestamp: number; durationEstimateMs: number }> = [];
  let phaseStart = thinkingDeltas[0].timestamp;
  let phaseEnd = phaseStart;

  for (let i = 1; i < thinkingDeltas.length; i++) {
    const delta = thinkingDeltas[i];
    // Gap > 2s means a new thinking phase
    if (delta.timestamp - phaseEnd > 2000) {
      phases.push({
        timestamp: phaseStart,
        durationEstimateMs: Math.max(0, phaseEnd - phaseStart),
      });
      phaseStart = delta.timestamp;
    }
    phaseEnd = delta.timestamp;
  }

  // Push the last phase
  phases.push({
    timestamp: phaseStart,
    durationEstimateMs: Math.max(0, phaseEnd - phaseStart),
  });

  return phases;
};

const extractErrors = (
  events: AgentEvent[]
): Array<{ timestamp: number; message: string }> => {
  const errors: Array<{ timestamp: number; message: string }> = [];
  for (const event of events) {
    if (event.type === 'error') {
      errors.push({ timestamp: event.timestamp, message: event.error });
    }
  }
  return errors;
};

const findUserMessage = (turnId: string, messages: AgentTurnMessage[]): string => {
  const msg = messages.find((m) => m.turnId === turnId && m.role === 'user');
  return msg ? createMessageSnippet(msg.text, 60) : '(no user message)';
};

const buildTurnTimelines = (
  eventsByTurn: Record<string, AgentEvent[]>,
  turnSummaries: InsightTurnSummary[],
  messages: AgentTurnMessage[]
): TurnTimelineData[] => {
  const timelines: TurnTimelineData[] = [];

  for (let i = 0; i < turnSummaries.length; i++) {
    const summary = turnSummaries[i];
    const events = eventsByTurn[summary.turnId] ?? [];
    if (events.length === 0) continue;

    const usage = extractTurnUsage(summary.turnId, events);
    const durationMs = Math.max(0, summary.lastTimestamp - summary.startedAt);

    timelines.push({
      turnId: summary.turnId,
      turnNumber: i + 1,
      userMessageSnippet: findUserMessage(summary.turnId, messages),
      durationMs,
      costUsd: usage?.costUsd ?? 0,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      tools: deriveToolDurations(events),
      thinkingPhases: extractThinkingPhases(events),
      errors: extractErrors(events),
      hasResult: events.some((e) => e.type === 'result'),
    });
  }

  return timelines;
};

const truncateDetail = (detail: string, maxLength = 200): string => {
  if (!detail || detail.length <= maxLength) return detail;
  return `${detail.slice(0, maxLength)}…`;
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const ToolEntry = ({
  tool,
  turnDurationMs,
  isExpanded,
  onToggle,
}: {
  tool: ToolCallDiagnostic;
  turnDurationMs: number;
  isExpanded: boolean;
  onToggle: () => void;
}) => {
  const barWidthPercent =
    tool.durationMs != null && turnDurationMs > 0
      ? Math.min(100, (tool.durationMs / turnDurationMs) * 100)
      : tool.durationMs == null
        ? 30 // fixed width for unknown duration
        : 2;

  const barClass = tool.isError
    ? styles.barError
    : tool.durationMs == null
      ? styles.barInProgress
      : styles.barSuccess;

  const statusIcon = tool.isError ? (
    <XCircle size={13} aria-label="Error" className={styles.toolStatus} style={{ color: 'rgba(239, 68, 68, 0.72)' }} />
  ) : tool.durationMs == null ? (
    <Clock size={13} aria-label="In progress" className={styles.toolStatus} style={{ color: 'var(--color-text-muted)' }} />
  ) : (
    <CheckCircle size={13} aria-label="Success" className={styles.toolStatus} style={{ color: 'rgba(34, 197, 94, 0.72)' }} />
  );

  const durationLabel =
    tool.durationMs != null
      ? formatDurationShort(tool.durationMs)
      : 'unknown';

  return (
    <div
      className={`${styles.entry} ${styles.entryClickable}`}
      role="button"
      tabIndex={0}
      aria-expanded={isExpanded}
      aria-label={`${tool.toolName} — ${durationLabel}`}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <div className={styles.toolRow}>
        <span className={styles.toolIcon} aria-hidden>🔧</span>
        <span className={styles.toolName} title={tool.toolName}>
          {tool.toolName}
        </span>
        <Tooltip content={TOOL_DURATION_PROVENANCE} placement="top">
          <div className={styles.barContainer}>
            <div
              className={`${styles.bar} ${barClass}`}
              style={{ width: `${barWidthPercent}%` }}
              aria-label={`Duration bar: ${durationLabel}`}
            />
          </div>
        </Tooltip>
        <span className={styles.toolDuration}>{durationLabel}</span>
        {statusIcon}
      </div>

      {isExpanded && (
        <div className={styles.expandedDetail}>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Tool</span>
            <span className={styles.detailValue}>{tool.toolName}</span>
          </div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Duration</span>
            <span className={styles.detailValue}>
              {tool.durationMs != null ? formatDurationShort(tool.durationMs) : 'Duration unknown'}
              {tool.durationMs == null && ' (in progress or orphaned event)'}
            </span>
          </div>
          {tool.isError && (
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Status</span>
              <Badge variant="destructive" size="sm">Error</Badge>
            </div>
          )}
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Input</span>
            <span className={styles.detailValue}>
              {tool.isCompacted && !tool.inputDetail ? (
                <span className={styles.compactedNote}>
                  Detail unavailable (session compacted)
                </span>
              ) : (
                truncateDetail(tool.inputDetail) || '—'
              )}
            </span>
          </div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Output</span>
            <span className={styles.detailValue}>
              {tool.isCompacted ? (
                <span className={styles.compactedNote}>
                  Detail unavailable (session compacted)
                </span>
              ) : (
                truncateDetail(tool.outputDetail) || '—'
              )}
            </span>
          </div>
          {tool.hasImageContent && (
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Images</span>
              <Badge variant="outline" size="sm">Contains image output</Badge>
            </div>
          )}
          {tool.parentToolUseId && (
            <div className={styles.detailRow}>
              <span className={styles.detailLabel}>Parent</span>
              <Badge variant="muted" size="sm">Sub-agent call</Badge>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const ThinkingEntry = ({
  phase,
}: {
  phase: { timestamp: number; durationEstimateMs: number };
}) => (
  <div className={`${styles.entry} ${styles.thinkingEntry}`}>
    <div className={styles.thinkingRow}>
      <Brain size={13} aria-hidden />
      <span>
        Thinking
        {phase.durationEstimateMs > 0 && ` (~${formatDurationShort(phase.durationEstimateMs)})`}
      </span>
    </div>
  </div>
);

const ErrorEntry = ({ error }: { error: { timestamp: number; message: string } }) => (
  <div className={`${styles.entry} ${styles.errorEntry}`}>
    <div className={styles.errorRow}>
      <AlertCircle size={13} aria-hidden />
      <span>{truncateDetail(error.message, 120)}</span>
    </div>
  </div>
);

const TurnCompleteRow = ({
  costUsd,
  inputTokens,
  outputTokens,
}: {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}) => (
  <div className={styles.turnCompleteRow}>
    <CheckCircle size={13} aria-hidden />
    <span>
      Turn complete · {formatCostCompact(costUsd)} · {formatTokenCount(inputTokens)} in / {formatTokenCount(outputTokens)} out
    </span>
  </div>
);

// ---------------------------------------------------------------------------
// Timeline entries: interleave tools, thinking, errors by timestamp
// ---------------------------------------------------------------------------

type TimelineEntryItem =
  | { kind: 'tool'; data: ToolCallDiagnostic; key: string }
  | { kind: 'thinking'; data: { timestamp: number; durationEstimateMs: number }; key: string }
  | { kind: 'error'; data: { timestamp: number; message: string }; key: string };

const interleaveEntries = (turn: TurnTimelineData): TimelineEntryItem[] => {
  const items: TimelineEntryItem[] = [];

  for (const tool of turn.tools) {
    items.push({ kind: 'tool', data: tool, key: `tool-${tool.toolUseId}` });
  }
  for (let i = 0; i < turn.thinkingPhases.length; i++) {
    items.push({
      kind: 'thinking',
      data: turn.thinkingPhases[i],
      key: `think-${i}-${turn.thinkingPhases[i].timestamp}`,
    });
  }
  for (let i = 0; i < turn.errors.length; i++) {
    items.push({
      kind: 'error',
      data: turn.errors[i],
      key: `err-${i}-${turn.errors[i].timestamp}`,
    });
  }

  // Sort by timestamp ascending
  items.sort((a, b) => {
    const tsA = a.kind === 'tool' ? a.data.startTimestamp : a.data.timestamp;
    const tsB = b.kind === 'tool' ? b.data.startTimestamp : b.data.timestamp;
    return tsA - tsB;
  });

  return items;
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const TimelineTab = ({
  eventsByTurn,
  turnSummaries,
  messages,
}: TimelineTabProps) => {
  const [selectedTurn, setSelectedTurn] = useState<string>(ALL_TURNS);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  // Memo keyed to eventsByTurn identity alone. Invariant: messages and
  // turnSummaries are downstream of the event flow that bumps
  // eventsByTurnVersion in sessionStore (see store/sessionStore.ts
  // "Invariants" header), so their content is implicitly covered. If you
  // add a path that updates either prop WITHOUT appending an agent event,
  // this deps array must be expanded (e.g. add `messages.length` or
  // `turnSummaries.length`). Stage 6 / 260523 code-health sweep.
  const turnTimelines = useMemo(
    () => buildTurnTimelines(eventsByTurn, turnSummaries, messages),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per invariant above
    [eventsByTurn]
  );

  const visibleTurns = useMemo(() => {
    if (selectedTurn === ALL_TURNS) return turnTimelines;
    return turnTimelines.filter((t) => t.turnId === selectedTurn);
  }, [turnTimelines, selectedTurn]);

  const toggleToolExpanded = (toolUseId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolUseId)) {
        next.delete(toolUseId);
      } else {
        next.add(toolUseId);
      }
      return next;
    });
  };

  if (turnTimelines.length === 0) {
    return (
      <div className={styles.timelineTab} role="region" aria-label="Timeline">
        <div className={styles.emptyState}>No turns yet — the timeline populates as the conversation runs</div>
      </div>
    );
  }

  return (
    <div className={styles.timelineTab} role="region" aria-label="Timeline">
      {/* Turn filter pills */}
      {turnTimelines.length > 1 && (
        <div className={styles.controls} role="toolbar" aria-label="Turn filter">
          <span className={styles.controlLabel}>Show:</span>
          <button
            className={`${styles.turnPill} ${selectedTurn === ALL_TURNS ? styles.turnPillActive : ''}`}
            onClick={() => setSelectedTurn(ALL_TURNS)}
            aria-pressed={selectedTurn === ALL_TURNS}
          >
            All turns
          </button>
          {turnTimelines.map((turn) => (
            <button
              key={turn.turnId}
              className={`${styles.turnPill} ${selectedTurn === turn.turnId ? styles.turnPillActive : ''}`}
              onClick={() => setSelectedTurn(turn.turnId)}
              aria-pressed={selectedTurn === turn.turnId}
            >
              Turn {turn.turnNumber}
            </button>
          ))}
        </div>
      )}

      {/* Turn sections */}
      {visibleTurns.map((turn) => {
        const entries = interleaveEntries(turn);

        return (
          <section
            key={turn.turnId}
            className={styles.turnSection}
            aria-label={`Turn ${turn.turnNumber}`}
          >
            <div className={styles.turnHeader}>
              <span
                className={styles.turnNumber}
                aria-label={`Turn ${turn.turnNumber}`}
              >
                {turn.turnNumber}
              </span>
              <span className={styles.turnSnippet} title={turn.userMessageSnippet}>
                {turn.userMessageSnippet}
              </span>
              <div className={styles.turnMeta}>
                <span className={styles.turnMetaItem}>
                  <Clock size={13} aria-hidden />
                  {formatDurationShort(turn.durationMs)}
                </span>
                <span className={styles.turnMetaItem}>
                  <DollarSign size={13} aria-hidden />
                  {formatCostCompact(turn.costUsd)}
                </span>
              </div>
            </div>

            {entries.length > 0 && (
              <div className={styles.entryList} role="list">
                {entries.map((item) => {
                  if (item.kind === 'tool') {
                    return (
                      <ToolEntry
                        key={item.key}
                        tool={item.data}
                        turnDurationMs={turn.durationMs}
                        isExpanded={expandedTools.has(item.data.toolUseId)}
                        onToggle={() => toggleToolExpanded(item.data.toolUseId)}
                      />
                    );
                  }
                  if (item.kind === 'thinking') {
                    return <ThinkingEntry key={item.key} phase={item.data} />;
                  }
                  return <ErrorEntry key={item.key} error={item.data} />;
                })}
              </div>
            )}

            {turn.hasResult && (
              <TurnCompleteRow
                costUsd={turn.costUsd}
                inputTokens={turn.inputTokens}
                outputTokens={turn.outputTokens}
              />
            )}
          </section>
        );
      })}
    </div>
  );
};
