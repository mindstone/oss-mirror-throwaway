import { exec as nodeExec, spawn as nodeSpawn } from 'node:child_process';
import type {
  ExecCommandOptions,
  ExecCommandResult,
  ProcessSpawnOptions,
  ProcessSpawner,
  SpawnedProcess,
  WaitForExitResult,
} from '@core/processSpawner';

function normalizeExecError(error: unknown): Error | null {
  if (!error) return null;
  if (error instanceof Error) return error;
  return new Error(String(error));
}

export class StandaloneProcessSpawner implements ProcessSpawner {
  public spawn(command: string, args: string[], options: ProcessSpawnOptions = {}): SpawnedProcess {
    const proc = nodeSpawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: options.detached,
      windowsHide: options.windowsHide,
      stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
    });
    return proc as unknown as SpawnedProcess;
  }

  public async exec(command: string, options: ExecCommandOptions = {}): Promise<ExecCommandResult> {
    return new Promise((resolve) => {
      nodeExec(
        command,
        {
          cwd: options.cwd,
          env: options.env,
          timeout: options.timeoutMs,
        },
        (error, stdout, stderr) => {
          resolve({
            stdout,
            stderr,
            error: normalizeExecError(error),
          });
        },
      );
    });
  }

  public kill(pid: number, signal: NodeJS.Signals | number = 'SIGKILL'): boolean {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  public async waitForExit(proc: SpawnedProcess, timeoutMs = 30_000): Promise<WaitForExitResult> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: WaitForExitResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };

      proc.once('exit', (code, signal) => {
        finish({ code, signal, timedOut: false });
      });

      proc.once('error', () => {
        finish({ code: null, signal: null, timedOut: false });
      });

      let timer: NodeJS.Timeout | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          finish({ code: null, signal: null, timedOut: true });
        }, timeoutMs);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      }
    });
  }
}
