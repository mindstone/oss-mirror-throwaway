/**
 * Stage 3 (260610_gworkspace-mcp-error-disconnect-hang): seam tests for
 * `reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral` — the
 * resolve-on-deferral sibling of `reconfigureSuperMcpWithCacheRefresh`.
 *
 * Contract under test (PLAN.md Stage 3 verification cases):
 *   (i)   deferred  → resolves promptly with `{ queued: true }` even though the
 *         underlying restart completion never settles (the production hang).
 *   (iii) idle      → does NOT resolve before the restart execution completes,
 *         then resolves `{ queued: false }` (the "connect ⇒ usable" contract —
 *         losing this silently reintroduces the launchRebel race).
 *   (iv)  a restart failure AFTER the early queued resolution stays observed
 *         (scoped warn, no unhandled rejection).
 *   (v)   idle-path restart failure still rejects (each handler's existing
 *         non-fatal warn-catch behavior is preserved unchanged).
 *
 * The coalesce case (ii) — a second request joining a pending restart must not
 * drop the deferral callback — is covered at the scheduler seam in
 * `src/core/services/__tests__/superMcpHttpManager.scheduleRestart.test.ts`
 * (this file mocks the manager, so coalescing isn't observable here).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

type ConfigRestartRequest = {
  configPath: string;
  context: string;
  afterRestart?: () => void;
  onRestartError?: (error: unknown) => void;
  onRestartDeferred?: (info: { activeTurns: number }) => void;
};

// Shared scoped-logger singleton so the post-resolve warn is assertable.
const scopedLoggerMock = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

const PENDING_SENTINEL = Symbol('variant-still-pending');

/** Race the variant against a macrotask — pending microtasks drain first. */
async function raceAgainstMacrotask<T>(promise: Promise<T>): Promise<T | typeof PENDING_SENTINEL> {
  return Promise.race([
    promise,
    new Promise<typeof PENDING_SENTINEL>((resolve) => setTimeout(() => resolve(PENDING_SENTINEL), 0)),
  ]);
}

describe('reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral', () => {
  let variant: typeof import('../mcpService').reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral;
  let requestRestartForConfigChangeMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    await initTestPlatformConfig();
    for (const fn of Object.values(scopedLoggerMock)) {
      fn.mockReset();
    }

    requestRestartForConfigChangeMock = vi.fn();

    vi.doMock('@core/services/settingsStore', () => ({
      setSettingsStoreAdapter: vi.fn(),
      getSettings: vi.fn(() => ({ mcpConfigFile: null })),
      settingsStore: { store: {} },
    }));

    vi.doMock('@core/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      createScopedLogger: vi.fn(() => scopedLoggerMock),
      runWithTurnContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
      createTurnSessionLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    }));

    vi.doMock('../toolIndexService', () => ({
      markToolIndexInvalidated: vi.fn(() => 1),
      markToolIndexRefreshComplete: vi.fn(),
      rollbackToolIndexInvalidation: vi.fn(),
      refreshToolIndex: vi.fn(async () => ({ success: true, added: 0, updated: 0, removed: 0, total: 0 })),
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
        requestImmediateConfigReloadForChatMaterialization: vi.fn(),
        isConfigured: vi.fn(() => true),
      },
      CircuitBreakerError: class CircuitBreakerError extends Error {},
      findAvailablePort: vi.fn(),
    }));

    const mod = await import('../mcpService');
    variant = mod.reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral;
  });

  it('(i) resolves promptly with { queued: true } when the scheduler defers the restart', async () => {
    // Deferral signal fires synchronously (as the real scheduler does), then
    // the completion never settles — the exact shape of the production hang.
    requestRestartForConfigChangeMock.mockImplementation((request: ConfigRestartRequest) => {
      request.onRestartDeferred?.({ activeTurns: 1 });
      return new Promise<never>(() => {});
    });

    const winner = await raceAgainstMacrotask(
      variant('/tmp/mcp.json', { context: 'google-workspace-connect' }),
    );

    expect(winner).toEqual({ queued: true });
    expect(requestRestartForConfigChangeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: '/tmp/mcp.json',
        context: 'google-workspace-connect',
        // Cache-refresh parity with the awaited sibling: the tool-index /
        // connected-packages callbacks must still ride along.
        afterRestart: expect.any(Function),
        onRestartError: expect.any(Function),
        onRestartDeferred: expect.any(Function),
      }),
    );
  });

  it('(iii) idle path: does not resolve before the restart completes, then resolves { queued: false }', async () => {
    let resolveCompletion: (() => void) | undefined;
    requestRestartForConfigChangeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCompletion = () => resolve();
        }),
    );

    const pending = variant('/tmp/mcp.json', { context: 'microsoft-connect' });

    // No deferral signal → the variant must still be pending (idle contract:
    // resolution means the restart actually executed).
    expect(await raceAgainstMacrotask(pending)).toBe(PENDING_SENTINEL);

    resolveCompletion?.();
    await expect(pending).resolves.toEqual({ queued: false });
  });

  it('(iv) a restart failure after the queued resolution is observed via scoped warn (no unhandled rejection)', async () => {
    let rejectCompletion: ((error: Error) => void) | undefined;
    requestRestartForConfigChangeMock.mockImplementation((request: ConfigRestartRequest) => {
      request.onRestartDeferred?.({ activeTurns: 2 });
      return new Promise<void>((_resolve, reject) => {
        rejectCompletion = reject;
      });
    });

    await expect(
      variant('/tmp/mcp.json', { context: 'slack-connect' }),
    ).resolves.toEqual({ queued: true });

    rejectCompletion?.(new Error('restart failed after queue'));
    // Flush so the background rejection observer runs; vitest fails the suite
    // on unhandled rejections, so reaching the assertion proves observation.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scopedLoggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), context: 'slack-connect' }),
      expect.stringContaining('after queued resolution'),
    );
  });

  it('(v) idle-path restart failure still rejects the variant', async () => {
    requestRestartForConfigChangeMock.mockImplementation(
      () => Promise.reject(new Error('idle restart failed')),
    );

    await expect(
      variant('/tmp/mcp.json', { context: 'discourse-connect' }),
    ).rejects.toThrow('idle restart failed');
  });
});
