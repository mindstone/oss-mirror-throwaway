import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { ApprovalRequest } from '@core/types/headlessTurnOptions';
import { initCliRuntime, runCli } from '../cli';

const settings = {
  coreDirectory: '/tmp/workspace',
  claude: { apiKey: 'test-key' },
  models: { apiKey: 'test-key' },
} as AppSettings;

const approvalRequest: ApprovalRequest = {
  kind: 'tool_safety',
  toolName: 'send_email',
  toolInput: { to: 'team@example.com' },
  reason: 'Sends email',
};

describe('CLI approval policy', () => {
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let originalStdinDescriptor: PropertyDescriptor | undefined;
  let originalStdoutIsTtyDescriptor: PropertyDescriptor | undefined;
  let stdin: PassThrough & { isTTY?: boolean };

  beforeEach(() => {
    stdoutWrites = [];
    stderrWrites = [];
    originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    originalStdoutIsTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    stdin.isTTY = true;
    Object.defineProperty(process, 'stdin', {
      value: stdin,
      configurable: true,
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalStdinDescriptor) {
      Object.defineProperty(process, 'stdin', originalStdinDescriptor);
    }
    if (originalStdoutIsTtyDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', originalStdoutIsTtyDescriptor);
    } else {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  it('allows a TTY-approved tool safety request and the turn succeeds', async () => {
    const runHeadlessTurn = vi.fn(async ({ onEvent, options }) => {
      const decisionPromise = options.approvalHandler?.(approvalRequest, new AbortController().signal);
      stdin.write('y\n');
      await expect(decisionPromise).resolves.toEqual({ approved: true });
      onEvent({ type: 'result', text: 'ok', timestamp: Date.now() });
    });

    initCliRuntime({
      runHeadlessTurn: runHeadlessTurn as never,
      getSettings: () => settings,
      appVersion: 'test',
    });

    const exitCode = await runCli(['run', '--prompt', 'send it']);

    expect(exitCode).toBe(0);
    expect(runHeadlessTurn).toHaveBeenCalledTimes(1);
    expect(stderrWrites.join('')).toContain('[approval]');
  });

  it('returns exit 2 when a TTY approval request is declined', async () => {
    const runHeadlessTurn = vi.fn(async ({ options }) => {
      const decisionPromise = options.approvalHandler?.(approvalRequest, new AbortController().signal);
      stdin.write('n\n');
      await expect(decisionPromise).resolves.toEqual({ approved: false, reason: 'declined' });
    });

    initCliRuntime({
      runHeadlessTurn: runHeadlessTurn as never,
      getSettings: () => settings,
      appVersion: 'test',
    });

    const exitCode = await runCli(['run', '--prompt', 'send it']);

    expect(exitCode).toBe(2);
    expect(stderrWrites.join('')).toContain('[approval]');
  });

  it('returns exit 2 in JSON mode without printing an interactive prompt', async () => {
    const runHeadlessTurn = vi.fn(async ({ options }) => {
      const decision = await options.approvalHandler?.(
        approvalRequest,
        new AbortController().signal,
      );
      expect(decision).toEqual({ approved: false, reason: 'json_mode_auto_denied' });
    });

    initCliRuntime({
      runHeadlessTurn: runHeadlessTurn as never,
      getSettings: () => settings,
      appVersion: 'test',
    });

    const exitCode = await runCli(['run', '--prompt', 'send it', '--json']);

    expect(exitCode).toBe(2);
    expect(stderrWrites.join('')).not.toContain('[approval]');
    expect(stdoutWrites.join('')).toContain('"type":"approval_required"');
    expect(stdoutWrites.join('')).toContain('"decision":"auto_denied_json_mode"');
  });
});
