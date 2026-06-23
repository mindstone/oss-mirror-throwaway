import readline from 'node:readline';
import type { ApprovalHandler, ApprovalRequest } from '@core/types/headlessTurnOptions';

type InputStream = NodeJS.ReadableStream & { isTTY?: boolean };
type OutputStream = { isTTY?: boolean; write: (message: string) => unknown };

export interface CliApprovalHandlerDeps {
  stdin: InputStream;
  stdout: OutputStream;
  stderr: OutputStream;
  now: () => number;
  timeoutMs?: number;
  jsonMode: boolean;
}

type ReadLineResult =
  | { kind: 'line'; line: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'closed' };

const DEFAULT_TIMEOUT_MS = 60_000;

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (Number.isFinite(timeoutMs) && timeoutMs && timeoutMs > 0) {
    return timeoutMs;
  }
  const raw = process.env.REBEL_CLI_APPROVAL_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function describeApprovalRequest(request: ApprovalRequest): string {
  if (request.kind === 'tool_safety') {
    return `Tool "${request.toolName}" requires approval`;
  }
  return `Memory write to "${request.target}" requires approval`;
}

function emitStructuredAutoDeny(args: {
  stdout: OutputStream;
  now: () => number;
  request: ApprovalRequest;
  decision: 'auto_denied_json_mode' | 'auto_denied_no_tty';
}): void {
  args.stdout.write(
    JSON.stringify({
      type: 'approval_required',
      request: args.request,
      decision: args.decision,
      timestamp: args.now(),
    }) + '\n',
  );
}

function readLineWithTimeout(
  stdin: InputStream,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ReadLineResult> {
  if (signal.aborted) {
    return Promise.resolve({ kind: 'aborted' });
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: stdin,
      terminal: false,
    });

    let settled = false;
    const timeoutRef: { current?: ReturnType<typeof setTimeout> } = {};
    const finish = (result: ReadLineResult) => {
      if (settled) return;
      settled = true;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      signal.removeEventListener('abort', onAbort);
      rl.removeListener('line', onLine);
      rl.removeListener('close', onClose);
      rl.close();
      resolve(result);
    };
    function onLine(line: string) {
      finish({ kind: 'line', line });
    }
    function onClose() {
      finish({ kind: 'closed' });
    }
    function onAbort() {
      finish({ kind: 'aborted' });
    }

    timeoutRef.current = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    rl.once('line', onLine);
    rl.once('close', onClose);
  });
}

export function createCliApprovalHandler(deps: CliApprovalHandlerDeps): ApprovalHandler {
  return async (request, signal) => {
    if (deps.jsonMode) {
      emitStructuredAutoDeny({
        stdout: deps.stdout,
        now: deps.now,
        request,
        decision: 'auto_denied_json_mode',
      });
      return { approved: false, reason: 'json_mode_auto_denied' };
    }

    if (!deps.stdin.isTTY || !deps.stdout.isTTY) {
      emitStructuredAutoDeny({
        stdout: deps.stdout,
        now: deps.now,
        request,
        decision: 'auto_denied_no_tty',
      });
      return { approved: false, reason: 'no_tty' };
    }

    deps.stdout.write('\n');
    deps.stderr.write(`[approval] ${describeApprovalRequest(request)} — allow? (y/N): `);

    const result = await readLineWithTimeout(deps.stdin, signal, resolveTimeoutMs(deps.timeoutMs));
    if (result.kind === 'aborted') {
      deps.stderr.write('\n');
      return { approved: false, reason: 'aborted' };
    }
    if (result.kind === 'timeout') {
      deps.stderr.write('\n');
      return { approved: false, reason: 'timeout' };
    }
    if (result.kind === 'line') {
      const normalized = result.line.trim().toLowerCase();
      if (normalized === 'y' || normalized === 'yes') {
        return { approved: true };
      }
    }
    return { approved: false, reason: 'declined' };
  };
}
