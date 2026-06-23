import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { SessionRuntimeState } from '../../utils/runtimeState';
import { formatDurationShort } from '@renderer/utils/formatters';
import styles from '../WorkSurface.module.css';
import { SessionStoryline } from './StepsPanel';
import { StorylineDetailPanel } from './TimelineView';
import { RunsPanel } from './RunsPanel';
import type { InsightTurnSummary, StorylineEntry, StorylineFilters, StorylineStats } from '../types';
import type { AgentTurnMessage } from '@shared/types';

type InsightSurfaceProps = {
  isViewSessionBusy: boolean;
  thinkingHint: string;
  displayStepsCount: number;
  turnSummaries: InsightTurnSummary[];
  currentRuntime: SessionRuntimeState;
  isBusy: boolean;
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
  storylineEntries: StorylineEntry[];
  storylineFilters: StorylineFilters;
  onToggleStorylineFilter: (filter: keyof StorylineFilters) => void;
  selectedStorylineEntry: StorylineEntry | null;
  onSelectStorylineStep: (stepNumber: number) => void;
  loadWorkspaceFile: (path: string) => Promise<void>;
  onOpenConversation?: (sessionId: string) => void;
  showTechnicalDetails: boolean;
  setShowTechnicalDetails: React.Dispatch<React.SetStateAction<boolean>>;
  storylineStats: StorylineStats;
  thinkingStage: 'generation' | 'processing' | null;
  thinkingElapsedLabel: string;
  messages: AgentTurnMessage[];
  editingMessageId: string | null;
  onBeginEditMessage?: (messageId: string) => void;
  /** Session the storyline events belong to. Forwarded to `StorylineDetailPanel` for `imageRef` resolution. */
  sessionId?: string;
};

const SPLIT_STORAGE_KEY = 'insight-pane-split';
const DEFAULT_SPLIT_PERCENT = 60;
const MIN_SPLIT_PERCENT = 35;
const MAX_SPLIT_PERCENT = 80;

