/**
 * usePrincipleOptions — state-machine unit tests.
 *
 * Covers the Stage 4 Round-2 F4-5 gap (planner promised hook unit tests; none
 * existed). Focus areas:
 *  - generation lifecycle (loading → loaded | error)
 *  - selection → confirm → applying → applied
 *  - safety-prompt persistence step (transport.safetyPrompt.update) wraps
 *    applySelection with proper fail-loud semantics (F15)
 *  - trusted-tool confirmation for non-memory tools: settings-transport call
 *  - memory_write + trusted_tool path routes directly through applySelection
 *  - fail-loud propagation of `ApprovalTransportError` from
 *    `settings.addTrustedTool`
 *    (F4-1 integration — the hook must NOT transition to `applied` and must
 *    NOT call `onApprove` when the transport throws)
 *  - deny direction — trusted_tool path short-circuits to principle apply
 *  - goBack / retry flows
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePrincipleOptions } from '../hooks/usePrincipleOptions';
import { ApprovalTransportError } from '../transport/approvalTransport';
import type {
  ApprovalTransport,
  BlockedActionContext,
  PrincipleApplyResult,
  PrincipleOption,
  PrincipleOptionsResult,
  SafetyPromptSnapshot,
  SafetyPromptUpdatedEvent,
} from '../transport/approvalTransport';

// ---------------------------------------------------------------------------
// Transport mock factory
// ---------------------------------------------------------------------------

interface MockTransportState {
  generateOptions: ReturnType<typeof vi.fn>;
  generateDenyOptions: ReturnType<typeof vi.fn>;
  applySelection: ReturnType<typeof vi.fn>;
  applyDenySelection: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  onUpdated: ReturnType<typeof vi.fn>;
  setSpaceSafetyLevel: ReturnType<typeof vi.fn>;
  addTrustedTool: ReturnType<typeof vi.fn>;
  transport: ApprovalTransport;
}

function buildMockTransport(overrides: Partial<MockTransportState> = {}): MockTransportState {
  const defaultOptions: PrincipleOption[] = [
    { label: 'Always allow this specific tool', scope: 'trusted_tool' },
    { label: 'Allow this type broadly', scope: 'broad' },
    { label: 'Allow just this scenario', scope: 'specific' },
  ];
  const defaultApplyUpdate = {
    summary: 'Allow memory writes to Team Ops',
    proposedPrinciple: 'Always allow memory writes to "Team Ops".',
    fullUpdatedPrompt: '...full prompt including the new principle...',
  };
  const defaultSnapshot: SafetyPromptSnapshot = {
    prompt: '...full prompt including the new principle...',
    version: 2,
    lastUpdatedAt: 1700000000000,
    lastUpdatedBy: 'system',
    history: [],
    migrationComplete: true,
  };

  const generateOptions =
    overrides.generateOptions ??
    vi.fn<() => Promise<PrincipleOptionsResult>>().mockResolvedValue({ options: defaultOptions });
  const generateDenyOptions =
    overrides.generateDenyOptions ??
    vi.fn<() => Promise<PrincipleOptionsResult>>().mockResolvedValue({ options: defaultOptions });
  const applySelection =
    overrides.applySelection ??
    vi.fn<() => Promise<PrincipleApplyResult>>().mockResolvedValue({ update: defaultApplyUpdate });
  const applyDenySelection =
    overrides.applyDenySelection ??
    vi.fn<() => Promise<PrincipleApplyResult>>().mockResolvedValue({ update: defaultApplyUpdate });
  const update =
    overrides.update ??
    vi.fn<() => Promise<SafetyPromptSnapshot>>().mockResolvedValue(defaultSnapshot);
  const onUpdated =
    overrides.onUpdated ??
    vi.fn((_listener: (evt: SafetyPromptUpdatedEvent) => void) => () => {
      /* noop */
    });
  const setSpaceSafetyLevel =
    overrides.setSpaceSafetyLevel ?? vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const addTrustedTool =
    overrides.addTrustedTool ?? vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

  const transport: ApprovalTransport = {
    safetyPrompt: {
      generateOptions: generateOptions as unknown as ApprovalTransport['safetyPrompt']['generateOptions'],
      generateDenyOptions: generateDenyOptions as unknown as ApprovalTransport['safetyPrompt']['generateDenyOptions'],
      applySelection: applySelection as unknown as ApprovalTransport['safetyPrompt']['applySelection'],
      applyDenySelection: applyDenySelection as unknown as ApprovalTransport['safetyPrompt']['applyDenySelection'],
      update: update as unknown as ApprovalTransport['safetyPrompt']['update'],
      onUpdated: onUpdated as unknown as ApprovalTransport['safetyPrompt']['onUpdated'],
    },
    settings: {
      setSpaceSafetyLevel: setSpaceSafetyLevel as unknown as ApprovalTransport['settings']['setSpaceSafetyLevel'],
      addTrustedTool: addTrustedTool as unknown as ApprovalTransport['settings']['addTrustedTool'],
    },
  };

  return {
    generateOptions,
    generateDenyOptions,
    applySelection,
    applyDenySelection,
    update,
    onUpdated,
    setSpaceSafetyLevel,
    addTrustedTool,
    transport,
  };
}

