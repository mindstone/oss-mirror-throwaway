import { PassThrough } from 'node:stream';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ApprovalRequest } from '@core/types/headlessTurnOptions';
import { createCliApprovalHandler } from '../ttyApprovalPrompt';

const request: ApprovalRequest = {
  kind: 'tool_safety',
  toolName: 'send_email',
  toolInput: { to: 'team@example.com' },
  reason: 'Sends email',
};

function createHarness(options: { stdinTTY?: boolean; stdoutTTY?: boolean; jsonMode?: boolean } = {}) {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = options.stdinTTY ?? true;
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];
  const stdout = {
    isTTY: options.stdoutTTY ?? true,
    write: (message: string) => {
      stdoutWrites.push(String(message));
      return true;
    },
  };
  const stderr = {
    write: (message: string) => {
      stderrWrites.push(String(message));
      return true;
    },
  };
  const handler = createCliApprovalHandler({
    stdin,
    stdout,
    stderr,
    now: () => 1234,
    timeoutMs: 25,
    jsonMode: options.jsonMode ?? false,
  });

  return { stdin, stdoutWrites, stderrWrites, handler };
}

describe('createCliApprovalHandler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('approves interactive TTY input on yes', async () => {
    const { stdin, stdoutWrites, stderrWrites, handler } = createHarness();

    const decisionPromise = handler(request, new AbortController().signal);
    stdin.write('yes\n');

    await expect(decisionPromise).resolves.toEqual({ approved: true });
    expect(stderrWrites.join('')).toContain('[approval] Tool "send_email" requires approval');
    expect(stdoutWrites.join('')).toBe('\n');
    expect(stdoutWrites.join('')).not.toContain('[approval]');
  });

  it('denies interactive TTY input on no', async () => {
    const { stdin, handler } = createHarness();

    const decisionPromise = handler(request, new AbortController().signal);
    stdin.write('n\n');

    await expect(decisionPromise).resolves.toEqual({ approved: false, reason: 'declined' });
  });

  it('denies interactive TTY input on timeout', async () => {
    vi.useFakeTimers();
    const { handler } = createHarness();

    const decisionPromise = handler(request, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(26);

    await expect(decisionPromise).resolves.toEqual({ approved: false, reason: 'timeout' });
  });

  it('denies immediately when the abort signal fires', async () => {
    const { handler } = createHarness();
    const controller = new AbortController();

    const decisionPromise = handler(request, controller.signal);
    controller.abort();

    await expect(decisionPromise).resolves.toEqual({ approved: false, reason: 'aborted' });
  });

  it('auto-denies non-TTY runs with a structured stdout event', async () => {
    const { stdoutWrites, stderrWrites, handler } = createHarness({ stdinTTY: false });

    await expect(handler(request, new AbortController().signal)).resolves.toEqual({
      approved: false,
      reason: 'no_tty',
    });

    expect(stderrWrites.join('')).not.toContain('[approval]');
    const event = JSON.parse(stdoutWrites.join(''));
    expect(event).toMatchObject({
      type: 'approval_required',
      decision: 'auto_denied_no_tty',
      timestamp: 1234,
      request,
    });
  });

  it('auto-denies JSON mode with a structured stdout event and no prompt', async () => {
    const { stdoutWrites, stderrWrites, handler } = createHarness({ jsonMode: true });

    await expect(handler(request, new AbortController().signal)).resolves.toEqual({
      approved: false,
      reason: 'json_mode_auto_denied',
    });

    expect(stderrWrites.join('')).not.toContain('[approval]');
    const event = JSON.parse(stdoutWrites.join(''));
    expect(event).toMatchObject({
      type: 'approval_required',
      decision: 'auto_denied_json_mode',
      timestamp: 1234,
      request,
    });
  });
});
