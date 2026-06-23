import { createScopedLogger } from '@core/logger';
import { isSyncHookOutput } from '@core/agentRuntimeTypes';
import type { HookJSONOutput } from '@core/agentRuntimeTypes';
import type {
  ExecuteToolFn,
  HookExecutionContext,
  RebelCoreHookMatcher,
  RebelCoreHooks,
  ToolExecutionResult,
} from './types';
import { curateToolOutput, ENABLE_TOOL_OUTPUT_CURATION, CURATION_THRESHOLD_CHARS, type CurationContext } from './toolOutputCurator';

const log = createScopedLogger({ service: 'rebelCoreHookPipeline' });

const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

const getHookTimeoutMs = (matcher: RebelCoreHookMatcher): number => {
  if (typeof matcher.timeout === 'number' && Number.isFinite(matcher.timeout) && matcher.timeout > 0) {
    return matcher.timeout * 1_000;
  }
  return DEFAULT_HOOK_TIMEOUT_MS;
};

const matchToolName = (matcher: string | undefined, toolName: string): boolean => {
  if (!matcher || matcher === '*') {
    return true;
  }

  const escaped = matcher
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*/g, '.*');

  try {
    return new RegExp(`^${escaped}$`, 'i').test(toolName);
  } catch {
    return matcher === toolName;
  }
};

const buildBaseHookInput = (context: HookExecutionContext = {}) => ({
  session_id: context.sessionId ?? 'rebel-core',
  transcript_path: context.transcriptPath ?? '',
  cwd: context.cwd ?? process.cwd(),
  permission_mode: context.permissionMode,
});

