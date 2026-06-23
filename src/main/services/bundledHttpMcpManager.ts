import { spawn as defaultSpawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { getPlatformConfig } from '@core/platform';
import { readFdPressure } from '@core/utils/fdPressure';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { findAvailablePort } from '@core/services/superMcpHttpManager';
import type { McpServerUpsertPayload } from '@shared/types';
import { buildBundledHttpMcpPayload } from './bundledMcpManager';

const log = createScopedLogger({ service: 'bundledHttpMcpManager' });

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_READINESS_POLL_MS = 200;
const DEFAULT_PORT_BASELINE = 9_100;
const DEFAULT_PORT_SCAN_RANGE = 50;
const STOP_TIMEOUT_MS = 2_000;

const REDACTED_ENV_VALUE = '[redacted]';
const SENSITIVE_ENV_KEY_EXACT = new Set([
  'OPENAI_API_KEY',
  'OPENAI_API_BASE_URL',
  'REBEL_WORKSPACE_PATH',
]);

export type BundledHttpMcpStatus = 'starting' | 'ready' | 'failed' | 'crashed';

export interface BundledHttpMcpManagerOptions {
  startupTimeoutMs?: number;
  readinessPollMs?: number;
  spawnFn?: typeof defaultSpawn;
  findPortFn?: (
    preferredPort: number,
    maxAttempts?: number
  ) => Promise<{ port: number; conflicted: boolean }>;
  surface?: 'desktop' | 'cloud';
  portBaseline?: number;
  portScanRange?: number;
}

export interface SpawnBundledHttpMcpOptions {
  scriptPath: string;
  env: Record<string, string>;
  nodeModulesDir?: string;
}

export interface BundledHttpMcpDiagnosticEvent {
  type: 'spawn-failed' | 'crashed';
  serverName: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

interface ChildState {
  process: ChildProcess;
  port: number;
  startedAt: number;
  status: BundledHttpMcpStatus;
  payload: McpServerUpsertPayload | null;
  url: string;
  stopping: boolean;
  stoppingPromise: Promise<void> | null;
  bootFailureReject: ((err: Error) => void) | null;
  stderrBuffer: string;
  configSignature: string;
}

const computeConfigSignature = (options: SpawnBundledHttpMcpOptions): string => {
  const sortedEnvKeys = Object.keys(options.env).sort();
  const sortedEnv: Record<string, string> = {};
  for (const key of sortedEnvKeys) {
    sortedEnv[key] = options.env[key];
  }
  const canonical = JSON.stringify({
    scriptPath: options.scriptPath,
    nodeModulesDir: options.nodeModulesDir ?? null,
    env: sortedEnv,
  });
  return createHash('sha256').update(canonical).digest('hex');
};

export const bundledHttpMcpDiagnosticEvents = new EventEmitter<{
  event: [BundledHttpMcpDiagnosticEvent];
}>();

const isSensitiveEnvKey = (key: string): boolean => {
  if (SENSITIVE_ENV_KEY_EXACT.has(key)) return true;
  return /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|BEARER)/iu.test(key);
};

const redactEnv = (env: Record<string, string>): Record<string, string> => {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = isSensitiveEnvKey(key) ? REDACTED_ENV_VALUE : value;
  }
  return redacted;
};

const serverNameHash = (serverName: string): string =>
  createHash('sha256').update(serverName).digest('hex').slice(0, 16);

const hasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

export class BundledHttpMcpManager {
  private readonly startupTimeoutMs: number;
  private readonly readinessPollMs: number;
  private readonly spawnFn: typeof defaultSpawn;
  private readonly findPortFn: NonNullable<BundledHttpMcpManagerOptions['findPortFn']>;
  private readonly surfaceOverride: 'desktop' | 'cloud' | undefined;
  private resolvedSurface: 'desktop' | 'cloud' | undefined;
  private get surface(): 'desktop' | 'cloud' {
    return (this.resolvedSurface ??=
      this.surfaceOverride ?? (getPlatformConfig().surface === 'cloud' ? 'cloud' : 'desktop'));
  }
  private readonly portBaseline: number;
  private readonly portScanRange: number;
  private readonly children = new Map<string, ChildState>();

  constructor(opts: BundledHttpMcpManagerOptions = {}) {
    this.startupTimeoutMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.readinessPollMs = opts.readinessPollMs ?? DEFAULT_READINESS_POLL_MS;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.findPortFn = opts.findPortFn ?? findAvailablePort;
    this.surfaceOverride = opts.surface;
    this.portBaseline = opts.portBaseline ?? DEFAULT_PORT_BASELINE;
    this.portScanRange = opts.portScanRange ?? DEFAULT_PORT_SCAN_RANGE;
  }

