/**
 * Inbound Trigger IPC Handlers
 *
 * Handles all inbound-triggers:* IPC channels for managing
 * inbound trigger adapters (enable/disable, state queries).
 */

import type { IpcMainInvokeEvent } from 'electron';
import { inboundTriggersChannels } from '@shared/ipc/contracts';
import { registerHandler } from './utils/registerHandler';
import type { InboundTriggerService } from '../services/inboundTriggers/inboundTriggerService';

export interface InboundTriggerHandlerDeps {
  getInboundTriggerService: () => InboundTriggerService;
}

export function registerInboundTriggerHandlers(deps: InboundTriggerHandlerDeps): void {
  const { getInboundTriggerService } = deps;

  registerHandler(
    inboundTriggersChannels['inbound-triggers:get-state'].channel,
    (_event: IpcMainInvokeEvent) => {
      return getInboundTriggerService().getState();
    }
  );

  registerHandler(
    inboundTriggersChannels['inbound-triggers:set-adapter-enabled'].channel,
    (_event: IpcMainInvokeEvent, request: { adapterId: string; enabled: boolean }) => {
      getInboundTriggerService().setAdapterEnabled(request.adapterId, request.enabled);
    }
  );

  registerHandler(
    inboundTriggersChannels['inbound-triggers:get-adapter-state'].channel,
    (_event: IpcMainInvokeEvent, request: { adapterId: string }) => {
      return getInboundTriggerService().getAdapterState(request.adapterId);
    }
  );

  registerHandler(
    inboundTriggersChannels['inbound-triggers:check-prerequisites'].channel,
    async (_event: IpcMainInvokeEvent, request: { adapterId: string }) => {
      return getInboundTriggerService().checkPrerequisites(request.adapterId);
    }
  );
}
