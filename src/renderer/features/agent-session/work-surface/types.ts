import type { AgentEvent } from '@shared/types';
import type { FileOperation } from '@renderer/utils/fileOperations';

export type WorkSurfaceView = 'session' | 'insights' | 'diagnostics';

export type StorylineFilters = {
  thinking: boolean;
  files: boolean;
  tools: boolean;
};

export const DEFAULT_STORYLINE_FILTERS: StorylineFilters = {
  thinking: true,
  files: true,
  tools: true
};

export const STORYLINE_FILTER_STORAGE_KEY = 'storyline-filters';

export type StorylineEntry = {
  stepNumber: number;
  timestamp: number;
  thinkingEvent: AgentEvent;
  fileOperations: FileOperation[];
  technicalEvents: AgentEvent[];
};

export type StorylineStats = {
  durationMs: number;
  steps: number;
  filesTouched: number;
  toolCalls: number;
  errors: number;
};

export type InsightTurnSummary = {
  turnId: string;
  label: string;
  startedAt: number;
  lastTimestamp: number;
  status: 'running' | 'complete' | 'error';
};

export type FileOperationsByStep = Map<number, FileOperation[]>;

