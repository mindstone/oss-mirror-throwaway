// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@renderer/test-utils';
import { useConversationFiles } from '../useConversationFiles';
import type { TurnStepContext } from '../../utils/turnStepContext';
import type { FileOperation } from '@renderer/utils/fileOperations';

const makeOperation = (overrides: Partial<FileOperation>): FileOperation => ({
  toolName: 'Write',
  operation: 'write',
  filePath: '/workspace/report.md',
  timestamp: Date.now(),
  stage: 'end',
  ...overrides,
});

const makeTurnContext = (flattenedFileOperations: FileOperation[]): TurnStepContext => ({
  flattenedFileOperations,
  assistantSteps: [],
  fileOperationsByStep: new Map(),
  toolSummariesByStep: new Map(),
  technicalEvents: [],
  technicalEventsByStep: new Map(),
  modelByStep: new Map(),
  pendingTodos: [],
  missionContext: null,
  taskProgress: [],
  turnTaskDelta: {
    hasMissionSet: false,
    snapshot: [],
    touchedTaskIds: [],
    deltaTasks: [],
  },
});

describe('useConversationFiles', () => {
  it('ignores failed operations when deriving created/updated labels', () => {
    const { result } = renderHook(() =>
      useConversationFiles(
        {
          turn1: makeTurnContext([
            makeOperation({ operation: 'write', stage: 'end' }),
            makeOperation({
              operation: 'delete',
              stage: 'end',
              isError: true,
              detail: 'Error: ENOENT: no such file or directory',
            }),
          ]),
        },
        {},
      ),
    );

    expect(result.current.files).toEqual([
      {
        path: '/workspace/report.md',
        operation: 'create',
        category: 'workspace',
      },
    ]);
  });
});
