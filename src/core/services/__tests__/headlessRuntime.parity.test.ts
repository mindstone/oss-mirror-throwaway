import { describe, expect, it, vi } from 'vitest';
import type { EventWindow } from '@core/types';
import type { AgentEvent, AgentTurnRequest, AppSettings } from '@shared/types';
import type { HeadlessRuntimeConfig } from '../headlessRuntime';
import type { AgentTurnServiceDeps } from '../agentTurnService';
import type { HeadlessTurnOptions } from '@core/types/headlessTurnOptions';

type TestOverrides = NonNullable<HeadlessRuntimeConfig['__testOverrides']>;

const makeSettings = (mcpConfigFile: string): AppSettings => ({
  coreDirectory: '/workspace',
  mcpConfigFile,
} as AppSettings);

const createRequest = (): AgentTurnRequest => ({
  sessionId: 'session-1',
  prompt: 'hello',
});

function createHarness(port: number): {
  order: string[];
  overrides: TestOverrides;
} {
  const order: string[] = [];
  const agentTurnRegistry: TestOverrides['agentTurnRegistry'] = {
    setEventListener: vi.fn((_turnId: string, _listener: (event: AgentEvent) => void) => undefined),
    deleteEventListener: vi.fn((_turnId: string) => true),
    getActiveTurnController: vi.fn((_turnId: string) => undefined),
    getTurnCloseCallback: vi.fn((_turnId: string) => undefined),
    deleteRendererSession: vi.fn((_turnId: string) => undefined),
    cancelExistingTurnForSession: vi.fn((_sessionId: string) => undefined),
    getActiveTurnForSession: vi.fn((_sessionId: string) => undefined),
    abortAllTurns: vi.fn(() => {
      order.push('abort-turns');
    }),
    getActiveTurnCount: vi.fn(() => {
      order.push('drain-turns');
      return 0;
    }),
  };

  const overrides: TestOverrides = {
    executeAgentTurn: vi.fn(async () => undefined) as AgentTurnServiceDeps['executeAgentTurn'],
    startAgentTurn: vi.fn((_deps, _request, _win) => ({ turnId: 'turn-1' })),
    runHeadlessTurn: vi.fn(async (_params: {
      prompt: string;
      onEvent: (event: AgentEvent) => void;
      options: HeadlessTurnOptions;
    }) => undefined),
    configureHeadlessTurnExecutor: vi.fn((_executeAgentTurn: AgentTurnServiceDeps['executeAgentTurn']) => undefined),
    agentTurnRegistry,
    dispatchAgentEvent: vi.fn((_win, _turnId, _event) => undefined) as AgentTurnServiceDeps['dispatchAgentEvent'],
    superMcpHttpManager: {
      getState: vi.fn(() => ({ isRunning: true, port, url: `http://127.0.0.1:${port}/mcp` })),
    },
    stopSuperMcpForHeadlessCleanup: vi.fn(async () => {
      order.push('stop-super-mcp');
    }),
    findAvailablePort: vi.fn(async (preferredPort: number) => ({ port: preferredPort, conflicted: false })),
    startSuperMcpWithRetries: vi.fn(async () => ({ success: true, port, attempts: 1 })),
    initCoreServices: vi.fn(async () => ({ errors: [], registeredMcpCount: 0 })),
    setMcpDisabled: vi.fn((_disabled: boolean) => undefined),
    registerPreOAuthCallHook: vi.fn((_hook: () => Promise<void>) => undefined),
    setMigrationComplete: vi.fn((_complete: boolean) => undefined),
    stopBundledInboxBridge: vi.fn(async () => {
      order.push('stop-inbox-bridge');
    }),
    closeFileIndex: vi.fn(async () => {
      order.push('close-file-index');
    }),
    proxyManager: {
      stop: vi.fn(async () => {
        order.push('stop-model-proxy');
      }),
    },
  };

  return { order, overrides };
}

