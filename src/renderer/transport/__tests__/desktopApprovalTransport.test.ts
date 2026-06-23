/**
 * Runs the shared ApprovalTransport contract suite against the desktop adapter.
 *
 * See `cloud-client/src/transport/__tests__/approvalTransport.contract.ts` for
 * suite details and Stage 0 of
 * `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md` for context.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  SafetyPromptUpdatedEvent,
  SafetyPromptUpdater,
} from '@rebel/cloud-client';
import { ApprovalTransportError } from '@rebel/cloud-client';
import {
  createMockBackend,
  runApprovalTransportContract,
  type ApprovalTransportMockBackend,
} from '../../../../cloud-client/src/transport/__tests__/approvalTransport.contract';
import { buildDesktopApprovalTransport } from '../desktopApprovalTransport';

interface FakeSafetyPromptApi {
  generateOptions: (ctx: unknown) => Promise<unknown>;
  generateDenyOptions: (ctx: unknown) => Promise<unknown>;
  applySelection: (req: unknown) => Promise<unknown>;
  applyDenySelection: (req: unknown) => Promise<unknown>;
  update: (req: { prompt: string; updatedBy?: SafetyPromptUpdater }) => Promise<unknown>;
}

interface FakeSettingsApi {
  get: () => Promise<unknown>;
  update: (settings: unknown) => Promise<unknown>;
  setSpaceSafetyLevel: (req: { spaceId: string; level: string }) => Promise<unknown>;
  addTrustedTool: (req: unknown) => Promise<unknown>;
}

interface FakeSubscriptions {
  onSafetyPromptUpdated: (listener: (evt: SafetyPromptUpdatedEvent) => void) => () => void;
  onSafetyPromptRulePersisted: (listener: (evt: {
    version: number;
    lastUpdatedAt: number;
    source: 'ui-picker' | 'chat-intent' | 'settings-editor' | 'system' | 'migration';
    summary: string;
    proposedPrinciple: string;
  }) => void) => () => void;
}

function buildFakesFromMock(mock: ApprovalTransportMockBackend): {
  safetyPromptApi: FakeSafetyPromptApi;
  settingsApi: FakeSettingsApi;
  safetyPromptSubscriptions: FakeSubscriptions;
} {
  const listeners = new Set<(evt: SafetyPromptUpdatedEvent) => void>();
  mock.emitUpdated = (evt) => listeners.forEach((l) => l(evt));

  // Simulated settings state — exercised by setSpaceSafetyLevel.
  const settingsState: { spaceSafetyLevels: Record<string, string> } = {
    spaceSafetyLevels: {},
  };

  return {
    safetyPromptApi: {
      generateOptions: async (ctx) => {
        mock.lastGenerateOptionsCtx = ctx as ApprovalTransportMockBackend['lastGenerateOptionsCtx'];
        return { options: mock.cannedOptions };
      },
      generateDenyOptions: async (ctx) => {
        mock.lastGenerateDenyOptionsCtx = ctx as ApprovalTransportMockBackend['lastGenerateDenyOptionsCtx'];
        return { options: mock.cannedDenyOptions };
      },
      applySelection: async (req) => {
        mock.lastApplyRequest = req as ApprovalTransportMockBackend['lastApplyRequest'];
        return { update: mock.cannedApplyUpdate };
      },
      applyDenySelection: async (req) => {
        mock.lastApplyDenyRequest = req as ApprovalTransportMockBackend['lastApplyDenyRequest'];
        return { update: mock.cannedApplyUpdate };
      },
      update: async (req) => {
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
    },
    settingsApi: {
      get: async () => ({ ...settingsState }),
      update: async (settings) => {
        const next = settings as { spaceSafetyLevels?: Record<string, string> };
        if (next.spaceSafetyLevels) {
          settingsState.spaceSafetyLevels = next.spaceSafetyLevels;
          const entries = Object.entries(next.spaceSafetyLevels);
          if (entries.length === 1) {
            const [spaceId, level] = entries[0]!;
            mock.lastSafetyLevel = { spaceId, level };
          }
        }
        return settings;
      },
      // Narrow-slice channel (F-R2-2). Desktop adapter now calls this directly.
      setSpaceSafetyLevel: async (req: { spaceId: string; level: string }) => {
        settingsState.spaceSafetyLevels = {
          ...settingsState.spaceSafetyLevels,
          [req.spaceId]: req.level,
        };
        mock.lastSafetyLevel = { spaceId: req.spaceId, level: req.level };
        return { success: true };
      },
      addTrustedTool: async (req) => {
        const r = req as { toolId: string; displayName?: string; serverHint?: string };
        mock.lastTrustedTool = {
          toolId: r.toolId,
          displayName: r.displayName,
          serverHint: r.serverHint,
        };
        return { success: true };
      },
    },
    safetyPromptSubscriptions: {
      onSafetyPromptUpdated(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      onSafetyPromptRulePersisted(_listener) {
        return () => {};
      },
    },
  };
}

runApprovalTransportContract('desktop adapter', {
  build: () => {
    const mock = createMockBackend();
    const fakes = buildFakesFromMock(mock);
    const transport = buildDesktopApprovalTransport({
      safetyPromptApi: fakes.safetyPromptApi as any,
      settingsApi: fakes.settingsApi as any,
      safetyPromptSubscriptions: fakes.safetyPromptSubscriptions,
    });
    return { transport, mock };
  },
});

// Desktop-specific: setSpaceSafetyLevel now uses the narrow-slice IPC channel (F-R2-2).
describe('desktopApprovalTransport — narrow-slice setSpaceSafetyLevel', () => {
  it('calls settingsApi.setSpaceSafetyLevel directly (no get→merge→update race)', async () => {
    const setSpaceSpy = vi.fn().mockResolvedValue({ success: true });
    const transport = buildDesktopApprovalTransport({
      safetyPromptApi: {} as any,
      settingsApi: { setSpaceSafetyLevel: setSpaceSpy, addTrustedTool: vi.fn() } as any,
      safetyPromptSubscriptions: {} as any,
    });
    await transport.settings.setSpaceSafetyLevel('space_abc', 'cautious');
    expect(setSpaceSpy).toHaveBeenCalledOnce();
    expect(setSpaceSpy).toHaveBeenCalledWith({ spaceId: 'space_abc', level: 'cautious' });
  });
});

// -----------------------------------------------------------------------------
// F4-1: Fail-loud on `{ success: false }` responses.
//
// The underlying IPC handlers (`settings:set-space-safety-level`,
// `settings:add-trusted-tool`) return `{ success: false, error?: string }` on
// rejection (READ_ONLY, UNKNOWN_SPACE_ID, etc.) WITHOUT throwing. The transport
// adapter MUST surface this as an `ApprovalTransportError` so `usePrincipleOptions`
// reaches its `catch` branch and refuses to transition to `applyState='applied'`.
// -----------------------------------------------------------------------------

describe('desktopApprovalTransport — F4-1 fail-loud on { success: false }', () => {
  it('setSpaceSafetyLevel: throws ApprovalTransportError when handler returns { success: false, error: READ_ONLY }', async () => {
    const setSpaceSpy = vi
      .fn()
      .mockResolvedValue({ success: false, error: 'READ_ONLY' });
    const transport = buildDesktopApprovalTransport({
      safetyPromptApi: {} as any,
      settingsApi: { setSpaceSafetyLevel: setSpaceSpy, addTrustedTool: vi.fn() } as any,
      safetyPromptSubscriptions: {} as any,
    });

    await expect(
      transport.settings.setSpaceSafetyLevel('space_abc', 'cautious'),
    ).rejects.toMatchObject({
      name: 'ApprovalTransportError',
      method: 'settings.setSpaceSafetyLevel',
      code: 'READ_ONLY',
    });
    // Typed-instance check (round-trips ApprovalTransportError-ness).
    await expect(
      transport.settings.setSpaceSafetyLevel('space_abc', 'cautious'),
    ).rejects.toBeInstanceOf(ApprovalTransportError);
  });

  it('setSpaceSafetyLevel: throws ApprovalTransportError with structured details for UNKNOWN_SPACE_ID', async () => {
    const setSpaceSpy = vi.fn().mockResolvedValue({
      success: false,
      error: 'UNKNOWN_SPACE_ID',
      spaceId: '/spaces/missing',
    });
    const transport = buildDesktopApprovalTransport({
      safetyPromptApi: {} as any,
      settingsApi: { setSpaceSafetyLevel: setSpaceSpy, addTrustedTool: vi.fn() } as any,
      safetyPromptSubscriptions: {} as any,
    });

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
    const setSpaceSpy = vi.fn().mockResolvedValue({ success: true });
    const transport = buildDesktopApprovalTransport({
      safetyPromptApi: {} as any,
      settingsApi: { setSpaceSafetyLevel: setSpaceSpy, addTrustedTool: vi.fn() } as any,
      safetyPromptSubscriptions: {} as any,
    });
    await expect(
      transport.settings.setSpaceSafetyLevel('space_abc', 'cautious'),
    ).resolves.toBeUndefined();
  });

  it('addTrustedTool: throws ApprovalTransportError when handler returns { success: false }', async () => {
    const addSpy = vi.fn().mockResolvedValue({ success: false });
    const transport = buildDesktopApprovalTransport({
      safetyPromptApi: {} as any,
      settingsApi: { setSpaceSafetyLevel: vi.fn(), addTrustedTool: addSpy } as any,
      safetyPromptSubscriptions: {} as any,
    });

    await expect(
      transport.settings.addTrustedTool({
        toolId: 'slack_send_message',
        displayName: 'Slack: Send Message',
      }),
    ).rejects.toMatchObject({
      name: 'ApprovalTransportError',
      method: 'settings.addTrustedTool',
    });
  });

  // Stage 4 R2: `settings:add-trusted-tool` handler now returns
  // `{ success: false, error: 'READ_ONLY', toolId }` in read-only mode so
  // ApprovalTransport consumers can classify the failure exactly like
  // `setSpaceSafetyLevel`'s READ_ONLY / UNKNOWN_SPACE_ID paths.
  it('addTrustedTool: surfaces typed READ_ONLY code + toolId when handler rejects in read-only mode', async () => {
    const addSpy = vi.fn().mockResolvedValue({
      success: false,
      error: 'READ_ONLY',
      toolId: 'slack_send_message',
    });
    const transport = buildDesktopApprovalTransport({
      safetyPromptApi: {} as any,
      settingsApi: { setSpaceSafetyLevel: vi.fn(), addTrustedTool: addSpy } as any,
      safetyPromptSubscriptions: {} as any,
    });

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
    const addSpy = vi.fn().mockResolvedValue({ success: true });
    const transport = buildDesktopApprovalTransport({
      safetyPromptApi: {} as any,
      settingsApi: { setSpaceSafetyLevel: vi.fn(), addTrustedTool: addSpy } as any,
      safetyPromptSubscriptions: {} as any,
    });
    await expect(
      transport.settings.addTrustedTool({ toolId: 'slack_send_message' }),
    ).resolves.toBeUndefined();
  });
});
