import {
  createUntrackedConnectionCardOps,
  type ConnectionCardAddBundledServerPayload,
  type ConnectionCardAddBundledServerResult,
  type ConnectionCardOps,
  type ConnectionCardToggleServerEnabledResult,
  type ConnectionCardTracking,
} from '../useConnectionCardOps';
import type { McpServerUpsertPayload } from '@shared/types';

type TestConnectionCardOpsOverrides = {
  addBundledServer?: (
    payload: ConnectionCardAddBundledServerPayload,
    tracking: ConnectionCardTracking,
  ) => Promise<ConnectionCardAddBundledServerResult> | ConnectionCardAddBundledServerResult;
  upsertServer?: (
    payload: McpServerUpsertPayload,
    tracking: ConnectionCardTracking,
  ) => Promise<void> | void;
  removeServer?: (
    serverName: string,
    tracking: ConnectionCardTracking,
  ) => Promise<void> | void;
  toggleServerEnabled?: (
    serverId: string,
    tracking: ConnectionCardTracking,
  ) => Promise<ConnectionCardToggleServerEnabledResult> | ConnectionCardToggleServerEnabledResult;
};

export function createTestConnectionCardOps(overrides: TestConnectionCardOpsOverrides = {}): ConnectionCardOps {
  return createUntrackedConnectionCardOps('test fixture has no queued-state owner', {
    addBundledServer: overrides.addBundledServer ?? ((payload) => window.settingsApi.mcpAddBundledServer(payload)),
    upsertServer: overrides.upsertServer ?? (async () => undefined),
    removeServer: overrides.removeServer ?? (async () => undefined),
    toggleServerEnabled: overrides.toggleServerEnabled ?? ((serverId) => window.settingsApi.mcpToggleServerEnabled({ serverId })),
  });
}
