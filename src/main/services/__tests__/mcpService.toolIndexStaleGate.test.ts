import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

describe('mcpService tool-index stale gate wiring', () => {
  let reconfigureSuperMcpWithCacheRefreshAndAwaitExecution: typeof import('../mcpService').reconfigureSuperMcpWithCacheRefreshAndAwaitExecution;
  let reconfigureSuperMcpWithCacheRefreshDetached: typeof import('../mcpService').reconfigureSuperMcpWithCacheRefreshDetached;
  let restartSuperMcpForConfigChangeAndAwaitExecution: typeof import('../mcpService').restartSuperMcpForConfigChangeAndAwaitExecution;
  let reloadSuperMcpNowForChatPackageMaterialization: typeof import('../mcpService').reloadSuperMcpNowForChatPackageMaterialization;

  let markToolIndexInvalidatedMock: ReturnType<typeof vi.fn>;
  let markToolIndexRefreshCompleteMock: ReturnType<typeof vi.fn>;
  let rollbackToolIndexInvalidationMock: ReturnType<typeof vi.fn>;
  let refreshToolIndexMock: ReturnType<typeof vi.fn>;
  let requestRestartForConfigChangeMock: ReturnType<typeof vi.fn>;
  let requestImmediateConfigReloadForChatMaterializationMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    await initTestPlatformConfig();

    markToolIndexInvalidatedMock = vi.fn(() => 1);
    markToolIndexRefreshCompleteMock = vi.fn();
    rollbackToolIndexInvalidationMock = vi.fn();
    refreshToolIndexMock = vi.fn(async () => ({ success: true, added: 1, updated: 0, removed: 0, total: 1 }));
    requestRestartForConfigChangeMock = vi.fn(async (request: { afterRestart?: () => void }) => {
      request.afterRestart?.();
    });
    requestImmediateConfigReloadForChatMaterializationMock = vi.fn(async (request: { afterRestart?: () => void }) => {
      request.afterRestart?.();
    });

    vi.doMock('@core/services/settingsStore', () => ({
      setSettingsStoreAdapter: vi.fn(),
      getSettings: vi.fn(() => ({ mcpConfigFile: null })),
      settingsStore: { store: {} },
    }));

    vi.doMock('@core/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      createScopedLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
      runWithTurnContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
      createTurnSessionLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    }));

    vi.doMock('../toolIndexService', () => ({
      markToolIndexInvalidated: markToolIndexInvalidatedMock,
      markToolIndexRefreshComplete: markToolIndexRefreshCompleteMock,
      rollbackToolIndexInvalidation: rollbackToolIndexInvalidationMock,
      refreshToolIndex: refreshToolIndexMock,
      searchTools: vi.fn(async () => []),
      hasToolIndex: vi.fn(() => false),
      getToolIndexStatus: vi.fn(() => ({
        isInitialized: false,
        toolCount: 0,
        lastRefreshAt: null,
        etag: null,
        byServer: undefined,
      })),
    }));

    vi.doMock('../superMcpHttpManager', () => ({
      superMcpHttpManager: {
        requestRestartForConfigChangeAndAwaitExecution: requestRestartForConfigChangeMock,
        requestImmediateConfigReloadForChatMaterialization: requestImmediateConfigReloadForChatMaterializationMock,
        isConfigured: vi.fn(() => true),
      },
      CircuitBreakerError: class CircuitBreakerError extends Error {},
      findAvailablePort: vi.fn(),
    }));

    const mod = await import('../mcpService');
    reconfigureSuperMcpWithCacheRefreshAndAwaitExecution = mod.reconfigureSuperMcpWithCacheRefreshAndAwaitExecution;
    reconfigureSuperMcpWithCacheRefreshDetached = mod.reconfigureSuperMcpWithCacheRefreshDetached;
    restartSuperMcpForConfigChangeAndAwaitExecution = mod.restartSuperMcpForConfigChangeAndAwaitExecution;
    reloadSuperMcpNowForChatPackageMaterialization = mod.reloadSuperMcpNowForChatPackageMaterialization;
  });

  it('marks invalidated and refreshes only after the requested restart completes', async () => {
    markToolIndexInvalidatedMock.mockReturnValueOnce(5);

    await reconfigureSuperMcpWithCacheRefreshAndAwaitExecution('/tmp/mcp.json', { context: 'oauth-reconnect' });
    await Promise.resolve();

    expect(requestRestartForConfigChangeMock).toHaveBeenCalledWith(expect.objectContaining({
      configPath: '/tmp/mcp.json',
      context: 'oauth-reconnect',
    }));
    expect(markToolIndexInvalidatedMock).toHaveBeenCalledWith('super-mcp-reconfigure:oauth-reconnect');
    expect(requestRestartForConfigChangeMock.mock.invocationCallOrder[0]).toBeLessThan(
      markToolIndexInvalidatedMock.mock.invocationCallOrder[0],
    );
    expect(markToolIndexRefreshCompleteMock).toHaveBeenCalledWith(5, { success: true });
    expect(rollbackToolIndexInvalidationMock).not.toHaveBeenCalled();
  });

  it('keeps stale generation when requested restart fails after a config change', async () => {
    markToolIndexInvalidatedMock.mockReturnValueOnce(6);
    requestRestartForConfigChangeMock.mockImplementationOnce(async (request: { onRestartError?: (error: unknown) => void }) => {
      const error = new Error('reconfigure failed');
      request.onRestartError?.(error);
      throw error;
    });

    await expect(
      reconfigureSuperMcpWithCacheRefreshAndAwaitExecution('/tmp/mcp.json', { context: 'oauth-reconnect' }),
    ).rejects.toThrow('reconfigure failed');

    expect(markToolIndexRefreshCompleteMock).toHaveBeenCalledWith(6, {
      success: false,
      error: 'reconfigure failed',
    });
    expect(rollbackToolIndexInvalidationMock).not.toHaveBeenCalled();
    expect(refreshToolIndexMock).not.toHaveBeenCalled();
  });

  it('restart helper routes through the drain-safe restart requester', async () => {
    markToolIndexInvalidatedMock.mockReturnValueOnce(11);

    await restartSuperMcpForConfigChangeAndAwaitExecution('/tmp/mcp.json', 'settings-change');
    await Promise.resolve();

    expect(requestRestartForConfigChangeMock).toHaveBeenCalledWith(expect.objectContaining({
      configPath: '/tmp/mcp.json',
      context: 'settings-change',
    }));
    expect(markToolIndexInvalidatedMock).toHaveBeenCalledWith('super-mcp-reconfigure:settings-change');
    expect(markToolIndexRefreshCompleteMock).toHaveBeenCalledWith(11, { success: true });
    expect(rollbackToolIndexInvalidationMock).not.toHaveBeenCalled();
  });

  it('restart helper keeps stale when requested restart fails', async () => {
    markToolIndexInvalidatedMock.mockReturnValueOnce(12);
    requestRestartForConfigChangeMock.mockImplementationOnce(async (request: { onRestartError?: (error: unknown) => void }) => {
      const error = new Error('boom');
      request.onRestartError?.(error);
      throw error;
    });

    await expect(restartSuperMcpForConfigChangeAndAwaitExecution('/tmp/mcp.json', 'settings-change')).rejects.toThrow('boom');

    expect(markToolIndexRefreshCompleteMock).toHaveBeenCalledWith(12, {
      success: false,
      error: 'boom',
    });
    expect(rollbackToolIndexInvalidationMock).not.toHaveBeenCalled();
    expect(refreshToolIndexMock).not.toHaveBeenCalled();
  });

  it('chat materialization helper routes through the immediate reload requester', async () => {
    markToolIndexInvalidatedMock.mockReturnValueOnce(13);

    await reloadSuperMcpNowForChatPackageMaterialization('/tmp/mcp.json', 'bundled-inbox-bridge:raw upsert');
    await Promise.resolve();

    expect(requestImmediateConfigReloadForChatMaterializationMock).toHaveBeenCalledWith(expect.objectContaining({
      configPath: '/tmp/mcp.json',
      context: 'bundled-inbox-bridge:raw upsert',
      reason: 'chat-package-materialization',
    }));
    expect(requestRestartForConfigChangeMock).not.toHaveBeenCalled();
    expect(markToolIndexInvalidatedMock).toHaveBeenCalledWith('super-mcp-reconfigure:bundled-inbox-bridge:raw upsert');
    expect(markToolIndexRefreshCompleteMock).toHaveBeenCalledWith(13, { success: true });
    expect(rollbackToolIndexInvalidationMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 260610 API split: the detached form is the default for config-mutation
  // callers. Contract: void by construction, requests the same drain-safe
  // restart, and never throws / never leaks an unhandled rejection — every
  // failure shape is observed via onError.
  // ---------------------------------------------------------------------------
  describe('reconfigureSuperMcpWithCacheRefreshDetached', () => {
    it('returns void synchronously while the restart stays deferred (never resolves)', async () => {
      // Deferral simulation: the drain-safe restart promise never resolves.
      requestRestartForConfigChangeMock.mockImplementationOnce(() => new Promise<never>(() => {}));

      const result = reconfigureSuperMcpWithCacheRefreshDetached('/tmp/mcp.json', { context: 'connect-detached' });

      expect(result).toBeUndefined();
      expect(requestRestartForConfigChangeMock).toHaveBeenCalledWith(expect.objectContaining({
        configPath: '/tmp/mcp.json',
        context: 'connect-detached',
      }));
    });

    it('still refreshes dependent caches after the detached restart completes', async () => {
      markToolIndexInvalidatedMock.mockReturnValueOnce(21);

      reconfigureSuperMcpWithCacheRefreshDetached('/tmp/mcp.json', { context: 'connect-detached' });
      await Promise.resolve();
      await Promise.resolve();

      expect(markToolIndexInvalidatedMock).toHaveBeenCalledWith('super-mcp-reconfigure:connect-detached');
      expect(markToolIndexRefreshCompleteMock).toHaveBeenCalledWith(21, { success: true });
    });

    it('routes a background restart failure to onError without throwing', async () => {
      requestRestartForConfigChangeMock.mockImplementationOnce(async () => {
        throw new Error('restart failed in background');
      });
      const onError = vi.fn();

      expect(() => {
        reconfigureSuperMcpWithCacheRefreshDetached('/tmp/mcp.json', { context: 'connect-detached', onError });
      }).not.toThrow();

      // Flush so the detached .catch runs; vitest fails the run on a dropped rejection.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'restart failed in background' }));
    });

    it('routes a synchronous restart-request throw to onError without throwing', async () => {
      // The awaiting form is async, so a sync throw below surfaces as a
      // rejection; the detached contract (observe via onError, never
      // propagate) must hold for that shape too.
      requestRestartForConfigChangeMock.mockImplementationOnce(() => {
        throw new Error('sync throw before promise');
      });
      const onError = vi.fn();

      expect(() => {
        reconfigureSuperMcpWithCacheRefreshDetached('/tmp/mcp.json', { context: 'connect-detached', onError });
      }).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'sync throw before promise' }));
    });

    it('a throwing onError callback is contained', async () => {
      requestRestartForConfigChangeMock.mockImplementationOnce(async () => {
        throw new Error('restart failed in background');
      });

      expect(() => {
        reconfigureSuperMcpWithCacheRefreshDetached('/tmp/mcp.json', {
          context: 'connect-detached',
          onError: () => {
            throw new Error('observer blew up');
          },
        });
      }).not.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
