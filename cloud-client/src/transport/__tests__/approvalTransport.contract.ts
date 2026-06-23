/**
 * Shared contract-test suite for `ApprovalTransport`.
 *
 * Both desktop and mobile adapters must pass this suite. Stage 0 of
 * `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md` requires that
 * every adapter conforms to the same invariants so cross-surface hooks can
 * depend on the interface, not the platform.
 *
 * Adapter authors import `runApprovalTransportContract(factory)` and pass a
 * factory that builds a live adapter wired against an in-memory mock of the
 * underlying call sites (`window.safetyPromptApi.*`, `cloudClient.ipcCall(...)`,
 * etc.). The factory also returns hooks for the suite to assert on:
 *
 *     runApprovalTransportContract({
 *       build: () => {
 *         const mock = createMockBackend();
 *         const transport = buildAdapter(mock);
 *         return { transport, mock };
 *       },
 *     });
 *
 * The mock backend exposes the state the suite needs to verify each method
 * forwards correctly (inputs observed, emitted events, stored principles).
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  ApprovalTransport,
  BlockedActionContext,
  PrincipleOption,
  PrincipleOptionScope,
  PrincipleApplyRequest,
  PrincipleUpdate,
  SafetyPromptSnapshot,
  SafetyPromptUpdatedEvent,
} from '../approvalTransport';

// ---------------------------------------------------------------------------
// Mock backend — adapter factories build on top of this.
// ---------------------------------------------------------------------------

export interface ApprovalTransportMockBackend {
  /** Most recent context passed to each generate endpoint. */
  lastGenerateOptionsCtx: BlockedActionContext | null;
  lastGenerateDenyOptionsCtx: BlockedActionContext | null;
  /** Most recent apply request. */
  lastApplyRequest: PrincipleApplyRequest | null;
  lastApplyDenyRequest: PrincipleApplyRequest | null;
  /** Most recent update payload. */
  lastUpdatePrompt: string | null;
  /** Safety-prompt snapshot returned by update(). */
  snapshot: SafetyPromptSnapshot;
  /** Most recent settings calls. */
  lastSafetyLevel: { spaceId: string; level: string } | null;
  lastTrustedTool: { toolId: string; displayName?: string; serverHint?: string } | null;
  /** Canned options and applied update returned by generate/apply methods. */
  cannedOptions: PrincipleOption[];
  cannedDenyOptions: PrincipleOption[];
  cannedApplyUpdate: PrincipleUpdate;
  /** Emit a safety-prompt:updated event to all listeners. */
  emitUpdated(evt: SafetyPromptUpdatedEvent): void;
}

export function createMockBackend(): ApprovalTransportMockBackend {
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
    emitUpdated(_evt) {
      /* overridden by adapter factories */
    },
  };
}

// ---------------------------------------------------------------------------
// Shared suite
// ---------------------------------------------------------------------------

export interface ApprovalTransportFactory {
  build: () => { transport: ApprovalTransport; mock: ApprovalTransportMockBackend };
}

const baseCtx: BlockedActionContext = {
  toolName: 'slack_send_message',
  toolInput: { to: 'U123', text: 'hi' },
  blockReason: 'Contains potentially sensitive text',
};

export function runApprovalTransportContract(
  label: string,
  factory: ApprovalTransportFactory,
): void {
  describe(`ApprovalTransport contract — ${label}`, () => {
    describe('safetyPrompt.generateOptions', () => {
      it('forwards the BlockedActionContext and returns 3 options', async () => {
        const { transport, mock } = factory.build();
        const result = await transport.safetyPrompt.generateOptions(baseCtx);
        expect(mock.lastGenerateOptionsCtx).toEqual(baseCtx);
        expect(result.options).toHaveLength(3);
        expect(result.options.map((o) => o.scope).sort()).toEqual(
          ['broad', 'specific', 'trusted_tool'].sort(),
        );
      });
    });

    describe('safetyPrompt.generateDenyOptions', () => {
      it('forwards the BlockedActionContext and returns 3 deny options', async () => {
        const { transport, mock } = factory.build();
        const result = await transport.safetyPrompt.generateDenyOptions(baseCtx);
        expect(mock.lastGenerateDenyOptionsCtx).toEqual(baseCtx);
        expect(result.options).toHaveLength(3);
      });
    });

    describe('safetyPrompt.applySelection', () => {
      it('forwards the request and returns a PrincipleUpdate', async () => {
        const { transport, mock } = factory.build();
        const req: PrincipleApplyRequest = {
          blockedAction: baseCtx,
          selectedLabel: mock.cannedOptions[1]!.label,
          scope: 'broad' as PrincipleOptionScope,
        };
        const result = await transport.safetyPrompt.applySelection(req);
        expect(mock.lastApplyRequest).toEqual(req);
        expect(result.update).not.toBeNull();
        expect(result.update?.proposedPrinciple).toBeTruthy();
      });
    });

    describe('safetyPrompt.applyDenySelection', () => {
      it('forwards the request and returns a PrincipleUpdate', async () => {
        const { transport, mock } = factory.build();
        const req: PrincipleApplyRequest = {
          blockedAction: baseCtx,
          selectedLabel: mock.cannedDenyOptions[0]!.label,
          scope: 'trusted_tool' as PrincipleOptionScope,
        };
        const result = await transport.safetyPrompt.applyDenySelection(req);
        expect(mock.lastApplyDenyRequest).toEqual(req);
        expect(result.update).not.toBeNull();
      });
    });

    describe('safetyPrompt.update', () => {
      it('persists the updated prompt and returns the new snapshot', async () => {
        const { transport, mock } = factory.build();
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
      it('invokes listeners when the backend emits an update event', () => {
        const { transport, mock } = factory.build();
        const listener = vi.fn();
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
        const { transport, mock } = factory.build();
        const listener = vi.fn();
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
      it('forwards the space id and level without exposing other settings', async () => {
        const { transport, mock } = factory.build();
        await transport.settings.setSpaceSafetyLevel('space_abc', 'cautious');
        expect(mock.lastSafetyLevel).toEqual({ spaceId: 'space_abc', level: 'cautious' });
      });
    });

    describe('settings.addTrustedTool', () => {
      it('forwards the tool id and optional display metadata', async () => {
        const { transport, mock } = factory.build();
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
  });
}