describe('createHeadlessRuntime parity', () => {
  const rows = [
    {
      surface: 'desktop',
      userDataDir: '/tmp/rebel-desktop',
      resourcesDir: '/Applications/Rebel.app/Contents/Resources',
      isPackaged: true,
      routerConfigPath: '/tmp/rebel-desktop/mcp/super-mcp-router.json',
      portBase: 3100,
      portRange: 25,
    },
    {
      surface: 'cloud',
      userDataDir: '/data',
      resourcesDir: '/srv/rebel/resources',
      isPackaged: false,
      routerConfigPath: '/data/mcp/super-mcp-router.json',
      portBase: 3200,
      portRange: 25,
    },
    {
      surface: 'eval',
      userDataDir: '/tmp/rebel-eval',
      resourcesDir: '/repo/resources',
      isPackaged: false,
      routerConfigPath: '/tmp/rebel-eval/mcp/super-mcp-router.json',
      portBase: 3125,
      portRange: 25,
    },
    {
      surface: 'standalone-Node',
      userDataDir: '/tmp/rebel-standalone',
      resourcesDir: '/repo/resources',
      isPackaged: false,
      routerConfigPath: '/tmp/rebel-standalone/mcp/super-mcp-router.json',
      portBase: 3150,
      portRange: 25,
    },
  ];

  it('initializes desktop, cloud, eval, and standalone Node with equivalent wiring', async () => {
    for (const row of rows) {
      vi.resetModules();
      const { createHeadlessRuntime } = await import('../headlessRuntime');
      const { order, overrides } = createHarness(row.portBase);
      const settings = makeSettings(row.routerConfigPath);
      const updateSettings = vi.fn((_partial: Partial<AppSettings>) => undefined);
      const waitForSuperMcpReady = vi.fn(async (_url: string) => undefined);
      const preOAuthCallHook = vi.fn(async () => undefined);

      const runtime = await createHeadlessRuntime({
        userDataDir: row.userDataDir,
        resourcesDir: row.resourcesDir,
        isPackaged: row.isPackaged,
        routerConfigPath: row.routerConfigPath,
        getSettings: () => settings,
        updateSettings,
        superMcpPortBase: row.portBase,
        superMcpPortRange: row.portRange,
        superMcpTimeoutMs: 45_000,
        waitForSuperMcpReady,
        preOAuthCallHook,
        __testOverrides: overrides,
      });

      expect(overrides.registerPreOAuthCallHook).toHaveBeenCalledTimes(1);
      expect(overrides.configureHeadlessTurnExecutor).toHaveBeenCalledWith(overrides.executeAgentTurn);
      expect(overrides.setMcpDisabled).toHaveBeenCalledWith(false);
      expect(overrides.registerPreOAuthCallHook).toHaveBeenCalledWith(preOAuthCallHook);
      expect(overrides.setMigrationComplete).toHaveBeenCalledWith(true);
      expect(overrides.initCoreServices).toHaveBeenCalledTimes(1);
      expect(overrides.initCoreServices).toHaveBeenCalledWith(expect.objectContaining({
        userDataDir: row.userDataDir,
        resourcesDir: row.resourcesDir,
        isPackaged: row.isPackaged,
        routerConfigPath: row.routerConfigPath,
        getSettings: expect.any(Function),
      }));
      expect(overrides.startSuperMcpWithRetries).toHaveBeenCalledTimes(1);
      expect(overrides.startSuperMcpWithRetries).toHaveBeenCalledWith(row.routerConfigPath, expect.objectContaining({
        preferredPort: row.portBase,
        portRange: row.portRange,
        startupTimeoutMs: 45_000,
      }));
      expect(waitForSuperMcpReady).toHaveBeenCalledWith(`http://127.0.0.1:${row.portBase}/mcp`);
      expect(typeof runtime.runTurn).toBe('function');

      const result = runtime.startAgentTurn(createRequest(), null as EventWindow | null);
      expect(result).toEqual({ turnId: 'turn-1' });
      expect(overrides.startAgentTurn).toHaveBeenCalledTimes(1);

      await runtime.cleanup();
      await runtime.cleanup();

      expect(order).toEqual([
        'abort-turns',
        'drain-turns',
        'stop-super-mcp',
        'stop-inbox-bridge',
        'close-file-index',
        'stop-model-proxy',
      ]);
    }
  });

  it('does not start or stop Super-MCP when skipMcp is true', async () => {
    vi.resetModules();
    const { createHeadlessRuntime } = await import('../headlessRuntime');
    const { order, overrides } = createHarness(3100);

    const runtime = await createHeadlessRuntime({
      userDataDir: '/tmp/rebel-skip',
      resourcesDir: '/repo/resources',
      isPackaged: false,
      routerConfigPath: '/tmp/rebel-skip/mcp/super-mcp-router.json',
      getSettings: () => makeSettings('/tmp/rebel-skip/mcp/super-mcp-router.json'),
      updateSettings: vi.fn((_partial: Partial<AppSettings>) => undefined),
      preOAuthCallHook: vi.fn(async () => undefined),
      skipMcp: true,
      __testOverrides: overrides,
    });

    expect(overrides.startSuperMcpWithRetries).not.toHaveBeenCalled();
    expect(overrides.findAvailablePort).not.toHaveBeenCalled();
    expect(overrides.setMcpDisabled).toHaveBeenCalledWith(true);
    await runtime.runTurn({
      prompt: 'hello without tools',
      onEvent: vi.fn(),
      options: { sessionType: 'cli', persistMode: { kind: 'none' } },
    });
    expect(overrides.runHeadlessTurn).toHaveBeenCalledTimes(1);
    await runtime.cleanup();
    expect(overrides.setMcpDisabled).toHaveBeenLastCalledWith(false);
    expect(order).toEqual([
      'abort-turns',
      'drain-turns',
      'stop-inbox-bridge',
      'close-file-index',
      'stop-model-proxy',
    ]);
  });

  it('enforces singleton creation within one module instance', async () => {
    vi.resetModules();
    const { createHeadlessRuntime } = await import('../headlessRuntime');
    const firstHarness = createHarness(3100);
    const secondHarness = createHarness(3125);
    const config = {
      userDataDir: '/tmp/rebel-singleton',
      resourcesDir: '/repo/resources',
      isPackaged: false,
      routerConfigPath: '/tmp/rebel-singleton/mcp/super-mcp-router.json',
      getSettings: () => makeSettings('/tmp/rebel-singleton/mcp/super-mcp-router.json'),
      updateSettings: vi.fn((_partial: Partial<AppSettings>) => undefined),
      preOAuthCallHook: vi.fn(async () => undefined),
      __testOverrides: firstHarness.overrides,
    } satisfies HeadlessRuntimeConfig;

    const runtime = await createHeadlessRuntime(config);
    await expect(createHeadlessRuntime({
      ...config,
      __testOverrides: secondHarness.overrides,
    })).rejects.toThrow('createHeadlessRuntime called twice; runtime is singleton-per-process');

    await runtime.cleanup();
  });

  it('wires eval PreToolUse hooks through AgentTurnServiceDeps', async () => {
    vi.resetModules();
    const { createHeadlessRuntime } = await import('../headlessRuntime');
    const { overrides } = createHarness(3125);
    const preToolHook = vi.fn(async () => ({}));

    const runtime = await createHeadlessRuntime({
      userDataDir: '/tmp/rebel-eval-hooks',
      resourcesDir: '/repo/resources',
      isPackaged: false,
      routerConfigPath: '/tmp/rebel-eval-hooks/mcp/super-mcp-router.json',
      getSettings: () => makeSettings('/tmp/rebel-eval-hooks/mcp/super-mcp-router.json'),
      updateSettings: vi.fn((_partial: Partial<AppSettings>) => undefined),
      preOAuthCallHook: vi.fn(async () => undefined),
      preToolHook,
      __testOverrides: overrides,
    });

    runtime.startAgentTurn(createRequest(), null);

    expect(overrides.startAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ mcpDenyHook: preToolHook }),
      expect.any(Object),
      null,
    );

    await runtime.cleanup();
  });

  it('does not surface a stale superMcpUrl when startWithRetries fails (port-collision regression)', async () => {
    // Regression: previously, the manager's configure() set state.url BEFORE the
    // subprocess spawn. When startup retries exhausted, stop() cleared isRunning
    // and the process handle but left state.url populated. toSuperMcpUrl() then
    // returned that stale URL, callers logged "Super-MCP HTTP server started",
    // and the immediate /api/tools fetch got ECONNREFUSED. This caused hermetic
    // eval runs to silently launch with mcp_mode=unavailable and hang at the
    // agent-turn watchdog 30s later. The fix: toSuperMcpUrl() gates on both
    // `result.success === false` and `state.isRunning === false`.
    vi.resetModules();
    const { createHeadlessRuntime } = await import('../headlessRuntime');
    const { overrides } = createHarness(3100);

    overrides.startSuperMcpWithRetries = vi.fn(async () => ({
      success: false,
      error: 'all attempts failed: port collision with orphan process',
      attempts: 4,
      lastError: 'all attempts failed: port collision with orphan process',
      lastErrorObj: new Error('all attempts failed: port collision with orphan process'),
      attemptErrors: [
        { attempt: 1, phase: 'spawn-or-health-check' as const, error: 'EADDRINUSE 3100' },
        { attempt: 2, phase: 'spawn-or-health-check' as const, error: 'EADDRINUSE 3101' },
        { attempt: 3, phase: 'spawn-or-health-check' as const, error: 'EADDRINUSE 3102' },
        { attempt: 4, phase: 'spawn-or-health-check' as const, error: 'EADDRINUSE 3103' },
      ],
    }));
    overrides.superMcpHttpManager = {
      getState: vi.fn(() => ({
        isRunning: false,
        port: 3114,
        url: 'http://127.0.0.1:3114/mcp',
      })),
    };
    overrides.stopSuperMcpForHeadlessCleanup = vi.fn(async () => undefined);
    const waitForSuperMcpReady = vi.fn(async (_url: string) => undefined);

    const runtime = await createHeadlessRuntime({
      userDataDir: '/tmp/rebel-stale-url',
      resourcesDir: '/repo/resources',
      isPackaged: false,
      routerConfigPath: '/tmp/rebel-stale-url/mcp/super-mcp-router.json',
      getSettings: () => makeSettings('/tmp/rebel-stale-url/mcp/super-mcp-router.json'),
      updateSettings: vi.fn((_partial: Partial<AppSettings>) => undefined),
      preOAuthCallHook: vi.fn(async () => undefined),
      waitForSuperMcpReady,
      superMcpPortBase: 3100,
      superMcpPortRange: 25,
      __testOverrides: overrides,
    });

    expect(runtime.superMcpUrl).toBeUndefined();
    expect(waitForSuperMcpReady).not.toHaveBeenCalled();

    expect(runtime.superMcpStartupError).toBeDefined();
    expect(runtime.superMcpStartupError?.lastError).toBe(
      'all attempts failed: port collision with orphan process',
    );
    expect(runtime.superMcpStartupError?.attempts).toBe(4);
    expect(runtime.superMcpStartupError?.attemptErrors).toHaveLength(4);
    expect(runtime.superMcpStartupError?.portBase).toBe(3100);
    expect(runtime.superMcpStartupError?.portRange).toBe(25);

    await runtime.cleanup();
  });

  it('leaves superMcpStartupError undefined on the success path', async () => {
    vi.resetModules();
    const { createHeadlessRuntime } = await import('../headlessRuntime');
    const { overrides } = createHarness(3100);

    const runtime = await createHeadlessRuntime({
      userDataDir: '/tmp/rebel-success',
      resourcesDir: '/repo/resources',
      isPackaged: false,
      routerConfigPath: '/tmp/rebel-success/mcp/super-mcp-router.json',
      getSettings: () => makeSettings('/tmp/rebel-success/mcp/super-mcp-router.json'),
      updateSettings: vi.fn((_partial: Partial<AppSettings>) => undefined),
      preOAuthCallHook: vi.fn(async () => undefined),
      __testOverrides: overrides,
    });

    expect(runtime.superMcpUrl).toBe('http://127.0.0.1:3100/mcp');
    expect(runtime.superMcpStartupError).toBeUndefined();

    await runtime.cleanup();
  });

  it('calls waitForSuperMcpReady whenever a superMcpUrl is surfaced, even on retry-resolved startup', async () => {
    // Defense-in-depth: previously the wait was gated on `superMcpStarted`,
    // which could be `false` while the URL existed (the stale-URL bug above).
    // After the fix, waitForSuperMcpReady is called whenever the URL is set,
    // catching any remaining race between startWithRetries returning success
    // and the upstream /api/tools endpoint actually accepting connections.
    vi.resetModules();
    const { createHeadlessRuntime } = await import('../headlessRuntime');
    const { overrides } = createHarness(3100);
    const waitForSuperMcpReady = vi.fn(async (_url: string) => undefined);

    const runtime = await createHeadlessRuntime({
      userDataDir: '/tmp/rebel-wait-ready',
      resourcesDir: '/repo/resources',
      isPackaged: false,
      routerConfigPath: '/tmp/rebel-wait-ready/mcp/super-mcp-router.json',
      getSettings: () => makeSettings('/tmp/rebel-wait-ready/mcp/super-mcp-router.json'),
      updateSettings: vi.fn((_partial: Partial<AppSettings>) => undefined),
      preOAuthCallHook: vi.fn(async () => undefined),
      waitForSuperMcpReady,
      __testOverrides: overrides,
    });

    expect(runtime.superMcpUrl).toBe('http://127.0.0.1:3100/mcp');
    expect(waitForSuperMcpReady).toHaveBeenCalledTimes(1);
    expect(waitForSuperMcpReady).toHaveBeenCalledWith('http://127.0.0.1:3100/mcp');

    await runtime.cleanup();
  });

  it('wires cloud recovery executor and memory hook through AgentTurnServiceDeps', async () => {
    vi.resetModules();
    const { createHeadlessRuntime } = await import('../headlessRuntime');
    const { overrides } = createHarness(3200);
    const executeAgentTurnWithRecovery =
      vi.fn<NonNullable<AgentTurnServiceDeps['executeAgentTurnWithRecovery']>>(async () => undefined);
    const memoryWriteHook = vi.fn(async () => ({}));

    const runtime = await createHeadlessRuntime({
      userDataDir: '/data',
      resourcesDir: '/srv/rebel/resources',
      isPackaged: false,
      routerConfigPath: '/data/mcp/super-mcp-router.json',
      getSettings: () => makeSettings('/data/mcp/super-mcp-router.json'),
      updateSettings: vi.fn((_partial: Partial<AppSettings>) => undefined),
      preOAuthCallHook: vi.fn(async () => undefined),
      executeAgentTurnWithRecovery,
      memoryWriteHook,
      __testOverrides: overrides,
    });

    runtime.startAgentTurn(createRequest(), null);

    expect(overrides.startAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        executeAgentTurnWithRecovery,
        memoryWriteHook,
      }),
      expect.any(Object),
      null,
    );

    await runtime.cleanup();
  });
});
