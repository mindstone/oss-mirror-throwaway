/**
 * HandlerRegistry — platform-agnostic IPC handler registration.
 *
 * Replaces direct `ipcMain.handle()` usage. Electron impl wraps ipcMain
 * with cloudRouter logic; cloud impl uses a plain Map.
 *
 * All handler registration MUST go through this interface so the cloud
 * service can run business logic without a fake Electron layer.
 */

/**
 * Neutral context passed to IPC handlers across all surfaces.
 *
 * On desktop, Electron passes a real `IpcMainInvokeEvent` whose shape
 * structurally extends `HandlerInvokeContext` — desktop handlers can cast
 * back to the full Electron type if needed.
 *
 * On cloud, the cloud router (`cloud-service/src/routes/ipc.ts:363`)
 * invokes handlers with LITERAL `null` (`handler(null, ...args)`). Handlers
 * MUST null-guard via the {@link HandlerInvokeEvent} parameter alias below.
 *
 * On mobile (future), no direct handler invocation today.
 */
export interface HandlerInvokeContext {
  /**
   * Caller process identity. On desktop this is Electron's WebContents.id
   * (number). On cloud this is undefined.
   */
  readonly sender?: {
    readonly id: number;
  };
}

/**
 * The actual parameter type for handlers registered through `cloudIpcHandlers.ts`.
 * Cloud invokes with `null`; desktop invokes with `IpcMainInvokeEvent`.
 * Always null-guard at use sites: `event?.sender?.id ?? 'cloud-process'`.
 */
export type HandlerInvokeEvent = HandlerInvokeContext | null;

export type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown;

export interface HandlerRegistry {
  register(channel: string, handler: IpcHandler): void;
  remove(channel: string): void;
  get(channel: string): IpcHandler | undefined;
  /**
   * List currently registered channels.
   *
   * Used by startup invariants that verify contract↔handler wiring parity.
   */
  listRegisteredChannels(): readonly string[];
  /**
   * Invoke a registered handler through the platform's normal routing wrapper.
   *
   * Use this for cross-channel composition when a handler calls another handler
   * and must preserve the same cloud routing / dual-write semantics as a
   * renderer-originated IPC invocation.
   */
  invokeWithRouting(channel: string, event: unknown | undefined, ...args: unknown[]): Promise<unknown>;
}

let _registry: HandlerRegistry | null = null;

export function setHandlerRegistry(registry: HandlerRegistry): void {
  _registry = registry;
}

export function getHandlerRegistry(): HandlerRegistry {
  if (!_registry) {
    throw new Error(
      'HandlerRegistry not initialized. Call setHandlerRegistry() before registering handlers.',
    );
  }
  return _registry;
}
