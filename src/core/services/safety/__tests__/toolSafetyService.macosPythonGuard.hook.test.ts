/**
 * Hook-level (createToolSafetyHook) test for the macOS CLT shim guard
 * (FOX-3482 / REBEL-674). Pins the END-TO-END deny shape produced by the hook:
 *   - the Bash tool is DENIED,
 *   - the response carries NO `continue:false` (turn continues so the agent can
 *     pivot — `continue:false` is the stop-shaped response), and
 *   - the agent-facing reason (permissionDecisionReason) surfaces the calm,
 *     don't-retry steering message rather than a terse stopReason (which would
 *     otherwise SHADOW it in getPreToolDenyReason, hookPipeline.ts).
 *
 * The helper-level no-exec-of-the-shim invariant is covered in
 * pythonRuntimeService.test.ts; here `macosCommandResolvesToCltShim` is
 * mocked to isolate the hook wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { HookCallback, SyncHookJSONOutput } from '@core/agentRuntimeTypes';

const { mockResolvesToCltShim, mockSendToAllWindows } = vi.hoisted(() => ({
  mockResolvesToCltShim: vi.fn(),
  mockSendToAllWindows: vi.fn(),
}));

vi.mock('@main/services/pythonRuntimeService', () => ({
  MACOS_CLT_SHIM_BINARY_NAMES: [
    'python',
    'python3',
    'pip',
    'pip3',
    'git',
    'clang',
    'clang++',
    'make',
    'swift',
    'swiftc',
    'lldb',
    'gcc',
    'g++',
    'ld',
    'strip',
    'nm',
    'otool',
  ],
  macosCommandResolvesToCltShim: mockResolvesToCltShim,
  macosCommandResolvesToPythonShim: mockResolvesToCltShim,
  checkPythonRuntime: vi.fn(),
}));

vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getApprovalHandler: vi.fn(() => undefined),
    recordSecurityDenial: vi.fn(),
    recordToolCall: vi.fn(),
    incrementAutomationSafetyBlock: vi.fn(),
    getAutomationSafetyBlockCount: vi.fn().mockReturnValue(0),
  },
}));

vi.mock('@main/services/safety', () => ({
  addPendingApproval: vi.fn(),
  removePendingApproval: vi.fn(),
  getPendingApprovals: vi.fn().mockReturnValue([]),
  clearPendingApprovalsForSession: vi.fn().mockReturnValue([]),
  storeSingleUseApproval: vi.fn(),
  consumeSingleUseApproval: vi.fn().mockReturnValue(false),
  clearSessionSingleUseApprovals: vi.fn(),
}));

vi.mock('@main/services/safety/stagedToolCallsService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/services/safety/stagedToolCallsService')>();
  return {
    ...actual,
    getPendingStagedCalls: vi.fn().mockReturnValue([]),
  };
});

vi.mock('@core/safetyPromptLogic', () => ({
  evaluateSafetyPrompt: vi.fn(),
  shouldAllow: vi.fn(),
  clearCache: vi.fn(),
}));

vi.mock('@core/safetyPromptStore', () => ({
  getSafetyPrompt: vi.fn().mockReturnValue('safety prompt'),
  getSafetyPromptVersion: vi.fn().mockReturnValue(1),
  isMigrationComplete: vi.fn().mockReturnValue(true),
}));

vi.mock('@core/safetyActivityLogStore', () => ({
  addEvaluationEntry: vi.fn(),
}));

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ sendToAllWindows: mockSendToAllWindows });
});

vi.mock('@core/services/toolAliasCache', () => ({
  resolveAlias: vi.fn((_packageId: string, toolId: string) => toolId),
  updateAliases: vi.fn(),
  clearAliases: vi.fn(),
}));

import { createToolSafetyHook } from '../toolSafetyService';

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: platform,
    writable: true,
  });
}

const settings = { claude: { apiKey: 'test-key' } } as AppSettings;

function makeHook(): HookCallback {
  return createToolSafetyHook(
    'run my script',
    settings,
    'balanced',
    undefined,
    [],
    undefined,
    null,
  );
}

beforeEach(() => {
  mockResolvesToCltShim.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM);
  vi.restoreAllMocks();
});

describe('createToolSafetyHook — macOS Python guard (end-to-end deny shape)', () => {
  it('darwin + shim_blocked → denies Bash, no continue:false, surfaces steering reason', async () => {
    setPlatform('darwin');
    mockResolvesToCltShim.mockResolvedValue('shim_blocked');

    const hook = makeHook();
    const result = (await hook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'python3 build.py' },
        tool_use_id: 'tool-1',
      },
      'tool-1',
      { signal: new AbortController().signal },
    )) as SyncHookJSONOutput;

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    // Plain per-tool deny — turn continues so the agent can pivot.
    expect(result.continue).toBeUndefined();
    expect(result.stopReason).toBeUndefined();

    const reason = String(result.hookSpecificOutput?.permissionDecisionReason ?? '');
    expect(reason.toLowerCase()).toContain('python');
    expect(reason).toMatch(/don't retry|do not retry/i);
    // Resolver was consulted with the spawn's PATH (process.env.PATH).
    expect(mockResolvesToCltShim).toHaveBeenCalledWith(
      'python3',
      process.env.PATH ?? '',
    );
  });
});
