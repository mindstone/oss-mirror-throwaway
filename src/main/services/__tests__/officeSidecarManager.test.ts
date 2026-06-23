import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorReporter } from '@core/errorReporter';
import { defaultCapabilities, setPlatformConfig, type PlatformConfig, type PlatformSurface } from '@core/platform';
import { redactPathsAndTokens } from '../officeSidecarLogRedaction';
import {
  OFFICE_MCP_PACKAGE_SPEC,
  OFFICE_MCP_PACKAGE_NAME,
  OFFICE_MCP_PACKAGE_VERSION,
  OFFICE_MCP_PACKAGE_SPECS_TO_TRY,
} from '@shared/sidecar/officePackage';
import {
  createOfficeSidecarManager,
  getOfficeSidecarManager,
  isOfficeSidecarRunning,
  type OfficeSidecarTimingOptions,
  setOfficeSidecarManagerForShutdown,
  startOfficeSidecar,
  stopOfficeSidecar,
  type OfficeSidecarManager,
} from '../officeSidecarManager';
import type { InstallMetadata } from '../managedMcpInstallService';
import { __resetManagedMcpInstallSingletonForTesting } from '../managedMcpInstallServiceInstance';
import { ReadySignalSchema, type ReadySignal } from '@shared/sidecar/readySignal';
import { constantTimeStringEqual } from '@shared/sidecar/constantTime';
import {
  readLastFailureFile,
  resolveLastFailureFilePath,
  resolveStateFilePath,
  writeLastFailureFile,
  writeStateFile,
} from '@shared/sidecar/stateFile';

type Breadcrumb = Parameters<ErrorReporter['addBreadcrumb']>[0];
type OfficeExecFile = NonNullable<Parameters<typeof createOfficeSidecarManager>[0]['execFile']>;

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  exitCode: number | null = null;
  readonly killedSignals: string[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killedSignals.push(signal);
    queueMicrotask(() => {
      this.exitCode = signal === 'SIGKILL' ? null : 0;
      this.emit('exit', this.exitCode, signal);
    });
    return true;
  }

  emitReadyLine(readySignal: ReadySignal): void {
    this.stdout.write(`${JSON.stringify(readySignal)}\n`);
  }

  emitStdout(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  emitStderr(line: string): void {
    this.stderr.write(`${line}\n`);
  }

  triggerExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit('exit', code, signal);
  }

  triggerError(error: Error): void {
    this.emit('error', error);
  }
}

function buildPlatformConfig(
  userDataPath: string,
  surface: PlatformSurface = 'desktop',
  platform: NodeJS.Platform = process.platform,
): PlatformConfig {
  return {
    userDataPath,
    appPath: '/tmp/mindstone-rebel-test-app',
    tempPath: os.tmpdir(),
    logsPath: path.join(userDataPath, 'logs'),
    homePath: os.homedir(),
    documentsPath: path.join(os.homedir(), 'Documents'),
    desktopPath: path.join(os.homedir(), 'Desktop'),
    appDataPath: path.join(os.homedir(), 'AppData'),
    version: '0.0.0-test',
    isPackaged: false,
    platform,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    arch: process.arch,
    surface,
    isOss: false,
    capabilities: defaultCapabilities(surface),
  };
}

function buildErrorReporter(): ErrorReporter & {
  breadcrumbs: Breadcrumb[];
  captured: Array<{ error: unknown; context?: Record<string, unknown> }>;
} {
  const breadcrumbs: Breadcrumb[] = [];
  const captured: Array<{ error: unknown; context?: Record<string, unknown> }> = [];

  return {
    breadcrumbs,
    captured,
    addBreadcrumb: (breadcrumb) => {
      breadcrumbs.push(breadcrumb);
    },
    captureException: (error, context) => {
      captured.push({ error, context });
    },
    captureMessage: () => {},
  };
}

function buildLogger(): Logger & {
  records: Array<{ level: string; data: unknown; message: string }>;
} {
  const records: Array<{ level: string; data: unknown; message: string }> = [];

  const push = (level: string, args: unknown[]): void => {
    const [first, second] = args;
    if (typeof first === 'string') {
      records.push({ level, data: undefined, message: first });
      return;
    }

    records.push({
      level,
      data: first,
      message: typeof second === 'string' ? second : '',
    });
  };

  return {
    records,
    info: (...args: unknown[]) => push('info', args),
    warn: (...args: unknown[]) => push('warn', args),
    error: (...args: unknown[]) => push('error', args),
    debug: (...args: unknown[]) => push('debug', args),
    trace: (...args: unknown[]) => push('trace', args),
    fatal: (...args: unknown[]) => push('fatal', args),
  } as unknown as Logger & {
    records: Array<{ level: string; data: unknown; message: string }>;
  };
}

type ManagerHarnessOptions = {
  userDataPath?: string;
  surface?: PlatformSurface;
  platform?: NodeJS.Platform;
  capabilities?: PlatformConfig['capabilities'];
  readKillSwitch?: () => string | undefined;
  spawnFactory?: (child: FakeChild, callIndex: number, stateDir: string) => void;
  requestSidecar?: (port: number, pathname: string, token?: string, timeoutMs?: number) => Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
  }>;
  isPidAlive?: (pid: number) => boolean;
  signalProcess?: (pid: number, signal?: NodeJS.Signals | 0) => void;
  timings?: OfficeSidecarTimingOptions;
};

type ManagerHarness = {
  manager: OfficeSidecarManager;
  platformConfig: PlatformConfig;
  errorReporter: ReturnType<typeof buildErrorReporter>;
  logger: ReturnType<typeof buildLogger>;
  spawnCalls: Array<{ child: FakeChild; options: unknown }>;
  requestSidecar: ReturnType<typeof vi.fn>;
  signalProcess: ReturnType<typeof vi.fn>;
  isPidAlive: ReturnType<typeof vi.fn>;
  stateDir: string;
  stateFilePath: string;
  userDataPath: string;
};

const tempDirs: string[] = [];
const managersToStop: OfficeSidecarManager[] = [];

async function createHarness(options: ManagerHarnessOptions = {}): Promise<ManagerHarness> {
  const userDataPath = options.userDataPath ?? await fs.mkdtemp(path.join(os.tmpdir(), 'office-sidecar-manager-'));
  if (!options.userDataPath) {
    tempDirs.push(userDataPath);
  }

  const basePlatformConfig = buildPlatformConfig(userDataPath, options.surface, options.platform);
  const platformConfig: PlatformConfig = options.capabilities
    ? { ...basePlatformConfig, capabilities: options.capabilities }
    : basePlatformConfig;
  setPlatformConfig(platformConfig);
  const errorReporter = buildErrorReporter();
  const logger = buildLogger();
  const stateDir = path.join(userDataPath, 'mcp', 'rebeloffice');
  const stateFilePath = resolveStateFilePath(stateDir);
  const fakeCliPath = path.join(userDataPath, 'office-sidecar-cli.js');
  const fakeAddinDir = path.join(userDataPath, 'office-addin');
  const spawnCalls: Array<{ child: FakeChild; options: unknown }> = [];

  await fs.mkdir(fakeAddinDir, { recursive: true });
  await fs.writeFile(fakeCliPath, '// test cli stub\n', 'utf8');

  let nextPid = 4_000;
  const spawnChild = vi.fn((_: string, __: readonly string[], forkOptions: unknown) => {
    const child = new FakeChild(nextPid++);
    spawnCalls.push({ child, options: forkOptions });
    void options.spawnFactory?.(child, spawnCalls.length - 1, stateDir);
    return child as unknown as ChildProcess;
  });

  const requestSidecar = vi.fn(
    options.requestSidecar ??
      (async () => ({
        statusCode: 404,
        headers: {},
      })),
  );

  const alivePids = new Set<number>([process.pid]);
  const isPidAlive = vi.fn(
    options.isPidAlive ??
      ((pid: number) => alivePids.has(pid)),
  );

  const signalProcess = vi.fn(
    options.signalProcess ??
      ((pid: number, signal?: NodeJS.Signals | 0) => {
        if (signal) {
          alivePids.delete(pid);
        }
      }),
  );

  const manager = createOfficeSidecarManager({
    platformConfig,
    errorReporter,
    logger,
    readKillSwitch: options.readKillSwitch,
    spawnChild,
    requestSidecar,
    isPidAlive,
    signalProcess,
    resolveSidecarScript: () => fakeCliPath,
    resolveAddinDir: () => fakeAddinDir,
    timings: {
      startTimeoutMs: 50,
      healthTimeoutMs: 50,
      identifyTimeoutMs: 50,
      lockRetryDelayMs: 20,
      lockMaxAttempts: 5,
      adoptedPollIntervalMs: 20,
      adoptedRestartDelayMs: 10,
      stopTimeoutMs: 50,
      stopPollIntervalMs: 5,
      restartBackoffsMs: [20, 40, 60, 80, 100],
      stabilityResetMs: 100,
      ...options.timings,
    },
  });
  managersToStop.push(manager);

  return {
    manager,
    platformConfig,
    errorReporter,
    logger,
    spawnCalls,
    requestSidecar,
    signalProcess,
    isPidAlive,
    stateDir,
    stateFilePath,
    userDataPath,
  };
}

