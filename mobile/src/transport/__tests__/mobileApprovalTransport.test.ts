/**
 * Jest suite for the mobile `ApprovalTransport` adapter.
 *
 * The shared contract in `cloud-client/src/transport/__tests__/approvalTransport.contract.ts`
 * is Vitest-based and runs alongside the desktop adapter. Mobile uses Jest via
 * jest-expo, so we mirror the same invariants here against a local in-memory
 * mock of `cloudClient.ipcCall(...)` and the `safetyPromptEventEmitter`.
 *
 * Stage 0 of `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`.
 */

import type {
  BlockedActionContext,
  PrincipleApplyRequest,
  PrincipleOption,
  PrincipleUpdate,
  SafetyPromptSnapshot,
  SafetyPromptUpdatedEvent,
} from '@rebel/cloud-client';
import { ApprovalTransportError } from '@rebel/cloud-client';
import { buildMobileApprovalTransport } from '../mobileApprovalTransport';

interface MockBackend {
  lastGenerateOptionsCtx: BlockedActionContext | null;
  lastGenerateDenyOptionsCtx: BlockedActionContext | null;
  lastApplyRequest: PrincipleApplyRequest | null;
  lastApplyDenyRequest: PrincipleApplyRequest | null;
  lastUpdatePrompt: string | null;
  snapshot: SafetyPromptSnapshot;
  lastSafetyLevel: { spaceId: string; level: string } | null;
  lastTrustedTool: { toolId: string; displayName?: string; serverHint?: string } | null;
  cannedOptions: PrincipleOption[];
  cannedDenyOptions: PrincipleOption[];
  cannedApplyUpdate: PrincipleUpdate;
  emitUpdated(evt: SafetyPromptUpdatedEvent): void;
}

function createMockBackend(): MockBackend {
  const cannedOptions: PrincipleOption[] = [
    { label: 'Always allow this specific tool', scope: 'trusted_tool' },
    { label: 'Allow this type of action broadly', scope: 'broad' },
    { label: 'Allow just this scenario', scope: 'specific' },
  ];
  const cannedDenyOptions: PrincipleOption[] = [
    { label: 'Block this specific tool', scope: 'trusted_tool' },
    { label: 'Block this type of action broadly', scope: 'broad' },
    { label: 'Block just this scenario', scope: 'specific' },
  ];
  const cannedApplyUpdate: PrincipleUpdate = {
    summary: 'Allow Slack messages to teammates',
    proposedPrinciple: 'Slack messages sent to teammates are always allowed.',
    fullUpdatedPrompt: '...full prompt with the new principle...',
  };
  return {
    lastGenerateOptionsCtx: null,
    lastGenerateDenyOptionsCtx: null,
    lastApplyRequest: null,
    lastApplyDenyRequest: null,
    lastUpdatePrompt: null,
    snapshot: {
      prompt: 'Initial prompt.',
      version: 1,
      lastUpdatedAt: 1700000000000,
      lastUpdatedBy: 'user',
      history: [],
      migrationComplete: true,
    },
    lastSafetyLevel: null,
    lastTrustedTool: null,
    cannedOptions,
    cannedDenyOptions,
    cannedApplyUpdate,
    emitUpdated() {
      /* wired by buildAdapter() */
    },
  };
}

function buildAdapter(mock: MockBackend) {
  const listeners = new Set<(evt: SafetyPromptUpdatedEvent) => void>();
  mock.emitUpdated = (evt) => listeners.forEach((l) => l(evt));

  // Simulated settings state — exercised by setSpaceSafetyLevel.
  const settingsState: { spaceSafetyLevels: Record<string, string>; [k: string]: unknown } = {
    spaceSafetyLevels: {},
  };

  const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    switch (channel) {
      case 'safety-prompt:generate-options': {
        mock.lastGenerateOptionsCtx = args[0] as BlockedActionContext;
        return { options: mock.cannedOptions };
      }
      case 'safety-prompt:generate-deny-options': {
        mock.lastGenerateDenyOptionsCtx = args[0] as BlockedActionContext;
        return { options: mock.cannedDenyOptions };
      }
      case 'safety-prompt:apply-selection': {
        mock.lastApplyRequest = args[0] as PrincipleApplyRequest;
        return { update: mock.cannedApplyUpdate };
      }
      case 'safety-prompt:apply-deny-selection': {
        mock.lastApplyDenyRequest = args[0] as PrincipleApplyRequest;
        return { update: mock.cannedApplyUpdate };
      }
      case 'safety-prompt:update': {
        const req = args[0] as { prompt: string; updatedBy?: 'user' | 'system' | 'migration' };
        mock.lastUpdatePrompt = req.prompt;
        mock.snapshot = {
          ...mock.snapshot,
          prompt: req.prompt,
          version: mock.snapshot.version + 1,
          lastUpdatedAt: Date.now(),
          lastUpdatedBy: req.updatedBy ?? 'user',
        };
        return mock.snapshot;
      }
      case 'settings:set-space-safety-level': {
        // Narrow-slice channel (F-R2-2). The adapter now calls this directly
        // instead of the old settings:get → settings:update dance.
        const req = args[0] as { spaceId: string; level: string };
        settingsState.spaceSafetyLevels = {
          ...settingsState.spaceSafetyLevels,
          [req.spaceId]: req.level,
        };
        mock.lastSafetyLevel = { spaceId: req.spaceId, level: req.level };
        return { success: true };
      }
      case 'settings:add-trusted-tool': {
        const r = args[0] as { toolId: string; displayName?: string; serverHint?: string };
        mock.lastTrustedTool = {
          toolId: r.toolId,
          displayName: r.displayName,
          serverHint: r.serverHint,
        };
        return { success: true };
      }
      default:
        throw new Error(`Unexpected channel in mobile adapter test: ${channel}`);
    }
  };

  return buildMobileApprovalTransport({
     
    ipcCall: call as any,
    safetyPromptEventEmitter: {
      on(_event, handler) {
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      },
    },
  });
}

