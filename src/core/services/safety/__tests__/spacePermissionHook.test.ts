/**
 * Unit tests for spacePermissionHook.ts
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isSyncHookOutput,
  type HookJSONOutput,
  type SyncHookJSONOutput,
} from '@core/agentRuntimeTypes';
import {
  createSpacePermissionHook,
  getWritableForSpacePath,
} from '../spacePermissionHook';

// Shared test helpers
const abortController = new AbortController();
const defaultOptions = { signal: abortController.signal };

function makeInput(toolName: string, toolInput: Record<string, unknown> = {}) {
  return { tool_name: toolName, tool_input: toolInput, tool_use_id: 'test-id' };
}

function getHookSpecificOutput(result: HookJSONOutput) {
  expect(isSyncHookOutput(result)).toBe(true);
  return (result as SyncHookJSONOutput).hookSpecificOutput;
}

describe('createSpacePermissionHook', () => {
  describe('blocking writes to read-only spaces', () => {
    it('blocks Edit tool targeting a read-only space', async () => {
      const hook = createSpacePermissionHook({
        getWritableForPath: () => false,
      });

      const result = await hook(
        makeInput('Edit', { file_path: '/workspace/shared-drive/doc.md' }),
        undefined,
        defaultOptions,
      );

      expect(getHookSpecificOutput(result)).toBeDefined();
      expect(getHookSpecificOutput(result)).toHaveProperty('permissionDecision', 'deny');
      expect(getHookSpecificOutput(result)).toHaveProperty(
        'permissionDecisionReason',
        expect.stringContaining('read-only space'),
      );
    });

    it('blocks Create tool targeting a read-only space', async () => {
      const hook = createSpacePermissionHook({
        getWritableForPath: () => false,
      });

      const result = await hook(
        makeInput('Create', { file_path: '/workspace/shared-drive/new-file.txt' }),
        undefined,
        defaultOptions,
      );

      expect(getHookSpecificOutput(result)).toHaveProperty('permissionDecision', 'deny');
    });

    it('blocks Write tool targeting a read-only space', async () => {
      const hook = createSpacePermissionHook({
        getWritableForPath: () => false,
      });

      const result = await hook(
        makeInput('Write', { file_path: '/workspace/shared-drive/output.txt' }),
        undefined,
        defaultOptions,
      );

      expect(getHookSpecificOutput(result)).toHaveProperty('permissionDecision', 'deny');
    });

    it('blocks str_replace_editor targeting a read-only space', async () => {
      const hook = createSpacePermissionHook({
        getWritableForPath: () => false,
      });

      const result = await hook(
        makeInput('str_replace_editor', { path: '/workspace/shared-drive/file.py' }),
        undefined,
        defaultOptions,
      );

      expect(getHookSpecificOutput(result)).toHaveProperty('permissionDecision', 'deny');
    });

    it('blocks write_file targeting a read-only space', async () => {
      const hook = createSpacePermissionHook({
        getWritableForPath: () => false,
      });

      const result = await hook(
        makeInput('write_file', { file_path: '/workspace/shared-drive/data.json' }),
        undefined,
        defaultOptions,
      );

      expect(getHookSpecificOutput(result)).toHaveProperty('permissionDecision', 'deny');
    });

    it('includes helpful error message mentioning Chief-of-Staff', async () => {
      const hook = createSpacePermissionHook({
        getWritableForPath: () => false,
      });

      const result = await hook(
        makeInput('Create', { file_path: '/workspace/shared/readme.md' }),
        undefined,
        defaultOptions,
      );

      const reason = (getHookSpecificOutput(result) as Record<string, unknown>)?.permissionDecisionReason as string;
      expect(reason).toContain('Chief-of-Staff');
      expect(reason).toContain('read-only space');
      expect(reason).toContain('cloud permission');
    });
  });

  describe('allowing writes to writable spaces', () => {
    it('allows Edit tool when writable is true', async () => {
      const hook = createSpacePermissionHook({
        getWritableForPath: () => true,
      });

      const result = await hook(
        makeInput('Edit', { file_path: '/workspace/my-space/doc.md' }),
        undefined,
        defaultOptions,
      );

      expect(result).toEqual({});
    });

    it('allows Create tool when writable is true', async () => {
      const hook = createSpacePermissionHook({
        getWritableForPath: () => true,
      });

      const result = await hook(
        makeInput('Create', { file_path: '/workspace/my-space/new-file.txt' }),
        undefined,
        defaultOptions,
      );

      expect(result).toEqual({});
    });
  });

  describe('allowing writes when writable is undefined', () => {
    it('allows write when writable status is unknown', async () => {
      const hook = createSpacePermissionHook({
        getWritableForPath: () => undefined,
      });

      const result = await hook(
        makeInput('Edit', { file_path: '/workspace/unknown-space/doc.md' }),
        undefined,
        defaultOptions,
      );

      expect(result).toEqual({});
    });
  });

  describe('handling paths outside any space', () => {
    it('allows write when path does not match any space', async () => {
      const getWritableForPath = vi.fn().mockReturnValue(undefined);
      const hook = createSpacePermissionHook({ getWritableForPath });

      const result = await hook(
        makeInput('Create', { file_path: '/some/other/directory/file.txt' }),
        undefined,
        defaultOptions,
      );

      expect(result).toEqual({});
      expect(getWritableForPath).toHaveBeenCalledWith('/some/other/directory/file.txt');
    });
  });

  describe('non-write tools are always allowed', () => {
    it.each([
      'Read',
      'Glob',
      'Grep',
      'LS',
      'WebSearch',
      'WebFetch',
      'rebel_diagnostics_check',
    ])('allows read tool %s regardless of writable status', async (toolName) => {
      const getWritableForPath = vi.fn().mockReturnValue(false);
      const hook = createSpacePermissionHook({ getWritableForPath });

      const result = await hook(
        makeInput(toolName, { file_path: '/workspace/read-only-space/doc.md' }),
        undefined,
        defaultOptions,
      );

      expect(result).toEqual({});
      // Should not even check writable status for non-write tools
      expect(getWritableForPath).not.toHaveBeenCalled();
    });
  });

  describe('missing file_path in tool_input', () => {
    it('allows write when no file_path is provided', async () => {
      const getWritableForPath = vi.fn().mockReturnValue(false);
      const hook = createSpacePermissionHook({ getWritableForPath });

      const result = await hook(
        makeInput('Edit', {}),
        undefined,
        defaultOptions,
      );

      expect(result).toEqual({});
      expect(getWritableForPath).not.toHaveBeenCalled();
    });

    it('allows write when tool_input is undefined', async () => {
      const getWritableForPath = vi.fn().mockReturnValue(false);
      const hook = createSpacePermissionHook({ getWritableForPath });

      const result = await hook(
        { tool_name: 'Edit', tool_use_id: 'test-id' },
        undefined,
        defaultOptions,
      );

      expect(result).toEqual({});
    });
  });

  describe('path extraction', () => {
    it('uses file_path from tool_input', async () => {
      const getWritableForPath = vi.fn().mockReturnValue(true);
      const hook = createSpacePermissionHook({ getWritableForPath });

      await hook(
        makeInput('Edit', { file_path: '/workspace/space/file.md' }),
        undefined,
        defaultOptions,
      );

      expect(getWritableForPath).toHaveBeenCalledWith('/workspace/space/file.md');
    });

    it('falls back to path from tool_input when file_path is absent', async () => {
      const getWritableForPath = vi.fn().mockReturnValue(true);
      const hook = createSpacePermissionHook({ getWritableForPath });

      await hook(
        makeInput('str_replace_editor', { path: '/workspace/space/file.py' }),
        undefined,
        defaultOptions,
      );

      expect(getWritableForPath).toHaveBeenCalledWith('/workspace/space/file.py');
    });

    it('prefers file_path over path when both present', async () => {
      const getWritableForPath = vi.fn().mockReturnValue(true);
      const hook = createSpacePermissionHook({ getWritableForPath });

      await hook(
        makeInput('Edit', { file_path: '/workspace/space/a.md', path: '/workspace/space/b.md' }),
        undefined,
        defaultOptions,
      );

      expect(getWritableForPath).toHaveBeenCalledWith('/workspace/space/a.md');
    });
  });

  describe('edge cases', () => {
    it('handles empty tool_name', async () => {
      const hook = createSpacePermissionHook({
        getWritableForPath: () => false,
      });

      const result = await hook(
        makeInput('', { file_path: '/workspace/read-only/file.md' }),
        undefined,
        defaultOptions,
      );

      expect(result).toEqual({});
    });

    it('handles missing tool_name', async () => {
      const hook = createSpacePermissionHook({
        getWritableForPath: () => false,
      });

      const result = await hook(
        { tool_input: { file_path: '/workspace/read-only/file.md' }, tool_use_id: 'test-id' },
        undefined,
        defaultOptions,
      );

      expect(result).toEqual({});
    });
  });
});

describe('getWritableForSpacePath', () => {
  const coreDirectory = '/workspace/core';

  it('uses the longest workspace-path prefix for nested read-only parent and writable child spaces', () => {
    const spaces = [
      { path: 'work/Mindstone', writable: false },
      { path: 'work/Mindstone/Coaches', writable: true },
    ];

    expect(
      getWritableForSpacePath('work/Mindstone/Coaches/draft.md', spaces, coreDirectory),
    ).toBe(true);
    expect(
      getWritableForSpacePath(
        'work/Mindstone/Coaches/draft.md',
        [...spaces].reverse(),
        coreDirectory,
      ),
    ).toBe(true);
  });

  it('falls back to the parent space for paths outside the writable child', () => {
    const spaces = [
      { path: 'work/Mindstone', writable: false },
      { path: 'work/Mindstone/Coaches', writable: true },
    ];

    expect(
      getWritableForSpacePath('work/Mindstone/General/draft.md', spaces, coreDirectory),
    ).toBe(false);
  });

  it('uses the deepest matching prefix across three nesting levels', () => {
    const spaces = [
      { path: 'work', writable: false },
      { path: 'work/Mindstone', writable: false },
      { path: 'work/Mindstone/Coaches', writable: true },
    ];

    expect(
      getWritableForSpacePath('work/Mindstone/Coaches/draft.md', spaces, coreDirectory),
    ).toBe(true);
  });

  it('returns undefined when no space matches', () => {
    expect(
      getWritableForSpacePath(
        'personal/notes.md',
        [{ path: 'work/Mindstone', writable: false }],
        coreDirectory,
      ),
    ).toBeUndefined();
  });

  it('keeps first-declared wins for identical-length prefix ties', () => {
    const spaces = [
      { path: 'work/Mindstone', writable: false },
      { path: 'work/Mindstone', writable: true },
    ];

    expect(getWritableForSpacePath('work/Mindstone/draft.md', spaces, coreDirectory)).toBe(
      false,
    );
    expect(
      getWritableForSpacePath('work/Mindstone/draft.md', [...spaces].reverse(), coreDirectory),
    ).toBe(true);
  });

  it('matches both workspace paths and sourcePath targets', () => {
    const spaces = [
      { path: 'work/Mindstone', sourcePath: '/cloud/Mindstone', writable: false },
      {
        path: 'work/Mindstone/Coaches',
        sourcePath: '/cloud/Mindstone/Coaches',
        writable: true,
      },
    ];

    expect(
      getWritableForSpacePath('work/Mindstone/Coaches/draft.md', spaces, coreDirectory),
    ).toBe(true);
    expect(
      getWritableForSpacePath('/cloud/Mindstone/Coaches/draft.md', spaces, coreDirectory),
    ).toBe(true);
  });
});
