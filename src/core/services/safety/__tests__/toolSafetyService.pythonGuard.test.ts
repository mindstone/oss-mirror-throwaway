/**
 * Tests for the platform Python guards in toolSafetyService.
 *
 * Focus: the macOS guard (`macosCltShimGuard`) that prevents the agent's
 * Bash tool from exec'ing Apple's xcode-select CLT shims (`/usr/bin/python3`,
 * `/usr/bin/git`, etc.),
 * which pops the OS "install command line developer tools" dialog on a
 * CLT-missing Mac (Sentry REBEL-674 / FOX-3482).
 *
 * Also pins `windowsPythonGuard` behaviour, which previously had no dedicated
 * tests and lives in the same file.
 *
 * `macosCommandResolvesToCltShim` (the real shim/CLT decision, owned by
 * pythonRuntimeService) is mocked here so the guard is tested in isolation; its
 * own resolution + never-exec-the-shim invariant is covered in
 * `src/main/services/__tests__/pythonRuntimeService.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncHookJSONOutput } from '@core/agentRuntimeTypes';

const { mockResolvesToCltShim, mockCheckPythonRuntime, mockRunProbe } = vi.hoisted(
  () => ({
    mockResolvesToCltShim: vi.fn(),
    mockCheckPythonRuntime: vi.fn(),
    mockRunProbe: vi.fn(),
  }),
);

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
  checkPythonRuntime: mockCheckPythonRuntime,
}));

// windowsPythonGuard resolves the python path via where.exe through runProbe.
vi.mock('@main/services/processProbe', () => ({
  runProbe: mockRunProbe,
}));

// Minimal module mocks so importing toolSafetyService resolves cleanly.
vi.mock('@main/services/safety', () => ({
  addPendingApproval: vi.fn(),
  removePendingApproval: vi.fn(),
  getPendingApprovals: vi.fn().mockReturnValue([]),
  clearPendingApprovalsForSession: vi.fn().mockReturnValue([]),
  storeSingleUseApproval: vi.fn(),
  consumeSingleUseApproval: vi.fn().mockReturnValue(false),
  clearSessionSingleUseApprovals: vi.fn(),
}));

vi.mock('@core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/logger')>();
  return {
    ...actual,
    createScopedLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    }),
  };
});

import { createScopedLogger } from '@core/logger';
import {
  detectMacosCltShimCommandInHeader,
  detectPythonInHeader,
  macosCltShimGuard,
  macosPythonGuard,
  windowsPythonGuard,
} from '../toolSafetyService';

const log = createScopedLogger({ service: 'test' });

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: platform,
    writable: true,
  });
}

function bashCall(command: string): { toolName: string; toolInput: unknown } {
  return { toolName: 'Bash', toolInput: { command } };
}

beforeEach(() => {
  mockResolvesToCltShim.mockReset();
  mockCheckPythonRuntime.mockReset();
  mockRunProbe.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM);
});

describe('macosPythonGuard', () => {
  it('darwin + CLT-missing + python3 resolves to shim → DENY (and never resolves the binary itself)', async () => {
    setPlatform('darwin');
    mockResolvesToCltShim.mockResolvedValue('shim_blocked');

    const { toolName, toolInput } = bashCall('python3 script.py');
    const result = (await macosPythonGuard(
      toolName,
      toolInput,
      log,
    )) as SyncHookJSONOutput | null;

    expect(result).not.toBeNull();
    // Plain per-tool deny: NO continue:false and NO stopReason, so the turn
    // continues (agent can pivot) and our rich message is NOT shadowed by
    // stopReason in getPreToolDenyReason (hookPipeline.ts).
    expect(result?.continue).toBeUndefined();
    expect(result?.stopReason).toBeUndefined();
    expect(result?.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(result?.hookSpecificOutput?.permissionDecision).toBe('deny');
    // Calm, agent-steering, on-brand: tells it not to retry, no jargon dump.
    const reason = String(result?.hookSpecificOutput?.permissionDecisionReason ?? '');
    expect(reason.toLowerCase()).toContain('python');
    expect(reason).toMatch(/don't retry|do not retry/i);

    // Resolution used process.env.PATH (the spawn's PATH), not pythonAvailable.
    expect(mockResolvesToCltShim).toHaveBeenCalledWith(
      'python3',
      process.env.PATH ?? '',
    );
    expect(mockCheckPythonRuntime).not.toHaveBeenCalled();
  });

  it('darwin + CLT present (resolution safe) → allow', async () => {
    setPlatform('darwin');
    mockResolvesToCltShim.mockResolvedValue('safe');

    const { toolName, toolInput } = bashCall('python3 script.py');
    expect(await macosPythonGuard(toolName, toolInput, log)).toBeNull();
  });

  it('darwin + safe Homebrew python first hit → allow', async () => {
    setPlatform('darwin');
    mockResolvesToCltShim.mockResolvedValue('safe');

    const { toolName, toolInput } = bashCall('python3 -c "print(1)"');
    expect(await macosPythonGuard(toolName, toolInput, log)).toBeNull();
  });

  it('darwin + command not found → allow (fails naturally)', async () => {
    setPlatform('darwin');
    mockResolvesToCltShim.mockResolvedValue('not_found');

    const { toolName, toolInput } = bashCall('python3 missing.py');
    expect(await macosPythonGuard(toolName, toolInput, log)).toBeNull();
  });

  it('darwin + non-python command → allow without resolving', async () => {
    setPlatform('darwin');

    const { toolName, toolInput } = bashCall('ls -la');
    expect(await macosPythonGuard(toolName, toolInput, log)).toBeNull();
    expect(mockResolvesToCltShim).not.toHaveBeenCalled();
  });

  it('non-darwin → no-op (returns null without resolving)', async () => {
    setPlatform('win32');

    const { toolName, toolInput } = bashCall('python3 script.py');
    expect(await macosPythonGuard(toolName, toolInput, log)).toBeNull();
    expect(mockResolvesToCltShim).not.toHaveBeenCalled();
  });

  it('darwin + non-Bash tool → allow', async () => {
    setPlatform('darwin');

    expect(
      await macosPythonGuard('TextEditor', { file_path: '/tmp/x' }, log),
    ).toBeNull();
    expect(mockResolvesToCltShim).not.toHaveBeenCalled();
  });

  it('darwin + CLT-missing + absolute /usr/bin/python3 x.py → DENY (token passed verbatim)', async () => {
    setPlatform('darwin');
    mockResolvesToCltShim.mockResolvedValue('shim_blocked');

    const { toolName, toolInput } = bashCall('/usr/bin/python3 x.py');
    const result = (await macosPythonGuard(
      toolName,
      toolInput,
      log,
    )) as SyncHookJSONOutput | null;

    expect(result?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result?.continue).toBeUndefined();
    // The absolute shim token is forwarded verbatim to the resolver.
    expect(mockResolvesToCltShim).toHaveBeenCalledWith(
      '/usr/bin/python3',
      process.env.PATH ?? '',
    );
  });

  it('darwin + CLT-missing + env python3 x.py → DENY (env wrapper unwrapped to python3)', async () => {
    setPlatform('darwin');
    mockResolvesToCltShim.mockResolvedValue('shim_blocked');

    const { toolName, toolInput } = bashCall('env python3 x.py');
    const result = (await macosPythonGuard(
      toolName,
      toolInput,
      log,
    )) as SyncHookJSONOutput | null;

    expect(result?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(mockResolvesToCltShim).toHaveBeenCalledWith(
      'python3',
      process.env.PATH ?? '',
    );
  });

  it('darwin + CLT-missing + FOO=bar python3 x.py → DENY (env-assign prefix skipped)', async () => {
    setPlatform('darwin');
    mockResolvesToCltShim.mockResolvedValue('shim_blocked');

    const { toolName, toolInput } = bashCall('FOO=bar python3 x.py');
    const result = (await macosPythonGuard(
      toolName,
      toolInput,
      log,
    )) as SyncHookJSONOutput | null;

    expect(result?.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(mockResolvesToCltShim).toHaveBeenCalledWith(
      'python3',
      process.env.PATH ?? '',
    );
  });
});

describe('macosCltShimGuard — generalized CLT shims', () => {
  it.each([
    ['git', 'git status'],
    ['make', 'make build'],
    ['swift', 'env swift --version'],
  ])('darwin + CLT-missing + %s resolves to shim → DENY with CLT guidance', async (expectedToken, command) => {
    setPlatform('darwin');
    mockResolvesToCltShim.mockResolvedValue('shim_blocked');

    const { toolName, toolInput } = bashCall(command);
    const result = (await macosCltShimGuard(
      toolName,
      toolInput,
      log,
    )) as SyncHookJSONOutput | null;

    expect(result?.continue).toBeUndefined();
    expect(result?.stopReason).toBeUndefined();
    expect(result?.hookSpecificOutput?.permissionDecision).toBe('deny');
    const reason = String(result?.hookSpecificOutput?.permissionDecisionReason ?? '');
    expect(reason).toContain('Xcode Command Line Tools');
    expect(reason).toMatch(/do not retry/i);
    expect(reason).toContain('xcode-select --install');
    expect(mockResolvesToCltShim).toHaveBeenCalledWith(
      expectedToken,
      process.env.PATH ?? '',
    );
  });

  it('darwin + CLT present/safe resolution for git → allow', async () => {
    setPlatform('darwin');
    mockResolvesToCltShim.mockResolvedValue('safe');

    const { toolName, toolInput } = bashCall('git status');
    expect(await macosCltShimGuard(toolName, toolInput, log)).toBeNull();
  });

  it('darwin + git not found → allow (fails naturally)', async () => {
    setPlatform('darwin');
    mockResolvesToCltShim.mockResolvedValue('not_found');

    const { toolName, toolInput } = bashCall('git status');
    expect(await macosCltShimGuard(toolName, toolInput, log)).toBeNull();
  });

  it('non-darwin → no-op for generalized guard', async () => {
    setPlatform('linux');

    const { toolName, toolInput } = bashCall('git status');
    expect(await macosCltShimGuard(toolName, toolInput, log)).toBeNull();
    expect(mockResolvesToCltShim).not.toHaveBeenCalled();
  });
});

describe('detectPythonInHeader — recognised invocation forms', () => {
  it('bare forms', () => {
    expect(detectPythonInHeader('python3 a.py')).toBe('python3');
    expect(detectPythonInHeader('python a.py')).toBe('python');
    expect(detectPythonInHeader('pip3 install x')).toBe('pip3');
    expect(detectPythonInHeader('pip install x')).toBe('pip');
    expect(detectPythonInHeader('py -3 a.py')).toBe('py');
  });

  it('absolute shim path (start and after chain)', () => {
    expect(detectPythonInHeader('/usr/bin/python3 a.py')).toBe('/usr/bin/python3');
    expect(detectPythonInHeader('/usr/bin/python a.py')).toBe('/usr/bin/python');
    expect(detectPythonInHeader('cd /tmp && /usr/bin/python3 a.py')).toBe(
      '/usr/bin/python3',
    );
  });

  it('env wrapper forms', () => {
    expect(detectPythonInHeader('env python3 a.py')).toBe('python3');
    expect(detectPythonInHeader('/usr/bin/env python3 a.py')).toBe('python3');
    expect(detectPythonInHeader('/usr/bin/env python a.py')).toBe('python');
  });

  it('leading env-var assignments', () => {
    expect(detectPythonInHeader('FOO=bar python3 a.py')).toBe('python3');
    expect(detectPythonInHeader('FOO=bar BAZ=qux python a.py')).toBe('python');
    expect(detectPythonInHeader('PYTHONPATH=/x env python3 a.py')).toBe('python3');
  });

  it('after chain operators', () => {
    expect(detectPythonInHeader('ls && python3 a.py')).toBe('python3');
    expect(detectPythonInHeader('false || python a.py')).toBe('python');
    expect(detectPythonInHeader('echo hi; pip install x')).toBe('pip');
  });

  it('does NOT match versioned interpreters or innocent commands', () => {
    // Versioned names are real interpreters, not the /usr/bin/python3 shim.
    expect(detectPythonInHeader('python3.11 a.py')).toBeNull();
    expect(detectPythonInHeader('/usr/bin/python3.11 a.py')).toBeNull();
    // Innocent commands / python mid-token must not trip.
    expect(detectPythonInHeader('ls -la')).toBeNull();
    expect(detectPythonInHeader('mypython a.py')).toBeNull();
    expect(detectPythonInHeader('echo python3')).toBeNull();
    // After a pipe is NOT a chain operator.
    expect(detectPythonInHeader('cat x | python3')).toBeNull();
  });
});

describe('detectMacosCltShimCommandInHeader — recognised invocation forms', () => {
  it('detects representative bare, absolute, env, env-assignment, and chain forms', () => {
    expect(detectMacosCltShimCommandInHeader('git status')).toBe('git');
    expect(detectMacosCltShimCommandInHeader('/usr/bin/git status')).toBe('/usr/bin/git');
    expect(detectMacosCltShimCommandInHeader('env make build')).toBe('make');
    expect(detectMacosCltShimCommandInHeader('SDKROOT=/tmp swift build')).toBe('swift');
    expect(detectMacosCltShimCommandInHeader('cd app && clang++ main.cc')).toBe('clang++');
  });

  it('does NOT match innocent commands or pipe positions', () => {
    expect(detectMacosCltShimCommandInHeader('git-lfs status')).toBeNull();
    expect(detectMacosCltShimCommandInHeader('echo git')).toBeNull();
    expect(detectMacosCltShimCommandInHeader('cat files | git hash-object --stdin')).toBeNull();
  });

  it('detects case-insensitive command tokens (default APFS)', () => {
    expect(detectMacosCltShimCommandInHeader('PYTHON3 script.py')).toBe('PYTHON3');
    expect(detectMacosCltShimCommandInHeader('Git status')).toBe('Git');
  });
});

describe('macosCltShimGuard — case-insensitive shim tokens', () => {
  it.each([
    ['PYTHON3', 'PYTHON3 script.py'],
    ['Git', 'Git status'],
  ])(
    'darwin + CLT-missing + %s resolves to shim → DENY',
    async (expectedToken, command) => {
      setPlatform('darwin');
      mockResolvesToCltShim.mockResolvedValue('shim_blocked');

      const { toolName, toolInput } = bashCall(command);
      const result = (await macosCltShimGuard(
        toolName,
        toolInput,
        log,
      )) as SyncHookJSONOutput | null;

      expect(result?.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(mockResolvesToCltShim).toHaveBeenCalledWith(
        expectedToken,
        process.env.PATH ?? '',
      );
    },
  );
});

describe('windowsPythonGuard (pinning — shared detectPythonInHeader changed)', () => {
  it('non-win32 → returns null (no-op)', async () => {
    setPlatform('darwin');

    const { toolName, toolInput } = bashCall('python3 script.py');
    expect(await windowsPythonGuard(toolName, toolInput, log)).toBeNull();
    expect(mockCheckPythonRuntime).not.toHaveBeenCalled();
  });

  it('win32 + python available + resolves to a safe (non-WindowsApps) path → allow', async () => {
    setPlatform('win32');
    mockCheckPythonRuntime.mockResolvedValue({
      pythonAvailable: true,
      windowsAliasesBlocked: false,
    });
    // where.exe returns a real install path, not a WindowsApps alias.
    mockRunProbe.mockResolvedValue({
      exitCode: 0,
      stdout: 'C:\\Python312\\python.exe\r\n',
      stderr: '',
    });

    const { toolName, toolInput } = bashCall('python3 script.py');
    const result = await windowsPythonGuard(toolName, toolInput, log);

    expect(result).toBeNull();
    expect(mockCheckPythonRuntime).toHaveBeenCalled();
  });
});
