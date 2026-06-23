import { memo, useEffect, useMemo, useState } from 'react';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import type { FileOperation } from '@renderer/utils/fileOperations';
import type { SessionRuntimeState } from '../utils/runtimeState';
import { InsightSurface } from './components/InsightSurface';
import { useTimelineFilters } from './hooks/useTimelineFilters';
import {
  buildStorylineEntries,
  buildTechnicalEventsByStep
} from './utils/timelineBuilders';
import type {
  FileOperationsByStep,
  InsightTurnSummary,
  StorylineEntry,
  StorylineFilters,
  StorylineStats
} from './types';

type WorkSurfaceProps = {
  isViewSessionBusy: boolean;
  thinkingHint: string;
  thinkingElapsedLabel: string;
  displayStepsCount: number;
  turnSummaries: InsightTurnSummary[];
  selectedTurnId: string | null;
  onSelectTurn: (turnId: string) => void;
  currentRuntime: SessionRuntimeState;
  isBusy: boolean;
  storylineFilters: StorylineFilters;
  onToggleStorylineFilter: (filter: keyof StorylineFilters) => void;
  showTechnicalDetails: boolean;
  setShowTechnicalDetails: React.Dispatch<React.SetStateAction<boolean>>;
  assistantSteps: AgentEvent[];
  flattenedFileOperations: FileOperation[];
  fileOperationsByStep?: FileOperationsByStep;
  technicalEvents: AgentEvent[];
  loadWorkspaceFile: (path: string) => Promise<void>;
  onOpenConversation?: (sessionId: string) => void;
  thinkingStage: 'generation' | 'processing' | null;
  messages: AgentTurnMessage[];
  editingMessageId: string | null;
  onBeginEditMessage?: (messageId: string) => void;
  /** Session the storyline events belong to. Used for `imageRef` resolution via `rebel-asset://`. */
  sessionId?: string;
};

const WorkSurfaceComponent = ({
  isViewSessionBusy,
  thinkingHint,
  thinkingElapsedLabel,
  displayStepsCount,
  turnSummaries,
  selectedTurnId,
  onSelectTurn,
  currentRuntime,
  isBusy,
  storylineFilters,
  onToggleStorylineFilter,
  showTechnicalDetails,
  setShowTechnicalDetails,
  assistantSteps,
  flattenedFileOperations,
  fileOperationsByStep,
  technicalEvents,
  loadWorkspaceFile,
  onOpenConversation,
  thinkingStage,
  messages,
  editingMessageId,
  onBeginEditMessage,
  sessionId,
}: WorkSurfaceProps) => {
  const { fileOperationsByStep: scopedFileOperations } = useTimelineFilters({
    assistantSteps,
    flattenedFileOperations,
    initialFileOperationsByStep: fileOperationsByStep
  });

  const [selectedStep, setSelectedStep] = useState<number | null>(null);

  const technicalEventsByStep = useMemo(
    () => buildTechnicalEventsByStep(technicalEvents, assistantSteps),
    [technicalEvents, assistantSteps]
  );

  const storylineEntries = useMemo<StorylineEntry[]>(
    () => buildStorylineEntries(assistantSteps, scopedFileOperations, technicalEventsByStep),
    [assistantSteps, scopedFileOperations, technicalEventsByStep]
  );

  useEffect(() => {
    if (storylineEntries.length === 0) {
      setSelectedStep(null);
      return;
    }
    setSelectedStep((prev) => {
      if (prev && storylineEntries.some((entry) => entry.stepNumber === prev)) {
        return prev;
      }
      return storylineEntries[storylineEntries.length - 1]?.stepNumber ?? null;
    });
  }, [storylineEntries]);

  const selectedEntry = useMemo(
    () => storylineEntries.find((entry) => entry.stepNumber === selectedStep) ?? null,
    [storylineEntries, selectedStep]
  );

  const filesTouchedCount = useMemo(() => {
    const touched = new Set<string>();
    flattenedFileOperations.forEach((operation) => {
      if (operation.filePath) {
        touched.add(operation.filePath);
      }
    });
    return touched.size;
  }, [flattenedFileOperations]);

  const selectedTurnSummary = useMemo(
    () => turnSummaries.find((summary) => summary.turnId === selectedTurnId) ?? null,
    [selectedTurnId, turnSummaries]
  );

  const storylineStats = useMemo<StorylineStats>(() => {
    const durationMs = selectedTurnSummary
      ? Math.max(0, selectedTurnSummary.lastTimestamp - selectedTurnSummary.startedAt)
      : 0;
    const toolCalls = technicalEvents.filter((event) => event.type === 'tool' && event.stage === 'start').length;
    const errors = technicalEvents.filter((event) => event.type === 'error').length;
    return {
      durationMs,
      steps: assistantSteps.length,
      filesTouched: filesTouchedCount,
      toolCalls,
      errors
    };
  }, [assistantSteps, filesTouchedCount, selectedTurnSummary, technicalEvents]);

  const handleSelectStorylineStep = (stepNumber: number) => {
    setSelectedStep(stepNumber);
    setShowTechnicalDetails(true);
  };

  return (
    <InsightSurface
      isViewSessionBusy={isViewSessionBusy}
      thinkingHint={thinkingHint}
      displayStepsCount={displayStepsCount}
      turnSummaries={turnSummaries}
      currentRuntime={currentRuntime}
      isBusy={isBusy}
      selectedTurnId={selectedTurnId}
      onSelectTurn={onSelectTurn}
      storylineEntries={storylineEntries}
      storylineFilters={storylineFilters}
      onToggleStorylineFilter={onToggleStorylineFilter}
      selectedStorylineEntry={selectedEntry}
      onSelectStorylineStep={handleSelectStorylineStep}
      loadWorkspaceFile={loadWorkspaceFile}
      onOpenConversation={onOpenConversation}
      showTechnicalDetails={showTechnicalDetails}
      setShowTechnicalDetails={setShowTechnicalDetails}
      storylineStats={storylineStats}
      thinkingStage={thinkingStage}
      thinkingElapsedLabel={thinkingElapsedLabel}
      messages={messages}
      editingMessageId={editingMessageId}
      onBeginEditMessage={onBeginEditMessage}
      sessionId={sessionId}
    />
  );
};

export const WorkSurface = memo(WorkSurfaceComponent);
WorkSurface.displayName = 'WorkSurface';
