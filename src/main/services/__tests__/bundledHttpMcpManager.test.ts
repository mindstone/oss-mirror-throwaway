import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServerUpsertPayloadSchema } from '@shared/ipc/schemas/mcp';

const logEntries = vi.hoisted((): Array<{ level: string; args: unknown[] }> => []);
const appendDiagnosticEvent = vi.hoisted(() => vi.fn());

 
vi.mock('@core/logger', () => {
  const push = (level: string) => (...args: unknown[]): void => {
    logEntries.push({ level, args });
  };
  return {
    createScopedLogger: () => ({
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    }),
  };
});

 
vi.mock('@core/services/diagnosticEventsLedger', () => ({ appendDiagnosticEvent }));
 
vi.mock('@core/services/superMcpHttpManager', () => ({
  findAvailablePort: vi.fn(async () => ({ port: 9_199, conflicted: false })),
}));

import {
  BundledHttpMcpManager,
  bundledHttpMcpDiagnosticEvents,
  type BundledHttpMcpDiagnosticEvent,
} from '../bundledHttpMcpManager';
import { defaultCapabilities, setPlatformConfig, type PlatformConfig, type PlatformSurface } from '@core/platform';

function buildTestPlatformConfig(surface: PlatformSurface): PlatformConfig {
  return {
    userDataPath: '/tmp/bundledHttpMcpManager-test',
    appPath: '/tmp/bundledHttpMcpManager-test-app',
    tempPath: '/tmp',
    logsPath: '/tmp/bundledHttpMcpManager-test/logs',
    homePath: '/tmp',
    documentsPath: '/tmp/Documents',
    desktopPath: '/tmp/Desktop',
    appDataPath: '/tmp/AppData',
    version: '0.0.0-test',
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    arch: process.arch,
    surface,
    isOss: false,
    capabilities: defaultCapabilities(surface),
  };
}

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFilePath);
const fixturePath = path.join(currentDir, 'fixtures', 'bundledHttpMcpFixtureServer.cjs');

const managers: BundledHttpMcpManager[] = [];

const allocatePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('No TCP port allocated')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });

const makeFindPortFn = () =>
  vi.fn(async () => ({ port: await allocatePort(), conflicted: false }));

const makeSpawnFn = (
  behavior: 'normal' | 'never-bind' | 'crash',
  onSpawn?: (child: ChildProcess) => void
): typeof spawn => {
  const spawnFn = ((
    command: string,
    args?: readonly string[],
    options?: SpawnOptions
  ): ChildProcess => {
    const child = spawn(command, args ? [...args] : [], {
      ...options,
      env: {
        ...options?.env,
        SPIKE_BEHAVIOR: behavior,
      },
    });
    onSpawn?.(child);
    return child;
  }) as typeof spawn;
  return spawnFn;
};

const makeManager = (opts: {
  behavior?: 'normal' | 'never-bind' | 'crash';
  startupTimeoutMs?: number;
  readinessPollMs?: number;
  onSpawn?: (child: ChildProcess) => void;
  spawnFn?: typeof spawn;
  findPortFn?: ReturnType<typeof makeFindPortFn>;
  surface?: 'desktop' | 'cloud';
} = {}): { manager: BundledHttpMcpManager; findPortFn: ReturnType<typeof makeFindPortFn> } => {
  const findPortFn = opts.findPortFn ?? makeFindPortFn();
  const manager = new BundledHttpMcpManager({
    surface: opts.surface ?? 'desktop',
    startupTimeoutMs: opts.startupTimeoutMs ?? 8_000,
    readinessPollMs: opts.readinessPollMs ?? 25,
    spawnFn: opts.spawnFn ?? makeSpawnFn(opts.behavior ?? 'normal', opts.onSpawn),
    findPortFn,
  });
  managers.push(manager);
  return { manager, findPortFn };
};

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
  logEntries.length = 0;
  appendDiagnosticEvent.mockClear();
  bundledHttpMcpDiagnosticEvents.removeAllListeners();
});