type ManagedInstallFixture = {
  metadata: InstallMetadata;
  stateDir: string;
  stateFilePath: string;
  defaults: {
    certificateDirectory: string;
    caCertificatePath: string;
    localhostCertificatePath: string;
    localhostKeyPath: string;
    certificateName: string;
    daysUntilCertificateExpires: number;
    domain: string | readonly string[];
  };
};

type ManagedInstallHarnessOptions = {
  platform?: NodeJS.Platform;
  moduleSource: string;
  defaultsOverrides?: Partial<ManagedInstallFixture['defaults']>;
  execFileImpl?: (command: string, args: readonly string[]) => {
    error?: Error;
    stdout?: string;
    stderr?: string;
  };
  requestSidecar?: (port: number, pathname: string, token?: string, timeoutMs?: number) => Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
  }>;
  isPidAlive?: (pid: number) => boolean;
  spawnFactory?: (child: FakeChild, callIndex: number, fixture: ManagedInstallFixture) => void;
};

type ManagedInstallHarness = {
  manager: OfficeSidecarManager;
  platformConfig: PlatformConfig;
  errorReporter: ReturnType<typeof buildErrorReporter>;
  logger: ReturnType<typeof buildLogger>;
  fixture: ManagedInstallFixture;
  spawnCalls: Array<{ child: FakeChild; options: unknown; modulePath: string }>;
  execFileMock: ReturnType<typeof vi.fn>;
  getMetadata: ReturnType<typeof vi.fn>;
};

async function createManagedInstallFixture(
  userDataPath: string,
  moduleSource: string,
  defaultsOverrides: Partial<ManagedInstallFixture['defaults']> = {},
): Promise<ManagedInstallFixture> {
  const packageSpec = OFFICE_MCP_PACKAGE_SPECS_TO_TRY[0] ?? OFFICE_MCP_PACKAGE_SPEC;
  const [packageName, packageVersion] = packageSpec.split(/@(?=\d)/);
  if (!packageName || !packageVersion) {
    throw new Error(`Invalid Office package spec in test fixture: ${packageSpec}`);
  }

  const installRoot = path.join(userDataPath, 'mcp', 'managed-installs', 'office-cert-preflight-fixture');
  const packageDir = path.join(installRoot, 'node_modules', ...packageName.split('/'));
  const cliPath = path.join(packageDir, 'dist', 'sidecar', 'cli.js');
  const addinDir = path.join(packageDir, 'dist', 'addin');
  const entryPath = path.join(packageDir, 'dist', 'index.js');
  const devCertLibDir = path.join(installRoot, 'node_modules', 'office-addin-dev-certs', 'lib');
  const certificateDirectory = path.join(userDataPath, '.office-addin-dev-certs');
  const defaults: ManagedInstallFixture['defaults'] = {
    certificateDirectory,
    caCertificatePath: path.join(certificateDirectory, 'ca.crt'),
    localhostCertificatePath: path.join(certificateDirectory, 'localhost.crt'),
    localhostKeyPath: path.join(certificateDirectory, 'localhost.key'),
    certificateName: 'Developer CA for Microsoft Office Add-ins',
    daysUntilCertificateExpires: 30,
    domain: 'localhost',
    ...defaultsOverrides,
  };

  await fs.mkdir(path.dirname(cliPath), { recursive: true });
  await fs.mkdir(addinDir, { recursive: true });
  await fs.mkdir(devCertLibDir, { recursive: true });
  await fs.mkdir(defaults.certificateDirectory, { recursive: true });
  await fs.writeFile(cliPath, '// managed sidecar cli fixture\n', 'utf8');
  await fs.writeFile(entryPath, '// managed sidecar entry fixture\n', 'utf8');
  await fs.writeFile(path.join(devCertLibDir, 'main.js'), moduleSource, 'utf8');
  await fs.writeFile(
    path.join(devCertLibDir, 'defaults.js'),
    `module.exports = ${JSON.stringify(defaults, null, 2)};\n`,
    'utf8',
  );

  const stateDir = path.join(userDataPath, 'mcp', 'rebeloffice');
  const stateFilePath = resolveStateFilePath(stateDir);

  return {
    metadata: {
      packageSpec,
      packageName,
      version: packageVersion,
      entryPath,
      installRoot,
      installedAt: new Date(0).toISOString(),
      platform: process.platform,
      nodeVersion: process.version,
      metaVersion: 1,
    },
    stateDir,
    stateFilePath,
    defaults,
  };
}

function asOfficeExecFile(mock: ReturnType<typeof vi.fn>): OfficeExecFile {
  return mock as unknown as OfficeExecFile;
}

async function createManagedInstallHarness(
  options: ManagedInstallHarnessOptions,
): Promise<ManagedInstallHarness> {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sidecar-managed-preflight-'));
  tempDirs.push(userDataPath);

  const platformConfig = buildPlatformConfig(userDataPath, 'desktop', options.platform);
  setPlatformConfig(platformConfig);
  const errorReporter = buildErrorReporter();
  const logger = buildLogger();
  const fixture = await createManagedInstallFixture(
    userDataPath,
    options.moduleSource,
    options.defaultsOverrides,
  );

  let nextPid = 4_600;
  const spawnCalls: Array<{ child: FakeChild; options: unknown; modulePath: string }> = [];
  const spawnChild = vi.fn((modulePath: string, _args: readonly string[], forkOptions: unknown) => {
    const child = new FakeChild(nextPid++);
    const callIndex = spawnCalls.length;
    spawnCalls.push({ child, options: forkOptions, modulePath });
    if (options.spawnFactory) {
      options.spawnFactory(child, callIndex, fixture);
    } else {
      queueMicrotask(() => {
        child.emitReadyLine({
          type: 'ready',
          pid: child.pid,
          port: 52_100 + callIndex,
          token: String(callIndex + 1).repeat(64),
          stateFilePath: fixture.stateFilePath,
          wefInstallResults: [],
        });
      });
    }
    return child as unknown as ChildProcess;
  });

  const requestSidecar = vi.fn(
    options.requestSidecar ??
      (async () => ({
        statusCode: 404,
        headers: {},
      })),
  );

  const alivePids = new Set<number>([process.pid]);
  const isPidAlive = vi.fn(
    options.isPidAlive ??
      ((pid: number) => alivePids.has(pid)),
  );

  const signalProcess = vi.fn((pid: number, signal?: NodeJS.Signals | 0) => {
    if (signal) {
      alivePids.delete(pid);
    }
  });

  const getMetadata = vi.fn(async (spec: string) =>
    spec === fixture.metadata.packageSpec ? fixture.metadata : null,
  );
  const execFileMock = vi.fn(
    (
      command: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const result = options.execFileImpl?.(command, args) ?? {};
      callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '');
    },
  );

  const manager = createOfficeSidecarManager({
    platformConfig,
    errorReporter,
    logger,
    spawnChild,
    requestSidecar,
    isPidAlive,
    signalProcess,
    execFile: asOfficeExecFile(execFileMock),
    managedMcpInstallService: { getMetadata },
    timings: {
      startTimeoutMs: 50,
      healthTimeoutMs: 50,
      identifyTimeoutMs: 50,
      lockRetryDelayMs: 20,
      lockMaxAttempts: 5,
      stopTimeoutMs: 50,
      stopPollIntervalMs: 5,
      restartBackoffsMs: [20, 40, 60, 80, 100],
      stabilityResetMs: 100,
    },
  });
  managersToStop.push(manager);

  return {
    manager,
    platformConfig,
    errorReporter,
    logger,
    fixture,
    spawnCalls,
    execFileMock,
    getMetadata,
  };
}

