import { X, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import { useFlowPanels } from '@renderer/features/flow-panels/FlowPanelsProvider';
import { formatDurationShort, formatTimestamp, formatStepDuration, createMessageSnippet, formatUsage } from '@renderer/utils/formatters';
import { extractTurnUsage } from '@shared/utils/usageAggregator';
import { formatCostCompact } from '@shared/utils/usageFormatters';
import { MessageMarkdown } from '@renderer/components/MessageMarkdown';
import { ImageGrid } from './ImageGrid';
import { imageGridSourceFromEvent } from './imageGridSource';
import { getFileOperationDetails } from '@renderer/utils/fileOperations';
import { tryFormatJSON } from '@renderer/utils/stringUtils';
import type { SessionRuntimeState } from '../utils/runtimeState';
import type { InsightTurnSummary, StorylineFilters, StorylineStats, StorylineEntry } from '../work-surface/types';
import { buildStorylineEntries, buildTechnicalEventsByStep } from '../work-surface/utils/timelineBuilders';
import type { TurnStepContext } from '../utils/turnStepContext';
import { memo, useState, useRef, useEffect, useCallback, useMemo } from 'react';
import './InsightsDrawer.css';

type InsightsDrawerProps = {
  turnSummaries: InsightTurnSummary[];
  currentRuntime: SessionRuntimeState;
  isBusy: boolean;
  storylineFilters: StorylineFilters;
  onToggleStorylineFilter: (filter: keyof StorylineFilters) => void;
  thinkingStage: 'generation' | 'processing' | null;
  thinkingElapsedLabel: string;
  isViewSessionBusy: boolean;
  thinkingHint: string;
  /** Map of turn ID → turn step context data */
  turnStepContextByTurn: Record<string, TurnStepContext | undefined>;
  /** Callback to open a file in the workspace drawer */
  loadWorkspaceFile: (path: string) => Promise<void>;
  onOpenConversation?: (sessionId: string) => void;
  /** Current Rebel session ID */
  sessionId?: string;
};

const FILTERS: Array<{ key: keyof StorylineFilters; label: string }> = [
  { key: 'thinking', label: 'Thinking' },
  { key: 'files', label: 'Files' },
  { key: 'tools', label: 'Tools & status' }
];

type StepAccordionProps = {
  entry: StorylineEntry;
  isExpanded: boolean;
  onToggle: () => void;
  filters: StorylineFilters;
  loadWorkspaceFile: (path: string) => Promise<void>;
  onOpenConversation?: (sessionId: string) => void;
  /** Session ID the entry was emitted from. Used to resolve `imageRef` assets via `rebel-asset://`. */
  sessionId?: string;
  /** Duration of this step in milliseconds (time until next step or turn end) */
  durationMs?: number;
  /** Whether this is the last step of an active/running turn */
  isLiveStep?: boolean;
};

const StepAccordion = ({
  entry,
  isExpanded,
  onToggle,
  filters,
  loadWorkspaceFile,
  onOpenConversation,
  sessionId,
  durationMs,
  isLiveStep,
}: StepAccordionProps) => {
  const thinkingText = 'text' in entry.thinkingEvent ? entry.thinkingEvent.text : '';
  const thinkingSnippet = filters.thinking ? createMessageSnippet(thinkingText, 100) : null;
  const preferredOps = entry.fileOperations.filter((op) => op.stage === 'end');
  const fileOps = preferredOps.length > 0 ? preferredOps : entry.fileOperations;
  const toolEvents = entry.technicalEvents.filter((event) => event.type === 'tool');
  const errorEvents = entry.technicalEvents.filter((event) => event.type === 'error');

  const hasThinking = filters.thinking && thinkingText;
  const hasFiles = filters.files && fileOps.length > 0;
  const hasTools = filters.tools && (toolEvents.length > 0 || errorEvents.length > 0);
  const hasContent = hasThinking || hasFiles || hasTools;

  return (
    <div className={`step-accordion ${isExpanded ? 'step-accordion--expanded' : ''}`}>
      <button
        type="button"
        className="step-accordion__header"
        onClick={onToggle}
        aria-expanded={isExpanded}
      >
        <div className="step-accordion__header-left">
          <ChevronRight
            className={`step-accordion__chevron ${isExpanded ? 'step-accordion__chevron--open' : ''}`}
            size={14}
          />
          <span className="step-accordion__step-number">Step {entry.stepNumber}</span>
          <span className="step-accordion__time">
            {formatTimestamp(entry.timestamp)}
            {durationMs !== undefined || isLiveStep ? (
              <span className="step-accordion__duration">
                {' · '}
                {isLiveStep ? 'Live' : formatStepDuration(durationMs)}
              </span>
            ) : null}
          </span>
        </div>
        <div className="step-accordion__badges">
          {toolEvents.length > 0 && (
            <span className="step-accordion__badge step-accordion__badge--tool">
              ⚙️ {toolEvents.length}
            </span>
          )}
          {fileOps.length > 0 && filters.files && (
            <span className="step-accordion__badge step-accordion__badge--file">
              📁 {fileOps.length}
            </span>
          )}
          {errorEvents.length > 0 && (
            <span className="step-accordion__badge step-accordion__badge--error">
              ⚠️ {errorEvents.length}
            </span>
          )}
        </div>
      </button>

      {/* Summary preview when collapsed */}
      {!isExpanded && thinkingSnippet ? (
        <div className="step-accordion__preview">
          <p>{thinkingSnippet}</p>
        </div>
      ) : null}

      {/* Expanded content */}
      {isExpanded && hasContent ? (
        <div className="step-accordion__content">
          {/* Thinking section */}
          {hasThinking ? (
            <div className="step-accordion__section">
              <h5 className="step-accordion__section-title">💭 Thinking</h5>
              <div className="step-accordion__section-body step-accordion__thinking">
                <MessageMarkdown
                  content={thinkingText}
                  onOpenFile={loadWorkspaceFile}
                  onOpenConversation={onOpenConversation}
                />
              </div>
            </div>
          ) : null}

          {/* Files section */}
          {hasFiles ? (
            <div className="step-accordion__section">
              <h5 className="step-accordion__section-title">📁 File Activity ({fileOps.length})</h5>
              <ul className="step-accordion__file-list">
                {fileOps.map((op, idx) => (
                  <li key={`${op.timestamp}-${idx}`} className="step-accordion__file-item">
                    {getFileOperationDetails(op)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Tools & Status section */}
          {hasTools ? (
            <div className="step-accordion__section">
              <h5 className="step-accordion__section-title">
                ⚙️ Tools & Status ({toolEvents.length + errorEvents.length})
              </h5>
              <div className="step-accordion__tools">
                {entry.technicalEvents.map((event, idx) => {
                  if (event.type === 'tool') {
                    const jsonResult = tryFormatJSON(event.detail);
                    const isStart = event.stage === 'start';
                    const gridImages =
                      event.stage === 'end'
                        ? imageGridSourceFromEvent(
                            { imageContent: event.imageContent, imageRef: event.imageRef },
                            sessionId,
                            { altPrefix: `${event.toolName} result image` },
                          )
                        : [];
                    return (
                      <div
                        key={`tool-${event.timestamp}-${idx}`}
                        className={`step-accordion__tool-entry ${isStart ? 'step-accordion__tool-entry--call' : 'step-accordion__tool-entry--result'}`}
                      >
                        <div className="step-accordion__tool-header">
                          <span className="step-accordion__tool-label">
                            {isStart ? '→' : '←'} {event.toolName}
                          </span>
                          {jsonResult.isJSON && (
                            <span className="step-accordion__tool-tag">JSON</span>
                          )}
                        </div>
                        {jsonResult.isJSON ? (
                          <pre className="step-accordion__json">
                            <code>{jsonResult.formatted}</code>
                          </pre>
                        ) : (
                          <p className="step-accordion__tool-detail">{jsonResult.formatted}</p>
                        )}
                        {gridImages.length > 0 ? <ImageGrid images={gridImages} /> : null}
                      </div>
                    );
                  } else if (event.type === 'error') {
                    return (
                      <div key={`error-${event.timestamp}-${idx}`} className="step-accordion__error-entry">
                        <span className="step-accordion__error-label">⚠️ Error</span>
                        <p>{event.error}</p>
                      </div>
                    );
                  } else if (event.type === 'result') {
                    const usageInfo = formatUsage(event);
                    return (
                      <div key={`result-${event.timestamp}-${idx}`} className="step-accordion__result-entry">
                        <span className="step-accordion__result-label">✓ Run Complete</span>
                        <p>{event.text}</p>
                        {usageInfo ? (
                          <p className="step-accordion__usage">{usageInfo}</p>
                        ) : null}
                      </div>
                    );
                  } else if (event.type === 'status') {
                    return (
                      <div key={`status-${event.timestamp}-${idx}`} className="step-accordion__status-entry">
                        <span className="step-accordion__status-label">ℹ️ Status</span>
                        <p>{event.message}</p>
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            </div>
          ) : null}

          {/* No content message when filters hide everything */}
          {!hasThinking && !hasFiles && !hasTools ? (
            <p className="step-accordion__empty">
              Enable filters above to see step details.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const InsightsDrawer = memo(({
  turnSummaries,
  currentRuntime,
  isBusy,
  storylineFilters,
  onToggleStorylineFilter,
  thinkingStage,
  thinkingElapsedLabel,
  isViewSessionBusy,
  thinkingHint,
  turnStepContextByTurn,
  loadWorkspaceFile,
  onOpenConversation,
  sessionId
}: InsightsDrawerProps) => {
  const { closeInsightsDrawer, selectedInsightsTurnId, setSelectedInsightsTurnId } = useFlowPanels();
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const [copiedDebugInfo, setCopiedDebugInfo] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const handleCopyDebugInfo = useCallback(async () => {
    const lines = [
      '--- Rebel Session Debug Info ---',
      '',
      `Rebel Session ID: ${sessionId || '(unknown)'}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopiedDebugInfo(true);
      setTimeout(() => setCopiedDebugInfo(false), 2000);
    } catch {
      // Clipboard access failed - silently ignore for debug feature
    }
  }, [sessionId]);

  // Find the selected turn summary
  const selectedTurnSummary = turnSummaries.find((s) => s.turnId === selectedInsightsTurnId);

  // Get the turn context for the selected turn
  const turnContext = selectedInsightsTurnId ? turnStepContextByTurn[selectedInsightsTurnId] : undefined;

  // Compute storyline entries from the turn context
  const { storylineEntries, storylineStats } = useMemo(() => {
    if (!turnContext) {
      return {
        storylineEntries: [],
        storylineStats: { durationMs: 0, steps: 0, filesTouched: 0, toolCalls: 0, errors: 0 }
      };
    }

    const { assistantSteps, fileOperationsByStep, technicalEvents } = turnContext;
    const technicalEventsByStep = buildTechnicalEventsByStep(technicalEvents, assistantSteps);
    const entries = buildStorylineEntries(assistantSteps, fileOperationsByStep, technicalEventsByStep);

    // Compute stats
    const filesTouchedSet = new Set<string>();
    fileOperationsByStep.forEach((ops) => {
      ops.forEach((op) => {
        if (op.filePath) filesTouchedSet.add(op.filePath);
      });
    });

    const durationMs = selectedTurnSummary
      ? Math.max(0, selectedTurnSummary.lastTimestamp - selectedTurnSummary.startedAt)
      : 0;
    const toolCalls = technicalEvents.filter((event) => event.type === 'tool' && event.stage === 'start').length;
    const errors = technicalEvents.filter((event) => event.type === 'error').length;

    const stats: StorylineStats = {
      durationMs,
      steps: assistantSteps.length,
      filesTouched: filesTouchedSet.size,
      toolCalls,
      errors
    };

    return { storylineEntries: entries, storylineStats: stats };
  }, [turnContext, selectedTurnSummary]);

  // Auto-expand the latest step when entries change
  useEffect(() => {
    if (storylineEntries.length > 0) {
      setExpandedStep(storylineEntries[storylineEntries.length - 1]?.stepNumber ?? null);
    } else {
      setExpandedStep(null);
    }
  }, [storylineEntries]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isDropdownOpen]);

  const handleTurnSelect = useCallback(
    (turnId: string) => {
      setSelectedInsightsTurnId(turnId);
      setIsDropdownOpen(false);
      setExpandedStep(null);
    },
    [setSelectedInsightsTurnId]
  );

  const handleToggleStep = useCallback((stepNumber: number) => {
    setExpandedStep((prev) => (prev === stepNumber ? null : stepNumber));
  }, []);

  const getStatusLabel = (summary: InsightTurnSummary) => {
    const isLive = currentRuntime.activeTurnId === summary.turnId && isBusy;
    if (isLive) return 'Live';
    if (summary.status === 'error') return 'Error';
    if (summary.status === 'complete') return 'Complete';
    return 'Queued';
  };

  // Check if we're viewing the currently active turn
  const isViewingActiveTurn = selectedInsightsTurnId === currentRuntime.activeTurnId;
  const displayStepsCount = storylineEntries.length;

  // Extract cost and context utilization from turn's result event
  const turnUsage = useMemo(() => {
    if (!selectedInsightsTurnId || !turnContext?.technicalEvents) return null;
    return extractTurnUsage(selectedInsightsTurnId, turnContext.technicalEvents);
  }, [selectedInsightsTurnId, turnContext?.technicalEvents]);

  const turnCost = turnUsage?.costUsd ?? null;
  const contextUtilization = turnUsage?.contextUtilization ?? null;

  const statItems = [
    {
      label: 'Duration',
      value:
        storylineStats.durationMs > 0
          ? formatDurationShort(storylineStats.durationMs)
          : thinkingStage && thinkingElapsedLabel && isViewingActiveTurn
            ? thinkingElapsedLabel
            : '—'
    },
    { label: 'Steps', value: storylineStats.steps },
    { label: 'Tool calls', value: storylineStats.toolCalls },
    { label: 'Files', value: storylineStats.filesTouched },
    { label: 'Errors', value: storylineStats.errors, isError: storylineStats.errors > 0 },
    { label: 'Context', value: contextUtilization != null ? `${contextUtilization}%` : '—' },
    { label: 'Cost', value: formatCostCompact(turnCost) }
  ];

  return (
    <div className="insights-drawer">
      <header className="insights-drawer__header">
        <h3 className="insights-drawer__title">Behind the scenes</h3>
        <div className="insights-drawer__header-actions">
          {sessionId && (
            <button
              type="button"
              className="insights-drawer__copy-debug"
              onClick={handleCopyDebugInfo}
              aria-label="Copy session debug info to clipboard"
              title={
                copiedDebugInfo
                  ? 'Copied to clipboard!'
                  : 'Copy session ID to clipboard for debugging'
              }
            >
              {copiedDebugInfo ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            </button>
          )}
          <button
            type="button"
            className="insights-drawer__close"
            onClick={closeInsightsDrawer}
            aria-label="Close insights"
            title="Close"
          >
            <X size={18} aria-hidden />
          </button>
        </div>
      </header>

      {/* Turn selector dropdown */}
      <div className="insights-drawer__turn-selector" ref={dropdownRef}>
        <button
          type="button"
          className="insights-drawer__turn-button"
          onClick={() => setIsDropdownOpen(!isDropdownOpen)}
          aria-expanded={isDropdownOpen}
          aria-haspopup="listbox"
        >
          <div className="insights-drawer__turn-info">
            <span className="insights-drawer__turn-label">
              {selectedTurnSummary?.label || 'Select a turn'}
            </span>
            {selectedTurnSummary ? (
              <span className="insights-drawer__turn-time">
                {formatTimestamp(selectedTurnSummary.startedAt)}
              </span>
            ) : null}
          </div>
          <ChevronDown
            className={`insights-drawer__turn-chevron ${isDropdownOpen ? 'insights-drawer__turn-chevron--open' : ''}`}
            size={16}
            aria-hidden
          />
        </button>

        {isDropdownOpen && turnSummaries.length > 0 ? (
          <ul className="insights-drawer__turn-menu" role="listbox">
            {turnSummaries.map((summary) => {
              const isSelected = summary.turnId === selectedInsightsTurnId;
              const statusLabel = getStatusLabel(summary);
              const durationMs = Math.max(0, summary.lastTimestamp - summary.startedAt);
              const durationLabel = durationMs > 0 ? formatDurationShort(durationMs) : '—';

              return (
                <li key={summary.turnId} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    className={`insights-drawer__turn-option ${isSelected ? 'insights-drawer__turn-option--selected' : ''}`}
                    onClick={() => handleTurnSelect(summary.turnId)}
                  >
                    <div className="insights-drawer__turn-option-main">
                      <span className="insights-drawer__turn-option-label">{summary.label}</span>
                      <span className="insights-drawer__turn-option-time">
                        {formatTimestamp(summary.startedAt)}
                      </span>
                    </div>
                    <div className="insights-drawer__turn-option-meta">
                      <span
                        className="insights-drawer__turn-option-status"
                        data-status={statusLabel.toLowerCase()}
                      >
                        {statusLabel}
                      </span>
                      <span className="insights-drawer__turn-option-duration">{durationLabel}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {/* Stats bar */}
      <div className="insights-drawer__stats">
        {statItems.map((stat) => (
          <div
            key={stat.label}
            className={`insights-drawer__stat ${
              'isError' in stat && stat.isError ? 'insights-drawer__stat--error' : ''
            }`}
          >
            <span className="insights-drawer__stat-value">{stat.value}</span>
            <span className="insights-drawer__stat-label">{stat.label}</span>
          </div>
        ))}
      </div>

      {/* Filter pills */}
      <div className="insights-drawer__filters">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={`insights-drawer__filter ${storylineFilters[key] ? 'insights-drawer__filter--active' : ''}`}
            aria-pressed={storylineFilters[key]}
            onClick={() => onToggleStorylineFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Status message */}
      <p className="insights-drawer__status">
        {isViewSessionBusy && isViewingActiveTurn
          ? thinkingHint || 'Gathering workspace context'
          : displayStepsCount > 0
            ? `${displayStepsCount} step${displayStepsCount === 1 ? '' : 's'}`
            : 'No steps captured yet'}
      </p>

      {/* Step accordions */}
      <div className="insights-drawer__steps">
        {storylineEntries.length === 0 ? (
          <div className="insights-drawer__empty">
            <span>No agent steps yet</span>
            <p>Run the agent to see insights here.</p>
          </div>
        ) : (
          storylineEntries.map((entry, index) => {
            const isLastStep = index === storylineEntries.length - 1;
            const nextTimestamp = isLastStep
              ? selectedTurnSummary?.lastTimestamp
              : storylineEntries[index + 1]?.timestamp;
            const durationMs = nextTimestamp !== undefined
              ? Math.max(0, nextTimestamp - entry.timestamp)
              : undefined;
            const isLiveStep = isLastStep && isViewingActiveTurn && isBusy;

            return (
              <StepAccordion
                key={entry.stepNumber}
                entry={entry}
                isExpanded={expandedStep === entry.stepNumber}
                onToggle={() => handleToggleStep(entry.stepNumber)}
                filters={storylineFilters}
                loadWorkspaceFile={loadWorkspaceFile}
                onOpenConversation={onOpenConversation}
                sessionId={sessionId}
                durationMs={isLiveStep ? undefined : durationMs}
                isLiveStep={isLiveStep}
              />
            );
          })
        )}
      </div>
    </div>
  );
});