const baseCtx: BlockedActionContext = {
  toolName: 'slack_send_message',
  toolInput: { to: 'U123', text: 'hi' },
  blockReason: 'Contains potentially sensitive text',
};

describe('mobileApprovalTransport', () => {
  describe('safetyPrompt.generateOptions', () => {
    it('forwards the BlockedActionContext and returns 3 options', async () => {
      const mock = createMockBackend();
      const transport = buildAdapter(mock);
      const result = await transport.safetyPrompt.generateOptions(baseCtx);
      expect(mock.lastGenerateOptionsCtx).toEqual(baseCtx);
      expect(result.options).toHaveLength(3);
    });
  });

  describe('safetyPrompt.generateDenyOptions', () => {
    it('forwards the BlockedActionContext and returns 3 deny options', async () => {
      const mock = createMockBackend();
      const transport = buildAdapter(mock);
      const result = await transport.safetyPrompt.generateDenyOptions(baseCtx);
      expect(mock.lastGenerateDenyOptionsCtx).toEqual(baseCtx);
      expect(result.options).toHaveLength(3);
    });
  });

  describe('safetyPrompt.applySelection', () => {
    it('forwards the request and returns a PrincipleUpdate', async () => {
      const mock = createMockBackend();
      const transport = buildAdapter(mock);
      const req: PrincipleApplyRequest = {
        blockedAction: baseCtx,
        selectedLabel: mock.cannedOptions[1]!.label,
        scope: 'broad',
      };
      const result = await transport.safetyPrompt.applySelection(req);
      expect(mock.lastApplyRequest).toEqual(req);
      expect(result.update?.proposedPrinciple).toBeTruthy();
    });
  });

  describe('safetyPrompt.applyDenySelection', () => {
    it('forwards the request and returns a PrincipleUpdate', async () => {
      const mock = createMockBackend();
      const transport = buildAdapter(mock);
      const req: PrincipleApplyRequest = {
        blockedAction: baseCtx,
        selectedLabel: mock.cannedDenyOptions[0]!.label,
        scope: 'trusted_tool',
      };
      const result = await transport.safetyPrompt.applyDenySelection(req);
      expect(mock.lastApplyDenyRequest).toEqual(req);
      expect(result.update).not.toBeNull();
    });
  });

  describe('safetyPrompt.update', () => {
    it('persists the updated prompt and returns the new snapshot', async () => {
      const mock = createMockBackend();
      const transport = buildAdapter(mock);
      const newPrompt = 'Updated prompt with applied principle.';
      const snapshot = await transport.safetyPrompt.update({
        prompt: newPrompt,
        updatedBy: 'user',
      });
      expect(mock.lastUpdatePrompt).toBe(newPrompt);
      expect(snapshot.prompt).toBe(newPrompt);
      expect(snapshot.version).toBeGreaterThanOrEqual(1);
    });
  });

  describe('safetyPrompt.onUpdated', () => {
    it('invokes listeners when an update event fires', () => {
      const mock = createMockBackend();
      const transport = buildAdapter(mock);
      const listener = jest.fn();
      const unsubscribe = transport.safetyPrompt.onUpdated(listener);
      const evt: SafetyPromptUpdatedEvent = {
        version: 7,
        lastUpdatedAt: Date.now(),
        lastUpdatedBy: 'system',
      };
      mock.emitUpdated(evt);
      expect(listener).toHaveBeenCalledWith(evt);
      unsubscribe();
    });

    it('stops calling listeners after unsubscribe', () => {
      const mock = createMockBackend();
      const transport = buildAdapter(mock);
      const listener = jest.fn();
      const unsubscribe = transport.safetyPrompt.onUpdated(listener);
      unsubscribe();
      mock.emitUpdated({
        version: 2,
        lastUpdatedAt: Date.now(),
        lastUpdatedBy: 'user',
      });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('settings.setSpaceSafetyLevel', () => {
    it('merges the level into existing spaceSafetyLevels and writes back', async () => {
      const mock = createMockBackend();
      const transport = buildAdapter(mock);
      await transport.settings.setSpaceSafetyLevel('space_abc', 'cautious');
      expect(mock.lastSafetyLevel).toEqual({ spaceId: 'space_abc', level: 'cautious' });
    });
  });

  describe('settings.addTrustedTool', () => {
    it('forwards the tool id and optional display metadata', async () => {
      const mock = createMockBackend();
      const transport = buildAdapter(mock);
      await transport.settings.addTrustedTool({
        toolId: 'slack_send_message',
        displayName: 'Slack: Send Message',
        serverHint: 'slack-mcp',
      });
      expect(mock.lastTrustedTool).toEqual({
        toolId: 'slack_send_message',
        displayName: 'Slack: Send Message',
        serverHint: 'slack-mcp',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // F4-1: Fail-loud on `{ success: false }` responses.
  //
  // Mirror of the desktop adapter coverage. The mobile adapter wraps
  // `cloudClient.ipcCall(...)`; the cloud-service handler returns
  // `{ success: false, error: 'READ_ONLY' | 'UNKNOWN_SPACE_ID' }` on a 200
  // response (the IPC route only surfaces the handler payload). Without a
  // fail-loud check the hook would silently UI-apply.
  // ---------------------------------------------------------------------------

  describe('F4-1 fail-loud on { success: false }', () => {
    function buildAdapterWithMockCall(mockCall: (channel: string, ...args: unknown[]) => Promise<unknown>) {
      return buildMobileApprovalTransport({
         
        ipcCall: mockCall as any,
        safetyPromptEventEmitter: {
          on(_event, _handler) {
            return () => {
              /* noop */
            };
          },
        },
      });
    }

    it('setSpaceSafetyLevel: throws ApprovalTransportError when handler returns { success: false, error: READ_ONLY }', async () => {
      const mockCall = jest.fn().mockResolvedValue({ success: false, error: 'READ_ONLY' });
      const transport = buildAdapterWithMockCall(mockCall);
      await expect(
        transport.settings.setSpaceSafetyLevel('space_abc', 'cautious'),
      ).rejects.toMatchObject({
        name: 'ApprovalTransportError',
        method: 'settings.setSpaceSafetyLevel',
        code: 'READ_ONLY',
      });
      await expect(
        transport.settings.setSpaceSafetyLevel('space_abc', 'cautious'),
      ).rejects.toBeInstanceOf(ApprovalTransportError);
    });

    it('setSpaceSafetyLevel: includes structured details for UNKNOWN_SPACE_ID', async () => {
      const mockCall = jest.fn().mockResolvedValue({
        success: false,
        error: 'UNKNOWN_SPACE_ID',
        spaceId: '/spaces/missing',
      });
      const transport = buildAdapterWithMockCall(mockCall);
      await expect(
        transport.settings.setSpaceSafetyLevel('/spaces/missing', 'cautious'),
      ).rejects.toMatchObject({
        name: 'ApprovalTransportError',
        method: 'settings.setSpaceSafetyLevel',
        code: 'UNKNOWN_SPACE_ID',
        details: { spaceId: '/spaces/missing' },
      });
    });

    it('setSpaceSafetyLevel: resolves silently when handler returns { success: true }', async () => {
      const mockCall = jest.fn().mockResolvedValue({ success: true });
      const transport = buildAdapterWithMockCall(mockCall);
      await expect(
        transport.settings.setSpaceSafetyLevel('space_abc', 'cautious'),
      ).resolves.toBeUndefined();
    });

    it('addTrustedTool: throws ApprovalTransportError when handler returns { success: false }', async () => {
      const mockCall = jest.fn().mockResolvedValue({ success: false });
      const transport = buildAdapterWithMockCall(mockCall);
      await expect(
        transport.settings.addTrustedTool({ toolId: 'slack_send_message' }),
      ).rejects.toMatchObject({
        name: 'ApprovalTransportError',
        method: 'settings.addTrustedTool',
      });
    });

    // Stage 4 R2: handler now returns typed READ_ONLY + toolId in read-only mode.
    it('addTrustedTool: surfaces typed READ_ONLY code + toolId', async () => {
      const mockCall = jest.fn().mockResolvedValue({
        success: false,
        error: 'READ_ONLY',
        toolId: 'slack_send_message',
      });
      const transport = buildAdapterWithMockCall(mockCall);
      await expect(
        transport.settings.addTrustedTool({ toolId: 'slack_send_message' }),
      ).rejects.toMatchObject({
        name: 'ApprovalTransportError',
        method: 'settings.addTrustedTool',
        code: 'READ_ONLY',
        details: { toolId: 'slack_send_message' },
      });
    });

    it('addTrustedTool: resolves silently when handler returns { success: true }', async () => {
      const mockCall = jest.fn().mockResolvedValue({ success: true });
      const transport = buildAdapterWithMockCall(mockCall);
      await expect(
        transport.settings.addTrustedTool({ toolId: 'slack_send_message' }),
      ).resolves.toBeUndefined();
    });
  });
});
