import type { McpServerUpsertPayload } from '@shared/types';

export type ConnectionCardOperationKind = 'connect' | 'disconnect' | 'toggle';

export type ConnectionCardTracking =
  | { kind: ConnectionCardOperationKind; context: string }
  | { exempt: string };

export type DeferredConnectionCardOperation = {
  id: string;
  kind: ConnectionCardOperationKind;
  context: string;
};

type SettingsApi = Window['settingsApi'];
export type ConnectionCardAddBundledServerPayload = Parameters<SettingsApi['mcpAddBundledServer']>[0];
export type ConnectionCardAddBundledServerResult = Awaited<ReturnType<SettingsApi['mcpAddBundledServer']>>;
export type ConnectionCardToggleServerEnabledResult = Awaited<ReturnType<SettingsApi['mcpToggleServerEnabled']>>;

export interface ConnectionCardOps {
  addBundledServer(
    payload: ConnectionCardAddBundledServerPayload,
    tracking: ConnectionCardTracking,
  ): Promise<ConnectionCardAddBundledServerResult>;
  upsertServer(
    payload: McpServerUpsertPayload,
    tracking: ConnectionCardTracking,
  ): Promise<void>;
  removeServer(
    serverName: string,
    tracking: ConnectionCardTracking,
  ): Promise<void>;
  toggleServerEnabled(
    serverId: string,
    tracking: ConnectionCardTracking,
  ): Promise<ConnectionCardToggleServerEnabledResult>;
  /**
   * Passthrough for Google Workspace OAuth start-auth legs. These are
   * resolve-on-deferral contexts, so they intentionally do not use the
   * clear-on-settle wrappers above.
   */
  trackResolveOnDeferralConnect?: (operation: DeferredConnectionCardOperation) => void;
  clearResolveOnDeferralConnect?: (id: string, kind: ConnectionCardOperationKind) => void;
}

type ConnectionCardOpsDelegates = {
  addBundledServer: (
    payload: ConnectionCardAddBundledServerPayload,
    tracking: ConnectionCardTracking,
  ) => Promise<ConnectionCardAddBundledServerResult> | ConnectionCardAddBundledServerResult;
  upsertServer: (
    payload: McpServerUpsertPayload,
    tracking: ConnectionCardTracking,
  ) => Promise<void> | void;
  removeServer: (
    serverName: string,
    tracking: ConnectionCardTracking,
  ) => Promise<void> | void;
  toggleServerEnabled: (
    serverId: string,
    tracking: ConnectionCardTracking,
  ) => Promise<ConnectionCardToggleServerEnabledResult> | ConnectionCardToggleServerEnabledResult;
};

type TrackedConnectionCardOpsOptions = ConnectionCardOpsDelegates & {
  operationId: string;
  trackDeferredOperation: (operation: DeferredConnectionCardOperation) => void;
  clearDeferredOperation: (id: string, kind: ConnectionCardOperationKind) => void;
};

async function runTracked<T>(
  options: Pick<TrackedConnectionCardOpsOptions, 'operationId' | 'trackDeferredOperation' | 'clearDeferredOperation'>,
  tracking: ConnectionCardTracking,
  delegate: () => Promise<T> | T,
): Promise<T> {
  if ('exempt' in tracking) {
    return delegate();
  }

  options.trackDeferredOperation({
    id: options.operationId,
    kind: tracking.kind,
    context: tracking.context,
  });
  try {
    return await delegate();
  } finally {
    options.clearDeferredOperation(options.operationId, tracking.kind);
  }
}

export function createTrackedConnectionCardOps(options: TrackedConnectionCardOpsOptions): ConnectionCardOps {
  const tracker = {
    operationId: options.operationId,
    trackDeferredOperation: options.trackDeferredOperation,
    clearDeferredOperation: options.clearDeferredOperation,
  };

  // Clear-on-settle is correct only for card-owned settings-upsert/remove/toggle
  // contexts that await executed restarts. Do not reuse this wrapper for
  // resolve-on-deferral connect contexts; clearing when that IPC settles would
  // erase the queued state before the deferred restart actually runs.
  return {
    addBundledServer: (payload, tracking) =>
      runTracked(tracker, tracking, () => options.addBundledServer(payload, tracking)),
    upsertServer: (payload, tracking) =>
      runTracked(tracker, tracking, () => options.upsertServer(payload, tracking)),
    removeServer: (serverName, tracking) =>
      runTracked(tracker, tracking, () => options.removeServer(serverName, tracking)),
    toggleServerEnabled: (serverId, tracking) =>
      runTracked(tracker, tracking, () => options.toggleServerEnabled(serverId, tracking)),
    trackResolveOnDeferralConnect: options.trackDeferredOperation,
    clearResolveOnDeferralConnect: options.clearDeferredOperation,
  };
}

export function createUntrackedConnectionCardOps(
  reason: string,
  delegates: ConnectionCardOpsDelegates,
): ConnectionCardOps {
  if (!reason.trim()) {
    throw new Error('createUntrackedConnectionCardOps requires a named reason');
  }

  return {
    addBundledServer: async (payload, tracking) => delegates.addBundledServer(payload, tracking),
    upsertServer: async (payload, tracking) => delegates.upsertServer(payload, tracking),
    removeServer: async (serverName, tracking) => delegates.removeServer(serverName, tracking),
    toggleServerEnabled: async (serverId, tracking) => delegates.toggleServerEnabled(serverId, tracking),
  };
}