function buildReadySignal(stateFilePath: string, overrides: Partial<ReadySignal> = {}): ReadySignal {
  return {
    type: 'ready',
    pid: 9_001,
    port: 52_100,
    token: 'a'.repeat(64),
    stateFilePath,
    wefInstallResults: [],
    ...overrides,
  };
}

async function persistState(
  stateDir: string,
  overrides: Partial<Parameters<typeof buildReadySignal>[1]> = {},
): Promise<ReadySignal> {
  const readySignal = buildReadySignal(resolveStateFilePath(stateDir), overrides);
  await writeStateFile(
    {
      port: readySignal.port,
      token: readySignal.token,
      pid: readySignal.pid,
      lastEagerStartErrorCode: undefined,
    },
    stateDir,
  );
  return readySignal;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

beforeEach(() => {
  setOfficeSidecarManagerForShutdown(null);
  __resetManagedMcpInstallSingletonForTesting();
});

afterEach(async () => {
  vi.useRealTimers();
  setOfficeSidecarManagerForShutdown(null);
  __resetManagedMcpInstallSingletonForTesting();

  while (managersToStop.length > 0) {
    const manager = managersToStop.pop();
    if (manager) {
      await manager.stop();
    }
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('officeSidecarManager Stage 1', () => {
  it('skips startup without Sentry capture when managed install service is not configured', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sidecar-no-managed-install-'));
    tempDirs.push(userDataPath);
    const platformConfig = buildPlatformConfig(userDataPath, 'desktop', 'linux');
    setPlatformConfig(platformConfig);
    const errorReporter = buildErrorReporter();
    const logger = buildLogger();
    const spawnChild = vi.fn(() => {
      throw new Error('should not spawn');
    });

    const manager = createOfficeSidecarManager({
      platformConfig,
      errorReporter,
      logger,
      spawnChild,
      timings: { startTimeoutMs: 10 },
    });
    managersToStop.push(manager);

    await expect(manager.start()).resolves.toBeNull();

    expect(spawnChild).not.toHaveBeenCalled();
    expect(manager.getLastError()).toBeNull();
    expect(errorReporter.captured).toHaveLength(0);
    expect(errorReporter.breadcrumbs).toContainEqual(
      expect.objectContaining({
        category: 'office-sidecar',
        level: 'info',
        message: 'office-sidecar-skipped',
        data: expect.objectContaining({ reason: 'managed-install-service-unavailable' }),
      }),
    );
  });

  it('starts successfully and returns runtime state', async () => {
    const harness = await createHarness({
      spawnFactory: async (child, _callIndex, stateDir) => {
        const readySignal = await persistState(stateDir);
        queueMicrotask(() => {
          child.emitReadyLine(readySignal);
        });
      },
    });

    const state = await harness.manager.start();

    expect(state?.port).toBeGreaterThan(0);
    expect(harness.manager.isRunning()).toBe(true);
    expect(harness.manager.getLastError()).toBeNull();
    expect(harness.spawnCalls).toHaveLength(1);
  });

  it('skips startup when the kill switch is enabled', async () => {
    const harness = await createHarness({
      readKillSwitch: () => '1',
    });

    await expect(harness.manager.start()).resolves.toBeNull();
    expect(harness.manager.getSkipReason()).toBe('kill-switch');
    expect(harness.spawnCalls).toHaveLength(0);
  });

  it('skips startup on non-desktop surfaces', async () => {
    const harness = await createHarness({
      surface: 'cloud',
    });

    await expect(harness.manager.start()).resolves.toBeNull();
    expect(harness.manager.getSkipReason()).toBe('surface-not-desktop');
    expect(harness.spawnCalls).toHaveLength(0);
  });

  it('skips startup when capabilities.officeSidecar is false even on desktop surface', async () => {
    const harness = await createHarness({
      surface: 'desktop',
      capabilities: { ...defaultCapabilities('desktop'), officeSidecar: false },
    });

    await expect(harness.manager.start()).resolves.toBeNull();
    expect(harness.manager.getSkipReason()).toBe('surface-not-desktop');
    expect(harness.spawnCalls).toHaveLength(0);
  });

  it('coalesces idempotent double-start calls', async () => {
    let readySignal!: ReadySignal;
    const harness = await createHarness({
      spawnFactory: async (child, _callIndex, stateDir) => {
        readySignal = await persistState(stateDir);
        setTimeout(() => {
          child.emitReadyLine(readySignal);
        }, 5);
      },
    });

    const [first, second] = await Promise.all([
      harness.manager.start(),
      harness.manager.start(),
    ]);

    expect(first).toEqual(second);
    expect(harness.spawnCalls).toHaveLength(1);
  });

  it('keeps stop() idempotent before start and after owned sidecar shutdown', async () => {
    const harness = await createHarness({
      spawnFactory: async (child, _callIndex, stateDir) => {
        const readySignal = await persistState(stateDir);
        queueMicrotask(() => {
          child.emitReadyLine(readySignal);
        });
      },
    });

    await expect(harness.manager.stop()).resolves.toBeUndefined();
    await harness.manager.start();
    await harness.manager.stop();
    await harness.manager.stop();

    expect(harness.signalProcess).toHaveBeenCalledTimes(1);
    expect(harness.manager.isRunning()).toBe(false);
    expect(harness.manager.getState()).toBeNull();
  });

  // Flaky under parallel Vitest worker stress (timing-sensitive backoff sleeps);
  // passes in isolation. Sibling test in this file uses the same pragmatic retry.
  it('auto-restarts after a child crash with bounded backoff', { retry: 3 }, async () => {
    const harness = await createHarness({
      spawnFactory: async (child, callIndex, stateDir) => {
        const readySignal = await persistState(stateDir, {
          pid: 9_001 + callIndex,
          port: 52_100 + callIndex,
          token: `${String(callIndex + 1).repeat(64)}`,
        });
        queueMicrotask(() => {
          child.emitReadyLine(readySignal);
        });
      },
    });

    await harness.manager.start();
    const firstChild = harness.spawnCalls[0]!.child;
    firstChild.triggerExit(1);

    expect(harness.spawnCalls).toHaveLength(1);
    await sleep(10);
    expect(harness.spawnCalls).toHaveLength(1);
    await sleep(30);

    expect(harness.spawnCalls).toHaveLength(2);
    expect(harness.manager.getState()?.port).toBe(52_101);
  });

  // Flaky under parallel Vitest worker stress (timing-sensitive backoff loop);
  // passes in isolation. Sibling test in this file uses the same pragmatic retry.
  it('gives up after five restart attempts and clears runtime state', { retry: 3 }, async () => {
    const harness = await createHarness({
      spawnFactory: async (child, callIndex, stateDir) => {
        const readySignal = await persistState(stateDir, {
          pid: 9_100 + callIndex,
          port: 52_100 + callIndex,
          token: `${String(callIndex + 2).repeat(64)}`,
        });
        queueMicrotask(() => {
          child.emitReadyLine(readySignal);
        });
      },
    });

    await harness.manager.start();

    for (const [attemptIndex, backoffMs] of [20, 40, 60, 80, 100].entries()) {
      const child = harness.spawnCalls.at(-1)!.child;
      child.triggerExit(1);
      await vi.waitFor(() => {
        expect(harness.spawnCalls).toHaveLength(attemptIndex + 2);
      }, { timeout: Math.max(1_000, backoffMs * 10) });
    }

    harness.spawnCalls.at(-1)!.child.triggerExit(1);
    await vi.waitFor(() => {
      expect(
        harness.errorReporter.breadcrumbs.some((breadcrumb) => breadcrumb.message === 'office-sidecar.restart-gave-up'),
      ).toBe(true);
    }, { timeout: 1_000 });

    expect(harness.manager.isRunning()).toBe(false);
    expect(harness.manager.getState()).toBeNull();
    expect(harness.manager.getLastError()?.code).toBe('child-crashed');
  });

  it('keeps the back-compat shims delegating through the registered manager', async () => {
    const harness = await createHarness({
      spawnFactory: async (child, _callIndex, stateDir) => {
        const readySignal = await persistState(stateDir);
        queueMicrotask(() => {
          child.emitReadyLine(readySignal);
        });
      },
    });
    setOfficeSidecarManagerForShutdown(harness.manager);

    const state = await startOfficeSidecar();

    expect(getOfficeSidecarManager()).toBe(harness.manager);
    expect(state?.port).toBe(52_100);
    expect(isOfficeSidecarRunning()).toBe(true);

    await stopOfficeSidecar();

    expect(isOfficeSidecarRunning()).toBe(false);
  });

  it('keeps adopted stopOfficeSidecar() idempotent across repeated shutdown calls', async () => {
    const harness = await createHarness({
      requestSidecar: async (_port, pathname) => {
        if (pathname === '/health') {
          return { statusCode: 200, headers: {} };
        }
        return { statusCode: 204, headers: { 'x-rebel-sidecar-pid': '9001' } };
      },
      isPidAlive: (pid) => pid === process.pid || pid === 9_001,
    });
    await persistState(harness.stateDir);
    setOfficeSidecarManagerForShutdown(harness.manager);

    await harness.manager.start();
    await stopOfficeSidecar();
    await stopOfficeSidecar();

    expect(harness.signalProcess).not.toHaveBeenCalled();
    await expect(fs.access(harness.stateFilePath)).resolves.toBeUndefined();
    expect(harness.manager.getState()).toBeNull();
  });

  it('adopts an existing healthy sidecar without spawning a new child', async () => {
    const harness = await createHarness({
      requestSidecar: async (_port, pathname) => {
        if (pathname === '/health') {
          return { statusCode: 200, headers: {} };
        }
        return { statusCode: 204, headers: { 'x-rebel-sidecar-pid': '9001' } };
      },
      isPidAlive: (pid) => pid === process.pid || pid === 9_001,
    });
    await persistState(harness.stateDir);

    const state = await harness.manager.start();

    expect(state).toMatchObject({
      adopted: true,
      pid: 9_001,
      port: 52_100,
    });
    expect(harness.spawnCalls).toHaveLength(0);
  });

  it.each([
    ['401 identify', async (harness: ManagerHarness) => {
      harness.requestSidecar.mockImplementation(async (_port: number, pathname: string) => {
        if (pathname === '/health') {
          return { statusCode: 200, headers: {} };
        }
        return { statusCode: 401, headers: {} };
      });
    }],
    ['500 health', async (harness: ManagerHarness) => {
      harness.requestSidecar.mockImplementation(async () => ({ statusCode: 500, headers: {} }));
    }],
    ['dead pid', async (harness: ManagerHarness) => {
      harness.isPidAlive.mockImplementation((pid: number) => pid === process.pid);
      harness.requestSidecar.mockImplementation(async () => ({ statusCode: 500, headers: {} }));
    }],
    ['missing state', async (harness: ManagerHarness) => {
      await fs.rm(harness.stateFilePath, { force: true });
    }],
    ['same process pid', async (harness: ManagerHarness) => {
      await writeStateFile(
        {
          port: 52_100,
          token: 'b'.repeat(64),
          pid: process.pid,
        },
        harness.stateDir,
      );
    }],
  ])('falls back to spawn when adoption preconditions fail (%s)', async (_label, arrange) => {
    const harness = await createHarness({
      requestSidecar: async () => ({ statusCode: 404, headers: {} }),
      isPidAlive: (pid) => pid === process.pid || pid === 9_001,
      spawnFactory: async (child, _callIndex, stateDir) => {
        const readySignal = await persistState(stateDir, { token: 'c'.repeat(64) });
        queueMicrotask(() => {
          child.emitReadyLine(readySignal);
        });
      },
    });

    await persistState(harness.stateDir);
    await arrange(harness);

    const state = await harness.manager.start();

    expect(state?.adopted).toBe(false);
    expect(harness.spawnCalls).toHaveLength(1);
  });

  // Flake-tolerance note (D20 Stage 3, 2026-04-23):
  // This test races two managers through a filesystem lock + adoption path. The 1s
  // startTimeoutMs was flaky under parallel Vitest worker stress (0/1/2 failures across
  // 3 back-to-back runs). Chief bumped to 5s, then 10s; 9/20 runs still failed with
  // "Timed out waiting to acquire sidecar lock" (NOT startTimeout) at ~10s elapsed time.
  // The failure mode is SUSPECTED to be a lock acquisition starvation between the first
  // manager's spawn completion and the second manager's lock-retry loop — but the
  // underlying cause was NOT conclusively isolated to a true code race vs worker-thread
  // scheduler starvation under Vitest worker pressure. What IS proven: a single-attempt
  // run of this test is not deterministic on this machine class. Root-cause work is
  // deferred as follow-up hardening (either fake-timers, an in-memory lock mock, or a
  // deterministic promise-controlled handoff in spawnFactory to gate manager release).
  //
  // Pragmatic interim fix: { retry: 5 } so the behavioral assertion (second adopts
  // first) still catches genuine regressions if all retries fail, but ordinary
  // schedule-induced flake doesn't break CI. Keep startTimeoutMs at 10s to give the
  // adoption path breathing room. TRADEOFF: retry(5) can mask moderate-probability
  // regressions that would fail 1-of-1 runs. If CI starts greenlighting buggy fixes
  // against this test, remove retry first and re-investigate the race.
  //
  // TODO(D20-Stage-3-followup): remove { retry: 5 } once the test is made deterministic
  // or the lock-acquisition starvation is proven as the root cause. Tracked in Stage 6
  // pathologist postmortem (see docs-private/postmortems/ after Stage 6 lands).
  // See docs/plans/260425_d20_super_mcp_ci_wiring.md §5 Stage 3 for investigation log.
  it('serializes two managers through the filesystem lock and lets the second adopt the first', { retry: 5 }, async () => {
    const sharedUserDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sidecar-shared-'));
    tempDirs.push(sharedUserDataPath);

    const first = await createHarness({
      userDataPath: sharedUserDataPath,
      timings: {
        startTimeoutMs: 10_000,
        lockRetryDelayMs: 10,
        lockMaxAttempts: 200,
      },
      isPidAlive: (pid) => pid === process.pid || pid === 9_001,
      requestSidecar: async (_port, pathname) => {
        if (pathname === '/health') {
          return { statusCode: 200, headers: {} };
        }
        return { statusCode: 204, headers: { 'x-rebel-sidecar-pid': '9001' } };
      },
      spawnFactory: (child, _callIndex, stateDir) => {
        const readySignal = buildReadySignal(resolveStateFilePath(stateDir));
        setTimeout(() => {
          void (async () => {
            await writeStateFile(
              {
                port: readySignal.port,
                token: readySignal.token,
                pid: readySignal.pid,
              },
              stateDir,
            );
            child.emitReadyLine(readySignal);
          })();
        }, 20);
      },
    });
    const second = await createHarness({
      userDataPath: sharedUserDataPath,
      timings: {
        startTimeoutMs: 10_000,
        lockRetryDelayMs: 10,
        lockMaxAttempts: 200,
      },
      isPidAlive: (pid) => pid === process.pid || pid === 9_001,
      requestSidecar: async (_port, pathname) => {
        if (pathname === '/health') {
          return { statusCode: 200, headers: {} };
        }
        return { statusCode: 204, headers: { 'x-rebel-sidecar-pid': '9001' } };
      },
    });

    const firstStart = first.manager.start();
    const secondStart = second.manager.start();
    const combined = Promise.all([firstStart, secondStart]);

    await sleep(60);
    const [firstState, secondState] = await combined;

    expect(firstState?.adopted).toBe(false);
    expect(secondState?.adopted).toBe(true);
    expect(first.spawnCalls).toHaveLength(1);
    expect(second.spawnCalls).toHaveLength(0);
  });

  it('recovers a stale filesystem lock when the recorded holder pid is dead', async () => {
    const harness = await createHarness({
      spawnFactory: async (child, _callIndex, stateDir) => {
        const readySignal = await persistState(stateDir, { token: 'c'.repeat(64) });
        queueMicrotask(() => {
          child.emitReadyLine(readySignal);
        });
      },
    });
    const lockFilePath = path.join(harness.stateDir, 'sidecar.lock');

    await fs.mkdir(harness.stateDir, { recursive: true });
    await fs.writeFile(lockFilePath, String(process.pid + 100_000), 'utf8');

    const state = await harness.manager.start();

    expect(state?.adopted).toBe(false);
    expect(harness.spawnCalls).toHaveLength(1);
    await expect(fs.access(lockFilePath)).rejects.toThrow();
  });

  it('recovers a stale filesystem lock when the live holder timestamp is too old', async () => {
    const harness = await createHarness({
      spawnFactory: async (child, _callIndex, stateDir) => {
        const readySignal = await persistState(stateDir, { token: 'd'.repeat(64) });
        queueMicrotask(() => {
          child.emitReadyLine(readySignal);
        });
      },
    });
    const lockFilePath = path.join(harness.stateDir, 'sidecar.lock');
    const staleAt = new Date(Date.now() - 120_000);

    await fs.mkdir(harness.stateDir, { recursive: true });
    await fs.writeFile(lockFilePath, String(process.pid), 'utf8');
    await fs.utimes(lockFilePath, staleAt, staleAt);

    const state = await harness.manager.start();

    expect(state?.adopted).toBe(false);
    expect(harness.spawnCalls).toHaveLength(1);
    await expect(fs.access(lockFilePath)).rejects.toThrow();
  });

  it('resolves sidecar CLI and add-in assets from managed-install metadata', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sidecar-managed-install-'));
    tempDirs.push(userDataPath);

    const platformConfig = buildPlatformConfig(userDataPath, 'desktop', 'linux');
    setPlatformConfig(platformConfig);
    const errorReporter = buildErrorReporter();
    const logger = buildLogger();
    const installRoot = path.join(
      userDataPath,
      'mcp',
      'managed-installs',
      '@mindstone',
      `mcp-server-office@${OFFICE_MCP_PACKAGE_VERSION}`,
    );
    const packageDir = path.join(
      installRoot,
      'node_modules',
      '@mindstone',
      'mcp-server-office',
    );
    const cliPath = path.join(packageDir, 'dist', 'sidecar', 'cli.js');
    const addinDir = path.join(packageDir, 'dist', 'addin');
    const stateDir = path.join(userDataPath, 'mcp', 'rebeloffice');
    const stateFilePath = resolveStateFilePath(stateDir);

    await fs.mkdir(path.dirname(cliPath), { recursive: true });
    await fs.mkdir(addinDir, { recursive: true });
    await fs.writeFile(cliPath, '// managed install cli stub\n', 'utf8');

    const metadata: InstallMetadata = {
      packageSpec: OFFICE_MCP_PACKAGE_SPEC,
      packageName: OFFICE_MCP_PACKAGE_NAME,
      version: OFFICE_MCP_PACKAGE_VERSION,
      entryPath: path.join(packageDir, 'dist', 'index.js'),
      installRoot,
      installedAt: new Date(0).toISOString(),
      platform: process.platform,
      nodeVersion: process.version,
      metaVersion: 1,
    };
    const getMetadata = vi.fn(async (spec: string) =>
      spec === OFFICE_MCP_PACKAGE_SPEC ? metadata : null,
    );
    const spawnCalls: Array<{ modulePath: string; env?: NodeJS.ProcessEnv }> = [];
    const spawnChild = vi.fn((modulePath: string, _args: readonly string[], forkOptions: { env?: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(4_500);
      spawnCalls.push({ modulePath, env: forkOptions.env });
      queueMicrotask(() => {
        child.emitReadyLine({
          type: 'ready',
          pid: child.pid,
          port: 52_100,
          token: 'e'.repeat(64),
          stateFilePath,
          wefInstallResults: [],
        });
      });
      return child as unknown as ChildProcess;
    });

    const manager = createOfficeSidecarManager({
      platformConfig,
      errorReporter,
      logger,
      managedMcpInstallService: { getMetadata },
      spawnChild,
      timings: {
        startTimeoutMs: 50,
        healthTimeoutMs: 50,
        identifyTimeoutMs: 50,
        lockRetryDelayMs: 20,
        lockMaxAttempts: 5,
        stopTimeoutMs: 50,
        stopPollIntervalMs: 5,
        restartBackoffsMs: [20, 40, 60, 80, 100],
        stabilityResetMs: 100,
      },
    });
    managersToStop.push(manager);

    const state = await manager.start();

    expect(state?.pid).toBe(4_500);
    expect(getMetadata).toHaveBeenCalledWith(OFFICE_MCP_PACKAGE_SPEC);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.modulePath).toBe(cliPath);
    expect(spawnCalls[0]?.env?.MCP_OFFICE_SIDECAR_STATE_DIR).toBe(stateDir);
    expect(spawnCalls[0]?.env?.MCP_OFFICE_ADDIN_DIR).toBe(addinDir);
  });

  it('classifies missing managed-install metadata as script-not-found without Sentry capture', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sidecar-missing-metadata-'));
    tempDirs.push(userDataPath);

    const platformConfig = buildPlatformConfig(userDataPath, 'desktop', 'linux');
    setPlatformConfig(platformConfig);
    const errorReporter = buildErrorReporter();
    const logger = buildLogger();
    const getMetadata = vi.fn(async () => null);

    const manager = createOfficeSidecarManager({
      platformConfig,
      errorReporter,
      logger,
      managedMcpInstallService: { getMetadata },
      timings: {
        startTimeoutMs: 50,
        healthTimeoutMs: 50,
        identifyTimeoutMs: 50,
        lockRetryDelayMs: 20,
        lockMaxAttempts: 5,
        stopTimeoutMs: 50,
        stopPollIntervalMs: 5,
        restartBackoffsMs: [20, 40, 60, 80, 100],
        stabilityResetMs: 100,
      },
    });
    managersToStop.push(manager);

    let caughtError: Error | null = null;
    try {
      await manager.start();
    } catch (err) {
      caughtError = err as Error;
    }
    expect(caughtError).toBeInstanceOf(Error);

    expect(getMetadata).toHaveBeenCalledWith(OFFICE_MCP_PACKAGE_SPEC);
    expect(manager.getLastError()?.code).toBe('script-not-found');
    expect(errorReporter.captured).toHaveLength(0);
    // FOX-3319: thrown error must list every spec we tried so operators
    // can diagnose scope mismatch from logs. (manager.getLastError() is the
    // sanitized user-facing message; the raw throw carries the detail.)
    for (const spec of OFFICE_MCP_PACKAGE_SPECS_TO_TRY) {
      expect(caughtError?.message).toContain(spec);
    }
  });

  it('FOX-3319: resolves Office sidecar from new-scope managed install when present', async () => {
    const newScopeSpec = OFFICE_MCP_PACKAGE_SPECS_TO_TRY[0];
    expect(newScopeSpec.startsWith('@mindstone/mcp-server-office@')).toBe(true);
    const [newScopeName, newScopeVersion] = newScopeSpec.split(/@(?=\d)/);

    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sidecar-new-scope-'));
    tempDirs.push(userDataPath);

    const platformConfig = buildPlatformConfig(userDataPath, 'desktop', 'linux');
    setPlatformConfig(platformConfig);
    const errorReporter = buildErrorReporter();
    const logger = buildLogger();
    const installRoot = path.join(
      userDataPath,
      'mcp',
      'managed-installs',
      '@mindstone',
      `mcp-server-office@${newScopeVersion}`,
    );
    const packageDir = path.join(installRoot, 'node_modules', ...newScopeName.split('/'));
    const cliPath = path.join(packageDir, 'dist', 'sidecar', 'cli.js');
    const addinDir = path.join(packageDir, 'dist', 'addin');
    const stateDir = path.join(userDataPath, 'mcp', 'rebeloffice');
    const stateFilePath = resolveStateFilePath(stateDir);

    await fs.mkdir(path.dirname(cliPath), { recursive: true });
    await fs.mkdir(addinDir, { recursive: true });
    await fs.writeFile(cliPath, '// new-scope managed install cli stub\n', 'utf8');

    const metadata: InstallMetadata = {
      packageSpec: newScopeSpec,
      packageName: newScopeName,
      version: newScopeVersion,
      entryPath: path.join(packageDir, 'dist', 'index.js'),
      installRoot,
      installedAt: new Date(0).toISOString(),
      platform: process.platform,
      nodeVersion: process.version,
      metaVersion: 1,
    };
    const getMetadata = vi.fn(async (spec: string) =>
      spec === newScopeSpec ? metadata : null,
    );
    const spawnCalls: Array<{ modulePath: string; env?: NodeJS.ProcessEnv }> = [];
    const spawnChild = vi.fn((modulePath: string, _args: readonly string[], forkOptions: { env?: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(4_700);
      spawnCalls.push({ modulePath, env: forkOptions.env });
      queueMicrotask(() => {
        child.emitReadyLine({
          type: 'ready',
          pid: child.pid,
          port: 52_120,
          token: 'f'.repeat(64),
          stateFilePath,
          wefInstallResults: [],
        });
      });
      return child as unknown as ChildProcess;
    });

    const manager = createOfficeSidecarManager({
      platformConfig,
      errorReporter,
      logger,
      managedMcpInstallService: { getMetadata },
      spawnChild,
      timings: {
        startTimeoutMs: 50,
        healthTimeoutMs: 50,
        identifyTimeoutMs: 50,
        lockRetryDelayMs: 20,
        lockMaxAttempts: 5,
        stopTimeoutMs: 50,
        stopPollIntervalMs: 5,
        restartBackoffsMs: [20, 40, 60, 80, 100],
        stabilityResetMs: 100,
      },
    });
    managersToStop.push(manager);

    const state = await manager.start();

    expect(state?.pid).toBe(4_700);
    expect(getMetadata).toHaveBeenCalledWith(newScopeSpec);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.modulePath).toBe(cliPath);
    // Also assert addinDir resolves under the new-scope packageName so
    // both path-derivation surfaces are exercised.
    expect(spawnCalls[0]?.env?.MCP_OFFICE_ADDIN_DIR).toBe(addinDir);
  });

  it('runs Darwin cert preflight fast-path without keychain subprocesses', async () => {
    const harness = await createManagedInstallHarness({
      platform: 'darwin',
      moduleSource: `
        module.exports = {
          verifyCertificates() {
            return true;
          },
          deleteCertificateFiles() {
            throw new Error('deleteCertificateFiles should not be called on fast path');
          },
          async generateCertificates() {
            throw new Error('generateCertificates should not be called on fast path');
          },
        };
      `,
      execFileImpl: () => ({
        error: new Error('security should not be called on fast path'),
      }),
    });

    const state = await harness.manager.start();

    expect(state?.adopted).toBe(false);
    expect(harness.spawnCalls).toHaveLength(1);
    expect(harness.execFileMock).not.toHaveBeenCalled();
    expect(
      harness.errorReporter.breadcrumbs.some(
        (breadcrumb) => breadcrumb.message === 'office-sidecar.cert-preflight.fast-path',
      ),
    ).toBe(true);
  });

  it('runs Darwin cert preflight regenerate path in order and parses SHA-1 hashes from security output', async () => {
    const orderLogPath = path.join(
      os.tmpdir(),
      `office-sidecar-cert-preflight-order-${Date.now()}-${Math.random().toString(16).slice(2)}.log`,
    );
    const hashOne = '0123456789ABCDEF0123456789ABCDEF01234567';
    const hashTwoLower = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const hashTwo = hashTwoLower.toUpperCase();

    const harness = await createManagedInstallHarness({
      platform: 'darwin',
      moduleSource: `
        const fs = require('node:fs');
        module.exports = {
          verifyCertificates() {
            fs.appendFileSync(${JSON.stringify(orderLogPath)}, 'verify\\n');
            return false;
          },
          deleteCertificateFiles() {
            fs.appendFileSync(${JSON.stringify(orderLogPath)}, 'delete-files\\n');
          },
          async generateCertificates() {
            fs.appendFileSync(${JSON.stringify(orderLogPath)}, 'generate\\n');
          },
        };
      `,
      execFileImpl: (command, args) => {
        if (command !== 'security') {
          return {};
        }

        const operation = args[0];
        if (operation === 'find-certificate') {
          fsSync.appendFileSync(orderLogPath, 'security-find\n');
          return {
            stdout: `Certificate:\nSHA-1 hash: ${hashOne}\nSHA-1 hash: ${hashTwoLower}\n`,
          };
        }
        if (operation === 'delete-certificate') {
          fsSync.appendFileSync(orderLogPath, `security-delete:${String(args[2])}\n`);
          return {};
        }
        if (operation === 'add-trusted-cert') {
          fsSync.appendFileSync(orderLogPath, 'security-add-trusted-cert\n');
          return {};
        }

        return {};
      },
    });

    const state = await harness.manager.start();
    const callOrder = (await fs.readFile(orderLogPath, 'utf8')).trim().split('\n');
    await fs.rm(orderLogPath, { force: true });

    expect(state?.adopted).toBe(false);
    expect(callOrder).toEqual([
      'verify',
      'delete-files',
      'security-find',
      `security-delete:${hashOne}`,
      `security-delete:${hashTwo}`,
      'generate',
      'security-add-trusted-cert',
    ]);

    const addTrustedCall = harness.execFileMock.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1][0] === 'add-trusted-cert',
    );
    const addTrustedArgs = (addTrustedCall?.[1] ?? []) as string[];
    expect(addTrustedArgs).not.toContain('-d');
    expect(addTrustedArgs).toContain(path.join(harness.platformConfig.homePath, 'Library', 'Keychains', 'login.keychain-db'));
    expect(addTrustedArgs.at(-1)).toBe(harness.fixture.defaults.caCertificatePath);
    expect(
      harness.errorReporter.breadcrumbs.some(
        (breadcrumb) => breadcrumb.message === 'office-sidecar.cert-preflight.regenerate',
      ),
    ).toBe(true);
  });

  it('treats cert preflight as a no-op on non-darwin platforms', async () => {
    const harness = await createManagedInstallHarness({
      platform: 'linux',
      moduleSource: `
        module.exports = {
          verifyCertificates() {
            throw new Error('verifyCertificates should not run on non-darwin');
          },
          deleteCertificateFiles() {},
          async generateCertificates() {},
        };
      `,
      execFileImpl: () => ({
        error: new Error('security should not run on non-darwin'),
      }),
    });

    const state = await harness.manager.start();

    expect(state?.adopted).toBe(false);
    expect(harness.execFileMock).not.toHaveBeenCalled();
    expect(
      harness.errorReporter.breadcrumbs.some(
        (breadcrumb) => breadcrumb.message === 'office-sidecar.cert-preflight.start',
      ),
    ).toBe(false);
  });

  it('classifies cert preflight API shape failures as cert-failed', async () => {
    const harness = await createManagedInstallHarness({
      platform: 'darwin',
      moduleSource: `
        module.exports = {
          verifyCertificates() {
            return false;
          },
          deleteCertificateFiles() {},
        };
      `,
    });

    await expect(harness.manager.start()).rejects.toBeInstanceOf(Error);
    expect(harness.manager.getLastError()?.code).toBe('cert-failed');
    expect(harness.spawnCalls).toHaveLength(0);
    expect(
      harness.errorReporter.breadcrumbs.some(
        (breadcrumb) => breadcrumb.message === 'office-sidecar.cert-preflight.failed',
      ),
    ).toBe(true);
  });

  it('does not run cert preflight when an existing sidecar is adopted', async () => {
    const harness = await createManagedInstallHarness({
      platform: 'darwin',
      moduleSource: `
        module.exports = {
          verifyCertificates() {
            throw new Error('verifyCertificates should not run when adoption succeeds');
          },
          deleteCertificateFiles() {},
          async generateCertificates() {},
        };
      `,
      requestSidecar: async (_port, pathname) => {
        if (pathname === '/health') {
          return { statusCode: 200, headers: {} };
        }
        return { statusCode: 204, headers: { 'x-rebel-sidecar-pid': '9001' } };
      },
      isPidAlive: (pid) => pid === process.pid || pid === 9_001,
    });

    await writeStateFile(
      {
        port: 52_100,
        token: 'z'.repeat(64),
        pid: 9_001,
      },
      harness.fixture.stateDir,
    );

    const state = await harness.manager.start();

    expect(state?.adopted).toBe(true);
    expect(harness.spawnCalls).toHaveLength(0);
    expect(harness.execFileMock).not.toHaveBeenCalled();
    expect(
      harness.errorReporter.breadcrumbs.some(
        (breadcrumb) => breadcrumb.message === 'office-sidecar.cert-preflight.start',
      ),
    ).toBe(false);
  });

  it('surfaces a timeout error when the filesystem lock stays held', async () => {
    const harness = await createHarness({
      isPidAlive: (pid) => pid === process.pid,
    });
    await fs.mkdir(harness.stateDir, { recursive: true });
    await fs.writeFile(path.join(harness.stateDir, 'sidecar.lock'), String(process.pid), 'utf8');

    const startPromise = harness.manager.start();
    const observed = expect(startPromise).rejects.toBeInstanceOf(Error);
    await sleep(150);

    await observed;
    await sleep(10);
    expect(harness.manager.getLastError()?.code).toBe('unknown');
  });

  it('restarts from adoption after three consecutive liveness failures', async () => {
    let requestCount = 0;
    const harness = await createHarness({
      isPidAlive: (pid) => pid === process.pid || pid === 9_001,
      requestSidecar: async (_port, pathname) => {
        if (pathname === '/sidecar/identify') {
          return { statusCode: 204, headers: { 'x-rebel-sidecar-pid': '9001' } };
        }

        requestCount += 1;
        if (requestCount === 1) {
          return { statusCode: 200, headers: {} };
        }
        return { statusCode: 500, headers: {} };
      },
      spawnFactory: async (child, _callIndex, stateDir) => {
        const readySignal = await persistState(stateDir, { port: 52_101, token: 'd'.repeat(64) });
        queueMicrotask(() => {
          child.emitReadyLine(readySignal);
        });
      },
    });
    await persistState(harness.stateDir);
    await harness.manager.start();

    await vi.waitFor(() => {
      expect(harness.manager.getState()?.adopted).toBe(false);
    }, { timeout: 5000 });
    expect(harness.spawnCalls).toHaveLength(1);
    expect(
      harness.errorReporter.breadcrumbs.some((breadcrumb) => breadcrumb.message === 'office-sidecar.adopted-lost'),
    ).toBe(true);
  });

  it('keeps adopted state healthy without respawning when health checks pass', async () => {
    vi.useFakeTimers();

    const harness = await createHarness({
      isPidAlive: (pid) => pid === process.pid || pid === 9_001,
      requestSidecar: async (_port, pathname) => {
        if (pathname === '/sidecar/identify') {
          return { statusCode: 204, headers: { 'x-rebel-sidecar-pid': '9001' } };
        }
        return { statusCode: 200, headers: {} };
      },
    });
    await persistState(harness.stateDir);

    await harness.manager.start();
    const before = harness.manager.getState()?.lastHealthAt ?? 0;
    await vi.advanceTimersByTimeAsync(20);
    const after = harness.manager.getState()?.lastHealthAt ?? 0;

    expect(after).toBeGreaterThanOrEqual(before);
    expect(harness.spawnCalls).toHaveLength(0);
  });

  it('cancels the adopted restart grace timer on stop so shutdown cannot respawn a foreign sidecar', async () => {
    vi.useFakeTimers();

    let healthRequests = 0;
    const harness = await createHarness({
      timings: {
        adoptedFailureThreshold: 1,
        adoptedRestartDelayMs: 1_000,
      },
      isPidAlive: (pid) => pid === process.pid || pid === 9_001,
      requestSidecar: async (_port, pathname) => {
        if (pathname === '/sidecar/identify') {
          return { statusCode: 204, headers: { 'x-rebel-sidecar-pid': '9001' } };
        }

        healthRequests += 1;
        return { statusCode: healthRequests === 1 ? 200 : 500, headers: {} };
      },
    });
    await persistState(harness.stateDir);
    await harness.manager.start();

    await vi.advanceTimersByTimeAsync(20);
    await harness.manager.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.spawnCalls).toHaveLength(0);
    expect(harness.signalProcess).not.toHaveBeenCalled();
  });

  it('cancels adopted liveness polling on stop without killing the adopted pid', async () => {
    vi.useFakeTimers();

    const harness = await createHarness({
      isPidAlive: (pid) => pid === process.pid || pid === 9_001,
      requestSidecar: async (_port, pathname) => {
        if (pathname === '/sidecar/identify') {
          return { statusCode: 204, headers: { 'x-rebel-sidecar-pid': '9001' } };
        }
        return { statusCode: 200, headers: {} };
      },
    });
    await persistState(harness.stateDir);
    await harness.manager.start();

    await harness.manager.stop();
    await vi.advanceTimersByTimeAsync(20 * 3);

    expect(harness.signalProcess).not.toHaveBeenCalled();
    expect(harness.requestSidecar).toHaveBeenCalledTimes(2);
  });

  it('tolerates non-JSON stdout lines before the ready signal', async () => {
    const harness = await createHarness({
      spawnFactory: async (child, _callIndex, stateDir) => {
        const readySignal = await persistState(stateDir);
        queueMicrotask(() => {
          child.emitStdout('garbage');
          child.emitReadyLine(readySignal);
        });
      },
    });

    const state = await harness.manager.start();

    expect(state?.port).toBe(52_100);
    expect(
      harness.logger.records.some((record) => (record.data as { line?: string } | undefined)?.line === 'garbage'),
    ).toBe(true);
  });

  it('rejects startup when the child exits before reporting ready', async () => {
    const harness = await createHarness({
      spawnFactory: (child) => {
        queueMicrotask(() => {
          child.triggerExit(1);
        });
      },
    });

    await expect(harness.manager.start()).rejects.toBeInstanceOf(Error);
    expect(['spawn-timeout', 'child-crashed']).toContain(harness.manager.getLastError()?.code);
  });

  it('kills the child when no ready output arrives within 30 seconds', async () => {
    const harness = await createHarness({
      spawnFactory: () => {
        // Intentionally silent.
      },
    });
    const startPromise = harness.manager.start();
    const rejected = expect(startPromise).rejects.toBeInstanceOf(Error);

    await sleep(70);

    await rejected;
    expect(harness.manager.getLastError()?.code).toBe('spawn-timeout');
    expect(harness.spawnCalls[0]!.child.killedSignals).toContain('SIGKILL');
  });

  it('does not capture script-not-found startup failures to Sentry', async () => {
    const harness = await createHarness();
    const cliPath = path.join(harness.userDataPath, 'office-sidecar-cli.js');
    await fs.rm(cliPath, { force: true });

    await expect(harness.manager.start()).rejects.toBeInstanceOf(Error);

    expect(harness.manager.getLastError()?.code).toBe('script-not-found');
    expect(harness.errorReporter.captured).toHaveLength(0);
  });

  it('ignores invalid ready payloads until a valid one arrives', async () => {
    const harness = await createHarness({
      spawnFactory: async (child, _callIndex, stateDir) => {
        const validReady = await persistState(stateDir, { token: 'e'.repeat(64) });
        queueMicrotask(() => {
          child.emitStdout(JSON.stringify({ type: 'ready', port: 0, token: 'abc', pid: 1234 }));
          child.emitStdout(JSON.stringify({ port: 52_100, token: 'abc', pid: 1234 }));
          child.emitReadyLine(validReady);
        });
      },
    });

    const state = await harness.manager.start();

    expect(state?.port).toBe(52_100);
  });

  it('writes sidecar-last-failure.json for eager-start failures before ready', async () => {
    const harness = await createHarness({
      spawnFactory: () => {
        throw new Error('listen EADDRINUSE: address already in use 127.0.0.1:52100');
      },
    });
    const before = Date.now();

    await expect(harness.manager.start()).rejects.toBeInstanceOf(Error);

    const lastFailure = await readLastFailureFile(harness.stateDir);
    expect(lastFailure).not.toBeNull();
    expect(lastFailure).toMatchObject({
      code: 'port-in-use',
    });
    expect(lastFailure!.at).toBeGreaterThanOrEqual(before);
  });

  it('logs malformed sidecar-last-failure.json reads before returning null', async () => {
    const harness = await createHarness();
    const lastFailureFilePath = resolveLastFailureFilePath(harness.stateDir);
    await fs.mkdir(harness.stateDir, { recursive: true });
    await fs.writeFile(lastFailureFilePath, '{"code":', 'utf8');

    await expect(readLastFailureFile(harness.stateDir, { logger: harness.logger })).resolves.toBeNull();

    expect(harness.logger.records).toContainEqual(expect.objectContaining({
      level: 'warn',
      message: 'Failed to read Office sidecar last-failure file',
      data: expect.objectContaining({
        err: expect.anything(),
        path: lastFailureFilePath,
      }),
    }));
  });

  it('clears sidecar-last-failure.json after a successful start', async () => {
    const harness = await createHarness({
      spawnFactory: async (child, _callIndex, stateDir) => {
        const readySignal = await persistState(stateDir, { token: 'success'.repeat(8) });
        queueMicrotask(() => {
          child.emitReadyLine(readySignal);
        });
      },
    });

    await writeLastFailureFile(harness.stateDir, {
      code: 'port-in-use',
      at: Date.now(),
    });

    await harness.manager.start();

    await expect(readLastFailureFile(harness.stateDir)).resolves.toBeNull();
  });

  it('surfaces wef-install-failed from the structured ready signal while still starting', async () => {
    const harness = await createHarness({
      spawnFactory: async (child, _callIndex, stateDir) => {
        const readySignal = await persistState(stateDir, {
          token: 'f'.repeat(64),
          wefInstallResults: [
            {
              app: 'word',
              status: 'failed',
              error: 'Install failed',
              path: '/tmp/wef',
            },
          ],
        });
        queueMicrotask(() => {
          child.emitReadyLine(readySignal);
        });
      },
    });

    const state = await harness.manager.start();

    expect(state?.port).toBe(52_100);
    expect(harness.manager.getLastError()?.code).toBe('wef-install-failed');
    expect(() => ReadySignalSchema.parse(buildReadySignal(harness.stateFilePath))).not.toThrow();
  });

  it('refuses insecure POSIX state files during adoption and spawns instead', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const harness = await createHarness({
      requestSidecar: async (_port, pathname) => {
        if (pathname === '/health') {
          return { statusCode: 200, headers: {} };
        }
        return { statusCode: 204, headers: { 'x-rebel-sidecar-pid': '9001' } };
      },
      isPidAlive: (pid) => pid === process.pid || pid === 9_001,
      spawnFactory: async (child, _callIndex, stateDir) => {
        const readySignal = await persistState(stateDir, { token: 'e'.repeat(64) });
        queueMicrotask(() => {
          child.emitReadyLine(readySignal);
        });
      },
    });
    await persistState(harness.stateDir);
    await fs.chmod(harness.stateFilePath, 0o644);

    const state = await harness.manager.start();

    expect(state?.adopted).toBe(false);
    expect(harness.spawnCalls).toHaveLength(1);
    expect(harness.requestSidecar).not.toHaveBeenCalled();
  });

  it('parses the exact ready payload shape emitted by cli.ts', () => {
    const cliReadyPayload = {
      type: 'ready',
      pid: 9_001,
      port: 52_100,
      token: 'f'.repeat(64),
      stateFilePath: path.join(os.tmpdir(), 'office-sidecar-ready', 'sidecar-state.json'),
      wefInstallResults: [
        {
          app: 'word',
          status: 'unchanged',
          path: path.join(os.tmpdir(), 'office-sidecar-ready', 'manifest.xml'),
        },
      ],
    } satisfies ReadySignal;

    expect(ReadySignalSchema.parse(JSON.parse(JSON.stringify(cliReadyPayload)))).toEqual(cliReadyPayload);
  });

  it('sanitizes raw startup failures before storing the lastError message', async () => {
    const harness = await createHarness({
      spawnFactory: (_child) => {
        throw new Error('/Users/alice/secret/path');
      },
    });

    await expect(harness.manager.start()).rejects.toBeInstanceOf(Error);
    expect(harness.manager.getLastError()?.message).not.toContain('/Users/');
  });

  it('captures a sanitized error for Sentry when start fails', async () => {
    const rawError = new Error(
      '/Users/alice/private/token 0123456789abcdef0123456789abcdef /Applications/Microsoft Word.app',
    );
    rawError.name = 'RawOfficeSidecarStartError';
    rawError.stack = 'RawOfficeSidecarStartError: boom\n    at /Users/alice/private/start.ts:1:1';
    const harness = await createHarness({
      spawnFactory: () => {
        throw rawError;
      },
    });

    await expect(harness.manager.start()).rejects.toBeInstanceOf(Error);

    expect(harness.errorReporter.captured).toHaveLength(1);
    const sentryError = harness.errorReporter.captured[0]!.error as Error;
    expect(sentryError.name).toBe('RawOfficeSidecarStartError');
    expect(sentryError.message).not.toContain('/Users/');
    expect(sentryError.message).not.toContain('/Applications/');
    expect(sentryError.message).not.toMatch(/[a-f0-9]{32}/i);
    expect(sentryError.stack).not.toBe(rawError.stack);
  });

  it('never logs the raw sidecar token or absolute userData path', async () => {
    const harness = await createHarness({
      spawnFactory: async (child, _callIndex, stateDir) => {
        const readySignal = await persistState(stateDir, { token: 'deadbeef'.repeat(8) });
        queueMicrotask(() => {
          child.emitStdout(JSON.stringify(readySignal));
          child.emitStdout(path.join(path.resolve(stateDir, '..', '..'), 'mcp', 'rebeloffice', 'sidecar-state.json'));
          child.emitReadyLine(readySignal);
        });
      },
    });

    await harness.manager.start();

    const combinedLogs = harness.logger.records
      .map((record) => JSON.stringify(record))
      .join('\n');
    const breadcrumbs = JSON.stringify(harness.errorReporter.breadcrumbs);

    expect(combinedLogs).not.toContain('deadbeef');
    expect(combinedLogs).toContain('<REDACTED_TOKEN>');
    expect(combinedLogs).toContain('<REDACTED_PATH>');
    expect(breadcrumbs).not.toContain('deadbeef');
  });

  it('covers helper redaction and constant-time equality utilities', async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'office-sidecar-redaction-'));
    tempDirs.push(userDataPath);
    setPlatformConfig(buildPlatformConfig(userDataPath));

    const token = 'abcdef0123456789abcdef0123456789';
    expect(redactPathsAndTokens(token)).toContain('<REDACTED_TOKEN>');
    expect(redactPathsAndTokens(path.join(userDataPath, 'mcp', 'rebeloffice', 'manifest.xml'))).toContain('<REDACTED_PATH>');
    expect(redactPathsAndTokens(path.join(os.homedir(), 'Desktop', 'notes.txt'))).toContain('<HOME>');
    expect(redactPathsAndTokens('/Applications/Microsoft Word.app')).toContain('<REDACTED_PATH>');

    expect(constantTimeStringEqual('token-123', 'token-123')).toBe(true);
    expect(constantTimeStringEqual('token-123', 'token-124')).toBe(false);
    expect(constantTimeStringEqual('short', 'longer')).toBe(false);
  });

  it('exits a child when the IPC channel disconnects', async () => {
    const fixturePath = path.join(
      process.cwd(),
      'src',
      'main',
      'services',
      '__tests__',
      'fixtures',
      'disconnect-child.js',
    );
    const child = fork(fixturePath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    await new Promise<void>((resolve) => {
      child.once('message', () => resolve());
    });

    const exit = new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('disconnect-child did not exit in time'));
      }, 5_000);

      child.once('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    child.disconnect();

    await expect(exit).resolves.toBe(42);
  });
});

describe('office-addin-dev-certs package layout contract', () => {
  it('imports the entrypoint declared by the upstream package.json', async () => {
    const candidates = [
      path.join(
        os.homedir(),
        'Library/Application Support/mindstone-rebel/mcp/managed-installs',
        OFFICE_MCP_PACKAGE_SPEC,
        'node_modules/office-addin-dev-certs/package.json',
      ),
      path.join(
        os.homedir(),
        'Library/Application Support/mindstone-rebel/mcp/managed-installs',
        '@mindstone-engineering/mcp-server-office@0.1.3',
        'node_modules/office-addin-dev-certs/package.json',
      ),
    ];
    const presentManifests = candidates.filter((p) => fsSync.existsSync(p));
    if (presentManifests.length === 0) {
      return;
    }
    for (const manifestPath of presentManifests) {
      const pkg = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { main?: string };
      expect(
        pkg.main,
        `${manifestPath} declares an unexpected entrypoint; update runOfficeCertPreflight import path`,
      ).toBe('./lib/main.js');
    }
  });
});
