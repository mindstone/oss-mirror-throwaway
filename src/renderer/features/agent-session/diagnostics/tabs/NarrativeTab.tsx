import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Sparkles,
  User,
  Wrench,
  Zap,
} from 'lucide-react';
import { Badge, Button, Tooltip } from '@renderer/components/ui';
import type { AgentEvent, ToolDetailArchiveEntry } from '@shared/types';
import { extractTurnUsage } from '@shared/utils/usageAggregator';
import { formatTokenCount } from '@shared/utils/usageFormatters';
import type { NarrativeAnalysis } from '@shared/ipc/schemas/sessions';
import type { InsightTurnSummary } from '../../work-surface/types';
import { deriveToolDurations } from '../utils/deriveToolDurations';
import styles from './NarrativeTab.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type NarrativeTabProps = {
  sessionId: string;
  eventsByTurn: Record<string, AgentEvent[]>;
  turnSummaries: InsightTurnSummary[];
  toolDetailArchive?: Record<string, ToolDetailArchiveEntry> | null;
  /** AI analysis state lifted to parent so it persists across tab switches */
  analysis?: NarrativeAnalysis | null;
  /** Callback to update analysis state in parent */
  onAnalysisChange?: (analysis: NarrativeAnalysis | null) => void;
};

// ---------------------------------------------------------------------------
// Narrative row types
// ---------------------------------------------------------------------------

type NarrativeFlag =
  | 'slow'
  | 'heavy'
  | 'retries'
  | 'failed'
  | 'context_full'
  | 'sub_agent'
  | 'cache_heavy'
  | 'fast_fail'
  | 'thrashing';

interface NarrativeRow {
  id: string;
  type: 'user' | 'assistant' | 'tool' | 'sub_agent';
  turnNumber: number;
  depth: number;
  label: string;
  description: string;
  fullText: string;
  tokens?: number;
  cost?: number;
  durationMs?: number;
  outputChars?: number;
  isError: boolean;
  isCompacted: boolean;
  flags: NarrativeFlag[];
}

// ---------------------------------------------------------------------------
// Flag detection helpers
// ---------------------------------------------------------------------------

const FLAG_LABELS: Record<NarrativeFlag, string> = {
  slow: 'Slow',
  heavy: 'Heavy',
  retries: 'Retries',
  failed: 'Failed',
  context_full: '100% ctx',
  sub_agent: 'Sub-agent',
  cache_heavy: 'Cache-heavy',
  fast_fail: 'Fast fail',
  thrashing: 'Thrashing',
};

