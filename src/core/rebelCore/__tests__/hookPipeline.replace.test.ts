import { describe, expect, it, vi } from 'vitest';
import type { HookJSONOutput } from '@core/agentRuntimeTypes';
import { createHookAwareToolExecutor, runPreToolUseHooks } from '../hookPipeline';
import type { ToolExecutionResult } from '../types';

const TOOL_NAME = 'mcp__super-mcp-router__search_tools';
const TOOL_USE_ID = 'tool-use-1';
const ORIGINAL_INPUT = { query: 'find tools' };
const TEST_SIGNAL = new AbortController().signal;

const toHookOutput = (value: unknown): HookJSONOutput => value as HookJSONOutput;

const createExecutor = (
  hookOutputs: HookJSONOutput[],
  executeResult: ToolExecutionResult = { output: 'executed', isError: false },
) => {
  const executeTool = vi.fn(async () => executeResult);
  const hooks = hookOutputs.map((output) => vi.fn(async () => output));

  const executor = createHookAwareToolExecutor(
    executeTool,
    {
      PreToolUse: [{ hooks }],
    },
  );

  return { executor, executeTool, hooks };
};

describe('hookPipeline replace semantics', () => {
  it('replace result short-circuits tool execution', async () => {
    const { executor, executeTool } = createExecutor([
      toHookOutput({
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          replaceResult: {
            output: '{"results":[],"query":"find tools"}',
            isError: false,
          },
        },
      }),
    ]);

    const result = await executor(TOOL_NAME, ORIGINAL_INPUT, TOOL_USE_ID, TEST_SIGNAL);

    expect(result).toEqual({
      output: '{"results":[],"query":"find tools"}',
      isError: false,
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('replace result with isError:true works', async () => {
    const { executor, executeTool } = createExecutor([
      toHookOutput({
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          replaceResult: {
            output: 'replacement error',
            isError: true,
          },
        },
      }),
    ]);

    const result = await executor(TOOL_NAME, ORIGINAL_INPUT, TOOL_USE_ID, TEST_SIGNAL);

    expect(result).toEqual({
      output: 'replacement error',
      isError: true,
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('replace takes precedence over block from same hook', async () => {
    const { executor, executeTool } = createExecutor([
      toHookOutput({
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'deny reason should not win',
          replaceResult: {
            output: 'replacement wins',
            isError: false,
          },
        },
      }),
    ]);

    const result = await executor(TOOL_NAME, ORIGINAL_INPUT, TOOL_USE_ID, TEST_SIGNAL);

    expect(result).toEqual({
      output: 'replacement wins',
      isError: false,
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('replace from first hook prevents later hooks from running', async () => {
    const firstHook = vi.fn(async () =>
      toHookOutput({
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          replaceResult: {
            output: 'first hook replacement',
            isError: false,
          },
        },
      }),
    );
    const secondHook = vi.fn(async () =>
      toHookOutput({
        continue: true,
      }),
    );
    const executeTool = vi.fn(async () => ({ output: 'executed', isError: false }));
    const executor = createHookAwareToolExecutor(executeTool, {
      PreToolUse: [{ hooks: [firstHook, secondHook] }],
    });

    const result = await executor(TOOL_NAME, ORIGINAL_INPUT, TOOL_USE_ID, TEST_SIGNAL);

    expect(result).toEqual({
      output: 'first hook replacement',
      isError: false,
    });
    expect(firstHook).toHaveBeenCalledTimes(1);
    expect(secondHook).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('invalid replaceResult falls through', async () => {
    const blocked = await runPreToolUseHooks(
      [
        {
          hooks: [
            async () =>
              toHookOutput({
                continue: false,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: 'fallback deny',
                  replaceResult: {
                    isError: false,
                  },
                },
              }),
          ],
        },
      ],
      {
        toolName: TOOL_NAME,
        input: ORIGINAL_INPUT,
        toolUseId: TOOL_USE_ID,
      },
    );

    expect(blocked).toEqual({
      shouldExecute: false,
      input: ORIGINAL_INPUT,
      blockedResult: {
        output: 'fallback deny',
        isError: true,
      },
    });

    const continued = await runPreToolUseHooks(
      [
        {
          hooks: [
            async () =>
              toHookOutput({
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  replaceResult: {
                    output: 'missing isError should not replace',
                  },
                },
              }),
          ],
        },
      ],
      {
        toolName: TOOL_NAME,
        input: ORIGINAL_INPUT,
        toolUseId: TOOL_USE_ID,
      },
    );

    expect(continued).toEqual({
      shouldExecute: true,
      input: ORIGINAL_INPUT,
    });
  });

  it('existing block behavior unchanged', async () => {
    const { executor, executeTool } = createExecutor([
      toHookOutput({
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'existing deny',
        },
      }),
    ]);

    const result = await executor(TOOL_NAME, ORIGINAL_INPUT, TOOL_USE_ID, TEST_SIGNAL);

    expect(result).toEqual({
      output: 'existing deny',
      isError: true,
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('existing allow behavior unchanged', async () => {
    const { executor, executeTool } = createExecutor([
      toHookOutput({
        continue: true,
      }),
    ]);

    const result = await executor(TOOL_NAME, ORIGINAL_INPUT, TOOL_USE_ID, TEST_SIGNAL);

    expect(result).toEqual({
      output: 'executed',
      isError: false,
    });
    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool).toHaveBeenCalledWith(
      TOOL_NAME,
      ORIGINAL_INPUT,
      TOOL_USE_ID,
      TEST_SIGNAL,
    );
  });
});

describe('replace integration with createHookAwareToolExecutor', () => {
  it('hook replacement short-circuits tool execution via executor', async () => {
    const replaceHook = vi.fn(async () =>
      toHookOutput({
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          replaceResult: {
            output: '{"results":[{"name":"Search"}]}',
            isError: false,
          },
        },
      }),
    );
    const executeTool = vi.fn(async () => ({ output: 'executed', isError: false }));
    const executor = createHookAwareToolExecutor(executeTool, {
      PreToolUse: [{ hooks: [replaceHook] }],
    });

    const result = await executor(TOOL_NAME, ORIGINAL_INPUT, TOOL_USE_ID, TEST_SIGNAL);

    expect(result).toEqual({
      output: '{"results":[{"name":"Search"}]}',
      isError: false,
    });
    expect(replaceHook).toHaveBeenCalledTimes(1);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('PostToolUse hooks do NOT run for replaced tools', async () => {
    const replaceHook = vi.fn(async () =>
      toHookOutput({
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          replaceResult: {
            output: '{"results":[]}',
            isError: false,
          },
        },
      }),
    );
    const postHook = vi.fn(async () => toHookOutput({ continue: true }));
    const executeTool = vi.fn(async () => ({ output: 'executed', isError: false }));
    const executor = createHookAwareToolExecutor(executeTool, {
      PreToolUse: [{ hooks: [replaceHook] }],
      PostToolUse: [{ hooks: [postHook] }],
    });

    const result = await executor(TOOL_NAME, ORIGINAL_INPUT, TOOL_USE_ID, TEST_SIGNAL);

    expect(result).toEqual({
      output: '{"results":[]}',
      isError: false,
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(postHook).not.toHaveBeenCalled();
  });

  it('hook replacement with multiple PreToolUse hooks — replace from first prevents later hooks', async () => {
    const firstReplaceHook = vi.fn(async () =>
      toHookOutput({
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          replaceResult: {
            output: 'first replacement',
            isError: false,
          },
        },
      }),
    );
    const secondHook = vi.fn(async () => toHookOutput({ continue: true }));
    const executeTool = vi.fn(async () => ({ output: 'executed', isError: false }));
    const executor = createHookAwareToolExecutor(executeTool, {
      PreToolUse: [{ hooks: [firstReplaceHook] }, { hooks: [secondHook] }],
    });

    const result = await executor(TOOL_NAME, ORIGINAL_INPUT, TOOL_USE_ID, TEST_SIGNAL);

    expect(result).toEqual({
      output: 'first replacement',
      isError: false,
    });
    expect(firstReplaceHook).toHaveBeenCalledTimes(1);
    expect(secondHook).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });
});