  async spawn(
    serverName: string,
    options: SpawnBundledHttpMcpOptions
  ): Promise<{ url: string }> {
    if (this.surface !== 'desktop') {
      throw new Error('BundledHttpMcpManager.spawn is desktop-only; cloud surface should not call this');
    }

    const nextSignature = computeConfigSignature(options);

    const existing = this.children.get(serverName);
    if (existing?.status === 'ready' && existing.configSignature === nextSignature) {
      return { url: existing.url };
    }
    if (existing) {
      if (existing.status === 'ready') {
        log.info(
          { serverName },
          'Bundled HTTP MCP config changed (env/script); restarting child to pick up new options'
        );
      }
      await this.stop(serverName);
    }

    const { port } = await this.findPortFn(
      this.portBaseline + this.children.size,
      this.portScanRange
    );
    const url = `http://127.0.0.1:${port}/`;
    const childEnv: Record<string, string> = {
      ...process.env,
      ...options.env,
      REBEL_MCP_HTTP_PORT: String(port),
      NODE_PATH: options.nodeModulesDir || process.env.NODE_PATH || '',
    };

    log.debug(
      { serverName, port, scriptPath: options.scriptPath, env: redactEnv(childEnv) },
      'Spawning bundled HTTP MCP child'
    );

    const child = this.spawnFn('node', [options.scriptPath], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    const state: ChildState = {
      process: child,
      port,
      startedAt: Date.now(),
      status: 'starting',
      payload: null,
      url,
      stopping: false,
      stoppingPromise: null,
      bootFailureReject: null,
      stderrBuffer: '',
      configSignature: nextSignature,
    };
    this.children.set(serverName, state);
    this.attachChildHandlers(serverName, state);

    try {
      await this.waitForTcpReadyOrBootFailure(serverName, state);
      await this.performProtocolHandshake(url);
      state.status = 'ready';
      state.payload = buildBundledHttpMcpPayload(serverName, { url });
      log.info(
        {
          serverName,
          port,
          startupMs: Date.now() - state.startedAt,
          env: redactEnv(options.env),
        },
        'Bundled HTTP MCP child ready'
      );
      return { url };
    } catch (err) {
      if (state.status !== 'crashed') {
        state.status = 'failed';
      }
      await this.terminateChildProcess(state);
      log.warn(
        {
          err,
          serverName,
          port,
          startupTimeoutMs: this.startupTimeoutMs,
          env: redactEnv(options.env),
        },
        'Bundled HTTP MCP child failed readiness'
      );
      throw err;
    }
  }

  async stop(serverName: string): Promise<void> {
    const state = this.children.get(serverName);
    if (!state) return;
    if (state.stoppingPromise) {
      return state.stoppingPromise;
    }

    state.stopping = true;
    state.status = 'failed';
    state.stoppingPromise = (async () => {
      await this.terminateChildProcess(state);
      this.children.delete(serverName);
    })();

    return state.stoppingPromise;
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.children.keys()].map((name) =>
        this.stop(name).catch((err: unknown) => {
          log.warn({ err, name }, 'stopAll: stop failed for child');
        })
      )
    );
  }

  getPayload(serverName: string): McpServerUpsertPayload | null {
    return this.children.get(serverName)?.payload ?? null;
  }

  getHealthSnapshot(): Record<string, BundledHttpMcpStatus> {
    const snapshot: Record<string, BundledHttpMcpStatus> = {};
    for (const [serverName, state] of this.children.entries()) {
      snapshot[serverName] = state.status;
    }
    return snapshot;
  }

  /**
   * Attach an fd-pressure snapshot as a Sentry breadcrumb on a child spawn
   * failure (260621 monitoring / REBEL-66M). Carries open-fd count + highest fd
   * number (structural, no PII) so a `spawn EBADF`-class failure that is really
   * fd exhaustion is diagnosable from the captured event without an lsof
   * round-trip. Best-effort: readFdPressure never throws, and the breadcrumb
   * emit is guarded so telemetry can never perturb the spawn-failure path.
   */
  private recordSpawnFailureFdBreadcrumb(serverName: string, err: unknown): void {
    try {
      const fd = readFdPressure();
      const errorCode = (err as NodeJS.ErrnoException)?.code;
      getErrorReporter().addBreadcrumb({
        category: 'mcp.spawn_failed',
        message: 'bundled-http-mcp spawn failed',
        level: 'warning',
        data: {
          serverName,
          ...(errorCode ? { errorCode } : {}),
          fdStatus: fd.status,
          ...(fd.status === 'ok'
            ? { openFdCount: fd.openFdCount, maxFdNumber: fd.maxFdNumber }
            : {}),
        },
      });
    } catch (breadcrumbError) {
      // Best-effort observability; never perturb the spawn-failure path.
      log.debug({ err: breadcrumbError, serverName }, 'fd-pressure spawn-failure breadcrumb emit failed');
    }
  }

  private attachChildHandlers(serverName: string, state: ChildState): void {
    state.process.stderr?.on('data', (chunk: Buffer | string) => {
      this.forwardStderr(serverName, state, chunk.toString());
    });

    state.process.on('error', (err) => {
      if (!state.stopping) {
        state.status = 'failed';
        this.emitDiagnosticEvent({ type: 'spawn-failed', serverName });
        // Context-on-the-event (260621 monitoring / REBEL-66M): the fd-leak
        // incident surfaced as `spawn EBADF` but the Sentry event arrived
        // context-free and was misdiagnosed as a stdio bug. Attach an fd-pressure
        // snapshot breadcrumb so a spawn failure that's actually fd exhaustion is
        // self-evident on the captured event. readFdPressure never throws;
        // best-effort so it can't perturb the failure path.
        this.recordSpawnFailureFdBreadcrumb(serverName, err);
        state.bootFailureReject?.(err instanceof Error ? err : new Error(String(err)));
        log.warn({ err, serverName }, 'Bundled HTTP MCP child spawn error');
      }
    });

    state.process.on('exit', (code, signal) => {
      const wasStopping = state.stopping;
      if (!wasStopping && state.status !== 'failed') {
        state.status = 'crashed';
        const err = new Error(
          `BundledHttpMcp ${serverName} exited before readiness (code ${code ?? 'null'}, signal ${signal ?? 'null'})`
        );
        state.bootFailureReject?.(err);
        this.emitDiagnosticEvent({
          type: 'crashed',
          serverName,
          exitCode: code,
          signal,
        });
        log.warn(
          { serverName, code, signal },
          'Bundled HTTP MCP child exited unexpectedly'
        );
      }
    });
  }

  private forwardStderr(serverName: string, state: ChildState, chunk: string): void {
    state.stderrBuffer += chunk;
    const lines = state.stderrBuffer.split(/\r?\n/u);
    state.stderrBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length === 0) continue;
      log.debug({ serverName, stderr: line }, 'Bundled HTTP MCP child stderr');
    }
  }

  private async waitForTcpReadyOrBootFailure(
    serverName: string,
    state: ChildState
  ): Promise<void> {
    const bootFailure = new Promise<never>((_, reject) => {
      state.bootFailureReject = reject;
    });
    try {
      await Promise.race([
        this.waitForTcpReady(state.port, serverName),
        bootFailure,
      ]);
    } finally {
      state.bootFailureReject = null;
    }
  }

  private async waitForTcpReady(port: number, serverName: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started <= this.startupTimeoutMs) {
      const ready = await this.probeTcp(port);
      if (ready) return;
      await new Promise((resolve) => setTimeout(resolve, this.readinessPollMs));
    }
    throw new Error(`BundledHttpMcp ${serverName} not ready after ${this.startupTimeoutMs}ms`);
  }

  private probeTcp(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' }, () => {
        socket.end();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  private async performProtocolHandshake(url: string): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    const client = new Client(
      { name: 'rebel-bundled-http-readiness-probe', version: '0.0.1' },
      { capabilities: {} }
    );
    await client.connect(transport);
    await client.close();
  }

  private async terminateChildProcess(state: ChildState): Promise<void> {
    state.stopping = true;
    const exitPromise = this.waitForExit(state.process, STOP_TIMEOUT_MS);
    if (!hasExited(state.process)) {
      state.process.kill('SIGTERM');
    }
    const exited = await exitPromise;
    if (!exited && !hasExited(state.process)) {
      const killExitPromise = this.waitForExit(state.process, STOP_TIMEOUT_MS);
      state.process.kill('SIGKILL');
      await killExitPromise;
    }
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (hasExited(child)) return Promise.resolve(true);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      timeout.unref();

      child.once('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }

  private emitDiagnosticEvent(event: BundledHttpMcpDiagnosticEvent): void {
    bundledHttpMcpDiagnosticEvents.emit('event', event);
    appendDiagnosticEvent({
      kind: 'mcp_transition',
      data: {
        transition: 'error',
        reason: event.type === 'crashed' ? 'process-exit' : 'spawn-error',
        serverIdHash: serverNameHash(event.serverName),
        restartCount: 0,
        consecutiveFailures: 1,
      },
    });
  }
}

export const bundledHttpMcpManager = new BundledHttpMcpManager();
