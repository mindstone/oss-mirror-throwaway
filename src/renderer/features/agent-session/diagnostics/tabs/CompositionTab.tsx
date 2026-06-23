import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Layers, PieChart } from 'lucide-react';
import { Badge, Tooltip } from '@renderer/components/ui';
import type { AgentEvent } from '@shared/types';
import { extractTurnUsage } from '@shared/utils/usageAggregator';
import { formatTokenCount } from '@shared/utils/usageFormatters';
import type { InsightTurnSummary } from '../../work-surface/types';
import { safeParseDetail } from '../../utils/safeParseDetail';
import styles from './CompositionTab.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type CompositionTabProps = {
  eventsByTurn: Record<string, AgentEvent[]>;
  turnSummaries: InsightTurnSummary[];
  toolDetailArchive?: Record<string, import('@shared/types').ToolDetailArchiveEntry> | null;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TokenCategory = 'input' | 'output' | 'cacheWrite' | 'cacheRead';

type TurnTokenBar = {
  turnId: string;
  turnNumber: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
};

type ToolOutputBlock = {
  label: string;
  chars: number;
  fraction: number;
};

type DotEntry = {
  category: TokenCategory;
  index: number;
};

type ContextBudget = {
  contextWindow: number | null;
  utilization: number | null;
  totalTokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

type ToolCompositionData = {
  mcpChars: number;
  builtinChars: number;
  totalChars: number;
  mcpServerBreakdown: Record<string, number>;
  categoryBreakdown: Record<string, number>;
  hasToolMetrics: boolean;
};

/** Individual tool call with actual content for drill-down */
type ToolCallDetail = {
  toolUseId: string;
  toolName: string;
  /** The resolved MCP server name, or 'built-in' */
  source: string;
  turnNumber: number;
  inputChars: number;
  outputChars: number;
  inputSnippet: string;
  outputSnippet: string;
  fullInput: string;
  fullOutput: string;
  isError: boolean;
  isCompacted: boolean;
};

type DerivedComposition = {
  turnBars: TurnTokenBar[];
  maxTurnTotal: number;
  toolBlocks: ToolOutputBlock[];
  dots: DotEntry[];
  budget: ContextBudget;
  toolData: ToolCompositionData;
  /** Individual tool calls with actual content, grouped by source */
  toolCallsBySource: Record<string, ToolCallDetail[]>;
  allToolCalls: ToolCallDetail[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_COLORS: Record<TokenCategory, string> = {
  input: 'var(--comp-input)',
  output: 'var(--comp-output)',
  cacheWrite: 'var(--comp-cache-write)',
  cacheRead: 'var(--comp-cache-read)',
};

const TOKEN_LABELS: Record<TokenCategory, string> = {
  input: 'Input',
  output: 'Output',
  cacheWrite: 'Cache write',
  cacheRead: 'Cache read',
};

const TOKENS_PER_DOT = 1000;
const MAX_DOTS = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the MCP server name from a tool event's resolved toolName.
 * End-stage events have names like "Slack-mindstone/Slack-mindstone__get_slack_thread".
 * Returns 'built-in' for non-MCP tools.
 */
const resolveToolSource = (toolName: string): string => {
  // MCP super-router end events: "PackageId/PackageId__method"
  const slashIdx = toolName.indexOf('/');
  if (slashIdx > 0) return toolName.slice(0, slashIdx);
  // MCP super-router start events
  if (toolName.startsWith('mcp__')) return 'mcp (resolving...)';
  return 'built-in';
};

/** Resolve a human-readable tool method name */
const resolveToolMethod = (toolName: string): string => {
  const slashIdx = toolName.indexOf('/');
  if (slashIdx > 0) {
    const after = toolName.slice(slashIdx + 1);
    // "Slack-mindstone__get_slack_thread_replies" -> "get_slack_thread_replies"
    const doubleUnderIdx = after.indexOf('__');
    return doubleUnderIdx > 0 ? after.slice(doubleUnderIdx + 2) : after;
  }
  if (toolName.startsWith('mcp__super-mcp-router__')) {
    return toolName.slice('mcp__super-mcp-router__'.length);
  }
  return toolName;
};

const DETAIL_SNIPPET_LEN = 120;

const createDetailSnippet = (detail: string, maxLen: number): string => {
  if (!detail) return '';
  const trimmed = detail.trim().replace(/\s+/g, ' ');
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}...` : trimmed;
};

const deriveComposition = (
  eventsByTurn: Record<string, AgentEvent[]>,
  turnSummaries: InsightTurnSummary[],
  toolDetailArchive?: Record<string, import('@shared/types').ToolDetailArchiveEntry> | null
): DerivedComposition => {
  const turnBars: TurnTokenBar[] = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheWrite = 0;
  let totalCacheRead = 0;
  let lastContextWindow: number | null = null;
  let lastUtilization: number | null = null;

  // Aggregated tool metrics from result events
  let totalMcpChars = 0;
  let totalBuiltinChars = 0;
  let totalToolChars = 0;
  const mcpServerUsage: Record<string, number> = {};
  const categoryUsage: Record<string, number> = {};
  let hasToolMetrics = false;

  // Individual tool call extraction
  const allToolCalls: ToolCallDetail[] = [];
  const startEvents = new Map<string, Extract<AgentEvent, { type: 'tool' }>>();

  for (let i = 0; i < turnSummaries.length; i++) {
    const summary = turnSummaries[i];
    const events = eventsByTurn[summary.turnId] ?? [];
    const usage = extractTurnUsage(summary.turnId, events);

    const input = usage?.inputTokens ?? 0;
    const output = usage?.outputTokens ?? 0;
    const cacheWrite = usage?.cacheCreationTokens ?? 0;
    const cacheRead = usage?.cacheReadTokens ?? 0;

    turnBars.push({
      turnId: summary.turnId,
      turnNumber: i + 1,
      input,
      output,
      cacheWrite,
      cacheRead,
      total: input + output + cacheWrite + cacheRead,
    });

    totalInput += input;
    totalOutput += output;
    totalCacheWrite += cacheWrite;
    totalCacheRead += cacheRead;

    if (usage?.contextWindow != null) lastContextWindow = usage.contextWindow;
    if (usage?.contextUtilization != null) lastUtilization = usage.contextUtilization;

    // Extract tool metrics from result events and build per-call details
    for (const event of events) {
      if (event.type === 'result' && event.toolMetrics) {
        hasToolMetrics = true;
        totalMcpChars += event.toolMetrics.mcpToolOutputChars ?? 0;
        totalBuiltinChars += event.toolMetrics.builtinToolOutputChars ?? 0;
        totalToolChars += event.toolMetrics.totalToolOutputChars ?? 0;

        if (event.toolMetrics.mcpServerUsage) {
          for (const [server, count] of Object.entries(event.toolMetrics.mcpServerUsage)) {
            mcpServerUsage[server] = (mcpServerUsage[server] ?? 0) + count;
          }
        }
        if (event.toolMetrics.toolUsageByCategory) {
          for (const [cat, count] of Object.entries(event.toolMetrics.toolUsageByCategory)) {
            categoryUsage[cat] = (categoryUsage[cat] ?? 0) + count;
          }
        }
      }

      // Collect tool events for per-call detail
      if (event.type === 'tool') {
        const id = event.toolUseId ?? `synthetic-${event.toolName}-${event.timestamp}`;
        if (event.stage === 'start') {
          startEvents.set(id, event);
        } else {
          const startEv = startEvents.get(id);
          let inputDetail = startEv?.detail ?? '';
          let outputDetail = event.detail ?? '';
          let isCompacted = outputDetail === '' || (
            outputDetail.startsWith('{') && outputDetail.length < 200
          );

          // Recover from archive if events are compacted
          const archived = toolDetailArchive?.[id];
          if (isCompacted && archived) {
            inputDetail = archived.input || inputDetail;
            outputDetail = archived.output || outputDetail;
            isCompacted = false; // Successfully recovered
          }

          allToolCalls.push({
            toolUseId: id,
            toolName: event.toolName,
            source: resolveToolSource(event.toolName),
            turnNumber: i + 1,
            inputChars: inputDetail.length,
            outputChars: archived?.outputChars ?? outputDetail.length,
            inputSnippet: createDetailSnippet(inputDetail, DETAIL_SNIPPET_LEN),
            outputSnippet: createDetailSnippet(outputDetail, DETAIL_SNIPPET_LEN),
            fullInput: inputDetail,
            fullOutput: outputDetail,
            isError: event.isError === true,
            isCompacted,
          });
          startEvents.delete(id);
        }
      }
    }
  }

  const maxTurnTotal = Math.max(...turnBars.map((b) => b.total), 1);

  // Build tool output blocks (treemap-style)
  // Use actual per-tool output chars when available, fall back to approximation
  const toolBlocks: ToolOutputBlock[] = [];
  if (hasToolMetrics && totalToolChars > 0) {
    // Compute actual output chars per source from tool call details
    const charsBySource = new Map<string, number>();
    for (const call of allToolCalls) {
      const src = call.source;
      charsBySource.set(src, (charsBySource.get(src) ?? 0) + call.outputChars);
    }

    // If tool calls have actual output data, use it for proportions
    const totalMeasuredChars = Array.from(charsBySource.values()).reduce((s, v) => s + v, 0);
    const hasActualMeasurements = totalMeasuredChars > 0;

    if (hasActualMeasurements) {
      // Sort by chars descending
      const entries = Array.from(charsBySource.entries()).sort(([, a], [, b]) => b - a);
      for (const [source, chars] of entries) {
        // Scale measured chars to match aggregate total (measured chars may differ from aggregate)
        const scaledChars = Math.round((chars / totalMeasuredChars) * totalToolChars);
        if (scaledChars > 0) {
          toolBlocks.push({
            label: source,
            chars: scaledChars,
            fraction: scaledChars / totalToolChars,
          });
        }
      }
    } else if (allToolCalls.length > 0) {
      // Fallback: use per-source call counts for proportioning so labels
      // match toolCallsBySource keys (enabling drill-down on click).
      const callsBySource = new Map<string, number>();
      for (const call of allToolCalls) {
        callsBySource.set(call.source, (callsBySource.get(call.source) ?? 0) + 1);
      }
      const totalCalls = allToolCalls.length;
      const sortedSources = Array.from(callsBySource.entries()).sort(([, a], [, b]) => b - a);
      for (const [source, calls] of sortedSources) {
        const approxChars = totalToolChars > 0
          ? Math.round((calls / totalCalls) * totalToolChars)
          : calls;
        if (approxChars > 0) {
          toolBlocks.push({
            label: source,
            chars: approxChars,
            fraction: totalToolChars > 0 ? approxChars / totalToolChars : calls / totalCalls,
          });
        }
      }
    } else {
      // No individual tool calls available — use aggregate metrics for display only.
      // Drill-down won't be available since there are no per-call details.
      if (totalBuiltinChars > 0) {
        toolBlocks.push({
          label: 'Built-in tools',
          chars: totalBuiltinChars,
          fraction: totalBuiltinChars / totalToolChars,
        });
      }
      const mcpEntries = Object.entries(mcpServerUsage).sort(([, a], [, b]) => b - a);
      if (mcpEntries.length > 0) {
        const totalMcpCalls = mcpEntries.reduce((sum, [, c]) => sum + c, 0);
        for (const [server, calls] of mcpEntries) {
          const approxChars = totalMcpCalls > 0
            ? Math.round((calls / totalMcpCalls) * totalMcpChars)
            : 0;
          if (approxChars > 0) {
            toolBlocks.push({
              label: server,
              chars: approxChars,
              fraction: approxChars / totalToolChars,
            });
          }
        }
      } else if (totalMcpChars > 0) {
        toolBlocks.push({
          label: 'MCP tools',
          chars: totalMcpChars,
          fraction: totalMcpChars / totalToolChars,
        });
      }
    }
  }

  // Group tool calls by source
  const toolCallsBySource: Record<string, ToolCallDetail[]> = {};
  for (const call of allToolCalls) {
    if (!toolCallsBySource[call.source]) toolCallsBySource[call.source] = [];
    toolCallsBySource[call.source].push(call);
  }

  // Build dot matrix
  const totalTokens = totalInput + totalOutput + totalCacheWrite + totalCacheRead;
  const dotScale = totalTokens > MAX_DOTS * TOKENS_PER_DOT
    ? totalTokens / MAX_DOTS
    : TOKENS_PER_DOT;

  const dots: DotEntry[] = [];
  const categories: { cat: TokenCategory; count: number }[] = [
    { cat: 'cacheRead', count: totalCacheRead },
    { cat: 'cacheWrite', count: totalCacheWrite },
    { cat: 'input', count: totalInput },
    { cat: 'output', count: totalOutput },
  ];

  let dotIndex = 0;
  for (const { cat, count } of categories) {
    const numDots = Math.max(count > 0 ? 1 : 0, Math.round(count / dotScale));
    for (let d = 0; d < numDots && dotIndex < MAX_DOTS; d++) {
      dots.push({ category: cat, index: dotIndex++ });
    }
  }

  return {
    turnBars,
    maxTurnTotal,
    toolBlocks,
    dots,
    budget: {
      contextWindow: lastContextWindow,
      utilization: lastUtilization,
      totalTokensUsed: totalInput + totalOutput + totalCacheWrite + totalCacheRead,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheWriteTokens: totalCacheWrite,
      cacheReadTokens: totalCacheRead,
    },
    toolData: {
      mcpChars: totalMcpChars,
      builtinChars: totalBuiltinChars,
      totalChars: totalToolChars,
      mcpServerBreakdown: mcpServerUsage,
      categoryBreakdown: categoryUsage,
      hasToolMetrics,
    },
    toolCallsBySource,
    allToolCalls,
  };
};

const formatChars = (chars: number): string => {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M`;
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}k`;
  return chars.toString();
};

const formatContextWindow = (tokens: number | null): string => {
  if (tokens == null) return '—';
  if (tokens >= 1_000_000) return '1M';
  return `${Math.round(tokens / 1000)}K`;
};

/** Try to pretty-print JSON detail, truncating large values */
const MAX_DETAIL_DISPLAY = 2000;
// Exported for unit testing the OOM guard (see __tests__/tryFormatDetail.test.ts).
export const tryFormatDetail = (detail: string): string => {
  if (!detail) return '';
  const truncated = detail.length > MAX_DETAIL_DISPLAY
    ? detail.slice(0, MAX_DETAIL_DISPLAY) + `\n... [${formatChars(detail.length)} total]`
    : detail;
  // Guard the parse: a huge `detail` (large tool output) must never be fully
  // JSON.parsed here — that materialises a multi-hundred-MB object graph and
  // can OOM the renderer (REBEL-68T/68P). The previous dead-ternary guard
  // (`truncated.length === detail.length ? detail : detail`) always parsed the
  // full string. safeParseDetail refuses anything over its byte budget BEFORE
  // calling JSON.parse; over-budget detail falls back to the truncated display
  // string. See docs/plans/260616_stuck-library-renderer-oom/PLAN.md (Stage 1).
  const parsed = safeParseDetail(detail);
  if (parsed.ok) {
    return JSON.stringify(parsed.value, null, 2).slice(0, MAX_DETAIL_DISPLAY + 200);
  }
  return truncated;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const CompositionTab = ({ eventsByTurn, turnSummaries, toolDetailArchive }: CompositionTabProps) => {
  // Memo keyed to eventsByTurn + toolDetailArchive identity. Invariant:
  // turnSummaries is downstream of the event flow that bumps
  // eventsByTurnVersion in sessionStore (see store/sessionStore.ts
  // "Invariants" header), so its content is implicitly covered. If you
  // add a path that updates turnSummaries WITHOUT appending an agent
  // event, this deps array must be expanded (e.g. add
  // `turnSummaries.length`). Stage 6 / 260523 code-health sweep.
  const derived = useMemo(
    () => deriveComposition(eventsByTurn, turnSummaries, toolDetailArchive),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per invariant above
    [eventsByTurn, toolDetailArchive]
  );

  // Drill-down state: which source is expanded, and which individual call is expanded
  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  const [expandedCallId, setExpandedCallId] = useState<string | null>(null);
  const drillDownRef = useRef<HTMLDivElement>(null);

  const handleBlockClick = useCallback((label: string) => {
    setExpandedSource((prev) => prev === label ? null : label);
    setExpandedCallId(null);
  }, []);

  // Auto-scroll to drill-down panel when it opens
  useEffect(() => {
    if (expandedSource && drillDownRef.current) {
      drillDownRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [expandedSource]);

  const handleCallToggle = useCallback((callId: string) => {
    setExpandedCallId((prev) => prev === callId ? null : callId);
  }, []);

  if (derived.turnBars.length === 0) {
    return (
      <div className={styles.compositionTab} role="region" aria-label="Context composition">
        <div className={styles.emptyState}>Composition data appears after the first turn</div>
      </div>
    );
  }

  return (
    <div className={styles.compositionTab} role="region" aria-label="Context composition">
      {/* Legend */}
      <div className={styles.legend}>
        {(Object.entries(TOKEN_LABELS) as [TokenCategory, string][]).map(([cat, label]) => (
          <span key={cat} className={styles.legendItem}>
            <span
              className={styles.legendDot}
              style={{ background: TOKEN_COLORS[cat] }}
              aria-hidden
            />
            {label}
          </span>
        ))}
      </div>

      {/* Section 1: Stacked bar chart — token composition per turn */}
      <section className={styles.section} aria-labelledby="comp-stacked-bar">
        <div className={styles.sectionHeaderRow}>
          <h3 id="comp-stacked-bar" className={styles.sectionHeading}>
            Token composition per turn
          </h3>
          <Tooltip content="Stacked bars show input, output, cache write, and cache read tokens for each turn" placement="top">
            <span className={styles.infoDot} aria-hidden>ⓘ</span>
          </Tooltip>
        </div>

        <div className={styles.barList}>
          {derived.turnBars.map((bar) => {
            const pctInput = bar.total > 0 ? (bar.input / bar.total) * 100 : 0;
            const pctOutput = bar.total > 0 ? (bar.output / bar.total) * 100 : 0;
            const pctCacheWrite = bar.total > 0 ? (bar.cacheWrite / bar.total) * 100 : 0;
            const pctCacheRead = bar.total > 0 ? (bar.cacheRead / bar.total) * 100 : 0;
            const barWidth = derived.maxTurnTotal > 0
              ? Math.max(2, (bar.total / derived.maxTurnTotal) * 100)
              : 0;

            return (
              <Tooltip
                key={bar.turnId}
                content={`Input: ${formatTokenCount(bar.input)} · Output: ${formatTokenCount(bar.output)} · Cache W: ${formatTokenCount(bar.cacheWrite)} · Cache R: ${formatTokenCount(bar.cacheRead)}`}
                placement="top"
              >
                <div className={styles.barRow}>
                  <span className={styles.turnLabel}>Turn {bar.turnNumber}</span>
                  <div className={styles.stackedBarTrack}>
                    <div
                      className={styles.stackedBar}
                      style={{ width: `${barWidth}%` }}
                      role="meter"
                      aria-valuenow={bar.total}
                      aria-valuemin={0}
                      aria-valuemax={derived.maxTurnTotal}
                      aria-label={`Turn ${bar.turnNumber}: ${formatTokenCount(bar.total)} total tokens`}
                    >
                      {bar.input > 0 && (
                        <div
                          className={styles.stackedSegment}
                          style={{ width: `${pctInput}%`, background: TOKEN_COLORS.input }}
                        />
                      )}
                      {bar.output > 0 && (
                        <div
                          className={styles.stackedSegment}
                          style={{ width: `${pctOutput}%`, background: TOKEN_COLORS.output }}
                        />
                      )}
                      {bar.cacheWrite > 0 && (
                        <div
                          className={styles.stackedSegment}
                          style={{ width: `${pctCacheWrite}%`, background: TOKEN_COLORS.cacheWrite }}
                        />
                      )}
                      {bar.cacheRead > 0 && (
                        <div
                          className={styles.stackedSegment}
                          style={{ width: `${pctCacheRead}%`, background: TOKEN_COLORS.cacheRead }}
                        />
                      )}
                    </div>
                  </div>
                  <span className={styles.totalLabel}>{formatTokenCount(bar.total)}</span>
                </div>
              </Tooltip>
            );
          })}
        </div>
      </section>

      {/* Section 2: Tool output composition (treemap-style blocks) */}
      <section className={styles.section} aria-labelledby="comp-tool-output">
        <div className={styles.sectionHeaderRow}>
          <h3 id="comp-tool-output" className={styles.sectionHeading}>
            Tool output composition
          </h3>
          <Tooltip content="Proportional blocks showing what tool outputs consumed context" placement="top">
            <span className={styles.infoDot} aria-hidden>ⓘ</span>
          </Tooltip>
        </div>

        {!derived.toolData.hasToolMetrics ? (
          <div className={styles.noDataCard}>
            <Layers size={16} aria-hidden />
            <span>Tool metrics not available for this session</span>
          </div>
        ) : derived.toolBlocks.length === 0 ? (
          <div className={styles.noDataCard}>
            <Layers size={16} aria-hidden />
            <span>No tool output data recorded</span>
          </div>
        ) : (
          <>
            {derived.allToolCalls.length > 0 && (
              <p className={styles.drillHint}>Click a block to see individual tool calls</p>
            )}
            <div
              className={styles.treemap}
              role="list"
              aria-label="Tool output composition treemap"
            >
              {derived.toolBlocks.map((block) => {
                const isSelected = expandedSource === block.label;
                return (
                  <Tooltip
                    key={block.label}
                    content={`${block.label}: ${formatChars(block.chars)} chars (${Math.round(block.fraction * 100)}%) — click to drill down`}
                    placement="top"
                  >
                    <button
                      type="button"
                      className={`${styles.treemapBlock} ${isSelected ? styles.treemapBlockSelected : ''}`}
                      style={{
                        flexGrow: Math.max(1, Math.round(block.fraction * 100)),
                        cursor: 'pointer',
                      }}
                      role="listitem"
                      aria-label={`${block.label}: ${formatChars(block.chars)} chars`}
                      aria-expanded={isSelected}
                      onClick={() => handleBlockClick(block.label)}
                    >
                      <span className={styles.treemapLabel}>{block.label}</span>
                      <span className={styles.treemapValue}>{formatChars(block.chars)}</span>
                    </button>
                  </Tooltip>
                );
              })}
            </div>

            {/* Drill-down: individual tool calls for selected source */}
            {expandedSource && (derived.toolCallsBySource[expandedSource] ? (
              <div ref={drillDownRef} className={styles.drillDown} role="region" aria-label={`Tool calls from ${expandedSource}`}>
                <h4 className={styles.drillDownHeading}>
                  {expandedSource} — {derived.toolCallsBySource[expandedSource].length} call{derived.toolCallsBySource[expandedSource].length === 1 ? '' : 's'}
                </h4>
                <div className={styles.callList}>
                  {derived.toolCallsBySource[expandedSource].map((call) => {
                    const isCallExpanded = expandedCallId === call.toolUseId;
                    const method = resolveToolMethod(call.toolName);
                    return (
                      <div key={call.toolUseId} className={styles.callItem}>
                        <button
                          type="button"
                          className={styles.callHeader}
                          onClick={() => handleCallToggle(call.toolUseId)}
                          aria-expanded={isCallExpanded}
                        >
                          {isCallExpanded
                            ? <ChevronDown size={14} aria-hidden />
                            : <ChevronRight size={14} aria-hidden />
                          }
                          <span className={styles.callMethod}>{method}</span>
                          <span className={styles.callMeta}>
                            Turn {call.turnNumber}
                            {call.outputChars > 0 && ` · ${formatChars(call.outputChars)} output`}
                            {call.inputChars > 0 && ` · ${formatChars(call.inputChars)} input`}
                          </span>
                          {call.isError && <Badge variant="destructive" size="sm">Error</Badge>}
                          {call.isCompacted && <Badge variant="muted" size="sm">Compacted</Badge>}
                        </button>
                        {isCallExpanded && (
                          <div className={styles.callBody}>
                            {call.fullInput && (
                              <div className={styles.callSection}>
                                <span className={styles.callSectionLabel}>Input</span>
                                <pre className={styles.callContent}>{tryFormatDetail(call.fullInput)}</pre>
                              </div>
                            )}
                            {call.fullOutput ? (
                              <div className={styles.callSection}>
                                <span className={styles.callSectionLabel}>Output ({formatChars(call.outputChars)})</span>
                                <pre className={styles.callContent}>{tryFormatDetail(call.fullOutput)}</pre>
                              </div>
                            ) : call.isCompacted ? (
                              <div className={styles.callSection}>
                                <span className={styles.callSectionLabel}>Output</span>
                                <span className={styles.compactedNote}>
                                  Content unavailable — session was compacted before persistence.
                                  Full data may exist in ~/.claude/ transcripts.
                                </span>
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div ref={drillDownRef} className={styles.drillDown} role="region" aria-label={`Tool calls from ${expandedSource}`}>
                <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--color-text-muted)' }}>
                  No individual call data available for &quot;{expandedSource}&quot;.
                  Tool details may have been compacted.
                </p>
              </div>
            ))}

            {/* Category breakdown */}
            {Object.keys(derived.toolData.categoryBreakdown).length > 0 && (
              <div className={styles.categoryRow}>
                {Object.entries(derived.toolData.categoryBreakdown)
                  .sort(([, a], [, b]) => b - a)
                  .map(([cat, count]) => (
                    <Badge key={cat} variant="outline" size="sm">
                      {cat}: {count}
                    </Badge>
                  ))}
              </div>
            )}
          </>
        )}
      </section>

      {/* Section 3: Token distribution dot matrix */}
      <section className={styles.section} aria-labelledby="comp-dot-matrix">
        <div className={styles.sectionHeaderRow}>
          <h3 id="comp-dot-matrix" className={styles.sectionHeading}>
            Token distribution
          </h3>
          <Tooltip
            content={`Each dot ≈ ${formatTokenCount(derived.budget.totalTokensUsed > MAX_DOTS * TOKENS_PER_DOT ? Math.round(derived.budget.totalTokensUsed / MAX_DOTS) : TOKENS_PER_DOT)} tokens`}
            placement="top"
          >
            <span className={styles.infoDot} aria-hidden>ⓘ</span>
          </Tooltip>
        </div>

        <div
          className={styles.dotGrid}
          role="img"
          aria-label={`Token distribution: ${formatTokenCount(derived.budget.inputTokens)} input, ${formatTokenCount(derived.budget.outputTokens)} output, ${formatTokenCount(derived.budget.cacheWriteTokens)} cache write, ${formatTokenCount(derived.budget.cacheReadTokens)} cache read`}
        >
          {derived.dots.map((dot) => (
            <span
              key={dot.index}
              className={styles.dot}
              style={{ background: TOKEN_COLORS[dot.category] }}
              title={TOKEN_LABELS[dot.category]}
            />
          ))}
        </div>

        <div className={styles.dotSummary}>
          {derived.budget.cacheReadTokens > 0 && (
            <span>
              <span className={styles.dotInline} style={{ background: TOKEN_COLORS.cacheRead }} />
              Cache read: {formatTokenCount(derived.budget.cacheReadTokens)}
            </span>
          )}
          {derived.budget.cacheWriteTokens > 0 && (
            <span>
              <span className={styles.dotInline} style={{ background: TOKEN_COLORS.cacheWrite }} />
              Cache write: {formatTokenCount(derived.budget.cacheWriteTokens)}
            </span>
          )}
          <span>
            <span className={styles.dotInline} style={{ background: TOKEN_COLORS.input }} />
            Input: {formatTokenCount(derived.budget.inputTokens)}
          </span>
          <span>
            <span className={styles.dotInline} style={{ background: TOKEN_COLORS.output }} />
            Output: {formatTokenCount(derived.budget.outputTokens)}
          </span>
        </div>
      </section>

      {/* Section 4: Context budget summary */}
      <section className={styles.section} aria-labelledby="comp-budget">
        <div className={styles.sectionHeaderRow}>
          <h3 id="comp-budget" className={styles.sectionHeading}>
            Context budget
          </h3>
          <PieChart size={14} className={styles.sectionIcon} aria-hidden />
        </div>

        <div className={styles.budgetCard}>
          <div className={styles.budgetRow}>
            <span className={styles.budgetLabel}>Context window</span>
            <span className={styles.budgetValue}>
              {formatContextWindow(derived.budget.contextWindow)}
            </span>
          </div>

          <div className={styles.budgetRow}>
            <span className={styles.budgetLabel}>Utilization</span>
            <span className={styles.budgetValue}>
              {derived.budget.utilization != null ? `${derived.budget.utilization}%` : '—'}
            </span>
          </div>

          {/* Visual gauge */}
          {derived.budget.utilization != null && (
            <div className={styles.gauge}>
              <div
                className={styles.gaugeFill}
                style={{ width: `${Math.min(100, derived.budget.utilization)}%` }}
                role="meter"
                aria-valuenow={derived.budget.utilization}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Context utilization: ${derived.budget.utilization}%`}
              />
            </div>
          )}

          <div className={styles.budgetRow}>
            <span className={styles.budgetLabel}>Total tokens</span>
            <span className={styles.budgetValue}>
              {formatTokenCount(derived.budget.totalTokensUsed)}
            </span>
          </div>

          {derived.budget.contextWindow != null && (
            <div className={styles.budgetRow}>
              <span className={styles.budgetLabel}>Remaining</span>
              <span className={styles.budgetValue}>
                {formatTokenCount(Math.max(0, derived.budget.contextWindow - derived.budget.totalTokensUsed))}
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
