/**
 * ProcessSpawner — boundary interface for subprocess lifecycle management.
 *
 * Core services can depend on this boundary while each surface wires an
 * environment-specific implementation.
 */

export type SpawnStdioValue = 'pipe' | 'ignore' | number;

export interface ProcessSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  windowsHide?: boolean;
  stdio?: [SpawnStdioValue?, SpawnStdioValue?, SpawnStdioValue?];
}

export interface SpawnedProcess {
  readonly pid: number | undefined;
  readonly killed: boolean;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref(): void;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface ExecCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ExecCommandResult {
  stdout: string;
  stderr: string;
  error: Error | null;
}

export interface WaitForExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface ProcessSpawner {
  spawn(command: string, args: string[], options?: ProcessSpawnOptions): SpawnedProcess;
  exec(command: string, options?: ExecCommandOptions): Promise<ExecCommandResult>;
  kill(pid: number, signal?: NodeJS.Signals | number): boolean;
  waitForExit(proc: SpawnedProcess, timeoutMs?: number): Promise<WaitForExitResult>;
}

export type ProcessSpawnerFactory = () => ProcessSpawner;

let _factory: ProcessSpawnerFactory | undefined;
let _instance: ProcessSpawner | undefined;

export function setProcessSpawnerFactory(factory: ProcessSpawnerFactory): void {
  _factory = factory;
  _instance = undefined;
}

export function getProcessSpawner(): ProcessSpawner {
  if (_instance) return _instance;
  if (!_factory) {
    throw new Error(
      'ProcessSpawner not initialized. Call setProcessSpawnerFactory() before subprocess usage.',
    );
  }
  _instance = _factory();
  return _instance;
}