export const InsightSurface = ({
  isViewSessionBusy,
  thinkingHint,
  displayStepsCount,
  turnSummaries,
  currentRuntime,
  isBusy,
  selectedTurnId,
  onSelectTurn,
  storylineEntries,
  storylineFilters,
  onToggleStorylineFilter,
  selectedStorylineEntry,
  onSelectStorylineStep,
  loadWorkspaceFile,
  onOpenConversation,
  showTechnicalDetails,
  setShowTechnicalDetails,
  storylineStats,
  thinkingStage,
  thinkingElapsedLabel,
  messages,
  editingMessageId,
  onBeginEditMessage,
  sessionId,
}: InsightSurfaceProps) => {
  const [isStatsTooltipVisible, setIsStatsTooltipVisible] = useState(false);
  const statsTooltipId = useId();
  const splitPaneRef = useRef<HTMLDivElement | null>(null);
  const [paneSplit, setPaneSplit] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_SPLIT_PERCENT;
    const stored = Number(window.localStorage.getItem(SPLIT_STORAGE_KEY));
    if (Number.isFinite(stored)) {
      return Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, stored));
    }
    return DEFAULT_SPLIT_PERCENT;
  });
  const [isResizing, setIsResizing] = useState(false);

  const statCards = [
    {
      label: 'Duration',
      value:
        storylineStats.durationMs > 0
          ? formatDurationShort(storylineStats.durationMs)
          : thinkingStage && thinkingElapsedLabel
            ? thinkingElapsedLabel
            : '—'
    },
    { label: 'Steps', value: storylineStats.steps },
    { label: 'Files touched', value: storylineStats.filesTouched },
    { label: 'Tool calls', value: storylineStats.toolCalls },
    { label: 'Errors', value: storylineStats.errors }
  ];

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(SPLIT_STORAGE_KEY, paneSplit.toString());
    } catch {
      // Ignore persistence failures
    }
  }, [paneSplit]);

  const updateSplitFromClientX = useCallback((clientX: number) => {
    const container = splitPaneRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    const relative = ((clientX - rect.left) / rect.width) * 100;
    const clamped = Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, relative));
    setPaneSplit(clamped);
  }, []);

  useEffect(() => {
    if (!isResizing) return undefined;
    const handlePointerMove = (event: PointerEvent) => {
      event.preventDefault();
      updateSplitFromClientX(event.clientX);
    };
    const handlePointerUp = () => {
      setIsResizing(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isResizing, updateSplitFromClientX]);

  const handleSplitterPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsResizing(true);
  }, []);

  const handleSplitterKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setPaneSplit((value) => Math.max(MIN_SPLIT_PERCENT, value - 2));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        setPaneSplit((value) => Math.min(MAX_SPLIT_PERCENT, value + 2));
      }
    },
    []
  );

  const timelineBasis = showTechnicalDetails ? paneSplit : 100;
  const detailBasis = showTechnicalDetails ? 100 - paneSplit : 0;

  return (
    <section className={styles.insightPanel} aria-label="Agent insights">
      <header className={styles.insightPanelHeader}>
        <div className={styles.insightHeaderTop}>
          <div className={styles.insightPanelTitles}>
            <div className={styles.insightTitleRow}>
              <h3>Agent insights</h3>
              <div
                className={styles.insightInfoWrapper}
                onMouseEnter={() => setIsStatsTooltipVisible(true)}
                onMouseLeave={() => setIsStatsTooltipVisible(false)}
              >
                <button
                  type="button"
                  className={styles.insightInfoButton}
                  aria-label="Show run statistics"
                  aria-expanded={isStatsTooltipVisible}
                  aria-describedby={isStatsTooltipVisible ? statsTooltipId : undefined}
                  onFocus={() => setIsStatsTooltipVisible(true)}
                  onBlur={() => setIsStatsTooltipVisible(false)}
                  title="Run statistics"
                >
                  <span className={styles.insightInfoIcon} aria-hidden>
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <circle cx="12" cy="12" r="9" />
                      <line x1="12" y1="11" x2="12" y2="16" />
                      <circle cx="12" cy="7" r="1" />
                    </svg>
                  </span>
                </button>
                <div
                  id={statsTooltipId}
                  role="tooltip"
                  className={[
                    styles.insightInfoTooltip,
                    isStatsTooltipVisible ? styles.insightInfoTooltipVisible : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-hidden={!isStatsTooltipVisible}
                >
                  <div className={styles.insightInfoList}>
                    {statCards.map((card) => (
                      <div key={card.label} className={styles.insightInfoRow}>
                        <span className={styles.insightInfoLabel}>{card.label}</span>
                        <span className={styles.insightInfoValue}>{card.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <p>
              {isViewSessionBusy
                ? thinkingHint || 'Gathering workspace context'
                : displayStepsCount > 0
                  ? `Review ${displayStepsCount} recorded step${displayStepsCount === 1 ? '' : 's'}`
                  : 'No agent steps captured yet'}
            </p>
          </div>
        </div>
      </header>
      <div className={styles.insightPanelBody}>
        <RunsPanel
          turnSummaries={turnSummaries}
          selectedTurnId={selectedTurnId}
          onSelectTurn={onSelectTurn}
          currentRuntime={currentRuntime}
          isBusy={isBusy}
        />
        <div className={styles.insightSplitPane} ref={splitPaneRef}>
          <div
            className={styles.storylineColumnWrapper}
            style={{ flexBasis: `${timelineBasis}%` }}
            aria-label="Step timeline"
          >
            <SessionStoryline
              entries={storylineEntries}
              filters={storylineFilters}
              onToggleFilter={onToggleStorylineFilter}
              selectedStep={selectedStorylineEntry?.stepNumber ?? null}
              onSelectStep={onSelectStorylineStep}
            />
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-valuemin={MIN_SPLIT_PERCENT}
            aria-valuemax={MAX_SPLIT_PERCENT}
            aria-valuenow={paneSplit}
            tabIndex={0}
            className={[styles.splitPaneDivider, isResizing ? styles.splitPaneDividerActive : '']
              .filter(Boolean)
              .join(' ')}
            onPointerDown={handleSplitterPointerDown}
            onKeyDown={handleSplitterKeyDown}
          >
            <button
              type="button"
              className={styles.splitPaneCollapseButton}
              onClick={() => setShowTechnicalDetails((value) => !value)}
              onPointerDown={(event) => event.stopPropagation()}
              aria-label={showTechnicalDetails ? 'Collapse details panel' : 'Expand details panel'}
            >
              {showTechnicalDetails ? '⟨' : '⟩'}
            </button>
          </div>
          <div
            className={[styles.storylineDetailWrapper, showTechnicalDetails ? '' : styles.storylineDetailWrapperHidden]
              .filter(Boolean)
              .join(' ')}
            style={{ flexBasis: `${detailBasis}%` }}
            aria-hidden={!showTechnicalDetails}
          >
            <StorylineDetailPanel
              entry={selectedStorylineEntry}
              filters={storylineFilters}
              showDetails={showTechnicalDetails}
              setShowDetails={setShowTechnicalDetails}
              loadWorkspaceFile={loadWorkspaceFile}
              onOpenConversation={onOpenConversation}
              sessionId={sessionId}
              messages={messages}
              editingMessageId={editingMessageId}
              onBeginEditMessage={onBeginEditMessage}
            />
          </div>
        </div>
      </div>
    </section>
  );
};