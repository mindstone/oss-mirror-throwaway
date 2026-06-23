import type { AgentEvent } from '@shared/types';
import { extractFileOperations, type FileOperation } from '@renderer/utils/fileOperations';
import { type FileOperationsByStep, type StorylineEntry } from '../types';

type StepWindow = {
  stepNumber: number;
  start: number;
  end: number;
};

const buildStepWindows = (assistantSteps: AgentEvent[]): StepWindow[] =>
  assistantSteps.map((step, index) => ({
    stepNumber: index + 1,
    start: step.timestamp,
    end: index < assistantSteps.length - 1 ? assistantSteps[index + 1].timestamp : Number.POSITIVE_INFINITY
  }));

export const buildAssistantSteps = (
  assistantEvents: AgentEvent[],
  hasResultEvent: boolean,
  hasToolEvents: boolean = false
): AgentEvent[] => {
  if (assistantEvents.length === 0) return [];
  
  // If tools were used, show all steps in real-time (activity is meaningful)
  // Users want to see what's happening as it happens, not just after completion
  if (hasToolEvents) {
    return assistantEvents;
  }
  
  // For running turns (no result yet), always show steps so users can see activity
  // This ensures the Activity section is visible when navigating between parallel agents
  if (!hasResultEvent) {
    return assistantEvents;
  }
  
  // Completed turn with no tools - only show steps if there are MULTIPLE thinking steps
  // A single message with no tools is just a simple reply, no Activity needed
  if (assistantEvents.length <= 1) return [];
  
  // Multiple thinking steps without tools - show them
  return assistantEvents;
};

export const buildFileOperationData = (
  toolEvents: AgentEvent[],
  assistantSteps: AgentEvent[]
): { fileOperationsByStep: FileOperationsByStep; flattenedFileOperations: FileOperation[] } => {
  const operationsMap: FileOperationsByStep = new Map();
  const allOperations = extractFileOperations(toolEvents);

  if (assistantSteps.length === 0) {
    return {
      fileOperationsByStep: operationsMap,
      flattenedFileOperations: allOperations.sort((a, b) => a.timestamp - b.timestamp)
    };
  }

  const windows = buildStepWindows(assistantSteps);

  const flattenedList: FileOperation[] = [];

  for (const operation of allOperations) {
    let targetWindow = windows.find(
      (segment) => operation.timestamp >= segment.start && operation.timestamp < segment.end
    );

    if (!targetWindow && operation.timestamp < windows[0].start) {
      targetWindow = windows[0];
    }

    if (targetWindow) {
      const opWithStep: FileOperation = { ...operation, stepNumber: targetWindow.stepNumber };
      const existing = operationsMap.get(targetWindow.stepNumber) ?? [];
      operationsMap.set(targetWindow.stepNumber, [...existing, opWithStep]);
      flattenedList.push(opWithStep);
    } else {
      flattenedList.push(operation);
    }
  }

  flattenedList.sort((a, b) => a.timestamp - b.timestamp);

  return {
    fileOperationsByStep: operationsMap,
    flattenedFileOperations: flattenedList
  };
};

export const groupFileOperationsByStep = (operations: FileOperation[]): FileOperationsByStep => {
  const map: FileOperationsByStep = new Map();
  for (const operation of operations) {
    if (typeof operation.stepNumber !== 'number') continue;
    const list = map.get(operation.stepNumber) ?? [];
    map.set(operation.stepNumber, [...list, operation]);
  }
  return map;
};

export const buildTechnicalEventsByStep = (
  events: AgentEvent[],
  assistantSteps: AgentEvent[]
): Map<number, AgentEvent[]> => {
  const map = new Map<number, AgentEvent[]>();
  if (assistantSteps.length === 0 || events.length === 0) {
    return map;
  }

  const windows = buildStepWindows(assistantSteps);
  const firstWindow = windows[0];
  const lastWindow = windows[windows.length - 1];

  for (const event of events) {
    let targetWindow = windows.find(
      (segment) => event.timestamp >= segment.start && event.timestamp < segment.end
    );

    if (!targetWindow) {
      if (event.timestamp < firstWindow.start) {
        targetWindow = firstWindow;
      } else if (event.timestamp >= lastWindow.end) {
        targetWindow = lastWindow;
      }
    }

    if (!targetWindow) {
      continue;
    }

    const existing = map.get(targetWindow.stepNumber) ?? [];
    map.set(targetWindow.stepNumber, [...existing, event]);
  }

  return map;
};

export const buildStorylineEntries = (
  assistantSteps: AgentEvent[],
  fileOperationsByStep: FileOperationsByStep,
  technicalEventsByStep: Map<number, AgentEvent[]>
): StorylineEntry[] =>
  assistantSteps.map((step, index) => {
    const stepNumber = index + 1;
    return {
      stepNumber,
      timestamp: step.timestamp,
      thinkingEvent: step,
      fileOperations: fileOperationsByStep.get(stepNumber) ?? [],
      technicalEvents: technicalEventsByStep.get(stepNumber) ?? []
    };
  });
