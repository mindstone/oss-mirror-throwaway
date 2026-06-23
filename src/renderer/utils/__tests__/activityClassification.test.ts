import { describe, expect, it } from 'vitest';
import { categorizeFileActivity } from '../activityClassification';
import type { FileOperation } from '../fileOperations';

const makeOperation = (overrides: Partial<FileOperation>): FileOperation => ({
  toolName: 'Write',
  operation: 'write',
  filePath: '/workspace/report.md',
  timestamp: Date.now(),
  stage: 'end',
  ...overrides,
});

describe('categorizeFileActivity', () => {
  it('does not show failed workspace writes as created files', () => {
    const activity = categorizeFileActivity([
      makeOperation({ stage: 'start' }),
      makeOperation({
        stage: 'end',
        isError: true,
        detail: 'Error: ENOENT: no such file or directory',
      }),
    ]);

    expect(activity.workspaceWrites).toEqual([]);
  });

  it('counts successful workspace writes', () => {
    const activity = categorizeFileActivity([
      makeOperation({ stage: 'start' }),
      makeOperation({ stage: 'end', detail: 'File written successfully' }),
    ]);

    expect(activity.workspaceWrites).toEqual(['/workspace/report.md']);
  });

  it('does not show failed reads as referenced files', () => {
    const activity = categorizeFileActivity([
      makeOperation({
        toolName: 'Read',
        operation: 'read',
        filePath: '/workspace/memory/topics/profile.md',
        stage: 'end',
        isError: true,
      }),
    ]);

    expect(activity.memoryReads).toEqual([]);
  });
});