describe('BundledHttpMcpManager', () => {
  it('spawns a child, completes readiness, and reports ready status', async () => {
    const { manager, findPortFn } = makeManager();

    const result = await manager.spawn('FixtureServer', {
      scriptPath: fixturePath,
      env: {},
    });

    const pickedPort = (await findPortFn.mock.results[0].value).port;
    expect(result).toEqual({ url: `http://127.0.0.1:${pickedPort}/` });
    expect(manager.getHealthSnapshot()).toEqual({ FixtureServer: 'ready' });
  });

  it('times out when the child never binds and leaves failed status for cleanup', async () => {
    let spawnedChild: ChildProcess | undefined;
    const { manager } = makeManager({
      behavior: 'never-bind',
      startupTimeoutMs: 500,
      readinessPollMs: 25,
      onSpawn: (child) => {
        spawnedChild = child;
      },
    });

    await expect(
      manager.spawn('NeverBind', { scriptPath: fixturePath, env: {} })
    ).rejects.toThrow('BundledHttpMcp NeverBind not ready after 500ms');

    expect(spawnedChild?.killed).toBe(true);
    expect(manager.getHealthSnapshot()).toEqual({ NeverBind: 'failed' });
  });

  it('emits a diagnostic event when the child crashes during boot', async () => {
    const diagnosticEvents: BundledHttpMcpDiagnosticEvent[] = [];
    bundledHttpMcpDiagnosticEvents.on('event', (event) => diagnosticEvents.push(event));
    const { manager } = makeManager({
      behavior: 'crash',
      startupTimeoutMs: 8_000,
      readinessPollMs: 25,
    });

    await expect(
      manager.spawn('Crashy', { scriptPath: fixturePath, env: {} })
    ).rejects.toThrow(/Crashy exited before readiness|not ready after 8000ms/u);

    expect(diagnosticEvents).toEqual([
      expect.objectContaining({ type: 'crashed', serverName: 'Crashy', exitCode: 1 }),
    ]);
    expect(appendDiagnosticEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'mcp_transition',
        data: expect.objectContaining({ reason: 'process-exit' }),
      })
    );
  });

  it('makes stop idempotent', async () => {
    const { manager } = makeManager();
    await manager.spawn('FixtureServer', { scriptPath: fixturePath, env: {} });

    await expect(manager.stop('FixtureServer')).resolves.toBeUndefined();
    await expect(manager.stop('FixtureServer')).resolves.toBeUndefined();
  });

  it('waits for every child in stopAll', async () => {
    const killed: ChildProcess[] = [];
    const { manager } = makeManager({
      onSpawn: (child) => killed.push(child),
    });

    await Promise.all([
      manager.spawn('One', { scriptPath: fixturePath, env: {} }),
      manager.spawn('Two', { scriptPath: fixturePath, env: {} }),
      manager.spawn('Three', { scriptPath: fixturePath, env: {} }),
    ]);

    await manager.stopAll();

    expect(killed).toHaveLength(3);
    expect(killed.every((child) => child.killed || child.exitCode !== null || child.signalCode !== null)).toBe(true);
    expect(manager.getHealthSnapshot()).toEqual({});
  });

  it('returns an HTTP payload that validates without Authorization headers', async () => {
    const { manager } = makeManager();
    const { url } = await manager.spawn('PayloadServer', {
      scriptPath: fixturePath,
      env: {},
    });

    const payload = manager.getPayload('PayloadServer');
    const parsed = McpServerUpsertPayloadSchema.parse(payload);

    expect(parsed.transport).toBe('http');
    expect(parsed.type).toBe('http');
    expect(parsed.url).toBe(url);
    expect(parsed.headers?.Authorization).toBeUndefined();
  });

  it('redacts managed environment values from lifecycle logs', async () => {
    const { manager } = makeManager();

    await manager.spawn('RedactionServer', {
      scriptPath: fixturePath,
      env: { OPENAI_API_KEY: 'fake-secret-12345' },
    });

    expect(JSON.stringify(logEntries)).not.toContain('fake-secret-12345');
  });

  it('gates spawn on cloud surfaces before spawning a child', async () => {
    const spawnFn = vi.fn() as unknown as typeof spawn;
    const { manager } = makeManager({
      surface: 'cloud',
      spawnFn,
      findPortFn: makeFindPortFn(),
    });

    await expect(
      manager.spawn('CloudServer', { scriptPath: fixturePath, env: {} })
    ).rejects.toThrow('BundledHttpMcpManager.spawn is desktop-only; cloud surface should not call this');
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('is idempotent after a successful spawn', async () => {
    let spawnCount = 0;
    const { manager } = makeManager({
      onSpawn: () => {
        spawnCount += 1;
      },
    });

    const first = await manager.spawn('IdempotentServer', {
      scriptPath: fixturePath,
      env: {},
    });
    const second = await manager.spawn('IdempotentServer', {
      scriptPath: fixturePath,
      env: {},
    });

    expect(second).toEqual(first);
    expect(spawnCount).toBe(1);
  });

  it('restarts the child when the env signature changes', async () => {
    let spawnCount = 0;
    const { manager } = makeManager({
      onSpawn: () => {
        spawnCount += 1;
      },
    });

    await manager.spawn('SignatureServer', {
      scriptPath: fixturePath,
      env: { OPENAI_API_KEY: 'fake-old' },
    });
    await manager.spawn('SignatureServer', {
      scriptPath: fixturePath,
      env: { OPENAI_API_KEY: 'fake-new' },
    });

    expect(spawnCount).toBe(2);
    expect(manager.getHealthSnapshot()).toEqual({ SignatureServer: 'ready' });
  });

  describe('constructor surface default', () => {
    it('honours explicit opts.surface = "desktop"', () => {
      setPlatformConfig(buildTestPlatformConfig('cloud'));
      const manager = new BundledHttpMcpManager({ surface: 'desktop' });
      expect((manager as unknown as { surface: 'desktop' | 'cloud' }).surface).toBe('desktop');
    });

    it('honours explicit opts.surface = "cloud"', () => {
      setPlatformConfig(buildTestPlatformConfig('desktop'));
      const manager = new BundledHttpMcpManager({ surface: 'cloud' });
      expect((manager as unknown as { surface: 'desktop' | 'cloud' }).surface).toBe('cloud');
    });

    it('defaults to "cloud" when no opts.surface and platform surface is cloud', () => {
      setPlatformConfig(buildTestPlatformConfig('cloud'));
      const manager = new BundledHttpMcpManager();
      expect((manager as unknown as { surface: 'desktop' | 'cloud' }).surface).toBe('cloud');
    });

    it('defaults to "desktop" when no opts.surface and platform surface is desktop', () => {
      setPlatformConfig(buildTestPlatformConfig('desktop'));
      const manager = new BundledHttpMcpManager();
      expect((manager as unknown as { surface: 'desktop' | 'cloud' }).surface).toBe('desktop');
    });
  });
});