const runHookWithTimeout = async (
  hook: RebelCoreHookMatcher['hooks'][number],
  hookInput: unknown,
  toolUseId: string | undefined,
  context: HookExecutionContext,
  timeoutMs: number,
): Promise<HookJSONOutput | null> => {
  let timeout: NodeJS.Timeout | undefined;

  try {
    const hookPromise = hook(hookInput as never, toolUseId, {
      signal: context.signal ?? new AbortController().signal,
    });

    const timeoutPromise = new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), timeoutMs);
    });

    const result = await Promise.race([hookPromise, timeoutPromise]);
    if (result === null) {
      log.warn({ toolUseId, timeoutMs }, 'Hook timed out; continuing fail-open');
      return null;
    }
    return result;
  } catch (error) {
    log.warn({ err: error, toolUseId }, 'Hook execution failed; continuing fail-open');
    return null;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const getPreToolDenyReason = (output: HookJSONOutput): string => {
  if (!isSyncHookOutput(output)) {
    return 'Tool call blocked by PreToolUse hook';
  }

  if (typeof output.stopReason === 'string' && output.stopReason.length > 0) {
    return output.stopReason;
  }

  if (typeof output.reason === 'string' && output.reason.length > 0) {
    return output.reason;
  }

  const rawHso: unknown = output.hookSpecificOutput;
  const hookSpecificOutput = isRecord(rawHso) ? rawHso : null;
  if (hookSpecificOutput && typeof hookSpecificOutput.permissionDecisionReason === 'string') {
    return hookSpecificOutput.permissionDecisionReason;
  }

  return 'Tool call blocked by PreToolUse hook';
};

const shouldBlockPreToolUse = (output: HookJSONOutput): boolean => {
  if (!isSyncHookOutput(output)) {
    return false;
  }

  if (output.continue === false) {
    return true;
  }

  const rawHso: unknown = output.hookSpecificOutput;
  const hookSpecificOutput = isRecord(rawHso) ? rawHso : null;
  if (!hookSpecificOutput) {
    return false;
  }

  return (
    hookSpecificOutput.permissionDecision === 'deny' ||
    hookSpecificOutput.permissionDecision === 'ask'
  );
};

const getUpdatedToolInput = (output: HookJSONOutput): unknown => {
  if (!isSyncHookOutput(output)) {
    return undefined;
  }

  const rawHso: unknown = output.hookSpecificOutput;
  const hookSpecificOutput = isRecord(rawHso) ? rawHso : null;
  if (hookSpecificOutput && isRecord(hookSpecificOutput.updatedInput)) {
    return hookSpecificOutput.updatedInput;
  }

  return undefined;
};

/**
 * Extract a replace result from hook output.
 * When present, the tool call is short-circuited and the replace result
 * is returned directly — the tool never executes.
 */
const getReplaceResult = (output: HookJSONOutput): ToolExecutionResult | undefined => {
  if (!isSyncHookOutput(output)) return undefined;
  const rawHso: unknown = output.hookSpecificOutput;
  const hookSpecificOutput = isRecord(rawHso) ? rawHso : null;
  if (!hookSpecificOutput) return undefined;
  const replaceResult = isRecord(hookSpecificOutput.replaceResult) ? hookSpecificOutput.replaceResult : undefined;
  if (!replaceResult) return undefined;
  if (typeof replaceResult.output !== 'string') return undefined;
  if (typeof replaceResult.isError !== 'boolean') return undefined;
  return { output: replaceResult.output, isError: replaceResult.isError };
};

export interface PreToolUseHookResult {
  shouldExecute: boolean;
  input: unknown;
  /**
   * Result to return when shouldExecute is false.
   * Used for both blocked results (isError: true) and replacement results (isError: false).
   * When isError is false, the tool call was successfully replaced by a hook (e.g., hybrid search intercept).
   */
  blockedResult?: ToolExecutionResult;
}

export const runPreToolUseHooks = async (
  matchers: RebelCoreHookMatcher[] | undefined,
  params: {
    toolName: string;
    input: unknown;
    toolUseId: string;
    context?: HookExecutionContext;
  },
): Promise<PreToolUseHookResult> => {
  const context = params.context ?? {};
  let nextInput = params.input;

  for (const matcher of matchers ?? []) {
    if (!matchToolName(matcher.matcher, params.toolName)) {
      continue;
    }

    for (const hook of matcher.hooks) {
      const hookInput = {
        ...buildBaseHookInput(context),
        hook_event_name: 'PreToolUse' as const,
        tool_name: params.toolName,
        tool_input: nextInput,
        tool_use_id: params.toolUseId,
      };

      const output = await runHookWithTimeout(
        hook,
        hookInput,
        params.toolUseId,
        context,
        getHookTimeoutMs(matcher),
      );

      if (!output) {
        continue;
      }

      const updatedInput = getUpdatedToolInput(output);
      if (updatedInput !== undefined) {
        nextInput = updatedInput;
      }

      // Check for replace result BEFORE block check
      // (both use continue:false but replace returns isError:false)
      const replaceResult = getReplaceResult(output);
      if (replaceResult) {
        return {
          shouldExecute: false,
          input: nextInput,
          blockedResult: replaceResult,
        };
      }

      if (shouldBlockPreToolUse(output)) {
        return {
          shouldExecute: false,
          input: nextInput,
          blockedResult: {
            output: getPreToolDenyReason(output),
            isError: true,
          },
        };
      }
    }
  }

  return {
    shouldExecute: true,
    input: nextInput,
  };
};

export const runPostToolUseHooks = async (
  matchers: RebelCoreHookMatcher[] | undefined,
  params: {
    toolName: string;
    input: unknown;
    toolUseId: string;
    result: ToolExecutionResult;
    context?: HookExecutionContext;
  },
): Promise<void> => {
  const context = params.context ?? {};

  for (const matcher of matchers ?? []) {
    if (!matchToolName(matcher.matcher, params.toolName)) {
      continue;
    }

    for (const hook of matcher.hooks) {
      const hookInput = {
        ...buildBaseHookInput(context),
        hook_event_name: 'PostToolUse' as const,
        tool_name: params.toolName,
        tool_input: params.input,
        tool_response: params.result,
        tool_use_id: params.toolUseId,
      };

      await runHookWithTimeout(
        hook,
        hookInput,
        params.toolUseId,
        context,
        getHookTimeoutMs(matcher),
      );
    }
  }
};

const shouldContinueFromStopHook = (output: HookJSONOutput): boolean => {
  if (!isSyncHookOutput(output)) {
    return false;
  }

  return output.decision === 'block' || output.continue === false;
};

const getStopHookContinueReason = (output: HookJSONOutput): string | undefined => {
  if (!isSyncHookOutput(output)) {
    return undefined;
  }

  if (typeof output.stopReason === 'string' && output.stopReason.length > 0) {
    return output.stopReason;
  }
  if (typeof output.reason === 'string' && output.reason.length > 0) {
    return output.reason;
  }

  const rawHso: unknown = output.hookSpecificOutput;
  const hookSpecificOutput = isRecord(rawHso) ? rawHso : null;
  if (hookSpecificOutput && typeof hookSpecificOutput.permissionDecisionReason === 'string') {
    return hookSpecificOutput.permissionDecisionReason;
  }

  return undefined;
};

export interface StopHookRunResult {
  shouldContinue: boolean;
  reason?: string;
}

export const runStopHooksWithReason = async (
  matchers: RebelCoreHookMatcher[] | undefined,
  context: HookExecutionContext = {},
): Promise<StopHookRunResult> => {
  for (const matcher of matchers ?? []) {
    for (const hook of matcher.hooks) {
      const hookInput = {
        ...buildBaseHookInput(context),
        hook_event_name: 'Stop' as const,
        stop_hook_active: context.stopHookActive ?? false,
      };

      const output = await runHookWithTimeout(
        hook,
        hookInput,
        undefined,
        context,
        getHookTimeoutMs(matcher),
      );

      if (output && shouldContinueFromStopHook(output)) {
        const reason = getStopHookContinueReason(output);
        return {
          shouldContinue: true,
          ...(reason ? { reason } : {}),
        };
      }
    }
  }

  return { shouldContinue: false };
};

export const runStopHooks = async (
  matchers: RebelCoreHookMatcher[] | undefined,
  context: HookExecutionContext = {},
): Promise<boolean> => {
  const result = await runStopHooksWithReason(matchers, context);
  return result.shouldContinue;
};

/**
 * Run SubagentStart hooks before spawning a sub-agent.
 * Returns additionalContext to inject into the sub-agent's system prompt.
 */
export const runSubagentStartHooks = async (
  matchers: RebelCoreHookMatcher[] | undefined,
  context: HookExecutionContext = {},
): Promise<string | undefined> => {
  let additionalContext: string | undefined;

  for (const matcher of matchers ?? []) {
    for (const hook of matcher.hooks) {
      const hookInput = {
        ...buildBaseHookInput(context),
        hook_event_name: 'SubagentStart' as const,
      };

      const output = await runHookWithTimeout(
        hook,
        hookInput,
        undefined,
        context,
        getHookTimeoutMs(matcher),
      );

      if (output && isSyncHookOutput(output)) {
        const rawHso: unknown = output.hookSpecificOutput;
        const hookSpecific = isRecord(rawHso) ? rawHso : null;
        if (hookSpecific && typeof hookSpecific.additionalContext === 'string') {
          additionalContext = additionalContext
            ? `${additionalContext}\n\n${hookSpecific.additionalContext}`
            : hookSpecific.additionalContext;
        }
      }
    }
  }

  return additionalContext;
};

/**
 * Run SubagentStop hooks after a sub-agent completes.
 * Returns true if the agent should continue (same as Stop hooks).
 */
export const runSubagentStopHooks = async (
  matchers: RebelCoreHookMatcher[] | undefined,
  context: HookExecutionContext = {},
): Promise<boolean> => {
  for (const matcher of matchers ?? []) {
    for (const hook of matcher.hooks) {
      const hookInput = {
        ...buildBaseHookInput(context),
        hook_event_name: 'SubagentStop' as const,
      };

      const output = await runHookWithTimeout(
        hook,
        hookInput,
        undefined,
        context,
        getHookTimeoutMs(matcher),
      );

      if (output && shouldContinueFromStopHook(output)) {
        return true;
      }
    }
  }

  return false;
};

export interface HookAwareToolExecutorOptions {
  curationContext?: CurationContext;
}

export const createHookAwareToolExecutor = (
  executeTool: ExecuteToolFn,
  hooks: RebelCoreHooks | undefined,
  context: HookExecutionContext = {},
  options?: HookAwareToolExecutorOptions,
): ExecuteToolFn => {
  return async (toolName: string, input: unknown, toolUseId: string, signal: AbortSignal): Promise<ToolExecutionResult> => {
    const preTool = await runPreToolUseHooks(hooks?.PreToolUse, {
      toolName,
      input,
      toolUseId,
      context,
    });

    if (!preTool.shouldExecute) {
      return preTool.blockedResult ?? {
        output: 'Tool call blocked by PreToolUse hook',
        isError: true,
      };
    }

    const result = await executeTool(toolName, preTool.input, toolUseId, signal);

    // PostToolUse hooks see RAW output (preserves existing hook behavior)
    await runPostToolUseHooks(hooks?.PostToolUse, {
      toolName,
      input: preTool.input,
      toolUseId,
      result,
      context,
    });

    // Tool output curation runs AFTER hooks, before return to agent loop.
    // Only curates non-error outputs above threshold. Fail-open on any error.
    if (ENABLE_TOOL_OUTPUT_CURATION
        && options?.curationContext
        && !result.isError
        && result.output.length > CURATION_THRESHOLD_CHARS) {
      const curated = await curateToolOutput(
        toolName,
        result.output,
        options.curationContext,
        context.signal,
      );
      if (curated.wasCurated) {
        return {
          output: curated.output,
          isError: false,
          ...(result.imageContent ? { imageContent: result.imageContent } : {}),
          ...(result.imageRef ? { imageRef: result.imageRef } : {}),
          ...(result.meta !== undefined ? { meta: result.meta } : {}),
          ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        };
      }
    }

    return result;
  };
};
