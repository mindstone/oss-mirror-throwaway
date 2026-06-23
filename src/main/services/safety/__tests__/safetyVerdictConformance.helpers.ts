import { expect } from 'vitest';
import {
  isSyncHookOutput,
  type HookJSONOutput,
  type SyncHookJSONOutput,
} from '@core/agentRuntimeTypes';

type PreToolUseHookSpecificOutput = NonNullable<SyncHookJSONOutput['hookSpecificOutput']>;

export function getHookSpecificOutput(result: HookJSONOutput): PreToolUseHookSpecificOutput | undefined {
  expect(isSyncHookOutput(result)).toBe(true);
  return (result as SyncHookJSONOutput).hookSpecificOutput as PreToolUseHookSpecificOutput | undefined;
}

export function expectBinaryHookDecision(result: HookJSONOutput): void {
  const decision = getHookSpecificOutput(result)?.permissionDecision;
  expect(decision).not.toBe('ask');
  expect(decision === undefined || decision === 'allow' || decision === 'deny').toBe(true);
}
