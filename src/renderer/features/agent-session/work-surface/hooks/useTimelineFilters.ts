import { useMemo } from 'react';
import type { AgentEvent } from '@shared/types';
import type { FileOperation } from '@renderer/utils/fileOperations';
import { groupFileOperationsByStep } from '../utils/timelineBuilders';
import type { FileOperationsByStep } from '../types';

type UseTimelineFiltersArgs = {
  assistantSteps: AgentEvent[];
  flattenedFileOperations: FileOperation[];
  initialFileOperationsByStep?: FileOperationsByStep;
};

type UseTimelineFiltersResult = {
  fileOperationsByStep: FileOperationsByStep;
};

export const useTimelineFilters = (args: UseTimelineFiltersArgs): UseTimelineFiltersResult => {
  const { flattenedFileOperations, initialFileOperationsByStep } = args;

  const fileOperationsByStep = useMemo(() => {
    if (initialFileOperationsByStep) {
      return initialFileOperationsByStep;
    }
    return groupFileOperationsByStep(flattenedFileOperations);
  }, [flattenedFileOperations, initialFileOperationsByStep]);

  return {
    fileOperationsByStep
  };
};