const FLAG_VARIANTS: Record<NarrativeFlag, 'destructive' | 'outline' | 'muted'> = {
  slow: 'destructive',
  heavy: 'outline',
  retries: 'outline',
  failed: 'destructive',
  context_full: 'outline',
  sub_agent: 'muted',
  cache_heavy: 'muted',
  fast_fail: 'destructive',
  thrashing: 'outline',
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const SNIPPET_LEN = 120;
const MAX_EXPAND_LEN = 3000;

const createSnippet = (text: string): string => {
  if (!text) return '';
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > SNIPPET_LEN ? `${trimmed.slice(0, SNIPPET_LEN)}…` : trimmed;
};

const formatDuration = (ms: number | undefined): string => {
  if (ms == null) return '—';
  if (ms < 1000) return '<1s';
  return `${(ms / 1000).toFixed(1)}s`;
};

const formatChars = (chars: number): string => {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M`;
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}k`;
  return chars.toString();
};

const formatCost = (cost: number | undefined): string => {
  if (cost == null || cost === 0) return '';
  if (cost < 0.01) return '<1¢';
  if (cost < 1) return `${Math.round(cost * 100)}¢`;
  return `$${cost.toFixed(2)}`;
};

/** Resolve a human-readable tool method name */
const resolveToolMethod = (toolName: string): string => {
  const slashIdx = toolName.indexOf('/');
  if (slashIdx > 0) {
    const after = toolName.slice(slashIdx + 1);
    const doubleUnderIdx = after.indexOf('__');
    return doubleUnderIdx > 0 ? after.slice(doubleUnderIdx + 2) : after;
  }
  if (toolName.startsWith('mcp__super-mcp-router__')) {
    return toolName.slice('mcp__super-mcp-router__'.length);
  }
  return toolName;
};

const isSubAgentTool = (toolName: string): boolean =>
  toolName === 'Task' || toolName.endsWith('/Task') ||
  toolName === 'Agent' || toolName.endsWith('/Agent');

// ---------------------------------------------------------------------------
// deriveNarrativeRows — single pass from eventsByTurn + turnSummaries
// ---------------------------------------------------------------------------

function deriveNarrativeRows(
  eventsByTurn: Record<string, AgentEvent[]>,
  turnSummaries: InsightTurnSummary[],
  toolDetailArchive?: Record<string, ToolDetailArchiveEntry> | null
): NarrativeRow[] {
  const rows: NarrativeRow[] = [];

  for (let i = 0; i < turnSummaries.length; i++) {
    const summary = turnSummaries[i];
    const events = eventsByTurn[summary.turnId] ?? [];
    const turnNumber = i + 1;
    const usage = extractTurnUsage(summary.turnId, events);

    const totalTurnTokens = usage
      ? usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens
      : undefined;
    const costUsd = usage?.costUsd;
    const contextUtil = usage?.contextUtilization;

    // Turn-level flags
    const turnFlags: NarrativeFlag[] = [];
    if (contextUtil != null && contextUtil >= 95) turnFlags.push('context_full');
    if (usage && usage.cacheReadTokens > 0.8 * usage.inputTokens && usage.inputTokens > 0) {
      turnFlags.push('cache_heavy');
    }

    // Find user message for this turn
    const userEvent = events.find((e) => (e.type as string) === 'user');
    const assistantEvents = events.filter((e) => e.type === 'assistant');
    const assistantText = assistantEvents.map((e) => (e as { text?: string }).text ?? '').join(' ');

    // User row
    if (userEvent) {
      const userText = (userEvent as { text?: string }).text ?? '';
      rows.push({
        id: `turn-${turnNumber}-user`,
        type: 'user',
        turnNumber,
        depth: 0,
        label: 'User',
        description: createSnippet(userText),
        fullText: userText.slice(0, MAX_EXPAND_LEN),
        tokens: totalTurnTokens,
        cost: costUsd,
        isError: false,
        isCompacted: false,
        flags: turnFlags,
      });
    }

    // Assistant row
    if (assistantText.trim()) {
      rows.push({
        id: `turn-${turnNumber}-assistant`,
        type: 'assistant',
        turnNumber,
        depth: 0,
        label: 'Agent',
        description: createSnippet(assistantText),
        fullText: assistantText.slice(0, MAX_EXPAND_LEN),
        isError: false,
        isCompacted: false,
        flags: [],
      });
    }

    // Tool calls — use deriveToolDurations for paired timing
    const toolDiagnostics = deriveToolDurations(events);

    // Detect retries: 2+ calls to same tool method in same turn
    const toolMethodCounts = new Map<string, number>();
    for (const td of toolDiagnostics) {
      const method = resolveToolMethod(td.toolName);
      toolMethodCounts.set(method, (toolMethodCounts.get(method) ?? 0) + 1);
    }
    const retriedMethods = new Set(
      Array.from(toolMethodCounts.entries())
        .filter(([, count]) => count >= 2)
        .map(([method]) => method)
    );

    // Detect thrashing: A->B->A pattern
    const thrashingIds = new Set<string>();
    if (toolDiagnostics.length >= 3) {
      for (let j = 2; j < toolDiagnostics.length; j++) {
        const methodA = resolveToolMethod(toolDiagnostics[j - 2].toolName);
        const methodB = resolveToolMethod(toolDiagnostics[j - 1].toolName);
        const methodC = resolveToolMethod(toolDiagnostics[j].toolName);
        if (methodA === methodC && methodA !== methodB) {
          thrashingIds.add(toolDiagnostics[j].toolUseId);
          thrashingIds.add(toolDiagnostics[j - 2].toolUseId);
        }
      }
    }

    let subToolIdx = 0;
    for (const td of toolDiagnostics) {
      subToolIdx++;
      const method = resolveToolMethod(td.toolName);
      const isSubAgent = isSubAgentTool(td.toolName);
      const depth = td.parentToolUseId ? 1 : 0;

      // Recover archive details if compacted
      let outputDetail = td.outputDetail;
      let inputDetail = td.inputDetail;
      let compacted = td.isCompacted;
      const archived = toolDetailArchive?.[td.toolUseId];
      if (compacted && archived) {
        outputDetail = archived.output || outputDetail;
        inputDetail = archived.input || inputDetail;
        compacted = false;
      }

      const outputChars = archived?.outputChars ?? outputDetail.length;

      // Build flags
      const toolFlags: NarrativeFlag[] = [];
      if (td.durationMs != null && td.durationMs > 10_000) toolFlags.push('slow');
      if (outputChars > 10_000) toolFlags.push('heavy');
      if (td.isError) {
        toolFlags.push('failed');
        if (td.durationMs != null && td.durationMs < 1000) toolFlags.push('fast_fail');
      }
      if (retriedMethods.has(method)) toolFlags.push('retries');
      if (thrashingIds.has(td.toolUseId)) toolFlags.push('thrashing');
      if (isSubAgent) toolFlags.push('sub_agent');

      const fullContent = [
        inputDetail ? `Input:\n${inputDetail.slice(0, MAX_EXPAND_LEN)}` : '',
        outputDetail ? `Output:\n${outputDetail.slice(0, MAX_EXPAND_LEN)}` : '',
      ].filter(Boolean).join('\n\n');

      rows.push({
        id: `turn-${turnNumber}-tool-${subToolIdx}`,
        type: isSubAgent ? 'sub_agent' : 'tool',
        turnNumber,
        depth,
        label: isSubAgent ? 'Sub-agent' : method,
        description: createSnippet(outputDetail || inputDetail || `${method} call`),
        fullText: fullContent,
        durationMs: td.durationMs ?? undefined,
        outputChars,
        isError: td.isError,
        isCompacted: compacted,
        flags: toolFlags,
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Duration timeline data
// ---------------------------------------------------------------------------

type TimelineTurn = {
  turnNumber: number;
  totalMs: number;
  segments: Array<{
    type: 'tool' | 'error' | 'think';
    ms: number;
    label: string;
  }>;
};

function deriveTimeline(
  eventsByTurn: Record<string, AgentEvent[]>,
  turnSummaries: InsightTurnSummary[]
): TimelineTurn[] {
  const turns: TimelineTurn[] = [];

  for (let i = 0; i < turnSummaries.length; i++) {
    const summary = turnSummaries[i];
    const events = eventsByTurn[summary.turnId] ?? [];
    const turnNumber = i + 1;

    const timestamps = events.map((e) => e.timestamp).filter(Boolean);
    if (timestamps.length < 2) continue;
    const totalMs = Math.max(...timestamps) - Math.min(...timestamps);
    if (totalMs <= 0) continue;

    const toolDiagnostics = deriveToolDurations(events);
    let toolMs = 0;
    let errorMs = 0;

    const segments: TimelineTurn['segments'] = [];
    for (const td of toolDiagnostics) {
      if (td.durationMs == null) continue;
      if (td.isError) {
        errorMs += td.durationMs;
        segments.push({ type: 'error', ms: td.durationMs, label: resolveToolMethod(td.toolName) });
      } else {
        toolMs += td.durationMs;
        segments.push({ type: 'tool', ms: td.durationMs, label: resolveToolMethod(td.toolName) });
      }
    }

    const thinkMs = Math.max(0, totalMs - toolMs - errorMs);
    if (thinkMs > 0) {
      segments.push({ type: 'think', ms: thinkMs, label: 'Thinking' });
    }

    turns.push({ turnNumber, totalMs, segments });
  }

  return turns;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const ActorIcon = ({ type }: { type: NarrativeRow['type'] }) => {
  const size = 14;
  switch (type) {
    case 'user': return <User size={size} className={styles.actorIcon} aria-hidden />;
    case 'assistant': return <Bot size={size} className={styles.actorIcon} aria-hidden />;
    case 'sub_agent': return <Zap size={size} className={styles.actorIcon} aria-hidden />;
    case 'tool': return <Wrench size={size} className={styles.actorIcon} aria-hidden />;
  }
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const NarrativeTab = ({
  sessionId,
  eventsByTurn,
  turnSummaries,
  toolDetailArchive,
  analysis: externalAnalysis,
  onAnalysisChange,
}: NarrativeTabProps) => {
  // Derive screenplay rows.
  // Memo keyed to eventsByTurn + toolDetailArchive identity. Invariant:
  // turnSummaries is downstream of the event flow that bumps
  // eventsByTurnVersion in sessionStore (see store/sessionStore.ts
  // "Invariants" header), so its content is implicitly covered. If you
  // add a path that updates turnSummaries WITHOUT appending an agent
  // event, this deps array must be expanded (e.g. add
  // `turnSummaries.length`). Stage 6 / 260523 code-health sweep.
  const narrativeRows = useMemo(
    () => deriveNarrativeRows(eventsByTurn, turnSummaries, toolDetailArchive),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per invariant above
    [eventsByTurn, toolDetailArchive]
  );

  // Derive timeline.
  // Memo keyed to eventsByTurn identity alone. Invariant: turnSummaries
  // is downstream of the event flow that bumps eventsByTurnVersion in
  // sessionStore (see store/sessionStore.ts "Invariants" header), so its
  // content is implicitly covered. If you add a path that updates
  // turnSummaries WITHOUT appending an agent event, this deps array must
  // be expanded (e.g. add `turnSummaries.length`). Stage 6 / 260523
  // code-health sweep.
  const timelineTurns = useMemo(
    () => deriveTimeline(eventsByTurn, turnSummaries),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per invariant above
    [eventsByTurn]
  );

  // Expanded row state
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

  // AI analysis state -- use lifted state from parent if available, otherwise local
  const [localAnalysis, setLocalAnalysis] = useState<NarrativeAnalysis | null>(null);
  const analysis = externalAnalysis !== undefined ? externalAnalysis : localAnalysis;
  const setAnalysis = useCallback((value: NarrativeAnalysis | null) => {
    if (onAnalysisChange) {
      onAnalysisChange(value);
    } else {
      setLocalAnalysis(value);
    }
  }, [onAnalysisChange]);

  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const handleGenerateAnalysis = useCallback(async () => {
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      const result = await window.sessionsApi.generateNarrative({ sessionId });
      if (result.error) {
        setAnalysisError(result.error);
      } else {
        setAnalysis(result.narrative ?? null);
        if (!result.narrative) {
          setAnalysisError('No analysis was generated. Ensure you have a valid API key.');
        }
      }
    } catch (err) {
      setAnalysisError((err as Error).message ?? 'Failed to generate analysis');
    } finally {
      setAnalysisLoading(false);
    }
  }, [sessionId, setAnalysis]);

  const handleRowToggle = useCallback((rowId: string) => {
    setExpandedRowId((prev) => (prev === rowId ? null : rowId));
  }, []);

  // Build a set of turn numbers that have waste items for inline banners
  const wasteByTurn = useMemo(() => {
    if (!analysis) return new Map<number, NarrativeAnalysis['wasteItems']>();
    const map = new Map<number, NarrativeAnalysis['wasteItems']>();
    for (const item of analysis.wasteItems) {
      if (item.turnNumber != null) {
        const existing = map.get(item.turnNumber) ?? [];
        existing.push(item);
        map.set(item.turnNumber, existing);
      }
    }
    return map;
  }, [analysis]);

  // Track which turn numbers we've already shown waste banners for
  const renderedWasteTurns = new Set<number>();

  if (narrativeRows.length === 0) {
    return (
      <div className={styles.narrativeTab} role="region" aria-label="Narrative analysis">
        <div className={styles.emptyState}>The narrative builds as the conversation unfolds</div>
      </div>
    );
  }

  const maxTimelineMs = Math.max(...timelineTurns.map((t) => t.totalMs), 1);

  const scoreClass = analysis
    ? analysis.efficiencyScore >= 80
      ? styles.scoreGreen
      : analysis.efficiencyScore >= 50
        ? styles.scoreYellow
        : styles.scoreRed
    : '';

  return (
    <div className={styles.narrativeTab} role="region" aria-label="Narrative analysis">
      {/* ---- AI Analysis Section ---- */}
      <section className={styles.section} aria-labelledby="narr-analysis">
        <div className={styles.sectionHeaderRow}>
          <h3 id="narr-analysis" className={styles.sectionHeading}>
            AI Analysis
          </h3>
          <Sparkles size={14} className={styles.sectionIcon} aria-hidden />
        </div>

        {!analysis && !analysisLoading && (
          <div className={styles.analysisActions}>
            <Button
              variant="outline"
              size="sm"
              onClick={handleGenerateAnalysis}
              disabled={analysisLoading}
            >
              <Sparkles size={14} aria-hidden />
              Generate Analysis
            </Button>
            {analysisError && <span className={styles.errorText}>{analysisError}</span>}
          </div>
        )}

        {analysisLoading && (
          <div className={styles.loadingRow} role="status" aria-live="polite">
            <Loader2 size={14} className={styles.spinIcon} aria-hidden />
            <span>Generating narrative analysis…</span>
          </div>
        )}

        {analysis && (
          <>
            <div className={styles.verdictCard}>
              <div className={`${styles.scoreCircle} ${scoreClass}`}>
                {analysis.efficiencyScore}
              </div>
              <div className={styles.verdictBody}>
                <p className={styles.verdictText}>{analysis.verdict}</p>
                <p className={styles.goalText}>Goal: {analysis.goal}</p>
                <div className={styles.idealRow}>
                  <span className={styles.idealItem}>
                    <span className={styles.idealLabel}>Ideal:</span>
                    {analysis.idealEstimate.time} · {analysis.idealEstimate.tokens} · {analysis.idealEstimate.cost}
                  </span>
                </div>
              </div>
            </div>

            {analysis.narrative && (
              <p className={styles.narrativeText}>{analysis.narrative}</p>
            )}

            {analysis.wasteItems.length > 0 && (
              <div className={styles.wasteList}>
                {analysis.wasteItems.map((item, idx) => (
                  <div key={idx} className={styles.wasteItem}>
                    <div className={styles.wasteHeader}>
                      <AlertTriangle size={13} aria-hidden />
                      <span className={styles.wasteDescription}>{item.description}</span>
                      <Badge variant="outline" size="sm">{item.category.replace(/_/g, ' ')}</Badge>
                      {item.turnNumber != null && (
                        <Badge variant="muted" size="sm">Turn {item.turnNumber}</Badge>
                      )}
                    </div>
                    <div className={styles.wasteMeta}>
                      <span>Time: {item.timeWasted}</span>
                      <span>Tokens: {item.tokensWasted}</span>
                    </div>
                    <span className={styles.wasteSuggestion}>💡 {item.suggestion}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {/* ---- Screenplay Table ---- */}
      <section className={styles.section} aria-labelledby="narr-screenplay">
        <div className={styles.sectionHeaderRow}>
          <h3 id="narr-screenplay" className={styles.sectionHeading}>
            Screenplay
          </h3>
          <Tooltip content="Structured breakdown of conversation actions. Click a row to expand." placement="top">
            <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', cursor: 'help' }} aria-hidden>ⓘ</span>
          </Tooltip>
        </div>

        {(() => {
          const toolRows = narrativeRows.filter((r) => r.type === 'tool' || r.type === 'sub_agent');
          const compactedCount = toolRows.filter((r) => r.isCompacted).length;
          if (compactedCount > 0 && compactedCount >= toolRows.length * 0.5) {
            return (
              <p className={styles.compactionNote}>
                Tool details for this session were compacted before being saved to disk.
                Timing and structure are preserved, but full input/output text is unavailable.
                New conversations will retain full detail.
              </p>
            );
          }
          return null;
        })()}

        <table className={styles.screenplayTable}>
          <thead>
            <tr>
              <th className={styles.colNumber}>#</th>
              <th className={styles.colActor}>Actor</th>
              <th>What happened</th>
              <th className={styles.colMetrics}>Metrics</th>
              <th className={styles.colFlags}>Flags</th>
            </tr>
          </thead>
          <tbody>
            {narrativeRows.map((row) => {
              const isExpanded = expandedRowId === row.id;
              const isTurnLevel = row.type === 'user' || row.type === 'assistant';
              const rowClass = [
                isTurnLevel ? styles.turnRow : styles.toolRow,
                row.isError ? styles.errorRow : '',
              ].filter(Boolean).join(' ');

              // Determine if we should show waste banners after this row
              // Show after the last row for a given turn number
              const turnRows = narrativeRows.filter((r) => r.turnNumber === row.turnNumber);
              const isLastRowOfTurn = turnRows[turnRows.length - 1]?.id === row.id;
              const wasteItems = isLastRowOfTurn && !renderedWasteTurns.has(row.turnNumber)
                ? wasteByTurn.get(row.turnNumber) ?? []
                : [];
              if (wasteItems.length > 0) {
                renderedWasteTurns.add(row.turnNumber);
              }

              // Build numbering
              const subNumber = !isTurnLevel
                ? `.${turnRows.filter((r) => r.type === 'tool' || r.type === 'sub_agent').indexOf(row) + 1}`
                : '';
              const displayNumber = `${row.turnNumber}${subNumber}`;

              // Build metrics string
              let metricsStr = '';
              if (isTurnLevel && row.tokens != null) {
                metricsStr = formatTokenCount(row.tokens);
                const costStr = formatCost(row.cost);
                if (costStr) metricsStr += ` · ${costStr}`;
              } else if (!isTurnLevel) {
                const parts: string[] = [];
                if (row.durationMs != null) parts.push(formatDuration(row.durationMs));
                if (row.outputChars != null && row.outputChars > 0) parts.push(`${formatChars(row.outputChars)} out`);
                metricsStr = parts.join(' · ');
              }

              return [
                <tr
                  key={row.id}
                  className={rowClass}
                  onClick={() => handleRowToggle(row.id)}
                  role="button"
                  aria-expanded={isExpanded}
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleRowToggle(row.id); } }}
                >
                  <td className={styles.colNumber}>{displayNumber}</td>
                  <td className={styles.colActor}>
                    <span className={styles.actorCell}>
                      <ActorIcon type={row.type} />
                      <span className={styles.actorLabel}>{row.label}</span>
                    </span>
                  </td>
                  <td className={`${styles.colDescription} ${row.depth > 0 ? styles.depthIndent : ''}`}>
                    {isExpanded
                      ? <ChevronDown size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} aria-hidden />
                      : <ChevronRight size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} aria-hidden />
                    }
                    {row.description}
                    {row.isCompacted && (
                      <Badge variant="muted" size="sm" style={{ marginLeft: 6 }}>compacted</Badge>
                    )}
                  </td>
                  <td className={styles.colMetrics}>{metricsStr}</td>
                  <td className={styles.colFlags}>
                    <span className={styles.flagList}>
                      {row.flags.map((flag) => (
                        <Badge key={flag} variant={FLAG_VARIANTS[flag]} size="sm">
                          {FLAG_LABELS[flag]}
                        </Badge>
                      ))}
                    </span>
                  </td>
                </tr>,
                isExpanded && row.fullText && (
                  <tr key={`${row.id}-expanded`}>
                    <td colSpan={5} className={styles.expandedContent}>
                      <pre className={styles.expandedPre}>{row.fullText}</pre>
                    </td>
                  </tr>
                ),
                // Inline waste banners for this turn
                ...wasteItems.map((waste, widx) => (
                  <tr key={`${row.id}-waste-${widx}`} className={styles.inlineWasteBanner}>
                    <td colSpan={5}>
                      ⚠ {waste.description} — {waste.suggestion}
                    </td>
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </section>

      {/* ---- Duration Timeline ---- */}
      {timelineTurns.length > 0 && (
        <section className={styles.section} aria-labelledby="narr-timeline">
          <div className={styles.sectionHeaderRow}>
            <h3 id="narr-timeline" className={styles.sectionHeading}>
              Duration Timeline
            </h3>
            <Clock size={14} className={styles.sectionIcon} aria-hidden />
          </div>

          <div className={styles.timelineList}>
            {timelineTurns.map((turn) => {
              const barWidth = Math.max(2, (turn.totalMs / maxTimelineMs) * 100);
              return (
                <Tooltip
                  key={turn.turnNumber}
                  content={turn.segments.map((s) => `${s.label}: ${formatDuration(s.ms)}`).join(' · ')}
                  placement="top"
                >
                  <div className={styles.timelineRow}>
                    <span className={styles.timelineLabel}>Turn {turn.turnNumber}</span>
                    <div className={styles.timelineBarTrack}>
                      <div style={{ display: 'flex', width: `${barWidth}%` }}>
                        {turn.segments.map((seg, si) => {
                          const segPct = turn.totalMs > 0 ? (seg.ms / turn.totalMs) * 100 : 0;
                          const segClass = seg.type === 'error'
                            ? styles.segmentError
                            : seg.type === 'tool'
                              ? styles.segmentTool
                              : styles.segmentThink;
                          return (
                            <div
                              key={si}
                              className={`${styles.timelineSegment} ${segClass}`}
                              style={{ width: `${segPct}%` }}
                              title={`${seg.label}: ${formatDuration(seg.ms)}`}
                            />
                          );
                        })}
                      </div>
                    </div>
                    <span className={styles.timelineDuration}>{formatDuration(turn.totalMs)}</span>
                  </div>
                </Tooltip>
              );
            })}
          </div>

          {/* Timeline legend */}
          <div style={{ display: 'flex', gap: 14, fontSize: '0.74rem', color: 'var(--color-text-secondary)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: 'rgba(99, 102, 241, 0.65)' }} /> Tool calls
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: 'rgba(239, 68, 68, 0.7)' }} /> Errors
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: 'rgba(148, 163, 184, 0.35)' }} /> Thinking
            </span>
          </div>
        </section>
      )}
    </div>
  );
};
