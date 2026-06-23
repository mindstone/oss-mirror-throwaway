/**
 * Verifies the shared contract suite (`approvalTransport.contract.ts`) is
 * coherent by running it against an in-memory reference implementation. Real
 * adapters (desktop, mobile) run the same suite against live bindings.
 */

import type {
  ApprovalTransport,
  SafetyPromptUpdatedEvent,
} from '../approvalTransport';
import {
  createMockBackend,
  runApprovalTransportContract,
  type ApprovalTransportMockBackend,
} from './approvalTransport.contract';

function buildReferenceAdapter(): {
  transport: ApprovalTransport;
  mock: ApprovalTransportMockBackend;
} {
  const mock = createMockBackend();
  const listeners = new Set<(evt: SafetyPromptUpdatedEvent) => void>();
  mock.emitUpdated = (evt) => {
    listeners.forEach((l) => l(evt));
  };

  const transport: ApprovalTransport = {
    safetyPrompt: {
      async generateOptions(ctx) {
        mock.lastGenerateOptionsCtx = ctx;
        return { options: mock.cannedOptions };
      },
      async generateDenyOptions(ctx) {
        mock.lastGenerateDenyOptionsCtx = ctx;
        return { options: mock.cannedDenyOptions };
      },
      async applySelection(req) {
        mock.lastApplyRequest = req;
        return { update: mock.cannedApplyUpdate };
      },
      async applyDenySelection(req) {
        mock.lastApplyDenyRequest = req;
        return { update: mock.cannedApplyUpdate };
      },
      async update(req) {
        mock.lastUpdatePrompt = req.prompt;
        mock.snapshot = {
          ...mock.snapshot,
          prompt: req.prompt,
          version: mock.snapshot.version + 1,
          lastUpdatedAt: Date.now(),
          lastUpdatedBy: req.updatedBy ?? 'user',
        };
        return mock.snapshot;
      },
      onUpdated(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    settings: {
      async setSpaceSafetyLevel(spaceId, level) {
        mock.lastSafetyLevel = { spaceId, level };
      },
      async addTrustedTool(req) {
        mock.lastTrustedTool = {
          toolId: req.toolId,
          displayName: req.displayName,
          serverHint: req.serverHint,
        };
      },
    },
  };

  return { transport, mock };
}

runApprovalTransportContract('in-memory reference implementation', {
  build: buildReferenceAdapter,
});