const baseBlockedAction: BlockedActionContext = {
  toolName: 'slack_send_message',
  toolInput: { to: 'U123', text: 'hi' },
  blockReason: 'Safety Rules blocked: contains sensitive text',
};

const memoryWriteBlockedAction: BlockedActionContext = {
  toolName: 'memory_write',
  toolInput: {
    spaceName: 'Team Ops',
    spacePath: '/spaces/team-ops',
    filePath: 'notes/retro.md',
    sharing: 'restricted',
  },
  blockReason: 'Memory write to "Team Ops"',
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('usePrincipleOptions — state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------

  it('starts in idle state with empty options and no errors', () => {
    const mocks = buildMockTransport();
    const onApprove = vi.fn();
    const { result } = renderHook(() =>
      usePrincipleOptions({
        transport: mocks.transport,
        blockedAction: baseBlockedAction,
        effectiveToolId: 'slack_send_message',
        packageName: 'slack-mcp',
        onApprove,
      }),
    );

    expect(result.current.generationState).toBe('idle');
    expect(result.current.options).toEqual([]);
    expect(result.current.generationError).toBeNull();
    expect(result.current.selectedOption).toBeNull();
    expect(result.current.applyState).toBe('idle');
    expect(result.current.applyError).toBeNull();
    expect(result.current.appliedUpdate).toBeNull();
    expect(onApprove).not.toHaveBeenCalled();
    expect(mocks.generateOptions).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // startGeneration — guarded, only fires once unless retried
  // -------------------------------------------------------------------------

  describe('startGeneration', () => {
    it('calls transport.safetyPrompt.generateOptions and transitions loading → loaded', async () => {
      const mocks = buildMockTransport();
      const onApprove = vi.fn();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove,
        }),
      );

      act(() => result.current.startGeneration());
      expect(result.current.generationState).toBe('loading');
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));
      expect(result.current.options).toHaveLength(3);
      expect(mocks.generateOptions).toHaveBeenCalledTimes(1);
      expect(mocks.generateOptions).toHaveBeenCalledWith({
        toolName: 'slack_send_message',
        toolInput: { to: 'U123', text: 'hi' },
        // `extractBlockReason` strips the 'Safety Rules blocked:' prefix.
        blockReason: 'contains sensitive text',
        spaceDescription: undefined,
      });
    });

    it('is guarded — multiple calls before completion only fire generateOptions once', async () => {
      const mocks = buildMockTransport();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove: vi.fn(),
        }),
      );

      act(() => {
        result.current.startGeneration();
        result.current.startGeneration();
        result.current.startGeneration();
      });
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));
      expect(mocks.generateOptions).toHaveBeenCalledTimes(1);
    });

    it('transitions to error when generateOptions rejects', async () => {
      const mocks = buildMockTransport({
        generateOptions: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      });
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove: vi.fn(),
        }),
      );

      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('error'));
      expect(result.current.generationError).toBe('LLM unavailable');
      expect(result.current.options).toEqual([]);
    });

    it('transitions to error when generateOptions resolves with no options and an error string', async () => {
      const mocks = buildMockTransport({
        generateOptions: vi.fn().mockResolvedValue({ options: [], error: 'empty output' }),
      });
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove: vi.fn(),
        }),
      );

      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('error'));
      expect(result.current.generationError).toBe('empty output');
    });

    // F-D-R2-5 (260417_approval_consolidation_closeout): distinguish the
    // "loaded but no suggestions" path from generation errors so the UI
    // can render the free-text fallback instead of an error banner.
    it('transitions to loaded with empty options when generateOptions resolves with [] and no error', async () => {
      const mocks = buildMockTransport({
        generateOptions: vi.fn().mockResolvedValue({ options: [] }),
      });
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove: vi.fn(),
        }),
      );

      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));
      expect(result.current.options).toEqual([]);
      expect(result.current.generationError).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // selectOption
  // -------------------------------------------------------------------------

  describe('selectOption', () => {
    it('records the selection index and resets apply state', async () => {
      const mocks = buildMockTransport();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove: vi.fn(),
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));

      act(() => result.current.selectOption(1));
      expect(result.current.selectedOption).toBe(1);
      expect(result.current.applyState).toBe('idle');
    });

    it('accepts "other" free-text selection', async () => {
      const mocks = buildMockTransport();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove: vi.fn(),
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));

      act(() => {
        result.current.selectOption('other');
        result.current.setOtherText('Custom principle text');
      });
      expect(result.current.selectedOption).toBe('other');
      expect(result.current.otherText).toBe('Custom principle text');
    });
  });

  // -------------------------------------------------------------------------
  // confirmSelection — non-trusted-tool scopes trigger apply + persist
  // -------------------------------------------------------------------------

  describe('confirmSelection (non-trusted-tool scope)', () => {
    it('applies then persists via transport.safetyPrompt.update, transitions to applied, calls onApprove', async () => {
      const mocks = buildMockTransport();
      const onApprove = vi.fn();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove,
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));

      act(() => result.current.selectOption(1)); // 'broad' scope
      act(() => result.current.confirmSelection());
      expect(result.current.applyState).toBe('applying');
      await waitFor(() => expect(result.current.applyState).toBe('applied'));

      // applySelection was called with the selected option's label + scope.
      expect(mocks.applySelection).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedLabel: 'Allow this type broadly',
          scope: 'broad',
        }),
      );
      // Persistence step fires after apply.
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: expect.any(String), updatedBy: 'system' }),
      );
      // Caller was notified.
      expect(onApprove).toHaveBeenCalledTimes(1);
      expect(result.current.appliedUpdate?.proposedPrinciple).toContain('Team Ops');
    });

    it('surfaces applyState=error when applySelection throws and does NOT call update/onApprove', async () => {
      const mocks = buildMockTransport({
        applySelection: vi.fn().mockRejectedValue(new Error('apply failed')),
      });
      const onApprove = vi.fn();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove,
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));

      act(() => result.current.selectOption(1));
      act(() => result.current.confirmSelection());
      await waitFor(() => expect(result.current.applyState).toBe('error'));

      expect(result.current.applyError).toBe('apply failed');
      expect(mocks.update).not.toHaveBeenCalled();
      expect(onApprove).not.toHaveBeenCalled();
    });

    it('surfaces applyState=error when transport.safetyPrompt.update fails — rule was not persisted; does NOT call onApprove (F15)', async () => {
      const mocks = buildMockTransport({
        update: vi.fn().mockRejectedValue(new Error('persist failed')),
      });
      const onApprove = vi.fn();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove,
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));

      act(() => result.current.selectOption(1));
      act(() => result.current.confirmSelection());
      await waitFor(() => expect(result.current.applyState).toBe('error'));

      expect(result.current.applyError).toMatch(/Failed to save the rule update/);
      expect(onApprove).not.toHaveBeenCalled();
      // The apply-selection response was received but persistence failed.
      expect(mocks.applySelection).toHaveBeenCalled();
      expect(mocks.update).toHaveBeenCalled();
    });

    it('surfaces applyState=error when applySelection returns { update: null, error }', async () => {
      const mocks = buildMockTransport({
        applySelection: vi
          .fn()
          .mockResolvedValue({ update: null, error: 'Could not apply principle' }),
      });
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove: vi.fn(),
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));

      act(() => result.current.selectOption(1));
      act(() => result.current.confirmSelection());
      await waitFor(() => expect(result.current.applyState).toBe('error'));
      expect(result.current.applyError).toBe('Could not apply principle');
      expect(mocks.update).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // trusted_tool flow
  // - non-memory tools: confirmSelection → confirming_trust → confirmTrustedTool
  // - memory_write: confirmSelection routes directly to applySelection
  // -------------------------------------------------------------------------

  describe('trusted_tool flow (allow direction)', () => {
    it('transitions confirmSelection → confirming_trust instead of applying', async () => {
      const mocks = buildMockTransport();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          packageName: 'slack-mcp',
          onApprove: vi.fn(),
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));

      act(() => result.current.selectOption(0)); // 'trusted_tool' scope
      act(() => result.current.confirmSelection());
      expect(result.current.applyState).toBe('confirming_trust');
      // applySelection NOT called yet — waiting for second confirm.
      expect(mocks.applySelection).not.toHaveBeenCalled();
    });

    it('confirmTrustedTool (non-memory tool) calls settings.addTrustedTool and transitions to applied', async () => {
      const mocks = buildMockTransport();
      const onApprove = vi.fn();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          packageName: 'slack-mcp',
          onApprove,
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));

      act(() => result.current.selectOption(0));
      act(() => result.current.confirmSelection());
      expect(result.current.applyState).toBe('confirming_trust');

      // confirmTrustedTool is async — wrap in `await act(async ...)` so React
      // flushes the settings-transport call before assertions.
      await act(async () => {
        await result.current.confirmTrustedTool();
      });
      expect(result.current.applyState).toBe('applied');
      expect(mocks.addTrustedTool).toHaveBeenCalledWith({
        toolId: 'slack_send_message',
        displayName: 'slack_send_message',
        serverHint: 'slack-mcp',
      });
      expect(onApprove).toHaveBeenCalledTimes(1);
    });

    it('confirmTrustedTool (memory_write) routes through applySelection and transitions to applied', async () => {
      const mocks = buildMockTransport();
      const onApprove = vi.fn();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: memoryWriteBlockedAction,
          effectiveToolId: 'memory_write',
          onApprove,
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));

      act(() => result.current.selectOption(0));
      act(() => result.current.confirmSelection());
      expect(result.current.applyState).toBe('applying');
      expect(mocks.applySelection).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'trusted_tool',
          selectedLabel: 'Always allow this specific tool',
        }),
      );
      await waitFor(() => expect(result.current.applyState).toBe('applied'));
      expect(result.current.applyState).toBe('applied');

      expect(mocks.setSpaceSafetyLevel).not.toHaveBeenCalled();
      expect(mocks.addTrustedTool).not.toHaveBeenCalled();
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(onApprove).toHaveBeenCalledTimes(1);
    });

    it('memory_write + trusted_tool skips confirming_trust and routes directly to apply', async () => {
      const mocks = buildMockTransport();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: memoryWriteBlockedAction,
          effectiveToolId: 'memory_write',
          onApprove: vi.fn(),
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));

      act(() => result.current.selectOption(0));
      act(() => result.current.confirmSelection());

      expect(result.current.applyState).toBe('applying');
      expect(mocks.applySelection).toHaveBeenCalledTimes(1);
      expect(mocks.setSpaceSafetyLevel).not.toHaveBeenCalled();
      expect(mocks.addTrustedTool).not.toHaveBeenCalled();
      await waitFor(() => expect(result.current.applyState).toBe('applied'));
    });

    // -----------------------------------------------------------------------
    // F4-1 fail-loud integration
    // -----------------------------------------------------------------------

    it('F4-1: surfaces applyState=error when settings.addTrustedTool throws ApprovalTransportError — NO onApprove call', async () => {
      const mocks = buildMockTransport({
        addTrustedTool: vi
          .fn()
          .mockRejectedValue(
            new ApprovalTransportError('settings.addTrustedTool', 'READ_ONLY'),
          ),
      });
      const onApprove = vi.fn();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove,
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));

      act(() => result.current.selectOption(0));
      act(() => result.current.confirmSelection());
      await act(async () => {
        await result.current.confirmTrustedTool();
      });
      expect(result.current.applyState).toBe('error');

      // Error propagated via the hook (includes transport code in the message).
      expect(result.current.applyError).toMatch(/READ_ONLY/);
      expect(onApprove).not.toHaveBeenCalled();
      expect(mocks.addTrustedTool).toHaveBeenCalledTimes(1);
    });

    it('cancelTrustedTool returns to idle without calling transport', async () => {
      const mocks = buildMockTransport();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove: vi.fn(),
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));
      act(() => result.current.selectOption(0));
      act(() => result.current.confirmSelection());
      expect(result.current.applyState).toBe('confirming_trust');

      act(() => result.current.cancelTrustedTool());
      expect(result.current.applyState).toBe('idle');
      expect(mocks.addTrustedTool).not.toHaveBeenCalled();
      expect(mocks.setSpaceSafetyLevel).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Deny direction — trusted_tool scope routes to principle apply, not settings
  // -------------------------------------------------------------------------

  describe('deny direction', () => {
    it('confirmTrustedTool with direction=deny calls applyDenySelection (not settings)', async () => {
      const mocks = buildMockTransport();
      const onDeny = vi.fn();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove: vi.fn(),
          direction: 'deny',
          onDeny,
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));

      act(() => result.current.selectOption(0));
      act(() => result.current.confirmSelection());
      expect(result.current.applyState).toBe('confirming_trust');

      await act(async () => {
        await result.current.confirmTrustedTool();
      });
      await waitFor(() => expect(result.current.applyState).toBe('applied'));

      expect(mocks.applyDenySelection).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'trusted_tool' }),
      );
      expect(mocks.addTrustedTool).not.toHaveBeenCalled();
      expect(mocks.setSpaceSafetyLevel).not.toHaveBeenCalled();
      expect(onDeny).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // resolveOnce / goBack / retry
  // -------------------------------------------------------------------------

  describe('resolveOnce', () => {
    it('calls onApprove for allow direction', () => {
      const mocks = buildMockTransport();
      const onApprove = vi.fn();
      const onDeny = vi.fn();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove,
          onDeny,
        }),
      );
      act(() => result.current.resolveOnce());
      expect(onApprove).toHaveBeenCalledTimes(1);
      expect(onDeny).not.toHaveBeenCalled();
    });

    it('calls onDeny for deny direction', () => {
      const mocks = buildMockTransport();
      const onApprove = vi.fn();
      const onDeny = vi.fn();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove,
          direction: 'deny',
          onDeny,
        }),
      );
      act(() => result.current.resolveOnce());
      expect(onDeny).toHaveBeenCalledTimes(1);
      expect(onApprove).not.toHaveBeenCalled();
    });
  });

  describe('goBack', () => {
    it('resets selection, other text, applyState, error, and appliedUpdate', async () => {
      const mocks = buildMockTransport();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove: vi.fn(),
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));

      act(() => {
        result.current.selectOption('other');
        result.current.setOtherText('hello');
      });
      expect(result.current.selectedOption).toBe('other');
      expect(result.current.otherText).toBe('hello');

      act(() => result.current.goBack());
      expect(result.current.selectedOption).toBeNull();
      expect(result.current.otherText).toBe('');
      expect(result.current.applyState).toBe('idle');
      expect(result.current.applyError).toBeNull();
      expect(result.current.appliedUpdate).toBeNull();
    });
  });

  describe('retryGeneration', () => {
    it('re-fires generateOptions after a failed initial attempt', async () => {
      const generateOptions = vi
        .fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce({
          options: [
            { label: 'opt1', scope: 'specific' },
            { label: 'opt2', scope: 'broad' },
            { label: 'opt3', scope: 'trusted_tool' },
          ],
        });
      const mocks = buildMockTransport({ generateOptions });
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove: vi.fn(),
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('error'));

      act(() => result.current.retryGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));
      expect(mocks.generateOptions).toHaveBeenCalledTimes(2);
      expect(result.current.options).toHaveLength(3);
    });
  });

  describe('retryApply', () => {
    it('re-attempts the last applySelection after a failure', async () => {
      const applySelection = vi
        .fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce({
          update: {
            summary: 'ok',
            proposedPrinciple: 'p',
            fullUpdatedPrompt: 'full',
          },
        });
      const mocks = buildMockTransport({ applySelection });
      const onApprove = vi.fn();
      const { result } = renderHook(() =>
        usePrincipleOptions({
          transport: mocks.transport,
          blockedAction: baseBlockedAction,
          effectiveToolId: 'slack_send_message',
          onApprove,
        }),
      );
      act(() => result.current.startGeneration());
      await waitFor(() => expect(result.current.generationState).toBe('loaded'));
      act(() => result.current.selectOption(1));
      act(() => result.current.confirmSelection());
      await waitFor(() => expect(result.current.applyState).toBe('error'));

      act(() => result.current.retryApply());
      await waitFor(() => expect(result.current.applyState).toBe('applied'));
      expect(mocks.applySelection).toHaveBeenCalledTimes(2);
      expect(onApprove).toHaveBeenCalledTimes(1);
    });
  });
});
