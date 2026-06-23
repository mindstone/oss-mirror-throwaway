/**
 * Stage 2 of `260422_renderer_driven_connector_status` — testable factory
 * for the `connector:status-changed` push-event subscription.
 *
 * Pattern mirrors `safetyPromptSubscriptionFactory.ts`. `validate:ipc`
 * does not cover broadcast channels, so extracting the subscription as
 * a factory gives us a deterministic unit-test seam for the channel
 * name, payload shape, and unsubscribe behaviour — the three things
 * most likely to silently regress during future refactors.
 *
 * The main-side translator (`src/main/services/appBridgeManager.ts`)
 * builds the payload via `ConnectorStatusChangedPayloadSchema`, so we
 * also validate on the receive side: an invalid shape is logged at
 * warn level and dropped without calling the consumer callback. This
 * prevents a future schema drift from silently forwarding unvalidated
 * data into the renderer.
 *
 * @see docs/plans/260422_renderer_driven_connector_status.md
 */

import {
  CONNECTOR_STATUS_CHANGED,
  ConnectorStatusChangedPayloadSchema,
  type ConnectorStatusChangedPayload,
} from '@shared/ipc/channels/appBridge';

/**
 * Minimal `ipcRenderer` surface — matches the shape of the Electron type
 * but keeps us independent of the electron runtime in tests (the real
 * preload passes `Electron.IpcRenderer`, which is assignable).
 */
export interface IpcRendererLike {
  on(channel: string, listener: (...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (...args: unknown[]) => void): void;
}

/**
 * Optional logger sink. Defaults to `console.warn`. Tests inject a spy
 * instead of monkey-patching globals.
 */
export interface ConnectorStatusSubscriptionsLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ConnectorStatusSubscriptionsFactoryOptions {
  logger?: ConnectorStatusSubscriptionsLogger;
}

/**
 * Build the `connector:status-changed` subscription surface.
 *
 * Returned shape is intentionally flat + composable with the existing
 * `appBridgeSubscriptions` object in `preload/index.ts`:
 *
 *   const appBridgeSubscriptions = {
 *     onPendingApprovalUpdated: ...,
 *     ...createConnectorStatusSubscriptions(ipcRenderer),
 *   };
 */
export function createConnectorStatusSubscriptions(
  ipcRenderer: IpcRendererLike,
  { logger }: ConnectorStatusSubscriptionsFactoryOptions = {},
): {
  onConnectorStatusChanged: (
    callback: (payload: ConnectorStatusChangedPayload) => void,
  ) => () => void;
} {
  const warn = logger?.warn ?? ((message: string, meta?: Record<string, unknown>) => {
    console.warn(message, meta ?? {});
  });

  return {
    onConnectorStatusChanged: (
      callback: (payload: ConnectorStatusChangedPayload) => void,
    ): (() => void) => {
      // IpcRendererLike uses the variadic Electron signature
      // `(event, ...args) => void`. Validate the payload shape inside the
      // listener so a malformed broadcast can't crash the renderer or
      // slip through as `any`.
      const listener = (...args: unknown[]): void => {
        const raw = args[1];
        const parsed = ConnectorStatusChangedPayloadSchema.safeParse(raw);
        if (!parsed.success) {
          warn('connector:status-changed payload failed validation — dropping', {
            issues: parsed.error.issues,
          });
          return;
        }
        callback(parsed.data);
      };
      ipcRenderer.on(CONNECTOR_STATUS_CHANGED, listener);
      return () => void ipcRenderer.removeListener(CONNECTOR_STATUS_CHANGED, listener);
    },
  };
}
