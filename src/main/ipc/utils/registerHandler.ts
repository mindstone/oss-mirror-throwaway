import { getHandlerRegistry, type IpcHandler } from '@core/handlerRegistry';
import { wrapHandlerWithContractParse } from './registerContractHandler';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Electron's ipcMain handler accepts arbitrary IpcMainInvokeEvent + variadic args; the cast is absorbed at this boundary so callers can be precisely typed
type ElectronIpcHandler = (event: any, ...args: any[]) => Promise<unknown> | unknown;

/**
 * Register an IPC handler with automatic removal of any existing handler.
 *
 * Delegates to the platform's HandlerRegistry:
 * - Electron: wraps ipcMain.handle() with cloudRouter logic (dual-write, routing, fallback)
 * - Cloud: stores in a plain Map
 *
 * Accepts Electron-typed handlers (with IpcMainInvokeEvent) and casts to
 * the platform-agnostic IpcHandler. The core type uses `event: unknown` to
 * stay Electron-free; this wrapper absorbs the type mismatch at the boundary.
 *
 * @param channel - The IPC channel name
 * @param handler - The handler function
 */
export function registerHandler(
  channel: string,
  handler: ElectronIpcHandler
): void {
  // Stage-2 contract seam: in dev/test the handler is wrapped to parse the
  // request before the body and the response after it; in production (the
  // default / unset / unknown-env path) `wrapHandlerWithContractParse` returns
  // the handler UNCHANGED — this is a no-op passthrough, so the prod runtime
  // behaviour is byte-for-byte unaffected. See registerContractHandler.ts.
  const wrapped = wrapHandlerWithContractParse(channel, handler);
  getHandlerRegistry().register(channel, wrapped as IpcHandler);
}
