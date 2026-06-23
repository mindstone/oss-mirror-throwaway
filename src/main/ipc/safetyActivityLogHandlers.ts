/**
 * Safety Activity Log IPC handlers.
 */

import type { IpcMainInvokeEvent } from 'electron';
import { getActivityLog, flagEntry, unflagEntry } from '@core/safetyActivityLogStore';
import { createScopedLogger } from '@core/logger';
import type { SafetyActivityLogCloudSyncState } from '@shared/ipc/channels/safetyActivityLog';
import { registerHandler } from './utils/registerHandler';

const log = createScopedLogger({ service: 'safetyActivityLogHandlers' });

export interface SafetyActivityLogHandlerDeps {
  syncCloud?: () => Promise<{ cloudSyncState: SafetyActivityLogCloudSyncState }>;
}

export function registerSafetyActivityLogHandlers(deps: SafetyActivityLogHandlerDeps = {}): void {
  log.info('Registering safety activity log handlers');

  registerHandler(
    'safety-activity-log:get',
    async (_event: IpcMainInvokeEvent, args?: { limit?: number }) => {
      const entries = getActivityLog();
      const limit = args?.limit;
      return {
        entries: limit !== undefined ? entries.slice(0, limit) : entries,
      };
    },
  );

  registerHandler(
    'safety-activity-log:flag',
    async (_event: IpcMainInvokeEvent, args: { entryId: string }) => {
      const success = flagEntry(args.entryId);
      if (!success) {
        log.warn({ entryId: args.entryId }, 'Flag request for unknown or non-evaluation entry');
      }
      return { success };
    },
  );

  registerHandler(
    'safety-activity-log:unflag',
    async (_event: IpcMainInvokeEvent, args: { entryId: string }) => {
      const success = unflagEntry(args.entryId);
      if (!success) {
        log.warn({ entryId: args.entryId }, 'Unflag request for unknown or non-flagged entry');
      }
      return { success };
    },
  );

  registerHandler(
    'safety-activity-log:sync-cloud',
    async () => {
      if (!deps.syncCloud) {
        return { cloudSyncState: 'not-configured' as const };
      }
      return deps.syncCloud();
    },
  );
}
