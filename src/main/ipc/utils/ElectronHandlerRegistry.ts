/**
 * ElectronHandlerRegistry — Electron implementation of HandlerRegistry.
 *
 * Wraps ipcMain.handle() with cloudRouter logic (dual-write, cloud routing,
 * fallback). This replicates the wrapping that registerHandler.ts currently
 * does, so that Stage 2 can swap registerHandler to use getHandlerRegistry().
 *
 * When `REBEL_E2E_PERF_MODE=1`, also instruments IPC responses with payload
 * size checking and exposes perf-test-only IPC handlers for reading violations.
 *
 * @see src/main/ipc/utils/ipcPayloadGuard.ts — Payload size estimation module
 * @see docs/plans/260328_perf_regression_tests.md — Perf regression test plan
 */

import { ipcMain } from 'electron';
import type { HandlerRegistry, IpcHandler } from '@core/handlerRegistry';
import { cloudRouter } from '../../services/cloud/cloudRouter';
import { createScopedLogger } from '@core/logger';
import { recordIfOversized, getViolations, clearViolations } from './ipcPayloadGuard';
import { recordLatency } from './ipcLatencyTracker';

const log = createScopedLogger({ service: 'ElectronHandlerRegistry' });
const IS_PERF_MODE = process.env.REBEL_PERF_MODE === '1';

export class ElectronHandlerRegistry implements HandlerRegistry {
  private handlers = new Map<string, IpcHandler>();

  constructor() {
    // Register perf-test-only IPC handlers ONCE when running in perf test mode.
    // These allow E2E tests to query/clear payload size violations from the test process.
    // Both IPC handlers (for renderer access) and global accessors (for electronApp.evaluate)
    // are provided since the preload bridge doesn't expose perf-test channels.
    if (process.env.REBEL_E2E_PERF_MODE === '1') {
      ipcMain.handle('e2e:get-ipc-size-violations', () => getViolations());
      ipcMain.handle('e2e:clear-ipc-size-violations', () => {
        clearViolations();
        return true;
      });
      // Expose on global for electronApp.evaluate() access from E2E tests
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- gated by REBEL_E2E_PERF_MODE; intentional global attach for Playwright .evaluate() access
      (global as any).__e2e_getIpcSizeViolations = () => getViolations();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- gated by REBEL_E2E_PERF_MODE; intentional global attach for Playwright .evaluate() access
      (global as any).__e2e_clearIpcSizeViolations = () => { clearViolations(); return true; };
      log.info('Perf mode: registered IPC payload size violation handlers');
    }
  }

  register(channel: string, handler: IpcHandler): void {
    this.handlers.set(channel, handler);
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      return this.executeWithRouting(channel, handler, event, ...args);
    });
  }

  async invokeWithRouting(channel: string, event: unknown | undefined, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler registered for channel: ${channel}`);
    }

    return this.executeWithRouting(channel, handler, event, ...args);
  }

  private async executeWithRouting(
    channel: string,
    handler: IpcHandler,
    event: unknown | undefined,
    ...args: unknown[]
  ): Promise<unknown> {
    const runLocalHandlerWithTiming = async (): Promise<unknown> => {
      if (!IS_PERF_MODE) {
        return handler(event, ...args);
      }

      const start = performance.now();
      try {
        return await handler(event, ...args);
      } finally {
        recordLatency(channel, performance.now() - start);
      }
    };

    const runCloudForwardWithTiming = async (): Promise<unknown> => {
      if (!IS_PERF_MODE) {
        return cloudRouter.forward(channel, args);
      }

      const start = performance.now();
      try {
        return await cloudRouter.forward(channel, args);
      } finally {
        recordLatency(`cloud:${channel}`, performance.now() - start);
      }
    };

    // Dual-write channels: run locally AND forward to cloud.
    // This keeps local state in sync so switching back to local mode is safe.
    if (cloudRouter.isDualWrite(channel)) {
      const localResult = await runLocalHandlerWithTiming();
      runCloudForwardWithTiming().catch((err) => {
        log.warn({ err, channel }, 'Cloud dual-write forward failed (local write succeeded)');
      });
      recordIfOversized(channel, localResult);
      return localResult;
    }

    // Cloud routing: almost all channels now run locally on desktop (execute-where-triggered).
    // The cloud routing path is only used for the few remaining dual-write channels
    // (settings:update, automations:upsert, automations:delete, agent:tool-safety-response).
    // On failure for data channels, fall back to local handler so the app remains usable.
    // Mobile/web execute on cloud directly (they bypass ElectronHandlerRegistry entirely).
    if (cloudRouter.shouldRouteToCloud(channel)) {
      const result = await runCloudForwardWithTiming();
      const isAgentChannel = channel.startsWith('agent:');
      if (!isAgentChannel && result && typeof result === 'object' && 'error' in result) {
        log.warn({ channel, error: (result as Record<string, unknown>).error }, 'Cloud forward returned error, falling back to local');
        const fallbackResult = await runLocalHandlerWithTiming();
        recordIfOversized(channel, fallbackResult);
        return fallbackResult;
      }
      recordIfOversized(channel, result);
      return result;
    }

    // Otherwise, handle locally (existing behavior)
    const result = await runLocalHandlerWithTiming();
    recordIfOversized(channel, result);
    return result;
  }

  remove(channel: string): void {
    this.handlers.delete(channel);
    ipcMain.removeHandler(channel);
  }

  get(channel: string): IpcHandler | undefined {
    return this.handlers.get(channel);
  }

  listRegisteredChannels(): readonly string[] {
    return Array.from(this.handlers.keys());
  }
}
