/**
 * F4 — schema-gate deny-contract integration test.
 *
 * Unlike schemaGateHook.test.ts (which unit-tests the hook's return value in
 * isolation), this drives the REAL hook runner — `createHookAwareToolExecutor`
 * (Pre → execute → Post) — to prove the full contract:
 *   1. an enforcing-mode deny becomes the MODEL-VISIBLE tool result
 *      (`{ isError: true, output: <corrective get_tool_details message> }`) and
 *      the underlying tool never executes;
 *   2. end-to-end, a SUCCESSFUL get_tool_details hydrates via the PostToolUse hook
 *      and the subsequent use_tool then executes;
 *   3. (F3 end-to-end) a FAILED get_tool_details does NOT hydrate, so use_tool
 *      stays denied through the real pipeline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHookAwareToolExecutor } from '@core/rebelCore/hookPipeline';
import type { ToolExecutionResult } from '@core/rebelCore/types';
import { createSchemaGateHook, createSchemaGatePostHook, clearSchemaGateSession } from '../schemaGateHook';

const USE_TOOL = 'mcp__super-mcp-router__use_tool';
const GET_DETAILS = 'mcp__super-mcp-router__get_tool_details';
const SID = 'integration-session';
const SIGNAL = new AbortController().signal;

const makeExecutor = (
  executeImpl?: (toolName: string, input: unknown) => Promise<ToolExecutionResult>,
) => {
  const executeTool = vi.fn(
    executeImpl ?? (async () => ({ output: 'ok', isError: false }) as ToolExecutionResult),
  );
  // Wire the REAL schema-gate hooks (Pre enforcer + Post recorder, same session)
  // through the production hook runner.
  const executor = createHookAwareToolExecutor(
    executeTool as unknown as Parameters<typeof createHookAwareToolExecutor>[0],
    {
      PreToolUse: [{ hooks: [createSchemaGateHook(SID)] }],
      PostToolUse: [{ hooks: [createSchemaGatePostHook(SID)] }],
    },
  );
  return { executor, executeTool };
};

describe('schemaGateHook integration (F4: deny contract through the real hook runner)', () => {
  beforeEach(() => {
    clearSchemaGateSession(SID);
    process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
    delete process.env.REBEL_SKIP_SCHEMA_GATE;
  });

  afterEach(() => {
    clearSchemaGateSession(SID);
    delete process.env.REBEL_ENFORCE_SCHEMA_GATE;
  });

  it('an unhydrated use_tool is DENIED: the corrective message is the model-visible result and the tool never executes', async () => {
    const { executor, executeTool } = makeExecutor();

    const result = await executor(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }, 'tu-1', SIGNAL);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('get_tool_details');
    expect(result.output).toContain('Gmail__send_email');
    // The deny short-circuits — the underlying tool must NOT run.
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('end-to-end: a successful get_tool_details hydrates (PostToolUse), then use_tool executes', async () => {
    const { executor, executeTool } = makeExecutor();

    // 1. get_tool_details runs and succeeds → PostToolUse records hydration
    const details = await executor(GET_DETAILS, { tool_ids: ['Gmail__send_email'] }, 'tu-1', SIGNAL);
    expect(details.isError).toBe(false);

    // 2. use_tool is now hydrated → executes for real
    const used = await executor(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }, 'tu-2', SIGNAL);
    expect(used.isError).toBe(false);
    expect(used.output).toBe('ok');
    expect(executeTool).toHaveBeenCalledWith(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }, 'tu-2', SIGNAL);
  });

  it('F3 end-to-end: a FAILED get_tool_details does not hydrate, so use_tool stays denied', async () => {
    const { executor, executeTool } = makeExecutor(async (toolName) =>
      toolName === GET_DETAILS
        ? { output: 'tool not found', isError: true }
        : { output: 'ok', isError: false },
    );

    const details = await executor(GET_DETAILS, { tool_ids: ['Gmail__send_email'] }, 'tu-1', SIGNAL);
    expect(details.isError).toBe(true);

    const used = await executor(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }, 'tu-2', SIGNAL);
    expect(used.isError).toBe(true);
    expect(used.output).toContain('get_tool_details');
    // get_tool_details ran (1×); use_tool was denied (never executed)
    expect(executeTool).toHaveBeenCalledTimes(1);
  });
});
